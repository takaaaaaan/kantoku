// POST /api/secret and the secret cards in /api/bots, end to end with a real child process.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseLog } from './notes.ts'
import { buildCommand, commandText } from './secret.ts'
import { expireSecrets, startBotServer } from './server.ts'
import type { Ring } from './doorbell.ts'
import { countRecipe, makeHome } from './testing.ts'
import { call, makePageDir, portOf } from './http.testing.ts'
import { localIso } from './write.ts'

const TOKEN = 'a'.repeat(64)
const DUMMY = 'dummy-ｶﾅ-ü-123456'
const servers: Server[] = []
after(() => servers.forEach(s => s.close()))

type Setup = { root: string; server: Server; rung: string[]; out: string; ring: Ring }

async function setup(requests: Record<string, unknown>[]): Promise<Setup> {
  const root = makeHome()
  const rung: string[] = []
  const out = join(mkdtempSync(join(tmpdir(), 'kantoku-secret-')), 'count.json')
  mkdirSync(join(root, 'Mochi', 'bot'), { recursive: true })
  const lines = requests.map(r => JSON.stringify({ at: localIso(new Date()), label: 'Token', ...r }) + '\n')
  writeFileSync(join(root, 'Mochi', 'bot', 'secret-requests.jsonl'), lines.join(''))
  const ring: Ring = async (_run, _terminal, id) => {
    rung.push(id)
    return true
  }
  const server = await startBotServer({ root, port: 0, pageDir: makePageDir(), token: TOKEN, recipes: { count: countRecipe(out) }, ring })
  servers.push(server)
  return { root, server, rung, out, ring }
}

// A shipped recipe, for tests that never run anything.
const GH = { recipe: 'gh-secret-repo', name: 'DUMMY_TOKEN', repo: 'example/app' }
const target = (exit = '0') => ({ recipe: 'count', exit })

function shown(out: string, exit = '0'): string {
  const built = buildCommand(target(exit), { count: countRecipe(out) })
  assert.ok(built.ok)
  return commandText(built.command)
}

const good = (server: Server) => ({ 'content-type': 'application/json', 'x-bot-token': TOKEN, origin: `http://127.0.0.1:${portOf(server)}` })

const post = (server: Server, body: unknown, headers: Record<string, string> = good(server)) =>
  call(server, '/api/secret', { method: 'POST', headers, body: JSON.stringify(body) })

const logOf = (root: string) => {
  try {
    return readFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), 'utf8')
  } catch {
    return ''
  }
}

const mochi = async (server: Server) => JSON.parse((await call(server, '/api/bots')).body).bots.find((b: { name: string }) => b.name === 'Mochi')
const card = async (server: Server, id: string) => (await mochi(server)).talk.find((t: { kind: string; id: string }) => t.kind === 'secret' && t.id === id)

// No file under the folder holds the value's bytes.
function assertNowhere(folder: string) {
  const needle = Buffer.from(DUMMY, 'utf8')
  for (const file of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const path = join(file.parentPath, file.name)
    assert.equal(readFileSync(path).includes(needle), false, path)
  }
}

const ranNothing = (out: string) => assert.throws(() => readFileSync(out), /ENOENT/)

test('the value reaches the command on stdin only, and only the exit code is logged and returned', async () => {
  const { root, server, rung, out } = await setup([{ id: 's-1', target: target() }])
  const before = await card(server, 's-1')
  assert.deepEqual([before.state, before.command], ['open', shown(out)])

  const res = await post(server, { bot: 'Mochi', request: 's-1', command: shown(out), value: DUMMY })
  assert.equal(res.status, 200)
  const reply = JSON.parse(res.body)
  assert.deepEqual([reply.exit, reply.delivery], [0, 'sent'])
  assert.equal(res.body.includes(DUMMY), false)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { bytes: Buffer.byteLength(DUMMY), argv: ['0'], envHasValue: false })

  const entries = parseLog(logOf(root)).filter(e => e.id === reply.id)
  assert.deepEqual(
    entries.map(e => [e.type, e.request, e.exit]),
    [
      ['secret-done', 's-1', 0],
      ['delivered', undefined, undefined],
    ],
  )
  assert.deepEqual(rung, [reply.id])
  const done = await card(server, 's-1')
  assert.deepEqual([done.state, done.exit], ['done', 0])
  assertNowhere(root)
  assertNowhere(dirname(out))
  assert.equal((await call(server, '/api/bots')).body.includes(DUMMY), false)
})

test('a failed run keeps the card open for another paste', async () => {
  const { server, out } = await setup([{ id: 's-1', target: target('3') }])
  const first = await post(server, { bot: 'Mochi', request: 's-1', command: shown(out, '3'), value: DUMMY })
  assert.equal(JSON.parse(first.body).exit, 3)
  const open = await card(server, 's-1')
  assert.deepEqual([open.state, open.exit], ['open', 3])
  assert.equal((await post(server, { bot: 'Mochi', request: 's-1', command: shown(out, '3'), value: DUMMY })).status, 200)
})

