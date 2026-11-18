import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, handleDelivery, tick } from './daemon.ts'
import type { Relay } from './relay.ts'
import type { Trouble } from './events.ts'
import { fakeRun, json } from './testing.ts'

type FakeRelay = Relay & { synced: string[][]; connect(repo: string): void; trouble(repo: string, problem: Trouble): void }

function fakeRelay(): FakeRelay {
  const connected: ((repo: string) => void)[] = []
  const troubled: ((repo: string, problem: Trouble, detail: string) => void)[] = []
  const synced: string[][] = []

  return {
    name: 'fake',
    synced,
    preflight: async () => [],
    sync: async repos => {
      synced.push([...repos].sort())
    },
    stop: async () => {},
    onConnected: cb => {
      connected.push(cb)
    },
    onTrouble: cb => {
      troubled.push(cb)
    },
    connect: repo => connected.forEach(cb => cb(repo)),
    trouble: (repo, problem) => troubled.forEach(cb => cb(repo, problem, 'detail')),
  }
}

const head = 'abc1234def'
function world(prState: Record<string, string> = {}, buckets = ['pass']) {
  return fakeRun((cmd, args) => {
    if (cmd === 'orca') return {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login\n' }
    if (args[0] === 'pr' && args[1] === 'view') return json({ state: prState[`${args[4]}#${args[2]}`] ?? 'OPEN', headRefOid: head, mergedBy: null })
    if (args[0] === 'pr' && args[1] === 'checks') return json(buckets.map((bucket, at) => ({ name: `c${at}`, bucket })))
    if (args[0] === 'api') return json([[]])

    return { code: 1 }
  })
}

function setup(rows: string[], opts: { allow?: string[]; prState?: Record<string, string>; buckets?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kw-daemon-'))
  const stateRoot = join(root, 'kantoku')
  const home = join(root, 'watch')
  mkdirSync(join(stateRoot, 'mgr'), { recursive: true })
  mkdirSync(home)
  const write = (lines: string[]) => writeFileSync(join(stateRoot, 'mgr', 'state.md'), `run: run_1

## Tasks
| Task | Child worktree | dispatch ID | PR | Status | Pending gate |
|---|---|---|---|---|---|
${lines.join('\n')}
`)
  write(rows)
  const run = world(opts.prState, opts.buckets)
  const relay = fakeRelay()
  const make = () => createContext({ run, relay, stateRoot, home, allow: new Set(opts.allow ?? []), port: 1234, now: new Date('2026-11-18T10:00:00Z') })

  return { run, relay, home, write, make, letters: () => run.calls.filter(c => c[0] === 'orca').map(c => `${c[4]} ${c[8]}`) }
}

const at = (minutes: number) => new Date(Date.parse('2026-11-18T10:00:00Z') + minutes * 60_000)
const prViews = (calls: string[][]) => calls.filter(c => c[1] === 'pr' && c[2] === 'view').length

test('a first-seen PR is caught up once', async () => {
  const s = setup(['| Fix | wt | ctx_1 | https://github.com/me-login/app/pull/1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  await tick(ctx, at(1))
  assert.equal(prViews(s.run.calls), 1)
  assert.deepEqual(s.letters(), ['dispatch:ctx_1 kantoku-watch: me-login/app#1 CI passed (1 passed)', 'run:run_1 kantoku-watch: me-login/app#1 (Fix → ctx_1) CI passed'])
  assert.deepEqual(s.relay.synced.at(-1), ['me-login/app'])
  const prs = JSON.parse(readFileSync(join(s.home, 'prs.json'), 'utf8'))
  assert.equal(prs['me-login/app#1'].firstSeenAt, at(0).toISOString())
  const status = JSON.parse(readFileSync(join(s.home, 'status.json'), 'utf8'))
  assert.deepEqual([status.pid, status.port, status.lastAliveAt, status.repos], [process.pid, 1234, at(1).toISOString(), { 'me-login/app': 'forwarding' }])
})

test('a first-seen PR in a done row is recorded without letters', async () => {
  const s = setup(['| Old | wt | ctx_1 | me-login/app#1 | merged | — |'], { prState: { 'me-login/app#1': 'MERGED' } })
  await tick(await s.make(), at(0))
  assert.deepEqual(s.letters(), [])
})

test('an org repo without --allow needs approval: not synced, one manager line', async () => {
  const s = setup(['| Fix | wt | ctx_1 | https://github.com/some-org/app/pull/2 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  await tick(ctx, at(1))
  assert.deepEqual(s.relay.synced.at(-1), [])
  assert.equal(s.letters().filter(l => l.includes('needs approval')).length, 1)
  assert.equal(s.letters().find(l => l.includes('needs approval')), 'run:run_1 kantoku-watch: some-org/app needs approval: not forwarded until a start with --allow some-org/app')
  assert.equal(ctx.repos['some-org/app'], 'needs-approval')
  assert.equal(s.run.calls.some(c => c.join(' ').includes('hooks')), false)
})

test('an org repo with --allow is synced', async () => {
  const s = setup(['| Fix | wt | ctx_1 | some-org/app#2 | in progress | — |'], { allow: ['Some-Org/App'] })
  await tick(await s.make(), at(0))
  assert.deepEqual(s.relay.synced.at(-1), ['some-org/app'])
})

test('a repeated delivery ID sends nothing', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  const before = s.letters().length
  const payload = { action: 'created', issue: { number: 1, pull_request: {} }, comment: { id: 9, body: 'hi', html_url: 'u', user: { login: 'x', type: 'User' } }, repository: { full_name: 'me-login/app' } }
  await handleDelivery(ctx, 'issue_comment', 'd-1', payload, at(1))
  assert.equal(s.letters().length, before + 1)
  const edited = { ...payload, comment: { ...payload.comment, id: 10 } }
  await handleDelivery(ctx, 'issue_comment', 'd-1', edited, at(2))
  assert.equal(s.letters().length, before + 1)
})

test('a CI result already sent by catch-up is not sent again by a trigger; pending sends nothing', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'], { buckets: ['pass', 'fail'] })
  const ctx = await s.make()
  await tick(ctx, at(0))
  const before = s.letters().length
  await handleDelivery(ctx, 'check_suite', 'd-2', { action: 'completed', check_suite: { head_sha: head }, repository: { full_name: 'me-login/app' } }, at(1))
  await handleDelivery(ctx, 'check_suite', 'd-3', { action: 'completed', check_suite: { head_sha: head }, repository: { full_name: 'me-login/app' } }, at(2))
  assert.equal(s.letters().length, before, 'the first-seen catch-up already sent this CI result')

  const s2 = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'], { buckets: ['pass', 'pending'] })
  const c2 = await s2.make()
  await tick(c2, at(0))
  assert.deepEqual(s2.letters(), [])
})

test('a CI trigger after checks finish sends once', async () => {
  let buckets = ['pending']
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const run = fakeRun((cmd, args) => {
    if (args[0] === 'pr' && args[1] === 'checks') return json(buckets.map(bucket => ({ name: 'build', bucket })))
    if (cmd === 'orca') return {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return json({ state: 'OPEN', headRefOid: head })

    return json([[]])
  })
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  buckets = ['fail']
  const trigger = { action: 'completed', check_suite: { head_sha: head }, repository: { full_name: 'me-login/app' } }
  await handleDelivery(ctx, 'check_suite', 'd-1', trigger, at(1))
  await handleDelivery(ctx, 'check_suite', 'd-2', trigger, at(2))
  const sent = run.calls.filter(c => c[0] === 'orca').map(c => c[8])
  assert.deepEqual(sent, ['kantoku-watch: me-login/app#1 CI failed (1 of 1)', 'kantoku-watch: me-login/app#1 (Fix → ctx_1) CI failed: build'])
})

test('a relay connection runs catch-up for that repo', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  const before = prViews(s.run.calls)
  await tick(ctx, at(1))
  assert.equal(prViews(s.run.calls), before)
  s.relay.connect('me-login/app')
  await tick(ctx, at(2))
  assert.equal(prViews(s.run.calls), before + 1)
})

test('a relay that gave up moves the repo to polling, caught up every 10 minutes', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  s.relay.trouble('me-login/app', 'forwarder-gave-up')
  await tick(ctx, at(1))
  assert.equal(ctx.repos['me-login/app'], 'polling')
  assert.equal(s.letters().filter(l => l.includes('stopped')).length, 1)
  const before = prViews(s.run.calls)
  await tick(ctx, at(5))
  assert.equal(prViews(s.run.calls), before)
  await tick(ctx, at(12))
  assert.equal(prViews(s.run.calls), before + 1)
})

test('no open watched PR for 10 minutes stops the daemon; a closed PR is not open', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'], { prState: { 'me-login/app#1': 'CLOSED' } })
  const ctx = await s.make()
  assert.equal(await tick(ctx, at(0)), 'continue')
  assert.equal(s.letters().filter(l => l.includes('closed without merge')).length, 2)
  assert.equal(await tick(ctx, at(9)), 'continue')
  assert.equal(await tick(ctx, at(11)), 'idle-stop')
  assert.deepEqual(s.relay.synced.at(-1), [])
})

test('state survives a restart: a known PR is not first-seen again', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  await ctx.seen.save()
  const again = await s.make()
  const before = prViews(s.run.calls)
  await tick(again, at(1))
  assert.equal(prViews(s.run.calls), before)
})

test('a closed event for a PR nobody watches is not recorded', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  await handleDelivery(ctx, 'pull_request', 'd-9', { action: 'closed', pull_request: { number: 7, merged: true, merged_by: { login: 'x' } }, repository: { full_name: 'me-login/app' } }, at(1))
  assert.equal(ctx.prs['me-login/app#7'], undefined)
})

test('records of PRs gone from state.md are dropped after 14 days', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  s.write([])
  await tick(ctx, at(60))
  assert.notEqual(ctx.prs['me-login/app#1'], undefined)
  await tick(ctx, at(15 * 24 * 60))
  assert.equal(ctx.prs['me-login/app#1'], undefined)
})
