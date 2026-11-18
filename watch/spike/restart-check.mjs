// Spike: start one forwarder while a stale hook exists, log its output for 15 s, then child.kill().
import { spawn, execFileSync } from 'node:child_process'
const [repo, events] = process.argv.slice(2)
const hooks = () => execFileSync('gh', ['api', `repos/${repo}/hooks`, '--jq', '[.[] | {id, url: .config.url, events}]'], { encoding: 'utf8' }).trim()
console.log('before', hooks())
const c = spawn('gh', ['webhook', 'forward', '--repo', repo, `--events=${events}`, '--url', 'http://127.0.0.1:18999/webhook'], { stdio: ['ignore', 'pipe', 'pipe'] })
c.stdout.on('data', d => console.log('out:', d.toString().trim().split('\n')[0]))
c.stderr.on('data', d => console.log('err:', d.toString().trim().split('\n').slice(0, 2).join(' / ')))
c.on('exit', (code, sig) => console.log('exit', code, sig))
await new Promise(r => setTimeout(r, 15000))
console.log('during', hooks())
if (c.exitCode === null) c.kill()
await new Promise(r => setTimeout(r, 3000))
console.log('after kill', hooks())
