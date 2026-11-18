// Spike: run gh webhook forward into receiver.mjs, trigger a comment, start a 2nd forwarder, then child.kill().
// usage: node forward-driver.mjs <repo> <pr> <outdir>
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const [repo, pr, out] = process.argv.slice(2)
const log = m => { appendFileSync(out + '/driver.log', new Date().toISOString() + ' ' + m + '\n'); console.log(m) }
const wait = ms => new Promise(r => setTimeout(r, ms))
const secret = randomBytes(16).toString('hex')
const port = 18000 + Math.floor(Math.random() * 1000)
const events = 'check_suite,status,pull_request_review,issue_comment,pull_request'
const hooks = () => execFileSync('gh', ['api', `repos/${repo}/hooks`, '--jq', '[.[] | {id, url: .config.url, events, active}]'], { encoding: 'utf8' }).trim()
const startFwd = (name) => {
  const c = spawn('gh', ['webhook', 'forward', '--repo', repo, `--events=${events}`, '--url', `http://127.0.0.1:${port}/webhook`, '--secret', secret], { stdio: ['ignore', 'pipe', 'pipe'] })
  c.stdout.on('data', d => log(`${name} stdout: ${d.toString().trim()}`))
  c.stderr.on('data', d => log(`${name} stderr: ${d.toString().trim()}`))
  c.on('exit', (code, sig) => log(`${name} exit code=${code} signal=${sig}`))
  return c
}
const recv = spawn(process.execPath, ['receiver.mjs', String(port), secret, out + '/deliveries.jsonl'], { stdio: 'inherit' })
await wait(1000)
log('hooks before: ' + hooks())
const f1 = startFwd('fwd1')
await wait(8000)
log('hooks while fwd1 runs: ' + hooks())
execFileSync('gh', ['pr', 'comment', pr, '-R', repo, '--body', '[spike] kantoku-watch webhook test comment'], { stdio: 'inherit' })
log('comment posted')
await wait(10000)
const f2 = startFwd('fwd2')
await wait(10000)
log('hooks with fwd2 tried: ' + hooks())
if (f2.exitCode === null) { log('fwd2 still running, killing'); f2.kill() }
log('killing fwd1 with child.kill(), pid=' + f1.pid)
f1.kill()
await wait(5000)
log('hooks 5s after kill: ' + hooks())
await wait(25000)
log('hooks 30s after kill: ' + hooks())
recv.kill()
