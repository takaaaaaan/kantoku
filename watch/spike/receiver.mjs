// Spike: tiny receiver that logs delivery headers and checks the HMAC.
// usage: node receiver.mjs <port> <secret> <logfile>
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const [port, secret, log] = process.argv.slice(2)
createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const sig = req.headers['x-hub-signature-256'] ?? ''
    const want = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const ok = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))
    let action = ''
    try { action = JSON.parse(body.toString()).action ?? '' } catch {}
    appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), path: req.url, event: req.headers['x-github-event'], delivery: req.headers['x-github-delivery'], hasSig256: !!req.headers['x-hub-signature-256'], hasSig1: !!req.headers['x-hub-signature'], sigOk: ok, action, headerNames: Object.keys(req.headers) }) + '\n')
    res.writeHead(200).end('ok')
  })
}).listen(Number(port), '127.0.0.1', () => console.log('listening', port))
