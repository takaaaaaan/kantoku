// Remembers every letter sent and every delivery handled, so each fact is sent once.
// The file is `{ [key]: isoTime }`. A missing or broken file starts empty.

import { readFile } from 'node:fs/promises'
import { writeJson } from './files.ts'

export type Seen = {
  has(key: string): boolean
  add(key: string, at: Date): void
  prune(activePrKeys: Set<string>, now: Date): void
  save(): Promise<void>
  // True when memory has keys seen.json may not have (added since the last successful save).
  unsaved(): boolean
}

const KEEP_MS = 14 * 24 * 60 * 60 * 1000

export async function openSeen(path: string): Promise<Seen> {
  const keys = new Map<string, string>()
  let unsaved = false
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof data === 'object' && data !== null && !Array.isArray(data))
      for (const [key, at] of Object.entries(data)) if (typeof at === 'string') keys.set(key, at)
  } catch {}

  return {
    has: key => keys.has(key),
    add: (key, at) => {
      keys.set(key, at.toISOString())
      unsaved = true
    },
    prune: (active, now) => {
      for (const [key, at] of keys) {
        const old = now.getTime() - Date.parse(at) > KEEP_MS || Number.isNaN(Date.parse(at))
        const pr = /^(?:ci|review|comment|closed):([^#\s]+#\d+)/.exec(key)?.[1]
        if (old && (pr === undefined || !active.has(pr))) keys.delete(key)
      }
    },
    save: async () => {
      unsaved = true
      await writeJson(path, Object.fromEntries(keys))
      unsaved = false
    },
    unsaved: () => unsaved,
  }
}
