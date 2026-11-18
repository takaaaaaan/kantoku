import type { EngineInterface, Register } from 'claude-code'

import { buildView, terminalOf } from './parse'
import type { ManagerView, TaskItem } from './parse'

// A panel beside the chat that shows which kantoku manager this session is:
// its name, the gist of its profile, and its tasks as a todo list. It opens
// only in a session whose $ORCA_TERMINAL_HANDLE a manager wrote to the
// `terminal:` line of ~/.kantoku/<name>/state.md, and it reads those files
// again every few seconds, so it follows the manager as it works.

const PANE = 'kantoku-manager'
const COMMAND = 'kantoku-panel'
const POLL_MS = 5000

async function kantokuRoot($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

  return home === undefined ? undefined : `${home.replace(/[\\/]+$/, '')}/.kantoku`
}

const readOrEmpty = ($: EngineInterface, path: string) => $.fs.read(path).then(String, () => '')

const modifiedAt = ($: EngineInterface, path: string) =>
  $.fs.stat(path).then(
    stat => stat.mtimeMs,
    () => 0,
  )

// The manager whose state.md names this session's terminal. Should an old
// state.md still name the same terminal, the one written last wins.
async function loadView($: EngineInterface): Promise<ManagerView | undefined> {
  const handle = await $.env.get('ORCA_TERMINAL_HANDLE')
  const root = await kantokuRoot($)
  if (handle === undefined || handle === '' || root === undefined) return undefined

  const entries = await $.fs.list(root).catch(() => [])
  const managers = await Promise.all(
    entries
      .filter(entry => entry.kind !== 'file')
      .map(async entry => {
        const state = await readOrEmpty($, `${root}/${entry.name}/state.md`)

        return { name: entry.name, state }
      }),
  )
  const mine = managers.filter(manager => terminalOf(manager.state) === handle)
  if (mine.length === 0) return undefined

  const written = await Promise.all(mine.map(manager => modifiedAt($, `${root}/${manager.name}/state.md`)))
  const newest = written.indexOf(Math.max(...written))
  const manager = mine[newest] ?? mine[0]
  if (manager === undefined) return undefined
  const profile = await readOrEmpty($, `${root}/${manager.name}/profile.md`)

  return buildView(manager.name, profile, manager.state)
}

const titleOf = (view: ManagerView) => `${view.name}くん`

const autonomyOf = (view: ManagerView) =>
  view.externalWrites === undefined && view.merge === undefined
    ? '(no autonomy in profile.md)'
    : `writes: ${view.externalWrites ?? '?'} · merge: ${view.merge ?? '?'}`

const lineOf = (task: TaskItem) =>
  task.isDone ? `☑ ${task.title}` : `□ ${task.title}${task.status === '' ? '' : ` (${task.status})`}`

// What the last poll drew, so the panel redraws only when the files changed
// and draws without reading them again. A reload starts these over, and
// session.start polls again.
let seen = ''
let last: ManagerView | undefined
let hasOpened = false

async function poll($: EngineInterface) {
  const view = await loadView($)
  const now = view === undefined ? '' : JSON.stringify(view)
  if (now === seen) return
  last = view
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (view === undefined) {
    if (isUp) await $.ui.close({ id: PANE })
    hasOpened = false
  } else if (!hasOpened || isUp) {
    // Open once when this session becomes a manager; after that only
    // retitle, so a panel the person closed stays closed until /kantoku-panel.
    await $.ui.open({ id: PANE, title: titleOf(view) })
    hasOpened = true
  }
  // Marked seen only once the pane is settled, so a refused open is tried again.
  seen = now
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Show this kantoku manager's profile and tasks beside the chat",
    })
    $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    await poll($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const view = await loadView($)
    if (view === undefined) {
      return {
        text: 'This session is not a kantoku manager: no ~/.kantoku/<name>/state.md names its Orca terminal.',
      }
    }
    await $.ui.open({ id: PANE, title: titleOf(view) })
    hasOpened = true

    return { text: `Opened the panel for ${titleOf(view)}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = last ?? (await loadView($))
    if (view === undefined) {
      return <Text dimColor>This session is not a kantoku manager.</Text>
    }

    // Rows for tasks: the pane's body less the name, job, autonomy, the gap
    // and the "+N more" line.
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const room = Math.max(1, bodyRows - 5)
    const shown = view.tasks.length > room ? view.tasks.slice(0, room) : view.tasks
    const hidden = view.tasks.length - shown.length

    return (
      <Box flexDirection="column">
        {/* The terminal draws no pane title, so the body leads with the name. */}
        <Text bold>{titleOf(view)}</Text>
        <Text>{view.job === '' ? '(no duties in profile.md yet)' : view.job}</Text>
        <Text dimColor>{autonomyOf(view)}</Text>
        <Text> </Text>
        {view.tasks.length === 0 && <Text dimColor>No tasks in state.md.</Text>}
        {shown.map(task => (
          <Text dimColor={task.isDone}>{lineOf(task)}</Text>
        ))}
        {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
      </Box>
    )
  })
}
