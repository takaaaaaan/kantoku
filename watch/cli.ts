// kantoku-watch commands: start, stop, status, catchup, run.
// `start` launches `run` as a detached process and returns; the daemon then
// stops itself when no watched PR is open for 10 minutes.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLock, catchUpOnce, createContext, handleDelivery, isApproved, log, login, readPrs, releaseLock, statusOf, tick, writeJson } from './daemon.ts'
import type { Status } from './daemon.ts'
import type { Trouble } from './events.ts'
import { startReceiver } from './receiver.ts'
import { ghForwardRelay, realSpawn } from './relays/gh-forward.ts'
import { realRun } from './run.ts'
import type { Run } from './run.ts'
import { prKey, readAllTargets } from './targets.ts'
import type { Relay } from './relay.ts'

export type CliDeps = {
  run: Run
  out: (line: string) => void
  sleep: (ms: number) => Promise<void>
  isAlive: (pid: number) => boolean
  spawnDaemon: (args: string[], env: Record<string, string | undefined>) => number | undefined
  post: (url: string, headers: Record<string, string>) => Promise<number>
}

type Env = Record<string, string | undefined>
type Paths = { home: string; stateRoot: string }

const USAGE = `usage: node watch/cli.ts start [--allow owner/repo ...]   start the daemon, or report the running one
       node watch/cli.ts stop                             stop it and its forwarders
       node watch/cli.ts status                           running?, repos, troubles
       node watch/cli.ts catchup                          one catch-up pass, no forwarding
       node watch/cli.ts run [--allow owner/repo ...]     the daemon itself, in the foreground`

const FIX: Partial<Record<Trouble, string>> = {
  'gh-missing': 'gh (GitHub CLI) is not installed. Ask the user to install it: https://cli.github.com',
  'gh-not-logged-in': 'gh is not logged in. Ask the user to run: gh auth login',
  'extension-missing': 'The gh extension cli/gh-webhook is missing. Ask the user before installing: gh extension install cli/gh-webhook',
  'scope-missing': 'The gh token lacks the admin:repo_hook scope. Ask the user to run: gh auth refresh -h github.com -s admin:repo_hook',
}

const FORWARDER_HOOK_URL = 'https://webhook-forwarder.github.com/hook'
const LOOP_MS = 15_000
const START_WAIT_MS = 10_000
const HEARTBEAT_MAX_MS = 2 * 60_000

const realDeps: CliDeps = {
  run: realRun,
  out: line => console.log(line),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  isAlive: pid => {
    try {
      process.kill(pid, 0)

      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  spawnDaemon: (args, env) => {
    if (process.platform === 'win32') return launchWindows(process.execPath, args)
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: env as NodeJS.ProcessEnv })
    child.unref()

    return child.pid
  },
  post: async (url, headers) => (await fetch(url, { method: 'POST', headers })).status,
}

function pathsOf(env: Env): Paths {
  // HOME first, like the manager panel (hooks/register.tsx), so both read the same ~/.kantoku.
  const base = env.HOME ?? env.USERPROFILE ?? homedir()

  return {
    home: env.KANTOKU_WATCH_HOME ?? join(base, '.kantoku-watch'),
    stateRoot: env.KANTOKU_HOME ?? join(base, '.kantoku'),
  }
}

type Flags = { allow: string[]; from?: string; home?: string; stateRoot?: string }

const FLAGS_OF: Record<string, string[]> = { start: ['--allow'], run: ['--allow', '--from', '--home', '--state-root'] }

function flagsOf(command: string | undefined, args: string[]): Flags | undefined {
  const known = FLAGS_OF[command ?? ''] ?? []
  const flags: Flags = { allow: [] }
  for (let at = 0; at < args.length; at += 2) {
    const [flag, value] = [args[at] ?? '', args[at + 1]]
    if (!known.includes(flag) || value === undefined || value.startsWith('--')) return undefined
    if (flag === '--allow') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) return undefined
      flags.allow.push(value.toLowerCase())
    } else if (flag === '--from') flags.from = value
    else if (flag === '--home') flags.home = value
    else flags.stateRoot = value
  }

  return flags
}

// A Windows command line for CreateProcess: every argument in double quotes.
// Arguments here are paths, repo names, and terminal handles, so a double quote
// or a trailing backslash (which would escape the closing quote) is refused.
export function windowsCommandLine(exe: string, args: string[]): string {
  return [exe, ...args].map(arg => {
    if (arg.includes('"') || arg.endsWith('\\')) throw new Error(`cannot quote argument: ${arg}`)

    return `"${arg}"`
  }).join(' ')
}

