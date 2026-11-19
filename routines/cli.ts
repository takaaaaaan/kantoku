// kantoku routines: turn the Routines table in ~/.kantoku/<manager>/profile.md
// into Orca automations, and do what each one does when its time comes.
//
//   node routines/cli.ts sync <manager>             make Orca match the table
//   node routines/cli.ts fire <manager> <routine>   the automation's precheck
//
// fire exits 0 only for a `child` routine, so Orca starts its agent. A `manager`
// routine sends the manager a letter and exits 1, so no agent starts and no
// tokens are spent. When the manager is not running, the wake waits in
// <home>/routines/inbox/ and the manager reads it on its next startup.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realRun } from '../watch/run.ts'
import type { Run } from '../watch/run.ts'
import { automationName, automationsFor, parseRoutines, planSync } from './routines.ts'
import type { Automation, Existing, Routine } from './routines.ts'

export type Deps = {
  run: Run
  kantokuRoot: string
  // A git repo Orca knows: automations cannot run in a folder project.
  workspace: string
  node: string
  cli: string
  timezone: string
  now: () => Date
  print: (line: string) => void
}

const MANAGER = /^[A-Za-z0-9_-]{1,40}$/
const ROUTINE = /^[a-z0-9][a-z0-9-]*$/

const slash = (path: string) => path.replace(/\\/g, '/')

function readOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

const field = (text: string, key: string) => new RegExp(`^${key}:[ \\t]*(\\S+)`, 'm').exec(text)?.[1]

function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}

function letterBody(routine: Routine): string {
  return [
    `Routine "${routine.name}" from your profile's Routines table (not an outside request).`,
    `Do: ${routine.what}`,
    `Quiet when: ${routine.quietWhen === '' ? '(never quiet)' : routine.quietWhen}`,
  ].join('\n')
}

