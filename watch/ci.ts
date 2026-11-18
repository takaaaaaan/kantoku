// Folds `gh pr checks --json name,bucket` into one CI result.
// No checks yet counts as pending: there is nothing to report.

import type { CiSummary } from './events.ts'

export function summarizeChecks(checks: { name: string; bucket: string }[]): CiSummary {
  const failed = new Set<string>()
  let passed = 0
  let skipped = 0
  let pending = checks.length === 0
  for (const { name, bucket } of checks) {
    if (bucket === 'pass') passed++
    else if (bucket === 'fail') failed.add(name)
    else if (bucket === 'skipping' || bucket === 'cancel') skipped++
    else pending = true
  }
  const state = pending ? 'pending' : failed.size > 0 ? 'failed' : 'passed'

  return { state, failed: [...failed].sort(), passed, skipped }
}