test('no token, a wrong token, another origin or a non-JSON body → 403, and nothing runs', async () => {
  const { root, server, rung, out } = await setup([{ id: 's-1', target: target() }])
  const log = logOf(root)
  const body = { bot: 'Mochi', request: 's-1', command: shown(out), value: DUMMY }
  const port = portOf(server)
  const cases: [string, Record<string, string>][] = [
    ['no token', { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }],
    ['wrong token', { ...good(server), 'x-bot-token': 'b'.repeat(64) }],
    ['foreign origin', { ...good(server), origin: 'https://evil.example' }],
    ['origin on another port', { ...good(server), origin: 'http://127.0.0.1:1' }],
    ['no origin', { 'content-type': 'application/json', 'x-bot-token': TOKEN }],
    ['null origin', { ...good(server), origin: 'null' }],
    ['text/plain', { ...good(server), 'content-type': 'text/plain' }],
  ]
  for (const [name, headers] of cases) {
    const res = await post(server, body, headers)
    assert.equal(res.status, 403, name)
    assert.equal(res.body.includes(DUMMY), false, name)
  }
  assert.equal((await call(server, '/api/secret', { method: 'POST', headers: { ...good(server), host: `evil.example:${port}` }, body: JSON.stringify(body) })).status, 403)
  ranNothing(out)
  assert.equal(logOf(root), log)
  assert.equal(rung.length, 0)
})

test('a request that is unknown, refused, expired, done, or changed since it was shown → 409, and nothing runs', async () => {
  const { root, server, out } = await setup([
    { id: 'open', target: target() },
    { id: 'bad', target: { recipe: 'gh-secret-repo', name: 'A;B', repo: 'o/r' } },
    { id: 'shell', target: { recipe: 'sh', cmd: 'echo hi' } },
    { id: 'done', target: target() },
  ])
  const requests = join(root, 'Mochi', 'bot', 'secret-requests.jsonl')
  appendFileSync(requests, JSON.stringify({ id: 'old', at: localIso(new Date(Date.now() - 31 * 60_000)), label: 'x', target: target() }) + '\n')
  writeFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), JSON.stringify({ id: 'd-20261119-000000-0000', at: localIso(new Date()), type: 'secret-done', request: 'done', exit: 0 }) + '\n')
  for (const [request, command] of [
    ['nope', shown(out)],
    ['bad', 'gh secret set A;B --repo o/r'],
    ['shell', 'sh echo hi'],
    ['old', shown(out)],
    ['done', shown(out)],
    ['open', 'gh secret set OTHER --repo evil/app'],
    ['open', undefined],
  ] as const) assert.equal((await post(server, { bot: 'Mochi', request, command, value: DUMMY })).status, 409, `${request} ${command}`)
  ranNothing(out)
  assertNowhere(root)
})

test('a request id written twice is refused, so its command cannot be swapped after the card is shown', async () => {
  const { root, server, out } = await setup([{ id: 's-1', target: target() }])
  const before = await card(server, 's-1')
  assert.equal(before.state, 'open')
  appendFileSync(join(root, 'Mochi', 'bot', 'secret-requests.jsonl'), JSON.stringify({ id: 's-1', at: localIso(new Date()), label: 'Token', target: target('5') }) + '\n')
  assert.equal((await card(server, 's-1')).state, 'refused')
  assert.equal((await post(server, { bot: 'Mochi', request: 's-1', command: before.command, value: DUMMY })).status, 409)
  ranNothing(out)
})

test('the page cannot choose the command: extra body fields are ignored', async () => {
  const { server, out } = await setup([{ id: 's-1', target: target() }])
  const res = await post(server, {
    bot: 'Mochi',
    request: 's-1',
    command: shown(out),
    value: DUMMY,
    target: target('7'),
    args: ['-e', 'process.exit(9)'],
    file: 'sh',
    recipe: 'gh-secret-repo',
  })
  assert.equal(JSON.parse(res.body).exit, 0)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).argv, ['0'])
})

test('a missing, empty, non-text or too long value → 400, and nothing runs', async () => {
  const { server, out } = await setup([{ id: 's-1', target: target() }])
  for (const value of [undefined, '', 5, ['x'], 'x'.repeat(8193)])
    assert.equal((await post(server, { bot: 'Mochi', request: 's-1', command: shown(out), value })).status, 400, String(value).slice(0, 10))
  ranNothing(out)
})

test('a refusal never echoes the value', async () => {
  const { server } = await setup([{ id: 's-1', target: target() }])
  for (const body of [
    { bot: 'Mochi', request: 'nope', command: 'x', value: DUMMY },
    { bot: 'Nobody', request: 's-1', command: 'x', value: DUMMY },
    { bot: 'Mochi', request: 's-1', command: 'x', value: DUMMY },
  ]) {
    const res = await post(server, body)
    assert.notEqual(res.status, 200)
    assert.equal(res.body.includes(DUMMY), false)
  }
})

test('expireSecrets writes secret-expired once per open request past its time, and rings', async () => {
  const { root, rung, ring } = await setup([
    { id: 's-1', target: GH, ttlMinutes: 1 },
    { id: 's-2', target: GH },
  ])
  const later = () => new Date(Date.now() + 2 * 60_000)
  assert.equal(await expireSecrets(root, ring, later), 1)
  assert.equal(await expireSecrets(root, ring, later), 0)
  const expired = parseLog(logOf(root)).filter(e => e.type === 'secret-expired')
  assert.deepEqual(
    expired.map(e => e.request),
    ['s-1'],
  )
  assert.deepEqual(rung, [expired[0]?.id])
})

test('an open secret card makes the manager wait for the user, and a secret entry is not a chat bubble', async () => {
  const { server, out } = await setup([{ id: 's-1', target: target() }])
  const bubbles = async () => (await mochi(server)).talk.filter((t: { kind: string }) => t.kind === 'mine').length
  assert.equal((await mochi(server)).status, 'waiting')
  const before = await bubbles()
  await post(server, { bot: 'Mochi', request: 's-1', command: shown(out), value: DUMMY })
  assert.equal(await bubbles(), before)
})
