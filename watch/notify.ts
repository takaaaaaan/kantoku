// Sends one letter with `orca orchestration send`. It only reports whether the
// send exited 0; the outbox (outbox.ts) decides what happens next.
// Orca refuses a send whose sender terminal it cannot tell, so every send names
// one with --from: the terminal that started the daemon, and when Orca refuses
// that one (another manager's Run), the manager's own terminal from state.md.

import type { Letter } from './route.ts'
import type { Run } from './run.ts'

async function sendOnce(run: Run, letter: Letter, from: string | undefined): Promise<boolean> {
  const args = ['orchestration', 'send']
  if (from !== undefined) args.push('--from', from)
  args.push('--to', letter.to, '--type', 'status', '--subject', letter.subject)
  if (letter.body !== '') args.push('--body', letter.body)
  try {
    return (await run('orca', args)).code === 0
  } catch {
    return false
  }
}

export async function sendLetter(run: Run, letter: Letter, from?: string): Promise<boolean> {
  for (const sender of new Set([from ?? letter.fallbackFrom, letter.fallbackFrom])) if (await sendOnce(run, letter, sender)) return true

  return false
}
