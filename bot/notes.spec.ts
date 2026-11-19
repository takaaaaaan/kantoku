import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashOf, parseHandled, parseLog, parseMemory, parseReports } from './notes.ts'

const REPORTS = `# reports

## 2026-11-18 21:40 ask q-0418
PR を出す前に、どこで試しますか?
- 手元で試す (おすすめ)
- ステージングで試す
- Skip it (recommended)

## 2026-11-18 21:02
できました。PR: [#131](https://github.com/owner/repo/pull/131)
- a bullet that belongs to the report
`

test('reports split on headings', () => {
  const [ask, report] = parseReports(REPORTS)
  assert.equal(ask?.kind, 'ask')
  assert.ok(ask?.kind === 'ask')
  assert.equal(ask.id, 'q-0418')
  assert.equal(ask.text, 'PR を出す前に、どこで試しますか?')
  assert.deepEqual(ask.choices, [
    { label: '手元で試す', recommended: true },
    { label: 'ステージングで試す', recommended: false },
    { label: 'Skip it', recommended: true },
  ])
  assert.equal(ask.at, new Date(2026, 10, 18, 21, 40).toISOString())
  assert.equal(report?.kind, 'report')
})

test('report links and bullets kept as text', () => {
  const report = parseReports(REPORTS)[1]
  assert.equal(report?.text, 'できました。PR: [#131](https://github.com/owner/repo/pull/131)\n- a bullet that belongs to the report')
})

test('an ask with an answer line carries the answer', () => {
  const [ask] = parseReports('## 2026-11-18 10:00 ask q-1\nどこ?\n- A\n- B\n答え: A\n')
  assert.ok(ask?.kind === 'ask')
  assert.equal(ask.answer, 'A')
  assert.deepEqual(ask.choices.map(c => c.label), ['A', 'B'])
  const [en] = parseReports('## 2026-11-18 10:00 ask q-2\nWhere?\n- A\nAnswer: B\n')
  assert.ok(en?.kind === 'ask')
  assert.equal(en.answer, 'B')
})

test('a heading without a date is kept with an empty time', () => {
  const [report] = parseReports('## hello\nworld\n')
  assert.deepEqual(report, { kind: 'report', at: '', text: 'hello\nworld' })
})

test('memory one fact per bullet', () => {
  const memory = parseMemory('# m\n<!-- - not a fact -->\n- tests run with npm test (2026-11-10)\n- the user answers in the morning\n')
  assert.equal(memory.length, 2)
  assert.deepEqual(
    memory.map(m => [m.fact, m.date, m.line]),
    [
      ['tests run with npm test', '2026-11-10', 2],
      ['the user answers in the morning', undefined, 3],
    ],
  )
  assert.match(memory[0]?.id ?? '', /^[0-9a-f]{8}$/)
  assert.equal(parseMemory('x\n- tests run with npm test (2026-11-10)')[0]?.id, memory[0]?.id)
})

test('log skips broken lines', () => {
  const log = parseLog('{"id":"d-1","at":"2026-11-19T21:35:01+09:00","type":"say","text":"hi","delivery":"sent"}\r\n{"id":2}\n{"id":"d-x","type":"nope","at":""}\n{"broken')
  assert.deepEqual(log, [{ id: 'd-1', at: '2026-11-19T21:35:01+09:00', type: 'say', text: 'hi', delivery: 'sent' }])
})

test('handled ids', () => {
  assert.deepEqual([...parseHandled('d-1\r\n\n d-2 \n')], ['d-1', 'd-2'])
})

test('empty input', () => {
  assert.deepEqual(parseReports(''), [])
  assert.deepEqual(parseMemory(''), [])
  assert.deepEqual(parseLog(''), [])
  assert.equal(parseHandled('').size, 0)
})

test('hashOf is sha256 hex', () => {
  assert.equal(hashOf(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('an entry written above the title does not take the title in', () => {
  const [ask] = parseReports('## 2026-11-19 21:40 ask q-1\nWhere?\n- A (recommended)\n- B\n\n# Mochi reports\n\n## 2026-11-18 10:00\nold\n')
  assert.ok(ask?.kind === 'ask')
  assert.deepEqual(ask.choices.map(c => c.label), ['A', 'B'])
})
