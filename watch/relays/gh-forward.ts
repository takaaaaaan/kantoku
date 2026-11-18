// Stage 1 relay: one `gh webhook forward` per repo, POSTing to the local receiver.
// GitHub drops the temporary hook when the forwarder's connection closes, so
// stopping means ending the process tree (on Windows, `gh.exe` has a child
// `gh-webhook.exe` that keeps forwarding if only the parent is killed).

import { spawn as nodeSpawn, execFile } from 'node:child_process'
import type { Trouble } from '../events.ts'
import type { Relay } from '../relay.ts'
import type { Run } from '../run.ts'

export const EVENTS = 'check_suite,status,pull_request_review,issue_comment,pull_request'
const CONNECTED = 'Forwarding Webhook events from GitHub'
const NO_ADMIN = /error creating webhook: HTTP 404/
const ALREADY = /Hook already exists on this repository/
const STDERR_KEEP = 4000

export type Proc = {
  onExit(cb: (code: number | null, stderr: string) => void): void
  onStderr(cb: (text: string) => void): void
  kill(): void
}
export type Spawn = (cmd: string, args: string[]) => Proc

export const realSpawn: Spawn = (cmd, args) => {
  const windows = process.platform === 'win32'
  const child = nodeSpawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], detached: !windows })
  let stderr = ''
  const stderrListeners: ((text: string) => void)[] = []
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (text: string) => {
    stderr = (stderr + text).slice(-STDERR_KEEP)
    for (const cb of stderrListeners) cb(text)
  })
  const exitListeners: ((code: number | null, stderr: string) => void)[] = []
  let exited = false
  const done = (code: number | null) => {
    if (exited) return
    exited = true
    for (const cb of exitListeners) cb(code, stderr)
  }
  child.on('close', code => done(code))
  child.on('error', error => {
    stderr += String(error.message)
    done(null)
  })

  return {
    onExit: cb => exitListeners.push(cb),
    onStderr: cb => stderrListeners.push(cb),
    kill: () => {
      if (child.pid === undefined || exited) return
      if (windows) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
      else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
    },
  }
}

// A forwarder that hit no-admin, already-exists, or gave up stays in the map
// with no process, so `sync` does not start it again until the repo leaves the set.
type Forwarder = { proc: Proc | undefined; attempts: number; timer: NodeJS.Timeout | undefined }

export function ghForwardRelay(opts: { spawn: Spawn; run: Run; url: string; secret: string; delays?: number[] }): Relay {
  const delays = opts.delays ?? [5000, 30000, 120000]
  const forwarders = new Map<string, Forwarder>()
  const connected: ((repo: string) => void)[] = []
  const troubled: ((repo: string, problem: Trouble, detail: string) => void)[] = []
  const trouble = (repo: string, problem: Trouble, detail: string) => {
    for (const cb of troubled) cb(repo, problem, detail)
  }

  const start = (repo: string, f: Forwarder) => {
    f.timer = undefined
    const proc = opts.spawn('gh', ['webhook', 'forward', '--repo', repo, '--events', EVENTS, '--url', opts.url, '--secret', opts.secret])
    f.proc = proc
    let tail = ''
    let isConnected = false
    proc.onStderr(text => {
      tail = (tail + text).slice(-(CONNECTED.length + text.length))
      if (isConnected || !tail.includes(CONNECTED)) return
      isConnected = true
      f.attempts = 0
      for (const cb of connected) cb(repo)
    })
    proc.onExit((_code, stderr) => {
      if (forwarders.get(repo) !== f || f.proc !== proc) return
      f.proc = undefined
      const detail = stderr.trim()
      if (NO_ADMIN.test(stderr)) {
        trouble(repo, 'no-admin', detail)
      } else if (ALREADY.test(stderr)) {
        trouble(repo, 'forwarder-exited', detail)
      } else if (f.attempts < delays.length) {
        f.timer = setTimeout(() => start(repo, f), delays[f.attempts++])
      } else {
        trouble(repo, 'forwarder-gave-up', detail)
      }
    })
  }

  const end = (repo: string) => {
    const f = forwarders.get(repo)
    forwarders.delete(repo)
    if (f?.timer !== undefined) clearTimeout(f.timer)
    f?.proc?.kill()
  }

  return {
    name: 'gh-webhook-forward',
    preflight: async () => {
      try {
        if ((await opts.run('gh', ['--version'])).code !== 0) return ['gh-missing']
      } catch {
        return ['gh-missing']
      }
      const problems: Trouble[] = []
      const auth = await opts.run('gh', ['auth', 'status'])
      if (auth.code !== 0) problems.push('gh-not-logged-in')
      else {
        const text = auth.stdout + auth.stderr
        const active = text.slice(Math.max(0, text.indexOf('Active account: true')))
        const scopes = /Token scopes:(.*)/.exec(active)?.[1]
        if (scopes !== undefined && !/'(repo|admin:repo_hook)'/.test(scopes)) problems.push('scope-missing')
      }
      const ext = await opts.run('gh', ['extension', 'list'])
      if (!/\bcli\/gh-webhook\b/.test(ext.stdout)) problems.push('extension-missing')

      return problems
    },
    sync: async repos => {
      const wanted = new Set(repos.map(repo => repo.toLowerCase()))
      for (const repo of [...forwarders.keys()]) if (!wanted.has(repo)) end(repo)
      for (const repo of wanted) {
        if (forwarders.has(repo)) continue
        const f: Forwarder = { proc: undefined, attempts: 0, timer: undefined }
        forwarders.set(repo, f)
        start(repo, f)
      }
    },
    stop: async () => {
      for (const repo of [...forwarders.keys()]) end(repo)
    },
    onConnected: cb => {
      connected.push(cb)
    },
    onTrouble: cb => {
      troubled.push(cb)
    },
  }
}
