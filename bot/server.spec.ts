import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLog } from './notes.ts'
import { startBotServer } from './server.ts'
import type { BotServerOptions } from './server.ts'
import { makeHome } from './testing.ts'
import { call, makePageDir, portOf } from './http.testing.ts'

const TOKEN = 'a'.repeat(64)
const servers: Server[] = []
after(() => servers.forEach(s => s.close()))

async function app(opts: Partial<BotServerOptions> = {}): Promise<Server> {
  const server = await startBotServer({ root: makeHome(), port: 0, pageDir: makePageDir(), token: TOKEN, ...opts })
  servers.push(server)
  return server
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

test('GET /api/bots gives kantoku bot', async () => {
  const res = await call(await app(), '/api/bots')
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /^application\/json/)
  assert.equal(JSON.parse(res.body).bots.length, 4)
})

test('GET / puts the token in the page', async () => {
  const res = await call(await app(), '/')
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /^text\/html/)
  assert.match(res.body, new RegExp(`<meta name="bot-token" content="${TOKEN}">`))
})

test('the three page files', async () => {
  const server = await app()
  for (const [path, type] of [
    ['/bot.js', /^text\/javascript/],
    ['/links.js', /^text\/javascript/],
    ['/bot.css', /^text\/css/],
  ] as const) {
    const res = await call(server, path)
    assert.equal(res.status, 200, path)
    assert.match(String(res.headers['content-type']), type, path)
  }
})

test('nothing else is served', async () => {
  const server = await app()
  for (const path of ['/../profile.md', '/Mochi/state.md', '/%2e%2e/Mochi/state.md', '/index.html/..', '/api/bots/x', '/favicon.ico'])
    assert.equal((await call(server, path)).status, 404, path)
})

test('a foreign Host is refused', async () => {
  const server = await app()
  const port = portOf(server)
  assert.equal((await call(server, '/api/bots', { headers: { host: `evil.example:${port}` } })).status, 403)
  assert.equal((await call(server, '/api/bots', { headers: { host: '127.0.0.1:1' } })).status, 403)
  assert.equal((await call(server, '/api/bots', { headers: { host: `localhost:${port}` } })).status, 200)
  assert.equal((await call(server, '/api/bots', { headers: { host: `127.0.0.1:${port}` } })).status, 200)
})

test('every response carries the safety headers and no CORS', async () => {
  const server = await app()
  for (const path of ['/', '/api/bots', '/nope']) {
    const res = await call(server, path)
    assert.equal(res.headers['content-security-policy'], CSP, path)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path)
    assert.equal(res.headers['cache-control'], 'no-store', path)
    assert.equal(res.headers['referrer-policy'], 'no-referrer', path)
    assert.equal(res.headers['access-control-allow-origin'], undefined, path)
  }
})

test('listens on loopback only', async () => {
  const server = await app()
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  assert.equal(address.address, '127.0.0.1')
})

test('other methods on read routes are refused', async () => {
  assert.equal((await call(await app(), '/api/bots', { method: 'DELETE' })).status, 405)
})

// ---------- writes ----------

type Rung = { run: string | undefined; terminal: string | undefined; id: string }

async function writeServer(answer = true) {
  const root = makeHome()
  const rung: Rung[] = []
  const server = await app({
    root,
    ring: async (run, terminal, id) => {
      rung.push({ run, terminal, id })
      return answer && run !== undefined
    },
  })
  return { root, server, rung }
}

function good(server: Server): Record<string, string> {
  return { 'content-type': 'application/json', 'x-bot-token': TOKEN, origin: `http://127.0.0.1:${portOf(server)}` }
}

