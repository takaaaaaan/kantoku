import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, windowsCommandLine } from './cli.ts'
import type { CliDeps } from './cli.ts'
import { fakeRun, json } from './testing.ts'
import type { Answer } from './testing.ts'

const authOk = "  - Active account: true\n  - Token scopes: 'repo'\n"

function setup(over: { auth?: Answer; ext?: Answer; rows?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kw-cli-'))
  const env = { KANTOKU_HOME: join(root, 'kantoku'), KANTOKU_WATCH_HOME: join(root, 'watch') }
  mkdirSync(join(env.KANTOKU_HOME, 'mgr'), { recursive: true })
  writeFileSync(join(env.KANTOKU_HOME, 'mgr', 'state.md'), `run: run_1
## Tasks
| Task | Child worktree | dispatch ID | PR | Status | Pending gate |
|---|---|---|---|---|---|
${(over.rows ?? []).join('\n')}
`)
  const run = fakeRun((cmd, args) => {
    if (cmd !== 'gh') return {}
    if (args[0] === '--version') return { stdout: 'gh version 2.92.0' }
    if (args[0] === 'auth') return over.auth ?? { stdout: authOk }
    if (args[0] === 'extension') return over.ext ?? { stdout: 'gh webhook\tcli/gh-webhook\tv0.2.0\n' }
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login\n' }
    if (args[0] === 'api') return json([])

    return { code: 1 }
  })
  const out: string[] = []
  const spawned: string[][] = []
  const posts: [string, Record<string, string>][] = []
  const alive = new Set<number>([process.pid])
  // ping: the status /ping answers with (404 = no kantoku-watch receiver there). shutdownWorks: /shutdown ends the pid.
  const control = { ping: 404, shutdownWorks: true }
  const deps: Partial<CliDeps> = {
    run,
    out: line => out.push(line),
    sleep: async () => {},
    isAlive: pid => alive.has(pid),
    spawnDaemon: (args, childEnv) => {
      spawned.push(args)
      assert.equal(Object.keys(childEnv).some(key => key.startsWith('ORCA_')), false)
      const pid = 4242
      alive.add(pid)
      mkdirSync(env.KANTOKU_WATCH_HOME, { recursive: true })
      writeFileSync(join(env.KANTOKU_WATCH_HOME, 'status.json'), JSON.stringify({ pid, port: 5555, startedAt: 'x', lastAliveAt: new Date().toISOString(), repos: { 'me-login/app': 'forwarding' }, troubles: [] }))

      return pid
    },
    post: async (url, headers) => {
      posts.push([url, headers])
      if (url.endsWith('/ping')) return control.ping
      if (!control.shutdownWorks) return 401
      alive.clear()

      return 202
    },
  }
  const statusFile = join(env.KANTOKU_WATCH_HOME, 'status.json')
  const writeStatus = (pid: number, lastAliveAt = new Date().toISOString()) => {
    mkdirSync(env.KANTOKU_WATCH_HOME, { recursive: true })
    writeFileSync(statusFile, JSON.stringify({ pid, port: 5555, startedAt: 's', lastAliveAt, repos: {}, troubles: [] }))
  }

  return { env: { ...env, ORCA_TERMINAL_HANDLE: 'term_x', ORCA_OTHER: 'y' }, deps, out, spawned, posts, writeStatus, home: env.KANTOKU_WATCH_HOME, control }
}

test('status with no file says not running and exits 0', async () => {
  const s = setup()
  assert.equal(await main(['status'], s.env, s.deps), 0)
  assert.match(s.out.join('\n'), /not running/)
})

test('start with a live daemon reports it and does not spawn', async () => {
  const s = setup()
  s.writeStatus(process.pid)
  assert.equal(await main(['start'], s.env, s.deps), 0)
  assert.match(s.out.join('\n'), /already running \(pid \d+/)
  assert.deepEqual(s.spawned, [])
})

test('start with a stale pid spawns a new daemon and prints its status', async () => {
  const s = setup({ rows: ['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'] })
  s.writeStatus(999_999)
  assert.equal(await main(['start', '--allow', 'Some-Org/App'], s.env, s.deps), 0)
  assert.equal(s.spawned.length, 1)
  assert.equal(s.spawned[0]?.[1], 'run')
  assert.deepEqual(s.spawned[0]?.slice(-2), ['--allow', 'some-org/app'])
  assert.match(s.out.join('\n'), /me-login\/app\s+forwarding/)
})

test('start creates the secret: 32 random bytes in hex', async () => {
  const s = setup()
  await main(['start'], s.env, s.deps)
  assert.match(readFileSync(join(s.home, 'secret'), 'utf8'), /^[0-9a-f]{64}$/)
})

test('start prints needs approval for repos the user does not own', async () => {
  const s = setup({ rows: ['| A | wt | ctx_1 | some-org/app#1 | x | — |', '| B | wt | ctx_2 | me-login/app#2 | x | — |', '| C | wt | ctx_3 | other/lib#3 | x | — |'] })
  assert.equal(await main(['start', '--allow', 'other/lib'], s.env, s.deps), 0)
  const text = s.out.join('\n')
  assert.match(text, /^needs approval: some-org\/app$/m)
  assert.doesNotMatch(text, /needs approval: (me-login|other)/)
})

test('preflight trouble exits 2 with the fix to ask for', async () => {
  const s = setup({ ext: { stdout: '' } })
  assert.equal(await main(['start'], s.env, s.deps), 2)
  assert.match(s.out.join('\n'), /gh extension install cli\/gh-webhook/)
  assert.deepEqual(s.spawned, [])
  const t = setup({ auth: { stdout: "  - Active account: true\n  - Token scopes: 'gist'\n" } })
  assert.equal(await main(['start'], t.env, t.deps), 2)
  assert.match(t.out.join('\n'), /gh auth refresh -h github\.com -s admin:repo_hook/)
})

test('stop posts /shutdown with the secret', async () => {
  const s = setup()
  await main(['start'], s.env, s.deps)
  const secret = readFileSync(join(s.home, 'secret'), 'utf8')
  assert.equal(await main(['stop'], s.env, s.deps), 0)
  assert.deepEqual(s.posts.filter(p => p[0].endsWith('/shutdown')), [['http://127.0.0.1:5555/shutdown', { 'x-kantoku-watch-secret': secret }]])
  assert.match(s.out.join('\n'), /stopped/)
})

test('stop when not running says so and exits 0', async () => {
  const s = setup()
  assert.equal(await main(['stop'], s.env, s.deps), 0)
  assert.match(s.out.join('\n'), /not running/)
  assert.deepEqual(s.posts, [])
})

test('unknown command prints usage and exits 1', async () => {
  const s = setup()
  assert.equal(await main(['bogus'], s.env, s.deps), 1)
  assert.match(s.out.join('\n'), /usage: node watch\/cli\.ts start/i)
  assert.equal(existsSync(join(s.home, 'secret')), false)
})

test('start hands the daemon its sender and paths as arguments', async () => {
  const s = setup()
  await main(['start', '--allow', 'o/r'], s.env, s.deps)
  const args = s.spawned[0] ?? []
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  assert.equal(value('--from'), 'term_x')
  assert.equal(value('--home'), s.home)
  assert.equal(value('--allow'), 'o/r')
  assert.match(value('--state-root') ?? '', /kantoku$/)
})

test('start outside Orca passes no sender', async () => {
  const s = setup()
  const { ORCA_TERMINAL_HANDLE: _, ...env } = s.env
  await main(['start'], env, s.deps)
  assert.equal(s.spawned[0]?.includes('--from'), false)
})

test('flags are checked', async () => {
  const s = setup()
  assert.equal(await main(['start', '--from', 'x'], s.env, s.deps), 1, '--from is only for run')
  assert.equal(await main(['run', '--home'], s.env, s.deps), 1)
  assert.equal(await main(['status', '--allow', 'o/r'], s.env, s.deps), 1)
})

test('windowsCommandLine quotes every argument and refuses double quotes', () => {
  assert.equal(windowsCommandLine('C:/node/node.exe', ['C:/a b/cli.ts', 'run', '--allow', 'o/r']), '"C:/node/node.exe" "C:/a b/cli.ts" "run" "--allow" "o/r"')
  assert.throws(() => windowsCommandLine('node', ['a"b']))
  assert.throws(() => windowsCommandLine('node', ['a\\']))
})

test('start --allow on a running daemon restarts it with the approval', async () => {
  const s = setup()
  s.writeStatus(process.pid)
  writeFileSync(join(s.home, 'secret'), 'a'.repeat(64))
  assert.equal(await main(['start', '--allow', 'some-org/app'], s.env, s.deps), 0)
  assert.equal(s.posts.filter(p => p[0].endsWith('/shutdown')).length, 1)
  assert.equal(s.spawned.length, 1)
  assert.deepEqual(s.spawned[0]?.slice(-2), ['--allow', 'some-org/app'])
})

test('a pid whose heartbeat is over 2 minutes old is not running', async () => {
  const s = setup()
  s.writeStatus(process.pid, new Date(Date.now() - 3 * 60_000).toISOString())
  assert.equal(await main(['status'], s.env, s.deps), 0)
  assert.match(s.out.join('\n'), /not running/)
  assert.equal(await main(['start'], s.env, s.deps), 0)
  assert.equal(s.spawned.length, 1)
})

test('catchup runs one pass like the daemon: letters sent, PRs recorded', async () => {
  const s = setup({ rows: ['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'] })
  const run = fakeRun((cmd, args) => {
    if (cmd === 'orca') return {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return json({ state: 'MERGED', headRefOid: 'abc', mergedBy: { login: 'x' } })
    if (args[0] === 'pr' && args[1] === 'checks') return json([{ name: 'b', bucket: 'pass' }])

    return json([[]])
  })
  assert.equal(await main(['catchup'], s.env, { ...s.deps, run }), 0)
  assert.equal(run.calls.filter(c => c[0] === 'orca').length, 4)
  assert.equal(typeof JSON.parse(readFileSync(join(s.home, 'prs.json'), 'utf8'))['me-login/app#1'].closedAt, 'string')
})

const stale = () => new Date(Date.now() - 3 * 60_000).toISOString()

test('stop shuts down a live daemon whose heartbeat is stale', async () => {
  const s = setup()
  s.writeStatus(process.pid, stale())
  writeFileSync(join(s.home, 'secret'), 'b'.repeat(64))
  assert.equal(await main(['stop'], s.env, s.deps), 0)
  assert.equal(s.posts.filter(p => p[0].endsWith('/shutdown')).length, 1)
  assert.match(s.out.join('\n'), /stopped/)
})

test('stop fails when the live pid does not stop', async () => {
  const s = setup()
  s.control.shutdownWorks = false
  s.writeStatus(process.pid, stale())
  writeFileSync(join(s.home, 'secret'), 'b'.repeat(64))
  assert.equal(await main(['stop'], s.env, s.deps), 1)
  assert.match(s.out.join('\n'), /did not stop/)
})

test('a stale heartbeat whose receiver answers the ping is still running', async () => {
  const s = setup()
  s.control.ping = 204
  s.writeStatus(process.pid, stale())
  writeFileSync(join(s.home, 'secret'), 'b'.repeat(64))
  assert.equal(await main(['status'], s.env, s.deps), 0)
  assert.match(s.out.join('\n'), /running \(pid/)
  assert.equal(await main(['start'], s.env, s.deps), 0)
  assert.match(s.out.join('\n'), /already running/)
  assert.deepEqual(s.spawned, [])
})
