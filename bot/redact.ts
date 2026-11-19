// Hides token-like strings before any text leaves the server. Ordered: values
// named as secrets first, then the specific shapes, then the broad hex/base64 runs.
const HIDDEN = '[hidden]'

// A name that says "this value is a secret", with optional prefixes such as
// access_, client_, x-api-. Its value is a quoted string or the next run up to
// a space, `&` or `#`, so a URL given as the value is hidden whole.
const SECRET_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|sig|signature|(?:api|access|application|secret|private|client)[_-]?key)`
const LABELLED = new RegExp(String.raw`(?<![A-Za-z0-9])(${SECRET_NAME})([ \t]*[:=：][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"'&#]+)`, 'gi')
const LABELLED_JA = /(パスワード|暗証番号)([ \t]*[:=：][ \t]*)("[^"\n]*"|[^\s"]+)/g

const RULES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Orca's dispatch, run, task, terminal and message IDs.
  /\b(run|ctx|task|term|msg)_[0-9a-f][0-9a-f-]{7,}/g,
]

// Long hex runs are hidden. Exactly 40 digits may be a git commit id:
// - right after /commit/, /commits/, /blob/ or /tree/ it is a commit link and stays whole;
// - elsewhere in a URL it may be a credential, so it is hidden;
// - in plain text it is shown in its short 7-digit form.
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g
const COMMIT_LENGTH = 40
const COMMIT_PATH = /\/(?:commit|commits|blob|tree)\/$/i
const URL_PART = /https?:\/\/[^\s<>"'`)\]]+/g

// A long base64-like run that mixes upper case, lower case and digits. A run
// with `/` may be a URL path: it is hidden from the first part that has `+`
// or `=`, or is itself a long random-looking piece.
const BASE64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g
const looksRandom = (run: string) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)
const secretPart = (part: string) => /[+=]/.test(part) || (part.length >= 12 && looksRandom(part))

function hideHex(text: string): string {
  const urls = [...text.matchAll(URL_PART)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const)
  const inUrl = (at: number) => urls.some(([start, end]) => at >= start && at < end)

  return text.replace(HEX_RUN, (run: string, at: number) => {
    if (run.length !== COMMIT_LENGTH) return HIDDEN
    if (COMMIT_PATH.test(text.slice(Math.max(0, at - 9), at))) return run
    return inUrl(at) ? HIDDEN : run.slice(0, 7)
  })
}

function hideBase64(run: string): string {
  if (!looksRandom(run)) return run
  if (!run.includes('/')) return HIDDEN
  const parts = run.split('/')
  const first = parts.findIndex(secretPart)
  if (first < 0) return run

  return [...parts.slice(0, first), HIDDEN].join('/')
}

export function redact(text: string): string {
  let out = text.replace(LABELLED, `$1$2${HIDDEN}`).replace(LABELLED_JA, `$1$2${HIDDEN}`)
  for (const rule of RULES) out = out.replace(rule, HIDDEN)

  return hideHex(out).replace(BASE64_RUN, hideBase64)
}
