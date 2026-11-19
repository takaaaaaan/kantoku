import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseState } from './state.ts'

const table = (rows: string[][]) =>
  `# x state\n\nterminal: term_abc\nrun: run_123\n\n## Tasks\n| Task | Child worktree | dispatch ID | Status | Pending gate |\n|---|---|---|---|---|\n${rows
    .map(r => `| ${r.join(' | ')} |`)
    .join('\n')}\n\n## Queue\n`

test('working when a row is open', () => {
  assert.equal(parseState(table([['a', 'w', 'ctx_1', 'in progress', '-']])).status, 'working')
  assert.equal(parseState(table([['a', 'w', 'ctx_1', '完了待ち', '-']])).status, 'working')
})

test('asleep when every row is done or there are none', () => {
  const done = table([
    ['a', 'w', 'c', 'done', '-'],
    ['b', 'w', 'c', 'merged', '-'],
    ['c', 'w', 'c', '完了: PR #3', '-'],
    ['d', 'w', 'c', 'merge 済', '-'],
  ])
  assert.equal(parseState(done).status, 'asleep')
  assert.equal(parseState(table([])).status, 'asleep')
  assert.equal(parseState('').status, 'asleep')
})

test('waiting when a Pending gate starts with user:', () => {
  const s = parseState(
    table([
      ['a', 'w', 'c', 'in progress', 'user: どこで試すか'],
      ['b', 'w', 'c', 'in progress', 'User: merge?'],
      ['c', 'w', 'c', 'in progress', 'ユーザー: 確認'],
      ['d', 'w', 'c', 'in progress', 'ユーザー：確認'],
    ]),
  )
  assert.equal(s.status, 'waiting')
  assert.equal(s.waitingRows, 4)
})

test('a done row is not waiting even with a user: gate', () => {
  assert.equal(parseState(table([['a', 'w', 'c', 'done', 'user: old']])).waitingRows, 0)
})

test('free-text gates are not waiting', () => {
  const s = parseState(
    table([
      ['a', 'w', 'c', 'in progress', '-'],
      ['b', 'w', 'c', 'in progress', '—'],
      ['c', 'w', 'c', 'in progress', 'merge は人(C)'],
      ['d', 'w', 'c', 'in progress', 'team-bot 移動待ち'],
    ]),
  )
  assert.equal(s.waitingRows, 0)
  assert.equal(s.status, 'working')
})

test('Japanese headings parse the same', () => {
  const text = '## タスク\n| タスク | 子 | dispatch | 状態 | 待っている gate |\n|---|---|---|---|---|\n| a | w | c | 作業中 | ユーザー: 確認 |\n'
  const s = parseState(text)
  assert.equal(s.status, 'waiting')
  assert.equal(s.waitingRows, 1)
})

test('run and terminal lines', () => {
  const s = parseState(table([]))
  assert.equal(s.run, 'run_123')
  assert.equal(s.terminal, 'term_abc')
  assert.equal(parseState('run:\npatrol_job:\n').run, undefined)
})

test('template parses', () => {
  const text = readFileSync(new URL('../skills/kantoku/templates/state.md', import.meta.url), 'utf8')
  assert.deepEqual(parseState(text), { status: 'asleep', waitingRows: 0 })
})
