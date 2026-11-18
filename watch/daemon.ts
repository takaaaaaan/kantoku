// The daemon: every 15 seconds it reads the state files, tells the relay which
// repos to forward, catches up where needed, and writes a heartbeat. Webhook
// deliveries come in through handleDelivery. Both paths run one at a time, so
// a letter is never sent twice by a race between them.

import { appendFile, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJson } from './files.ts'
import { catchUp, ciEvent } from './catchup.ts'
import { parseWebhook } from './events.ts'
import type { Trouble, WatchEvent } from './events.ts'
import { sendLetter } from './notify.ts'
import { openOutbox, retryWaitMs } from './outbox.ts'
import type { Outbox } from './outbox.ts'
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
  // Letters in the outbox, not sent yet.
  unsent?: number
}

// What kantoku-watch knows about a PR. It says nothing about letters: those live in the outbox.
// firstSeenAt: its first full read from GitHub succeeded (missing only when a close
// webhook came first). closedAt: a close was seen. finalReadAt: a catch-up read the
// closed PR once more, so facts whose webhooks were lost before the close are in the
// outbox too. Only then does the PR stop being followed.
export type PrRecord = { firstSeenAt?: string; closedAt?: string; finalReadAt?: string }

// The one rule for "this PR must be read from GitHub at the next tick, whatever else happened".
export function needsRead(record: PrRecord | undefined): boolean {
  return record?.firstSeenAt === undefined || (record.closedAt !== undefined && record.finalReadAt === undefined)
}

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
  outbox: Outbox
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
  // Repos to read from GitHub again (a reconnect, or a read that failed). A repo leaves
  // it at the end of a tick whose catch-up read every followed PR in it, and only if no
  // new request came while that catch-up ran. Sending is not its business: unsent letters
  // wait in the outbox.
  toCatchUp: CatchUpQueue
  // PRs whose last reads failed: how many in a row, and when the last one was.
  readFailures: Map<string, { count: number; at: number }>
  relayTroubles: Map<string, Trouble>
  newTroubles: { repo: string; problem: Trouble }[]
  emptyOnce: boolean
  lock: Promise<unknown>
}

// The catch-up requests. Every add (a reconnect, a failed read) raises the repo's
// generation, so a catch-up that started before a request cannot finish it.
export class CatchUpQueue extends Set<string> {
  // Created lazily: the Set constructor may call add before class fields exist.
  private generations: Map<string, number> | undefined

  override add(repo: string): this {
    this.generations ??= new Map()
    this.generations.set(repo, this.generation(repo) + 1)

    return super.add(repo)
  }

  generation(repo: string): number {
    return this.generations?.get(repo) ?? 0
  }

  // Removes the request only if nothing asked again since that generation was read.
  finish(repo: string, generation: number) {
    if (this.generation(repo) === generation) this.delete(repo)
  }
}

const IDLE_MS =10 * 60_000
const POLL_MS = 10 * 60_000
const LOG_MAX = 1024 * 1024
const TROUBLES_KEEP = 20
const KEEP_MS = 14 * 24 * 60 * 60_000

