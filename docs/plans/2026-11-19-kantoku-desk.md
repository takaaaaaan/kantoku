# kantoku desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only local page (`node desk/cli.ts`) that lists every kantoku manager like Grok Bot lists its bots, shows each one's reports to the user as a chat, and opens an info sheet with description, memory, routines, and skills.

**Architecture:** Pure readers turn `~/.kantoku/<name>/` files into a `Desk` JSON value; a redaction pass runs over every string; a `node:http` server on `127.0.0.1` serves that JSON and three static page files. The page renders with `textContent` only.

**Tech Stack:** Node 22.18+ with built-in type stripping, TypeScript (erasable syntax only), `node:test`, `node:http`. No npm dependencies.

**Spec:** [`docs/specs/2026-11-19-kantoku-desk-design.md`](../specs/2026-11-19-kantoku-desk-design.md). Mockup: [`docs/mockups/kantoku-desk.html`](../mockups/kantoku-desk.html).

## Global Constraints

- Node 22.18 or newer runs `.ts` directly. Erasable syntax only: `type` / `import type`, no `enum`, no `namespace`, no parameter properties. Relative imports end in `.ts`.
- No npm dependencies. Tests: `node --test desk/`.
- Every reader is lenient: a missing file or section gives an empty value, never a throw.
- The desk never writes anywhere.
- Server listens on `127.0.0.1`, default port `4870`, `--port` to change.
- Never put on the page: dispatch IDs, run IDs, worktree paths, raw state.md tables, and the profile sections `Browser accounts`, `Target repos`, `External input`, `Autonomy`, `Always-ask list`.
- Public repo: no company names, personal data, or local paths in code, tests, fixtures, or docs. Check with the maintainer's private-word search (company names, personal names, home paths) over `desk/` and `docs/` → 0 hits.
- Bump `.claude-plugin/plugin.json` `version` on every push.

## Review Focus

1. **A report or memory line containing `<script>` or `<img onerror>`** → shows as literal text. Pinned in Task 5 (page) by the `escapes markup` check, and in Task 4 by the CSP header test.
2. **A manager wrote a GitHub token into state.md or reports.md** → `[hidden]` on the page. Pinned in Task 3.
3. **A request with `Host: evil.example:4870`** (DNS rebinding) → 403. Pinned in Task 4.
4. **A Japanese-only profile with `## 担当業務` and a 待っている gate column** → still parsed. Pinned in Task 1 with a Japanese fixture.
5. **A directory with no profile.md, or a stray file like `notes.txt` under `~/.kantoku/`** → the directory shows with empty sections; the file is ignored. Pinned in Task 2's `buildDesk` tests.

---

## File structure

