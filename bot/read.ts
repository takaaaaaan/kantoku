// Every manager under the root → the Bots value the page reads.
// Only the parts the page shows leave this file, and every string passes redact().
import { HANDLED_FILE, LOG_FILE, SECRET_REQUESTS_FILE } from './paths.ts'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashOf, parseHandled, parseLog, parseMemory, parseReports } from './notes.ts'
import type { Report } from './notes.ts'
import { parseProfile } from './profile.ts'
import { redact } from './redact.ts'
import { RECIPES, parseSecretRequests, secretItems } from './secret.ts'
import type { Recipe, SecretItem } from './secret.ts'
import { parseState } from './state.ts'
import type { Bots, Bot, Entry, Language, Status, TalkItem } from './types.ts'

export const BOT_NAME = /^[A-Za-z0-9_-]{1,40}$/
export const MAX_FILE = 1_048_576
const MAX_TALK = 100
const LINE_LENGTH = 60

export const STATUS_WORDS: Record<Language, Record<Status, string>> = {
  ja: { waiting: 'あなた待ち', working: '作業中', asleep: 'おやすみ中' },
  en: { waiting: 'waiting for you', working: 'working', asleep: 'asleep' },
}

const RANK: Record<Status, number> = { waiting: 0, working: 1, asleep: 2 }

// A missing, unreadable or too large file reads as ''.
export async function readSmall(file: string): Promise<string> {
  try {
    if ((await stat(file)).size > MAX_FILE) return ''
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

export async function botNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && BOT_NAME.test(entry.name)).map(entry => entry.name)
  } catch {
    return []
  }
}

export async function buildBots(root: string, now: Date = new Date(), recipes: Record<string, Recipe> = RECIPES): Promise<Bots> {
  const bots: Bot[] = []
  const skills = new Set<string>()
  const built = await Promise.all((await botNames(root)).map(name => buildBot(join(root, name), name, now, recipes)))
  for (const { bot, extraSkills } of built) {
    bots.push(bot)
    for (const skill of extraSkills) skills.add(redact(skill))
  }
  bots.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return { bots, skills: [...skills].sort() }
}

async function buildBot(home: string, name: string, now: Date, recipes: Record<string, Recipe>): Promise<{ bot: Bot; extraSkills: string[] }> {
  const read = (file: string) => readSmall(join(home, file))
  const [profileText, stateText, reportsText, memoryText, logText, handledText, secretsText] = await Promise.all([
    read('profile.md'),
    read('state.md'),
    read('reports.md'),
    read('memory.md'),
    read(LOG_FILE),
    read(HANDLED_FILE),
    read(SECRET_REQUESTS_FILE),
  ])
  const profile = parseProfile(profileText)
  const state = parseState(stateText)
  const log = parseLog(logText)
  const secrets = secretItems(parseSecretRequests(secretsText, recipes), log, now.getTime())
  const talk = talkOf(parseReports(reportsText), log, parseHandled(handledText), secrets)
  const unanswered = talk.some(item => (item.kind === 'ask' && item.answer === undefined) || (item.kind === 'secret' && item.state === 'open'))
  const status: Status = state.status === 'waiting' || unanswered ? 'waiting' : state.status
  const newest = [...talk].reverse().find(item => item.kind === 'report' || item.kind === 'ask')

  const bot: Bot = {
    name,
    status,
    line: newest ? lineOf(newest.text) : STATUS_WORDS[profile.language][status],
    language: profile.language,
    awake: state.run !== undefined,
    description: redact(profile.description),
    wontDo: profile.wontDo.map(redact),
    memory: parseMemory(memoryText).map(({ id, fact, date }) => (date === undefined ? { id, fact: redact(fact) } : { id, fact: redact(fact), date })),
    routines: profile.routines.map(r => ({ name: redact(r.name), when: redact(r.when), what: redact(r.what) })),
    talk: talk.slice(-MAX_TALK).map(redactItem),
    version: { profile: hashOf(profileText), memory: hashOf(memoryText) },
  }

  return { bot, extraSkills: profile.extraSkills }
}

function lineOf(text: string): string {
  const first = redact(text.split('\n')[0] ?? '').trim()
  const chars = [...first]

  return chars.length > LINE_LENGTH ? chars.slice(0, LINE_LENGTH - 1).join('') + '…' : first
}

// Reports, secret cards and kantoku bot log in time order. Answers attach to
// their ask; an answer to an ask that is not in reports.md shows as the user's
// bubble. Secret results live on their card, never as a bubble.
function talkOf(reports: Report[], log: Entry[], handled: Set<string>, secrets: SecretItem[]): TalkItem[] {
  const asks = new Map<string, Extract<TalkItem, { kind: 'ask' }>>()
  for (const report of reports) if (report.kind === 'ask') asks.set(report.id, report)
  const delivered = new Set(log.filter(entry => entry.type === 'delivered').map(entry => entry.id))
  const mine: TalkItem[] = []
  for (const entry of log) {
    if (entry.type === 'delivered' || entry.type === 'secret-done' || entry.type === 'secret-expired') continue
    const ask = entry.type === 'answer' && entry.ask !== undefined ? asks.get(entry.ask) : undefined
    if (ask) {
      if (ask.answer === undefined) ask.answer = entry.text ?? ''
      continue
    }
    const delivery = handled.has(entry.id) ? 'read' : entry.delivery === 'sent' || delivered.has(entry.id) ? 'sent' : 'queued'
    mine.push({ kind: 'mine', at: entry.at, id: entry.id, text: entry.text ?? '', delivery })
  }
  const time = (item: TalkItem) => {
    const ms = Date.parse(item.at)
    return Number.isNaN(ms) ? 0 : ms
  }

  return [...reports, ...secrets, ...mine].map((item, order) => ({ item, order })).sort((a, b) => time(a.item) - time(b.item) || a.order - b.order).map(({ item }) => item)
}

function redactItem(item: TalkItem): TalkItem {
  // The command is built from the recipe table only, so it is shown exactly as it runs.
  if (item.kind === 'secret') {
    const card: TalkItem = { ...item, label: redact(item.label), description: redact(item.description) }
    if (item.reason !== undefined) card.reason = redact(item.reason)
    return card
  }
  if (item.kind === 'ask') {
    const ask: TalkItem = { ...item, text: redact(item.text), choices: item.choices.map(c => ({ ...c, label: redact(c.label) })) }
    if (item.answer !== undefined) ask.answer = redact(item.answer)
    return ask
  }

  return { ...item, text: redact(item.text) }
}
