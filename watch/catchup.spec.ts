import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { catchUp, ciEvent } from './catchup.ts'
import { parseWebhook } from './events.ts'
import { factKey } from './route.ts'
import { fakeRun, json } from './testing.ts'
import type { Answer } from './testing.ts'

const pr = { repo: 'owner/repo', number: 12 }
const head = '1a2b3c4d5e6f'
const view = (over: Record<string, unknown> = {}) => json({ state: 'OPEN', mergedAt: null, headRefOid: head, mergedBy: null, ...over })
const checks = (buckets: string[]): Answer => ({ stdout: JSON.stringify(buckets.map((bucket, at) => ({ name: `c${at}`, bucket }))), code: buckets.includes('pending') ? 8 : 0 })
const review = (id: number, login: string, state: string, at: string) => ({
  id, user: { login, type: 'User' }, state, body: `body ${id}`, html_url: `https://github.com/Owner/Repo/pull/12#pullrequestreview-${id}`, submitted_at: at,
})
const comment = (id: number, login: string, at: string, type = 'User') => ({
  id, user: { login, type }, body: `comment ${id}`, html_url: `https://github.com/Owner/Repo/pull/12#issuecomment-${id}`, created_at: at,
})

function gh(answers: { view?: Answer; checks?: Answer; reviews?: unknown[]; comments?: unknown[] }) {
  return fakeRun((cmd, args) => {
    if (cmd !== 'gh') return { code: 1 }
    if (args[0] === 'pr' && args[1] === 'view') return answers.view ?? view()
    if (args[0] === 'pr' && args[1] === 'checks') return answers.checks ?? checks(['pass'])
    if (args[0] === 'api' && args[1]?.endsWith('/reviews')) return json([answers.reviews ?? []])
    if (args[0] === 'api' && args[1]?.endsWith('/comments')) return json([answers.comments ?? []])

    return { code: 1 }
  })
}

test('ciEvent: undefined while pending, a ci event when done', async () => {
  assert.equal(await ciEvent(gh({ checks: checks(['pass', 'pending']) }), pr), undefined)
  assert.equal(await ciEvent(gh({ checks: { code: 1, stderr: "no checks reported on the 'x' branch" } }), pr), undefined)
  const run = gh({ checks: checks(['pass', 'fail']) })
  assert.deepEqual(await ciEvent(run, pr), { kind: 'ci', pr, headSha: head, summary: { state: 'failed', failed: ['c1'], passed: 1, skipped: 0 } })
  assert.deepEqual(run.calls, [
    ['gh', 'pr', 'view', '12', '--repo', 'owner/repo', '--json', 'state,mergedAt,headRefOid,mergedBy'],
    ['gh', 'pr', 'checks', '12', '--repo', 'owner/repo', '--json', 'name,bucket'],
  ])
})

test('ciEvent: a trigger for another head is ignored', async () => {
  assert.equal(await ciEvent(gh({}), pr, 'ffff'), undefined)
  assert.equal((await ciEvent(gh({}), pr, head))?.kind, 'ci')
})

test('catchUp, known PR: only reviews and comments after since', async () => {
  const run = gh({
    reviews: [review(1, 'a', 'APPROVED', '2026-11-18T09:00:00Z'), review(2, 'b', 'COMMENTED', '2026-11-18T11:00:00Z'), review(3, 'c', 'PENDING', '2026-11-18T11:00:00Z')],
    comments: [comment(10, 'x', '2026-11-18T09:00:00Z'), comment(11, 'y', '2026-11-18T11:00:00Z'), comment(12, 'bot', '2026-11-18T11:00:00Z', 'Bot')],
  })
  const events = await catchUp(run, pr, true, new Date('2026-11-18T10:00:00Z'))
  assert.deepEqual(events.map(e => e.kind === 'review' || e.kind === 'comment' ? `${e.kind}:${e.id}` : e.kind), ['ci', 'review:2', 'comment:11'])
  assert.deepEqual(run.calls.find(c => c[2]?.endsWith('/reviews')), ['gh', 'api', 'repos/owner/repo/pulls/12/reviews', '--paginate', '--slurp'])
})

test('catchUp, first-seen PR: latest decision per reviewer, no comments', async () => {
  const run = gh({
    reviews: [
      review(1, 'a', 'CHANGES_REQUESTED', '2026-11-18T09:00:00Z'),
      review(2, 'a', 'APPROVED', '2026-11-18T10:00:00Z'),
      review(3, 'a', 'COMMENTED', '2026-11-18T11:00:00Z'),
      review(4, 'b', 'CHANGES_REQUESTED', '2026-11-18T09:30:00Z'),
    ],
    comments: [comment(10, 'x', '2026-11-18T09:00:00Z')],
  })
  const events = await catchUp(run, pr, false, undefined)
  assert.deepEqual(events.map(e => e.kind === 'review' ? `${e.id}:${e.state}` : e.kind), ['ci', '2:approved', '4:changes_requested'])
})

test('catchUp, closed PR yields closed with merged from the state', async () => {
  const merged = await catchUp(gh({ view: view({ state: 'MERGED', mergedAt: '2026-11-18T10:00:00Z', mergedBy: { login: 'merger-login' } }) }), pr, true, new Date())
  assert.deepEqual(merged.at(-1), { kind: 'closed', pr, merged: true, by: 'merger-login' })
  const closed = await catchUp(gh({ view: view({ state: 'CLOSED' }) }), pr, true, new Date())
  assert.deepEqual(closed.at(-1), { kind: 'closed', pr, merged: false, by: '' })
})

test('catchUp: gh failing returns what it could read, never throws', async () => {
  const run = fakeRun(() => ({ code: 1, stderr: 'HTTP 502' }))
  assert.deepEqual(await catchUp(run, pr, true, new Date()), [])
})

test('the same review from a webhook and from catch-up has the same factKey', async () => {
  const payload = JSON.parse(readFileSync(new URL('./fixtures/review-approved.json', import.meta.url), 'utf8'))
  const fromHook = parseWebhook('pull_request_review', payload)
  const r = payload.review
  const run = gh({ reviews: [{ id: r.id, user: r.user, state: 'APPROVED', body: r.body, html_url: r.html_url, submitted_at: '2026-11-18T10:00:00Z' }] })
  const fromCatchUp = (await catchUp(run, pr, false, undefined)).find(e => e.kind === 'review')
  assert.ok(fromHook && fromCatchUp)
  assert.equal(factKey(fromCatchUp), factKey(fromHook))
  assert.deepEqual(fromCatchUp, fromHook)
})
