// Sends letters with `orca orchestration send`. A key is stored only after the
// send exits 0, so a failed letter is tried again at the next trigger or catch-up.
// Orca refuses a send whose sender terminal it cannot tell, so every send names
// one with --from: the terminal that started the daemon, and when Orca refuses
// that one (another manager's Run), the manager's own terminal from state.md.

import type { Letter } from './route.ts'
import type { Run } from './run.ts'
import type { Seen } from './seen.ts'

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

export async function sendLetters(run: Run, letters: Letter[], seen: Seen, now: Date, from?: string): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  for (const letter of letters) {
    if (seen.has(letter.key)) continue
    const senders = [...new Set([from ?? letter.fallbackFrom, letter.fallbackFrom])]
    let ok = false
    for (const sender of senders) if (!ok) ok = await sendOnce(run, letter, sender)
    if (ok) {
      seen.add(letter.key, now)
      sent++
    } else failed++
  }

  return { sent, failed }
}
