// Turns one GitHub webhook delivery into the one event kantoku-watch reports.
// Payloads come from outside, so every reader checks the shape and returns
// undefined for anything it does not know, never throws.

import type { PrRef } from './targets.ts'

export type CiSummary = {
  state: 'passed' | 'failed' | 'pending'
  failed: string[]
  passed: number
  skipped: number
}

export type Trouble =
  | 'gh-missing' | 'gh-not-logged-in' | 'extension-missing'
  | 'scope-missing' | 'no-admin' | 'needs-approval'
  | 'forwarder-exited' | 'forwarder-gave-up'

export type ReviewState = 'approved' | 'changes_requested' | 'commented'

export type WatchEvent =
  | { kind: 'ci'; pr: PrRef; headSha: string; summary: CiSummary }
  | { kind: 'review'; pr: PrRef; id: number; state: ReviewState; author: string; body: string; url: string }
  | { kind: 'comment'; pr: PrRef; id: number; author: string; body: string; url: string }
  | { kind: 'closed'; pr: PrRef; merged: boolean; by: string }
  | { kind: 'ci-trigger'; repo: string; headSha: string | undefined }
  | { kind: 'trouble'; repo: string; problem: Trouble }

type Json = Record<string, unknown>

const obj = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function reviewState(value: unknown): ReviewState | undefined {
  const state = str(value)?.toLowerCase()

  return state === 'approved' || state === 'changes_requested' || state === 'commented' ? state : undefined
}

export function parseWebhook(eventName: string, payload: unknown): WatchEvent | undefined {
  const body = obj(payload)
  if (body === undefined) return undefined
  const repo = str(obj(body.repository)?.full_name)?.toLowerCase()
  if (repo === undefined) return undefined

  switch (eventName) {
    case 'pull_request_review': return review(body, repo)
    case 'issue_comment': return comment(body, repo)
    case 'pull_request': return closed(body, repo)
    case 'check_suite': return body.action === 'completed' ? ciTrigger(repo, str(obj(body.check_suite)?.head_sha)) : undefined
    case 'status': return ciTrigger(repo, str(body.sha))
    default: return undefined
  }
}

function ciTrigger(repo: string, headSha: string | undefined): WatchEvent | undefined {
  return headSha === undefined ? undefined : { kind: 'ci-trigger', repo, headSha }
}

function review(body: Json, repo: string): WatchEvent | undefined {
  if (body.action !== 'submitted') return undefined
  const r = obj(body.review)
  const number = num(obj(body.pull_request)?.number)
  const id = num(r?.id)
  const state = reviewState(r?.state)
  const author = str(obj(r?.user)?.login)
  if (r === undefined || number === undefined || id === undefined || state === undefined || author === undefined) return undefined

  return { kind: 'review', pr: { repo, number }, id, state, author, body: str(r.body) ?? '', url: str(r.html_url) ?? '' }
}

function comment(body: Json, repo: string): WatchEvent | undefined {
  if (body.action !== 'created') return undefined
  const issue = obj(body.issue)
  const c = obj(body.comment)
  const user = obj(c?.user)
  const number = num(issue?.number)
  const id = num(c?.id)
  const author = str(user?.login)
  if (obj(issue?.pull_request) === undefined || user?.type === 'Bot') return undefined
  if (c === undefined || number === undefined || id === undefined || author === undefined) return undefined

  return { kind: 'comment', pr: { repo, number }, id, author, body: str(c.body) ?? '', url: str(c.html_url) ?? '' }
}

function closed(body: Json, repo: string): WatchEvent | undefined {
  if (body.action !== 'closed') return undefined
  const pr = obj(body.pull_request)
  const number = num(pr?.number)
  if (pr === undefined || number === undefined) return undefined
  const merged = pr.merged === true
  const by = (merged ? str(obj(pr.merged_by)?.login) : undefined) ?? str(obj(body.sender)?.login) ?? ''

  return { kind: 'closed', pr: { repo, number }, merged, by }
}
