// Sends letters with `orca orchestration send`. A key is stored only after the
// send exits 0, so a failed letter is tried again at the next trigger or catch-up.

import type { Letter } from './route.ts'
import type { Run } from './run.ts'
import type { Seen } from './seen.ts'

export async function sendLetters(run: Run, letters: Letter[], seen: Seen, now: Date): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  for (const letter of letters) {
    if (seen.has(letter.key)) continue
    const args = ['orchestration', 'send', '--to', letter.to, '--type', 'status', '--subject', letter.subject]
    if (letter.body !== '') args.push('--body', letter.body)
    let code = 1
    try {
      code = (await run('orca', args)).code
    } catch {}
    if (code === 0) {
      seen.add(letter.key, now)
      sent++
    } else failed++
  }

  return { sent, failed }
}