// On Windows, Orca ends every process of a worker's terminal when it releases
// the worker, even a detached one. A process created through WMI belongs to no
// terminal, so the daemon outlives the child that started it.
function launchWindows(exe: string, args: string[]): number | undefined {
  const line = windowsCommandLine(exe, args).replace(/'/g, "''")
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$si =New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${line}'; ProcessStartupInformation = $si }`,
    'if ($r.ReturnValue -ne 0) { exit 1 }',
    'Write-Output $r.ProcessId',
  ].join('; ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const pid = Number(out.trim())

  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export async function main(argv: string[], env: Env, given: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...realDeps, ...given }
  const [command, ...rest] = argv
  const flags = flagsOf(command, rest)
  if (flags === undefined) {
    deps.out(USAGE)

    return 1
  }
  const base = pathsOf(env)
  const paths = { home: flags.home ?? base.home, stateRoot: flags.stateRoot ?? base.stateRoot }
  const allow = flags.allow
  switch (command) {
    case 'start': return start(paths, allow, env, deps)
    case 'stop': return stop(paths, deps)
    case 'status': return status(paths, deps)
    case 'catchup': return catchupOnce(paths, deps, env.ORCA_TERMINAL_HANDLE)
    case 'run': return runDaemon(paths, allow, deps, flags.from)
    default:
      deps.out(USAGE)

      return 1
  }
}

async function readStatus(paths: Paths): Promise<Status | undefined> {
  try {
    const status = JSON.parse(await readFile(join(paths.home, 'status.json'), 'utf8'))

    return typeof status?.pid === 'number' ? status : undefined
  } catch {
    return undefined
  }
}

// Running means a live pid and a heartbeat (written every 15 s) under 2 minutes old,
// so a pid reused by another process after a crash does not count.
async function running(paths: Paths, deps: CliDeps): Promise<Status | undefined> {
  const status = await readStatus(paths)
  const fresh = status !== undefined && Date.now() - Date.parse(status.lastAliveAt) < HEARTBEAT_MAX_MS

  return status !== undefined && status.pid > 0 && fresh && deps.isAlive(status.pid) ? status : undefined
}

function printStatus(status: Status, deps: CliDeps) {
  deps.out(`kantoku-watch: running (pid ${status.pid}, port ${status.port})`)
  deps.out(`started: ${status.startedAt}  last alive: ${status.lastAliveAt}`)
  const repos = Object.entries(status.repos ?? {})
  if (repos.length === 0) deps.out('repos: none yet (the first round reads state.md within a few seconds; run status again)')
  for (const [repo, state] of repos) deps.out(`  ${repo}  ${state}`)
  for (const trouble of status.troubles ?? []) deps.out(`trouble: ${trouble}`)
}

async function ensureSecret(paths: Paths): Promise<string> {
  const file = join(paths.home, 'secret')
  try {
    const secret = (await readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(secret)) return secret
  } catch {}
  await mkdir(paths.home, { recursive: true })
  const secret = randomBytes(32).toString('hex')
  await writeFile(file, secret, { mode: 0o600 })

  return secret
}

async function preflight(deps: CliDeps): Promise<boolean> {
  const relay = ghForwardRelay({ spawn: realSpawn, run: deps.run, url: '', secret: '' })
  const problems = await relay.preflight()
  for (const problem of problems) deps.out(`cannot start: ${FIX[problem] ?? problem}`)

  return problems.length === 0
}

async function start(paths: Paths, allow: string[], env: Env, deps: CliDeps): Promise<number> {
  const live = await running(paths, deps)
  if (live !== undefined && allow.length === 0) {
    deps.out(`kantoku-watch: already running (pid ${live.pid})`)
    printStatus(live, deps)

    return 0
  }
  if (!(await preflight(deps))) return 2
  // An approval is given per start, so a running daemon restarts to take --allow.
  if (live !== undefined) {
    deps.out(`kantoku-watch: restarting pid ${live.pid} to apply --allow`)
    if (!(await shutdown(paths, live, deps))) return 1
  }
  await ensureSecret(paths)

  const me = await login(deps.run)
  const prs = await readPrs(join(paths.home, 'prs.json'))
  const repos = new Set((await readAllTargets(paths.stateRoot)).filter(t => prs[prKey(t.pr)]?.closedAt === undefined).map(t => t.pr.repo))
  for (const repo of [...repos].sort()) if (!isApproved({ me, allow: new Set(allow) }, repo)) deps.out(`needs approval: ${repo}`)

  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('ORCA_')))
  const cli = fileURLToPath(import.meta.url)
  const from = env.ORCA_TERMINAL_HANDLE
  const args = [cli, 'run', '--home', paths.home, '--state-root', paths.stateRoot, ...(from ? ['--from', from] : []), ...allow.flatMap(repo => ['--allow', repo])]
  let pid: number | undefined
  try {
    pid = deps.spawnDaemon(args, childEnv)
  } catch (error) {
    deps.out(`kantoku-watch: could not launch the daemon: ${String(error)}`)

    return 1
  }
  for (let waited = 0; pid !== undefined && waited <= START_WAIT_MS; waited += 250) {
    const status = await readStatus(paths)
    if (status?.pid === pid) {
      printStatus(status, deps)

      return 0
    }
    if (!deps.isAlive(pid)) break
    await deps.sleep(250)
  }
  deps.out(`kantoku-watch: did not start. See ${join(paths.home, 'watch.log')}`)

  return 1
}

