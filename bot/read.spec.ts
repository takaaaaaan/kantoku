import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBots } from './read.ts'
import { makeHome } from './testing.ts'

const bot = async (root: string, name: string) => {
  const found = (await buildBots(root)).bots.find(b => b.name === name)
  assert.ok(found, name)
  return found
}

test('lists valid directories only, sorted waiting, working, asleep, then name', async () => {
  const view = await buildBots(makeHome())
  assert.deepEqual(
    view.bots.map(b => [b.name, b.status]),
    [
      ['Mochi', 'waiting'],
      ['Pico', 'working'],
      ['Empty', 'asleep'],
      ['Sora', 'asleep'],
    ],
  )
})

test('a missing root gives an empty list', async () => {
  assert.deepEqual(await buildBots(join(makeHome(), 'nope')), { bots: [], skills: [] })
})

test('waiting from an unanswered ask alone', async () => {
  const root = makeHome()
  const state = join(root, 'Mochi', 'state.md')
  writeFileSync(state, readFileSync(state, 'utf8').replace('user: どこで試すか', '-'))
  assert.equal((await bot(root, 'Mochi')).status, 'waiting')
})

test('an answered ask is not waiting', async () => {
  const root = makeHome()
  const state = join(root, 'Mochi', 'state.md')
  writeFileSync(state, readFileSync(state, 'utf8').replace('user: どこで試すか', '-'))
  appendFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), '\n{"id":"d-20261119-090000-2c2c","at":"2026-11-19T09:00:00+09:00","type":"answer","ask":"q-0418","text":"手元で試す","delivery":"sent"}\n')
  assert.equal((await bot(root, 'Mochi')).status, 'working')
})

test('talk merges reports and log by time', async () => {
  const mochi = await bot(makeHome(), 'Mochi')
  assert.deepEqual(
    mochi.talk.map(t => [t.kind, 'id' in t ? t.id : '']),
    [
      ['ask', 'q-0417'],
      ['mine', 'd-20261117-120000-1b1b'],
      ['report', ''],
      ['ask', 'q-0418'],
    ],
  )
  const [answered, said, , open] = mochi.talk
  assert.ok(answered?.kind === 'ask' && answered.answer === '新しい順')
  assert.ok(said?.kind === 'mine' && said.delivery === 'read')
  assert.ok(open?.kind === 'ask' && open.answer === undefined)
  assert.ok(mochi.talk.every(t => !Number.isNaN(Date.parse(t.at))))
})

test('delivery follows the log', async () => {
  const root = makeHome()
  const log = join(root, 'Sora', 'bot', 'from-user.jsonl')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(root, 'Sora', 'bot'))
  writeFileSync(log, '{"id":"d-1","at":"2026-11-19T09:00:00Z","type":"say","text":"a","delivery":"queued"}\n{"id":"d-2","at":"2026-11-19T09:01:00Z","type":"say","text":"b","delivery":"queued"}\n{"id":"d-2","at":"2026-11-19T09:02:00Z","type":"delivered"}\n')
  const talk = (await bot(root, 'Sora')).talk
  assert.deepEqual(talk.map(t => t.kind === 'mine' && t.delivery), ['queued', 'sent'])
})

test('line is the newest report, cut at 60 characters, else the status word', async () => {
  const root = makeHome()
  assert.equal((await bot(root, 'Mochi')).line, 'PR を出す前に、どこで試しますか?')
  assert.equal((await bot(root, 'Sora')).line, 'おやすみ中')
  assert.equal((await bot(root, 'Empty')).line, 'asleep')
  writeFileSync(join(root, 'Sora', 'reports.md'), `## 2026-11-18 10:00\n${'あ'.repeat(80)}\n二行目\n`)
  assert.equal((await bot(root, 'Sora')).line, 'あ'.repeat(59) + '…')
})

test('profile parts, memory, awake, language', async () => {
  const root = makeHome()
  const mochi = await bot(root, 'Mochi')
  assert.equal(mochi.description, '検索ページを元気に保つ係です。')
  assert.deepEqual(mochi.wontDo, ['ユーザーなしで merge しない', '本番に触らない'])
  assert.deepEqual(mochi.routines, [{ name: '朝の見回り', when: '毎日 9:00', what: '新しい issue を読む' }])
  assert.deepEqual(mochi.memory.map(m => [m.fact, m.date]), [
    ['テストは npm test で動く', '2026-11-10'],
    ['ユーザーは朝に返事をくれることが多い', undefined],
  ])
  assert.equal(mochi.language, 'ja')
  assert.equal(mochi.awake, true)
  assert.equal((await bot(root, 'Sora')).awake, false)
  assert.equal((await bot(root, 'Pico')).language, 'en')
  assert.deepEqual((await buildBots(root)).skills, ['issue-flow', 'repo-rules'])
})

test('files over 1 MB are skipped', async () => {
  assert.deepEqual((await bot(makeHome(), 'Pico')).memory, [])
})

test('version hashes change when profile.md changes', async () => {
  const root = makeHome()
  const before = (await bot(root, 'Mochi')).version
  appendFileSync(join(root, 'Mochi', 'profile.md'), '\n')
  const after = (await bot(root, 'Mochi')).version
  assert.notEqual(after.profile, before.profile)
  assert.equal(after.memory, before.memory)
  assert.match(after.profile, /^[0-9a-f]{64}$/)
})

test('no internal fields', async () => {
  const json = JSON.stringify(await buildBots(makeHome()))
  assert.doesNotMatch(json, /ctx_|task_[0-9a-f]|run_|term_|worktree|repo-internal|\/work\//)
})

test('secrets never reach kantoku bot', async () => {
  const root = makeHome()
  const token = 'ghp_' + 'aB3'.repeat(12)
  appendFileSync(join(root, 'Pico', 'reports.md'), `\n## 2026-11-18 22:00\nused ${token} by mistake\n`)
  appendFileSync(join(root, 'Mochi', 'bot', 'from-user.jsonl'), `\n{"id":"d-9","at":"2026-11-19T09:00:00Z","type":"say","text":"token ${token}","delivery":"sent"}\n`)
  appendFileSync(join(root, 'Mochi', 'memory.md'), `- password: hunter2\n`)
  const json = JSON.stringify(await buildBots(root))
  assert.doesNotMatch(json, /ghp_|hunter2/)
  assert.match(json, /\[hidden\]/)
})
