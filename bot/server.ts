// kantoku bot's HTTP server. Listens on 127.0.0.1 only, serves the page and the
// manager list JSON, and guards every request with a Host check (DNS rebinding).
import { BACKUP_DIR, LOG_FILE } from './paths.ts'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { orcaRing } from './doorbell.ts'
import type { Ring } from './doorbell.ts'
import { BOT_NAME, botNames, buildBots, readSmall } from './read.ts'
import { parseLog, parseMemory, parseReports } from './notes.ts'
import { parseProfile } from './profile.ts'
import { redact } from './redact.ts'
import { parseState } from './state.ts'
import type { Entry } from './types.ts'
import { ChangedError, InputError, appendEntry, fixMemory, forgetMemory, localIso, newId, safeReplace, setDescription } from './write.ts'

export type BotServerOptions = {
  root: string
  port: number
  pageDir: string
  token: string
  ring?: Ring
  now?: () => Date
}

export const MAX_BODY = 16 * 1024
export const MAX_SAY = 4000

// A request kantoku bot refuses, with the status and a short reason for the page.
export class Refusal extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Body = Record<string, unknown>
type Route = (ctx: { opts: BotServerOptions; body: Body; now: Date }) => Promise<unknown>

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

const PAGE_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/bot.js': { file: 'bot.js', type: 'text/javascript; charset=utf-8' },
  '/links.js': { file: 'links.js', type: 'text/javascript; charset=utf-8' },
  '/bot.css': { file: 'bot.css', type: 'text/css; charset=utf-8' },
}

export const TOKEN_PLACEHOLDER = '__BOT_TOKEN__'

export function createBotServer(opts: BotServerOptions): Server {
  const server = createServer((req, res) => {
    handle(server, opts, req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end()
      if (error instanceof Refusal) return sendJson(res, error.status, { error: error.message })
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof ChangedError) return sendJson(res, 409, { error: 'changed' })
      sendJson(res, 500, { error: 'error' })
    })
  })

  return server
}

export function startBotServer(opts: BotServerOptions): Promise<Server> {
  const server = createBotServer(opts)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

export function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  })
  res.end(body)
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

function portOf(server: Server): number | undefined {
  return (server.address() as AddressInfo | null)?.port
}

function hostAllowed(server: Server, host: string | undefined): boolean {
  const port = portOf(server)

  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function sameToken(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)

  return a.length === b.length && timingSafeEqual(a, b)
}

// A write must come from kantoku bot page itself: its token, its exact origin, and JSON.
function checkWrite(server: Server, opts: BotServerOptions, req: IncomingMessage): void {
  const port = portOf(server)
  const origin = req.headers.origin
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (!sameToken(req.headers['x-bot-token'], opts.token)) throw new Refusal(403, 'forbidden')
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new Refusal(403, 'forbidden')
  if (type !== 'application/json') throw new Refusal(403, 'forbidden')
}

async function readBody(req: IncomingMessage): Promise<Body> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (declared > MAX_BODY) throw new Refusal(413, 'too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new Refusal(413, 'too large')
    chunks.push(chunk)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Refusal(400, 'bad json')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refusal(400, 'bad json')

  return value as Body
}

export async function botHome(opts: BotServerOptions, bot: unknown): Promise<string> {
  if (typeof bot !== 'string' || !BOT_NAME.test(bot) || !(await botNames(opts.root)).includes(bot)) throw new Refusal(400, 'unknown bot')

  return join(opts.root, bot)
}

export function textField(body: Body, key: string, max: number): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Refusal(400, `${key} is empty`)
  if ([...value].length > max) throw new Refusal(400, `${key} is too long`)

  return value
}

// Writes the entry as queued. Callers that check something first do this inside withLock.
async function record(home: string, entry: Omit<Entry, 'delivery'>): Promise<string> {
  await appendEntry(home, { ...entry, delivery: 'queued' })
  return entry.id
}

// Rings outside the lock (it can take up to 5 s) and records `delivered` when it goes through.
export async function ringFor(opts: BotServerOptions, home: string, id: string): Promise<{ id: string; delivery: 'sent' | 'queued' }> {
  const state = parseState(await readSmall(join(home, 'state.md')))
  const ring = opts.ring ?? orcaRing
  if (!(await ring(state.run, state.terminal, id))) return { id, delivery: 'queued' }
  await appendEntry(home, { id, at: localIso((opts.now ?? (() => new Date()))()), type: 'delivered' })

  return { id, delivery: 'sent' }
}

// One write at a time per manager, so a check and its write cannot interleave.
const locks = new Map<string, Promise<unknown>>()

export function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(home) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(home, tail)
  void tail.then(() => {
    if (locks.get(home) === tail) locks.delete(home)
  })

  return run
}

function optionalText(body: Body, key: string): string | undefined {
  return body[key] === undefined ? undefined : textField(body, key, MAX_SAY)
}