export async function createContext(options: ContextOptions): Promise<DaemonContext> {
  const { run, relay, stateRoot, home, now } = options
  const me = await login(run)
  const seen = await openSeen(join(home, 'seen.json'))
  const ctx: DaemonContext = {
    options,
    run,
    relay,
    seen,
    outbox: await openOutbox(join(home, 'outbox.json'), seen),
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
    toCatchUp: new CatchUpQueue(),
    readFailures: new Map(),
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
    // The requests this tick answers, each with its generation: one that comes during the reads is newer and stays.
    const toCatchUp = new Map([...ctx.toCatchUp].map(repo => [repo, ctx.toCatchUp.generation(repo)]))

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

    const unread = new Set<string>()
    for (const pr of followedPrs(ctx)) {
      const key = prKey(pr)
      const due = ctx.repos[pr.repo] === 'polling' && now.getTime() - (ctx.lastPollAt.get(pr.repo) ?? 0) >= POLL_MS
      if (!(needsRead(ctx.prs[key]) || toCatchUp.has(pr.repo) || due)) continue
      // A PR whose read keeps failing (a deleted repo, an outage) is tried 30 s, 1 min, ... at most 5 min apart, not every tick.
      const failed = ctx.readFailures.get(key)
      if (failed !== undefined && now.getTime() - failed.at < retryWaitMs(failed.count)) {
        unread.add(pr.repo)
        continue
      }
      if (await catchUpPr(ctx, pr, now)) ctx.readFailures.delete(key)
      else {
        ctx.readFailures.set(key, { count: (failed?.count ?? 0) + 1, at: now.getTime() })
        unread.add(pr.repo)
      }
    }
    for (const [repo, generation] of toCatchUp) if (!unread.has(repo)) ctx.toCatchUp.finish(repo, generation)
    for (const repo of repos) {
      if (ctx.repos[repo] === 'polling' && now.getTime() - (ctx.lastPollAt.get(repo) ?? 0) >= POLL_MS) ctx.lastPollAt.set(repo, now.getTime())
    }
    await flush(ctx, now)

    // Only PRs it can follow keep it alive: a repo waiting for approval or without admin rights never reports a close.
    // Letters still in the outbox keep it alive too, until they are sent or dropped.
    const stillOpen = openPrs(ctx).some(pr => ctx.repos[pr.repo] === 'forwarding' || ctx.repos[pr.repo] === 'polling')
    if (stillOpen || ctx.outbox.unsent() > 0) ctx.lastOpenAt = now
    const watched = new Set(ctx.targets.map(t => prKey(t.pr)))
    ctx.seen.prune(watched, now)
    for (const [key, record] of Object.entries(ctx.prs))
      if (!watched.has(key) && now.getTime() - Date.parse(record.closedAt ?? record.firstSeenAt ?? now.toISOString()) > KEEP_MS) delete ctx.prs[key]
    await saveAll(ctx, now)
    if (now.getTime() - ctx.lastOpenAt.getTime() >= IDLE_MS) {
      await ctx.relay.sync([])
      await log(ctx, 'idle stop: no open watched PR and no unsent letter for 10 minutes')

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
    try {
      if (event?.kind === 'ci-trigger') {
        for (const pr of openPrs(ctx).filter(pr => pr.repo === event.repo)) {
          const ci = await ciEvent(ctx.run, pr, event.headSha)
          if (ci === undefined) ctx.toCatchUp.add(pr.repo)
          else if (ci !== 'pending') await report(ctx, ci, now)
        }
      } else if (event !== undefined) await report(ctx, event, now)
    } catch (error) {
      // outbox.json could not be written: the delivery stays unhandled, and a catch-up reads the repo again.
      if (event !== undefined) ctx.toCatchUp.add('repo' in event ? event.repo : event.pr.repo)
      throw error
    }
    // The letters are in the outbox on disk before the delivery is marked handled.
    await savePrs(ctx)
    if (deliveryId !== '') ctx.seen.add(deliveryKey, now)
    await ctx.seen.save()
    await flush(ctx, now)
  })
}

// PRs kantoku-watch still reads from GitHub: open ones, and closed ones not yet read once after the close.
function followedPrs(ctx: DaemonContext): PrRef[] {
  const followed = new Map<string, PrRef>()
  for (const target of ctx.targets) {
    const record = ctx.prs[prKey(target.pr)]
    if (record?.closedAt === undefined || needsRead(record)) followed.set(prKey(target.pr), target.pr)
  }

  return [...followed.values()]
}

