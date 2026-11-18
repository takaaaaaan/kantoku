import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIVE_UP_ATTEMPTS, GIVE_UP_MS, openOutbox, retryWaitMs } from './outbox.ts'
import type { Letter } from './route.ts'
import { openSeen } from './seen.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'kw-outbox-'))
const child: Letter = { to: 'dispatch:ctx_1', subject: 'kantoku-watch: o/r#1 comment by x', body: 'b', key: 'comment:o/r#1:5>child:ctx_1', manager: 'run:run_1' }
const manager: Letter = { to: 'run:run_1', subject: 'kantoku-watch: o/r#1 merged', body: '', key: 'closed:o/r#1:merged>run:run_1' }
const t0 = new Date('2026-11-18T00:00:00Z')
const later = (ms: number) => new Date(t0.getTime() + ms)
const MIN = 60_000
const quiet = async () => {}

async function open(home = dir()) {
  const seen = await openSeen(join(home, 'seen.json'))

  return { home, seen, outbox: await openOutbox(join(home, 'outbox.json'), seen) }
}

// Fails every try, spaced past the longest retry wait, until the given time.
async function failUntil(outbox: Awaited<ReturnType<typeof open>>['outbox'], from: number, to: number, log: (line: string) => Promise<void>) {
  for (let at = from; at <= to; at += 6 * MIN) await outbox.flush(async () => false, later(at), log)
}

test('a letter put in the outbox is on disk before anything is sent', async () => {
  const { home, outbox } = await open()
  await outbox.put([child], t0)
  const onDisk = JSON.parse(readFileSync(join(home, 'outbox.json'), 'utf8'))
  assert.deepEqual(Object.keys(onDisk), [child.key])
  assert.equal(onDisk[child.key].attempts, 0)
})

test('a failed send keeps the letter, across a reopen; a successful one removes it and marks it seen', async () => {
  const { home, outbox, seen } = await open()
  await outbox.put([child, manager], t0)
  await outbox.flush(async l => l.to.startsWith('run:'), t0, quiet)
  assert.deepEqual(outbox.keys(), [child.key])
  assert.equal(seen.has(manager.key), true)
  assert.equal(seen.has(child.key), false)

  const again = await open(home)
  assert.deepEqual(again.outbox.keys(), [child.key])
  await again.outbox.flush(async () => true, later(MIN), quiet)
  assert.deepEqual(again.outbox.keys(), [])
  assert.equal(again.seen.has(child.key), true)
})

test('a failed letter waits before the next try, longer each time, at most 5 minutes', async () => {
  const { outbox } = await open()
  await outbox.put([child], t0)
  let tries = 0
  const fail = async () => (tries++, false)
  await outbox.flush(fail, t0, quiet)
  await outbox.flush(fail, later(10_000), quiet)
  assert.equal(tries, 1, 'too soon after the first failure')
  await outbox.flush(fail, later(30_000), quiet)
  assert.equal(tries, 2)
  assert.deepEqual([1, 2, 3, 5, 9].map(retryWaitMs), [30_000, 60_000, 120_000, 300_000, 300_000])
})

test('a letter already marked sent is not sent again: the duplicate check is just before sending', async () => {
  const { outbox, seen } = await open()
  await outbox.put([child], t0)
  seen.add(child.key, t0)
  let sends = 0
  await outbox.flush(async () => ++sends > 0, t0, quiet)
  assert.equal(sends, 0)
  assert.deepEqual(outbox.keys(), [])
})

test('putting a letter already sent does nothing; putting one already waiting keeps its entry and tries', async () => {
  const { outbox, seen } = await open()
  seen.add(manager.key, t0)
  await outbox.put([manager], t0)
  assert.deepEqual(outbox.keys(), [])
  await outbox.put([child], t0)
  await outbox.flush(async () => false, t0, quiet)
  await outbox.put([child], later(1000))
  assert.deepEqual(outbox.keys(), [child.key])
  assert.equal(outbox.entry(child.key)?.attempts, 1)
  assert.equal(outbox.entry(child.key)?.createdAt, t0.toISOString())
})

test('a letter that fails for a day and enough tries is dropped with a log line, stays dropped, and the manager is told', async () => {
  const { outbox, seen } = await open()
  await outbox.put([child], t0)
  const lines: string[] = []
  const log = async (line: string) => void lines.push(line)
  await failUntil(outbox, 0, (GIVE_UP_ATTEMPTS - 2) * 6 * MIN, log)
  assert.deepEqual(outbox.keys(), [child.key], 'enough tries, but not a day yet')
  await failUntil(outbox, GIVE_UP_MS, GIVE_UP_MS, log)
  assert.ok(lines.some(line => line.startsWith(`DROPPED ${child.key} `)), lines.join('\n'))
  assert.deepEqual(outbox.keys(), [`dropped:${child.key}`])

  await outbox.put([child], later(GIVE_UP_MS + MIN))
  assert.deepEqual(outbox.keys(), [`dropped:${child.key}`], 'a later catch-up of the same fact does not bring it back')
  assert.equal(seen.has(child.key), true)

  const sent: Letter[] = []
  await outbox.flush(async l => (sent.push(l), true), later(GIVE_UP_MS + 2 * MIN), log)
  assert.equal(sent[0]?.to, 'run:run_1')
  assert.match(sent[0]?.subject ?? '', /gave up/)
  assert.deepEqual(outbox.keys(), [])
})

test('a dropped line to the manager itself gets no notice to the same place; drops never loop', async () => {
  const { outbox } = await open()
  await outbox.put([manager], t0)
  const lines: string[] = []
  await failUntil(outbox, 0, GIVE_UP_MS, async l => void lines.push(l))
  assert.deepEqual(outbox.keys(), [])
  assert.ok(lines.some(line => line.startsWith(`DROPPED ${manager.key} `)))
  assert.ok(lines.some(line => line.startsWith('no manager to tell')))
})

test('an outbox file that cannot be read stops the open instead of starting empty', async () => {
  const home = dir()
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home, 'outbox.json'))
  await assert.rejects(open(home))
})

test('a broken outbox file starts empty and is kept aside, not overwritten', async () => {
  const home = dir()
  writeFileSync(join(home, 'outbox.json'), '{not json')
  const { outbox } = await open(home)
  assert.deepEqual(outbox.keys(), [])
  assert.equal(readdirSync(home).filter(name => name.startsWith('outbox.json.broken-')).length, 1)
})
