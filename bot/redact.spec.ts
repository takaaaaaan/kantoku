import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact } from './redact.ts'

const repeat = (chars: string, n: number) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n)

// Sample secrets are put together at run time, so no file holds one in a single
// piece (secret scanners flag even these made-up values).
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.')
const SLACK = ['xoxb', '123', '456', 'abc'].join('-')
const PEM_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ')

test('token-like strings become [hidden]', () => {
  const secrets = [
    'ghp_' + repeat('aB3', 36),
    'gho_' + repeat('aB3', 36),
    'github_pat_' + repeat('aB3_', 80),
    'sk-' + repeat('aB3', 40),
    'sk-ant-api03-' + repeat('aB3-', 60),
    SLACK,
    'AKIA' + repeat('A1', 16),
    repeat('0123456789abcdef', 32),
    repeat('0123456789abcdef', 64),
    repeat('0123456789abcdef', 41),
    repeat('Ab3+/', 44),
    JWT,
  ]
  for (const secret of secrets) assert.equal(redact(`before ${secret} after`), 'before [hidden] after', secret)
})

const SHA = '7a485f67aa8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d'

test('a 40-hex commit id is shown short, not hidden', () => {
  assert.equal(SHA.length, 40)
  assert.equal(redact(`${SHA} で merge`), '7a485f6 で merge')
  assert.equal(redact(`merged as ${SHA.toUpperCase()}.`), 'merged as 7A485F6.')
  assert.equal(redact(`(${SHA})`), '(7a485f6)')
})

test('GitHub commit and PR links stay whole', () => {
  for (const text of [
    `https://github.com/owner/repo/commit/${SHA}`,
    `see [the commit](https://github.com/owner/repo/commit/${SHA}) please`,
    `https://github.com/owner/repo/pull/131/commits/${SHA}`,
    'https://github.com/owner/repo/pull/131',
    `https://github.com/owner/repo/blob/${SHA}/README.md#L10`,
    `https://github.com/owner/repo/tree/${SHA}/bot`,
    `github.com/owner/repo/commit/${SHA}`,
  ])
    assert.equal(redact(text), text)
})

test('a token inside a URL is still hidden', () => {
  assert.equal(redact(`https://example.com/hook?token=abc123`), 'https://example.com/hook?token=[hidden]')
  assert.equal(redact(`https://x.example/${'ghp_' + repeat('aB3', 36)}`), 'https://x.example/[hidden]')
  assert.equal(redact(`https://x.example/${repeat('0123456789abcdef', 64)}`), 'https://x.example/[hidden]')
})

test('a 40-hex run in a URL is hidden unless it follows a commit path', () => {
  assert.equal(redact(`https://${SHA}@github.com/o/r.git`), 'https://[hidden]@github.com/o/r.git')
  assert.equal(redact(`https://api.example.com/v1/x?id=${SHA}`), 'https://api.example.com/v1/x?id=[hidden]')
  assert.equal(redact(`https://x.example/files/${SHA}`), 'https://x.example/files/[hidden]')
})

test('a URL given as a secret value is hidden whole', () => {
  assert.equal(redact('webhook token: https://hooks.example.com/services/T0AB/B0CD/xYz123abcDEF456'), 'webhook token: [hidden]')
  assert.equal(redact('secret: "https://hooks.example.com/services/T0AB"'), 'secret: [hidden]')
})

test('keys named in a query or a fragment are hidden', () => {
  assert.equal(redact(`https://api.example.com/x?application_key=${SHA}`), 'https://api.example.com/x?application_key=[hidden]')
  assert.equal(redact('https://x.example/cb#access_token=abc.def'), 'https://x.example/cb#access_token=[hidden]')
  assert.equal(redact('client_secret=s3cr3t'), 'client_secret=[hidden]')
})

test('a random run right after = is hidden', () => {
  const run = repeat('AbCdEf123xyZ', 48)
  assert.equal(redact(`https://x.example/q?sig=${run}`), 'https://x.example/q?sig=[hidden]')
  assert.equal(redact(`https://x.example/cb#data=${run}`), 'https://x.example/cb#data=[hidden]')
})

test('base64 with / inside a URL is hidden, but a path is not', () => {
  assert.equal(redact(`https://x.example/${repeat('Ab3+/', 50)}`), 'https://x.example/[hidden]')
  assert.equal(redact(`https://x.example/${repeat('aB3dEfG4hIjK5', 22)}/${repeat('mN6oPqR7sTuV8', 22)}`), 'https://x.example/[hidden]')
  for (const text of ['https://github.com/OwnerName/RepoName/blob/main/docs/README.md', 'https://example.com/Docs/Getting-Started/Install2/Windows11/Setup'])
    assert.equal(redact(text), text)
})

test('a PEM private key block', () => {
  const pem = `-----BEGIN ${PEM_LABEL}-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END ${PEM_LABEL}-----`
  assert.equal(redact(`key:\n${pem}\nend`), 'key:\n[hidden]\nend')
})

test('password lines keep the label', () => {
  assert.equal(redact('password: hunter2'), 'password: [hidden]')
  assert.equal(redact('Password = "hunter2" ok'), 'Password = [hidden] ok')
  assert.equal(redact('パスワード: hunter2'), 'パスワード: [hidden]')
  assert.equal(redact('パスワード：ひみつ'), 'パスワード：[hidden]')
  assert.equal(redact('api_key=abc123'), 'api_key=[hidden]')
  assert.equal(redact('token: abc'), 'token: [hidden]')
})

test('Orca IDs are hidden', () => {
  assert.equal(redact('run_bd2e02c71952 ctx_301941525dc2 task_7ef693496e83'), '[hidden] [hidden] [hidden]')
  assert.equal(redact('term_8a806107-2461-4b5f-a829-ef822090f612'), '[hidden]')
})

test('ordinary text is unchanged', () => {
  for (const text of [
    'PR #131',
    'SHA 9ddeb65',
    'commit 9ddeb65a1b2c',
    'https://github.com/owner/repo/pull/131',
    '2026-11-19 21:40',
    'パスワードを変える画面を直した',
    'the password reset page',
    'skill-creator:skill-creator',
    'bot/fixtures/home/Mochi',
    'ask q-0418',
    'd-20261119-213501-7f3a',
    '2026-11-19T21:35:01+09:00',
    'Internationalization and localization are different words',
    'issue #1234, version 0.4.0, port 4870',
    'https://example.com/docs/getting-started?lang=ja#install',
    'deadbeef cafebabe',
  ])
    assert.equal(redact(text), text)
})
