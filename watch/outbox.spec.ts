import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIVE_UP_ATTEMPTS, GIVE_UP_MS, openOutbox, retryWaitMs } from './outbox.ts'
import type { LogLine } from './outbox.ts'
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
async function failUntil(outbox: Awaited<ReturnType<typeof open>>['outbox'], from: number, to: number, log: LogLine) {
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

test('a letter that fails for a day and enough tries is dropped: the manager is told first, then the DROPPED line, and it stays dropped', async () => {
  const { outbox, seen } = await open()
  await outbox.put([child], t0)
  const lines: string[] = []
  const log = async (line: string) => void lines.push(line)
  await failUntil(outbox, 0, (GIVE_UP_ATTEMPTS - 2) * 6 * MIN, log)
  assert.deepEqual(outbox.keys(), [child.key], 'enough tries, but not a day yet')
  await failUntil(outbox, GIVE_UP_MS, GIVE_UP_MS, log)
  assert.deepEqual(outbox.keys(), [`dropped:${child.key}`], 'the letter became a drop entry in the same write')
  assert.ok(lines.some(line => line.startsWith(`GIVING UP ${child.key} `)), lines.join(' | '))
  assert.ok(!lines.some(line => line.startsWith('DROPPED')), 'the line to the manager has not gone out yet')

  await outbox.put([child], later(GIVE_UP_MS + MIN))
  assert.deepEqual(outbox.keys(), [`dropped:${child.key}`], 'a later catch-up of the same fact does not bring it back')

  const sent: Letter[] = []
  await outbox.flush(async l => (sent.push(l), true), later(GIVE_UP_MS + 10 * MIN), log)
  assert.equal(sent[0]?.to, 'run:run_1')
  assert.match(sent[0]?.subject ?? '', /gave up/)
  assert.ok(lines.some(line => line.startsWith(`DROPPED ${child.key} `) && line.endsWith('the manager was told')))
  assert.deepEqual(outbox.keys(), [])
  assert.equal(seen.has(child.key), true)
  await outbox.put([child], later(GIVE_UP_MS + 11 * MIN))
  assert.deepEqual(outbox.keys(), [], 'once done, the fact is not put back')
})

test('a dropped line to the manager itself gets no notice to the same place; drops never loop', async () => {
  const { outbox } = await open()
  await outbox.put([manager], t0)
  const lines: string[] = []
  await failUntil(outbox, 0, GIVE_UP_MS, async l => void lines.push(l))
  assert.deepEqual(outbox.keys(), [])
  assert.ok(lines.some(line => line.startsWith(`DROPPED ${manager.key} `) && line.endsWith('; no manager to tell')))
})

// Verifier run 4 (b19444f): a crash in the middle of a drop, or a failed log write, lost the manager's line and the DROPPED line.
test('a crash right after seen.json is written in the round that drops still tells the manager after a restart', async () => {
  const home = dir()
  const first = await open(home)
  await first.outbox.put([child], t0)
  await failUntil(first.outbox, 0, (GIVE_UP_ATTEMPTS - 2) * 6 * MIN, quiet)
  const realSave = first.seen.save
  first.seen.save = async () => {
    await realSave()
    throw new Error('crash after seen.json, before outbox.json')
  }
  await first.outbox.flush(async () => false, later(GIVE_UP_MS), quiet).catch(() => {})

  const again = await open(home)
  const sent: Letter[] = []
  const lines: string[] = []
  await again.outbox.flush(async l => (sent.push(l), true), later(GIVE_UP_MS + 10 * MIN), async l => void lines.push(l))
  assert.deepEqual(sent.map(l => l.key), [`dropped:${child.key}`])
  assert.ok(lines.some(line => line.startsWith(`DROPPED ${child.key} `)), lines.join(' | '))
  assert.deepEqual(again.outbox.keys(), [])
})

test('a DROPPED line that cannot be written keeps the drop open, even across a restart', async () => {
  const home = dir()
  const first = await open(home)
  await first.outbox.put([child], t0)
  await failUntil(first.outbox, 0, (GIVE_UP_ATTEMPTS - 1) * 6 * MIN, quiet)
  const sent: Letter[] = []
  for (const broken of [async () => false, async () => Promise.reject(new Error('EIO'))])
    await first.outbox.flush(async l => l.key.startsWith('dropped:') && (sent.push(l), true), later(GIVE_UP_MS + sent.length * 10 * MIN), broken)
  assert.deepEqual(sent.map(l => l.key), [`dropped:${child.key}`], 'the manager is told once')
  assert.deepEqual(first.outbox.keys(), [`dropped:${child.key}`])
  assert.equal(first.seen.has(child.key), false)
  await first.seen.save()

  const again = await open(home)
  const lines: string[] = []
  await again.outbox.flush(async l => (sent.push(l), true), later(GIVE_UP_MS + 30 * MIN), async l => void lines.push(l))
  assert.equal(sent.length, 1, 'not told twice')
  assert.ok(lines.some(line => line.startsWith(`DROPPED ${child.key} `) && line.endsWith('the manager was told')), lines.join(' | '))
  assert.deepEqual(again.outbox.keys(), [])
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

test('a drop waiting only for its log line does not count as unsent, so it does not keep the daemon up', async () => {
  const { outbox } = await open()
  await outbox.put([child], t0)
  await failUntil(outbox, 0, (GIVE_UP_ATTEMPTS - 1) * 6 * MIN, quiet)
  assert.equal(outbox.unsent(), 1)
  await outbox.flush(async l => l.key.startsWith('dropped:'), later(GIVE_UP_MS), async () => false)
  assert.deepEqual(outbox.keys(), [`dropped:${child.key}`], 'kept until the log line is written')
  assert.equal(outbox.unsent(), 0, 'nothing is left to send')
})

test('when the manager line gives up too, each DROPPED line is written once even if a write fails between them', async () => {
  const { outbox } = await open()
  await outbox.put([child], t0)
  await failUntil(outbox, 0, GIVE_UP_MS, quiet)
  assert.deepEqual(outbox.keys(), [`dropped:${child.key}`])
  const lines: string[] = []
  let writes = 0
  // The first DROPPED line is written, the second write fails; the next round writes only the second.
  const flaky = async (line: string) => line.startsWith('DROPPED') && writes++ === 1 ? false : void lines.push(line)
  await failUntil(outbox, 2 * GIVE_UP_MS, 2 * GIVE_UP_MS + 60 * MIN, flaky)
  assert.deepEqual(outbox.keys(), [])
  assert.equal(lines.filter(l => l.startsWith(`DROPPED ${child.key} `)).length, 1, lines.join(' | '))
  assert.equal(lines.filter(l => l.startsWith(`DROPPED dropped:${child.key} `)).length, 1, lines.join(' | '))
})
