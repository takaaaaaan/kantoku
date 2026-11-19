import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sectionsOf, tableOf } from './sections.ts'

test('sectionsOf gives offsets that slice back to the text', () => {
  const text = '# T\n\n## A\none\n\n## B\r\ntwo\n'
  const [a, b] = sectionsOf(text)
  assert.equal(a?.heading, 'A')
  assert.equal(text.slice(a?.start, a?.end), '## A\none\n\n')
  assert.equal(a?.body, 'one\n\n')
  assert.equal(b?.heading, 'B')
  assert.equal(b?.body, 'two\n')
  assert.equal(b?.end, text.length)
})

test('### is not a section', () => {
  assert.deepEqual(
    sectionsOf('## A\n### sub\nx').map(s => s.heading),
    ['A'],
  )
})

test('tableOf stops at the first non-table line', () => {
  const { header, rows } = tableOf('| a | b |\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |\n')
  assert.deepEqual(header, ['a', 'b'])
  assert.deepEqual(rows, [['1', '2']])
})
