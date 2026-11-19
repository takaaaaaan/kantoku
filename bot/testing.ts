// Test helper: a throwaway copy of bot/fixtures/home with the cases git cannot
// hold (an empty directory, a bad name, a stray file, a 2 MB memory.md).
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Recipe } from './secret.ts'

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

// A harmless recipe for real runs: node writes how many bytes it got, its argv
// and whether its env holds the value, to a file. It never writes the value.
export function countRecipe(out: string): Recipe {
  const script = `const fs=require('fs');let n=0;const parts=[];process.stdin.on('data',c=>{n+=c.length;parts.push(c)}).on('end',()=>{const got=Buffer.concat(parts).toString('utf8');fs.writeFileSync(process.argv[1],JSON.stringify({bytes:n,argv:process.argv.slice(2),envHasValue:Object.values(process.env).some(v=>v&&v===got)}));process.exit(Number(process.argv[2]))})`
  return { file: process.execPath, fields: { exit: /^[0-9]$/ }, args: f => ['-e', script, out, f.exit ?? '0'] }
}
