// Readers for reports.md (the manager), memory.md (the manager),
// bot/from-user.jsonl (kantoku bot) and bot/handled.txt (the manager).
// bot/secret-requests.jsonl (the manager) is read in secret.ts.
import { createHash } from 'node:crypto'
import { sectionsOf, stripComments } from './sections.ts'
import type { Choice, Entry, TalkItem } from './types.ts'

export type Report = Extract<TalkItem, { kind: 'report' }> | Extract<TalkItem, { kind: 'ask' }>
export type MemoryEntry = { id: string; fact: string; date?: string; line: number }

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const HEADING = /^(\d{4})-(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})(?:[ \t]+ask[ \t]+(\S+))?/i
const RECOMMENDED = /[ \t]*[((](recommended|おすすめ)[))][ \t]*$/i
const ANSWER_LINE = /^(答え|answer)[ \t]*[:：][ \t]*(.+)$/i

export function parseReports(text: string): Report[] {
  return sectionsOf(stripComments(text)).map(section => {
    const head = HEADING.exec(section.heading)
    // A `# title` line ends the entry (an entry may be written above the file's title).
    const all = section.body.split(/\r?\n/).map(line => line.trimEnd())
    const title = all.findIndex(line => /^#[ \t]/.test(line))
    const lines = title < 0 ? all : all.slice(0, title)
    if (!head) return { kind: 'report', at: '', text: [section.heading, ...lines].join('\n').trim() }
    const [, y, mo, d, h, mi, askId] = head
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).toISOString()
    if (askId === undefined) return { kind: 'report', at, text: lines.join('\n').trim() }

    return askOf(at, askId, lines)
  })
}

// An ask: the question, then its choices as the trailing bullets, then an
// optional `答え: …` / `Answer: …` line the manager adds once answered in chat.
function askOf(at: string, id: string, raw: string[]): Report {
  const lines = raw.filter(line => line.trim() !== '')
  let answer: string | undefined
  const last = lines[lines.length - 1]
  const answered = last === undefined ? null : ANSWER_LINE.exec(last.trim())
  if (answered) {
    answer = (answered[2] ?? '').trim()
    lines.pop()
  }
  const choices: Choice[] = []
  while (lines.length > 0 && /^[-*][ \t]+/.test(lines[lines.length - 1] ?? '')) {
    const label = (lines.pop() ?? '').replace(/^[-*][ \t]+/, '')
    choices.unshift({ label: label.replace(RECOMMENDED, '').trim(), recommended: RECOMMENDED.test(label) })
  }
  const ask: Report = { kind: 'ask', at, id, text: lines.join('\n').trim(), choices }
  if (answer !== undefined) ask.answer = answer

  return ask
}

const DATE_SUFFIX = /[ \t]*[((](\d{4}-\d{2}-\d{2})[))][ \t]*$/

export function parseMemory(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  stripComments(text)
    .split(/\n/)
    .forEach((raw, line) => {
      const trimmed = raw.trim()
      if (!/^[-*][ \t]+/.test(trimmed)) return
      const item = trimmed.replace(/^[-*][ \t]+/, '')
      const date = DATE_SUFFIX.exec(item)?.[1]
      const fact = item.replace(DATE_SUFFIX, '').trim()
      if (fact === '') return
      const entry: MemoryEntry = { id: memoryIdOf(trimmed), fact, line }
      if (date !== undefined) entry.date = date
      entries.push(entry)
    })

  return entries
}

export function memoryIdOf(line: string): string {
  return hashOf(line.trim()).slice(0, 8)
}

const TYPES = new Set(['say', 'answer', 'edited', 'delivered', 'secret-done', 'secret-expired'])

export function parseLog(text: string): Entry[] {
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.type !== 'string' || !TYPES.has(raw.type)) continue
    const entry: Entry = { id: raw.id, at: typeof raw.at === 'string' ? raw.at : '', type: raw.type as Entry['type'] }
    if (typeof raw.text === 'string') entry.text = raw.text
    if (typeof raw.ask === 'string') entry.ask = raw.ask
    if (typeof raw.what === 'string') entry.what = raw.what
    if (raw.delivery === 'sent' || raw.delivery === 'queued') entry.delivery = raw.delivery
    if (typeof raw.request === 'string') entry.request = raw.request
    if (raw.exit === null || (typeof raw.exit === 'number' && Number.isInteger(raw.exit))) entry.exit = raw.exit
    entries.push(entry)
  }

  return entries
}

export function parseHandled(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== ''),
  )
}
