// The one writer for kantoku-watch's JSON files: a temp file, then a rename, so a
// reader never sees half a file. The heartbeat timer and a tick can write the
// same file at once, so each write has its own temp name.

import { rename, writeFile } from 'node:fs/promises'

export async function writeJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 1))
  await rename(temp, path)
}
