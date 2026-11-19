import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseWebhook } from './events.ts'

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const pr = { repo: 'owner/repo', number: 12 }

test('review approved', () => {
  assert.deepEqual(parseWebhook('pull_request_review', fixture('review-approved')), {
    kind: 'review', pr, id: 101, state: 'approved', author: 'reviewer-login', body: 'Looks good.',
    url: 'https://github.com/Owner/Repo/pull/12#pullrequestreview-101',
  })
})

test('review changes requested', () => {
  assert.deepEqual(parseWebhook('pull_request_review', fixture('review-changes-requested')), {
    kind: 'review', pr, id: 102, state: 'changes_requested', author: 'reviewer-login',
    body: 'Please split the parser out of the handler.',
    url: 'https://github.com/Owner/Repo/pull/12#pullrequestreview-102',
  })
})

test('review commented', () => {
  const event = parseWebhook('pull_request_review', fixture('review-commented'))
  assert.equal(event?.kind === 'review' && event.state, 'commented')
})

test('review state in upper case (as gh pr view gives it) is read the same', () => {
  const payload = fixture('review-approved')
  payload.review.state = 'APPROVED'
  const event = parseWebhook('pull_request_review', payload)
  assert.equal(event?.kind === 'review' && event.state, 'approved')
})

test('a review from a bot is kept', () => {
  const payload = fixture('review-approved')
  payload.review.user = { login: 'review-bot[bot]', type: 'Bot' }
  assert.equal(parseWebhook('pull_request_review', payload)?.kind, 'review')
})

test('review that is not submitted is ignored', () => {
  const payload = fixture('review-approved')
  payload.action = 'dismissed'
  assert.equal(parseWebhook('pull_request_review', payload), undefined)
})

test('comment on a PR', () => {
  assert.deepEqual(parseWebhook('issue_comment', fixture('comment-on-pr')), {
    kind: 'comment', pr, id: 201, author: 'commenter-login', body: 'Can you add a test?',
    url: 'https://github.com/Owner/Repo/pull/12#issuecomment-201',
  })
})

test('comment on an issue, by a bot, or edited is ignored', () => {
  assert.equal(parseWebhook('issue_comment', fixture('comment-on-issue')), undefined)
  assert.equal(parseWebhook('issue_comment', fixture('comment-by-bot')), undefined)
  const edited = fixture('comment-on-pr')
  edited.action = 'edited'
  assert.equal(parseWebhook('issue_comment', edited), undefined)
})

test('merged and closed', () => {
  assert.deepEqual(parseWebhook('pull_request', fixture('pr-merged')), { kind: 'closed', pr, merged: true, by: 'merger-login' })
  assert.deepEqual(parseWebhook('pull_request', fixture('pr-closed')), { kind: 'closed', pr, merged: false, by: 'closer-login' })
  assert.equal(parseWebhook('pull_request', fixture('pr-opened')), undefined)
})

test('check_suite completed is a CI trigger', () => {
  assert.deepEqual(parseWebhook('check_suite', fixture('check-suite-completed')), { kind: 'ci-trigger', repo: 'owner/repo', headSha: '1a2b3c4d5e6f' })
  assert.equal(parseWebhook('check_suite', fixture('check-suite-requested')), undefined)
})

test('status is a CI trigger', () => {
  assert.deepEqual(parseWebhook('status', fixture('status')), { kind: 'ci-trigger', repo: 'owner/repo', headSha: '1a2b3c4d5e6f' })
})

test('wrong shapes and other events return undefined', () => {
  for (const [name, payload] of [
    ['push', fixture('status')],
    ['pull_request_review', null],
    ['pull_request_review', 'text'],
    ['pull_request_review', { action: 'submitted', review: { id: 'x' } }],
    ['issue_comment', { action: 'created', issue: { pull_request: {} } }],
    ['pull_request', { action: 'closed' }],
    ['check_suite', { action: 'completed' }],
    ['status', {}],
  ] as const) assert.equal(parseWebhook(name, payload), undefined, `${name} ${JSON.stringify(payload)}`)
})
