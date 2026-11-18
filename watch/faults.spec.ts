// Fault injection: random event orders (CI, comments, reviews, close, restart,
// reconnect) mixed with random failures (orca send, gh reads). For every seed,
// once the failures stop, each letter that GitHub's facts call for is sent
// exactly once, unless watch.log records that it was dropped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, handleDelivery, tick } from './daemon.ts'
import type { DaemonContext } from './daemon.ts'
import type { Trouble, WatchEvent } from './events.ts'
import type { Relay } from './relay.ts'
import { writeJson } from './files.ts'
import { openOutbox } from './outbox.ts'
import { lettersFor } from './route.ts'
import type { Letter } from './route.ts'
import { openSeen } from './seen.ts'
import type { Seen } from './seen.ts'
import { parseTargets } from './targets.ts'
import type { Run } from './run.ts'

const SEEDS = Number(process.env.KW_FAULT_SEEDS ?? 300)
const STEPS = 40
const REPO = 'me-login/app'
const STATE = `run: run_1

## Tasks
| Task | Child worktree | dispatch ID | PR | Status | Pending gate |
|---|---|---|---|---|---|
| A | wt | ctx_1 | ${REPO}#1 | in progress | — |
| B | wt | ctx_2 | ${REPO}#2 | in progress | — |
`
const targets = parseTargets('mgr', STATE)

function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return { next, pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)] as T }
}

function fakeRelay(): Relay & { connect(repo: string): void } {
  const connected: ((repo: string) => void)[] = []

  return {
    name: 'fake',
    preflight: async () => [],
    sync: async () => {},
    stop: async () => {},
    onConnected: cb => {
      connected.push(cb)
    },
    onTrouble: (_cb: (repo: string, problem: Trouble, detail: string) => void) => {},
    connect: repo => connected.forEach(cb => cb(repo)),
  }
}

type Pr = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  head: string
  bucket: 'pass' | 'fail' | 'pending'
  heads: { sha: string; bucket: 'pass' | 'fail' }[]
  comments: { id: number; user: { login: string; type: string }; body: string; html_url: string; created_at: string }[]
  reviews: { id: number; state: string; user: { login: string }; body: string; html_url: string; submitted_at: string }[]
}

