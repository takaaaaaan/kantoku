// Test helper: raw HTTP calls (fetch cannot set Host) and a page folder.
import { request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export function portOf(server: Server): number {
  return (server.address() as AddressInfo).port
}

export function call(server: Server, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const port = portOf(server)
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

export function makePageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kantoku-bot-page-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta name="bot-token" content="__BOT_TOKEN__"><title>bot</title>')
  writeFileSync(join(dir, 'bot.js'), 'export {}')
  writeFileSync(join(dir, 'links.js'), 'export {}')
  writeFileSync(join(dir, 'bot.css'), 'body{}')
  return dir
}
