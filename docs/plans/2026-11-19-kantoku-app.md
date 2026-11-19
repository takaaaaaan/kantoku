# kantoku app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** kantoku bot installs as an app on the PC (own window, badge, two kinds of OS notification, push while closed), and a paired phone reaches it through Tailscale Serve to read, say, and answer.

**Architecture:** The existing page gains a manifest and a service worker. A pure `notices.ts` turns the `Bots` value into "waiting" and "done" notices; the page shows them while open and `webpush.ts` (VAPID plus `aes128gcm` on `node:crypto`) sends them while closed. For the phone, a second loopback listener (`remote.ts`, port 4871) sits behind `tailscale serve`, checks Host, the Tailscale owner login, a request check on every POST, a paired-device cookie, and a PIN on every write, and mounts only the read, say, and answer routes.

**Tech Stack:** Node 22.18+ with type stripping, TypeScript (erasable syntax only), `node:test`, `node:http`, `node:crypto`. No npm dependencies. Browser: Web App Manifest, Service Worker, Notifications, Push API.

**Spec:** [`docs/specs/2026-11-19-kantoku-app-design.md`](../specs/2026-11-19-kantoku-app-design.md). Mockup: [`docs/mockups/kantoku-bot-mobile.html`](../mockups/kantoku-bot-mobile.html). Base: [kantoku bot plan](2026-11-19-kantoku-bot.md) and the secret card (issue #10), both merged before this starts.

## Global Constraints

- Everything in the kantoku bot plan's Global Constraints still holds (Node 22.18+, erasable syntax, `.ts` imports, no npm dependencies, `node --test bot/`, lenient readers, no user text on a command line, the never-shown list, public-repo word check → 0 hits, bump `.claude-plugin/plugin.json` `version` on every push).
- Both listeners bind `127.0.0.1` only. Local port `4870`, remote port `4871`.
- kantoku bot's own root folder is `~/.kantoku/.bot/` (`notified.json`, `vapid.json`, `push.json`, `devices.json`). A directory whose name starts with `.` is never listed as a manager.
- Notifications: two kinds only, `waiting` and `done`. Titles `<name> があなた待ち` / `<name> の仕事ができました` (English: `<name> is waiting for you` / `<name> finished something`). Body is a fixed phrase (`開いて答えてください` / `開いて見てください`); no text from the files ever goes into a notification or a push.
- Phone: pairing code 6 digits, 10 minutes, 5 tries per code. PIN 4 to 8 digits, scrypt, sent with every write and never stored by the page, 5 wrong in a row removes the device. Every remote POST needs Origin `https://<remote-host>`, `Content-Type: application/json`, and `X-Kantoku-Bot: 1`, checked before any route. Device cookie `__Host-kb_device`, Secure, HttpOnly, SameSite=Strict, Path=/, 30 days from last use.
- The remote listener never serves the local per-start token, the secret routes, the edit routes, or pairing management.
- kantoku bot never runs `tailscale` or changes OS or network settings. It prints the `tailscale serve` command for the user.

## Review Focus

1. **A request through Tailscale Funnel or from a tagged device** (no `Tailscale-User-Login`) → 403 before any route runs. Pinned in Task 9.
2. **The service worker serves a cached page after kantoku bot restarts with a new token** → the page must fetch a fresh token, not keep the old one, so writes still work. Pinned in Task 3.
3. **reports.md is edited by hand (a typo fixed in an old report)** → no repeat notification for it. Pinned in Task 2.
4. **The PC is asleep or kantoku bot is stopped while the phone is open** → the phone shows `PC に届きません` and keeps unsent text in the box; nothing is lost or sent twice. Pinned in Task 12.
5. **Someone types wrong PINs on the user's phone** → after 5 the device is removed and must pair again from the PC; the user is told this on the PIN sheet before the last try. Pinned in Task 11.

---

## File structure

| File | Responsibility |
|---|---|
| `bot/page/manifest.webmanifest`, `bot/page/icon-192.png`, `bot/page/icon-512.png` | Install metadata and icons |
| `bot/page/sw.js` | Shell cache, notifications, click to open, push |
| `bot/notices.ts` | `Bots` + seen ids → notices, badge count |
| `bot/store.ts` | Read and write small JSON files under `~/.kantoku/.bot/` atomically |
| `bot/webpush.ts` | VAPID JWT, `aes128gcm` encryption, send |
| `bot/loginitem.ts` | Write and remove the OS login-item file |
| `bot/devices.ts` | Pairing codes, device records, PIN hashing and lockout |
| `bot/remote.ts` | Remote listener, its checks and route table |
| `bot/server.ts` | Serves new page files; exports shared route handlers |
| `bot/cli.ts` | New flags |

---

## Stage 1: Desktop app

### Task 1: Spike — PWA and push on `http://127.0.0.1`

**Files:** none committed except a "Spike result" note in the spec.

- [ ] **Step 1:** Serve a throwaway page with a manifest and a service worker on `127.0.0.1:4899` under the current CSP. Install it in Edge and Chrome on Windows (and Chrome on macOS if at hand).
- [ ] **Step 2:** From the installed window, call `registration.showNotification` and `pushManager.subscribe` with a test VAPID key. Record whether each works on the loopback origin, and what CSP directive (if any) blocks the manifest or worker.
- [ ] **Step 3:** Close the window and send one push with the Task 5 code once it exists, or with a throwaway script now. Record whether it shows.

**Evidence:** browser, version, and the result of each call pasted in the task report; the spec's "Install" section updated with the result.

### Task 2: Notices

**Files:**
- Create: `bot/notices.ts`, `bot/store.ts`
- Test: `bot/notices.spec.ts`, `bot/store.spec.ts`

**Interfaces:**
- Consumes: `Bots`, `TalkItem` from `bot/types.ts` (including the secret card's open request items from #10).
- Produces:
  - `type Notice = { id: string; bot: string; kind: 'waiting' | 'done'; at: string }` (no text field: notifications never carry file text)
  - `noticesOf(bots: Bots, seen: ReadonlySet<string>, opts: { firstRun: boolean }): { fresh: Notice[]; seen: Set<string> }`
  - `badgeOf(bots: Bots): number`
  - `readJson<T>(file: string, fallback: T): Promise<T>`, `writeJson(file: string, value: unknown): Promise<void>` (temp file then rename)

- [ ] **Step 1: Write the failing tests**

```ts
test('a new unanswered ask is one waiting notice', ...)            // kind 'waiting', id `${bot}:waiting:${ask.id}`
test('a new report is one done notice', ...)                        // kind 'done'
test('seen ids never fire again', ...)                              // second call with returned seen → fresh = []
test('editing the text of an old report does not fire again', ...) // done id = `${bot}:done:${at}:${n}`, n counted from the oldest report with that time
test('a second report in the same minute fires once', ...)
test('an open secret card is one waiting notice, id from its request id', ...)
test('first run marks everything seen', ...)                        // noticesOf with seen = new Set() and opts.firstRun → fresh = []
test('a notice has no text from the files', ...)                    // Object.keys(notice) is exactly id, bot, kind, at
test('badge counts unanswered asks and open secret cards across bots', ...)
test('writeJson leaves the old file when rename fails', ...)
```

- [ ] **Step 2:** Run `node --test bot/notices.spec.ts bot/store.spec.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. With `opts.firstRun` (no `notified.json` yet), `noticesOf` returns every current id in `seen` and no `fresh`.
- [ ] **Step 4:** Run the same command. Expected: all pass.
- [ ] **Step 5:** Commit `feat(bot): notices for waiting and done`.

### Task 3: Manifest, service worker, notifications in the page

**Files:**
- Create: `bot/page/manifest.webmanifest`, `bot/page/sw.js`, `bot/page/icon-192.png`, `bot/page/icon-512.png`
- Modify: `bot/server.ts` (`PAGE_FILES`, `GET /api/notices`), `bot/page/index.html`, `bot/page/bot.js`, `bot/page/bot.css`
- Test: `bot/server.spec.ts`, `bot/page.spec.ts`

**Interfaces:**
- Consumes: `noticesOf`, `badgeOf`, `readJson`, `writeJson` (Task 2).
- Produces: `GET /api/notices` → `{ fresh: Notice[]; badge: number }`; the server keeps `seen` in `~/.kantoku/.bot/notified.json`.

- [ ] **Step 1: Write the failing tests**

```ts
test('serves manifest, sw.js and icons with the right types', ...)   // application/manifest+json, text/javascript, image/png
test('sw.js is served with Service-Worker-Allowed absent and no-store', ...)
test('GET /api/notices returns each notice once', ...)              // two calls → second fresh = []
test('page html has no token in a cacheable file', ...)             // index.html still carries __BOT_TOKEN__ placeholder only; sw.js never caches "/"
test('the page never notifies while visible', ...)                  // page.spec: bot.js checks document.visibilityState before postMessage
test('after a restart with a new token, a page opened again can write', ...) // GET / is no-store and never in the sw cache list
test('GET / on localhost:<port> redirects to 127.0.0.1:<port>; manifest only on 127.0.0.1', ...)
test('notification title and body are the fixed strings for each kind and language', ...)
```

- [ ] **Step 2:** Run `node --test bot/`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. `sw.js` caches only `/bot.js`, `/links.js`, `/bot.css`, the icons and the manifest, never `/` (it carries the per-start token) and never `/api/*`. Notification tag = notice id; click opens `/#bot=<name>`, after checking `<name>` matches `^[A-Za-z0-9_-]{1,40}$`. The "通知をオンにする" button asks permission; nothing asks on load. The install button appears on `beforeinstallprompt`. Badge via `navigator.setAppBadge(badge)` where supported. Keep the CSP; add `manifest-src 'self'; worker-src 'self'` only if Task 1 found them needed.
- [ ] **Step 4:** Run `node --test bot/`. Expected: all pass.
- [ ] **Step 5:** Manual: install from Edge, close the window to the background, add an `ask` to a fixture manager's reports.md under a temp `--root`, see one notification; click it, the conversation opens.
- [ ] **Step 6:** Commit `feat(bot): install as an app with notifications`.

**Evidence:** test output; a screenshot of the installed window and of the notification, made with fixture data only.

### Task 4: Login item

**Files:**
- Create: `bot/loginitem.ts`; Modify: `bot/cli.ts`
- Test: `bot/loginitem.spec.ts`, `bot/cli.spec.ts`

**Interfaces:**
- Produces: `loginItemPath(platform: NodeJS.Platform, home: string): string`, `loginItemBody(platform, nodePath: string, launcherPath: string): string`, `newestCli(versionsDir: string): string | null`, `setLoginItem(on: boolean, deps): Promise<string[]>` (returns the paths written or removed). Also `bot/start.mjs`, the launcher copied to `~/.kantoku/.bot/start.mjs`; it reads `~/.kantoku/.bot/launch.json` (`{ versionsDir }` or `{ cliPath }` for a git clone) and starts the newest `bot/cli.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('newestCli picks 0.10.0 over 0.9.0 and skips folders without bot/cli.ts', ...)
test('a git clone records its own cli path instead of a versions folder', ...)
test('win32 writes one .cmd in the Startup folder that starts node with the launcher path quoted', ...)
test('darwin writes a LaunchAgent plist with RunAtLoad true', ...)
test('linux writes ~/.config/autostart/kantoku-bot.desktop', ...)
test('off removes exactly the login item, start.mjs and launch.json, nothing else', ...)
test('--login-item needs on or off', ...)
```

- [ ] **Step 2:** Run `node --test bot/loginitem.spec.ts bot/cli.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with an injected `home` and file system so tests write under a temp folder.
- [ ] **Step 4:** Run the same command. Expected: pass.
- [ ] **Step 5:** README: "Install as an app", "Notifications", "Start at login". Bump version. Commit `feat(bot): start at login`.

**Evidence:** test output; the README section.

## Stage 2: Desktop push

### Task 5: Web Push without dependencies

**Files:**
- Create: `bot/webpush.ts`
- Test: `bot/webpush.spec.ts`

**Interfaces:**
- Produces:
  - `type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }`
  - `vapidKeys(file: string): Promise<{ publicKey: string; privateKey: KeyObject }>` (make once, keep in `vapid.json`)
  - `encrypt(payload: Buffer, sub: Subscription, opts?: { salt?: Buffer; serverKeys?: KeyPair }): Buffer`
  - `vapidHeader(endpoint: string, keys, subject: string, now: Date): string`
  - `sendPush(sub: Subscription, payload: Buffer, deps): Promise<'ok' | 'gone' | 'error'>`

- [ ] **Step 1: Write the failing tests**

```ts
test('encrypt matches the RFC 8291 section 5 example byte for byte', ...)  // fixed salt and server keys from the RFC
test('vapid JWT verifies with the public key and has aud = endpoint origin, exp within 24 h', ...)
test('sendPush maps 201 to ok, 404 and 410 to gone, others to error', ...) // injected fetch
test('endpoint must be https', ...)
```

- [ ] **Step 2:** Run `node --test bot/webpush.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `crypto.createECDH('prime256v1')`, `crypto.hkdfSync`, `aes-128-gcm`, and `crypto.sign('sha256', …, { key, dsaEncoding: 'ieee-p1363' })`. `subject` is the project URL `https://github.com/takaaaaaan/kantoku`, never an email address.
- [ ] **Step 4:** Run the same command. Expected: pass.
- [ ] **Step 5:** Commit `feat(bot): web push with node:crypto only`.

### Task 6: Subscribe and send

**Files:**
- Modify: `bot/server.ts` (`GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`), `bot/cli.ts` (send loop), `bot/page/sw.js`, `bot/page/bot.js`
- Test: `bot/server.spec.ts`

**Interfaces:**
- Consumes: `noticesOf` (Task 2), `sendPush`, `vapidKeys` (Task 5), `readJson`/`writeJson`.
- Produces: subscriptions in `~/.kantoku/.bot/push.json` as `Subscription[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test('subscribe needs the write checks (token, origin, json)', ...)
test('subscribe stores https endpoints only, once per endpoint, at most 10', ...)
test('a gone answer removes the subscription', ...)
test('the push body holds exactly id, bot and kind', ...)
test('sw.js drops a push while one of its windows is visible', ...)  // page.spec static check of the push handler
test('the send loop and GET /api/notices share one seen set: no notice is pushed and shown twice', ...)
```

- [ ] **Step 2:** Run `node --test bot/`. Expected: FAIL.
- [ ] **Step 3:** Implement. The cli runs one loop every 10 seconds: build bots, `noticesOf`, push each fresh notice to each subscription, save seen. `GET /api/notices` reads the same seen set. The service worker's `push` handler shows the notification with the same tag rule.
- [ ] **Step 4:** Run `node --test bot/`. Expected: pass.
- [ ] **Step 5:** Manual: with the app window closed and Edge still running, a new fixture `ask` gives one notification within 15 seconds.
- [ ] **Step 6:** README: push section, what goes to the push service. Bump version. Commit `feat(bot): notifications with the window closed`.

**Evidence:** test output; the time from writing the fixture to the notification.

## Stage 3: Phone

### Task 7: Spike — Tailscale Serve and the phone

Needs the user: they install Tailscale on the PC and the phone and run `tailscale serve`. Ask before this task; do not change Tailscale settings without that answer.

**Files:** none committed except a "Spike result" note in the spec.

- [ ] **Step 1:** A throwaway server on `127.0.0.1:4898` logs request headers. The user runs `tailscale serve --bg --https=443 http://127.0.0.1:4898`.
- [ ] **Step 2:** From the phone, open the ts.net address. Record `Host`, `Origin` on a POST, `Tailscale-User-Login`, and whether a client-sent `Tailscale-User-Login` header is removed (send one with `curl -H` from another tailnet device).
- [ ] **Step 3:** On iOS, add to the Home Screen; on Android, install. Record whether `__Host-` cookies set, service worker registers, and a push arrives.
- [ ] **Step 4:** The user turns Serve off (`tailscale serve --https=443 off`).

**Evidence:** the header log with the login replaced by `<owner>`; per-phone results; the spec updated.

### Task 8: Devices, pairing, PIN

**Files:**
- Create: `bot/devices.ts`
- Test: `bot/devices.spec.ts`

**Interfaces:**
- Consumes: `readJson`/`writeJson` (Task 2).
- Produces:
  - `type Device = { id: string; name: string; cookieHash: string; pinHash: string; pinSalt: string; created: string; lastSeen: string; misses: number }`
  - `newPairingCode(now: Date): { code: string; expires: string }` (one active code at a time; a new one replaces the old)
  - `pair(code: string, name: string, pin: string, now: Date): Promise<{ device: Device; cookie: string } | 'bad-code' | 'burned' | 'bad-pin'>`
  - `deviceOf(cookie: string, now: Date): Promise<Device | null>` (null when unknown or idle over 30 days)
  - `checkPin(device: Device, pin: string, now: Date): Promise<'ok' | 'wrong' | 'removed'>` (called on every write)
  - `removeDevice(id: string): Promise<void>`, `listDevices(): Promise<Pick<Device, 'id' | 'name' | 'created' | 'lastSeen'>[]>`

- [ ] **Step 1: Write the failing tests**

```ts
test('a code works once, within 10 minutes', ...)
test('the fifth wrong code burns it; the right code after that fails', ...)
test('PIN must be 4 to 8 digits', ...)
test('the stored record has no cookie and no PIN, only scrypt and sha256 hashes', ...)
test('five wrong PINs in a row remove the device; a right one resets the count', ...)
test('the record keeps a miss count across restarts', ...)
test('a device idle 30 days is not found', ...)
test('cookie compare is constant time', ...)  // uses timingSafeEqual on hashes
```

- [ ] **Step 2:** Run `node --test bot/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `randomInt` for the code, `randomBytes(32)` for the cookie, `scrypt` for the PIN.
- [ ] **Step 4:** Run the same command. Expected: pass.
- [ ] **Step 5:** Commit `feat(bot): pair a phone with a code and a PIN`.

### Task 9: Remote listener

**Files:**
- Create: `bot/remote.ts`; Modify: `bot/server.ts` (export the read, say, answer handlers), `bot/cli.ts` (`--remote`, `--owner`, `--remote-host`, prints the `tailscale serve` command)
- Test: `bot/remote.spec.ts`, `bot/cli.spec.ts`

**Interfaces:**
- Consumes: devices API (Task 8); shared handlers from `server.ts`.
- Produces: `startRemoteServer(opts: { root: string; port: number; owner: string; host: string; pageDir: string; ring?: Ring; now?: () => Date }): Promise<Server>`; routes `GET /`, page files, `GET /api/bots`, `POST /api/pair`, `POST /api/say`, `POST /api/answer`, `POST /api/push/subscribe`.

- [ ] **Step 1: Write the failing tests**

```ts
test('binds 127.0.0.1 only', ...)
test('wrong Host → 403', ...)
test('no Tailscale-User-Login → 403 (Funnel, tagged device)', ...)
test('another login → 403', ...)
test('no device cookie → only the pairing page and POST /api/pair answer', ...)
test('a write without the PIN, or with a wrong one, → 401 and one miss counted', ...)
test('any POST, including /api/pair and a PIN-carrying write, with wrong Origin, non-JSON, or no X-Kantoku-Bot → 403 and no try counted', ...)
test('a text/plain form from another tailnet machine with the device cookie cannot burn the code or count a PIN miss', ...)
test('/api/secret, /api/profile, /api/memory/*, pairing management → 404', ...)
test('the local per-start token never appears in any remote response', ...)
test('say from the phone writes via "phone:<device name>" and rings the doorbell with only the id', ...)
test('--remote without --owner or --remote-host exits 2 with usage', ...)
```

- [ ] **Step 2:** Run `node --test bot/`. Expected: FAIL.
- [ ] **Step 3:** Implement. Checks run in the spec's order before routing. The remote page is the same `index.html` with the token placeholder replaced by an empty string; `bot.js` switches to phone mode when it finds no token: every POST sends `X-Kantoku-Bot: 1`, and every write asks for the PIN and sends it in the body.
- [ ] **Step 4:** Run `node --test bot/`. Expected: pass.
- [ ] **Step 5:** Commit `feat(bot): remote listener for the phone`.

### Task 10: Pairing on the PC page; `via` in SKILL.md

**Files:**
- Modify: `bot/server.ts` (`POST /api/devices/code`, `GET /api/devices`, `POST /api/devices/remove`, local only), `bot/page/*`, `bot/types.ts` (`Entry.via?: string`), `bot/read.ts` (show the device name on the user's bubble), `skills/kantoku/SKILL.md`
- Test: `bot/server.spec.ts`, `bot/templates.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('device routes need the local write checks', ...)
test('the code is shown once and never returned by GET /api/devices', ...)
test('a bubble written from the phone shows "<device name> から"', ...)
test('SKILL.md "5. External input" says an entry with via is the user\'s words and to quote the device name', ...)
```

- [ ] **Step 2:** Run `node --test bot/`. Expected: FAIL.
- [ ] **Step 3:** Implement. SKILL.md gains one sentence after the entry-types line: "An entry with `via` came from a paired phone. It is still the user's own words; quote it as `kantoku bot (<device name>) から: …`."
- [ ] **Step 4:** Run `node --test bot/`. Expected: pass.
- [ ] **Step 5:** Commit `feat(bot): pair and remove phones from the PC page`.

### Task 11: Phone screens

**Files:**
- Modify: `bot/page/bot.js`, `bot/page/bot.css`, `bot/page/index.html`
- Test: `bot/page.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('below 720px the list and the conversation are two screens with a back button', ...)  // static check of the CSS and the view state in bot.js
test('choices stack full width with min-height 44px', ...)
test('textarea font-size is 16px on narrow screens', ...)
test('in phone mode the gear, memory fix/forget, and secret field are not rendered', ...)
test('the PIN sheet opens on send and on a choice, says how many tries are left, and never stores the PIN', ...)
```

- [ ] **Step 2:** Run `node --test bot/page.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Build from `docs/mockups/kantoku-bot-mobile.html`: list screen, conversation screen, bottom sheet, pairing screen, PIN sheet, connection pill, secret card with "PC で入れてください".
- [ ] **Step 4:** Run `node --test bot/page.spec.ts`. Expected: pass.
- [ ] **Step 5:** Commit `feat(bot): phone layout`.

### Task 12: End to end on a real phone, README

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json`

- [ ] **Step 1:** With a fixture `--root`, `--remote`, and the user's `tailscale serve`, pair the phone, answer an ask and say a line (each with the PIN). Check `from-user.jsonl` has both entries with `via`, and a test manager quotes them with the device name.
- [ ] **Step 2:** Stop kantoku bot while the phone is open. The pill says `PC に届きません`; the typed text stays in the box. Start again; sending works once, with one entry.
- [ ] **Step 3:** Remove the device on the PC; the phone's next request shows the pairing screen.
- [ ] **Step 4:** Send a request through Funnel if the user agrees to turn it on for one minute, else with `curl` without the identity header to `127.0.0.1:4871`: 403.
- [ ] **Step 5:** README: "Use it from your phone" (install Tailscale, the printed `tailscale serve` command, pair, PIN), the safety list from the spec, and the machine-name note. Bump version. Commit `docs: kantoku bot from the phone`.

**Evidence:** the two `from-user.jsonl` lines with text replaced; screenshots from the phone with fixture data; the 403 output.

---

## Task count

| Stage | Tasks |
|---|---|
| 1. Desktop app | 4 (Tasks 1 to 4) |
| 2. Desktop push | 2 (Tasks 5, 6) |
| 3. Phone | 6 (Tasks 7 to 12) |
| Total | 12 |

## Self-review against the spec

- Every spec section maps to a task: install and one origin (Task 3), login item and launcher (Task 4), notices and badge (Tasks 2, 3), push (Tasks 5, 6), road and checks (Tasks 7, 9), pairing (Tasks 8, 10), PIN on every write (Tasks 8, 9, 11), phone actions and 404 routes (Task 9), `via` (Tasks 9, 10), secret card on the phone (Task 11), layout (Task 11), README and safety (Tasks 4, 6, 12).
- The ten findings of the spec's adversarial review each have a test: Tasks 2 (ids, secret card, no text), 3 (token, one origin, fixed strings), 4 (newest version), 6 (one subscription per endpoint, drop while visible), 9 (every POST checked, same-site form, PIN on write).