function openPrs(ctx: DaemonContext): PrRef[] {
  return followedPrs(ctx).filter(pr => ctx.prs[prKey(pr)]?.closedAt === undefined)
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

// Reads one PR from GitHub and puts what it finds in the outbox. False when GitHub could not be read.
async function catchUpPr(ctx: DaemonContext, pr: PrRef, now: Date): Promise<boolean> {
  const key = prKey(pr)
  const firstSeenAt = ctx.prs[key]?.firstSeenAt
  const events = await catchUp(ctx.run, pr, firstSeenAt !== undefined, firstSeenAt === undefined ? undefined : new Date(firstSeenAt))
  if (events === undefined) {
    await log(ctx, `could not read ${key} from GitHub; tried again later`)

    return false
  }
  // A PR first seen in rows that are all done is old news: record it without letters.
  const quiet = firstSeenAt === undefined && ctx.targets.filter(t => prKey(t.pr) === key).every(t => t.rowDone)
  for (const event of events) await report(ctx, event, now, quiet)
  // A successful read of a closed PR is its last one: its comments and reviews are now in
  // the outbox. That holds even when GitHub still says OPEN (its view can lag behind the
  // webhook); a reopened PR is not followed again, as before.
  const current = ctx.prs[key]
  const closedAt = current?.closedAt ?? (events.some(event => event.kind === 'closed') ? now.toISOString() : undefined)
  const read: PrRecord = { firstSeenAt: firstSeenAt ?? now.toISOString() }
  ctx.prs[key] = closedAt === undefined ? read : { ...read, closedAt, finalReadAt: now.toISOString() }

  return true
}

// Turns an event into letters and puts them in the outbox (on disk). A close also
// changes the PR's state; it never touches the outbox. Sending is flush's job.
async function report(ctx: DaemonContext, event: WatchEvent, now: Date, quiet = false) {
  const letters = lettersFor(event, ctx.targets, now)
  // Quiet (old news) marks facts as known without letters, but never a letter a webhook already put in the outbox.
  if (quiet) for (const letter of letters) {
    if (ctx.outbox.entry(letter.key) === undefined) ctx.seen.add(letter.key, now)
  }
  else await ctx.outbox.put(letters, now)
  // A close is recorded at once. For a PR not read yet it is recorded without firstSeenAt,
  // so its first catch-up is still the full first-seen read of everything before the close.
  if (event.kind === 'closed' && ctx.targets.some(t => prKey(t.pr) === prKey(event.pr))) {
    const key = prKey(event.pr)
    if (ctx.prs[key]?.closedAt === undefined) ctx.prs[key] = { ...ctx.prs[key], closedAt: now.toISOString() }
  }
}

// Tries the letters in the outbox that are due. outbox.ts decides what leaves it.
async function flush(ctx: DaemonContext, now: Date) {
  await ctx.outbox.flush(letter => sendLetter(ctx.run, letter, ctx.options.from), now, line => log(ctx, line))
}

// One catch-up pass over every followed PR, without forwarding (the `catchup` command).
export async function catchUpOnce(ctx: DaemonContext, now: Date): Promise<void> {
  await serial(ctx, async () => {
    await readTargets(ctx)
    for (const pr of followedPrs(ctx)) await catchUpPr(ctx, pr, now)
    await ctx.seen.save()
    await savePrs(ctx)
    await flush(ctx, now)
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
    unsent: ctx.outbox.unsent(),
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


export async function readPrs(path: string): Promise<Record<string, PrRecord>> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
    const prs: Record<string, PrRecord> = {}
    for (const [key, value] of Object.entries(data))
      if (typeof value?.firstSeenAt === 'string' || typeof value?.closedAt === 'string')
        prs[key] = {
          ...(typeof value.firstSeenAt === 'string' ? { firstSeenAt: value.firstSeenAt } : {}),
          ...(typeof value.closedAt === 'string' ? { closedAt: value.closedAt } : {}),
          ...(typeof value.finalReadAt === 'string' ? { finalReadAt: value.finalReadAt } : {}),
        }

    return prs
  } catch {
    return {}
  }
}

// False when the line could not be written. Most callers ignore that; the outbox
// does not finish a drop until its DROPPED line is written.
export async function log(ctx: Pick<DaemonContext, 'home'>, line: string): Promise<boolean> {
  const path = join(ctx.home, 'watch.log')
  try {
    if ((await stat(path)).size > LOG_MAX) await rename(path, `${path}.1`)
  } catch {}
  try {
    await appendFile(path, `${new Date().toISOString()} ${line}\n`)

    return true
  } catch {
    return false
  }
}
