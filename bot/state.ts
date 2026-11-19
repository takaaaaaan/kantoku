// state.md → working / waiting for the user / asleep, and where to ring.
// The done rule is copied from hooks/parse.ts (the panel's reader) on purpose:
// that file belongs to the mod runtime and is not imported here.
import { bodyOf, columnOf, tableOf } from './sections.ts'
import type { Status } from './types.ts'

const TASKS_HEADING = /^(タスク|tasks?\b)/i
const STATUS_HEADER = /^(状態|状況|ステータス|status\b|state\b)/i
const GATE_HEADER = /(gate|ゲート)/i
// 完了待ち / 合格待ち ("waiting for done / pass") are still open.
const DONE_STATUS = /^((完了|合格)(?!待ち)|merge ?済|merged\b|done\b|succeeded\b|completed?\b|pass(ed)?\b)/i
const USER_GATE = /^(user|ユーザー)[ \t]*[:：]/i

export type StateView = { status: Status; waitingRows: number; run?: string; terminal?: string }

export function parseState(text: string): StateView {
  const { header, rows } = tableOf(bodyOf(text, TASKS_HEADING) ?? '')
  const statusAt = columnOf(header, STATUS_HEADER, -1)
  const gateAt = columnOf(header, GATE_HEADER, -1)
  const open = rows.filter(cells => !DONE_STATUS.test(plain(cells[statusAt] ?? '')))
  const waitingRows = open.filter(cells => USER_GATE.test(plain(cells[gateAt] ?? ''))).length
  const status: Status = waitingRows > 0 ? 'waiting' : open.length > 0 ? 'working' : 'asleep'
  const view: StateView = { status, waitingRows }
  const run = lineValue(text, 'run')
  const terminal = lineValue(text, 'terminal')
  if (run !== undefined) view.run = run
  if (terminal !== undefined) view.terminal = terminal

  return view
}

function plain(cell: string): string {
  return cell.replace(/\*\*|__|`/g, '').trim()
}

function lineValue(text: string, key: string): string | undefined {
  return new RegExp(`^${key}:[ \\t]*(\\S+)`, 'm').exec(text)?.[1]
}
