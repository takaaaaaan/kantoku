import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, createContext, handleDelivery, heartbeat, tick } from './daemon.ts'
import type { PrRecord } from './daemon.ts'
import { startReceiver } from './receiver.ts'
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

test('letters are sent from the terminal that started the daemon', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await createContext({ ...(await s.make()).options, from: 'term_starter' })
  await tick(ctx, at(0))
  const sends = s.run.calls.filter(c => c[0] === 'orca')
  assert.ok(sends.length > 0)
  for (const call of sends) assert.deepEqual(call.slice(3, 5), ['--from', 'term_starter'])
})

test('a PR in a repo waiting for approval does not keep the daemon alive', async () => {
  const s = setup(['| Fix | wt | ctx_1 | some-org/app#2 | in progress | — |'])
  const ctx = await s.make()
  assert.equal(await tick(ctx, at(0)), 'continue')
  assert.equal(await tick(ctx, at(11)), 'idle-stop')
})

function flaky(fails: { orca: number; view?: number }, state = 'OPEN', onView?: () => void) {
  return fakeRun((cmd, args) => {
    if (cmd === 'orca') return fails.orca-- > 0 ? { code: 1, stderr: 'orca down' } : {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') {
      onView?.()
      if ((fails.view ?? 0) > 0) {
        fails.view = (fails.view ?? 0) - 1

        return { code: 1, stderr: 'HTTP 502' }
      }

      return json({ state, headRefOid: head, mergedBy: null })
    }
    if (args[0] === 'pr' && args[1] === 'checks') return json([{ name: 'b', bucket: 'pass' }])

    return json([[]])
  })
}
const sent = (run: { calls: string[][] }) => run.calls.filter(c => c[0] === 'orca').map(c => c[4])

test('a letter that failed is retried by a catch-up at the next tick', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const run = flaky({ orca: 2 })
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  await tick(ctx, at(1))
  assert.deepEqual(sent(run), ['dispatch:ctx_1', 'run:run_1', 'dispatch:ctx_1', 'run:run_1'])
})

test('a close is recorded at once; its letters that failed wait in the outbox and go out later', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const run = flaky({ orca: 4 }, 'CLOSED')
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  assert.equal(typeof ctx.prs['me-login/app#1']?.closedAt, 'string')
  assert.equal(ctx.outbox.keys().length, 4)
  await tick(ctx, at(1))
  assert.deepEqual(ctx.outbox.keys(), [])
  assert.deepEqual(sent(run).slice(4), ['dispatch:ctx_1', 'run:run_1', 'dispatch:ctx_1', 'run:run_1'])
})

