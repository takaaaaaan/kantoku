import { expect, test } from 'claude-code/testing'

import { buildView, parseProfile, parseState, terminalOf } from './parse'

const STATE_JA = `# kaizen state

terminal: term_aaa
run: run_123
patrol_job: 8853b3aa

## タスク
| タスク | 子の worktree | dispatch ID | 状態 | 待っている gate |
|---|---|---|---|---|
| SKILL.md 英語化(spec: specs/english-skill.md) | wt-a | ctx_1 / task_5e43a15bf9b5 | worker_done。PR #1 検証待ち | — |
| mod 作成 task_920cd25731b4 | wt-b | ctx_2 | 作業中(plugin.json は触らない) | — |
| 起動・profile | current | ctx_3 | 完了: profile 作成済 | — |
| 片付け | current | ctx_4 | 一部完了: 2 つ残り | — |
| 検証 | current | ctx_5 | 合格(abc123) | — |

## 待ち列
- CI の結果を知らせる仕組み
(なし)

## 起こされた理由
- 2026-01-01 ユーザー: 起動
`

const STATE_EN = `# web state
terminal: term_bbb

## Tasks
| Task | dispatch ID | Status | Pending gate |
|---|---|---|---|
| Fix login | ctx_9 | **done** (merged) | — |
| Add a \\| pipe | ctx_8 | in progress | — |
| Verify | ctx_7 | PASS at abc123 | — |

## Queue
- (none)
- Write the docs
`

const PROFILE_JA = `# kaizen の担当

## 担当業務
OSS の skill「kantoku」の改善。使っていて出た問題を直す。

## 自律度
- 外への書き込み: auto(子のブランチへの push)
- merge: after-verifier(検証役が合格 → squash)
`

const PROFILE_EN = `# Duties of web

<!-- On the first startup, copy this.
     More comment. -->

## Duties
<!-- The work given to this manager -->
- Move the issues of the web app forward. Then keep CI green.

## Autonomy
- External writes: ask <!-- auto | ask -->
- merge: never <!-- after-verifier | never -->
`

test('terminalOf reads the terminal handle', () => {
  expect(terminalOf(STATE_JA)).toBe('term_aaa')
  expect(terminalOf(STATE_EN)).toBe('term_bbb')
  expect(terminalOf('# x\nrun: run_1\n')).toBe(undefined)
  expect(terminalOf('terminal:\n')).toBe(undefined)
})

test('parseProfile reads the first sentence of the job and the autonomy (Japanese)', () => {
  expect(parseProfile(PROFILE_JA)).toEqual({
    job: 'OSS の skill「kantoku」の改善。',
    externalWrites: 'auto',
    merge: 'after-verifier',
  })
})

test('parseProfile skips comments and bullets (English template)', () => {
  expect(parseProfile(PROFILE_EN)).toEqual({
    job: 'Move the issues of the web app forward.',
    externalWrites: 'ask',
    merge: 'never',
  })
})

test('parseProfile of an unfilled template leaves fields empty', () => {
  expect(parseProfile('## Duties\n<!-- fill me -->\n\n## Autonomy\n')).toEqual({
    job: '',
    externalWrites: undefined,
    merge: undefined,
  })
})

test('parseState reads the task table and the queue (Japanese)', () => {
  expect(parseState(STATE_JA)).toEqual([
    { title: 'SKILL.md 英語化', status: 'worker_done', isDone: false, isQueued: false },
    { title: 'mod 作成', status: '作業中', isDone: false, isQueued: false },
    { title: '起動・profile', status: '完了', isDone: true, isQueued: false },
    { title: '片付け', status: '一部完了', isDone: false, isQueued: false },
    { title: '検証', status: '合格', isDone: true, isQueued: false },
    { title: 'CI の結果を知らせる仕組み', status: 'queued', isDone: false, isQueued: true },
  ])
})

test('parseState reads English headings, bold and escaped pipes', () => {
  expect(parseState(STATE_EN)).toEqual([
    { title: 'Fix login', status: 'done', isDone: true, isQueued: false },
    { title: 'Add a | pipe', status: 'in progress', isDone: false, isQueued: false },
    { title: 'Verify', status: 'PASS at abc123', isDone: true, isQueued: false },
    { title: 'Write the docs', status: 'queued', isDone: false, isQueued: true },
  ])
})

test('parseState reads table rows written under the queue', () => {
  const text = `## タスク
| タスク | dispatch | 状態 |
|---|---|---|
| A | ctx_1 | 作業中 |

## 待ち列
| B | ctx_2 | merge 済 abc123 |
`
  expect(parseState(text)).toEqual([
    { title: 'A', status: '作業中', isDone: false, isQueued: false },
    { title: 'B', status: 'merge 済 abc123', isDone: true, isQueued: false },
  ])
})

test('parseState of a file with no tasks is empty', () => {
  expect(parseState('# x state\nterminal: term_1\n')).toEqual([])
})

test('buildView puts work first, then the queue, then what is done', () => {
  const view = buildView('kaizen', PROFILE_JA, STATE_JA)
  expect(view.name).toBe('kaizen')
  expect(view.job.startsWith('OSS の skill')).toBe(true)
  expect(view.tasks.map(t => t.title)).toEqual([
    'SKILL.md 英語化',
    'mod 作成',
    '片付け',
    'CI の結果を知らせる仕組み',
    '起動・profile',
    '検証',
  ])
})

test('a status that waits for done or pass is still open', () => {
  const text = `## タスク
| タスク | 状態 |
|---|---|
| A | 完了待ち |
| B | 合格待ち(検証役) |
| C | 完了 |
`
  expect(parseState(text).map(t => [t.title, t.isDone])).toEqual([
    ['A', false],
    ['B', false],
    ['C', true],
  ])
})

test('other status headers are read too', () => {
  const text = `## Tasks
| Task | ステータス |
|---|---|
| A | done |
`
  expect(parseState(text)).toEqual([{ title: 'A', status: 'done', isDone: true, isQueued: false }])
})

test('only a spec note is cut from a title', () => {
  const text = `## Tasks
| Task | Status |
|---|---|
| Fix crash (inspect logs) (spec: specs/crash.md) | in progress |
`
  expect(parseState(text)[0]?.title).toBe('Fix crash (inspect logs)')
})

test('an indented bullet under a queue item is not a task of its own', () => {
  const text = `## Queue
- Rotate keys
  - note: needs creds
`
  expect(parseState(text).map(t => t.title)).toEqual(['Rotate keys'])
})
