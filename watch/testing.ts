// Test helper: a fake `Run` that records calls and answers from a table.

import type { Run } from './run.ts'

export type Answer = { code?: number; stdout?: string; stderr?: string }

export function fakeRun(answer: (cmd: string, args: string[]) => Answer | undefined): Run & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    const a = answer(cmd, args) ?? {}

    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
  }

  return Object.assign(run, { calls })
}

export const json = (value: unknown): Answer => ({ stdout: JSON.stringify(value) })