function postJson(server: Server, path: string, body: unknown, headers: Record<string, string> = good(server)) {
  return call(server, path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

const logOf = (root: string, bot: string) => {
  try {
    return readFileSync(join(root, bot, 'bot', 'from-user.jsonl'), 'utf8')
  } catch {
    return ''
  }
}

// Every way a write can come from somewhere other than kantoku bot page → 403, nothing written.
async function assertGuarded(path: string, body: unknown) {
  const { root, server, rung } = await writeServer()
  const before = logOf(root, 'Mochi')
  const port = portOf(server)
  const cases: [string, Record<string, string>][] = [
    ['no token', { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }],
    ['wrong token', { ...good(server), 'x-bot-token': 'b'.repeat(64) }],
    ['short token', { ...good(server), 'x-bot-token': 'a' }],
    ['foreign origin', { ...good(server), origin: 'https://evil.example' }],
    ['origin on another port', { ...good(server), origin: 'http://127.0.0.1:1' }],
    ['no origin', { 'content-type': 'application/json', 'x-bot-token': TOKEN }],
    ['null origin', { ...good(server), origin: 'null' }],
    ['text/plain', { ...good(server), 'content-type': 'text/plain' }],
    ['form post', { ...good(server), 'content-type': 'application/x-www-form-urlencoded' }],
  ]
  for (const [name, headers] of cases) assert.equal((await postJson(server, path, body, headers)).status, 403, name)
  assert.equal(logOf(root, 'Mochi'), before)
  assert.equal(rung.length, 0)
  assert.equal((await postJson(server, path, body, { ...good(server), origin: `http://localhost:${port}` })).status === 403, false, 'localhost origin is allowed')
}

test('POST /api/say writes the words and rings Mochi', async () => {
  const { root, server, rung } = await writeServer()
  const res = await postJson(server, '/api/say', { bot: 'Mochi', text: '並び替えは新しい順で' })
  assert.equal(res.status, 200)
  const reply = JSON.parse(res.body)
  assert.match(reply.id, /^d-\d{8}-\d{6}-[0-9a-f]{4}$/)
  assert.equal(reply.delivery, 'sent')
  assert.deepEqual(rung, [{ run: 'run_fixturemochi', terminal: 'term_fixture-mochi', id: reply.id }])
  const said = parseLog(logOf(root, 'Mochi')).filter(e => e.id === reply.id)
  assert.deepEqual(
    said.map(e => [e.type, e.text, e.delivery]),
    [
      ['say', '並び替えは新しい順で', 'queued'],
      ['delivered', undefined, undefined],
    ],
  )
  const mine = JSON.parse((await call(server, '/api/bots')).body).bots.find((b: { name: string }) => b.name === 'Mochi').talk.at(-1)
  assert.deepEqual([mine.kind, mine.text, mine.delivery], ['mine', '並び替えは新しい順で', 'sent'])
})

test('a manager with no run line gets a queued entry', async () => {
  const { root, server } = await writeServer()
  const res = await postJson(server, '/api/say', { bot: 'Sora', text: 'おはよう' })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).delivery, 'queued')
  assert.deepEqual(parseLog(logOf(root, 'Sora')).map(e => [e.type, e.delivery]), [['say', 'queued']])
})

test('a failed doorbell keeps the entry queued', async () => {
  const { root, server } = await writeServer(false)
  const res = await postJson(server, '/api/say', { bot: 'Mochi', text: 'hi' })
  assert.equal(JSON.parse(res.body).delivery, 'queued')
  assert.equal(parseLog(logOf(root, 'Mochi')).filter(e => e.type === 'delivered').length, 0)
})

test('POST /api/say is guarded', async () => {
  await assertGuarded('/api/say', { bot: 'Mochi', text: 'hi' })
})

test('bad say requests are 400 and write nothing', async () => {
  const { root, server, rung } = await writeServer()
  const before = logOf(root, 'Mochi')
  for (const body of [
    { bot: 'Nobody', text: 'hi' },
    { bot: 'bad name!', text: 'hi' },
    { bot: '../Mochi', text: 'hi' },
    { bot: 'Mochi', text: '   ' },
    { bot: 'Mochi', text: 'x'.repeat(4001) },
    { bot: 'Mochi', text: 5 },
    { bot: 'Mochi' },
    '{not json',
    '[]',
  ]) assert.equal((await postJson(server, '/api/say', body)).status, 400, JSON.stringify(body))
  assert.equal(logOf(root, 'Mochi'), before)
  assert.equal(rung.length, 0)
})

test('a body over 16 KB is 413', async () => {
  const { server } = await writeServer()
  assert.equal((await postJson(server, '/api/say', { bot: 'Mochi', text: 'x'.repeat(17_000) })).status, 413)
})

test('shell-looking text is stored as-is and never reaches the doorbell', async () => {
  const { root, server, rung } = await writeServer()
  const text = '"; rm -rf ~ #'
  const res = await postJson(server, '/api/say', { bot: 'Mochi', text })
  assert.equal(res.status, 200)
  assert.equal(parseLog(logOf(root, 'Mochi')).find(e => e.type === 'say' && e.id === JSON.parse(res.body).id)?.text, text)
  for (const call of rung) for (const value of Object.values(call)) assert.ok(!String(value).includes('rm -rf'))
})

test('GET on a write route is 405', async () => {
  const { server } = await writeServer()
  assert.equal((await call(server, '/api/say')).status, 405)
})

// ---------- answers ----------

