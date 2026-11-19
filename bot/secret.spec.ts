import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECIPES, buildCommand, commandText, parseSecretRequests, runSecret, secretItems } from './secret.ts'
import type { Spawned } from './secret.ts'
import { countRecipe } from './testing.ts'
import type { Entry } from './types.ts'

const DUMMY = 'dummy-ｶﾅ-ü-123456'

// ---------- the recipe table ----------

test('the shipped recipes are the three gh secret set forms', () => {
  assert.deepEqual(Object.keys(RECIPES).sort(), ['gh-secret-env', 'gh-secret-org', 'gh-secret-repo'])
})

test('each recipe builds its fixed gh argv', () => {
  const cases: [Record<string, string>, string[]][] = [
    [{ recipe: 'gh-secret-repo', name: 'VERCEL_TOKEN', repo: 'octo/app' }, ['secret', 'set', 'VERCEL_TOKEN', '--repo', 'octo/app']],
    [{ recipe: 'gh-secret-org', name: 'NPM_TOKEN', org: 'octo-org', visibility: 'private' }, ['secret', 'set', 'NPM_TOKEN', '--org', 'octo-org', '--visibility', 'private']],
    [{ recipe: 'gh-secret-env', name: 'API_KEY', repo: 'octo/app', env: 'production' }, ['secret', 'set', 'API_KEY', '--repo', 'octo/app', '--env', 'production']],
  ]
  for (const [target, args] of cases) assert.deepEqual(buildCommand(target), { ok: true, command: { file: 'gh', args } }, target.recipe)
})

test('a recipe that is not in the table builds nothing', () => {
  for (const recipe of ['gh', 'sh', 'vercel-env', 'sops-set', 'constructor', '__proto__', 'toString', ''])
    assert.equal(buildCommand({ recipe, name: 'A' }).ok, false, recipe)
  for (const target of [null, 'gh secret set A', ['gh-secret-repo'], 5, { name: 'A', repo: 'o/r' }]) assert.equal(buildCommand(target).ok, false, JSON.stringify(target))
})

test('missing, extra or non-text fields build nothing', () => {
  const bad = [
    { recipe: 'gh-secret-repo', name: 'A' },
    { recipe: 'gh-secret-repo', name: 'A', repo: 'o/r', body: 'x' },
    { recipe: 'gh-secret-repo', name: 'A', repo: 'o/r', args: ['--body', 'x'] },
    { recipe: 'gh-secret-repo', name: 'A', repo: ['o/r'] },
    { recipe: 'gh-secret-repo', name: 1, repo: 'o/r' },
  ]
  for (const target of bad) assert.equal(buildCommand(target).ok, false, JSON.stringify(target))
})

test('symbols in a name, repo, org or env build nothing', () => {
  const hostile = ['A;rm -rf ~', 'A && curl x', '$(whoami)', '`id`', 'A|B', 'A B', 'A\nB', '-A', '--body=x', 'a"b', "a'b", 'A>f', 'Ａ', '', 'x'.repeat(300)]
  for (const value of hostile) {
    assert.equal(buildCommand({ recipe: 'gh-secret-repo', name: value, repo: 'o/r' }).ok, false, `name ${value}`)
    assert.equal(buildCommand({ recipe: 'gh-secret-repo', name: 'A', repo: `o/${value}` }).ok, false, `repo o/${value}`)
    assert.equal(buildCommand({ recipe: 'gh-secret-repo', name: 'A', repo: `${value}/r` }).ok, false, `repo ${value}/r`)
    assert.equal(buildCommand({ recipe: 'gh-secret-org', name: 'A', org: value, visibility: 'all' }).ok, false, `org ${value}`)
    assert.equal(buildCommand({ recipe: 'gh-secret-env', name: 'A', repo: 'o/r', env: value }).ok, false, `env ${value}`)
  }
  for (const repo of ['o/r/x', 'o', '/r', 'o/', '-o/r', 'o/-r', 'o/..', '../r'])
    assert.equal(buildCommand({ recipe: 'gh-secret-repo', name: 'A', repo }).ok, false, repo)
  assert.equal(buildCommand({ recipe: 'gh-secret-org', name: 'A', org: 'o', visibility: 'public' }).ok, false)
  assert.equal(buildCommand({ recipe: 'gh-secret-repo', name: 'lower', repo: 'o/r' }).ok, false)
})

