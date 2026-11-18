import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSeen } from './seen.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'kw-seen-'))
const day = 24 * 60 * 60 * 1000

test('add and has', async () => {
  const seen = await openSeen(join(dir(), 'seen.json'))
  assert.equal(seen.has('a'), false)
  seen.add('a', new Date())
  assert.equal(seen.has('a'), true)
})

test('save and reopen keeps keys', async () => {
  const path = join(dir(), 'seen.json')
  const seen = await openSeen(path)
  seen.add('review:o/r#1:5>child:ctx_1', new Date('2026-11-18T00:00:00Z'))
  await seen.save()
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 'review:o/r#1:5>child:ctx_1': '2026-11-18T00:00:00.000Z' })
  assert.equal((await openSeen(path)).has('review:o/r#1:5>child:ctx_1'), true)
})

test('missing or corrupt file opens empty', async () => {
  const path = join(dir(), 'seen.json')
  assert.equal((await openSeen(path)).has('a'), false)
  writeFileSync(path, '{not json')
  const seen = await openSeen(path)
  assert.equal(seen.has('a'), false)
  writeFileSync(path, '["a"]')
  assert.equal((await openSeen(path)).has('0'), false)
})

test('prune drops old keys of PRs no longer watched and old delivery IDs', async () => {
  const seen = await openSeen(join(dir(), 'seen.json'))
  const now = new Date('2026-12-31T00:00:00Z')
  const old = new Date(now.getTime() - 15 * day)
  const fresh = new Date(now.getTime() - 13 * day)
  seen.add('review:o/r#1:1>child:ctx_1', old)   // watched → kept
  seen.add('review:o/r#2:1>child:ctx_1', old)   // gone, old → dropped
  seen.add('review:o/r#3:1>child:ctx_1', fresh) // gone, fresh → kept
  seen.add('delivery:abc', old)                 // delivery, old → dropped
  seen.add('delivery:def', fresh)
  seen.add('trouble:o/r:no-admin:2026-12-01>run:run_1', old)
  seen.prune(new Set(['o/r#1']), now)
  assert.deepEqual(
    ['review:o/r#1:1>child:ctx_1', 'review:o/r#2:1>child:ctx_1', 'review:o/r#3:1>child:ctx_1', 'delivery:abc', 'delivery:def', 'trouble:o/r:no-admin:2026-12-01>run:run_1'].map(k => seen.has(k)),
    [true, false, true, false, true, false],
  )
})