const mochiOf = async (server: Server) => JSON.parse((await call(server, '/api/bots')).body).bots.find((b: { name: string }) => b.name === 'Mochi')

function onlyAskWaits(root: string) {
  const state = join(root, 'Mochi', 'state.md')
  writeFileSync(state, readFileSync(state, 'utf8').replace('user: どこで試すか', '-'))
}

test('a choice answers the ask and Mochi stops waiting', async () => {
  const { root, server, rung } = await writeServer()
  onlyAskWaits(root)
  assert.equal((await mochiOf(server)).status, 'waiting')
  const res = await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-0418', choice: '手元で試す' })
  assert.equal(res.status, 200)
  const { id, delivery } = JSON.parse(res.body)
  assert.equal(delivery, 'sent')
  assert.equal(rung[0]?.id, id)
  const entry = parseLog(logOf(root, 'Mochi')).find(e => e.id === id && e.type === 'answer')
  assert.deepEqual([entry?.ask, entry?.text], ['q-0418', '手元で試す'])
  const mochi = await mochiOf(server)
  assert.equal(mochi.talk.find((t: { id?: string }) => t.id === 'q-0418').answer, '手元で試す')
  assert.equal(mochi.status, 'working')
})

test('a free-text answer', async () => {
  const { root, server } = await writeServer()
  const res = await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-0418', text: '明日ステージングで' })
  assert.equal(res.status, 200)
  assert.equal(parseLog(logOf(root, 'Mochi')).find(e => e.type === 'answer' && e.ask === 'q-0418')?.text, '明日ステージングで')
})

test('choice and text together, neither, or an unknown choice → 400', async () => {
  const { root, server, rung } = await writeServer()
  const before = logOf(root, 'Mochi')
  for (const body of [
    { bot: 'Mochi', ask: 'q-0418', choice: '手元で試す', text: 'x' },
    { bot: 'Mochi', ask: 'q-0418' },
    { bot: 'Mochi', ask: 'q-0418', choice: 'どこでも' },
    { bot: 'Mochi', ask: 'q-0418', text: '   ' },
    { bot: 'Mochi', ask: 5, text: 'x' },
    { bot: 'Nobody', ask: 'q-0418', text: 'x' },
  ]) assert.equal((await postJson(server, '/api/answer', body)).status, 400, JSON.stringify(body))
  assert.equal(logOf(root, 'Mochi'), before)
  assert.equal(rung.length, 0)
})

