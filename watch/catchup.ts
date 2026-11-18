// Reads a PR's current state with `gh`, for what webhooks cannot replay:
// the time kantoku-watch was stopped, a PR seen for the first time, a reconnect.
// Reviews and comments come from the REST API because `gh pr view` gives
// GraphQL node IDs, and the dedupe keys use the numeric IDs webhooks carry.

import { summarizeChecks } from './ci.ts'
import { reviewState } from './events.ts'
import type { WatchEvent } from './events.ts'
import type { Run } from './run.ts'
import type { PrRef } from './targets.ts'

type Json = Record<string, any>

async function ghJson(run: Run, args: string[], okCodes = [0]): Promise<unknown> {
  try {
    const result = await run('gh', args)
    if (!okCodes.includes(result.code)) return undefined

    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

const isObj = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.flat().filter(isObj) : [])

async function viewOf(run: Run, pr: PrRef): Promise<Json | undefined> {
  const view = await ghJson(run, ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'state,mergedAt,headRefOid,mergedBy'])

  return isObj(view) ? view : undefined
}

async function ciFor(run: Run, pr: PrRef, headSha: string): Promise<WatchEvent | undefined> {
  // `gh pr checks` exits 8 while checks are pending and 1 when one failed.
  const checks = await ghJson(run, ['pr', 'checks', String(pr.number), '--repo', pr.repo, '--json', 'name,bucket'], [0, 1, 8])
  const rows = list(checks).filter(c => typeof c.name === 'string' && typeof c.bucket === 'string')
  const summary = summarizeChecks(rows.map(c => ({ name: c.name, bucket: c.bucket })))

  return summary.state === 'pending' ? undefined : { kind: 'ci', pr, headSha, summary }
}

export async function ciEvent(run: Run, pr: PrRef, headSha?: string): Promise<WatchEvent | undefined> {
  const view = await viewOf(run, pr)
  const head = typeof view?.headRefOid === 'string' ? view.headRefOid : undefined
  if (head === undefined || (headSha !== undefined && headSha !== head)) return undefined

  return ciFor(run, pr, head)
}

// undefined: the PR could not be read (gh failed); the caller tries again later.
export async function catchUp(run: Run, pr: PrRef, known: boolean, since: Date | undefined): Promise<WatchEvent[] | undefined> {
  const events: WatchEvent[] = []
  const view = await viewOf(run, pr)
  if (view === undefined) return undefined
  const head = typeof view.headRefOid === 'string' ? view.headRefOid : undefined
  const ci = head === undefined ? undefined : await ciFor(run, pr, head)
  if (ci !== undefined) events.push(ci)

  const incremental = known && since !== undefined
  const after = (at: unknown) => incremental && typeof at === 'string' && Date.parse(at) > (since?.getTime() ?? 0)

  const reviews = list(await ghJson(run, ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--slurp']))
    .flatMap(r => {
      const state = reviewState(r.state)
      const author = r.user?.login

      return typeof r.id === 'number' && state !== undefined && typeof author === 'string'
        ? [{ event: { kind: 'review', pr, id: r.id, state, author, body: String(r.body ?? ''), url: String(r.html_url ?? '') } as const, at: String(r.submitted_at ?? '') }]
        : []
    })
  if (incremental) events.push(...reviews.filter(r => after(r.at)).map(r => r.event))
  else {
    const latest = new Map<string, (typeof reviews)[number]>()
    for (const r of reviews)
      if (r.event.state !== 'commented' && (latest.get(r.event.author)?.at ?? '') <= r.at) latest.set(r.event.author, r)
    events.push(...[...latest.values()].map(r => r.event))
  }

  if (incremental) {
    const comments = list(await ghJson(run, ['api', `repos/${pr.repo}/issues/${pr.number}/comments`, '--paginate', '--slurp']))
    for (const c of comments)
      if (typeof c.id === 'number' && typeof c.user?.login === 'string' && c.user?.type !== 'Bot' && after(c.created_at))
        events.push({ kind: 'comment', pr, id: c.id, author: c.user.login, body: String(c.body ?? ''), url: String(c.html_url ?? '') })
  }

  if (view.state === 'MERGED' || view.state === 'CLOSED') {
    const merged = view.state === 'MERGED'
    events.push({ kind: 'closed', pr, merged, by: (merged && typeof view.mergedBy?.login === 'string' ? view.mergedBy.login : undefined) ?? '' })
  }

  return events
}