// Verifier run 3 (cf57829): a comment fails, then only the close goes out. The comment must still go out.
function closeAfterComment() {
  const gh = { state: 'OPEN', commentFails: true }
  const run = fakeRun((cmd, args) => {
    if (cmd === 'orca') return gh.commentFails && args.some(a => a.includes('comment by')) ? { code: 1, stderr: 'orca down' } : {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return json({ state: gh.state, headRefOid: head, mergedBy: null })
    if (args[0] === 'pr' && args[1] === 'checks') return json([])
    if (args[0] === 'api' && args[1]?.endsWith('/comments'))
      return json([[{ id: 77, user: { login: 'x', type: 'User' }, body: 'hi', html_url: 'u', created_at: at(0.5).toISOString() }]])

    return json([[]])
  })

  return { gh, run }
}
const commentKey = 'comment:me-login/app#1:77>child:ctx_1'

for (const via of ['catch-up', 'webhook'] as const)
  test(`a comment that failed is sent after the PR closes, whatever path brought the close (${via})`, async () => {
    const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
    const { gh, run } = closeAfterComment()
    const ctx = await createContext({ ...(await s.make()).options, run })
    await tick(ctx, at(0))
    await handleDelivery(ctx, 'issue_comment', 'd-1', commentPayload, at(1))
    gh.state = 'CLOSED'
    if (via === 'webhook') await handleDelivery(ctx, 'pull_request', 'd-2', { action: 'closed', pull_request: { number: 1, merged: false }, repository: { full_name: 'me-login/app' } }, at(1.2))
    else ctx.toCatchUp.add('me-login/app')
    await tick(ctx, at(1.25))
    assert.equal(typeof ctx.prs['me-login/app#1']?.closedAt, 'string')
    assert.equal(ctx.seen.has('closed:me-login/app#1:closed>child:ctx_1'), true)
    assert.deepEqual(ctx.outbox.keys(), [commentKey])

    // A restart in between: the outbox is on disk.
    const again = await createContext({ ...ctx.options, now: at(1.4) })
    gh.commentFails = false
    const commentSends = () => run.calls.filter(c => c[0] === 'orca' && c.some(a => a.includes('comment by'))).length
    const before = commentSends()
    await tick(again, at(1.5))
    await tick(again, at(2))
    assert.equal(again.seen.has(commentKey), true)
    assert.deepEqual(again.outbox.keys(), [])
    assert.equal(commentSends() - before, 1, 'sent exactly once after the recovery')
  })

test('a comment whose webhook was lost before the close is found by the last read of the closed PR', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const { gh, run } = closeAfterComment()
  gh.commentFails = false
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  gh.state = 'CLOSED'
  await handleDelivery(ctx, 'pull_request', 'd-2', { action: 'closed', pull_request: { number: 1, merged: false }, repository: { full_name: 'me-login/app' } }, at(1))
  assert.equal(ctx.prs['me-login/app#1']?.finalReadAt, undefined)
  await tick(ctx, at(1.25))
  assert.equal(ctx.seen.has(commentKey), true)
  assert.equal(typeof ctx.prs['me-login/app#1']?.finalReadAt, 'string')
  const views = prViews(run.calls)
  await tick(ctx, at(2))
  assert.equal(prViews(run.calls), views, 'after the last read the closed PR is no longer read')
})

test('a close webhook for a PR whose first read failed leaves the full first read to catch-up', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const gh = { view: 1, state: 'OPEN' }
  const run = fakeRun((cmd, args) => {
    if (cmd === 'orca') return {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return gh.view-- > 0 ? { code: 1, stderr: 'HTTP 502' } : json({ state: gh.state, headRefOid: head, mergedBy: { login: 'x' } })
    if (args[0] === 'pr' && args[1] === 'checks') return json([])
    if (args[1]?.endsWith('/reviews'))
      return json([[{ id: 9, state: 'APPROVED', user: { login: 'rev' }, body: '', html_url: 'u', submitted_at: at(-5).toISOString() }]])

    return json([[]])
  })
  const ctx = await createContext({ ...(await s.make()).options, run })
  const prs: Record<string, PrRecord> = ctx.prs
  await tick(ctx, at(0))
  assert.equal(prs['me-login/app#1'], undefined)
  gh.state = 'MERGED'
  await handleDelivery(ctx, 'pull_request', 'd-1', { action: 'closed', pull_request: { number: 1, merged: true, merged_by: { login: 'x' } }, repository: { full_name: 'me-login/app' } }, at(1))
  const record = () => ctx.prs['me-login/app#1']
  assert.equal(record()?.firstSeenAt, undefined, 'the first full read is still to come')
  assert.equal(typeof record()?.closedAt, 'string', 'the close itself is recorded')
  gh.state = 'OPEN' // GitHub's view lags behind the webhook
  await tick(ctx, at(2))
  assert.equal(ctx.seen.has('review:me-login/app#1:9>child:ctx_1'), true, 'the approval from before the close is sent')
  assert.equal(typeof record()?.finalReadAt, 'string')
  assert.equal(typeof record()?.closedAt, 'string', 'a lagging OPEN does not undo the close')
})

