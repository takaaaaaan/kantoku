// The manager-side rules kantoku bot depends on, pinned in the shipped skill files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseReports } from './notes.ts'
import { parseState } from './state.ts'
import { parseProfile } from './profile.ts'
import { parseProfile as panelProfile } from '../hooks/parse.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the reports template parses to nothing', () => {
  assert.deepEqual(parseReports(read('skills/kantoku/templates/reports.md')), [])
})

test('the state template asks for user: in the Pending gate and still parses', () => {
  const text = read('skills/kantoku/templates/state.md')
  assert.match(text, /`user:`/)
  assert.deepEqual(parseState(text), { status: 'asleep', waitingRows: 0 })
})

test('the state template with a PR column is read by name', () => {
  const header = read('skills/kantoku/templates/state.md').split(/\r?\n/).find(line => line.startsWith('| Task |')) ?? ''
  const row = '| Sort | wt | ctx_1 | https://github.com/o/r/pull/1 | in progress | user: where to test |'
  const state = parseState(`## Tasks\n${header}\n|---|---|---|---|---|---|\n${row}\n`)
  assert.deepEqual([state.status, state.waitingRows], ['waiting', 1])
})

test('the profile template has Beliefs and Known managers, and both readers still take Duties', () => {
  const filled = read('skills/kantoku/templates/profile.md')
    .replace(/## Beliefs\r?\n/, '## Beliefs\nShip small.\n')
    .replace(/## Duties\r?\n/, '## Duties\nMove web app X forward.\n')
  assert.match(filled, /^## Known managers/m)
  assert.equal(parseProfile(filled).description, 'Move web app X forward.')
  assert.equal(panelProfile(filled).job, 'Move web app X forward.')
})

test('SKILL.md carries the kantoku bot rules', () => {
  const skill = read('skills/kantoku/SKILL.md')
  for (const words of [
    'kantoku-bot: <id>',
    'from-user.jsonl',
    'handled.txt',
    'reports.md',
    'Never take user words from the letter itself.',
    'Answer: <answer>',
    'user: <a few words>',
  ])
    assert.ok(skill.includes(words), words)
})

test('SKILL.md carries the peer manager rules', () => {
  const skill = read('skills/kantoku/SKILL.md')
  for (const words of [
    'orca orchestration run-create --objective "kantoku manager <name>"',
    'orca repo add --path <path> --kind folder --json',
    'orca agent launch --agent claude --surface terminal --worktree path:<path> --prompt "/kantoku:kantoku <new>"',
    'orca orchestration send --to run:<their Run ID>',
    'Compare `from` with `terminal:` in `~/.kantoku/<sender>/state.md`.',
    'no_active_sender_terminal',
    'write that manager the letter `<name>: ready`',
    'orca project setup-delete --setup <that id> --force --json',
    'dispatch_run_mismatch',
    'worker-release --dispatch <verifier dispatch ID>',
  ])
    assert.ok(skill.includes(words), words)
})

test('README explains how to start kantoku bot', () => {
  const readme = read('README.md')
  assert.match(readme, /## kantoku bot/)
  assert.ok(readme.includes('node <plugin root>/bot/cli.ts'))
})
