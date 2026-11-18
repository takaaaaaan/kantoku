import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENTS, ghForwardRelay } from './gh-forward.ts'
import type { Spawn } from './gh-forward.ts'
import { fakeRun } from '../testing.ts'
import type { Answer } from '../testing.ts'
import type { Run } from '../run.ts'

type Proc = { args: string[]; killed: boolean; exit(code: number, stderr?: string): void; stderr(text: string): void }

function fakeSpawn(): Spawn & { procs: Proc[] } {
  const procs: Proc[] = []
  const spawn: Spawn = (cmd, args) => {
    let onExit: (code: number | null, stderr: string) => void = () => {}
    let onStderr: (text: string) => void = () => {}
    const proc: Proc = {
      args: [cmd, ...args],
      killed: false,
      exit: (code, stderr = '') => onExit(code, stderr),
      stderr: text => onStderr(text),
    }
    procs.push(proc)

    return {
      onExit: cb => (onExit = cb),
      onStderr: cb => (onStderr = cb),
      kill: () => {
        proc.killed = true
      },
    }
  }

  return Object.assign(spawn, { procs })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const relay = (spawn: Spawn, run: Run = fakeRun(() => ({}))) => ghForwardRelay({ spawn, run, url: 'http://127.0.0.1:4567/webhook', secret: 's3', delays: [0, 0, 0] })
const live = (spawn: { procs: Proc[] }) => spawn.procs.filter(p => !p.killed)

test('sync starts one forwarder per repo with the exact flags', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  await r.sync(['a/b', 'C/D'])
  assert.equal(EVENTS, 'check_suite,status,pull_request_review,issue_comment,pull_request')
  assert.deepEqual(spawn.procs.map(p => p.args), [
    ['gh', 'webhook', 'forward', '--repo', 'a/b', '--events', EVENTS, '--url', 'http://127.0.0.1:4567/webhook', '--secret', 's3'],
    ['gh', 'webhook', 'forward', '--repo', 'c/d', '--events', EVENTS, '--url', 'http://127.0.0.1:4567/webhook', '--secret', 's3'],
  ])
  await r.sync(['c/d', 'a/b'])
  assert.equal(spawn.procs.length, 2)
  await r.sync(['c/d'])
  assert.deepEqual(live(spawn).map(p => p.args[4]), ['c/d'])
  spawn.procs[0]?.exit(1)
  await tick()
  assert.equal(spawn.procs.length, 2, 'a killed forwarder is not restarted')
})

test('connected when stderr says it is forwarding', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  const connected: string[] = []
  r.onConnected(repo => connected.push(repo))
  await r.sync(['a/b'])
  spawn.procs[0]?.stderr('Forwarding Webhook ')
  assert.deepEqual(connected, [])
  spawn.procs[0]?.stderr('events from GitHub...\n')
  spawn.procs[0]?.stderr('Forwarding Webhook events from GitHub...\n')
  assert.deepEqual(connected, ['a/b'])
})

test('an exit restarts; three failed restarts give up', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  const troubles: string[][] = []
  r.onTrouble((repo, problem, detail) => troubles.push([repo, problem, detail]))
  await r.sync(['a/b'])
  for (let at = 0; at < 3; at++) {
    spawn.procs.at(-1)?.exit(1, `boom ${at}`)
    await tick()
  }
  assert.equal(spawn.procs.length, 4)
  assert.deepEqual(troubles, [])
  spawn.procs.at(-1)?.exit(1, 'boom 3')
  await tick()
  assert.equal(spawn.procs.length, 4)
  assert.deepEqual(troubles, [['a/b', 'forwarder-gave-up', 'boom 3']])
  await r.sync(['a/b'])
  assert.equal(spawn.procs.length, 4, 'a repo it gave up on is not restarted by sync')
})

