// The daemon: every 15 seconds it reads the state files, tells the relay which
// repos to forward, catches up where needed, and writes a heartbeat. Webhook
// deliveries come in through handleDelivery. Both paths run one at a time, so
// a letter is never sent twice by a race between them.

import { appendFile, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { catchUp, ciEvent } from './catchup.ts'
import { parseWebhook } from './events.ts'
import type { Trouble, WatchEvent } from './events.ts'
import { sendLetters } from './notify.ts'
import type { Relay } from './relay.ts'
import { lettersFor } from './route.ts'
import type { Run } from './run.ts'
import { openSeen } from './seen.ts'
import type { Seen } from './seen.ts'
import { prKey, readAllTargets } from './targets.ts'
import type { PrRef, WatchTarget } from './targets.ts'

export type RepoState = 'forwarding' | 'polling' | 'failed' | 'needs-approval'

export type Status = {
  pid: number
  port: number
  startedAt: string
  lastAliveAt: string
  repos: Record<string, RepoState>
  troubles: string[]
}

type PrRecord = { firstSeenAt: string; closedAt?: string }

export type ContextOptions = {
  run: Run
  relay: Relay
  stateRoot: string
  home: string
  allow: Set<string>
  port: number
  now: Date
  // The terminal that started the daemon; Orca needs a sender for every send.
  from?: string
}

export type DaemonContext = {
  options: ContextOptions
  run: Run
  relay: Relay
  seen: Seen
  stateRoot: string
  home: string
  allow: Set<string>
  me: string | undefined
  startedAt: Date
  prs: Record<string, PrRecord>
  repos: Record<string, RepoState>
  troubles: string[]
  targets: WatchTarget[]
  lastOpenAt: Date
  lastPollAt: Map<string, number>
  // Repos to catch up. A repo leaves this set in one place only: the end of a tick whose catch-up for it read GitHub and sent every letter.
  toCatchUp: Set<string>
  incomplete: Set<string>
  relayTroubles: Map<string, Trouble>
  newTroubles: { repo: string; problem: Trouble }[]
  emptyOnce: boolean
  lock: Promise<unknown>
}

const IDLE_MS = 10 * 60_000
const POLL_MS = 10 * 60_000
const LOG_MAX = 1024 * 1024
const TROUBLES_KEEP = 20
const KEEP_MS = 14 * 24 * 60 * 60_000

export async function createContext(options: ContextOptions): Promise<DaemonContext> {
  const { run, relay, stateRoot, home, now } = options
  const me = await login(run)
  const ctx: DaemonContext = {
    options,
    run,
    relay,
    seen: await openSeen(join(home, 'seen.json')),
    stateRoot,
    home,
    allow: new Set([...options.allow].map(repo => repo.toLowerCase())),
    me,
    startedAt: now,
    prs: await readPrs(join(home, 'prs.json')),
    repos: {},
    troubles: [],
    targets: [],
    lastOpenAt: now,
    lastPollAt: new Map(),
    toCatchUp: new Set(),
    incomplete: new Set(),
    relayTroubles: new Map(),
    newTroubles: [],
    emptyOnce: false,
    lock: Promise.resolve(),
  }
  relay.onConnected(repo => {
    ctx.toCatchUp.add(repo)
    void log(ctx, `connected ${repo}`)
  })
  relay.onTrouble((repo, problem, detail) => {
    ctx.relayTroubles.set(repo, problem)
    ctx.newTroubles.push({ repo, problem })
    void log(ctx, `trouble ${repo} ${problem}: ${detail.split('\n')[0] ?? ''}`)
  })

  return ctx
}

export async function login(run: Run): Promise<string | undefined> {
  try {
    const result = await run('gh', ['api', 'user', '--jq', '.login'])
    const name = result.stdout.trim().toLowerCase()

    return result.code === 0 && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

export function isApproved(ctx: Pick<DaemonContext, 'me' | 'allow'>, repo: string): boolean {
  return (ctx.me !== undefined && repo.split('/')[0] === ctx.me) || ctx.allow.has(repo)
}

// Runs one job at a time: deliveries and ticks never interleave.
function serial<T>(ctx: DaemonContext, job: () => Promise<T>): Promise<T> {
  const next = ctx.lock.then(job, job)
  ctx.lock = next.catch(() => {})

  return next
}

export function tick(ctx: DaemonContext, now: Date): Promise<'continue' | 'idle-stop'> {
  return serial(ctx, async () => {
    await readTargets(ctx)
    const open = openPrs(ctx)
    const toCatchUp = new Set(ctx.toCatchUp)
    ctx.incomplete.clear()

    const repos = [...new Set(open.map(pr => pr.repo))].sort()
    const forwarded: string[] = []
    const nextRepos: Record<string, RepoState> = {}
    for (const repo of repos) {
      if (!isApproved(ctx, repo)) {
        nextRepos[repo] = 'needs-approval'
        if (ctx.repos[repo] !== 'needs-approval') await log(ctx, `needs approval ${repo}`)
        await report(ctx, { kind: 'trouble', repo, problem: 'needs-approval' }, now)
        continue
      }
      forwarded.push(repo)
      const problem = ctx.relayTroubles.get(repo)
      nextRepos[repo] = problem === undefined ? 'forwarding' : problem === 'no-admin' ? 'failed' : 'polling'
    }
    for (const repo of Object.keys(ctx.repos)) if (!(repo in nextRepos)) ctx.relayTroubles.delete(repo)
    ctx.repos = nextRepos
    await ctx.relay.sync(forwarded)

    for (const { repo, problem } of ctx.newTroubles.splice(0)) {
      ctx.troubles = [...ctx.troubles, `${now.toISOString()} ${repo} ${problem}`].slice(-TROUBLES_KEEP)
      await report(ctx, { kind: 'trouble', repo, problem }, now)
    }

    for (const pr of open) {
      const key = prKey(pr)
      const due = ctx.repos[pr.repo] === 'polling' && now.getTime() - (ctx.lastPollAt.get(pr.repo) ?? 0) >= POLL_MS
      if (ctx.prs[key] === undefined) await catchUpPr(ctx, pr, false, now)
      else if (toCatchUp.has(pr.repo) || due) await catchUpPr(ctx, pr, true, now)
    }
    for (const repo of toCatchUp) if (!ctx.incomplete.has(repo)) ctx.toCatchUp.delete(repo)
    for (const repo of repos) {
      if (ctx.repos[repo] === 'polling' && now.getTime() - (ctx.lastPollAt.get(repo) ?? 0) >= POLL_MS) ctx.lastPollAt.set(repo, now.getTime())
    }

    // Only PRs it can follow keep it alive: a repo waiting for approval or without admin rights never reports a close.
    const stillOpen = openPrs(ctx).some(pr => ctx.repos[pr.repo] === 'forwarding' || ctx.repos[pr.repo] === 'polling')
    if (stillOpen) ctx.lastOpenAt = now
    const watched = new Set(ctx.targets.map(t => prKey(t.pr)))
    ctx.seen.prune(watched, now)
    for (const [key, record] of Object.entries(ctx.prs))
      if (!watched.has(key) && now.getTime() - Date.parse(record.closedAt ?? record.firstSeenAt) > KEEP_MS) delete ctx.prs[key]
    await saveAll(ctx, now)
    if (!stillOpen && now.getTime() - ctx.lastOpenAt.getTime() >= IDLE_MS) {
      await ctx.relay.sync([])
      await log(ctx, 'idle stop: no open watched PR for 10 minutes')

      return 'idle-stop'
    }

    return 'continue'
  })
}

export function handleDelivery(ctx: DaemonContext, eventName: string, deliveryId: string, payload: unknown, now: Date): Promise<void> {
  return serial(ctx, async () => {
    const deliveryKey = `delivery:${deliveryId}`
    if (deliveryId !== '' && ctx.seen.has(deliveryKey)) return
    const event = parseWebhook(eventName, payload)
    if (event?.kind === 'ci-trigger') {
      for (const pr of openPrs(ctx).filter(pr => pr.repo === event.repo)) {
        const ci = await ciEvent(ctx.run, pr, event.headSha)
        if (ci === undefined) incomplete(ctx, pr.repo)
        else if (ci !== 'pending') await report(ctx, ci, now)
      }
    } else if (event !== undefined) await report(ctx, event, now)
    if (deliveryId !== '') ctx.seen.add(deliveryKey, now)
    await ctx.seen.save()
    await savePrs(ctx)
  })
}

function openPrs(ctx: DaemonContext): PrRef[] {
  const open = new Map<string, PrRef>()
  for (const target of ctx.targets) {
    const key = prKey(target.pr)
    if (ctx.prs[key]?.closedAt === undefined) open.set(key, target.pr)
  }

  return [...open.values()]
}

// A manager rewriting state.md can be read half-written. One empty read keeps
// the previous targets, so the forwarders are not stopped and started again.
async function readTargets(ctx: DaemonContext) {
  const targets = await readAllTargets(ctx.stateRoot)
  if (targets.length === 0 && ctx.targets.length > 0 && !ctx.emptyOnce) {
    ctx.emptyOnce = true

    return
  }
  ctx.emptyOnce = false
  ctx.targets = targets
}

async function catchUpPr(ctx: DaemonContext, pr: PrRef, known: boolean, now: Date) {
  const key = prKey(pr)
  const record = ctx.prs[key]
  const events = await catchUp(ctx.run, pr, known, record === undefined ? undefined : new Date(record.firstSeenAt))
  if (events === undefined) {
    await log(ctx, `could not read ${key} from GitHub; tried again at the next tick`)

    return incomplete(ctx, pr.repo)
  }
  // A PR first seen in rows that are all done is old news: record it without letters.
  const quiet = !known && ctx.targets.filter(t => prKey(t.pr) === key).every(t => t.rowDone)
  let allSent = true
  for (const event of events) allSent = (await report(ctx, event, now, quiet)) && allSent
  // A first-seen PR is recorded once its letters went out; until then the next tick tries the first-seen pass again.
  if (allSent && ctx.prs[key] === undefined) ctx.prs[key] = { firstSeenAt: now.toISOString() }
}

// Returns false when a letter could not be sent. Then the PR's repo is caught up
// again at the next tick, and a close is recorded only once its letters went out.
async function report(ctx: DaemonContext, event: WatchEvent, now: Date, quiet = false): Promise<boolean> {
  const letters = lettersFor(event, ctx.targets, now)
  let ok = true
  if (quiet) for (const letter of letters) ctx.seen.add(letter.key, now)
  else {
    const fresh = letters.filter(letter => !ctx.seen.has(letter.key))
    if (fresh.length > 0) {
      const result = await sendLetters(ctx.run, fresh, ctx.seen, now, ctx.options.from)
      for (const letter of fresh) await log(ctx, `${ctx.seen.has(letter.key) ? 'sent' : 'FAILED'} ${letter.to} ${letter.subject}`)
      ok = result.failed === 0
      if (!ok) await log(ctx, `${result.failed} letter(s) not sent; tried again at the next tick`)
    }
  }
  if (!ok && 'pr' in event) incomplete(ctx, event.pr.repo)
  if (ok && event.kind === 'closed' && ctx.targets.some(t => prKey(t.pr) === prKey(event.pr))) {
    const key = prKey(event.pr)
    ctx.prs[key] = { firstSeenAt: ctx.prs[key]?.firstSeenAt ?? now.toISOString(), closedAt: now.toISOString() }
  }

  return ok
}

// Something about this repo was not read or not sent: keep it queued for the next tick.
function incomplete(ctx: DaemonContext, repo: string) {
  ctx.toCatchUp.add(repo)
  ctx.incomplete.add(repo)
}

// One catch-up pass over every open PR, without forwarding (the `catchup` command).
export async function catchUpOnce(ctx: DaemonContext, now: Date): Promise<void> {
  await serial(ctx, async () => {
    await readTargets(ctx)
    for (const pr of openPrs(ctx)) await catchUpPr(ctx, pr, ctx.prs[prKey(pr)] !== undefined, now)
    await ctx.seen.save()
    await savePrs(ctx)
  })
}

// One daemon per machine: the lock file holds the pid of the one that runs.
// The holder counts as running by the same rule `status` uses: a live pid and
// either a lock touched in the last 2 minutes (the daemon's heartbeat touches it
// every 15 s on its own timer, not inside a tick) or a receiver that answers the
// authenticated ping. Only a successful exclusive create ever wins, and taking
// over a stale lock is done by the one process that creates `daemon.lock.claim`.
const LOCK_FRESH_MS = 2 * 60_000
const CLAIM_STALE_MS = 30_000

async function createOnly(path: string, pid: number): Promise<boolean> {
  try {
    await writeFile(path, String(pid), { flag: 'wx' })

    return true
  } catch {
    return false
  }
}

async function lockHolder(path: string): Promise<{ pid: number; touchedAt: number } | undefined> {
  try {
    const pid = Number((await readFile(path, 'utf8')).trim())

    return { pid, touchedAt: (await stat(path)).mtimeMs }
  } catch {
    return undefined
  }
}

export async function acquireLock(
  home: string,
  pid: number,
  isAlive: (pid: number) => boolean,
  answers: (holder: number) => Promise<boolean> = holder => answersPing(home, holder),
): Promise<boolean> {
  const path = join(home, 'daemon.lock')
  const holdsIt = async (holder: { pid: number; touchedAt: number } | undefined) =>
    holder !== undefined && Number.isInteger(holder.pid) && holder.pid > 0 && isAlive(holder.pid) &&
    (Date.now() - holder.touchedAt < LOCK_FRESH_MS || (await answers(holder.pid)))

  if (await createOnly(path, pid)) return true
  const holder = await lockHolder(path)
  if (holder?.pid === pid) return true
  if (await holdsIt(holder)) return false

  const claim = `${path}.claim`
  const claimer = await lockHolder(claim)
  if (claimer !== undefined && Date.now() - claimer.touchedAt > CLAIM_STALE_MS) await unlink(claim).catch(() => {})
  if (!(await createOnly(claim, pid))) return false
  try {
    const again = await lockHolder(path)
    if (again !== undefined && (again.pid !== holder?.pid || again.touchedAt !== holder?.touchedAt || (await holdsIt(again)))) return false
    await unlink(path).catch(() => {})

    return await createOnly(path, pid)
  } finally {
    await unlink(claim).catch(() => {})
  }
}

// The holder is a running kantoku-watch if status.json in `home` names it and
// its receiver answers POST /ping with the secret.
export async function answersPing(home: string, holder: number): Promise<boolean> {
  try {
    const status = JSON.parse(await readFile(join(home, 'status.json'), 'utf8'))
    const secret = (await readFile(join(home, 'secret'), 'utf8')).trim()
    if (status?.pid !== holder || typeof status.port !== 'number' || status.port <= 0) return false
    const res = await fetch(`http://127.0.0.1:${status.port}/ping`, {
      method: 'POST',
      headers: { 'x-kantoku-watch-secret': secret },
      signal: AbortSignal.timeout(3000),
    })

    return res.status === 204
  } catch {
    return false
  }
}

// The daemon's heartbeat: touches its lock. False when the lock is no longer
// this process's (another daemon took it); the daemon then stops.
export async function heartbeat(home: string): Promise<boolean> {
  const path = join(home, 'daemon.lock')
  try {
    if (Number((await readFile(path, 'utf8')).trim()) !== process.pid) return false
    const now = new Date()
    await utimes(path, now, now)

    return true
  } catch {
    return false
  }
}

export async function releaseLock(home: string, pid: number): Promise<void> {
  const path = join(home, 'daemon.lock')
  try {
    if (Number((await readFile(path, 'utf8')).trim()) === pid) await unlink(path)
  } catch {}
}

export function statusOf(ctx: DaemonContext, now: Date): Status {
  return {
    pid: process.pid,
    port: ctx.options.port,
    startedAt: ctx.startedAt.toISOString(),
    lastAliveAt: now.toISOString(),
    repos: ctx.repos,
    troubles: ctx.troubles,
  }
}

async function saveAll(ctx: DaemonContext, now: Date) {
  await ctx.seen.save()
  await savePrs(ctx)
  await writeJson(join(ctx.home, 'status.json'), statusOf(ctx, now))
}

async function savePrs(ctx: DaemonContext) {
  await writeJson(join(ctx.home, 'prs.json'), ctx.prs)
}

export async function writeJson(path: string, value: unknown) {
  // The heartbeat timer and a tick can write status.json at the same time, so each write has its own temp file.
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 1))
  await rename(temp, path)
}

export async function readPrs(path: string): Promise<Record<string, PrRecord>> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
    const prs: Record<string, PrRecord> = {}
    for (const [key, value] of Object.entries(data))
      if (typeof value?.firstSeenAt === 'string')
        prs[key] = typeof value.closedAt === 'string' ? { firstSeenAt: value.firstSeenAt, closedAt: value.closedAt } : { firstSeenAt: value.firstSeenAt }

    return prs
  } catch {
    return {}
  }
}

export async function log(ctx: Pick<DaemonContext, 'home'>, line: string) {
  const path = join(ctx.home, 'watch.log')
  try {
    if ((await stat(path)).size > LOG_MAX) await rename(path, `${path}.1`)
  } catch {}
  try {
    await appendFile(path, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
