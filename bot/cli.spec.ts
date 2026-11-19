import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from './cli.ts'

test('defaults', () => {
  assert.deepEqual(parseArgs([]), { port: 4870, root: join(homedir(), '.kantoku') })
})

test('--port and --root', () => {
  assert.deepEqual(parseArgs(['--port', '5000', '--root', 'bot/fixtures/home']), { port: 5000, root: resolve('bot/fixtures/home') })
})

test('bad arguments throw', () => {
  assert.throws(() => parseArgs(['--port', 'x']), /--port needs a number/)
  assert.throws(() => parseArgs(['--port', '70000']), /--port needs a number/)
  assert.throws(() => parseArgs(['--port']), /--port needs a number/)
  assert.throws(() => parseArgs(['--root']), /--root needs a folder/)
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/)
})