test('a connection resets the restart count', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  await r.sync(['a/b'])
  for (let at = 0; at < 6; at++) {
    spawn.procs.at(-1)?.stderr('Forwarding Webhook events from GitHub...')
    spawn.procs.at(-1)?.exit(1, 'dropped')
    await tick()
  }
  assert.equal(spawn.procs.length, 7)
})

test('HTTP 404 means no admin rights: no restart', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  const troubles: string[][] = []
  r.onTrouble((repo, problem) => troubles.push([repo, problem]))
  await r.sync(['a/b'])
  spawn.procs[0]?.exit(1, 'Error: error creating webhook: HTTP 404: Not Found (https://api.github.com/repos/a/b/hooks)')
  await tick()
  assert.equal(spawn.procs.length, 1)
  assert.deepEqual(troubles, [['a/b', 'no-admin']])
})

test('hook already exists: reported once, no restart loop', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  const troubles: string[][] = []
  r.onTrouble((repo, problem) => troubles.push([repo, problem]))
  await r.sync(['a/b'])
  spawn.procs[0]?.exit(1, 'Error: error creating webhook: HTTP 422: Validation Failed (https://api.github.com/repos/a/b/hooks)\nHook already exists on this repository\nUsage: ...')
  await tick()
  await r.sync(['a/b'])
  assert.equal(spawn.procs.length, 1)
  assert.deepEqual(troubles, [['a/b', 'forwarder-exited']])
})

test('stop kills all and nothing restarts', async () => {
  const spawn = fakeSpawn()
  const r = relay(spawn)
  await r.sync(['a/b', 'c/d'])
  await r.stop()
  assert.deepEqual(live(spawn), [])
  for (const p of spawn.procs) p.exit(1)
  await tick()
  assert.equal(spawn.procs.length, 2)
})

const authOk = "github.com\n  ✓ Logged in to github.com account someone (keyring)\n  - Active account: true\n  - Token: gho_****\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n"
function gh(over: { version?: Answer; auth?: Answer; ext?: Answer }) {
  return fakeRun((cmd, args) => {
    if (cmd !== 'gh') return { code: 1 }
    if (args[0] === '--version') return over.version ?? { stdout: 'gh version 2.92.0' }
    if (args[0] === 'auth') return over.auth ?? { stdout: authOk }
    if (args[0] === 'extension') return over.ext ?? { stdout: 'gh webhook\tcli/gh-webhook\tv0.2.0\n' }

    return { code: 1 }
  })
}

test('preflight: all good', async () => {
  assert.deepEqual(await relay(fakeSpawn(), gh({})).preflight(), [])
})

test('preflight: gh missing', async () => {
  const run = async () => {
    throw new Error('spawn gh ENOENT')
  }
  assert.deepEqual(await relay(fakeSpawn(), run).preflight(), ['gh-missing'])
})

test('preflight: not logged in, extension missing', async () => {
  assert.deepEqual(await relay(fakeSpawn(), gh({ auth: { code: 1, stderr: 'You are not logged into any GitHub hosts.' } })).preflight(), ['gh-not-logged-in'])
  assert.deepEqual(await relay(fakeSpawn(), gh({ ext: { stdout: 'gh copilot\tgithub/gh-copilot\tv1\n' } })).preflight(), ['extension-missing'])
})

test('preflight: scope missing only when neither repo nor admin:repo_hook', async () => {
  const scopes = (list: string) => gh({ auth: { stdout: authOk.replace(/Token scopes: .*/, `Token scopes: ${list}`) } })
  assert.deepEqual(await relay(fakeSpawn(), scopes("'gist', 'read:org'")).preflight(), ['scope-missing'])
  assert.deepEqual(await relay(fakeSpawn(), scopes("'admin:repo_hook', 'read:org'")).preflight(), [])
  assert.deepEqual(await relay(fakeSpawn(), scopes("'repo'")).preflight(), [])
  assert.deepEqual(await relay(fakeSpawn(), gh({ auth: { stdout: authOk.replace(/.*Token scopes.*\n/, '') } })).preflight(), [], 'no scope line (fine-grained token): not judged')
})
