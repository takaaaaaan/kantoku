// Test helper: a throwaway copy of bot/fixtures/home with the cases git cannot
// hold (an empty directory, a bad name, a stray file, a 2 MB memory.md).
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/home', import.meta.url))

export function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'kantoku-bot-'))
  cpSync(FIXTURE_HOME, root, { recursive: true })
  mkdirSync(join(root, 'Empty'))
  mkdirSync(join(root, 'bad name!'))
  writeFileSync(join(root, 'bad name!', 'state.md'), '## Tasks\n')
  writeFileSync(join(root, 'notes.txt'), 'not a manager')
  writeFileSync(join(root, 'Pico', 'memory.md'), '- big\n'.repeat(400_000))

  return root
}
