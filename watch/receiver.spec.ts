import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { startReceiver } from './receiver.ts'

const secret = 'test-secret'
const sign = (body: string, key = secret) => 'sha256=' + createHmac('sha256', key).update(body).digest('hex')

async function withReceiver(fn: (base: string, calls: { deliveries: unknown[][]; shutdowns: number }, address: string) => Promise<void>) {
  const calls = { deliveries: [] as unknown[][], shutdowns: 0 }
  const receiver = await startReceiver({
    secret,
    onDelivery: (event, id, payload) => calls.deliveries.push([event, id, payload]),
    onShutdown: () => calls.shutdowns++,
  })
  try {
    await fn(`http://127.0.0.1:${receiver.port}`, calls, receiver.address)
  } finally {
    await receiver.close()
  }
}

const post = (url: string, body: string, headers: Record<string, string>) =>
  fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })

test('a good signature is accepted and passed on', async () => {
  await withReceiver(async (base, calls, address) => {
    assert.equal(address, '127.0.0.1')
    const body = JSON.stringify({ action: 'created', n: 'é' })
    const res = await post(`${base}/webhook`, body, { 'x-github-event': 'issue_comment', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(body) })
    assert.equal(res.status, 202)
    assert.deepEqual(calls.deliveries, [['issue_comment', 'd-1', { action: 'created', n: 'é' }]])
  })
})

test('a wrong or missing signature is rejected', async () => {
  await withReceiver(async (base, calls) => {
    const body = '{"a":1}'
    assert.equal((await post(`${base}/webhook`, body, { 'x-github-event': 'x', 'x-github-delivery': 'd', 'x-hub-signature-256': sign(body, 'other') })).status, 401)
    assert.equal((await post(`${base}/webhook`, body, { 'x-github-event': 'x', 'x-github-delivery': 'd', 'x-hub-signature-256': 'sha256=00' })).status, 401)
    assert.equal((await post(`${base}/webhook`, body, { 'x-github-event': 'x', 'x-github-delivery': 'd' })).status, 401)
    assert.equal(calls.deliveries.length, 0)
  })
})

test('a signed body that is not JSON is refused', async () => {
  await withReceiver(async (base, calls) => {
    const body = 'not json'
    assert.equal((await post(`${base}/webhook`, body, { 'x-github-event': 'x', 'x-github-delivery': 'd', 'x-hub-signature-256': sign(body) })).status, 400)
    assert.equal(calls.deliveries.length, 0)
  })
})

test('/shutdown needs the secret header', async () => {
  await withReceiver(async (base, calls) => {
    assert.equal((await post(`${base}/shutdown`, '', {})).status, 401)
    assert.equal((await post(`${base}/shutdown`, '', { 'x-kantoku-watch-secret': 'wrong' })).status, 401)
    assert.equal(calls.shutdowns, 0)
    assert.equal((await post(`${base}/shutdown`, '', { 'x-kantoku-watch-secret': secret })).status, 202)
    assert.equal(calls.shutdowns, 1)
  })
})

test('other paths are 404', async () => {
  await withReceiver(async base => {
    assert.equal((await fetch(`${base}/`)).status, 404)
  })
})
