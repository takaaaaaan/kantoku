// The local HTTP server that relays POST GitHub deliveries to. It listens on
// 127.0.0.1 only and accepts a delivery only with a valid X-Hub-Signature-256.
// POST /shutdown (with the secret) lets `stop` end the daemon on every OS.
// POST /ping (with the secret) answers 204, so `status` can tell this daemon from a reused pid.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_BODY = 25 * 1024 * 1024

export type ReceiverOptions = {
  secret: string
  onDelivery: (event: string, deliveryId: string, payload: unknown) => void
  onShutdown: () => void
}

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)

  return x.length === y.length && timingSafeEqual(x, y)
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY) chunks.push(chunk)
    })
    req.on('end', () => resolve(size <= MAX_BODY ? Buffer.concat(chunks) : undefined))
    req.on('error', () => resolve(undefined))
  })
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name]

  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export async function startReceiver(opts: ReceiverOptions): Promise<{ port: number; address: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const reply = (status: number) => res.writeHead(status).end()
    if (req.method !== 'POST' || (req.url !== '/webhook' && req.url !== '/shutdown' && req.url !== '/ping')) return reply(404)
    const body = await readBody(req)
    if (body === undefined) return reply(413)

    if (req.url === '/ping') return reply(sameText(header(req, 'x-kantoku-watch-secret'), opts.secret) ? 204 : 401)

    if (req.url === '/shutdown') {
      if (!sameText(header(req, 'x-kantoku-watch-secret'), opts.secret)) return reply(401)
      reply(202)

      return opts.onShutdown()
    }

    const expected = 'sha256=' + createHmac('sha256', opts.secret).update(body).digest('hex')
    if (!sameText(header(req, 'x-hub-signature-256'), expected)) return reply(401)
    let payload: unknown
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      return reply(400)
    }
    reply(202)
    opts.onDelivery(header(req, 'x-github-event'), header(req, 'x-github-delivery'), payload)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port, address } = server.address() as AddressInfo

  return {
    port,
    address,
    close: () => new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
