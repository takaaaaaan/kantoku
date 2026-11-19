// Regressions for the adversarial review of the secret card: each test is one way
// the card broke its rules before the fix.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSecretRequests, runSecret, secretItems } from './secret.ts'
import type { Recipe } from './secret.ts'
import { expireSecrets, startBotServer } from './server.ts'
import { makeHome } from './testing.ts'
import { call, makePageDir, portOf } from './http.testing.ts'
import { localIso } from './write.ts'

const TOKEN = 'a'.repeat(64)
const servers: Server[] = []
after(() => servers.forEach(s => s.close()))

// node echoes every stdin line to stderr, then exits 1, like a CLI that rejects its input.
const ECHO = { file: process.execPath, args: ['-e', "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stderr.write('error: bad value '+s.split('\\n').join('\\nerror: bad value ')+'\\n');process.exit(1)})"] }

test('a stderr line holding any part of the value is never returned', async () => {
  for (const value of ['DUMMY-LINE-ONE-abcdef\nDUMMY-LINE-TWO-123456', 'DUMMY-pasted-value\n', '  DUMMY-spaced  ']) {
    const result = await runSecret(ECHO, value)
    assert.equal(result.exit, 1)
    assert.equal(result.note, undefined, JSON.stringify(value))
  }
})

test('a stderr line with no part of the value is still shown', async () => {
  const result = await runSecret({ file: process.execPath, args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('HTTP 404: Not Found\\n');process.exit(1)})"] }, 'DUMMY-zzzz')
  assert.deepEqual(result, { exit: 1, note: 'HTTP 404: Not Found' })
})

const AT = Date.parse('2026-11-19T10:00:00+09:00')
const line = (at: string) => JSON.stringify({ id: 's-1', at, label: 'x', target: { recipe: 'gh-secret-repo', name: 'A', repo: 'o/r' } }) + '\n'

test('an extreme or future at is refused, never an endless or broken card', () => {
  for (const at of ['+275760-09-13T00:00:00.000Z', '2098-12-31T17:00:00Z', new Date(AT + 10 * 60_000).toISOString()]) {
    const cards = secretItems(parseSecretRequests(line(at)), [], AT)
    assert.equal(cards.length, 1, at)
    assert.equal(cards[0]?.state, 'refused', at)
  }
  assert.equal(secretItems(parseSecretRequests(line(new Date(AT - 60_000).toISOString())), [], AT)[0]?.state, 'open')
})

// ---------- server ----------

function sleepRecipe(out: string, ms: number): Recipe {
  return { file: process.execPath, fields: {}, args: () => ['-e', `require('fs').appendFileSync(${JSON.stringify(out)},'run\\n');setTimeout(()=>process.exit(3),${ms})`] }
}

async function setup(request: Record<string, unknown>, recipe: Recipe) {
  const root = makeHome()
  mkdirSync(join(root, 'Mochi', 'bot'), { recursive: true })
  writeFileSync(join(root, 'Mochi', 'bot', 'secret-requests.jsonl'), JSON.stringify({ id: 's-1', label: 'x', target: { recipe: 'r' }, ...request }) + '\n')
  const ring = async () => true
  const server = await startBotServer({ root, port: 0, pageDir: makePageDir(), token: TOKEN, recipes: { r: recipe }, ring })
  servers.push(server)
  const post = () =>
    call(server, '/api/secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN, origin: `http://127.0.0.1:${portOf(server)}` },
      body: JSON.stringify({ bot: 'Mochi', request: 's-1', command: commandOf(recipe), value: 'dummy' }),
    })
  return { root, server, post, ring }
}

const commandOf = (recipe: Recipe) => [recipe.file, ...recipe.args({})].join(' ')

test('a Register that waited for the lock past the expiry does not run', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kantoku-attack-')), 'runs.txt')
  // Expires about 1.5 s from now; the first run holds the lock for 3 s.
  const { post } = await setup({ at: localIso(new Date(Date.now() - 58_500)), ttlMinutes: 1 }, sleepRecipe(out, 3000))
  const [a, b] = await Promise.all([post(), post()])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal(readFileSync(out, 'utf8'), 'run\n')
})

test('a done card stays done when from-user.jsonl is over 1 MiB, and expiry is written once', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kantoku-attack-')), 'runs.txt')
  const ok: Recipe = { file: process.execPath, fields: {}, args: () => ['-e', `require('fs').appendFileSync(${JSON.stringify(out)},'run\\n')`] }
  const { root, post, ring } = await setup({ at: localIso(new Date()) }, ok)
  assert.equal((await post()).status, 200)
  const filler = JSON.stringify({ id: 'd-20261119-000000-0000', at: localIso(new Date()), type: 'say', text: 'x'.repeat(1000) }) + '\n'
  appendFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), filler.repeat(1200))
  assert.equal((await post()).status, 409)
  assert.equal(readFileSync(out, 'utf8'), 'run\n')

  appendFileSync(join(root, 'Mochi', 'bot', 'secret-requests.jsonl'), JSON.stringify({ id: 's-2', at: localIso(new Date()), label: 'x', target: { recipe: 'r' }, ttlMinutes: 1 }) + '\n')
  const later = () => new Date(Date.now() + 2 * 60_000)
  const written = [await expireSecrets(root, ring, later, { r: ok }), await expireSecrets(root, ring, later, { r: ok })]
  assert.deepEqual(written, [1, 0])
})

test('one bad request line does not break /api/bots for every manager', async () => {
  const { server } = await setup({ at: '+275760-09-13T00:00:00.000Z' }, sleepRecipe('x', 0))
  assert.equal((await call(server, '/api/bots')).status, 200)
})