test('an unknown or already answered ask → 409', async () => {
  const { root, server, rung } = await writeServer()
  const before = logOf(root, 'Mochi')
  assert.equal((await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-nope', text: 'x' })).status, 409)
  assert.equal((await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-0417', choice: '人気順' })).status, 409)
  assert.equal(logOf(root, 'Mochi'), before)
  assert.equal(rung.length, 0)
  assert.equal((await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-0418', text: 'first' })).status, 200)
  assert.equal((await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-0418', text: 'second' })).status, 409)
})

test('an ask answered in chat (答え: line) → 409', async () => {
  const { root, server } = await writeServer()
  writeFileSync(join(root, 'Mochi', 'reports.md'), '## 2026-11-18 21:40 ask q-0418\nどこ?\n- A\n答え: A\n')
  assert.equal((await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-0418', text: 'x' })).status, 409)
})

test('a choice whose label the page sees redacted can still be picked, and the real label is logged', async () => {
  const { root, server } = await writeServer()
  const sha = '3f9a'.repeat(16)
  writeFileSync(join(root, 'Mochi', 'reports.md'), `## 2026-11-18 21:40 ask q-1\nどこに戻す?\n- ${sha} に戻す (おすすめ)\n- 戻さない\n`)
  const ask = (await mochiOf(server)).talk.find((t: { id?: string }) => t.id === 'q-1')
  assert.equal(ask.choices[0].label, '[hidden] に戻す')
  const res = await postJson(server, '/api/answer', { bot: 'Mochi', ask: 'q-1', choice: ask.choices[0].label })
  assert.equal(res.status, 200)
  assert.equal(parseLog(logOf(root, 'Mochi')).find(e => e.type === 'answer' && e.ask === 'q-1')?.text, `${sha} に戻す`)
})

test('POST /api/answer is guarded', async () => {
  await assertGuarded('/api/answer', { bot: 'Mochi', ask: 'q-0418', text: 'x' })
})

// ---------- edits ----------

const edited = (root: string) => parseLog(logOf(root, 'Mochi')).filter(e => e.type === 'edited')

test('POST /api/profile saves, backs up, logs and rings', async () => {
  const { root, server, rung } = await writeServer()
  const { version } = await mochiOf(server)
  const res = await postJson(server, '/api/profile', { bot: 'Mochi', version: version.profile, description: '新しい説明です。', wontDo: ['本番に触らない'] })
  assert.equal(res.status, 200)
  const reply = JSON.parse(res.body)
  assert.equal(reply.delivery, 'sent')
  const mochi = await mochiOf(server)
  assert.equal(mochi.description, '新しい説明です。')
  assert.deepEqual(mochi.wontDo, ['本番に触らない'])
  assert.equal(reply.version, mochi.version.profile)
  const profile = readFileSync(join(root, 'Mochi', 'profile.md'), 'utf8')
  assert.match(profile, /\| example-app \| \/work\/example-app \|/)
  assert.equal(readdirSync(join(root, 'Mochi', 'bot', 'backup')).length, 1)
  assert.deepEqual(edited(root).map(e => [e.what, e.id]), [['description', reply.id]])
  assert.equal(rung.at(-1)?.id, reply.id)
})

test('a stale version is 409 and changes nothing', async () => {
  const { root, server, rung } = await writeServer()
  const { version } = await mochiOf(server)
  appendFileSync(join(root, 'Mochi', 'profile.md'), '\n')
  const before = readFileSync(join(root, 'Mochi', 'profile.md'), 'utf8')
  const res = await postJson(server, '/api/profile', { bot: 'Mochi', version: version.profile, description: 'x', wontDo: [] })
  assert.equal(res.status, 409)
  assert.equal(readFileSync(join(root, 'Mochi', 'profile.md'), 'utf8'), before)
  assert.equal(edited(root).length, 0)
  assert.equal(rung.length, 0)
})

test('bad profile input is 400', async () => {
  const { server } = await writeServer()
  const { version } = await mochiOf(server)
  for (const body of [
    { bot: 'Mochi', version: version.profile, description: '# x', wontDo: [] },
    { bot: 'Mochi', version: version.profile, description: 'x', wontDo: 'not a list' },
    { bot: 'Mochi', version: version.profile, description: 'x', wontDo: [1] },
    { bot: 'Mochi', version: version.profile, description: 5, wontDo: [] },
    { bot: 'Mochi', description: 'x', wontDo: [] },
  ]) assert.equal((await postJson(server, '/api/profile', body)).status, 400, JSON.stringify(body))
})

test('forget and fix one memory line', async () => {
  const { root, server, rung } = await writeServer()
  let mochi = await mochiOf(server)
  const [first, second] = mochi.memory
  let res = await postJson(server, '/api/memory/fix', { bot: 'Mochi', version: mochi.version.memory, id: first.id, fact: 'テストは node --test で動く' })
  assert.equal(res.status, 200)
  mochi = await mochiOf(server)
  assert.deepEqual(mochi.memory.map((m: { fact: string }) => m.fact), ['テストは node --test で動く', second.fact])
  res = await postJson(server, '/api/memory/forget', { bot: 'Mochi', version: mochi.version.memory, id: second.id })
  assert.equal(res.status, 200)
  mochi = await mochiOf(server)
  assert.deepEqual(mochi.memory.map((m: { fact: string }) => m.fact), ['テストは node --test で動く'])
  assert.deepEqual(edited(root).map(e => e.what), ['memory', 'memory'])
  assert.match(edited(root)[1]?.text ?? '', /朝に返事/)
  assert.equal(rung.length, 2)
  assert.equal(readdirSync(join(root, 'Mochi', 'bot', 'backup')).length, 2)
})

test('memory: stale version 409, unknown id 400', async () => {
  const { server } = await writeServer()
  const mochi = await mochiOf(server)
  assert.equal((await postJson(server, '/api/memory/forget', { bot: 'Mochi', version: 'x', id: mochi.memory[0].id })).status, 409)
  assert.equal((await postJson(server, '/api/memory/forget', { bot: 'Mochi', version: mochi.version.memory, id: 'ffffffff' })).status, 400)
  assert.equal((await postJson(server, '/api/memory/fix', { bot: 'Mochi', version: mochi.version.memory, id: mochi.memory[0].id, fact: 'a\nb' })).status, 400)
})

test('edit routes are guarded', async () => {
  await assertGuarded('/api/profile', { bot: 'Mochi', version: 'x', description: 'x', wontDo: [] })
  await assertGuarded('/api/memory/forget', { bot: 'Mochi', version: 'x', id: 'x' })
  await assertGuarded('/api/memory/fix', { bot: 'Mochi', version: 'x', id: 'x', fact: 'x' })
})
