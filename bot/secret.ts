// The secret input card. A manager asks for a secret by naming a recipe and its
// fields in <home>/bot/secret-requests.jsonl; it never writes a command. The
// command comes only from RECIPES. The user sees the whole command on the card,
// pastes the value, and presses Register. The value then goes to the command's
// stdin and nowhere else: not the argv, the env, a file, a log, or a reply.
import { spawn as nodeSpawn } from 'node:child_process'
import { redact } from './redact.ts'
import type { Entry, TalkItem } from './types.ts'

export type Command = { file: string; args: string[] }
export type Recipe = { file: string; fields: Record<string, RegExp>; args: (fields: Record<string, string>) => string[] }

// Every field starts with a letter or digit, so no value can read as a flag.
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const ENV = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
const VISIBILITY = /^(all|private|selected)$/

// The allowlist. A new recipe is a pull request to kantoku.
export const RECIPES: Record<string, Recipe> = {
  'gh-secret-repo': { file: 'gh', fields: { name: SECRET_NAME, repo: REPO }, args: f => ['secret', 'set', f.name!, '--repo', f.repo!] },
  'gh-secret-org': {
    file: 'gh',
    fields: { name: SECRET_NAME, org: ORG, visibility: VISIBILITY },
    args: f => ['secret', 'set', f.name!, '--org', f.org!, '--visibility', f.visibility!],
  },
  'gh-secret-env': { file: 'gh', fields: { name: SECRET_NAME, repo: REPO, env: ENV }, args: f => ['secret', 'set', f.name!, '--repo', f.repo!, '--env', f.env!] },
}

export type Built = { ok: true; command: Command } | { ok: false; reason: string }

export function buildCommand(target: unknown, recipes: Record<string, Recipe> = RECIPES): Built {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return { ok: false, reason: 'target must be an object' }
  const { recipe: name, ...given } = target as Record<string, unknown>
  const recipe = typeof name === 'string' && Object.hasOwn(recipes, name) ? recipes[name] : undefined
  if (recipe === undefined) return { ok: false, reason: `no recipe ${JSON.stringify(name)}` }
  const fields: Record<string, string> = {}
  for (const key of Object.keys(given)) if (!Object.hasOwn(recipe.fields, key)) return { ok: false, reason: `unknown field ${key}` }
  for (const [key, pattern] of Object.entries(recipe.fields)) {
    const value = given[key]
    if (typeof value !== 'string' || !pattern.test(value)) return { ok: false, reason: `bad ${key}` }
    fields[key] = value
  }

  return { ok: true, command: { file: recipe.file, args: recipe.args(fields) } }
}

export function commandText(command: Command): string {
  return [command.file, ...command.args].join(' ')
}

// ---------- requests ----------

export type SecretRequest = { id: string; at: string; label: string; description: string; expires: number; command?: Command; reason?: string }

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const DEFAULT_TTL = 30
const MAX_TTL = 120

// One JSON object per line, written by the manager. A line that is not a request
// is skipped; a request whose target fails the table is kept as refused, so the
// card can say why.
export function parseSecretRequests(text: string, recipes: Record<string, Recipe> = RECIPES): SecretRequest[] {
  const read: SecretRequest[] = []
  for (const raw of text.split('\n')) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const r = value as Record<string, unknown>
    const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN
    if (typeof r.id !== 'string' || !REQUEST_ID.test(r.id) || Number.isNaN(at) || typeof r.label !== 'string') continue
    const ttl = typeof r.ttlMinutes === 'number' && Number.isFinite(r.ttlMinutes) ? Math.min(MAX_TTL, Math.max(1, Math.floor(r.ttlMinutes))) : DEFAULT_TTL
    const request: SecretRequest = { id: r.id, at: r.at as string, label: r.label, description: typeof r.description === 'string' ? r.description : '', expires: at + ttl * 60_000 }
    const built = buildCommand(r.target, recipes)
    if (built.ok) request.command = built.command
    else request.reason = built.reason
    read.push(request)
  }
  const seen = new Map<string, number>()
  for (const r of read) seen.set(r.id, (seen.get(r.id) ?? 0) + 1)

  return read
    .filter((r, at) => read.findIndex(other => other.id === r.id) === at)
    .map(r => {
      if ((seen.get(r.id) ?? 0) < 2) return r
      const { command: _dropped, ...rest } = r
      return { ...rest, reason: 'the id was written twice' }
    })
}

