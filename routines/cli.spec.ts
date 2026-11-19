import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fire, main, sync } from './cli.ts'
import type { Deps } from './cli.ts'
import type { RunResult } from '../watch/run.ts'

const PROFILE = `## Routines
| Name | When | What | Wake | Quiet when |
|---|---|---|---|---|
| standup | 50 8 * * 1-5 | Look at the queue | manager | the queue is empty |
| digest | 0 9 * * * | Sum up mail | child | nothing new |
`

type Call = string[]

function world(opts: { state?: string; profile?: string; answer?: (args: string[]) => RunResult | undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kantoku-routines-'))
  const home = join(root, '.kantoku', 'alice')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'profile.md'), opts.profile ?? PROFILE)
  if (opts.state !== undefined) writeFileSync(join(home, 'state.md'), opts.state)
  const calls: Call[] = []
  const out: string[] = []
  const deps: Deps = {
    run: async (cmd, args) => {
      calls.push([cmd, ...args])
      return opts.answer?.([cmd, ...args]) ?? { code: 0, stdout: '{"ok":true,"result":{}}', stderr: '' }
    },
    kantokuRoot: join(root, '.kantoku'),
    workspace: join(root, '.kantoku-routines'),
    node: 'node',
    cli: '/plugin/routines/cli.ts',
    timezone: 'Asia/Seoul',
    now: () => new Date(2026, 10, 20, 8, 50),
    print: line => out.push(line),
  }

  return { root, home, deps, calls, out }
}

const LIVE_STATE = 'terminal: term_live\nrun: run_9\n'

test('a manager routine sends the manager a letter from its own terminal, and Orca starts no agent', async () => {
  const w = world({ state: LIVE_STATE })
  assert.equal(await fire(w.deps, 'alice', 'standup'), 1)
  const send = w.calls.find(call => call[1] === 'orchestration')
  assert.deepEqual(send?.slice(0, 11), ['orca', 'orchestration', 'send', '--from', 'term_live', '--to', 'run:run_9', '--type', 'status', '--subject', 'kantoku-routine: standup'])
  assert.match(send?.[12] ?? '', /Look at the queue/)
  assert.match(send?.[12] ?? '', /the queue is empty/)
  assert.equal(existsSync(join(w.home, 'routines', 'inbox')), false)
})

test('a manager routine checks the terminal is alive before it sends', async () => {
  const w = world({ state: LIVE_STATE })
  await fire(w.deps, 'alice', 'standup')
  assert.deepEqual(w.calls[0], ['orca', 'terminal', 'show', '--terminal', 'term_live', '--json'])
})

for (const [why, state, answer] of [
  ['no state.md', undefined, undefined],
  ['no terminal line', 'run: run_9\n', undefined],
  ['a closed terminal', LIVE_STATE, (args: string[]) => (args[1] === 'terminal' ? { code: 1, stdout: '{"ok":false,"error":{"code":"terminal_handle_stale"}}', stderr: '' } : undefined)],
  ['a refused send', LIVE_STATE, (args: string[]) => (args[1] === 'orchestration' ? { code: 1, stdout: '', stderr: 'no_active_sender_terminal' } : undefined)],
] as const) {
  test(`with ${why} the missed wake waits in the inbox for the next startup`, async () => {
    const w = world({ ...(state === undefined ? {} : { state }), ...(answer === undefined ? {} : { answer }) })
    assert.equal(await fire(w.deps, 'alice', 'standup'), 1)
    const inbox = join(w.home, 'routines', 'inbox')
    assert.deepEqual(readdirSync(inbox), ['2026-11-20-0850-standup.md'])
    const text = readFileSync(join(inbox, '2026-11-20-0850-standup.md'), 'utf8')
    assert.match(text, /^missed\n/)
    assert.match(text, /Look at the queue/)
  })
}

test('a child routine lets Orca start its agent', async () => {
  const w = world({ state: LIVE_STATE })
  assert.equal(await fire(w.deps, 'alice', 'digest'), 0)
  assert.deepEqual(w.calls, [])
})

test('a routine no longer in the table does not run', async () => {
  const w = world({ state: LIVE_STATE })
  assert.equal(await fire(w.deps, 'alice', 'gone'), 1)
  assert.deepEqual(w.calls, [])
  assert.match(w.out.join('\n'), /gone/)
})

