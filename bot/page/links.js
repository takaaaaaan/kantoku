// Splits text into plain parts and [label](http(s)://…) links.
// Only http and https become links; everything else stays text.
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g

/** @param {string} text @returns {{ text: string, href?: string }[]} */
export function splitLinks(text) {
  const parts = []
  let last = 0
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at) })
    parts.push({ text: match[1], href: match[2] })
    last = at + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })

  return parts
}