| File | Responsibility |
|---|---|
| `desk/types.ts` | `DeskBot`, `Desk`, `Report`, `Routine`, `MemoryItem` types (copied from the spec's "Data shapes") |
| `desk/sections.ts` | Split markdown into `##` sections, read tables and bullets; comment stripping |
| `desk/profile.ts` | profile.md → description, wontDo, routines, extraSkills, language |
| `desk/state.ts` | state.md → status, waitingCount, run id (run id stays server-side) |
| `desk/notes.ts` | reports.md and memory.md readers |
| `desk/redact.ts` | Secret redaction |
| `desk/desk.ts` | `buildDesk(root, opts)`: walks `~/.kantoku/`, assembles and redacts |
| `desk/server.ts` | Routes, Host check, headers |
| `desk/cli.ts` | Argument parsing, start, print URL |
| `desk/page/index.html`, `desk.js`, `desk.css` | The page, from the mockup |
| `desk/fixtures/` | Made-up `~/.kantoku/` trees for tests |

---

### Task 1: Read profile.md and state.md

**Files:**
- Create: `desk/types.ts`, `desk/sections.ts`, `desk/profile.ts`, `desk/state.ts`
- Test: `desk/profile.spec.ts`, `desk/state.spec.ts`

**Interfaces:**
- Produces:
  - `parseProfile(text: string): { description: string; wontDo: string[]; routines: Routine[]; extraSkills: string[]; language: 'ja' | 'en' }`
  - `parseState(text: string): { status: 'waiting' | 'working' | 'asleep'; waitingCount: number; waitingTasks: string[]; run?: string }`
  - `type Routine = { name: string; when: string; what: string }`

- [ ] **Step 1: Write failing tests**

`profile.spec.ts`:
- `description prefers Description over Duties`: profile with `## Description\nA paragraph.` and `## Duties\nShort.` → `description === 'A paragraph.'`.
- `description falls back to Duties` (English) and `担当業務` (Japanese) → the whole section text, comments stripped.
- `wontDo reads bullets` under `## Won't do` or `## やらないこと` → array of bullet texts.
- `routines reads the table` under `## Routines` / `## ルーティン` with header `| Name | When | Task | Quiet when |` → `[{ name, when, what: <Task cell> }]`.
- `extraSkills reads backticked names and bullets` under `## Extra skills` / `## 追加 skill`: `- skill の書き方: superpowers \`writing-skills\`` → `['writing-skills']`.
- `language`: `## Language` / `## 言語` text containing `日本語` or `Japanese` → `'ja'`, otherwise `'en'`; missing → `'ja'` if the file has any kana, else `'en'`.
- `never returns hidden sections`: the result object has exactly the five keys above (`assert.deepEqual(Object.keys(r).sort(), [...])`).
- `templates parse`: reading `skills/kantoku/templates/profile.md` gives `description === ''` and no throw.

`state.spec.ts`:
- `working when an open task exists`: one row with Status `in progress` → `'working'`.
- `asleep when every row is done`: Status `done`, `merged`, `完了: ...`, `merge 済` → `'asleep'`. `完了待ち` counts as open.
- `waiting when a Pending gate starts with user:`: cells `user: PR を試して`, `User: x`, `ユーザー: y` → `status === 'waiting'`, `waitingCount === 3`.
- `free-text gates are not waiting`: `-`, `—`, `merge は人(C)`, `team-bot 移動待ち` → `waitingCount === 0`.
- `Japanese headings`: `## タスク` with `| タスク | ... | 状態 | 待っている gate |` parses the same.
- `run line`: `run: run_123` → `run === 'run_123'`.
- `template parses`: `skills/kantoku/templates/state.md` → `'asleep'`, `0`.

- [ ] **Step 2: Run `node --test desk/` → FAIL (modules missing)**

- [ ] **Step 3: Implement** `sections.ts` (strip `<!-- -->`, split on `^##\s+`, `tableRows(lines)` returning header + rows of trimmed cells, `bullets(lines)`), then `profile.ts` and `state.ts`. Heading matching is a case-insensitive regex per section, English and Japanese, like `hooks/parse.ts`. Done-status regex is the one in `hooks/parse.ts` (`DONE_STATUS`), copied, not imported. `waitingTasks` holds the first cell of each `user:` row (used by Task 2 to drop duplicates with Orca gates).

- [ ] **Step 4: Run `node --test desk/` → PASS**

- [ ] **Step 5: Commit** `✨ feat: kantoku デスクが profile と state を読む`

**Evidence:** `node --test desk/` output with all tests passing, pasted in the task report.

---

### Task 2: Reports, memory, and the whole desk

**Files:**
- Create: `desk/notes.ts`, `desk/desk.ts`, `desk/fixtures/home/{Mochi,Pico,Sora}/...`, `desk/fixtures/home/notes.txt`
- Test: `desk/notes.spec.ts`, `desk/desk.spec.ts`

**Interfaces:**
- Consumes: Task 1's `parseProfile`, `parseState`.
- Produces:
  - `parseReports(text: string): Report[]` with `type Report = { at: string; kind: 'info' | 'ask'; text: string }`, newest first, at most 50.
  - `parseMemory(text: string): MemoryItem[]` with `type MemoryItem = { fact: string; date?: string }`.
  - `buildDesk(root: string, opts?: { gates?: (run: string) => Promise<string[]> }): Promise<Desk>`. `gates` returns the task titles of pending Orca gates for a run; default is none.

- [ ] **Step 1: Write failing tests**

`notes.spec.ts`:
- `reports split on headings`: `## 2026-11-18 21:40 ask\nText A\n\n## 2026-11-18 21:02\nText B` → `[{ at: '2026-11-18 21:40', kind: 'ask', text: 'Text A' }, { at: '2026-11-18 21:02', kind: 'info', text: 'Text B' }]`.
- `reports sorted newest first` even when the file is out of order.
- `reports capped at 50`: 60 entries → length 50, newest kept.
- `memory one fact per bullet`: `- main は自動で本番に出る (2026-11-12)` → `{ fact: 'main は自動で本番に出る', date: '2026-11-12' }`; a bullet without a date has no `date`.
- `empty input` → `[]` for both.

`desk.spec.ts` (fixture tree: Mochi has a `user:` row and reports; Pico has an open task; Sora has only done rows and no reports.md; `bad name!` directory; `notes.txt` file; Pico's memory.md is 2 MB):
- `lists valid directories only`: names `['Mochi', 'Pico', 'Sora']`.
- `sorted waiting, working, asleep`.
- `line is the first line of the newest report, cut at 60 chars`; Sora's line is `'おやすみ中'` (Japanese) .
- `missing profile.md` (add `Empty/` with no files) → bot present, `description === ''`.
- `files over 1 MB are skipped`: Pico's `memory` is `[]`.
- `skills is the sorted union of extraSkills`.
- `gates add only new tasks`: `gates` returns `['Task A', 'Task B']` where Mochi's `waitingTasks` has `Task A` → `waitingCount === 2`.
- `gates failure is ignored`: `gates` rejects → same result as without it.
- `no internal fields`: `JSON.stringify(desk)` does not match `/ctx_|task_[0-9a-f]|run_|worktree/`.

- [ ] **Step 2: Run `node --test desk/` → FAIL**
- [ ] **Step 3: Implement** `notes.ts`, then `buildDesk`: `readdir` with `withFileTypes`, name filter `^[A-Za-z0-9_-]{1,40}$`, `stat` size check (`> 1_048_576` → treat as empty), every read wrapped so errors give `''`. Calls `redact` from Task 3 on every string field (stub it as identity in this task; Task 3 swaps in the real one).
- [ ] **Step 4: Run `node --test desk/` → PASS**
- [ ] **Step 5: Commit** `✨ feat: kantoku デスクが報告と記憶を読み、全員分をまとめる`

**Evidence:** test output; `node -e` one-liner printing `buildDesk('desk/fixtures/home')` JSON, pasted.

---

### Task 3: Hide secrets

**Files:**
- Create: `desk/redact.ts`
- Modify: `desk/desk.ts` (use the real `redact`)
- Test: `desk/redact.spec.ts`

**Interfaces:**
- Produces: `redact(text: string): string`

- [ ] **Step 1: Write failing tests** — each input becomes text containing `[hidden]` and not the secret:
  `ghp_` + 36 alphanumerics; `github_pat_` + 80 chars; `sk-` + 40 chars; `xoxb-123-456-abc`; a `-----BEGIN PRIVATE KEY-----` … `-----END PRIVATE KEY-----` block; a 40-char hex run; a 44-char base64 run; `password: hunter2` and `パスワード: hunter2`.
  Kept unchanged: `PR #131`, a 7-char SHA `9ddeb65`, a URL `https://github.com/owner/repo/pull/131`, a date.
  `desk.spec.ts` gains `secrets never reach the desk`: a fixture report containing a `ghp_` token → `JSON.stringify(desk)` has no `ghp_`.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** as an ordered list of regexes. The hex/base64 rule needs at least 32 characters so short SHAs survive.
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `🔒 feat: kantoku デスクで秘密らしい文字列を隠す`

**Evidence:** test output.

---

### Task 4: Local read-only server and command

**Files:**
- Create: `desk/server.ts`, `desk/cli.ts`
- Test: `desk/server.spec.ts`, `desk/cli.spec.ts`

**Interfaces:**
- Consumes: `buildDesk`.
- Produces:
  - `createDeskServer(opts: { root: string; port: number; pageDir: string; gates?: (run: string) => Promise<string[]> }): import('node:http').Server`
  - `orcaGates(run: string): Promise<string[]>` in `server.ts`: runs `orca orchestration gate-list --run <run> --status pending --json` with `execFile` (no shell), 5 s timeout, returns task titles; any failure → `[]`.
  - `parseArgs(argv: string[]): { port: number; root: string }` in `cli.ts`; default port `4870`, root `~/.kantoku`; `--root <dir>` overrides the root (used for trying the page on fixtures).

- [ ] **Step 1: Write failing tests** (server on port 0, fixture root):
  - `GET /api/desk` → 200, `content-type: application/json; charset=utf-8`, body parses to a `Desk` with 3 bots.
  - `GET /` → 200 HTML; `GET /desk.js`, `GET /links.js`, `GET /desk.css` → 200 with the right types.
  - `GET /../profile.md`, `GET /Mochi/state.md` → 404.
  - `POST /api/desk` → 405.
  - `Host: evil.example:<port>` → 403; `Host: localhost:<port>` and `127.0.0.1:<port>` → 200.
  - every response has `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'`, `x-content-type-options: nosniff`, `cache-control: no-store`, and no `access-control-allow-origin`.
  - `listens on loopback only`: `server.address().address === '127.0.0.1'`.
  - `cli.spec.ts`: `parseArgs([])` → port 4870 and root ending in `.kantoku`; `['--root', 'desk/fixtures/home']` → that root; `['--port', '5000']` → 5000; `['--port', 'x']` throws `--port needs a number`.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** Static files come from a fixed map of four names (`/`, `/desk.js`, `/links.js`, `/desk.css`), never from the request path. `cli.ts` prints `kantoku desk: http://127.0.0.1:<port>/` and runs until Ctrl+C; port in use → prints `port <port> is in use; try --port <n>` and exits 1.
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `✨ feat: kantoku デスクを localhost だけで開く`

**Evidence:** test output; `curl -s -H "Host: evil.example:4870" -o /dev/null -w "%{http_code}" http://127.0.0.1:4870/api/desk` → `403`, pasted.

---

### Task 5: The page

**Files:**
- Create: `desk/page/index.html`, `desk/page/desk.js`, `desk/page/links.js`, `desk/page/desk.css`
- Test: `desk/page.spec.ts`

**Interfaces:**
- Consumes: `GET /api/desk` returning `Desk`.
- Produces: nothing for other tasks.

- [ ] **Step 1: Write failing tests** (static checks; no browser in CI):
  - `no inline script or style`: `index.html` has no `<script>` body and no `style=` / `<style>`; it loads `desk.js`, `links.js`, and `desk.css` only.
  - `no innerHTML`: `desk.js` does not contain `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`.
  - `links are http(s) only`: `desk.js` exports nothing, so test the link splitter by extracting it into `desk/page/links.js` (plain JS module also loaded by the page): `splitLinks('see [PR](https://x/1) and [bad](javascript:alert(1))')` → `[{text:'see '},{text:'PR',href:'https://x/1'},{text:' and [bad](javascript:alert(1))'}]`.
  - `no external loads`: no `http://` or `https://` in `index.html` or `desk.css`.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** by moving the mockup's look into the three files: the face SVG built with `createElementNS`, status → expression (`waiting` smile, `working` flat mouth + hopping dots, `asleep` closed eyes), color from a string hash of the name over a fixed pastel list, labels in Japanese and English chosen by `bot.language`, refresh every 5 s, keep the selected bot across refreshes, info sheet with ✕ / backdrop / Esc, `prefers-reduced-motion` respected, narrow layout under 720 px.
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Look at it.** `node desk/cli.ts --root desk/fixtures/home`, open in a browser, take one screenshot in light and one in dark, and one with the info sheet open. Add a fixture report containing `<img src=x onerror=alert(1)>` and confirm it shows as text.
- [ ] **Step 6: Commit** `✨ feat: kantoku デスクの画面`

**Evidence:** test output; the three screenshots attached to the report; a line confirming the `<img onerror>` text showed as text.

---

### Task 6: Rules for managers, README, version (depends on PR #7)

Do this task after PR #7 (kantoku-watch) merges, or rebase onto it: both change `SKILL.md`, the two templates, and `README.md`.

**Files:**
- Modify: `skills/kantoku/SKILL.md` ("3. How to ask the user", "6. Reporting", the folder diagram), `skills/kantoku/templates/state.md` (Pending gate comment), `README.md` (a "kantoku desk" section), `.claude-plugin/plugin.json` (minor version bump)
- Create: `skills/kantoku/templates/reports.md`
- Test: `desk/templates.spec.ts`

**Interfaces:**
- Consumes: `parseState`, `parseReports`.

- [ ] **Step 1: Write failing tests:** `templates/reports.md` parses with `parseReports` to `[]`; the state template's Pending gate comment contains `user:`; `SKILL.md` contains `reports.md` and `user:`.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Edit.**
  - SKILL.md "3. How to ask the user", lane C: after raising the question, write the task row's Pending gate as `user: <the question in a few words>`; clear it when the answer comes. Also append an `ask` entry to `reports.md`.
  - SKILL.md "6. Reporting": every report to the user is also appended to `<home>/reports.md` as a `## YYYY-MM-DD HH:MM` entry, newest at the top, a few lines, no IDs.
  - Folder diagram: add `reports.md` (and `memory.md` only if proposal 5 has already landed; otherwise leave it to that change).
  - README: what the desk is, `node <plugin root>/desk/cli.ts`, that it is read-only and local-only, and which files fill which part (the table from the spec, in user words).
  - Description, Won't do, Routines, and memory.md templates are **not** added here; they come from proposals 2, 1, and 5. The desk already shows them when present.
- [ ] **Step 4: Run `node --test desk/` → PASS; `jq . .claude-plugin/*.json` succeeds; the private-word search → 0 hits**
- [ ] **Step 5: Commit** `📝 docs: マネージャーが報告と「あなた待ち」を書く決まりと、デスクの README`

**Evidence:** test output, `jq` output, `rg` output (0 hits), the diff of SKILL.md sections.

---

### Task 7: Hand to the user for a local try

**Files:** none (push only).

- [ ] **Step 1:** Push the branch. Write the try-it steps: copy-paste commands that run the desk from the branch without touching the installed plugin (`git -C <clone> fetch && git -C <clone> worktree add <tmp> <branch>`, then `node <tmp>/desk/cli.ts`), what to look at, and how to undo (`Ctrl+C`, `git worktree remove <tmp>`).
- [ ] **Step 2:** `orca orchestration ask` with those steps and stop. A PR is opened only after the user says OK.

**Evidence:** pushed SHA; the user's OK (or the fixes made) recorded in the report.

---

## Dependencies

- Tasks 1 → 2 → 3 → 4 → 5 in order (each consumes the previous Interfaces).
- Task 6 depends on PR #7 being merged (shared files), and on Tasks 1–2 for its tests.
- Task 7 is last.
- Tasks 1–5 do not depend on PR #7 and can ship as their own PR first if PR #7 is still open; Task 6 then follows as a small second PR.