const listOf = (automations: object[]) => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { automations } }), stderr: '' })

test('sync makes the workspace once, then creates one automation per row', async () => {
  const w = world({ answer: args => (args[1] === 'repo' && args[2] === 'show' ? { code: 1, stdout: '', stderr: 'repo_not_found' } : args[2] === 'list' ? listOf([]) : undefined) })
  assert.equal(await sync(w.deps, 'alice'), 0)
  assert.ok(existsSync(join(w.root, '.kantoku-routines', '.git')))
  const orca = w.calls.filter(call => call[0] === 'orca').map(call => call.slice(1, 3).join(' '))
  assert.deepEqual(orca, ['repo show', 'repo add', 'automations list', 'automations create', 'automations create'])
  const create = w.calls.find(call => call[2] === 'create') ?? []
  const flag = (name: string) => create[create.indexOf(name) + 1]
  assert.equal(flag('--name'), 'kantoku:alice:standup')
  assert.equal(flag('--trigger'), '50 8 * * 1-5')
  assert.equal(flag('--timezone'), 'Asia/Seoul')
  assert.equal(flag('--provider'), 'claude')
  assert.equal(flag('--precheck'), '"node" "/plugin/routines/cli.ts" fire alice standup')
  assert.match(flag('--workspace') ?? '', /^path:.*\.kantoku-routines$/)
  assert.ok(create.includes('--enabled'))
  assert.ok(w.out.includes('created kantoku:alice:standup'))
})

test('sync on an unchanged table changes nothing', async () => {
  const first = world({ answer: args => (args[2] === 'list' ? listOf([]) : undefined) })
  await sync(first.deps, 'alice')
  const made = first.calls.filter(call => call[2] === 'create').map(call => {
    const flag = (name: string) => call[call.indexOf(name) + 1] ?? ''
    return { id: flag('--name'), name: flag('--name'), rrule: flag('--trigger'), timezone: flag('--timezone'), prompt: flag('--prompt'), precheck: { command: flag('--precheck') }, runContext: { path: flag('--workspace').slice('path:'.length).replace(/\\/g, '/') }, enabled: true }
  })
  const again = world({ answer: args => (args[2] === 'list' ? listOf(made) : undefined) })
  again.deps.workspace = first.deps.workspace
  assert.equal(await sync(again.deps, 'alice'), 0)
  assert.deepEqual(again.calls.filter(call => call[1] === 'automations').map(call => call[2]), ['list'])
})

test('sync removes the automation of a row taken out of the table', async () => {
  const w = world({ profile: '## Routines\n| Name | When | What | Wake | Quiet when |\n|---|---|---|---|---|\n', answer: args => (args[2] === 'list' ? listOf([{ id: 'a1', name: 'kantoku:alice:standup', rrule: '1 1 * * *', timezone: 'UTC', prompt: '', precheck: null, runContext: { path: '' }, enabled: true }]) : undefined) })
  assert.equal(await sync(w.deps, 'alice'), 0)
  assert.deepEqual(w.calls.find(call => call[2] === 'remove'), ['orca', 'automations', 'remove', 'a1', '--json'])
  assert.ok(w.out.includes('removed kantoku:alice:standup'))
})

test('sync edits a changed automation and says "edited"', async () => {
  const w = world({ answer: args => (args[2] === 'list' ? listOf([{ id: 'a1', name: 'kantoku:alice:standup', rrule: '1 1 * * *', timezone: 'UTC', prompt: '', precheck: null, runContext: { path: '' }, enabled: true }]) : undefined) })
  await sync(w.deps, 'alice')
  assert.equal(w.calls.find(call => call[2] === 'edit')?.[3], 'a1')
  assert.ok(w.out.includes('edited kantoku:alice:standup'))
})

test('sync reports a bad row and exits 1', async () => {
  const w = world({ profile: PROFILE.replace('| manager |', '| boss |'), answer: args => (args[2] === 'list' ? listOf([]) : undefined) })
  assert.equal(await sync(w.deps, 'alice'), 1)
  assert.match(w.out.join('\n'), /boss/)
})

test('main refuses an unknown command or a bad manager name', async () => {
  const w = world()
  assert.equal(await main(['nope'], w.deps), 2)
  assert.equal(await main(['sync', '../x'], w.deps), 2)
})
