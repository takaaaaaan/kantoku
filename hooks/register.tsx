import type { EngineInterface, Register } from 'claude-code'

import { buildView, terminalOf } from './parse'
import type { ManagerView, TaskItem } from './parse'

// A panel beside the chat that shows which kantoku manager this session is:
// its name, the gist of its profile, and its tasks as a todo list. It opens
// only in a session whose $ORCA_TERMINAL_HANDLE a manager wrote to the
// `terminal:` line of ~/.kantoku/<name>/state.md, and it reads those files
// again every few seconds, so it follows the manager as it works.
//
// The `showPanelOnStart` option (a row in /config) says whether a manager
// session starts with the panel up; `/kantoku-panel show|hide|toggle` and
// closing the pane change that for the session, through reloads too.

const PANE = 'kantoku-manager'
const COMMAND = 'kantoku-panel'
const POLL_MS = 5000
const USAGE = 'Usage: /kantoku-panel [show|hide|toggle]. With no argument it toggles.'

// The person's choice for this session; unset until they make one.
const wanted = { plugin: 'kantoku', key: 'isPanelWanted' } as const

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

const routinesLineOf = (view: ManagerView) =>
  `routines: ${view.routines.map(routine => `${routine.name} ${routine.when}`).join(' · ')}`

const lineOf = (task: TaskItem) =>
  task.isDone ? `☑ ${task.title}` : `□ ${task.title}${task.status === '' ? '' : ` (${task.status})`}`

// What the last poll drew, so the panel redraws only when the files changed
// and draws without reading them again. A reload starts these over, and
// session.start polls again.
let seen = ''
let last: ManagerView | undefined
let hasOpened = false

const paneOf = async ($: EngineInterface) => (await $.ui.panes()).find(pane => pane.id === PANE)

async function poll($: EngineInterface, showOnStart: boolean) {
  const view = await loadView($)
  const now = view === undefined ? '' : JSON.stringify(view)
  if (now === seen) return
  last = view
  const isUp = (await paneOf($)) !== undefined

  if (view === undefined) {
    if (isUp) await $.ui.close({ id: PANE })
    hasOpened = false
  } else if (isUp) {
    // Up already: only retitle.
    await $.ui.open({ id: PANE, title: titleOf(view) })
  } else if (!hasOpened) {
    // Opened once per load when this session is a manager, if the person's
    // choice (or else the option) wants it; a pane they close stays closed.
    const { value = showOnStart } = await $.state.get(wanted)
    if (value) {
      await $.ui.open({ id: PANE, title: titleOf(view) })
      // A hide that came while this open was on its way wins.
      if ((await $.state.get(wanted)).value === false) await $.ui.close({ id: PANE })
    }
    hasOpened = true
  }
  // Marked seen only once the pane is settled, so a refused open is tried again.
  seen = now
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  const showOnStart = options.showPanelOnStart !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Show or hide this kantoku manager's profile and tasks beside the chat",
      argumentHint: '[show|hide|toggle]',
    })
    $.clock.every(POLL_MS, () => void poll($, showOnStart).catch(() => undefined))
    await poll($, showOnStart).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const verb = e.args.trim().toLowerCase() || 'toggle'
    if (verb !== 'show' && verb !== 'hide' && verb !== 'toggle') return { text: USAGE }

    const view = await loadView($)
    if (view === undefined) {
      return {
        text: 'This session is not a kantoku manager: no ~/.kantoku/<name>/state.md names its Orca terminal.',
      }
    }

    // Listed is not seen: a pane can wait undrawn on a narrow terminal or
    // sit as a tab behind another, and toggling that one shows it.
    const pane = verb === 'show' ? undefined : await paneOf($)
    const isShow = verb === 'show' || (verb === 'toggle' && !(pane?.isPlaced === true && pane.isShown))
    if (!isShow) {
      await $.state.set(wanted, false)
      if (pane !== undefined) await $.ui.close({ id: PANE })

      return { text: 'Hid the kantoku panel. /kantoku-panel show brings it back.' }
    }

    await $.state.set(wanted, true)
    try {
      await $.ui.open({ id: PANE, title: titleOf(view) })
    } catch (error) {
      return { text: `Could not open the panel: ${error instanceof Error ? error.message : String(error)}` }
    }
    hasOpened = true

    return { text: `Opened the panel for ${titleOf(view)}.` }
  })

  // Closing the pane by hand counts as hiding it, so a reload keeps it closed.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.state.set(wanted, false).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = last ?? (await loadView($))
    if (view === undefined) {
      return <Text dimColor>This session is not a kantoku manager.</Text>
    }

    // Rows for tasks: the pane's body less the name, job, autonomy, routines,
    // the gap and the "+N more" line.
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const room = Math.max(1, bodyRows - 5 - (view.routines.length > 0 ? 1 : 0))
    const shown = view.tasks.length > room ? view.tasks.slice(0, room) : view.tasks
    const hidden = view.tasks.length - shown.length

    return (
      <Box flexDirection="column">
        {/* The terminal draws no pane title, so the body leads with the name. */}
        <Text bold>{titleOf(view)}</Text>
        <Text>{view.job === '' ? '(no duties in profile.md yet)' : view.job}</Text>
        <Text dimColor>{autonomyOf(view)}</Text>
        {view.routines.length > 0 && <Text dimColor>{routinesLineOf(view)}</Text>}
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
