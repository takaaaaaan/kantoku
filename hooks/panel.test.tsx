import { expect, mock, test } from 'claude-code/testing'
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
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    if (refusals > 0) {
      refusals -= 1
      throw new Error('pane held by another plugin')
    }
    opened.push(`${e.id} ${e.title}`)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { opened, clock }
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