async function isAlive(deps: Deps, terminal: string): Promise<boolean> {
  const shown = await deps.run('orca', ['terminal', 'show', '--terminal', terminal, '--json']).catch(() => undefined)
  if (shown === undefined || shown.code !== 0) return false
  try {
    return (JSON.parse(shown.stdout) as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}

export async function fire(deps: Deps, manager: string, name: string): Promise<number> {
  const home = join(deps.kantokuRoot, manager)
  const routine = parseRoutines(readOr(join(home, 'profile.md'), '')).routines.find(one => one.name === name)
  if (routine === undefined) {
    deps.print(`No routine "${name}" in ${manager}'s profile.md. Run sync to remove ${automationName(manager, name)}.`)
    return 1
  }
  if (routine.wake === 'child') return 0

  const state = readOr(join(home, 'state.md'), '')
  const terminal = field(state, 'terminal')
  const run = field(state, 'run')
  if (terminal !== undefined && run !== undefined && (await isAlive(deps, terminal))) {
    const args = ['orchestration', 'send', '--from', terminal, '--to', `run:${run}`, '--type', 'status', '--subject', `kantoku-routine: ${name}`, '--body', letterBody(routine)]
    const sent = await deps.run('orca', args).catch(() => undefined)
    if (sent?.code === 0) {
      deps.print(`Woke ${manager} for ${name}.`)
      return 1
    }
  }

  const inbox = join(home, 'routines', 'inbox')
  mkdirSync(inbox, { recursive: true })
  const file = join(inbox, `${stamp(deps.now())}-${name}.md`)
  writeFileSync(file, `missed\n${manager} was not running when "${name}" came due.\n\n${letterBody(routine)}\n`)
  deps.print(`${manager} is not running. Left ${file} for its next startup.`)

  return 1
}

type Listed = { id?: unknown; name?: unknown; rrule?: unknown; timezone?: unknown; prompt?: unknown; precheck?: { command?: unknown } | null; runContext?: { path?: unknown }; enabled?: unknown }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

async function ensureWorkspace(deps: Deps): Promise<boolean> {
  if (!existsSync(join(deps.workspace, '.git'))) {
    mkdirSync(deps.workspace, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', ['-C', deps.workspace, ...args], { stdio: 'ignore', windowsHide: true })
    git('init', '-q')
    git('-c', 'user.name=kantoku', '-c', 'user.email=kantoku@localhost', 'commit', '-q', '--allow-empty', '-m', 'kantoku routines workspace')
  }
  const selector = `path:${slash(deps.workspace)}`
  if ((await deps.run('orca', ['repo', 'show', '--repo', selector, '--json'])).code === 0) return true
  const added = await deps.run('orca', ['repo', 'add', '--path', slash(deps.workspace), '--json'])
  if (added.code !== 0) deps.print(`Could not add ${deps.workspace} to Orca: ${added.stderr || added.stdout}`)

  return added.code === 0
}

function flags(want: Automation): string[] {
  return ['--trigger', want.cron, '--timezone', want.timezone, '--prompt', want.prompt, '--provider', 'claude', '--workspace', `path:${slash(want.workspace)}`, '--precheck', want.precheck, '--enabled', '--json']
}

export async function sync(deps: Deps, manager: string): Promise<number> {
  const profile = readOr(join(deps.kantokuRoot, manager, 'profile.md'), '')
  if (profile === '') {
    deps.print(`No ${manager}/profile.md under ${deps.kantokuRoot}.`)
    return 1
  }
  const table = parseRoutines(profile)
  for (const problem of table.problems) deps.print(`Skipped row ${problem}.`)
  if (!(await ensureWorkspace(deps))) return 1

  const listed = await deps.run('orca', ['automations', 'list', '--json'])
  let automations: Listed[]
  try {
    automations = (JSON.parse(listed.stdout) as { result?: { automations?: Listed[] } }).result?.automations ?? []
  } catch {
    deps.print(`orca automations list failed: ${listed.stderr || listed.stdout}`)
    return 1
  }
  const existing: Existing[] = automations.map(one => ({
    id: text(one.id),
    name: text(one.name),
    cron: text(one.rrule),
    timezone: text(one.timezone),
    prompt: text(one.prompt),
    precheck: text(one.precheck?.command),
    workspace: text(one.runContext?.path),
    enabled: one.enabled === true,
  }))
  const want = automationsFor(table, { manager, node: deps.node, cli: deps.cli, workspace: slash(deps.workspace), timezone: deps.timezone })
  let failed = false
  for (const step of planSync(manager, want, existing, table.skipped)) {
    const args =
      step.kind === 'create'
        ? ['automations', 'create', '--name', step.want.name, ...flags(step.want)]
        : step.kind === 'edit'
          ? ['automations', 'edit', step.id, ...flags(step.want)]
          : ['automations', 'remove', step.id, '--json']
    const done = await deps.run('orca', args)
    const label = step.kind === 'remove' ? step.name : step.want.name
    deps.print(done.code === 0 ? `${DONE[step.kind]} ${label}` : `could not ${step.kind} ${label}: ${done.stderr || done.stdout}`)
    failed ||= done.code !== 0
  }
  deps.print(`${manager}: ${want.length} routine(s) in Orca.`)

  return failed || table.problems.length > 0 ? 1 : 0
}

const DONE = { create: 'created', edit: 'edited', remove: 'removed' } as const

const USAGE = 'Usage: node routines/cli.ts sync <manager> | fire <manager> <routine>'

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, manager = '', routine = ''] = argv
  if (!MANAGER.test(manager) || (command === 'fire' && !ROUTINE.test(routine)) || (command !== 'sync' && command !== 'fire')) {
    deps.print(USAGE)
    return 2
  }

  return command === 'sync' ? sync(deps, manager) : fire(deps, manager, routine)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deps: Deps = {
    run: realRun,
    kantokuRoot: join(homedir(), '.kantoku'),
    workspace: join(homedir(), '.kantoku-routines'),
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: () => new Date(),
    print: line => console.log(line),
  }
  process.exitCode = await main(process.argv.slice(2), deps)
}
