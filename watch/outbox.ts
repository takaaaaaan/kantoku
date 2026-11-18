// The outbox: every letter kantoku-watch decides to send is written here, on
// disk, before the first try. A letter leaves the outbox in one place only,
// `settle` below, and only for one of these reasons:
//   sent     — `orca orchestration send` exited 0, or the key is already in
//              seen.json (an earlier send succeeded and a crash came before
//              the outbox was saved);
//   dropped  — it failed for GIVE_UP_MS and at least GIVE_UP_ATTEMPTS tries;
//              then watch.log gets a DROPPED line, the key goes to seen.json
//              so the same fact is not put back, and the manager gets a line.
// Nothing else (a close, a catch-up, a failed gh read, a restart) touches it.
// The file is `{ [key]: Entry }`.

import { copyFile, readFile } from 'node:fs/promises'
import { writeJson } from './files.ts'
import type { Letter } from './route.ts'
import type { Seen } from './seen.ts'

export type Entry = { letter: Letter; createdAt: string; attempts: number; lastTriedAt?: string }

export type Outbox = {
  keys(): string[]
  entry(key: string): Entry | undefined
  put(letters: Letter[], now: Date): Promise<void>
  flush(send: (letter: Letter) => Promise<boolean>, now: Date, log: (line: string) => Promise<void>): Promise<{ sent: number; failed: number }>
}

export const GIVE_UP_MS = 24 * 60 * 60_000
export const GIVE_UP_ATTEMPTS = 10
// After a failure, wait 30 s, then twice as long each time, at most 5 minutes, so an Orca outage does not hold up every round.
const RETRY_FIRST_MS = 30_000
const RETRY_MAX_MS = 5 * 60_000
const DROPPED = 'dropped:'

export function retryWaitMs(attempts: number): number {
  return attempts <= 0 ? 0 : Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS)
}

export async function openOutbox(path: string, seen: Seen): Promise<Outbox> {
  const entries = new Map<string, Entry>()
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // No file: an empty outbox. Any other read error (a lock on Windows) stops the open,
    // because starting empty would overwrite the letters on the next save.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  if (text !== undefined) {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {}
    if (typeof data === 'object' && data !== null && !Array.isArray(data))
      for (const [key, value] of Object.entries(data)) {
        const entry = asEntry(value)
        if (entry !== undefined && entry.letter.key === key) entries.set(key, entry)
      }
    // A file that is not an outbox is kept aside (the open fails if it cannot be), never silently overwritten.
    else await copyFile(path, `${path}.broken-${Date.now()}`)
  }

  const save = () => writeJson(path, Object.fromEntries(entries))
  const add = (letter: Letter, now: Date) => entries.set(letter.key, { letter, createdAt: now.toISOString(), attempts: 0 })

  // The one place a letter leaves the outbox.
  const settle = (key: string) => entries.delete(key)

  return {
    keys: () => [...entries.keys()],
    entry: key => entries.get(key),
    // A letter already sent (or dropped) is not put back; one already waiting keeps its entry and its tries.
    put: async (letters, now) => {
      const fresh = letters.filter(letter => !entries.has(letter.key) && !seen.has(letter.key))
      for (const letter of fresh) add(letter, now)
      if (fresh.length > 0) await save()
    },
    flush: async (send, now, log) => {
      let sent = 0
      let failed = 0
      let changed = false
      for (const [key, entry] of [...entries]) {
        // The duplicate check: the last thing before a send.
        if (seen.has(key)) {
          settle(key)
          changed = true
          await log(`already sent ${key}; removed from the outbox`)
          continue
        }
        if (entry.lastTriedAt !== undefined && now.getTime() - Date.parse(entry.lastTriedAt) < retryWaitMs(entry.attempts)) continue
        changed = true
        if (await send(entry.letter)) {
          seen.add(key, now)
          settle(key)
          sent++
          await log(`sent ${entry.letter.to} ${entry.letter.subject}`)
          continue
        }
        failed++
        entry.attempts++
        entry.lastTriedAt = now.toISOString()
        if (entry.attempts >= GIVE_UP_ATTEMPTS && now.getTime() - Date.parse(entry.createdAt) >= GIVE_UP_MS) {
          seen.add(key, now)
          settle(key)
          await log(`DROPPED ${key} to ${entry.letter.to} after ${entry.attempts} tries since ${entry.createdAt}: ${entry.letter.subject}`)
          const notice = droppedNotice(entry.letter)
          if (notice === undefined) await log(`no manager to tell about the drop of ${key} (it was the manager's own line, or the row names no run)`)
          else if (!entries.has(notice.key) && !seen.has(notice.key)) add(notice, now)
        } else await log(`FAILED ${entry.letter.to} ${entry.letter.subject} (try ${entry.attempts}; kept in the outbox)`)
      }
      if (changed) {
        // seen.json first: a crash between the two writes leaves a sent letter in the outbox, which the check above settles.
        await seen.save()
        await save()
      }

      return { sent, failed }
    },
  }
}

// A line to the manager about a dropped letter. None for a dropped notice (so drops
// never loop) and none when the dropped letter was already addressed to the manager.
function droppedNotice(letter: Letter): Letter | undefined {
  if (letter.key.startsWith(DROPPED) || letter.manager === undefined || letter.manager === letter.to) return undefined
  const notice: Letter = {
    to: letter.manager,
    subject: `kantoku-watch: gave up sending a letter to ${letter.to} after a day of failures (see watch.log): ${letter.subject}`,
    body: '',
    key: `${DROPPED}${letter.key}`,
  }

  return letter.fallbackFrom === undefined ? notice : { ...notice, fallbackFrom: letter.fallbackFrom }
}

function asEntry(value: unknown): Entry | undefined {
  const v = value as Partial<Entry> | null
  const l = v?.letter as Partial<Letter> | undefined
  if (typeof v !== 'object' || v === null || typeof l !== 'object' || l === null) return undefined
  if (typeof l.to !== 'string' || typeof l.subject !== 'string' || typeof l.body !== 'string' || typeof l.key !== 'string') return undefined
  if (typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt))) return undefined
  const letter: Letter = { to: l.to, subject: l.subject, body: l.body, key: l.key }
  if (typeof l.fallbackFrom === 'string') letter.fallbackFrom = l.fallbackFrom
  if (typeof l.manager === 'string') letter.manager = l.manager

  return { letter, createdAt: v.createdAt, attempts: typeof v.attempts === 'number' ? v.attempts : 0, ...(typeof v.lastTriedAt === 'string' ? { lastTriedAt: v.lastTriedAt } : {}) }
}