test('the command text is the argv joined with spaces', () => {
  assert.equal(commandText({ file: 'gh', args: ['secret', 'set', 'A', '--repo', 'o/r'] }), 'gh secret set A --repo o/r')
})

// ---------- requests ----------

const AT = '2026-11-19T10:00:00+09:00'
const line = (value: unknown) => JSON.stringify(value) + '\n'
const request = (extra: Record<string, unknown> = {}) => ({
  id: 's-1',
  at: AT,
  label: 'Vercel token',
  description: 'Paste the token',
  target: { recipe: 'gh-secret-repo', name: 'VERCEL_TOKEN', repo: 'octo/app' },
  ...extra,
})

test('a request reads into its command and expiry', () => {
  const [r] = parseSecretRequests(line(request()))
  assert.deepEqual(r, {
    id: 's-1',
    at: AT,
    label: 'Vercel token',
    description: 'Paste the token',
    expires: Date.parse(AT) + 30 * 60_000,
    command: { file: 'gh', args: ['secret', 'set', 'VERCEL_TOKEN', '--repo', 'octo/app'] },
  })
})

test('ttlMinutes sets the expiry within 1 to 120 minutes', () => {
  const [a, b, c] = parseSecretRequests(line(request({ id: 'a', ttlMinutes: 5 })) + line(request({ id: 'b', ttlMinutes: 999 })) + line(request({ id: 'c', ttlMinutes: 0 })))
  assert.equal(a?.expires, Date.parse(AT) + 5 * 60_000)
  assert.equal(b?.expires, Date.parse(AT) + 120 * 60_000)
  assert.equal(c?.expires, Date.parse(AT) + 60_000)
})

test('a request with a bad target is kept as refused, with a reason and no command', () => {
  const [r] = parseSecretRequests(line(request({ target: { recipe: 'gh-secret-repo', name: 'A;B', repo: 'o/r' } })))
  assert.equal(r?.command, undefined)
  assert.match(r?.reason ?? '', /name/)
})

test('an id written twice is refused both times, so a request cannot be swapped after it is shown', () => {
  const rs = parseSecretRequests(line(request()) + line(request({ target: { recipe: 'gh-secret-repo', name: 'B', repo: 'evil/app' } })))
  assert.equal(rs.length, 1)
  assert.equal(rs[0]?.command, undefined)
  assert.match(rs[0]?.reason ?? '', /twice/)
})

test('lines that are not requests are skipped', () => {
  const text = 'not json\n' + line({ id: 'bad id!', at: AT, label: 'x', target: {} }) + line({ id: 's-2', at: 'yesterday', label: 'x', target: {} }) + line([1]) + line(request())
  assert.deepEqual(parseSecretRequests(text).map(r => r.id), ['s-1'])
})

// ---------- cards ----------

const NOW = Date.parse(AT) + 60_000
const entry = (e: Partial<Entry> & { type: Entry['type'] }): Entry => ({ id: 'd-20261119-100100-0000', at: AT, ...e })

test('an open request is an open card with the full command', () => {
  const [card] = secretItems(parseSecretRequests(line(request())), [], NOW)
  assert.deepEqual(card, {
    kind: 'secret',
    at: new Date(Date.parse(AT)).toISOString(),
    id: 's-1',
    label: 'Vercel token',
    description: 'Paste the token',
    command: 'gh secret set VERCEL_TOKEN --repo octo/app',
    expires: new Date(Date.parse(AT) + 30 * 60_000).toISOString(),
    state: 'open',
  })
})

test('a failed run keeps the card open with its exit code; a run that exits 0 closes it', () => {
  const requests = parseSecretRequests(line(request()))
  const failed = [entry({ type: 'secret-done', request: 's-1', exit: 1 })]
  assert.deepEqual(pick(secretItems(requests, failed, NOW)[0]), { state: 'open', exit: 1 })
  assert.deepEqual(pick(secretItems(requests, [...failed, entry({ type: 'secret-done', request: 's-1', exit: 0 })], NOW)[0]), { state: 'done', exit: 0 })
})

