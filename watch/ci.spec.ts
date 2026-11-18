import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeChecks } from './ci.ts'

const check = (name: string, bucket: string) => ({ name, bucket })

test('all pass', () => {
  assert.deepEqual(summarizeChecks([check('a', 'pass'), check('b', 'pass')]), { state: 'passed', failed: [], passed: 2, skipped: 0 })
})

test('some fail, names sorted', () => {
  assert.deepEqual(summarizeChecks([check('test', 'pass'), check('lint', 'fail'), check('build', 'fail')]), {
    state: 'failed', failed: ['build', 'lint'], passed: 1, skipped: 0,
  })
})

test('any pending is pending', () => {
  assert.equal(summarizeChecks([check('a', 'fail'), check('b', 'pending')]).state, 'pending')
})

test('skipping and cancel are skipped, not failures', () => {
  assert.deepEqual(summarizeChecks([check('a', 'pass'), check('b', 'skipping'), check('c', 'cancel')]), {
    state: 'passed', failed: [], passed: 1, skipped: 2,
  })
})

test('no checks yet is pending', () => {
  assert.equal(summarizeChecks([]).state, 'pending')
})

test('a duplicate failing name is listed once', () => {
  assert.deepEqual(summarizeChecks([check('lint', 'fail'), check('lint', 'fail')]).failed, ['lint'])
})
