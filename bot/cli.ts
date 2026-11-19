// node bot/cli.ts [--port 4870] [--root <dir>]
// Serves the kantoku bot on 127.0.0.1 until Ctrl+C.
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { orcaRing, retryQueued } from './doorbell.ts'
import { expireSecrets, startBotServer } from './server.ts'

export const DEFAULT_PORT = 4870
const RETRY_MS = 30_000

export function parseArgs(argv: string[]): { port: number; root: string } {
  let port = DEFAULT_PORT
  let root = join(homedir(), '.kantoku')
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at]
    const value = argv[at + 1]
    if (flag === '--port') {
      const n = Number(value)
      if (value === undefined || !/^\d+$/.test(value) || n < 1 || n > 65535) throw new Error('--port needs a number (1-65535)')
      port = n
      at++
    } else if (flag === '--root') {
      if (value === undefined || value.startsWith('--')) throw new Error('--root needs a folder')
      root = resolve(value)
      at++
    } else throw new Error(`unknown argument: ${flag}`)
  }

  return { port, root }
}

async function main(): Promise<void> {
  let args: { port: number; root: string }
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    console.error('usage: node bot/cli.ts [--port 4870] [--root <dir>]')
    process.exit(2)
  }
  const token = randomBytes(32).toString('hex')
  const pageDir = fileURLToPath(new URL('./page', import.meta.url))
  try {
    await startBotServer({ root: args.root, port: args.port, pageDir, token })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`port ${args.port} is in use; try --port <n>`)
    else console.error((error as Error).message)
    process.exit(1)
  }
  // Entries written while a manager had no Run, or whose doorbell failed; and
  // secret requests whose time ran out.
  setInterval(() => {
    void retryQueued(args.root, orcaRing).catch(() => 0)
    void expireSecrets(args.root, orcaRing).catch(() => 0)
  }, RETRY_MS)
  console.log(`kantoku bot: http://127.0.0.1:${args.port}/`)
  console.log('Ctrl+C to stop')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
