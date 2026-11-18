// The outbox: every letter kantoku-watch decides to send is written here, on
// disk, before the first try. A letter leaves the outbox in one place only,
// `settle` below, and only when its job is done:
//   sent     — `orca orchestration send` exited 0 (seen.json is saved right
//              then), or the key is already in seen.json;
//   dropped  — a drop is itself an entry. A letter that failed for GIVE_UP_MS
//              and at least GIVE_UP_ATTEMPTS tries is replaced, in one write of
//              outbox.json, by a `dropped:<key>` entry holding the line for the
//              manager. That entry leaves only after the manager's line was sent
//              (or itself gave up) and the DROPPED line was written to watch.log.
//              Then both keys go to seen.json, so the fact is not put back.
// A crash or a failed log write at any step leaves an entry that the next flush
// takes up where it stopped. Nothing else (a close, a catch-up, a failed gh read,
// a restart) touches the outbox. The file is `{ [key]: Entry }`.

import { copyFile, readFile } from 'node:fs/promises'
import { writeJson } from './files.ts'
import type { Letter } from './route.ts'
import type { Seen } from './seen.ts'

// A drop in progress. notify: there is a manager to tell (letter is that line).
// told: the manager's line was sent, or gave up itself; then only the log lines are left.
// logged: how many of the DROPPED lines are already in watch.log, so none is written twice.
export type Drop = { key: string; to: string; subject: string; tries: number; since: string; notify: boolean; told?: 'sent' | 'gave-up'; logged?: number }

export type Entry = { letter: Letter; createdAt: string; attempts: number; lastTriedAt?: string; drop?: Drop }

// A log writer: false or a throw means the line was not written.
export type LogLine = (line: string) => Promise<boolean | void>

