import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendLetters } from './notify.ts'
import { openSeen } from './seen.ts'
import { fakeRun } from './testing.ts'
import type { Letter } from './route.ts'

const seenFile = () => join(mkdtempSync(join(tmpdir(), 'kw-notify-')), 'seen.json')
const child: Letter = { to: 'dispatch:ctx_1', subject: 'kantoku-watch: o/r#1 approved by x', body: 'line 1\n> quoted "text"', key: 'review:o/r#1:5>child:ctx_1' }
const manager: Letter = { to: 'run:run_1', subject: 'kantoku-watch: o/r#1 (T → ctx_1) approved by x', body: '', key: 'review:o/r#1:5>run:run_1' }

test('sends each letter with orca and skips seen keys', async () => {
  const run = fakeRun(() => ({}))
  const seen = await openSeen(seenFile())
  const now = new Date()
  assert.deepEqual(await sendLetters(run, [child, manager], seen, now), { sent: 2, failed: 0 })
  assert.deepEqual(run.calls, [
    ['orca', 'orchestration', 'send', '--to', 'dispatch:ctx_1', '--type', 'status', '--subject', child.subject, '--body', child.body],
    ['orca', 'orchestration', 'send', '--to', 'run:run_1', '--type', 'status', '--subject', manager.subject],
  ])
  assert.equal(seen.has(child.key) && seen.has(manager.key), true)
  assert.deepEqual(await sendLetters(run, [child, manager], seen, now), { sent: 0, failed: 0 })
  assert.equal(run.calls.length, 2)
})

test('a failed child send is retried; the manager line is kept as sent', async () => {
  let childFails = true
  const run = fakeRun((_cmd, args) => (args.includes('dispatch:ctx_1') && childFails ? { code: 1, stderr: 'no such dispatch' } : {}))
  const seen = await openSeen(seenFile())
  assert.deepEqual(await sendLetters(run, [child, manager], seen, new Date()), { sent: 1, failed: 1 })
  assert.equal(seen.has(child.key), false)
  assert.equal(seen.has(manager.key), true)
  childFails = false
  assert.deepEqual(await sendLetters(run, [child, manager], seen, new Date()), { sent: 1, failed: 0 })
  assert.deepEqual(run.calls.slice(2).map(call => call[4]), ['dispatch:ctx_1'])
})

test('a send that throws counts as failed', async () => {
  const run = async () => {
    throw new Error('spawn orca ENOENT')
  }
  const seen = await openSeen(seenFile())
  assert.deepEqual(await sendLetters(run, [child], seen, new Date()), { sent: 0, failed: 1 })
})

test('sends with --from the given sender', async () => {
  const run = fakeRun(() => ({}))
  await sendLetters(run, [child], await openSeen(seenFile()), new Date(), 'term_start')
  assert.deepEqual(run.calls[0]?.slice(0, 5), ['orca', 'orchestration', 'send', '--from', 'term_start'])
})

test('a refused send is tried again from the fallback sender', async () => {
  const run = fakeRun((_cmd, args) => (args[3] === 'term_start' ? { code: 1, stderr: 'error: dispatch_run_mismatch: ...' } : {}))
  const seen = await openSeen(seenFile())
  assert.deepEqual(await sendLetters(run, [{ ...manager, fallbackFrom: 'term_mgr' }], seen, new Date(), 'term_start'), { sent: 1, failed: 0 })
  assert.deepEqual(run.calls.map(c => c[4]), ['term_start', 'term_mgr'])
  assert.equal(seen.has(manager.key), true)
})

test('with no sender at all, the fallback sender is used first', async () => {
  const run = fakeRun(() => ({}))
  await sendLetters(run, [{ ...manager, fallbackFrom: 'term_mgr' }], await openSeen(seenFile()), new Date())
  assert.deepEqual(run.calls.map(c => c.slice(3, 5)), [['--from', 'term_mgr']])
})
