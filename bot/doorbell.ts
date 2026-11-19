// The doorbell: a letter to the manager's Run that carries only a fixed
// subject and the entry id. The manager reads the words from the log.
// Run without a shell; every argument is fixed ASCII or checked below.
import { HANDLED_FILE, LOG_FILE } from './paths.ts'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { parseHandled, parseLog } from './notes.ts'
import { botNames, readSmall } from './read.ts'
import { parseState } from './state.ts'
import { appendEntry, localIso } from './write.ts'

export type Ring = (run: string | undefined, terminal: string | undefined, id: string) => Promise<boolean>
export type Exec = (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>

const RUN = /^run_[A-Za-z0-9_-]{1,80}$/
const TERMINAL = /^term_[A-Za-z0-9-]{1,80}$/
const ID = /^d-\d{8}-\d{6}-[0-9a-f]{4}$/
export const RING_TIMEOUT_MS = 5000
const FRESH_MS = 15_000

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, windowsHide: true, shell: false }, error => (error ? reject(error) : resolve(undefined)))
  })

export function makeOrcaRing(exec: Exec = realExec): Ring {
  return async (run, terminal, id) => {
    if (run === undefined || !RUN.test(run) || !ID.test(id)) return false
    if (terminal !== undefined && !TERMINAL.test(terminal)) return false
    const from = terminal === undefined ? [] : ['--from', terminal]
    try {
      await exec('orca', ['orchestration', 'send', ...from, '--to', `run:${run}`, '--type', 'status', '--subject', `kantoku-bot: ${id}`], {
        timeout: RING_TIMEOUT_MS,
      })
      return true
    } catch {
      return false
    }
  }
}

export const orcaRing: Ring = makeOrcaRing()

// Rings every entry still queued (no `delivered` line, not handled) and
// appends `delivered` for each that goes through. Returns how many did.
export async function retryQueued(root: string, ring: Ring, now: () => Date = () => new Date()): Promise<number> {
  let count = 0
  for (const name of await botNames(root)) {
    const home = join(root, name)
    const state = parseState(await readSmall(join(home, 'state.md')))
    if (state.run === undefined) continue
    const log = parseLog(await readSmall(join(home, LOG_FILE)))
    const handled = parseHandled(await readSmall(join(home, HANDLED_FILE)))
    const delivered = new Set(log.filter(e => e.type === 'delivered').map(e => e.id))
    // An entry younger than FRESH_MS may still be ringing in the request that wrote it.
    const settled = (at: string) => !(Date.parse(at) > now().getTime() - FRESH_MS)
    const queued = log.filter(e => e.type !== 'delivered' && e.delivery === 'queued' && !delivered.has(e.id) && !handled.has(e.id) && settled(e.at))
    for (const entry of queued) {
      if (!(await ring(state.run, state.terminal, entry.id))) break
      await appendEntry(home, { id: entry.id, at: localIso(now()), type: 'delivered' })
      count++
    }
  }

  return count
}
