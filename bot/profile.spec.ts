import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseProfile } from './profile.ts'

const EN = `# Duties of Mochi

## Duties
<!-- comment -->
Move the search issues forward.

## Description
<!-- one paragraph -->
Keeps the search page healthy.

## Won't do
- Merge without the user
* Touch production

## Routines
| Name | When | Task | Quiet when |
|---|---|---|---|
| morning | every day 9:00 | Read new issues | nothing new |

## Extra skills (added to child specs)
- \`issue-flow\` and \`repo-rules\`
<!-- \`not-this\` -->

## Language
Chat in Japanese.
`

test('description prefers Description over Duties', () => {
  assert.equal(parseProfile(EN).description, 'Keeps the search page healthy.')
})

test('description falls back to Duties, comments stripped', () => {
  const text = '## Duties\n<!-- example -->\nMove the search issues forward.\n'
  assert.equal(parseProfile(text).description, 'Move the search issues forward.')
  assert.equal(parseProfile('## 担当業務\n検索を進める。\n').description, '検索を進める。')
})

test('wontDo reads bullets', () => {
  assert.deepEqual(parseProfile(EN).wontDo, ['Merge without the user', 'Touch production'])
  assert.deepEqual(parseProfile('## やらないこと\n- 本番に触る\n').wontDo, ['本番に触る'])
})

test('routines reads the table', () => {
  assert.deepEqual(parseProfile(EN).routines, [{ name: 'morning', when: 'every day 9:00', what: 'Read new issues' }])
  const ja = '## ルーティン\n| 名前 | いつ | やること |\n|---|---|---|\n| 朝 | 毎日 9:00 | issue を読む |\n'
  assert.deepEqual(parseProfile(ja).routines, [{ name: '朝', when: '毎日 9:00', what: 'issue を読む' }])
})

test('extraSkills reads backticked names', () => {
  assert.deepEqual(parseProfile(EN).extraSkills, ['issue-flow', 'repo-rules'])
  assert.deepEqual(parseProfile('## 追加 skill\n- `a-b`\n').extraSkills, ['a-b'])
})

test('language', () => {
  assert.equal(parseProfile(EN).language, 'ja')
  assert.equal(parseProfile('## 言語\n日本語で話す\n').language, 'ja')
  assert.equal(parseProfile('## Language\nEnglish only\n').language, 'en')
  assert.equal(parseProfile('## Duties\n検索を進める\n').language, 'ja')
  assert.equal(parseProfile('## Duties\nMove search\n').language, 'en')
})

test('only five keys', () => {
  assert.deepEqual(Object.keys(parseProfile(EN)).sort(), ['description', 'extraSkills', 'language', 'routines', 'wontDo'])
})

test('template parses', () => {
  const text = readFileSync(new URL('../skills/kantoku/templates/profile.md', import.meta.url), 'utf8')
  const profile = parseProfile(text)
  assert.equal(profile.description, '')
  assert.deepEqual(profile.extraSkills, [])
  assert.deepEqual(profile.routines, [])
})

test('CRLF files parse the same', () => {
  assert.deepEqual(parseProfile(EN.replace(/\n/g, '\r\n')), parseProfile(EN))
})
