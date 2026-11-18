// The one place that runs `gh` and `orca`. Every caller takes a `Run`, so tests pass a fake.
// No shell: on Windows cmd.exe would re-parse arguments (spaces, `>`) in letter text.

import { execFile } from 'node:child_process'

export type RunResult = { code: number; stdout: string; stderr: string }
export type Run = (cmd: string, args: string[]) => Promise<RunResult>

export const realRun: Run = (cmd, args) =>
  new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr: stderr || (error !== null && typeof error.code !== 'number' ? String(error.message) : '') })
    })
  })