async function simulate(seed: number): Promise<string[]> {
  const r = rng(seed)
  const root = mkdtempSync(join(tmpdir(), 'kw-fault-'))
  const stateRoot = join(root, 'kantoku')
  const home = join(root, 'watch')
  mkdirSync(join(stateRoot, 'mgr'), { recursive: true })
  mkdirSync(home)
  writeFileSync(join(stateRoot, 'mgr', 'state.md'), STATE)

  const prs: Pr[] = [1, 2].map(number => ({ number, state: 'OPEN', head: `h${number}0`, bucket: 'pass', heads: [{ sha: `h${number}0`, bucket: 'pass' }], comments: [], reviews: [] }))
  let pOrca = 0
  let pGh = 0
  let nextId = 100
  let minute = 0
  const now = () => new Date(Date.parse('2026-11-18T10:00:00Z') + minute * 60_000)
  const sent: string[] = []

  const run: Run = async (cmd, args) => {
    if (cmd === 'orca') {
      if (r.next() < pOrca) return { code: 1, stdout: '', stderr: 'orca down' }
      const value = (flag: string) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? '') : '')
      sent.push(`${value('--to')}\n${value('--subject')}\n${value('--body')}`)

      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'api' && args[1] === 'user') return { code: 0, stdout: 'me-login\n', stderr: '' }
    if (r.next() < pGh) return { code: 1, stdout: '', stderr: 'HTTP 502' }
    const ok = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: '' })
    if (args[0] === 'pr') {
      const pr = prs.find(p => p.number === Number(args[2]))
      if (pr === undefined) return { code: 1, stdout: '', stderr: 'no such PR' }
      if (args[1] === 'view') return ok({ state: pr.state, headRefOid: pr.head, mergedBy: pr.state === 'MERGED' ? { login: 'merger' } : null })
      if (args[1] === 'checks') return ok([{ name: 'b', bucket: pr.bucket }], pr.bucket === 'pending' ? 8 : pr.bucket === 'fail' ? 1 : 0)
    }
    const m = /^repos\/[^/]+\/[^/]+\/(pulls|issues)\/(\d+)\/(reviews|comments)$/.exec(args[1] ?? '')
    const pr = prs.find(p => p.number === Number(m?.[2]))
    if (m !== null && pr !== undefined) return ok([m[3] === 'reviews' ? pr.reviews : pr.comments])

    return { code: 1, stdout: '', stderr: 'unknown call' }
  }

  let relay = fakeRelay()
  const make = () => createContext({ run, relay, stateRoot, home, allow: new Set(), port: 1, now: now() })
  let ctx: DaemonContext = await make()
  // The first-seen pass runs without failures, so "first seen" is minute 0 for both PRs.
  await tick(ctx, now())

  // Facts that call for letters, by the events catch-up or a webhook would build.
  const must: WatchEvent[] = []
  const deliver = async (event: string, payload: unknown) => {
    const id = `d${nextId++}`
    if (r.next() < 0.8) await handleDelivery(ctx, event, id, payload, now())
    if (r.next() < 0.15) await handleDelivery(ctx, event, id, payload, now())
  }
  const repository = { full_name: REPO }

  pOrca = r.pick([0.1, 0.3, 0.6])
  pGh = r.pick([0, 0.1, 0.3])
  for (let step = 0; step < STEPS; step++) {
    minute++
    const open = prs.filter(p => p.state === 'OPEN')
    const pr = open.length > 0 ? r.pick(open) : undefined
    const kind = r.pick(['comment', 'review', 'ci', 'close', 'restart', 'reconnect', 'tick', 'tick', 'tick'] as const)
    if (pr !== undefined && kind === 'comment') {
      const id = nextId++
      const c = { id, user: { login: `u${id}`, type: 'User' }, body: `text ${id}`, html_url: `https://x/c${id}`, created_at: now().toISOString() }
      pr.comments.push(c)
      must.push({ kind: 'comment', pr: { repo: REPO, number: pr.number }, id, author: c.user.login, body: c.body, url: c.html_url })
      await deliver('issue_comment', { action: 'created', issue: { number: pr.number, pull_request: {} }, comment: c, repository })
    } else if (pr !== undefined && kind === 'review') {
      const id = nextId++
      const state = r.pick(['approved', 'changes_requested', 'commented'] as const)
      const v = { id, state: state.toUpperCase(), user: { login: `r${id}` }, body: `review ${id}`, html_url: `https://x/r${id}`, submitted_at: now().toISOString() }
      pr.reviews.push(v)
      must.push({ kind: 'review', pr: { repo: REPO, number: pr.number }, id, state, author: v.user.login, body: v.body, url: v.html_url })
      await deliver('pull_request_review', { action: 'submitted', pull_request: { number: pr.number }, review: { ...v, state }, repository })
    } else if (pr !== undefined && kind === 'ci') {
      const sha = `h${pr.number}${nextId++}`
      pr.head = sha
      pr.bucket = 'pending'
      if (r.next() < 0.5) await deliver('check_suite', { action: 'completed', check_suite: { head_sha: sha }, repository })
      pr.bucket = r.pick(['pass', 'fail'] as const)
      pr.heads.push({ sha, bucket: pr.bucket })
      await deliver('check_suite', { action: 'completed', check_suite: { head_sha: sha }, repository })
    } else if (pr !== undefined && kind === 'close') {
      const merged = r.next() < 0.5
      pr.state = merged ? 'MERGED' : 'CLOSED'
      must.push({ kind: 'closed', pr: { repo: REPO, number: pr.number }, merged, by: merged ? 'merger' : '' })
      await deliver('pull_request', { action: 'closed', pull_request: { number: pr.number, merged, merged_by: merged ? { login: 'merger' } : null }, repository })
    } else if (kind === 'restart') {
      relay = fakeRelay()
      ctx = await make()
      await tick(ctx, now())
      relay.connect(REPO)
    } else if (kind === 'reconnect') relay.connect(REPO)
    else await tick(ctx, now())
  }

  // The failures stop. A reconnect replays what webhooks lost; a few ticks settle the rest.
  pOrca = 0
  pGh = 0
  relay.connect(REPO)
  // Ten minutes of ticks: past the longest retry wait (5 minutes) of a letter that failed last.
  for (let i = 0; i < 6; i++) {
    minute += 2
    await tick(ctx, now())
  }

  const problems: string[] = []
  const log = (() => {
    try {
      return readFileSync(join(home, 'watch.log'), 'utf8')
    } catch {
      return ''
    }
  })()
  const id = (l: { to: string; subject: string; body: string }) => `${l.to}\n${l.subject}\n${l.body}`
  const count = (key: string) => sent.filter(s => s === key).length
  const dropped = (key: string) => log.includes(`DROPPED ${key}`)

  // A PR's CI letter for the head GitHub ends on is a must while the PR is open. Earlier heads may be skipped, never repeated.
  for (const pr of prs) {
    const last = pr.heads[pr.heads.length - 1]
    if (pr.state === 'OPEN' && last !== undefined)
      must.push({ kind: 'ci', pr: { repo: REPO, number: pr.number }, headSha: last.sha, summary: { state: last.bucket === 'pass' ? 'passed' : 'failed', failed: last.bucket === 'fail' ? ['b'] : [], passed: last.bucket === 'pass' ? 1 : 0, skipped: 0 } })
  }
  for (const event of must)
    for (const letter of lettersFor(event, targets)) {
      // The manager's CI line names no SHA, so lines for two heads read the same: for it the check is "sent", not "once".
      const sameText = event.kind === 'ci' && letter.to.startsWith('run:')
      const n = count(id(letter))
      const ok = n === 1 || (sameText && n > 1) || (n === 0 && dropped(letter.key))
      if (!ok) problems.push(`seed ${seed}: ${letter.key} sent ${n} times`)
    }
  rmSync(root, { recursive: true, force: true })
  for (const s of new Set(sent)) if (count(s) > 1 && !/^run:[^\n]*\nkantoku-watch: \S+ \([^)]*\) CI (passed|failed)/.test(s)) problems.push(`seed ${seed}: sent ${count(s)} times: ${s.split('\n').slice(0, 2).join(' | ')}`)

  return problems
}

