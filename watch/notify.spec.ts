import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendLetter } from './notify.ts'
import { fakeRun } from './testing.ts'
import type { Letter } from './route.ts'

const child: Letter = { to: 'dispatch:ctx_1', subject: 'kantoku-watch: o/r#1 approved by x', body: 'line 1\n> quoted "text"', key: 'review:o/r#1:5>child:ctx_1' }
const manager: Letter = { to: 'run:run_1', subject: 'kantoku-watch: o/r#1 (T → ctx_1) approved by x', body: '', key: 'review:o/r#1:5>run:run_1' }

test('sends a letter with orca; an empty body is left out', async () => {
  const run = fakeRun(() => ({}))
  assert.equal(await sendLetter(run, child), true)
  assert.equal(await sendLetter(run, manager), true)
  assert.deepEqual(run.calls, [
    ['orca', 'orchestration', 'send', '--to', 'dispatch:ctx_1', '--type', 'status', '--subject', child.subject, '--body', child.body],
    ['orca', 'orchestration', 'send', '--to', 'run:run_1', '--type', 'status', '--subject', manager.subject],
  ])
})

test('a non-zero exit is a failed send', async () => {
  const run = fakeRun(() => ({ code: 1, stderr: 'no such dispatch' }))
  assert.equal(await sendLetter(run, child), false)
})

test('a send that throws counts as failed', async () => {
  const run = async () => {
    throw new Error('spawn orca ENOENT')
  }
  assert.equal(await sendLetter(run, child), false)
})

test('sends with --from the given sender', async () => {
  const run = fakeRun(() => ({}))
  await sendLetter(run, child, 'term_start')
  assert.deepEqual(run.calls[0]?.slice(0, 5), ['orca', 'orchestration', 'send', '--from', 'term_start'])
})

test('a refused send is tried again from the fallback sender', async () => {
  const run = fakeRun((_cmd, args) => (args[3] === 'term_start' ? { code: 1, stderr: 'error: dispatch_run_mismatch: ...' } : {}))
  assert.equal(await sendLetter(run, { ...manager, fallbackFrom: 'term_mgr' }, 'term_start'), true)
  assert.deepEqual(run.calls.map(c => c[4]), ['term_start', 'term_mgr'])
})

test('with no sender at all, the fallback sender is used first', async () => {
  const run = fakeRun(() => ({}))
  await sendLetter(run, { ...manager, fallbackFrom: 'term_mgr' })
  assert.deepEqual(run.calls.map(c => c.slice(3, 5)), [['--from', 'term_mgr']])
})
