# kantoku desk design

Status: design and mockup only. Nothing is implemented yet.
Mockup: [`docs/mockups/kantoku-desk.html`](../mockups/kantoku-desk.html) (open it in a browser; all data is made up).

## Why

kantoku's long-term aim is a Grok Bot–like agent on top of Orca: it stays around, sleeps when idle, wakes on a trigger, and keeps its state and memory in files. Today the only window into a manager is its chat session and the Manager panel beside it, which shows one manager at a time. To see how every manager is doing, the user has to open each session.

The kantoku desk is one local page that shows all managers the way Grok Bot shows its bots: a list on the left, a chat of what each bot told you on the right, and an info sheet behind the bot's name.

## What the user decided (fixed)

- **Really simple, and cute like Grok Bot.** The earlier sketch (plan B in the GUI study) showed too much. The desk never shows the inner machinery: decision logs, child specs, dispatch IDs, run IDs, worktrees, verifier verdicts.
- The desk shows only what Grok Bot lets a person see and change:
  - **Description**: the bot's role and what it will not do.
  - **Skills**: the procedures, shared by every bot.
  - **Memory**: per bot, the facts it keeps and how the work got there.
  - **Routines**: instructions that run on a schedule, listed in the info sheet.
  - How a bot works underneath is not shown.
- **Version 1 is read-only.** Answering a question with a button comes in the next version. Until then the user answers in the manager's chat, as now.
- It ships in the **public kantoku repo**.
- Phone access (Tailscale) comes later.
- The user tries it locally before any PR.

## Goals

- One page lists every manager under `~/.kantoku/` with a face, `<Name>くん`, a one-line status, and a "waiting for you" mark.
- Selecting a manager shows the reports it sent to the user, oldest at the top, as chat bubbles.
- Pressing the manager's name opens an info sheet: description and "won't do", memory, routines, skills.
- It starts with one command and needs nothing else running.

## Non-goals (this version)

- Answering, approving, pausing, or editing anything from the page.
- Notifications.
- Phone layout beyond "does not break at narrow width".
- Showing children, specs, decisions, PR status, or verifier results.

## Anti-goals (a failure even if it works)

- The page shows a dispatch ID, a run ID, a worktree path, or a raw table from state.md.
- File content reaches the page as HTML (an injection path).
- The page is reachable from another machine.
- A token, key, or password that a manager wrote into a file shows up on the page.
- The desk writes to `~/.kantoku/` or to anything else.
- A second copy of a mechanism that kaizen's other proposals already define (memory, description, routines).

## Constraints

- Node with TypeScript, no npm dependencies, run with Node's built-in type stripping (Node 22.18 or newer), the same rules as kantoku-watch: erasable syntax only, `.ts` extensions on relative imports, tests with `node:test`.
- Managers write their files by hand, in Japanese or English. Every reader is lenient: a missing file or section is empty, never an error.
- Public repo: no company names, personal data, or local paths, in code, tests, fixtures, or the mockup.

## Approaches considered

