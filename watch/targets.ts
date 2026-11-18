// Reads every kantoku manager's state.md into the PRs kantoku-watch follows.
// Managers write these files by hand, in Japanese or English, so the reader is
// lenient like hooks/parse.ts: an odd cell means "no PR", never an error.
// It does not import hooks/parse.ts; the test reads the real template instead.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type PrRef = { repo: string; number: number }

export type WatchTarget = {
  pr: PrRef
  url: string
  manager: string
  run: string | undefined
  dispatch: string | undefined
  task: string
  rowDone: boolean
}

const TASKS_HEADING = /^(タスク|tasks?\b)/i
const STATUS_HEADER = /^(状態|状況|ステータス|status\b|state\b)/i
const PR_HEADER = /^pr$/i
const DISPATCH_HEADER = /dispatch/i
// Same as DONE_STATUS in hooks/parse.ts. 完了待ち / 合格待ち are still open.
const DONE_STATUS = /^((完了|合格)(?!待ち)|merge ?済|merged\b|done\b|succeeded\b|completed?\b|pass(ed)?\b)/i

const NAME = '[A-Za-z0-9_.-]+'
const PR_URL = new RegExp(`^https?://github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:[/?#][^\\s)）\\]]*)?$`, 'i')
const PR_SHORT = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`)

export function prKey(pr: PrRef): string {
  return `${pr.repo}#${pr.number}`
}

export function isDoneStatus(status: string): boolean {
  return DONE_STATUS.test(status.trim())
}

export function parsePrRef(cell: string): PrRef | undefined {
  const link = /\]\(([^)]*)\)/.exec(cell)?.[1]
  const text = (link ?? cell).trim().replace(/^[(（<]+/, '').replace(/[)）>]+$/, '').trim()
  const match = PR_URL.exec(text) ?? PR_SHORT.exec(text)
  if (!match) return undefined
  const number = Number(match[3])

  return number > 0 ? { repo: `${match[1]}/${match[2]}`.toLowerCase(), number } : undefined
}

export function parseTargets(manager: string, stateText: string): WatchTarget[] {
  const text = stateText.replace(/<!--[\s\S]*?-->/g, '')
  const run = /^run:[ \t]*(\S+)/m.exec(text)?.[1]
  const lines = tasksLines(text)
  const ruleAt = lines.findIndex(isRuleLine)
  const header = ruleAt > 0 && isTableLine(lines[ruleAt - 1] ?? '') ? cellsOf(lines[ruleAt - 1] ?? '') : undefined
  if (header === undefined) return []
  const prAt = header.findIndex(cell => PR_HEADER.test(cell))
  if (prAt < 0) return []
  const statusAt = header.findIndex(cell => STATUS_HEADER.test(cell))
  const dispatchAt = header.findIndex(cell => DISPATCH_HEADER.test(cell))

  return lines.slice(ruleAt + 1).filter(isTableLine).flatMap(line => {
    const cells = cellsOf(line)
    const task = (cells[0] ?? '').replace(/\*\*|__|`/g, '').trim()
    const url = cells[prAt] ?? ''
    const pr = parsePrRef(url)
    if (task === '' || pr === undefined) return []
    const status = statusAt < 0 ? '' : (cells[statusAt] ?? '')
    const dispatch = dispatchAt < 0 ? undefined : /\bctx_[0-9a-f]+\b/i.exec(cells[dispatchAt] ?? '')?.[0]

    return [{ pr, url, manager, run, dispatch, task, rowDone: isDoneStatus(status) }]
  })
}

export async function readAllTargets(root: string): Promise<WatchTarget[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const all = await Promise.all(names.map(async name => {
    try {
      return parseTargets(name, await readFile(join(root, name, 'state.md'), 'utf8'))
    } catch {
      return []
    }
  }))

  return all.flat()
}

function tasksLines(text: string): string[] {
  const out: string[] = []
  let inTasks = false
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^##[ \t]+(.*)$/.exec(raw)
    if (heading) inTasks = TASKS_HEADING.test((heading[1] ?? '').trim())
    else if (inTasks) out.push(raw.trim())
  }

  return out
}

function cellsOf(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.replace(/\\\|/g, '|').trim())
}

const isTableLine = (line: string) => line.startsWith('|')
const isRuleLine = (line: string) => /^\|[\s|:-]+\|?$/.test(line)