test('a card past its expiry, or with a secret-expired entry, is expired', () => {
  const requests = parseSecretRequests(line(request({ ttlMinutes: 1 })))
  assert.equal(secretItems(requests, [], NOW + 1)[0]?.state, 'expired')
  assert.equal(secretItems(requests, [entry({ type: 'secret-expired', request: 's-1' })], NOW - 30_000)[0]?.state, 'expired')
})

test('a refused request is a refused card', () => {
  const [card] = secretItems(parseSecretRequests(line(request({ target: { recipe: 'curl' } }))), [], NOW)
  assert.equal(card?.state, 'refused')
  assert.equal(card?.command, '')
})

function pick(card: { state: string; exit?: number | null } | undefined) {
  return { state: card?.state, exit: card?.exit }
}

// ---------- running ----------

type Call = { file: string; args: string[]; opts: Record<string, unknown>; stdin: Buffer[] }

function fakeSpawn(exit: number | null, stderr = '') {
  const calls: Call[] = []
  const spawn = (file: string, args: string[], opts: Record<string, unknown>): Spawned => {
    const call: Call = { file, args, opts, stdin: [] }
    calls.push(call)
    let onClose: (code: number | null) => void = () => undefined
    return {
      stdin: {
        on: () => undefined,
        end: (chunk: string) => {
          call.stdin.push(Buffer.from(chunk, 'utf8'))
          setImmediate(() => onClose(exit))
        },
      },
      stderr: { on: (_: 'data', fn: (chunk: Buffer) => void) => fn(Buffer.from(stderr)) },
      on: (event: string, fn: (value: never) => void) => {
        if (event === 'close') onClose = fn as (code: number | null) => void
      },
    } as unknown as Spawned
  }
  return { calls, spawn }
}

test('the value goes to stdin only: not in the argv, the env, or a shell', async () => {
  const { calls, spawn } = fakeSpawn(0)
  const result = await runSecret({ file: 'gh', args: ['secret', 'set', 'A', '--repo', 'o/r'] }, DUMMY, { spawn })
  assert.deepEqual(result, { exit: 0 })
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.file, 'gh')
  assert.deepEqual(call.args, ['secret', 'set', 'A', '--repo', 'o/r'])
  assert.equal(call.opts.shell, false)
  assert.equal(call.opts.env, undefined, 'the child inherits the env unchanged')
  assert.equal(JSON.stringify(call.opts).includes(DUMMY), false)
  assert.deepEqual(Buffer.concat(call.stdin), Buffer.from(DUMMY, 'utf8'), 'exact bytes, no newline')
})

test('a failure gives the exit code and the first stderr line, never a line holding the value', async () => {
  assert.deepEqual(await runSecret({ file: 'gh', args: [] }, DUMMY, fakeSpawn(1, '\nHTTP 404: Not Found\nmore\n')), { exit: 1, note: 'HTTP 404: Not Found' })
  assert.deepEqual(await runSecret({ file: 'gh', args: [] }, DUMMY, fakeSpawn(1, `bad value ${DUMMY}\n`)), { exit: 1 })
})

test('a real child gets the exact bytes on stdin and nothing else', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kantoku-secret-')), 'count.json')
  const built = buildCommand({ recipe: 'count', exit: '0' }, { count: countRecipe(out) })
  assert.ok(built.ok)
  assert.deepEqual(await runSecret(built.command, DUMMY), { exit: 0 })
  const seen = readFileSync(out, 'utf8')
  assert.equal(seen.includes(DUMMY), false)
  assert.deepEqual(JSON.parse(seen), { bytes: Buffer.byteLength(DUMMY), argv: ['0'], envHasValue: false })
})

test('a missing program is a failed run with no exit code', async () => {
  assert.deepEqual(await runSecret({ file: 'kantoku-no-such-program', args: [] }, DUMMY), { exit: null, note: 'could not start kantoku-no-such-program' })
})

test('a program that runs past the time limit is stopped', async () => {
  const result = await runSecret({ file: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }, DUMMY, { timeoutMs: 300 })
  assert.equal(result.exit, null)
  assert.equal(result.note, 'stopped after 0.3 s')
})
