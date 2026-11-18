// The daemon: every 15 seconds it reads the state files, tells the relay which
// repos to forward, catches up where needed, and writes a heartbeat. Webhook
// deliveries come in through handleDelivery. Both paths run one at a time, so
// a letter is never sent twice by a race between them.

import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
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
  toCatchUp: Set<string>
  relayTroubles: Map<string, Trouble>
  newTroubles: { repo: string; problem: Trouble }[]
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
    relayTroubles: new Map(),
    newTroubles: [],
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
    ctx.targets = await readAllTargets(ctx.stateRoot)
    const open = openPrs(ctx)

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
      else if (ctx.toCatchUp.has(pr.repo) || due) await catchUpPr(ctx, pr, true, now)
    }
    for (const repo of repos) {
      ctx.toCatchUp.delete(repo)
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
        if (ci !== undefined) await report(ctx, ci, now)
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

async function catchUpPr(ctx: DaemonContext, pr: PrRef, known: boolean, now: Date) {
  const key = prKey(pr)
  const record = ctx.prs[key]
  const events = await catchUp(ctx.run, pr, known, record === undefined ? undefined : new Date(record.firstSeenAt))
  // A PR first seen in rows that are all done is old news: record it without letters.
  const quiet = !known && ctx.targets.filter(t => prKey(t.pr) === key).every(t => t.rowDone)
  ctx.prs[key] = record ?? { firstSeenAt: now.toISOString() }
  for (const event of events) await report(ctx, event, now, quiet)
}

async function report(ctx: DaemonContext, event: WatchEvent, now: Date, quiet = false) {
  if (event.kind === 'closed' && ctx.targets.some(t => prKey(t.pr) === prKey(event.pr))) {
    const key = prKey(event.pr)
    ctx.prs[key] = { firstSeenAt: ctx.prs[key]?.firstSeenAt ?? now.toISOString(), closedAt: now.toISOString() }
  }
  const letters = lettersFor(event, ctx.targets, now)
  if (quiet) {
    for (const letter of letters) ctx.seen.add(letter.key, now)

    return
  }
  const fresh = letters.filter(letter => !ctx.seen.has(letter.key))
  if (fresh.length === 0) return
  const result = await sendLetters(ctx.run, fresh, ctx.seen, now, ctx.options.from)
  for (const letter of fresh) await log(ctx, `${ctx.seen.has(letter.key) ? 'sent' : 'FAILED'} ${letter.to} ${letter.subject}`)
  if (result.failed > 0) await log(ctx, `${result.failed} letter(s) not sent; retried at the next trigger or catch-up`)
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
  const temp = `${path}.${process.pid}.tmp`
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
