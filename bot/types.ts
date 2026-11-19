// The shapes kantoku bot page reads. See docs/specs/2026-11-19-kantoku-bot-design.md "Data shapes".

export type Status = 'waiting' | 'working' | 'asleep'
export type Language = 'ja' | 'en'

export type Routine = { name: string; when: string; what: string }
export type Choice = { label: string; recommended: boolean }
export type MemoryLine = { id: string; fact: string; date?: string }

export type TalkItem =
  | { kind: 'report'; at: string; text: string }
  | { kind: 'ask'; at: string; id: string; text: string; choices: Choice[]; answer?: string }
  | { kind: 'mine'; at: string; id: string; text: string; delivery: 'sent' | 'queued' | 'read' }

export type Bot = {
  name: string
  status: Status
  line: string
  language: Language
  awake: boolean
  description: string
  wontDo: string[]
  memory: MemoryLine[]
  routines: Routine[]
  talk: TalkItem[]
  version: { profile: string; memory: string }
}

export type Bots = { bots: Bot[]; skills: string[] }

// One line of <home>/bot/from-user.jsonl.
export type Entry = {
  id: string
  at: string
  type: 'say' | 'answer' | 'edited' | 'delivered'
  text?: string
  ask?: string
  what?: string
  delivery?: 'sent' | 'queued'
}
