// Spike: spawn a detached node that runs `orca orchestration send` with a pruned env.
// usage: node send-detached.mjs <keepMode: none|minimal> <to> <subject> <logfile>
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
const [mode, to, subject, log] = process.argv.slice(2)
const keep = mode === 'minimal' ? new Set(['ORCA_USER_DATA_PATH', 'ORCA_RUNTIME_SOURCE_PROFILE_PATH', 'ORCA_RUNTIME_SOURCE_ID', 'ORCA_RUNTIME_SOURCE_INCARNATION', 'ORCA_APP_VERSION']) : new Set()
const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORCA_') || keep.has(k)) env[k] = v
const inner = `
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const out = []
out.push('pid=' + process.pid + ' orcaVars=' + Object.keys(process.env).filter(k => k.startsWith('ORCA_')).join(','))
try {
  const r = execFileSync('orca', ['orchestration','send','--to',${JSON.stringify(to)},'--type','status','--subject',${JSON.stringify(subject)},'--body','spike from detached process','--json'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })
  out.push('exit=0 ' + r)
} catch (e) { out.push('exit=' + e.status + ' stdout=' + e.stdout + ' stderr=' + e.stderr) }
fs.writeFileSync(${JSON.stringify(log)}, out.join(' | '))
`
const c = spawn(process.execPath, ['-e', inner], { detached: true, stdio: ['ignore', openSync(log + '.out', 'w'), openSync(log + '.err', 'w')], env, windowsHide: true })
c.unref()
console.log('spawned', c.pid)