async function stop(paths: Paths, deps: CliDeps): Promise<number> {
  const live = await running(paths, deps)
  if (live === undefined) {
    deps.out('kantoku-watch: not running')

    return 0
  }
  if (!(await shutdown(paths, live, deps))) return 1
  deps.out('kantoku-watch: stopped')

  // GitHub drops a forwarder's hook when its connection closes. List any left behind; deleting is the user's call.
  await deps.sleep(2000)
  for (const [repo, state] of Object.entries(live.repos ?? {})) {
    if (state === 'needs-approval' || state === 'failed') continue
    const result = await deps.run('gh', ['api', `repos/${repo}/hooks`, '--jq', `[.[] | select(.config.url == "${FORWARDER_HOOK_URL}") | .id]`])
    const ids = result.code === 0 ? (JSON.parse(result.stdout || '[]') as number[]) : []
    for (const id of ids) deps.out(`leftover forwarder hook on ${repo}: id ${id} (gh api -X DELETE repos/${repo}/hooks/${id} if no other forwarder of yours is running)`)
  }

  return 0
}

async function shutdown(paths: Paths, live: Status, deps: CliDeps): Promise<boolean> {
  const secret = await ensureSecret(paths)
  try {
    await deps.post(`http://127.0.0.1:${live.port}/shutdown`, { 'x-kantoku-watch-secret': secret })
  } catch {}
  for (let waited = 0; deps.isAlive(live.pid) && waited < START_WAIT_MS; waited += 250) await deps.sleep(250)
  if (deps.isAlive(live.pid)) deps.out(`kantoku-watch: pid ${live.pid} did not stop`)

  return !deps.isAlive(live.pid)
}

const NO_RELAY: Relay = {
  name: 'none',
  preflight: async () => [],
  sync: async () => {},
  stop: async () => {},
  onConnected: () => {},
  onTrouble: () => {},
}

async function status(paths: Paths, deps: CliDeps): Promise<number> {
  const live = await running(paths, deps)
  if (live !== undefined) printStatus(live, deps)
  else {
    const last = await readStatus(paths)
    deps.out(`kantoku-watch: not running${last?.lastAliveAt ? ` (last alive ${last.lastAliveAt})` : ''}`)
  }

  return 0
}

async function catchupOnce(paths: Paths, deps: CliDeps, from: string | undefined): Promise<number> {
  await mkdir(paths.home, { recursive: true })
  const now = new Date()
  const ctx = await createContext({ run: deps.run, relay: NO_RELAY, stateRoot: paths.stateRoot, home: paths.home, allow: new Set(), port: 0, now, from })
  await catchUpOnce(ctx, now)
  deps.out(`kantoku-watch: catch-up done. See ${join(paths.home, 'watch.log')} for the letters sent`)

  return 0
}

async function runDaemon(paths: Paths, allow: string[], deps: CliDeps, from: string | undefined): Promise<number> {
  await mkdir(paths.home, { recursive: true })
  if (!(await preflight(deps))) return 2
  if (!(await acquireLock(paths.home, process.pid, deps.isAlive))) {
    await log(paths, `another daemon holds ${join(paths.home, 'daemon.lock')}; pid ${process.pid} exits`)

    return 0
  }
  const secret = await ensureSecret(paths)
  let stopping = false
  let wake = () => {}
  const stopNow = () => {
    stopping = true
    wake()
  }
  let ctx: Awaited<ReturnType<typeof createContext>> | undefined
  const receiver = await startReceiver({
    secret,
    onDelivery: (event, id, payload) => {
      if (ctx === undefined) return
      handleDelivery(ctx, event, id, payload, new Date()).catch(error => log(paths, `delivery error: ${String(error)}`))
    },
    onShutdown: stopNow,
  })
  const relay = ghForwardRelay({ spawn: realSpawn, run: deps.run, url: `http://127.0.0.1:${receiver.port}/webhook`, secret })
  ctx = await createContext({ run: deps.run, relay, stateRoot: paths.stateRoot, home: paths.home, allow: new Set(allow), port: receiver.port, now: new Date(), from })
  process.on('SIGINT', stopNow)
  process.on('SIGTERM', stopNow)
  await writeJson(join(paths.home, 'status.json'), statusOf(ctx, new Date()))
  await log(paths, `started pid ${process.pid} port ${receiver.port}${allow.length > 0 ? ` allow ${allow.join(',')}` : ''}`)

  while (!stopping) {
    try {
      if ((await tick(ctx, new Date())) === 'idle-stop') break
    } catch (error) {
      await log(paths, `tick error: ${String(error)}`)
    }
    if (stopping) break
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, LOOP_MS)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  await relay.stop()
  await receiver.close()
  await writeJson(join(paths.home, 'status.json'), { ...statusOf(ctx, new Date()), pid: 0 })
  await releaseLock(paths.home, process.pid)
  await log(paths, 'stopped')

  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then(code => {
    process.exitCode = code
  })
}
