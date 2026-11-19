// kantoku bot's writes. The log is append-only: one JSON line per appendFile call.
import { BOT_DIR, LOG_FILE } from './paths.ts'
import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { hashOf, parseMemory } from './notes.ts'
import type { MemoryEntry } from './notes.ts'
import { DESCRIPTION_HEADING, WONT_DO_HEADING, parseProfile } from './profile.ts'
import { sectionsOf } from './sections.ts'
import type { Section } from './sections.ts'
import type { Entry } from './types.ts'

export { LOG_FILE }

export async function appendEntry(home: string, entry: Entry): Promise<void> {
  await mkdir(join(home, BOT_DIR), { recursive: true })
  const file = join(home, LOG_FILE)
  // After a crash mid-write the file may end in half a line; start a new one.
  const lead = (await endsInsideLine(file)) ? '\n' : ''
  await appendFile(file, lead + JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' })
}

async function endsInsideLine(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    if (size === 0) return false
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0')

function stamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function newId(now: Date): string {
  return `d-${stamp(now)}-${randomBytes(2).toString('hex')}`
}

// Local time with its offset, e.g. 2026-11-19T21:35:01+09:00.
export function localIso(now: Date): string {
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

  return `${date}T${time}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

// Backup file stamp: <file>.<YYYYMMDD-HHMMSS>.
export function backupStamp(now: Date): string {
  return stamp(now)
}

// ---------- edits to profile.md and memory.md ----------

// Bad input from the page (400). Checked before anything is written.
export class InputError extends Error {}
// The file changed since the page read it (409).
export class ChangedError extends Error {}

export const MAX_DESCRIPTION = 2000
export const MAX_WONT_DO_LINES = 20
export const MAX_WONT_DO_LINE = 200
export const MAX_FACT = 300

// Control characters other than tab and newline go; CR/LF becomes LF.
function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

const HEADING_LINE = /^[ \t]{0,3}#/m

// Checks shared by every edited text: no heading lines (they would break the
// sections), no comment markers (readers strip comments across the file), and
// no `[hidden]` (the page only ever saw the redacted text; saving it would
// overwrite the real value).
function checkLines(text: string): void {
  if (HEADING_LINE.test(text)) throw new InputError('a line may not start with #')
  if (text.includes('<!--') || text.includes('-->')) throw new InputError('<!-- and --> are not allowed')
  if (text.includes('[hidden]')) throw new InputError('[hidden] parts can only be changed in the file itself')
}

function checkDescription(description: string, wontDo: string[]): { description: string; wontDo: string[] } {
  const desc = clean(description).trim()
  if ([...desc].length > MAX_DESCRIPTION) throw new InputError(`description is over ${MAX_DESCRIPTION} characters`)
  checkLines(desc)
  if (wontDo.length > MAX_WONT_DO_LINES) throw new InputError(`at most ${MAX_WONT_DO_LINES} won't-do lines`)
  const rules = wontDo.map(rule => {
    const line = clean(rule).trim()
    if (line.includes('\n')) throw new InputError("one won't-do rule per line")
    if ([...line].length > MAX_WONT_DO_LINE) throw new InputError(`a won't-do line is over ${MAX_WONT_DO_LINE} characters`)
    checkLines(line)
    return line
  })

  return { description: desc, wontDo: rules.filter(rule => rule !== '') }
}

const LEADING_COMMENTS = /^((?:[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n)*)/

function replaceBody(text: string, section: Section, content: string, nl: string): string {
  const bodyStart = section.end - section.body.length
  const comments = LEADING_COMMENTS.exec(section.body)?.[1] ?? ''

  return text.slice(0, bodyStart) + comments + content + nl + text.slice(section.end)
}

function insertAt(text: string, at: number, block: string, nl: string): string {
  const before = text.slice(0, at)
  const lead = before === '' || before.endsWith('\n') ? '' : nl + nl

  return before + lead + block + text.slice(at)
}

const isEdited = (s: Section) => DESCRIPTION_HEADING.test(s.heading) || WONT_DO_HEADING.test(s.heading)
const untouched = (text: string) => JSON.stringify(sectionsOf(text).filter(s => !isEdited(s)).map(s => [s.heading, s.body]))

// Replaces only the bodies of Description and Won't do (creating them after the
// title when missing) and proves every other section stayed byte-identical.
export function setDescription(profile: string, description: string, wontDo: string[]): string {
  const input = checkDescription(description, wontDo)
  const nl = profile.includes('\r\n') ? '\r\n' : '\n'
  const ja = parseProfile(profile).language === 'ja'
  const descText = input.description === '' ? '' : input.description.split('\n').join(nl) + nl
  const wontText = input.wontDo.map(rule => `- ${rule}${nl}`).join('')

  let text = profile
  const desc = sectionsOf(text).find(s => DESCRIPTION_HEADING.test(s.heading))
  if (desc) text = replaceBody(text, desc, descText, nl)
  else text = insertAt(text, sectionsOf(text)[0]?.start ?? text.length, `## ${ja ? '説明' : 'Description'}${nl}${descText}${nl}`, nl)

  const wont = sectionsOf(text).find(s => WONT_DO_HEADING.test(s.heading))
  if (wont) text = replaceBody(text, wont, wontText, nl)
  else {
    const after = sectionsOf(text).find(s => DESCRIPTION_HEADING.test(s.heading))?.end ?? text.length
    text = insertAt(text, after, `## ${ja ? 'やらないこと' : "Won't do"}${nl}${wontText}${nl}`, nl)
  }

  if (untouched(text) !== untouched(profile)) throw new Error('profile check failed: another section would change')

  return text
}

function memoryLine(memory: string, id: string): MemoryEntry {
  const entry = parseMemory(memory).find(m => m.id === id)
  if (entry === undefined) throw new InputError('no such memory line')

  return entry
}

export function forgetMemory(memory: string, id: string): string {
  const entry = memoryLine(memory, id)
  const lines = memory.split('\n')
  const last = entry.line === lines.length - 1
  lines.splice(entry.line, 1)
  const out = lines.join('\n')

  return last && out !== '' ? out + '\n' : out
}

export function fixMemory(memory: string, id: string, fact: string): string {
  const entry = memoryLine(memory, id)
  const text = clean(fact).trim()
  if (text === '') throw new InputError('the fact is empty')
  if (text.includes('\n')) throw new InputError('one line per fact')
  if ([...text].length > MAX_FACT) throw new InputError(`a fact is over ${MAX_FACT} characters`)
  checkLines(text)
  const lines = memory.split('\n')
  const raw = lines[entry.line] ?? ''
  const bullet = /^\s*[-*][ \t]+/.exec(raw)?.[0] ?? '- '
  lines[entry.line] = bullet + text + (entry.date === undefined ? '' : ` (${entry.date})`) + (raw.endsWith('\r') ? '\r' : '')

  return lines.join('\n')
}

// ---------- safe replace ----------

export type FsLike = Pick<typeof fsp, 'readFile' | 'writeFile' | 'rename' | 'unlink' | 'copyFile' | 'readdir' | 'mkdir' | 'access'>

export const KEEP_BACKUPS = 20

// 1 version check, 2 transform (before any write, so bad input leaves no
// trace), 3 backup, 4 temp file + rename over the original.
export async function safeReplace(
  file: string,
  expectedVersion: string,
  transform: (text: string) => string,
  opts: { backupDir: string; now: Date; fs?: FsLike },
): Promise<{ version: string }> {
  const fs = opts.fs ?? fsp
  let text = ''
  let exists = true
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }
  if (hashOf(text) !== expectedVersion) throw new ChangedError('changed')
  const next = transform(text)

  if (exists) await backUp(fs, file, opts.backupDir, opts.now)

  const temp = `${file}.bot-tmp`
  try {
    await fs.writeFile(temp, next, { encoding: 'utf8', flush: true })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined)
    throw error
  }

  return { version: hashOf(next) }
}

async function backUp(fs: FsLike, file: string, backupDir: string, now: Date): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true })
  const name = basename(file)
  const base = join(backupDir, `${name}.${backupStamp(now)}`)
  let target = base
  for (let n = 2; await fs.access(target).then(() => true, () => false); n++) target = `${base}-${n}`
  await fs.copyFile(file, target)
  // Numeric order, so a same-second `-10` sorts after `-2`.
  const mine = (await fs.readdir(backupDir)).filter(f => f.startsWith(`${name}.`)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) await fs.unlink(join(backupDir, old)).catch(() => undefined)
}
