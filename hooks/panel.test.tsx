import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine makes the path absolute, so files are matched by their ending.
const HOME = '/home/someone'

const FILES: Record<string, string> = {
  [`${HOME}/.kantoku/kaizen/state.md`]: `# kaizen state
terminal: term_manager

## Tasks
| Task | dispatch ID | Status |
|---|---|---|
| English docs | ctx_1 | in progress |
| Launch and profile | ctx_2 | done |

## Queue
- Build the mod
`,
  [`${HOME}/.kantoku/kaizen/profile.md`]: `# Duties of kaizen

## Duties
Improve kantoku.

## Autonomy
- External writes: auto
- merge: after-verifier

## Routines
Timezone: Asia/Seoul
| Name | When | What | Wake | Quiet when |
|---|---|---|---|---|
| standup | 50 8 * * 1-5 | Look at the queue | manager | the queue is empty |
| digest | 0 9 * * * | Sum up mail | child | |
`,
  [`${HOME}/.kantoku/web/state.md`]: 'terminal: term_other\n',
}

const PANE = {
  plugin: 'kantoku',
  component: 'Pane',
  requestId: 'kantoku-manager',
  props: {
    title: 'kaizenくん',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type World = {
  // Panes the engine lists but does not draw, as on a narrow terminal.
  undrawn?: boolean
  files?: Record<string, string>
  // When each manager's state.md was last written, by manager name.
  writtenAt?: Record<string, number>
  // How many opens the engine refuses before it places the pane.
  refusals?: number
}

function engine(on: On, handle: string | undefined, world: World = {}) {
  mock.env(on, handle === undefined ? { HOME } : { HOME, ORCA_TERMINAL_HANDLE: handle })
  const clock = mock.clock(on)
  const files = world.files ?? FILES
  let refusals = world.refusals ?? 0
  const opened: string[] = []
  // The panes up now, as the engine would list them.
  const up = new Set<string>()
  on('fs.stat', (_, e) => {
    const name = /\.kantoku[\\/]([^\\/]+)[\\/]/.exec(e.path)?.[1] ?? ''

    return { value: { kind: 'file', size: 0, mtimeMs: world.writtenAt?.[name] ?? 0, isLink: false } }
  })
  on('fs.list', () => ({
    value: ['old', 'kaizen', 'web', 'notes.txt'].map(name => ({
      name,
      kind: name.includes('.') ? 'file' : 'dir',
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    const text = Object.entries(files).find(([known]) => path.endsWith(known))?.[1]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('command.register', () => ({ value: { command: 'kantoku-panel' } }))
  on('ui.panes', () => ({
    value: [...up].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: world.undrawn !== true })),
  }))
  on('ui.close', (_, e) => {
    up.delete(e.id)

    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    if (refusals > 0) {
      refusals -= 1
      throw new Error('pane held by another plugin')
    }
    opened.push(`${e.id} ${e.title}`)
    up.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { opened, clock, up }
}

test('a manager session opens the panel with its profile and tasks', async ($, on) => {
  const { opened } = engine(on, 'term_manager')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual(['kantoku-manager kaizenくん'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /くん/ }))?.text).toBe('kaizenくん')
    expect((await ui.find({ type: 'Text', text: /Improve/ }))?.text).toBe('Improve kantoku.')
    expect((await ui.find({ type: 'Text', text: /writes/ }))?.text).toBe(
      'writes: auto · merge: after-verifier',
    )
    expect((await ui.find({ type: 'Text', text: /routines/ }))?.text).toBe('routines: standup 50 8 * * 1-5 · digest 0 9 * * *')
    expect((await ui.find({ type: 'Text', text: /English/ }))?.text).toBe('□ English docs (in progress)')
    expect((await ui.find({ type: 'Text', text: /Build/ }))?.text).toBe('□ Build the mod (queued)')
    expect((await ui.find({ type: 'Text', text: /Launch/ }))?.text).toBe('☑ Launch and profile')
    await ui.unmount()
  }
})

test('a session that is no manager opens nothing', async ($, on) => {
  const { opened } = engine(on, 'term_someone_else')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual([])
})

test('a session outside Orca opens nothing', async ($, on) => {
  const { opened } = engine(on, undefined)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual([])
})

test('the command in a session that is no manager says so', async ($, on) => {
  engine(on, 'term_someone_else')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({
    command: 'kantoku-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(JSON.stringify(ran)).toContain('not a kantoku manager')
})

test('an old state.md naming the same terminal loses to the newest one', async ($, on) => {
  const { opened } = engine(on, 'term_manager', {
    files: { ...FILES, [`${HOME}/.kantoku/old/state.md`]: 'terminal: term_manager\n' },
    writtenAt: { old: 1000, kaizen: 2000 },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual(['kantoku-manager kaizenくん'])
})

test('an open the engine refused is tried again at the next poll', async ($, on) => {
  const { opened, clock } = engine(on, 'term_manager', { refusals: 1 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual([])

  await clock.advance(5000)
  expect(opened).toEqual(['kantoku-manager kaizenくん'])
})

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'kantoku-panel',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

test('with showPanelOnStart off, a manager session starts with the panel hidden', { options: { showPanelOnStart: false } }, async ($, on) => {
  const { opened, clock } = engine(on, 'term_manager')
  await $.session.start(START)
  await clock.advance(5000)

  expect(opened).toEqual([])

  const ran = await run($, 'show')
  expect(opened).toEqual(['kantoku-manager kaizenくん'])
  expect(JSON.stringify(ran)).toContain('Opened')
})

test('hide closes the panel, and the poll leaves it closed', async ($, on) => {
  const { opened, clock, up } = engine(on, 'term_manager')
  await $.session.start(START)
  expect([...up]).toEqual(['kantoku-manager'])

  const ran = await run($, 'hide')
  expect(JSON.stringify(ran)).toContain('Hid')
  expect([...up]).toEqual([])

  await clock.advance(5000)
  await clock.advance(5000)
  expect([...up]).toEqual([])
  expect(opened).toEqual(['kantoku-manager kaizenくん'])
})

test('the bare command and toggle flip the panel', async ($, on) => {
  const { up } = engine(on, 'term_manager')
  await $.session.start(START)
  expect([...up]).toEqual(['kantoku-manager'])

  await run($, '')
  expect([...up]).toEqual([])
  await run($, 'toggle')
  expect([...up]).toEqual(['kantoku-manager'])
})

test('hide stores the choice in $.state', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', (_, e, next) => {
    writes.push(e.value)

    return next(e)
  })
  engine(on, 'term_manager')
  await $.session.start(START)
  await run($, 'hide')

  expect(writes).toEqual([false])
})

test('a stored hide keeps the panel closed when the mod loads again', async ($, on) => {
  // $.state outlives a reload, whose session.start runs again.
  on('state.get', () => ({ value: { value: false, version: 3 } }))
  const { opened } = engine(on, 'term_manager')
  await $.session.start(START)

  expect(opened).toEqual([])
})

test('an unknown argument says how to use the command', async ($, on) => {
  engine(on, 'term_manager')
  await $.session.start(START)

  const ran = await run($, 'sideways')
  expect(JSON.stringify(ran)).toContain('show')
  expect(JSON.stringify(ran)).toContain('hide')
})

test('toggle shows a panel that is listed but not drawn', async ($, on) => {
  const { up } = engine(on, 'term_manager', { undrawn: true })
  await $.session.start(START)
  expect([...up]).toEqual(['kantoku-manager'])

  const ran = await run($, '')
  expect(JSON.stringify(ran)).toContain('Opened')
  expect([...up]).toEqual(['kantoku-manager'])
})

test('hide in a session that is no manager stores nothing', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', (_, e, next) => {
    writes.push(e.value)

    return next(e)
  })
  engine(on, 'term_someone_else')
  await $.session.start(START)

  const ran = await run($, 'hide')
  expect(JSON.stringify(ran)).toContain('not a kantoku manager')
  expect(writes).toEqual([])
})

test('a refused show says so instead of throwing', async ($, on) => {
  const { opened } = engine(on, 'term_manager', { refusals: 2 })
  await $.session.start(START)

  const ran = await run($, 'show')
  expect(JSON.stringify(ran)).toContain('Could not open')
  expect(opened).toEqual([])
})