export type Outbox = {
  keys(): string[]
  // Entries with a letter still to send. A drop waiting only for its log line does not count.
  unsent(): number
  entry(key: string): Entry | undefined
  put(letters: Letter[], now: Date): Promise<void>
  flush(send: (letter: Letter) => Promise<boolean>, now: Date, log: LogLine): Promise<{ sent: number; failed: number }>
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

async function written(log: LogLine, line: string): Promise<boolean> {
  try {
    return (await log(line)) !== false
  } catch {
    return false
  }
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
  const tooSoon = (entry: Entry, now: Date) => entry.lastTriedAt !== undefined && now.getTime() - Date.parse(entry.lastTriedAt) < retryWaitMs(entry.attempts)
  const givesUp = (entry: Entry, now: Date) => entry.attempts >= GIVE_UP_ATTEMPTS && now.getTime() - Date.parse(entry.createdAt) >= GIVE_UP_MS
  const failedTry = (entry: Entry, now: Date) => {
    entry.attempts++
    entry.lastTriedAt = now.toISOString()
  }

  // The one place an entry leaves the outbox.
  const settle = (key: string) => entries.delete(key)

  // A letter given up becomes a drop entry, in the same write that removes it.
  const startDrop = async (entry: Entry, now: Date, log: LogLine) => {
    const { letter } = entry
    const drop: Drop = { key: letter.key, to: letter.to, subject: letter.subject, tries: entry.attempts, since: entry.createdAt, notify: false }
    const notice: Letter = { to: '', subject: '', body: '', key: `${DROPPED}${letter.key}` }
    if (!letter.key.startsWith(DROPPED) && letter.manager !== undefined && letter.manager !== letter.to) {
      drop.notify = true
      notice.to = letter.manager
      notice.subject = `kantoku-watch: gave up sending a letter to ${letter.to} after a day of failures (see watch.log): ${letter.subject}`
      if (letter.fallbackFrom !== undefined) notice.fallbackFrom = letter.fallbackFrom
    }
    settle(letter.key)
    entries.set(notice.key, { letter: notice, createdAt: now.toISOString(), attempts: 0, drop })
    await save()
    // A hint only: the DROPPED line that counts is written when the drop is done.
    await written(log, `GIVING UP ${letter.key} to ${letter.to} after ${entry.attempts} tries; ${drop.notify ? `telling ${notice.to} first` : 'no manager to tell'}`)

    return notice.key
  }

  // Works a drop entry forward from wherever it stopped. True when it is finished and settled.
  const advanceDrop = async (key: string, entry: Entry, drop: Drop, send: (letter: Letter) => Promise<boolean>, now: Date, log: LogLine) => {
    if (drop.notify && drop.told === undefined) {
      if (tooSoon(entry, now)) return false
      if (await send(entry.letter)) drop.told = 'sent'
      else {
        failedTry(entry, now)
        if (givesUp(entry, now)) drop.told = 'gave-up'
        else {
          await save()
          await written(log, `FAILED ${entry.letter.to} ${entry.letter.subject} (try ${entry.attempts}; kept in the outbox)`)

          return false
        }
      }
      await save()
    }
    const told = drop.told === 'sent' ? 'the manager was told' : drop.told === 'gave-up' ? `the line to ${entry.letter.to} failed for a day too` : 'no manager to tell'
    const all = [`DROPPED ${drop.key} to ${drop.to} after ${drop.tries} tries since ${drop.since}: ${drop.subject}; ${told}`]
    if (drop.told === 'gave-up') all.push(`DROPPED ${key} to ${entry.letter.to} after ${entry.attempts} tries since ${entry.createdAt}: ${entry.letter.subject}`)
    // Every line must be written before the drop counts as done; a failed write is tried again next round.
    for (const line of all.slice(drop.logged ?? 0)) {
      if (!(await written(log, line))) return false
      drop.logged = (drop.logged ?? 0) + 1
      await save()
    }
    seen.add(drop.key, now)
    seen.add(key, now)
    await seen.save()
    settle(key)

    return true
  }

  return {
    keys: () => [...entries.keys()],
    unsent: () => [...entries.values()].filter(e => e.drop === undefined || (e.drop.notify && e.drop.told === undefined)).length,
    entry: key => entries.get(key),
    // A letter already sent (or dropped, or being dropped) is not put back; one already waiting keeps its entry and its tries.
    put: async (letters, now) => {
      const fresh = letters.filter(letter => !entries.has(letter.key) && !entries.has(`${DROPPED}${letter.key}`) && !seen.has(letter.key))
      for (const letter of fresh) entries.set(letter.key, { letter, createdAt: now.toISOString(), attempts: 0 })
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
          await written(log, `already sent ${key}; removed from the outbox`)
          continue
        }
        if (entry.drop !== undefined) {
          if (await advanceDrop(key, entry, entry.drop, send, now, log)) changed = true
          continue
        }
        if (tooSoon(entry, now)) continue
        changed = true
        if (await send(entry.letter)) {
          // seen.json is saved before anything else, so a crash later in this round cannot send it again.
          seen.add(key, now)
          await seen.save()
          settle(key)
          sent++
          await written(log, `sent ${entry.letter.to} ${entry.letter.subject}`)
          continue
        }
        failed++
        failedTry(entry, now)
        if (givesUp(entry, now)) {
          const dropKey = await startDrop(entry, now, log)
          const started = entries.get(dropKey)
          if (started?.drop !== undefined) await advanceDrop(dropKey, started, started.drop, send, now, log)
        } else await written(log, `FAILED ${entry.letter.to} ${entry.letter.subject} (try ${entry.attempts}; kept in the outbox)`)
      }
      if (changed) await save()

      return { sent, failed }
    },
  }
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
  const entry: Entry = { letter, createdAt: v.createdAt, attempts: typeof v.attempts === 'number' ? v.attempts : 0 }
  if (typeof v.lastTriedAt === 'string') entry.lastTriedAt = v.lastTriedAt
  const d = v.drop as Partial<Drop> | undefined
  if (typeof d === 'object' && d !== null && typeof d.key === 'string' && typeof d.to === 'string' && typeof d.subject === 'string' && typeof d.since === 'string' && typeof d.notify === 'boolean')
    entry.drop = { key: d.key, to: d.to, subject: d.subject, tries: typeof d.tries === 'number' ? d.tries : 0, since: d.since, notify: d.notify, ...(d.told === 'sent' || d.told === 'gave-up' ? { told: d.told } : {}), ...(typeof d.logged === 'number' ? { logged: d.logged } : {}) }
  // A letter with no address is only a drop's placeholder; without its drop part it is nothing to send.
  if (letter.to === '' && (entry.drop === undefined || entry.drop.notify)) return undefined

  return entry
}