// The answer to one open ask: exactly one of a listed choice or free text.
async function answerOf(home: string, body: Body): Promise<{ ask: string; text: string }> {
  const ask = body.ask
  if (typeof ask !== 'string' || ask === '') throw new Refusal(400, 'ask is missing')
  const choice = optionalText(body, 'choice')
  const text = optionalText(body, 'text')
  if ((choice === undefined) === (text === undefined)) throw new Refusal(400, 'give a choice or a text')
  const found = parseReports(await readSmall(join(home, 'reports.md'))).find(r => r.kind === 'ask' && r.id === ask)
  if (found === undefined || found.kind !== 'ask') throw new Refusal(409, 'no such question')
  const answered = parseLog(await readSmall(join(home, LOG_FILE))).some(e => e.type === 'answer' && e.ask === ask)
  if (found.answer !== undefined || answered) throw new Refusal(409, 'already answered')
  // The page only sees redacted labels; log the real one.
  const picked = choice === undefined ? undefined : found.choices.find(c => c.label === choice || redact(c.label) === choice)
  if (choice !== undefined && picked === undefined) throw new Refusal(400, 'unknown choice')

  return { ask, text: picked?.label ?? text ?? '' }
}

function versionOf(body: Body): string {
  if (typeof body.version !== 'string' || body.version === '') throw new Refusal(400, 'version is missing')
  return body.version
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Refusal(400, `${key} must be a list of lines`)
  return value
}

const EDITED_TEXT = {
  ja: {
    description: '説明とやらないことを変えました',
    forgot: (fact: string) => `覚えていたこと「${fact}」を消しました`,
    fixed: (from: string, to: string) => `覚えていたこと「${from}」を「${to}」に直しました`,
  },
  en: {
    description: "Changed the description and the won't-do list",
    forgot: (fact: string) => `Forgot: "${fact}"`,
    fixed: (from: string, to: string) => `Changed memory "${from}" to "${to}"`,
  },
}

// safeReplace on one file, then the `edited` entry and the doorbell.
async function edit(opts: BotServerOptions, home: string, now: Date, file: string, version: string, transform: (text: string) => string, what: string, text: (lang: 'ja' | 'en') => string) {
  const saved = await withLock(home, async () => {
    const lang = parseProfile(await readSmall(join(home, 'profile.md'))).language
    const { version: next } = await safeReplace(join(home, file), version, transform, { backupDir: join(home, BACKUP_DIR), now })
    const id = await record(home, { id: newId(now), at: localIso(now), type: 'edited', what, text: text(lang) })

    return { id, version: next }
  })

  return { ...(await ringFor(opts, home, saved.id)), version: saved.version }
}

const memoryFact = async (home: string, id: unknown) =>
  parseMemory(await readSmall(join(home, 'memory.md'))).find(m => m.id === id)?.fact ?? ''

const ROUTES: Record<string, Route> = {
  '/api/profile': async ({ opts, body, now }) => {
    const home = await botHome(opts, body.bot)
    const version = versionOf(body)
    if (typeof body.description !== 'string') throw new Refusal(400, 'description must be text')
    const description = body.description
    const wontDo = stringList(body.wontDo, 'wontDo')

    return edit(opts, home, now, 'profile.md', version, text => setDescription(text, description, wontDo), 'description', lang => EDITED_TEXT[lang].description)
  },
  '/api/memory/forget': async ({ opts, body, now }) => {
    const home = await botHome(opts, body.bot)
    const version = versionOf(body)
    if (typeof body.id !== 'string') throw new Refusal(400, 'id is missing')
    const id = body.id
    const fact = await memoryFact(home, id)

    return edit(opts, home, now, 'memory.md', version, text => forgetMemory(text, id), 'memory', lang => EDITED_TEXT[lang].forgot(fact))
  },
  '/api/memory/fix': async ({ opts, body, now }) => {
    const home = await botHome(opts, body.bot)
    const version = versionOf(body)
    if (typeof body.id !== 'string') throw new Refusal(400, 'id is missing')
    if (typeof body.fact !== 'string') throw new Refusal(400, 'fact must be text')
    const id = body.id
    const fact = body.fact
    const before = await memoryFact(home, id)

    return edit(opts, home, now, 'memory.md', version, text => fixMemory(text, id, fact), 'memory', lang => EDITED_TEXT[lang].fixed(before, fact.trim()))
  },
  '/api/answer': async ({ opts, body, now }) => {
    const home = await botHome(opts, body.bot)

    const id = await withLock(home, async () => {
      const { ask, text } = await answerOf(home, body)
      return record(home, { id: newId(now), at: localIso(now), type: 'answer', ask, text })
    })

    return ringFor(opts, home, id)
  },
  '/api/say': async ({ opts, body, now }) => {
    const home = await botHome(opts, body.bot)
    const text = textField(body, 'text', MAX_SAY)

    return ringFor(opts, home, await record(home, { id: newId(now), at: localIso(now), type: 'say', text }))
  },
}

async function handle(server: Server, opts: BotServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(server, req.headers.host)) return sendJson(res, 403, { error: 'forbidden' })
  const path = (req.url ?? '/').split('?')[0] ?? '/'
  const page = Object.hasOwn(PAGE_FILES, path) ? PAGE_FILES[path] : undefined
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined
  if (route) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    checkWrite(server, opts, req)
    const body = await readBody(req)
    return sendJson(res, 200, await route({ opts, body, now: (opts.now ?? (() => new Date()))() }))
  }

  if (path === '/api/bots' || page) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
    if (path === '/api/bots') return sendJson(res, 200, await buildBots(opts.root))
    if (page) {
      const text = await readFile(join(opts.pageDir, page.file), 'utf8')
      return send(res, 200, page.type, page.file === 'index.html' ? text.replace(TOKEN_PLACEHOLDER, opts.token) : text)
    }
  }

  return sendJson(res, 404, { error: 'not found' })
}
