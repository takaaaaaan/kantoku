import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashOf, memoryIdOf, parseMemory } from './notes.ts'
import { parseProfile } from './profile.ts'
import { sectionsOf } from './sections.ts'
import { ChangedError, InputError, fixMemory, forgetMemory, safeReplace, setDescription } from './write.ts'
import type { FsLike } from './write.ts'

const home = () => mkdtempSync(join(tmpdir(), 'kantoku-bot-edit-'))

const PROFILE = `# Duties of Mochi

## Duties
Move the search issues forward.

## Description
<!-- one paragraph -->
Old text.

## Won't do
- old rule

## Autonomy
- merge: never
`

const EDITED = /^(description|won't do|説明|やらないこと)/i
const others = (text: string) =>
  sectionsOf(text)
    .filter(s => !EDITED.test(s.heading))
    .map(s => [s.heading, s.body])

// ---------- setDescription ----------

test("setDescription replaces only Description and Won't do", () => {
  const out = setDescription(PROFILE, 'New text.\nSecond line.', ['a', 'b'])
  assert.deepEqual(others(out), others(PROFILE))
  const view = parseProfile(out)
  assert.equal(view.description, 'New text.\nSecond line.')
  assert.deepEqual(view.wontDo, ['a', 'b'])
  assert.match(out, /<!-- one paragraph -->/)
  assert.ok(out.startsWith('# Duties of Mochi\n'))
})

test('setDescription creates both sections after the title when missing', () => {
  const text = '# Duties of Sora\n\n## Duties\nDocs.\n\n## Language\nEnglish\n'
  const out = setDescription(text, 'Keeps the docs tidy.', ['delete files'])
  assert.deepEqual(others(out), others(text))
  assert.deepEqual(
    sectionsOf(out).map(s => s.heading),
    ['Description', "Won't do", 'Duties', 'Language'],
  )
  assert.equal(parseProfile(out).description, 'Keeps the docs tidy.')
  assert.deepEqual(parseProfile(out).wontDo, ['delete files'])
})

test('setDescription uses Japanese headings in a Japanese profile and keeps CRLF', () => {
  const text = '# Sora の担当業務\r\n\r\n## 担当業務\r\nドキュメントを整える。\r\n'
  const out = setDescription(text, '整える係です。', [])
  assert.deepEqual(
    sectionsOf(out).map(s => s.heading),
    ['説明', 'やらないこと', '担当業務'],
  )
  assert.doesNotMatch(out.replace(/\r\n/g, ''), /\n/)
  const ja = '# x\n\n## 説明\n古い\n\n## やらないこと\n- 古い\n\n## 言語\n日本語\n'
  const replaced = setDescription(ja, '新しい', ['新しいルール'])
  assert.deepEqual(parseProfile(replaced).wontDo, ['新しいルール'])
  assert.deepEqual(others(replaced), others(ja))
})

test('setDescription adds a missing Won’t do right after an existing Description', () => {
  const text = '# x\n\n## Description\nold\n\n## Duties\nd\n'
  const out = setDescription(text, 'new', ['r'])
  assert.deepEqual(
    sectionsOf(out).map(s => s.heading),
    ['Description', "Won't do", 'Duties'],
  )
  assert.deepEqual(others(out), others(text))
})

test('setDescription on an empty file', () => {
  assert.equal(parseProfile(setDescription('', 'x', [])).description, 'x')
})

test('bad description input is refused', () => {
  assert.throws(() => setDescription(PROFILE, 'x'.repeat(2001), []), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok\n# heading', []), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok\n## heading', []), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok', Array.from({ length: 21 }, (_, n) => `rule ${n}`)), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok', ['x'.repeat(201)]), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok', ['# no']), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok', ['two\nlines']), InputError)
})

test('hidden parts and comment markers are refused', () => {
  assert.throws(() => setDescription(PROFILE, 'uses [hidden] here', []), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok', ['no [hidden]']), InputError)
  assert.throws(() => setDescription(PROFILE, 'a <!-- b', []), InputError)
  assert.throws(() => setDescription(PROFILE, 'ok', ['b --> c']), InputError)
  const id = parseMemory(MEMORY)[0]?.id ?? ''
  assert.throws(() => fixMemory(MEMORY, id, 'token [hidden]'), InputError)
  assert.throws(() => fixMemory(MEMORY, id, 'starts <!-- here'), InputError)
})

test('backups past -9 in one second are pruned in number order', async () => {
  const dir = home()
  const file = join(dir, 'memory.md')
  writeFileSync(file, 'm')
  const backupDir = join(dir, 'bot', 'backup')
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, 'memory.md.20261119-214005'), '')
  for (let n = 2; n <= 21; n++) writeFileSync(join(backupDir, `memory.md.20261119-214005-${n}`), '')
  await safeReplace(file, hashOf('m'), t => t + 'x', { backupDir, now: NOW })
  const left = readdirSync(backupDir)
  assert.equal(left.length, 20)
  assert.ok(left.includes('memory.md.20261119-214005-22'))
  assert.ok(left.includes('memory.md.20261119-214005-10'))
  assert.ok(!left.includes('memory.md.20261119-214005-2'))
  assert.ok(!left.includes('memory.md.20261119-214005'))
})

test('control characters are removed', () => {
  const out = setDescription(PROFILE, 'a\u0000b\u001bc', ['d\u0007e'])
  assert.equal(parseProfile(out).description, 'abc')
  assert.deepEqual(parseProfile(out).wontDo, ['de'])
})

// ---------- memory ----------

const MEMORY = '# memory\n\n- tests run with npm test (2026-11-10)\n- the user answers in the morning\n'

test('forgetMemory and fixMemory touch one line', () => {
  const [first, second] = parseMemory(MEMORY)
  assert.ok(first && second)
  assert.equal(forgetMemory(MEMORY, first.id), '# memory\n\n- the user answers in the morning\n')
  assert.equal(fixMemory(MEMORY, second.id, 'the user answers at night'), '# memory\n\n- tests run with npm test (2026-11-10)\n- the user answers at night\n')
  assert.equal(fixMemory(MEMORY, first.id, 'tests run with node --test'), '# memory\n\n- tests run with node --test (2026-11-10)\n- the user answers in the morning\n')
  assert.equal(memoryIdOf('- x'), memoryIdOf('  - x  '))
})

test('forgetMemory keeps CRLF and the last line', () => {
  const crlf = '- a\r\n- b'
  const b = parseMemory(crlf)[1]
  assert.ok(b)
  assert.equal(forgetMemory(crlf, b.id), '- a\r\n')
})

test('unknown memory id or bad fact throws', () => {
  const id = parseMemory(MEMORY)[0]?.id ?? ''
  assert.throws(() => forgetMemory(MEMORY, 'ffffffff'), InputError)
  assert.throws(() => fixMemory(MEMORY, id, 'x'.repeat(301)), InputError)
  assert.throws(() => fixMemory(MEMORY, id, 'a\nb'), InputError)
  assert.throws(() => fixMemory(MEMORY, id, ' '), InputError)
  assert.throws(() => fixMemory(MEMORY, id, '# x'), InputError)
})

// ---------- safeReplace ----------

const NOW = new Date(2026, 10, 19, 21, 40, 5)

test('safeReplace: version mismatch leaves file and backups alone', async () => {
  const dir = home()
  const file = join(dir, 'profile.md')
  writeFileSync(file, PROFILE)
  const backupDir = join(dir, 'bot', 'backup')
  await assert.rejects(safeReplace(file, hashOf('other'), t => t + 'x', { backupDir, now: NOW }), ChangedError)
  assert.equal(readFileSync(file, 'utf8'), PROFILE)
  assert.equal(existsSync(backupDir), false)
})

test('safeReplace: success writes, backs up, and returns the new version', async () => {
  const dir = home()
  const file = join(dir, 'profile.md')
  writeFileSync(file, PROFILE)
  const backupDir = join(dir, 'bot', 'backup')
  const { version } = await safeReplace(file, hashOf(PROFILE), t => t + 'x', { backupDir, now: NOW })
  assert.equal(readFileSync(file, 'utf8'), PROFILE + 'x')
  assert.equal(version, hashOf(PROFILE + 'x'))
  assert.deepEqual(readdirSync(backupDir), ['profile.md.20261119-214005'])
  assert.equal(readFileSync(join(backupDir, 'profile.md.20261119-214005'), 'utf8'), PROFILE)
  assert.deepEqual(readdirSync(dir).sort(), ['bot', 'profile.md'])
})

test('safeReplace on a missing file creates it without a backup', async () => {
  const dir = home()
  const file = join(dir, 'memory.md')
  const backupDir = join(dir, 'bot', 'backup')
  await safeReplace(file, hashOf(''), () => '- x\n', { backupDir, now: NOW })
  assert.equal(readFileSync(file, 'utf8'), '- x\n')
  assert.equal(existsSync(backupDir), false)
})

test('safeReplace keeps the newest 20 backups per file', async () => {
  const dir = home()
  const file = join(dir, 'memory.md')
  writeFileSync(file, 'm')
  const backupDir = join(dir, 'bot', 'backup')
  mkdirSync(backupDir, { recursive: true })
  for (let n = 0; n < 25; n++) writeFileSync(join(backupDir, `memory.md.20261101-0000${String(n).padStart(2, '0')}`), '')
  writeFileSync(join(backupDir, 'profile.md.20261101-000000'), '')
  await safeReplace(file, hashOf('m'), t => t + '- x\n', { backupDir, now: NOW })
  const left = readdirSync(backupDir).sort()
  assert.equal(left.filter(f => f.startsWith('memory.md.')).length, 20)
  assert.ok(left.includes('memory.md.20261119-214005'))
  assert.ok(!left.includes('memory.md.20261101-000000'))
  assert.ok(left.includes('profile.md.20261101-000000'))
})

test('safeReplace: two saves in the same second keep both backups', async () => {
  const dir = home()
  const file = join(dir, 'memory.md')
  writeFileSync(file, 'a')
  const backupDir = join(dir, 'bot', 'backup')
  const first = await safeReplace(file, hashOf('a'), () => 'b', { backupDir, now: NOW })
  await safeReplace(file, first.version, () => 'c', { backupDir, now: NOW })
  assert.equal(readdirSync(backupDir).length, 2)
})

test('safeReplace: a failing rename leaves the original byte-identical and no temp file', async () => {
  const dir = home()
  const file = join(dir, 'profile.md')
  writeFileSync(file, PROFILE)
  const broken: FsLike = { ...fsp, rename: async () => Promise.reject(new Error('disk gone')) }
  await assert.rejects(safeReplace(file, hashOf(PROFILE), t => t + 'x', { backupDir: join(dir, 'bot', 'backup'), now: NOW, fs: broken }), /disk gone/)
  assert.equal(readFileSync(file, 'utf8'), PROFILE)
  assert.ok(!readdirSync(dir).some(f => f.endsWith('.bot-tmp')))
})

test('safeReplace: a transform that throws writes nothing', async () => {
  const dir = home()
  const file = join(dir, 'profile.md')
  writeFileSync(file, PROFILE)
  const bad = () => {
    throw new InputError('bad')
  }
  await assert.rejects(safeReplace(file, hashOf(PROFILE), bad, { backupDir: join(dir, 'bot', 'backup'), now: NOW }), InputError)
  assert.equal(readFileSync(file, 'utf8'), PROFILE)
  assert.deepEqual(readdirSync(dir), ['profile.md'])
})