test(`fault injection: ${SEEDS} seeds, every letter that GitHub's facts call for is sent exactly once`, async () => {
  const problems: string[] = []
  for (let seed = 1; seed <= SEEDS; seed++) problems.push(...(await simulate(seed)))
  const failedSeeds = new Set(problems.map(p => p.split(':')[0]))
  assert.deepEqual(problems.slice(0, 15), [], `${failedSeeds.size} of ${SEEDS} seeds failed`)
})

// Fault injection for the outbox itself: letters that fail long enough to be dropped,
// mixed with crashes (a send that dies before it acts, a process that dies right after
// seen.json is written and before outbox.json is) and log writes that fail. When the
// failures stop, each letter is either sent exactly once, or has its DROPPED log line
// and (for a child's letter) a line to its manager, sent or itself DROPPED.
async function dropSimulate(seed: number): Promise<string[]> {
  const r = rng(seed)
  const home = mkdtempSync(join(tmpdir(), 'kw-drop-'))
  const letters: Letter[] = [1, 2, 3, 4, 5, 6].map(n =>
    n % 3 === 0
      ? { to: 'run:run_1', subject: `line ${n}`, body: '', key: `closed:o/r#${n}:merged>run:run_1` }
      : { to: `dispatch:ctx_${n}`, subject: `letter ${n}`, body: 'b', key: `comment:o/r#${n}:${n}>child:ctx_${n}`, manager: 'run:run_1' },
  )
  const sends: string[] = []
  const logs: string[] = []
  let pSend = r.pick([0.6, 0.8, 0.95])
  let pLog = r.pick([0, 0.2, 0.5])
  let pCrash = r.pick([0, 0.1, 0.3])
  let pSave = r.pick([0, 0.2, 0.4])
  const saveFails = pSave > 0
  let failedSaves = 0
  let t = 0
  const at = () => new Date(Date.parse('2026-11-18T00:00:00Z') + t)

  const open = async () => {
    const real = await openSeen(join(home, 'seen.json'))
    const seen: Seen = { ...real, save: async () => {
      await real.save()
      if (r.next() < pCrash) throw new Error('crash after seen.json, before outbox.json')
    } }

    // outbox.json writes fail now and then (a lock, EPERM on rename); the same process may go on afterwards.
    const write = async (path: string, value: unknown) => {
      if (r.next() < pSave) {
        failedSaves++
        throw new Error('EPERM: rename outbox.json')
      }
      await writeJson(path, value)
    }

    return openOutbox(join(home, 'outbox.json'), seen, write)
  }
  const send = async (letter: Letter) => {
    if (r.next() < pCrash) throw new Error('crash before the send')
    if (r.next() < pSend) return false
    sends.push(letter.key)

    return true
  }
  const log = async (line: string) => {
    if (r.next() < pLog) return r.next() < 0.5 ? false : Promise.reject(new Error('EIO'))
    logs.push(line)

    return true
  }

  // Like a webhook delivery: once put resolves, the caller marks the fact handled and never offers it again.
  let pending = [...letters]
  let outbox = await open()
  const offer = async () => {
    for (const letter of [...pending]) {
      await outbox.put([letter], at())
      pending = pending.filter(l => l !== letter)
    }
  }
  for (let step = 0; step < 60; step++) {
    t += (1 + Math.floor(r.next() * 4)) * 60 * 60_000
    try {
      await offer()
      // The process may die right after the caller marked its letters handled (a delivery ID saved).
      if (r.next() < pCrash) outbox = await open()
      // A catch-up finds the same facts again, for half the letters only: the other half, like the
      // letters of a closed PR, are never offered again once the caller took them as handled.
      if (r.next() < 0.2) await outbox.put(letters.slice(0, 3), at())
      await outbox.flush(send, at(), log)
    } catch {
      // A failed write: half the time the same process goes on, half the time it dies and a new one starts from the files.
      if (r.next() < 0.5) outbox = await open()
    }
    if (r.next() < pCrash) outbox = await open()
  }
  pSend = 0
  pLog = 0
  pCrash = 0
  pSave = 0
  outbox = await open()
  await offer()
  for (let i = 0; i < 20; i++) {
    t += 10 * 60_000
    await outbox.flush(send, at(), log)
  }

  const problems: string[] = []
  const count = (key: string) => sends.filter(k => k === key).length
  const droppedLines = (key: string) => logs.filter(line => line.startsWith(`DROPPED ${key} `)).length
  const droppedLine = (key: string) => droppedLines(key) > 0
  for (const letter of letters) {
    const sent = count(letter.key)
    const dropped = droppedLine(letter.key)
    const notice = `dropped:${letter.key}`
    // A letter is never sent twice: seen.json is saved right after each send. Without failed outbox writes,
    // each drop step happens exactly once too. A failed write of a drop's progress followed by a crash makes
    // the next process redo that step (the manager's line or a DROPPED line once more), never skip it.
    // Each failed write can make one step happen once more, no more.
    const once = (n: number) => (saveFails ? n >= 1 && n <= 1 + failedSaves : n === 1)
    const told = letter.manager === undefined || (once(count(notice)) && (saveFails || !droppedLine(notice))) || (count(notice) === 0 && once(droppedLines(notice)))
    const ok = (sent === 1 && !dropped && count(notice) === 0) || (sent === 0 && once(droppedLines(letter.key)) && told)
    if (!ok) problems.push(`seed ${seed}: ${letter.key} sent ${sent}, DROPPED line ${dropped}, notice sent ${count(notice)}`)
  }
  if (outbox.keys().length > 0) problems.push(`seed ${seed}: outbox not empty: ${outbox.keys().join(' ')}`)
  rmSync(home, { recursive: true, force: true })

  return problems
}

test(`fault injection: ${SEEDS} seeds of drops with crashes and failed log writes; no letter vanishes without its DROPPED line and its manager's line`, async () => {
  const problems: string[] = []
  for (let seed = 1; seed <= SEEDS; seed++) problems.push(...(await dropSimulate(seed)))
  const failedSeeds = new Set(problems.map(p => p.split(':')[0]))
  assert.deepEqual(problems.slice(0, 15), [], `${failedSeeds.size} of ${SEEDS} seeds failed`)
})