test('a PR whose read keeps failing is read again 30 s, 1 min, ... apart, not every tick', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const run = flaky({ orca: 0, view: 1000 })
  const ctx = await createContext({ ...(await s.make()).options, run })
  for (let i = 0; i < 8; i++) await tick(ctx, new Date(at(0).getTime() + i * 15_000))
  // 0 s (fail 1), 30 s (fail 2), 90 s (fail 3): three reads in 105 seconds.
  assert.equal(prViews(run.calls), 3)
})

test('a quiet first read of a done row does not mark a letter already waiting in the outbox as sent', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | done | — |'])
  const gh = { view: 1, orca: 1 }
  const run = fakeRun((cmd, args) => {
    if (cmd === 'orca') return gh.orca-- > 0 ? { code: 1, stderr: 'orca down' } : {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return gh.view-- > 0 ? { code: 1, stderr: 'HTTP 502' } : json({ state: 'MERGED', headRefOid: head, mergedBy: { login: 'x' } })
    if (args[0] === 'pr' && args[1] === 'checks') return json([])

    return json([[]])
  })
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  await handleDelivery(ctx, 'pull_request', 'd-1', { action: 'closed', pull_request: { number: 1, merged: true, merged_by: { login: 'x' } }, repository: { full_name: 'me-login/app' } }, at(1))
  assert.deepEqual(ctx.outbox.keys(), ['closed:me-login/app#1:merged>run:run_1'])
  await tick(ctx, at(2))
  assert.equal(ctx.seen.has('closed:me-login/app#1:merged>run:run_1'), true)
  assert.equal(run.calls.filter(c => c[0] === 'orca').length, 2, 'one failure, then really sent')
})

test('a letter that cannot be sent for a day is dropped with a DROPPED log line, and the daemon stays up until then', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const run = flaky({ orca: Number.POSITIVE_INFINITY }, 'CLOSED')
  const ctx = await createContext({ ...(await s.make()).options, run })
  for (let minute = 0; minute <= 60; minute += 15) assert.equal(await tick(ctx, at(minute)), 'continue', 'unsent letters keep it alive')
  for (let i = 0; i < 10; i++) await tick(ctx, at(24 * 60 + i * 6))
  const log = readFileSync(join(s.home, 'watch.log'), 'utf8')
  assert.match(log, /GIVING UP closed:me-login\/app#1:closed>child:ctx_1 /, 'the drop has started; DROPPED follows once the manager is told')
  assert.ok(ctx.outbox.keys().every(key => key.startsWith('dropped:')), ctx.outbox.keys().join(' '))
  assert.ok(ctx.outbox.keys().includes('dropped:closed:me-login/app#1:closed>child:ctx_1'))
})

test('a first-seen PR that gh could not read is tried again', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const run = flaky({ orca: 0, view: 1 })
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  assert.equal(ctx.prs['me-login/app#1'], undefined)
  await tick(ctx, at(1))
  assert.notEqual(ctx.prs['me-login/app#1'], undefined)
})

test('a connection that comes during a tick is caught up at the next one', async () => {
  const s = setup(['| A | wt | ctx_1 | me-login/app#1 | x | — |', '| B | wt | ctx_2 | me-login/app#2 | x | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  let connectNow = true
  const run = flaky({ orca: 0 }, 'OPEN', () => {
    if (connectNow) s.relay.connect('me-login/app')
    connectNow = false
  })
  ctx.run = run
  s.write(['| A | wt | ctx_1 | me-login/app#1 | x | — |', '| B | wt | ctx_2 | me-login/app#2 | x | — |', '| C | wt | ctx_3 | me-login/app#3 | x | — |'])
  await tick(ctx, at(1))
  const views = () => run.calls.filter(c => c[1] === 'pr' && c[2] === 'view').length
  const before = views()
  await tick(ctx, at(2))
  assert.equal(views(), before + 3)
})

test('one empty read of state.md does not stop the forwarders; two do', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const ctx = await s.make()
  await tick(ctx, at(0))
  s.write([])
  await tick(ctx, at(1))
  assert.deepEqual(s.relay.synced.at(-1), ['me-login/app'])
  await tick(ctx, at(2))
  assert.deepEqual(s.relay.synced.at(-1), [])
})

test('acquireLock lets one daemon run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kw-lock-'))
  const alive = new Set([111])
  assert.equal(await acquireLock(home, 111, pid => alive.has(pid)), true)
  assert.equal(await acquireLock(home, 222, pid => alive.has(pid)), false)
  alive.delete(111)
  assert.equal(await acquireLock(home, 222, pid => alive.has(pid) || pid === 222), true)
  assert.equal(readFileSync(join(home, 'daemon.lock'), 'utf8').trim(), '222')
})

