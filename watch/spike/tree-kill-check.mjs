// Spike: (a) two forwarders, same events, secrets A/A then A/B; (b) stop with taskkill /T /F and time hook removal.
import { spawn, execFileSync } from 'node:child_process'
const repo = process.argv[2]
const events = 'check_suite,status,pull_request_review,issue_comment,pull_request'
const wait = ms => new Promise(r => setTimeout(r, ms))
const hooks = () => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/hooks`], { encoding: 'utf8' })).map(h => h.id)
const start = (name, secret) => {
  const c = spawn('gh', ['webhook', 'forward', '--repo', repo, `--events=${events}`, '--url', 'http://127.0.0.1:18998/webhook', '--secret', secret], { stdio: ['ignore', 'pipe', 'pipe'] })
  c.stderr.on('data', d => console.log(name, 'err:', d.toString().trim().split('\n').slice(0, 2).join(' / ')))
  c.on('exit', code => console.log(name, 'exit', code))
  return c
}
const treeKill = c => { try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) { console.log('taskkill failed', e.status) } }
const a = start('A', 'secretA'); await wait(6000)
const a2 = start('A2-same-secret', 'secretA'); await wait(6000)
const b = start('B-other-secret', 'secretB'); await wait(6000)
console.log('hooks', hooks())
for (const c of [a, a2, b]) if (c.exitCode === null) treeKill(c)
const t0 = Date.now()
for (let i = 0; i < 12; i++) { const h = hooks(); console.log(`+${Math.round((Date.now() - t0) / 1000)}s hooks`, h); if (h.length === 0) break; await wait(5000) }
console.log('gh-webhook left:', execFileSync('tasklist', { encoding: 'utf8' }).split('\n').filter(l => /gh-webhook/i.test(l)).length)
process.exit(0)
