// profile.md → the parts kantoku bot shows. Sections such as Target repos, Autonomy,
// Browser accounts or External input are never read.
import { bodyOf, bulletsOf, columnOf, linesOf, tableOf } from './sections.ts'
import type { Language, Routine } from './types.ts'

export const DESCRIPTION_HEADING = /^(description\b|説明)/i
export const WONT_DO_HEADING = /^(won'?t do\b|やらないこと)/i
const DUTIES_HEADING = /^(duties\b|担当業務)/i
const ROUTINES_HEADING = /^(routines?\b|ルーティン)/i
const SKILLS_HEADING = /^(extra skills\b|追加 ?skill)/i
const LANGUAGE_HEADING = /^(language\b|言語)/i

export type ProfileView = {
  description: string
  wontDo: string[]
  routines: Routine[]
  extraSkills: string[]
  language: Language
}

export function parseProfile(text: string): ProfileView {
  return {
    description: descriptionOf(text),
    wontDo: bulletsOf(bodyOf(text, WONT_DO_HEADING) ?? ''),
    routines: routinesOf(bodyOf(text, ROUTINES_HEADING) ?? ''),
    extraSkills: skillsOf(bodyOf(text, SKILLS_HEADING) ?? ''),
    language: languageOf(text),
  }
}

function paragraph(body: string | undefined): string {
  return linesOf(body ?? '')
    .join('\n')
    .trim()
}

function descriptionOf(text: string): string {
  return paragraph(bodyOf(text, DESCRIPTION_HEADING)) || paragraph(bodyOf(text, DUTIES_HEADING))
}

function routinesOf(body: string): Routine[] {
  const { header, rows } = tableOf(body)
  const name = columnOf(header, /^(name|名前)/i, 0)
  const when = columnOf(header, /^(when|いつ|時)/i, 1)
  const what = columnOf(header, /^(task|what|やること|内容|タスク)/i, 2)

  return rows.map(cells => ({ name: cells[name] ?? '', when: cells[when] ?? '', what: cells[what] ?? '' }))
}

function skillsOf(body: string): string[] {
  const names = [...linesOf(body).join('\n').matchAll(/`([^`\n]+)`/g)].map(match => (match[1] ?? '').trim())

  return [...new Set(names.filter(name => name !== ''))]
}

function languageOf(text: string): Language {
  const said = paragraph(bodyOf(text, LANGUAGE_HEADING))
  if (said !== '') return /日本語|japanese/i.test(said) ? 'ja' : 'en'

  return /[぀-ヿ]/.test(linesOf(text).join('\n')) ? 'ja' : 'en'
}