| Approach | Trade-off |
|---|---|
| **A. Standalone `desk` command (chosen)** | `node desk/cli.ts` serves the page on `127.0.0.1`. No dependency on kantoku-watch. Runs only while the user wants it. Stops when the terminal closes. |
| B. A route inside the kantoku-watch daemon (PR #7) | Always on while watch runs. But watch stops itself when no PR is open, and PR #7 is being rebuilt. The desk would wait on it and inherit its lifecycle. |
| C. Grow the Manager panel mod | Already exists. But it lives inside one chat session and shows one manager, which is the problem the desk solves. |

A is chosen: it can ship before PR #7, and a later version can still mount the same handler inside a resident process if that becomes useful.

## The screen

See the mockup for the look. In words:

```
┌ kantoku desk ──────────┬───────────────────────────────────────┐
│ (•‿•) Mochiくん  [待ち]│ (•‿•) Mochiくん ▸   あなた待ち          │
│      PRの前に見てほしい│                                        │
│ (•_•) Picoくん         │        ── 11/18 ──                     │
│      テストを直している│ (•‿•) [検索の並び替えができました…]     │
│ (-_-) Soraくん         │ (•‿•) [あなたに聞きたいこと: …]         │
│      おやすみ中        │                                        │
│                        │ 返事はいつもどおり、この子のチャットで │
└────────────────────────┴───────────────────────────────────────┘
          name pressed → info sheet slides in from the right:
          description · won't do · memory · routines · skills
```

- **Bot list (left).** One row per directory under `~/.kantoku/`. Face, `<Name>くん`, one-line status, and an orange `あなた待ち` pill when something waits on the user. Rows that wait on the user sort first, then working, then sleeping; ties by name.
- **Status words.** Three only: `作業中` (working), `あなた待ち` (waiting for you), `おやすみ中` (asleep). The one-line text under the name is the first line of the latest report; with no report it is the status word.
- **Chat (right).** Only reports the manager addressed to the user. A report that asks something is an orange bubble titled `あなたに聞きたいこと`. Date separators between days. No input box; the footer says to answer in the manager's chat.
- **Info sheet.** Opens when the name in the header is pressed; closes with ✕, the backdrop, or Esc. Sections: description (with "won't do" under it), memory (fact + date), routines (name, when, what), skills (chips, marked as shared by all).
- **Cuteness.** Each bot has a round face in its own pastel color with simple eyes and mouth. The color comes from a hash of the name, so it is stable without any file. The expression follows the status: smile when waiting for you, a flat mouth while working (with three hopping dots), closed eyes when asleep. Names get `くん`. Copy is soft and short (`おやすみ中`, `返事はいつもどおり、この子のチャットで伝えてね`). Rounded system font (Hiragino Maru Gothic, BIZ UDPGothic, Yu Gothic UI fallback); no web fonts, nothing loaded from outside.
- **Language.** Labels follow the manager's language when it can be told (the `Language` section of profile.md); Japanese and English label sets ship. `くん` stays in both (it is part of the character).
- **Themes.** Light and dark from `prefers-color-scheme`.
- **Refresh.** The page re-reads every 5 seconds, like the Manager panel.

## Data shapes (decided first)

The server turns files into this and nothing else. The page renders only these fields.

```ts
type DeskBot = {
  name: string                 // directory name under ~/.kantoku/
  status: 'waiting' | 'working' | 'asleep'
  waitingCount: number         // rows whose Pending gate starts with "user:"
  line: string                 // one-line status under the name
  language: 'ja' | 'en'
  description: string          // profile: Description, else Duties
  wontDo: string[]             // profile: Won't do (empty if absent)
  memory: { fact: string; date?: string }[]       // memory.md
  routines: { name: string; when: string; what: string }[]  // profile: Routines table
  reports: { at: string; kind: 'info' | 'ask'; text: string }[]  // reports.md, newest 50
}
type Desk = { bots: DeskBot[]; skills: string[] }   // skills: union of every profile's Extra skills
```

`text` fields are plain text. The page renders them with `textContent`; the only markup it builds itself is links of the form `[label](https://…)`, created as `<a>` elements with `rel="noopener"`, and only for `http:` and `https:` URLs.

## Where each piece comes from

All reads, under `~/.kantoku/<name>/`. "New" means the desk needs a file or section that does not exist yet; each one reuses the place a kaizen proposal from the Dr. Eggbot study already defines, so no second mechanism appears.

| Piece on screen | Source today | Enough today? | Fill with |
|---|---|---|---|
| Bot list, name | directory names | Yes | — |
| Face and color | hash of the name | Yes (no file) | — |
| `作業中` / `おやすみ中` | state.md `Tasks` Status column (open vs done, same rule as the Manager panel) | Yes | — |
| `あなた待ち` | state.md `Pending gate` column | **No.** The column is free text today (`-`, `—`, `merge は人(C)`, whole sentences) | New rule: a row waiting on the user starts its Pending gate with `user:` (see below). Orca gates are read as a helper |
| Chat (reports to the user) | nowhere; reports exist only in the chat session | **No** | New `reports.md`, one dated entry per report. Matches proposal 4 ("the only ways out to the user are a report and a C question") |
| One-line status | — | No | First line of the latest `reports.md` entry |
| Description | profile.md `Duties` (1–3 sentences) | Partly: shows the job, not the character | Proposal 2: a one-paragraph `Description` section. The desk prefers it and falls back to `Duties` |
| Won't do | — | **No** | Proposal 2: `Won't do` section |
| Memory | — | **No** | Proposal 5: `memory.md`, one fact per line |
| Routines | — | **No** | Proposal 1: `Routines` table in profile.md (name, cron, task, when it stays quiet) |
| Skills | profile.md `Extra skills` | Yes | — |
| Language of labels | profile.md `Language` | Yes | — |

### "Waiting for you": the `user:` rule

Orca gates (`orca orchestration gate-list --run <run> --status pending`) are the cleanest signal, but a gate cannot be opened while a supervised dispatch is active on the task (`task_not_startable`), so many real questions to the user never become gates. The desk therefore reads state.md:

- SKILL.md "3. How to ask the user" gains one line: when the manager raises a C question, it writes the Pending gate cell of that task's row as `user: <the question in a few words>`, and clears it when the answer arrives.
- The template's Pending gate comment says the same.
- The desk counts rows whose Pending gate starts with `user:` (case-insensitive, also `ユーザー:`).
- As a helper, when state.md has a `run:` line and the `orca` command is available, the desk also reads pending gates for that run and adds those whose task is not already counted. If `orca` is missing or fails, the desk shows only the state.md count. This is a read-only call.

### `reports.md`

```md
## 2026-11-18 21:40 ask
PR を出す前に手元で試してほしいです。試し方はチャットに書きました。

## 2026-11-18 21:02
検索の並び替え(#128)ができました。PR: [#131](https://github.com/owner/repo/pull/131)
```

- One `##` heading per report: date, time, and `ask` when it asks the user something.
- The manager appends an entry every time it reports to the user (SKILL.md "6. Reporting") and every time it raises a C question. The text is what the user should read, in a few lines, without IDs.
- Newest at the top, so a human reading the file sees the latest first. The desk shows the newest 50.
- This is the first user-facing writing rule; it belongs with proposal 4 and should land with it or before it.

## Safety

- **Local only.** The server listens on `127.0.0.1` (never `0.0.0.0`) on port `4870` by default (`--port` to change). It rejects any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
- **Read only.** `GET /` (the page) and `GET /api/desk` (the JSON). Everything else gets 404 or 405. No CORS headers.
- **No file content as HTML.** The page is a static file; data arrives as JSON and is placed with `textContent`. Links are built as elements from a strict pattern. A `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'` header blocks inline injection even if a bug slips in, so the page's script and style are separate static files.
- **Secrets.** Before any text leaves the server, a redaction pass replaces token-like strings (`ghp_…`, `github_pat_…`, `sk-…`, `xox…-`, PEM blocks, long hex or base64 runs over 32 characters, `password: …`) with `[hidden]`. Sections that are never read: `Browser accounts`, `Target repos`, `External input`, `Autonomy`, `Always-ask list`.
- **Names.** Only directory names matching `^[A-Za-z0-9_-]{1,40}$` are listed, so no path tricks.
- **Size.** Files over 1 MB are skipped and the bot shows an empty section instead.

## How it fits together

```
browser ──GET /api/desk──▶ desk/server.ts ──▶ desk/read.ts ──▶ ~/.kantoku/*/ (read)
   ▲                            │                  │
   └──── page.html/js/css ──────┘                  └──▶ orca gate-list (optional, read)
```

- `desk/read.ts`: pure functions, file text in, `DeskBot` out. Most of the tests live here.
- `desk/redact.ts`: the redaction pass.
- `desk/server.ts`: `node:http`, the routes, the Host check, the headers.
- `desk/cli.ts`: `node desk/cli.ts [--port 4870] [--root <dir>]`, prints the URL, runs in the foreground until Ctrl+C.
- `desk/page/`: `index.html`, `desk.js`, `links.js` (the safe link splitter), `desk.css`, built from the mockup. The server serves exactly these four files from a fixed map.

`read.ts` does not import `hooks/parse.ts` (that file belongs to the plugin mod's runtime). It reuses the same rules for sections and the done-status words; a test reads the real templates so the two cannot drift.

## Dependence on kantoku-watch (PR #7)

| Part | Depends on PR #7? |
|---|---|
| `desk/` code, page, tests | No. Runs alone |
| SKILL.md and template changes (`user:` rule, `reports.md`) | Only for merge order: PR #7 also edits `SKILL.md` and both templates, so this lands after PR #7 or is rebased onto it |
| README section | Same as above (README changes in PR #7) |
| Starting the desk from a resident process | Out of scope. If wanted later, `server.ts` exports a handler that the watch daemon can mount |

## Left to the builder

- Exact pastel palette and the hash-to-color mapping (keep contrast of the face features in both themes).
- English label wording.
- Whether `reports.md` entries keep only the first paragraph in the list's one-line status (a sensible default: first non-empty line, cut at 60 characters).

## Calls made by the designer (the user can overturn them)

- Port `4870`.
- Skills shown are the union of `Extra skills` across profiles, not every installed skill. Installed skills include private ones and would be noise.
- The desk refreshes every 5 seconds, the same as the panel.
- The newest 50 reports per bot.