test('a known PR whose letter fails twice is still caught up until it is sent', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  let orcaFails = 0
  const run = fakeRun((cmd, args) => {
    if (cmd === 'orca') return orcaFails-- > 0 ? { code: 1, stderr: 'orca down' } : {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return json({ state: 'OPEN', headRefOid: head, mergedBy: null })
    if (args[0] === 'pr' && args[1] === 'checks') return json([{ name: 'b', bucket: 'pass' }])
    if (args[0] === 'api' && args[1]?.endsWith('/comments'))
      return json([[{ id: 77, user: { login: 'x', type: 'User' }, body: 'hi', html_url: 'u', created_at: at(0.5).toISOString() }]])

    return json([[]])
  })
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  orcaFails = 2
  const comment = { action: 'created', issue: { number: 1, pull_request: {} }, comment: { id: 77, body: 'hi', html_url: 'u', user: { login: 'x', type: 'User' } }, repository: { full_name: 'me-login/app' } }
  await handleDelivery(ctx, 'issue_comment', 'd-1', comment, at(1))
  await tick(ctx, at(2))
  await tick(ctx, at(3))
  const commentSends = run.calls.filter(c => c[0] === 'orca' && String(c[8]).includes('comment by x'))
  assert.equal(commentSends.length, 3, 'failed, failed again, then sent')
  assert.equal(ctx.seen.has('comment:me-login/app#1:77>child:ctx_1'), true)
})

test('a stale lock taken by many at once goes to exactly one', async () => {
  for (let round = 0; round < 20; round++) {
    const home = mkdtempSync(join(tmpdir(), 'kw-lock-race-'))
    writeFileSync(join(home, 'daemon.lock'), '999')
    const isAlive = (pid: number) => pid !== 999
    const wins = await Promise.all([111, 222, 333].map(pid => acquireLock(home, pid, isAlive)))
    assert.equal(wins.filter(Boolean).length, 1, `round ${round}: ${wins}`)
    const holder = Number(readFileSync(join(home, 'daemon.lock'), 'utf8').trim())
    assert.equal([111, 222, 333][wins.indexOf(true)], holder)
  }
})

const oldLock = (pid: number) => {
  const home = mkdtempSync(join(tmpdir(), 'kw-lock-old-'))
  writeFileSync(join(home, 'daemon.lock'), String(pid))
  const old = new Date(Date.now() - 11 * 60_000)
  utimesSync(join(home, 'daemon.lock'), old, old)

  return home
}

test('an old lock whose live pid does not answer the ping is stale (pid reused)', async () => {
  assert.equal(await acquireLock(oldLock(111), 222, () => true, async () => false), true)
})

test('an old lock whose holder answers the ping is kept', async () => {
  assert.equal(await acquireLock(oldLock(111), 222, () => true, async () => true), false)
})

test('heartbeat keeps the lock fresh and reports a lost lock', async () => {
  const home = oldLock(process.pid)
  const before = statSync(join(home, 'daemon.lock')).mtimeMs
  assert.equal(await heartbeat(home), true)
  assert.ok(statSync(join(home, 'daemon.lock')).mtimeMs > before)
  writeFileSync(join(home, 'daemon.lock'), '999')
  assert.equal(await heartbeat(home), false)
})