// ---------- cards ----------

export type SecretItem = Extract<TalkItem, { kind: 'secret' }>

const MAX_TIME = 8.64e15
const FUTURE_SLACK_MS = 5 * 60_000
const isoOf = (ms: number) => (Math.abs(ms) <= MAX_TIME ? new Date(ms).toISOString() : '')

export function secretItems(requests: SecretRequest[], log: Entry[], now: number): SecretItem[] {
  return requests.map(r => {
    const runs = log.filter(e => e.type === 'secret-done' && e.request === r.id)
    const done = runs.some(e => e.exit === 0)
    const expired = log.some(e => e.type === 'secret-expired' && e.request === r.id) || now >= r.expires
    // A time in the future would keep the card open past its ttl; one out of range cannot be shown.
    const at = Date.parse(r.at)
    const badTime = !(Math.abs(r.expires) <= MAX_TIME) || at > now + FUTURE_SLACK_MS
    const reason = badTime ? 'the time is in the future or out of range' : r.reason
    const state: SecretItem['state'] = r.command === undefined || badTime ? 'refused' : done ? 'done' : expired ? 'expired' : 'open'
    const item: SecretItem = {
      kind: 'secret',
      at: isoOf(at),
      id: r.id,
      label: r.label,
      description: r.description,
      command: r.command === undefined ? '' : commandText(r.command),
      expires: isoOf(r.expires),
      state,
    }
    const last = runs.at(-1)
    if (last !== undefined) item.exit = done ? 0 : (last.exit ?? null)
    if (reason !== undefined) item.reason = reason

    return item
  })
}

// ---------- running ----------

// The part of a ChildProcess runSecret uses, so a test can see every call.
export type Spawned = {
  stdin: { on(event: 'error', fn: (error: Error) => void): unknown; end(chunk: string): unknown }
  stderr: { on(event: 'data', fn: (chunk: Buffer) => void): unknown }
  on(event: 'error', fn: (error: Error) => void): unknown
  on(event: 'close', fn: (code: number | null) => void): unknown
  kill(): unknown
}
export type Spawn = (file: string, args: string[], opts: { shell: false; windowsHide: true; stdio: ['pipe', 'ignore', 'pipe'] }) => Spawned

export const RUN_TIMEOUT_MS = 60_000
const MAX_STDERR = 4096
const MAX_NOTE = 200

export type RunResult = { exit: number | null; note?: string }

// No env option: the child inherits this process's env unchanged.
export function runSecret(command: Command, value: string, opts: { spawn?: Spawn; timeoutMs?: number } = {}): Promise<RunResult> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn)
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS

  return new Promise(resolve => {
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: Spawned
    try {
      child = spawn(command.file, command.args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    } catch {
      return finish({ exit: null, note: `could not start ${command.file}` })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('error', () => finish({ exit: null, note: `could not start ${command.file}` }))
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8')
    })
    child.on('close', code => {
      if (timedOut) return finish({ exit: null, note: `stopped after ${timeoutMs / 1000} s` })
      const note = firstLine(stderr, value)
      finish(code === 0 || note === undefined ? { exit: code } : { exit: code, note })
    })
    // A child that exits before reading stdin closes the pipe; that is its exit code's business.
    child.stdin.on('error', () => undefined)
    child.stdin.end(value)
  })
}

// The first non-empty stderr line for the user's card, unless it holds any piece
// of the value: any 4 characters in a row of a value line (or a whole shorter line).
function firstLine(stderr: string, value: string): string | undefined {
  const line = stderr
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l !== '')
  if (line === undefined || holdsPiece(line, value)) return undefined

  return redact([...line].slice(0, MAX_NOTE).join(''))
}

const PIECE = 4

function holdsPiece(line: string, value: string): boolean {
  for (const part of value.split(/\r?\n/).map(p => p.trim())) {
    if (part === '') continue
    if (part.length <= PIECE) {
      if (line.includes(part)) return true
      continue
    }
    for (let at = 0; at + PIECE <= part.length; at++) if (line.includes(part.slice(at, at + PIECE))) return true
  }

  return false
}
