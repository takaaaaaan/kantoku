// The one writer for kantoku-watch's JSON files: a temp file, then a rename, so a
// reader never sees half a file. The heartbeat timer and a tick can write the
// same file at once, so each write has its own temp name.

import { rename, unlink, writeFile } from 'node:fs/promises'

export async function writeJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 1))
    await rename(temp, path)
  } catch (error) {
    // A failed write leaves no temp file behind; the caller writes the whole file again later.
    await unlink(temp).catch(() => {})
    throw error
  }
}