// A run where GitHub reads can be made to fail, and orca sends can be made to fail.
function outage() {
  const down = { orca: 0, view: 0, checks: 0 }
  const run = fakeRun((cmd, args) => {
    if (cmd === 'orca') return down.orca-- > 0 ? { code: 1, stderr: 'orca down' } : {}
    if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me-login' }
    if (args[0] === 'pr' && args[1] === 'view') return down.view-- > 0 ? { code: 1, stderr: 'HTTP 502' } : json({ state: 'OPEN', headRefOid: head, mergedBy: null })
    if (args[0] === 'pr' && args[1] === 'checks') return down.checks-- > 0 ? { code: 4, stderr: 'HTTP 502' } : json([{ name: 'b', bucket: 'fail' }])
    if (args[0] === 'api' && args[1]?.endsWith('/comments'))
      return json([[{ id: 77, user: { login: 'x', type: 'User' }, body: 'hi', html_url: 'u', created_at: at(0.5).toISOString() }]])

    return json([[]])
  })

  return { down, run }
}
const commentPayload = { action: 'created', issue: { number: 1, pull_request: {} }, comment: { id: 77, body: 'hi', html_url: 'u', user: { login: 'x', type: 'User' } }, repository: { full_name: 'me-login/app' } }

test('a failed letter waits in the outbox and is sent even while GitHub cannot be read', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const { down, run } = outage()
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  down.orca = 2
  await handleDelivery(ctx, 'issue_comment', 'd-1', commentPayload, at(1))
  down.view = 2
  await tick(ctx, at(2))
  assert.equal(ctx.seen.has('comment:me-login/app#1:77>child:ctx_1'), false)
  assert.deepEqual(ctx.outbox.keys(), ['comment:me-login/app#1:77>child:ctx_1'])
  await tick(ctx, at(3))
  assert.equal(ctx.seen.has('comment:me-login/app#1:77>child:ctx_1'), true)
})

test('a CI trigger that cannot read GitHub queues the repo for catch-up', async () => {
  const s = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const { down, run } = outage()
  down.checks = 1
  const ctx = await createContext({ ...(await s.make()).options, run })
  await tick(ctx, at(0))
  assert.equal(ctx.prs['me-login/app#1'], undefined, 'first-seen pass incomplete: not recorded')
  await tick(ctx, at(1))
  const key = 'ci:me-login/app#1@' + head + ':failed:b>child:ctx_1'
  assert.equal(ctx.seen.has(key), true)

  const t = setup(['| Fix | wt | ctx_1 | me-login/app#1 | in progress | — |'])
  const o = outage()
  const c = await createContext({ ...(await t.make()).options, run: o.run })
  o.down.checks = 1
  await tick(c, at(0))
  await tick(c, at(1))
  const trigger = { action: 'completed', check_suite: { head_sha: head }, repository: { full_name: 'me-login/app' } }
  o.run.calls.length = 0
  o.down.view = 1
  await handleDelivery(c, 'check_suite', 'd-9', trigger, at(2))
  assert.equal(c.toCatchUp.has('me-login/app'), true)
})

test('an old lock whose holder receiver answers the ping is kept, found through status.json', async () => {
  const home = oldLock(process.pid)
  const secret = 'c'.repeat(64)
  const receiver = await startReceiver({ secret, onDelivery: () => {}, onShutdown: () => {} })
  try {
    writeFileSync(join(home, 'secret'), secret)
    writeFileSync(join(home, 'status.json'), JSON.stringify({ pid: process.pid, port: receiver.port, startedAt: 'x', lastAliveAt: 'x', repos: {}, troubles: [] }))
    assert.equal(await acquireLock(home, process.pid + 1, pid => pid === process.pid), false)
  } finally {
    await receiver.close()
  }
})
