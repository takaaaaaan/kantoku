// Reads a kantoku manager's profile.md and state.md into what the panel shows.
// The manager writes these files by hand, in Japanese or English, so every
// reader here is lenient: a missing section is empty, never an error.

export type Routine = { name: string; when: string }

export type Profile = {
  job: string
  externalWrites: string | undefined
  merge: string | undefined
  routines: Routine[]
}

export type TaskItem = {
  title: string
  status: string
  isDone: boolean
  isQueued: boolean
}

export type ManagerView = Profile & { name: string; tasks: TaskItem[] }

const TASKS_HEADING = /^(タスク|tasks?\b)/i
const QUEUE_HEADING = /^(待ち列|queue\b)/i
const JOB_HEADING = /^(担当業務|duties\b|job\b)/i
const AUTONOMY_HEADING = /^(自律度|autonomy\b)/i
const ROUTINES_HEADING = /^(routines?\b|ルーティン)/i
const STATUS_HEADER = /^(状態|状況|ステータス|status\b|state\b)/i
// 完了待ち / 合格待ち ("waiting for done / pass") are still open.
const DONE_STATUS = /^((完了|合格)(?!待ち)|merge ?済|merged\b|done\b|succeeded\b|completed?\b|pass(ed)?\b)/i
const EMPTY_ITEM = /^[((]?(なし|none)[))]?$/i

export function terminalOf(stateText: string): string | undefined {
  return /^terminal:[ \t]*(\S+)/m.exec(stateText)?.[1]
}

export function parseProfile(text: string): Profile {
  const sections = sectionsOf(text)
  const jobLine = linesOf(sections, JOB_HEADING).find(line => line.trim() !== '')
  const autonomy = linesOf(sections, AUTONOMY_HEADING)

  return {
    job: firstSentence(stripBullet((jobLine ?? '').trim())),
    externalWrites: settingOf(autonomy, /^(外への書き込み|external writes)$/i),
    merge: settingOf(autonomy, /^merge$/i),
    routines: routinesOf(linesOf(sections, ROUTINES_HEADING)),
  }
}

// The Routines table, found by column name; its empty template row is skipped.
function routinesOf(lines: string[]): Routine[] {
  const header = headerOf(lines) ?? []
  const column = (name: RegExp, fallback: number) => {
    const at = header.findIndex(cell => name.test(cell))

    return at < 0 ? fallback : at
  }
  const nameAt = column(/^(name|名前)/i, 0)
  const whenAt = column(/^(when|cron|時刻|いつ)/i, 1)
  const rule = lines.findIndex(isRuleLine)
  if (rule < 1) return []

  return lines
    .slice(rule + 1)
    .filter(isTableLine)
    .map(cellsOf)
    .map(cells => ({ name: plain(cells[nameAt] ?? ''), when: plain(cells[whenAt] ?? '') }))
    .filter(routine => routine.name !== '')
}

export function parseState(text: string): TaskItem[] {
  const sections = sectionsOf(text)
  const tasks = linesOf(sections, TASKS_HEADING)
  const queue = linesOf(sections, QUEUE_HEADING)
  const header = headerOf(tasks)
  const statusAt = header === undefined ? -1 : header.findIndex(cell => STATUS_HEADER.test(cell))

  return [
    ...rowsOf(tasks, statusAt),
    ...rowsOf(queue, statusAt),
    ...queue
      .filter(line => /^[-*] /.test(line))
      .map(stripBullet)
      .filter(item => item !== '' && !EMPTY_ITEM.test(item))
      .map(item => ({ title: shortTitle(item), status: 'queued', isDone: false, isQueued: true })),
  ]
}

export function buildView(name: string, profileText: string, stateText: string): ManagerView {
  const tasks = parseState(stateText)
  const rank = (task: TaskItem) => (task.isDone ? 2 : task.isQueued ? 1 : 0)

  return {
    name,
    ...parseProfile(profileText),
    tasks: [...tasks].sort((a, b) => rank(a) - rank(b)),
  }
}

type Section = { heading: string; lines: string[] }

function sectionsOf(text: string): Section[] {
  let current: Section = { heading: '', lines: [] }
  const sections = [current]
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const heading = /^##[ \t]+(.*)$/.exec(raw)
    if (heading) {
      current = { heading: (heading[1] ?? '').trim(), lines: [] }
      sections.push(current)
    } else current.lines.push(raw.trimEnd())
  }

  return sections
}

function linesOf(sections: Section[], heading: RegExp): string[] {
  return sections.filter(section => heading.test(section.heading)).flatMap(section => section.lines)
}

function settingOf(lines: string[], key: RegExp): string | undefined {
  for (const line of lines) {
    const setting = /^[-*][ \t]*([^::]+)[::][ \t]*([^\s((]+)/.exec(line)
    if (setting && key.test((setting[1] ?? '').trim())) return setting[2]
  }

  return undefined
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

// A table's header is the row right above its |---| rule.
function headerOf(lines: string[]): string[] | undefined {
  const above = lines[lines.findIndex(isRuleLine) - 1]

  return above !== undefined && isTableLine(above) ? cellsOf(above) : undefined
}

function rowsOf(lines: string[], statusAt: number): TaskItem[] {
  return lines
    .filter((line, at) => isTableLine(line) && !isRuleLine(line) && !isRuleLine(lines[at + 1] ?? ''))
    .map(cellsOf)
    .filter(cells => (cells[0] ?? '') !== '')
    .map(cells => {
      const status = shortStatus(statusAt < 0 ? '' : (cells[statusAt] ?? ''))

      return { title: shortTitle(cells[0] ?? ''), status, isDone: DONE_STATUS.test(status), isQueued: false }
    })
}

function stripBullet(line: string): string {
  return line.replace(/^[-*][ \t]+/, '').trim()
}

// The panel gives the job one line: its first sentence.
function firstSentence(text: string): string {
  return /^.*?(。|\.(?=\s|$))/.exec(text)?.[0] ?? text
}

function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, '')
}

// A task cell carries its spec path and task ID; the panel shows the name.
function shortTitle(cell: string): string {
  return plain(cell)
    .replace(/[((]\s*spec\b[^))]*[))]/gi, '')
    .replace(/\bspec:\s*\S+/gi, '')
    .replace(/\btask_[0-9a-f]+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A status cell often runs on with details; the panel shows its first words.
function shortStatus(cell: string): string {
  return (plain(cell).split(/[。((::]/)[0] ?? '').trim()
}
