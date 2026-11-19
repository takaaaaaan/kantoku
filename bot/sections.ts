// Markdown helpers shared by the readers. Managers write these files by hand,
// so everything here is lenient: no match gives an empty value.

export type Section = { heading: string; start: number; end: number; body: string }

// Every `## ` section with character offsets into `text`: `start` is the start of
// the heading line, `end` the start of the next heading (or the end of the text),
// and `body` everything after the heading line up to `end`.
export function sectionsOf(text: string): Section[] {
  const sections: Section[] = []
  const heading = /^##[ \t]+(.*?)[ \t]*\r?$/gm
  const found: { heading: string; start: number; bodyStart: number }[] = []
  for (let match = heading.exec(text); match; match = heading.exec(text)) {
    const lineEnd = text.indexOf('\n', match.index)
    found.push({ heading: match[1] ?? '', start: match.index, bodyStart: lineEnd < 0 ? text.length : lineEnd + 1 })
  }
  found.forEach((section, at) => {
    const end = found[at + 1]?.start ?? text.length
    sections.push({ heading: section.heading, start: section.start, end, body: text.slice(section.bodyStart, end) })
  })

  return sections
}

// Comments become spaces of the same newline count, so line numbers stay put.
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ''))
}

export function linesOf(body: string): string[] {
  return stripComments(body)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
}

export function bodyOf(text: string, heading: RegExp): string | undefined {
  return sectionsOf(text).find(section => heading.test(section.heading))?.body
}

export function bulletsOf(body: string): string[] {
  return linesOf(body)
    .filter(line => /^[-*][ \t]+/.test(line))
    .map(line => line.replace(/^[-*][ \t]+/, '').trim())
    .filter(item => item !== '')
}

export function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.replace(/\\\|/g, '|').trim())
}

const isTableLine = (line: string) => line.trim().startsWith('|')
const isRuleLine = (line: string) => /^\|[\s|:-]+\|?$/.test(line.trim())

// The header row (right above the |---| rule) and the data rows below it.
export function tableOf(body: string): { header: string[]; rows: string[][] } {
  const lines = linesOf(body)
  const rule = lines.findIndex(isRuleLine)
  const above = lines[rule - 1]
  if (rule < 1 || above === undefined || !isTableLine(above)) return { header: [], rows: [] }
  const rows: string[][] = []
  for (const line of lines.slice(rule + 1)) {
    if (!isTableLine(line)) break
    const cells = cellsOf(line)
    if (cells.some(cell => cell !== '')) rows.push(cells)
  }

  return { header: cellsOf(above), rows }
}

export function columnOf(header: string[], name: RegExp, fallback: number): number {
  const at = header.findIndex(cell => name.test(cell))

  return at < 0 ? fallback : at
}
