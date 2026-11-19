import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLog } from './notes.ts'
import { appendEntry, localIso, newId } from './write.ts'

const home = () => mkdtempSync(join(tmpdir(), 'kantoku-bot-home-'))
const logOf = (dir: string) => readFileSync(join(dir, 'bot', 'from-user.jsonl'), 'utf8')

test('appendEntry creates bot/ and writes one line per call', async () => {
  const dir = home()
  await appendEntry(dir, { id: 'd-1', at: 'x', type: 'say', text: 'a\nb', delivery: 'queued' })
  await appendEntry(dir, { id: 'd-2', at: 'y', type: 'delivered' })
  const text = logOf(dir)
  assert.ok(text.endsWith('\n'))
  assert.equal(text.split('\n').length, 3)
  assert.deepEqual(
    parseLog(text).map(e => [e.id, e.type, e.text]),
    [
      ['d-1', 'say', 'a\nb'],
      ['d-2', 'delivered', undefined],
    ],
  )
})

test('20 concurrent appends give 20 whole lines', async () => {
  const dir = home()
  const text = 'あ'.repeat(1000)
  await Promise.all(Array.from({ length: 20 }, (_, n) => appendEntry(dir, { id: `d-${n}`, at: '', type: 'say', text, delivery: 'queued' })))
  const lines = logOf(dir).trimEnd().split('\n')
  assert.equal(lines.length, 20)
  assert.equal(parseLog(logOf(dir)).length, 20)
})

test('newId format', () => {
  const id = newId(new Date(2026, 10, 19, 21, 35, 1))
  assert.match(id, /^d-20261119-213501-[0-9a-f]{4}$/)
  assert.notEqual(newId(new Date()), newId(new Date()))
})

test('localIso keeps the local offset', () => {
  const at = localIso(new Date(2026, 10, 19, 21, 35, 1))
  assert.match(at, /^2026-11-19T21:35:01[+-]\d{2}:\d{2}$/)
  assert.equal(Date.parse(at), new Date(2026, 10, 19, 21, 35, 1).getTime())
})

test('a half-written last line does not swallow the next entry', async () => {
  const dir = home()
  await appendEntry(dir, { id: 'd-1', at: '', type: 'say', text: 'a', delivery: 'queued' })
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dir, 'bot', 'from-user.jsonl'), '{"id":"d-cut')
  await appendEntry(dir, { id: 'd-2', at: '', type: 'say', text: 'b', delivery: 'queued' })
  assert.deepEqual(parseLog(logOf(dir)).map(e => e.id), ['d-1', 'd-2'])
})
