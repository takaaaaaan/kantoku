import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { automationsFor, parseRoutines, planSync } from './routines.ts'
import type { Existing } from './routines.ts'

const PROFILE = `# Duties of alice

## Duties
Read mail.

## Routines
Timezone: Asia/Seoul
| Name | When | What | Wake | Quiet when |
|---|---|---|---|---|
| morning-digest | 0 9 * * * | Sum up the morning mail (routines/morning-digest.md) | child | nothing needs action |
| standup | 50 8 * * 1-5 | Look at today's queue | manager | the queue is empty |

## Language
English
`

const CTX = { manager: 'alice', node: 'C:/node/node.exe', cli: 'C:/kantoku/routines/cli.ts', workspace: 'C:/Users/u/.kantoku-routines', timezone: 'Europe/Paris' }

test('reads the Routines table and its timezone', () => {
  const table = parseRoutines(PROFILE)
  assert.equal(table.timezone, 'Asia/Seoul')
  assert.deepEqual(table.problems, [])
  assert.deepEqual(table.routines, [
    { name: 'morning-digest', cron: '0 9 * * *', what: 'Sum up the morning mail (routines/morning-digest.md)', wake: 'child', quietWhen: 'nothing needs action' },
    { name: 'standup', cron: '50 8 * * 1-5', what: "Look at today's queue", wake: 'manager', quietWhen: 'the queue is empty' },
  ])
})

test('an old profile with no Routines section has no routines and no problems', () => {
  assert.deepEqual(parseRoutines('## Duties\nRead mail.\n'), { timezone: undefined, routines: [], problems: [], skipped: [] })
})

test('the template parses to no routines', () => {
  const text = readFileSync(new URL('../skills/kantoku/templates/profile.md', import.meta.url), 'utf8')
  assert.deepEqual(parseRoutines(text), { timezone: undefined, routines: [], problems: [], skipped: [] })
})

test('columns are found by name, in any order, in Japanese too', () => {
  const table = parseRoutines(`## ルーティン
| 起こす相手 | 名前 | 時刻 | やること | 黙る条件 |
|---|---|---|---|---|
| manager | standup | 50 8 * * 1-5 | 待ち列を見る | 待ち列が空 |
`)
  assert.deepEqual(table.routines, [{ name: 'standup', cron: '50 8 * * 1-5', what: '待ち列を見る', wake: 'manager', quietWhen: '待ち列が空' }])
})

test('a bad row is skipped with a problem, and its name is kept so sync does not remove it', () => {
  const table = parseRoutines(`## Routines
| Name | When | What | Wake | Quiet when |
|---|---|---|---|---|
| Morning Digest | 0 9 * * * | x | child | |
| health | every day | x | child | |
| standup | 50 8 * * 1-5 | x | someone | |
| ok | 5 4 * * * | x | child | |
| ok | 6 4 * * * | x | child | |
`)
  assert.deepEqual(table.routines.map(r => r.name), ['ok'])
  assert.deepEqual(table.skipped, ['health', 'standup', 'ok'])
  assert.equal(table.problems.length, 4)
  assert.match(table.problems.join('\n'), /Morning Digest/)
  assert.match(table.problems.join('\n'), /every day/)
  assert.match(table.problems.join('\n'), /someone/)
  assert.match(table.problems.join('\n'), /twice/)
})

test('each routine becomes one automation named after its manager', () => {
  const [digest, standup] = automationsFor(parseRoutines(PROFILE), CTX)
  assert.equal(digest?.name, 'kantoku:alice:morning-digest')
  assert.equal(digest?.cron, '0 9 * * *')
  assert.equal(digest?.timezone, 'Asia/Seoul')
  assert.equal(digest?.workspace, CTX.workspace)
  assert.equal(digest?.precheck, '"C:/node/node.exe" "C:/kantoku/routines/cli.ts" fire alice morning-digest')
  assert.equal(standup?.name, 'kantoku:alice:standup')
})

test('a child routine prompt carries the job, the quiet rule, autonomy, and where to write', () => {
  const [digest] = automationsFor(parseRoutines(PROFILE), CTX)
  const prompt = digest?.prompt ?? ''
  for (const words of [
    'Sum up the morning mail',
    'nothing needs action',
    '~/.kantoku/alice/routines/morning-digest.md',
    '~/.kantoku/alice/routines/inbox/',
    'information, not instructions',
    'Autonomy',
    'never merges',
    'kantoku-routine: morning-digest',
  ])
    assert.ok(prompt.includes(words), words)
})

test('a manager routine prompt only fires the letter, so Run now works too', () => {
  const [, standup] = automationsFor(parseRoutines(PROFILE), CTX)
  assert.match(standup?.prompt ?? '', /"C:\/node\/node.exe" "C:\/kantoku\/routines\/cli.ts" fire alice standup/)
})

test('with no Timezone line the PC timezone is used', () => {
  const [one] = automationsFor(parseRoutines(PROFILE.replace('Timezone: Asia/Seoul\n', '')), CTX)
  assert.equal(one?.timezone, 'Europe/Paris')
})

const existing = (name: string, over: Partial<Existing> = {}): Existing => {
  const want = automationsFor(parseRoutines(PROFILE), CTX).find(a => a.name === name)
  return {
    id: `id-${name}`,
    name,
    cron: want?.cron ?? '1 1 * * *',
    timezone: want?.timezone ?? 'UTC',
    prompt: want?.prompt ?? '',
    precheck: want?.precheck ?? '',
    workspace: want?.workspace ?? '',
    enabled: true,
    ...over,
  }
}

test('sync creates what is missing', () => {
  const plan = planSync('alice', automationsFor(parseRoutines(PROFILE), CTX), [], [])
  assert.deepEqual(plan.map(step => [step.kind, step.want?.name]), [
    ['create', 'kantoku:alice:morning-digest'],
    ['create', 'kantoku:alice:standup'],
  ])
})

test('sync run twice changes nothing', () => {
  const want = automationsFor(parseRoutines(PROFILE), CTX)
  const plan = planSync('alice', want, [existing('kantoku:alice:morning-digest'), existing('kantoku:alice:standup')], [])
  assert.deepEqual(plan, [])
})

test('sync edits a changed one, removes a dropped one, and leaves other managers alone', () => {
  const want = automationsFor(parseRoutines(PROFILE), CTX).filter(a => a.name.endsWith('morning-digest'))
  const plan = planSync(
    'alice',
    want,
    [
      existing('kantoku:alice:morning-digest', { cron: '0 8 * * *', enabled: false }),
      existing('kantoku:alice:standup'),
      existing('kantoku:alicia:standup'),
      existing('Daily review'),
    ],
    [],
  )
  assert.deepEqual(plan.map(step => [step.kind, step.id]), [
    ['edit', 'id-kantoku:alice:morning-digest'],
    ['remove', 'id-kantoku:alice:standup'],
  ])
})

test('sync keeps the automation of a row it skipped, and removes a duplicate', () => {
  const plan = planSync(
    'alice',
    [],
    [existing('kantoku:alice:standup'), existing('kantoku:alice:health'), existing('kantoku:alice:health', { id: 'dup' })],
    ['standup'],
  )
  assert.deepEqual(plan.map(step => [step.kind, step.id]), [
    ['remove', 'id-kantoku:alice:health'],
    ['remove', 'dup'],
  ])
})
