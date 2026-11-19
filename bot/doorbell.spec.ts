import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeOrcaRing, retryQueued } from './doorbell.ts'
import type { Exec, Ring } from './doorbell.ts'
import { parseLog } from './notes.ts'
import { makeHome } from './testing.ts'

function fakeExec(fail = false): Exec & { calls: { file: string; args: string[]; timeout: number }[] } {
  const calls: { file: string; args: string[]; timeout: number }[] = []
  const exec = async (file: string, args: string[], opts: { timeout: number }) => {
    calls.push({ file, args, timeout: opts.timeout })
    if (fail) throw new Error('timed out')
  }
  return Object.assign(exec, { calls })
}

test('orcaRing sends the fixed doorbell with --from', async () => {
  const exec = fakeExec()
  assert.equal(await makeOrcaRing(exec)('run_1', 'term_ab-1', 'd-20261119-213501-7f3a'), true)
  assert.deepEqual(exec.calls, [
    {
      file: 'orca',
      args: ['orchestration', 'send', '--from', 'term_ab-1', '--to', 'run:run_1', '--type', 'status', '--subject', 'kantoku-bot: d-20261119-213501-7f3a'],
      timeout: 5000,
    },
  ])
})

test('without a terminal the --from flag is left out', async () => {
  const exec = fakeExec()
  await makeOrcaRing(exec)('run_1', undefined, 'd-20261119-213501-7f3a')
  assert.deepEqual(exec.calls[0]?.args, ['orchestration', 'send', '--to', 'run:run_1', '--type', 'status', '--subject', 'kantoku-bot: d-20261119-213501-7f3a'])
})

test('a failure or timeout gives false', async () => {
  assert.equal(await makeOrcaRing(fakeExec(true))('run_1', 'term_1', 'd-20261119-213501-7f3a'), false)
})

test('no run, or odd-looking values, give false without calling', async () => {
  const exec = fakeExec()
  const ring = makeOrcaRing(exec)
  assert.equal(await ring(undefined, 'term_1', 'd-20261119-213501-7f3a'), false)
  assert.equal(await ring('run_1 & calc', 'term_1', 'd-20261119-213501-7f3a'), false)
  assert.equal(await ring('run_1', 'term_1"', 'd-20261119-213501-7f3a'), false)
  assert.equal(await ring('run_1', 'term_1', 'd-1; rm'), false)
  assert.equal(exec.calls.length, 0)
})

test('retryQueued rings only queued, unhandled ids and appends delivered', async () => {
  const root = makeHome()
  mkdirSync(join(root, 'Pico', 'bot'))
  const log = join(root, 'Pico', 'bot', 'from-user.jsonl')
  writeFileSync(
    log,
    [
      '{"id":"d-20261119-090000-0001","at":"","type":"say","text":"a","delivery":"queued"}',
      '{"id":"d-20261119-090000-0002","at":"","type":"say","text":"b","delivery":"queued"}',
      '{"id":"d-20261119-090000-0002","at":"","type":"delivered"}',
      '{"id":"d-20261119-090000-0003","at":"","type":"say","text":"c","delivery":"sent"}',
      '{"id":"d-20261119-090000-0004","at":"","type":"answer","ask":"q","text":"d","delivery":"queued"}',
      '{"id":"d-20261119-090000-0005","at":"","type":"say","text":"e","delivery":"queued"}',
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'Pico', 'bot', 'handled.txt'), 'd-20261119-090000-0005\n')
  const rung: string[][] = []
  const ring: Ring = async (run, terminal, id) => {
    rung.push([run ?? '', terminal ?? '', id])
    return true
  }
  assert.equal(await retryQueued(root, ring), 2)
  assert.deepEqual(rung, [
    ['run_fixturepico', 'term_fixture-pico', 'd-20261119-090000-0001'],
    ['run_fixturepico', 'term_fixture-pico', 'd-20261119-090000-0004'],
  ])
  const delivered = parseLog(readFileSync(log, 'utf8')).filter(e => e.type === 'delivered').map(e => e.id)
  assert.deepEqual(delivered, ['d-20261119-090000-0002', 'd-20261119-090000-0001', 'd-20261119-090000-0004'])
  assert.equal(await retryQueued(root, ring), 0)
})

test('retryQueued leaves entries younger than 15 s to the request that wrote them', async () => {
  const root = makeHome()
  mkdirSync(join(root, 'Pico', 'bot'))
  const now = new Date(2026, 10, 19, 9, 0, 30)
  writeFileSync(
    join(root, 'Pico', 'bot', 'from-user.jsonl'),
    [
      '{"id":"d-20261119-090000-0001","at":"2026-11-19T09:00:00","type":"say","text":"old","delivery":"queued"}',
      '{"id":"d-20261119-090025-0002","at":"2026-11-19T09:00:25","type":"say","text":"new","delivery":"queued"}',
      '',
    ].join('\n'),
  )
  const rung: string[] = []
  await retryQueued(root, async (_run, _terminal, id) => (rung.push(id), true), () => now)
  assert.deepEqual(rung, ['d-20261119-090000-0001'])
})

test('retryQueued skips managers without a run and keeps failures queued', async () => {
  const root = makeHome()
  mkdirSync(join(root, 'Sora', 'bot'))
  writeFileSync(join(root, 'Sora', 'bot', 'from-user.jsonl'), '{"id":"d-20261119-090000-0001","at":"","type":"say","text":"a","delivery":"queued"}\n')
  let called = 0
  assert.equal(await retryQueued(root, async () => (called++, false)), 0)
  assert.equal(called, 0)
  const failing: Ring = async () => false
  writeFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), '{"id":"d-20261119-090000-0009","at":"","type":"say","text":"a","delivery":"queued"}\n')
  assert.equal(await retryQueued(root, failing), 0)
  assert.equal(readFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), 'utf8').trim().split('\n').length, 1)
})
