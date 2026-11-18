import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDoneStatus, parsePrRef, parseTargets, prKey, readAllTargets } from './targets.ts'

const template = readFileSync(new URL('../skills/kantoku/templates/state.md', import.meta.url), 'utf8')

const state = (rows: string, run = 'run: run_1\n') => `# x state
${run}
## Tasks
| Task | Child worktree | dispatch ID | PR | Status | Pending gate |
|---|---|---|---|---|---|
${rows}

## Queue
`

test('reads the real template', () => {
  assert.deepEqual(parseTargets('x', template), [])
  const header = template.split(/\r?\n/).find(line => line.startsWith('| Task'))
  assert.match(header ?? '', /\| PR \|/)
})

test('maps a row to its child and manager', () => {
  const targets = parseTargets('mgr', state('| Fix login | wt | ctx_9f1 / task_ab12 | https://github.com/Owner/Repo/pull/12 | in progress | — |'))
  assert.deepEqual(targets, [{
    pr: { repo: 'owner/repo', number: 12 },
    url: 'https://github.com/Owner/Repo/pull/12',
    manager: 'mgr',
    run: 'run_1',
    dispatch: 'ctx_9f1',
    task: 'Fix login',
    rowDone: false,
  }])
})

test('parsePrRef accepts URLs and owner/repo#n', () => {
  const pr = { repo: 'o/r', number: 12 }
  assert.deepEqual(parsePrRef('https://github.com/o/r/pull/12'), pr)
  assert.deepEqual(parsePrRef('https://github.com/o/r/pull/12/files'), pr)
  assert.deepEqual(parsePrRef('o/r#12'), pr)
  assert.deepEqual(parsePrRef('(https://github.com/o/r/pull/12)'), pr)
  assert.deepEqual(parsePrRef('[#12](https://github.com/o/r/pull/12)'), pr)
  assert.deepEqual(parsePrRef('（https://github.com/o/r/pull/12）'), pr)
  assert.deepEqual(parsePrRef('O.x/r-1_2#7'), { repo: 'o.x/r-1_2', number: 7 })
})

test('parsePrRef rejects anything else', () => {
  for (const cell of ['—', '', '#12', 'PR 12', 'https://github.com/o/r/issues/12', 'o/r#', 'https://example.com/o/r/pull/12'])
    assert.equal(parsePrRef(cell), undefined, cell)
})

test('prKey', () => {
  assert.equal(prKey({ repo: 'o/r', number: 12 }), 'o/r#12')
})

test('no PR column means no targets', () => {
  const text = `run: run_1
## Tasks
| Task | Child worktree | dispatch ID | Status | Pending gate |
|---|---|---|---|---|
| Fix | wt | ctx_1 | https://github.com/o/r/pull/1 | — |
`
  assert.deepEqual(parseTargets('x', text), [])
})

test('done row is rowDone', () => {
  const rows = ['merged', '完了', '完了待ち']
    .map((status, at) => `| T${at} | wt | ctx_${at} | o/r#${at + 1} | ${status} | — |`)
    .join('\n')
  assert.deepEqual(parseTargets('x', state(rows)).map(t => t.rowDone), [true, true, false])
})

test('isDoneStatus', () => {
  assert.equal(isDoneStatus('done'), true)
  assert.equal(isDoneStatus('合格待ち'), false)
  assert.equal(isDoneStatus('in progress'), false)
})

test('Japanese headings', () => {
  const text = `run: run_j
## タスク
| タスク | 子の worktree | dispatch ID | PR | 状態 | 待っている gate |
|---|---|---|---|---|---|
| ログイン修正 | wt | ctx_9f1 | https://github.com/o/r/pull/12 | 作業中 | — |
`
  const [target] = parseTargets('m', text)
  assert.deepEqual(target?.pr, { repo: 'o/r', number: 12 })
  assert.equal(target?.task, 'ログイン修正')
  assert.equal(target?.dispatch, 'ctx_9f1')
  assert.equal(target?.run, 'run_j')
})

test('odd hand-written cells never throw', () => {
  const rows = [
    '| A | wt | ctx_a | #12 | in progress | — |',
    '| B | wt | — | （https://github.com/o/r/pull/3） | in progress | — |',
    '| C | wt | ctx_c |',
    '| | wt | ctx_d | o/r#4 | x | — |',
  ].join('\n')
  const targets = parseTargets('x', state(rows, ''))
  assert.deepEqual(targets.map(t => [t.task, prKey(t.pr), t.dispatch, t.run]), [['B', 'o/r#3', undefined, undefined]])
})

test('table inside a comment is ignored', () => {
  const text = `## Tasks
<!--
| Task | dispatch ID | PR | Status |
|---|---|---|---|
| T | ctx_1 | o/r#1 | x |
-->
`
  assert.deepEqual(parseTargets('x', text), [])
})

test('two rows, one PR', () => {
  const rows = '| A | wt | ctx_a | o/r#1 | x | — |\n| B | wt | ctx_b | https://github.com/O/R/pull/1 | x | — |'
  assert.deepEqual(parseTargets('x', state(rows)).map(t => [t.dispatch, prKey(t.pr)]), [['ctx_a', 'o/r#1'], ['ctx_b', 'o/r#1']])
})

test('readAllTargets reads every manager and skips unreadable entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kw-targets-'))
  for (const [name, pr] of [['a', 'o/r#1'], ['b', 'o/r#2']] as const) {
    mkdirSync(join(root, name))
    writeFileSync(join(root, name, 'state.md'), state(`| T | wt | ctx_${name} | ${pr} | x | — |`))
  }
  mkdirSync(join(root, 'empty'))
  writeFileSync(join(root, 'stray.md'), 'not a manager')
  const targets = await readAllTargets(root)
  assert.deepEqual(targets.map(t => [t.manager, prKey(t.pr)]).sort(), [['a', 'o/r#1'], ['b', 'o/r#2']])
  assert.deepEqual(await readAllTargets(join(root, 'missing')), [])
})
