# kantoku app design: desktop window and phone

Status: design. Nothing is implemented yet.
Mockup: [`docs/mockups/kantoku-bot-mobile.html`](../mockups/kantoku-bot-mobile.html) (open it in a browser; all data is made up and nothing is sent).
Builds on: [kantoku bot design](2026-11-19-kantoku-bot-design.md) and the secret card (issue #10), which this design assumes has landed.

## Why

kantoku's aim is a Grok Bot-like agent on top of Orca. Grok Bot is an app: it has its own window, a tray icon, OS notifications, and phone apps that reach the same bots. kantoku bot today is a page at `http://127.0.0.1:4870/` that the user opens in a browser tab on the PC. Two things are missing:

1. **An app on the PC.** Its own window, no browser tab to keep open, and an OS notification when a manager waits for the user. Today a question sits unseen until the user happens to look.
2. **The phone.** Away from the PC, the user cannot answer a manager's question or say something to it. A manager that needs one word from the user stops for hours.

## Goals

1. kantoku bot installs as an app on Windows and macOS: its own window, its own icon in the taskbar or Dock, a badge with the count of questions waiting.
2. An OS notification fires for exactly two events, the same two Grok Bot has: **a manager waits for you** (a new question) and **a manager finished something** (a new report). Pressing it opens that manager's conversation.
3. Notifications arrive while the app window is closed, as long as the PC and kantoku bot are running.
4. From a phone (iOS and Android), outside the home network, the user can see every manager, read the conversation, answer a question, and say something. Notifications reach the phone too.
5. The phone layout keeps today's look: round pastel faces, soft copy, bubbles, the orange "waiting for you" mark.
6. The page stays unreachable from the public internet.

## Non-goals (this design)

- A tray icon. Grok Bot has one. A PWA cannot draw one; see "Later" for the optional shell.
- Store apps (App Store, Play Store) and code signing.
- Editing the description or memory from the phone. The phone shows them; the PC edits them.
- Entering a secret value on the phone (see "Secret cards on the phone").
- Offline use. With the PC off, the phone shows "the PC is not reachable" and nothing else.
- More notification kinds than the two above.

## Anti-goals (a failure even if it works)

- Anyone other than the user can make a manager act on words it treats as the user's. That includes another device in the user's tailnet, a person the device is shared with, a public visitor through Tailscale Funnel, and someone holding the user's unlocked phone.
- The server listens on anything other than loopback.
- A secret value is typed on the phone or crosses the network to reach a secret card.
- A phone write can do something the PC page cannot do, or skips a check the PC page has.
- A notification carries a token, a path, or a run id.
- The design needs the user to open a port on the router.

## Constraints

- Same as kantoku bot: Node 22.18+ with TypeScript type stripping, no npm dependencies, `node:test`, public repo with no personal data.
- The manager is an LLM session that proves "this came from the user" by reading a file. Nothing in this design changes that rule; the phone writes the same `from-user.jsonl` entries.
- kantoku ships as a Claude Code plugin. Anything that needs a compiled binary, an app store, or a signing account does not fit that channel.

## Approaches considered

| | Windows | macOS | iOS | Android | Size | Ships as OSS in the plugin | Closeness to Grok Bot |
|---|---|---|---|---|---|---|---|
| **(a) PWA**: kantoku bot's page gains a manifest and a service worker and installs as an app | Yes (Chrome, Edge) | Yes (Chrome, Edge; Safari "Add to Dock") | Yes, from Safari "Add to Home Screen"; Web Push needs iOS 16.4+ and the installed app | Yes (Chrome) | Small: 4 new files and one server module | Yes, plain files in `bot/page/` | Window, icon, badge, both notifications. No tray |
| **(b) Electron or Tauri shell** around the same page | Yes | Yes | No | No | Medium to large: a second build system (Electron adds a 100 MB+ runtime and npm dependencies; Tauri needs a Rust toolchain), installers, an updater | Poorly: unsigned builds trip SmartScreen and Gatekeeper; signing costs money and an account | Tray, autostart, notifications. No phone |
| **(c) Tailscale Serve** in front of a second loopback listener, so the phone reaches the PC | n/a | n/a | Yes (Tailscale app) | Yes (Tailscale app) | Medium: the listener, pairing, PIN | Yes, code in `bot/`. The user installs Tailscale | It is the road, not the app. Combined with (a), the phone gets the same installable app |

**Chosen: (a) for both, with (c) as the road for the phone.** Reasons:

1. One set of page files serves the desktop window and the phone. (b) would serve only the desktop, and the phone would still need (a) and (c).
2. It ships inside the plugin as plain files, with no installer, signing, or updater. Updating kantoku updates the app.
3. Tailscale Serve gives the phone an HTTPS address only devices in the user's tailnet can reach, with no router change. HTTPS is what the phone needs for a service worker and Web Push at all.

What (a) gives up: the tray icon and starting with the OS by itself. The second is covered by a small login-item command (stage 1). The tray is left to "Later".

Rejected outright: binding to the LAN address (no HTTPS on a bare IP, so no service worker or push on the phone, and every device on the Wi-Fi can reach it), Tailscale Funnel (public internet), and a relay in the cloud (a new server to run and trust).

## Order

**Desktop first, then the phone.** The desktop stages add no new way in: the server still answers only the local page. They build the notice engine, the manifest, the service worker, and Web Push, which the phone then reuses. The phone stage is the one that changes who can reach kantoku bot, so it comes last, on a base that already works, and it gets the most review.

| Stage | Ships | New way in? |
|---|---|---|
| 1. Desktop app | Manifest, icons, service worker, notices engine, notifications while the window is open, badge, login item | No |
| 2. Desktop push | Web Push, so notifications arrive with the window closed | No (outbound only) |
| 3. Phone | Remote listener behind Tailscale Serve, owner check, device pairing, PIN on every write, phone layout, phone push | **Yes** |
| Later (not planned) | Passkey unlock in place of the PIN; an optional tray shell | — |

## The desktop app (stages 1 and 2)

### Install

- `bot/page/manifest.webmanifest`: `name` "kantoku bot", `display` "standalone", `start_url` "/", theme colors from the page tokens, icons at 192 and 512 px (a round pastel face, drawn as PNG from the SVG face).
- `bot/page/sw.js`: the service worker. It caches only `bot.js`, `links.js`, `bot.css`, the manifest, and the icons, so the window opens fast. It never caches `/`, because `/` carries the per-start token and a cached copy would hold a dead token after the next start (every write would then get 403). It never caches `/api/*`. It shows notifications and opens the right conversation on click.
- **One origin.** The local listener answers `GET /` on `localhost:<port>` with a redirect to `127.0.0.1:<port>`, and serves the manifest only on `127.0.0.1`. Two origins would install two apps with two service workers, and each notice would show twice.
- The page shows a small "Install as app" button when the browser fires `beforeinstallprompt` (Chrome, Edge). Safari users get a one-line hint.
- The local origin `http://127.0.0.1:4870` counts as a secure context, so install, service worker, and notifications work on it. Plan Task 1 checks this, and checks push on that origin, before anything else is built.

### Start with the OS

`node bot/cli.ts --login-item on|off` writes or removes one file that starts kantoku bot at login:

- Windows: a `.cmd` in the user's Startup folder.
- macOS: a LaunchAgent plist in `~/Library/LaunchAgents`.
- Linux: a `.desktop` file in `~/.config/autostart`.

The file does not name `<plugin root>/bot/cli.ts`. Claude Code keeps each plugin version in its own folder and keeps the old ones, so a fixed path would start the old version forever after an update. The file starts `~/.kantoku/.bot/start.mjs` instead. `--login-item on` copies that launcher there and records the folder that holds the version folders. At login the launcher picks the highest version folder that has `bot/cli.ts` and starts it. A plugin root that is not inside a version folder (a git clone) is used as it is.

It never runs without the flag. It prints the files it wrote, and `off` removes exactly those files.

### Notices (what makes a notification)

A new module, `bot/notices.ts`, turns the bot list into notices. It is pure: previous seen ids and the current `Bots` in, notices and new seen ids out.

```ts
type NoticeKind = 'waiting' | 'done'

type Notice = {
  id: string            // waiting: `${bot}:waiting:${askId}`; done: `${bot}:done:${reportTime}:${n}`,
                        // n = position among reports with that time. Never from the text, so fixing a typo
                        // in an old report does not fire it again
  bot: string
  kind: NoticeKind
  at: string
}
```

- `waiting`: an `ask` item without an answer, or an open secret card, that has not been noticed before. A secret card's id is its request id.
- `done`: a `report` item that has not been noticed before.
- Seen ids live in `~/.kantoku/.bot/notified.json` (kantoku bot's own folder at the root, not inside a manager). On the first run every existing item counts as seen, so installing does not fire a burst of old notices.
- The badge count is the number of unanswered asks plus open secret cards across all managers.
- **No text from the files.** A notice carries the bot name and its kind, nothing else. The redaction pass misses paths and short unlabeled tokens (the review proved both with `bot/redact.ts`), and a notification lands on a lock screen and goes through a vendor's push service. The text is one press away, in the app.

### Showing them

- **Window open or in the background**: the page already re-reads every 3 seconds. When a new notice appears and the page is hidden, it asks the service worker to show it. When the page is visible, it does not notify (the user is looking).
- **Window closed (stage 2)**: the server sends a Web Push message to each saved subscription. The service worker shows it.
- Title: `<name> があなた待ち` or `<name> の仕事ができました` (English labels for English profiles). Body: `開いて答えてください` or `開いて見てください` (fixed). Tag: the notice id, on both paths (page and push), so the same notice replaces itself instead of showing twice.
- The service worker drops a push when one of its windows is visible, so a push that races the page's own notice is not shown.
- Click: focus or open the app at `/#bot=<name>`.
- Permission is asked once, from a button in the page ("Turn on notifications"), never on load.

### Web Push without dependencies

`bot/webpush.ts` implements the two standards Web Push needs, with `node:crypto` only:

- VAPID (RFC 8292): an ES256 JWT signed with a P-256 key that kantoku bot makes once and keeps in `~/.kantoku/.bot/vapid.json`.
- Message encryption (RFC 8291, `aes128gcm`): ECDH with the subscription's key, HKDF, AES-128-GCM.

A test checks the encryption against the RFC 8291 worked example. Subscriptions live in `~/.kantoku/.bot/push.json`. A push service answer of 404 or 410 removes that subscription.

Push messages go out through the browser vendor's push service (Google, Mozilla, Apple). The body is encrypted end to end, so the vendor sees only size and timing. The body holds only the notice: its id (bot name, kind, and an ask id or report time), bot name, and kind. Never file text, run ids, paths, or tokens. Subscriptions are kept once per endpoint.

## The phone (stage 3)

### The road

```
phone (Tailscale app on)                PC
  https://<pc>.<tailnet>.ts.net  ──▶  tailscaled (Serve)  ──▶  127.0.0.1:4871  remote listener
                                         adds Tailscale-User-Login              (kantoku bot, same process)
                                                                         127.0.0.1:4870  local listener (unchanged)
```

- `node bot/cli.ts --remote --owner <tailscale login> --remote-host <pc>.<tailnet>.ts.net` starts a second listener on `127.0.0.1:4871`. It never binds anything but loopback, same as today.
- The user runs `tailscale serve --bg --https=443 http://127.0.0.1:4871` once. kantoku bot prints that command; it never changes Tailscale settings itself.
- Serve gives the phone a real HTTPS certificate for the ts.net name, which the phone needs for the service worker and Web Push.

### Who can open it

Every request to the remote listener passes these checks, in order. Any failure is `403` with no detail, and the local listener is not involved.

1. **Host** is exactly the configured `--remote-host`.
2. **Owner.** The `Tailscale-User-Login` header equals `--owner`. Serve sets this header for requests from the user's tailnet devices and removes any copy the client sent. Funnel requests, tagged devices, and requests with no header carry no identity and are refused. A person the device is shared with has a different login and is refused. This makes "turned on Funnel by mistake" fail closed.
3. **Every POST, with no exception,** needs `Origin` exactly `https://<remote-host>`, `Content-Type: application/json`, and the header `X-Kantoku-Bot: 1`. This runs before any route, so it covers `POST /api/pair` and every write that carries a PIN, before a try is counted. No CORS headers, as today.
4. **Paired device.** A `__Host-kb_device` cookie (Secure, HttpOnly, SameSite=Strict, Path=/) whose SHA-256 is in `~/.kantoku/.bot/devices.json`. Without it the only routes are the pairing page and `POST /api/pair`.
5. **PIN, for anything that writes** (below).

Why check 3 is needed even with the owner check and a SameSite cookie:

- The owner check passes for any page open on the owner's own devices. Tailscale adds the owner's login to every request from the device, whichever site sent it.
- `ts.net` is on the Public Suffix List, so every machine in one tailnet counts as one site. A page served by another machine in the tailnet is "same site", and the browser sends the SameSite=Strict cookie with its form posts.
- The review proved both: without check 3, a form on another site burned the pairing code, and a form on another tailnet machine sent five wrong PINs and removed the user's phone.
- A cross-origin page cannot send `X-Kantoku-Bot` or `application/json` without a CORS preflight, and the listener never answers one. The exact `Origin` closes what is left.

The per-start token of the local page is never served on the remote listener.

### Pairing a phone

1. On the PC page (local only), the info area gets "電話をつなぐ / Pair a phone". Pressing it shows a 6-digit code and asks for a device name ("my phone").
2. The code is good for 10 minutes and for 5 tries in total. A wrong fifth try burns it. Only requests that pass checks 1 to 3 count as tries.
3. On the phone, the user opens the ts.net address (inside Tailscale), types the code, and sets a 4 to 8 digit PIN.
4. The server stores `{ id, name, cookieHash, pinHash (scrypt), pinSalt, created, lastSeen, misses }` and sets the device cookie. The cookie lasts 30 days from last use.
5. The PC page lists paired devices with name, last seen, and "外す / Remove". Removing deletes the entry, so its cookie stops working on the next request.

### PIN on every write

Reading needs the paired device. **Every write carries the PIN**: each send, each answer, each "ask to stop".

- The page asks for the PIN in a small sheet when the user presses send or a choice, and sends it in the same request. The page never stores it.
- The PIN is checked on the PC (scrypt hash). Five wrong PINs in a row remove the device; it must pair again from the PC. The PIN sheet says how many tries are left.
- An earlier draft unlocked writes for 15 minutes after one PIN. The review proved the hole: someone who picks up the phone three minutes after the user's last answer could send "deploy: yes" with no PIN. A PIN on every write has no such window and no unlock state to keep, so it is also less code.
- It covers the case the anti-goals name: an unlocked phone in someone else's hand can read, but cannot answer "deploy?" or send words in the user's name.
- Passkeys (Face ID, fingerprint) would make each write one touch. They need WebAuthn verification (CBOR, COSE keys) with no dependencies, so they are left to "Later". The PIN is a few lines with `node:crypto` `scrypt`.

### What the phone can do

| Action | Phone | Why |
|---|---|---|
| See managers, status, conversation, info sheet | Yes | Read only, same redaction as the PC |
| Say something | Yes, with the PIN | The point of the phone |
| Answer a question card | Yes, with the PIN | The point of the phone |
| Ask to stop a routine | Yes, with the PIN | It is a `say` with fixed text |
| Edit description, fix or forget memory | No, shown with "edit on the PC" | Rare, and each one rewrites a file the manager relies on. Fewer write routes on the open road |
| Secret card | Seen, not usable | See below |
| Pair or remove devices | No | Only from the PC, so a phone can never add a phone |

The remote listener has its own route table. Routes the phone cannot use do not exist there (they return `404`), rather than being refused by a flag.

### How the manager tells phone words from PC words

Phone entries are the same `say` and `answer` entries in `from-user.jsonl`, with one more field:

```json
{"id":"d-20261119-094102-5c1e","at":"2026-11-19T09:41:02+09:00","type":"answer","ask":"q-1119","text":"手元で試す","delivery":"sent","via":"phone:my phone"}
```

- The doorbell is unchanged (`kantoku-bot: <id>`, no text in the letter).
- They carry the same weight as words typed in chat. The device check and the PIN are what make that safe; the manager does not second-guess a channel the user set up.
- The manager quotes them as `kantoku bot (my phone) から: …`, so the chat and decisions.md show which device spoke.
- SKILL.md "5. External input" gains one sentence: an entry with `via` is still the user's words; quote the device name.

### Secret cards on the phone

**Not on the phone.** The card shows the request and the exact command, with "enter this on the PC" in place of the field and the Register button. Reasons:

1. Pressing Register is itself the approval ("Registering counts as asking" in SKILL.md). The strongest approval the design has should stay on the PC, behind the local-only checks.
2. A secret pasted on a phone usually comes from the phone's clipboard, which other apps on the phone can read.
3. A stolen phone with the PIN seen over a shoulder could register a value of the thief's choosing as the user's CI token.

The card's time limit (30 minutes) still runs, so a card that waits too long expires and the child asks again later.

### Phone layout

See the mockup. In words:

- **Two screens, not two columns.** The bot list fills the screen; pressing a row opens the conversation; `‹` goes back. The PC's two-column layout is kept above 720 px.
- **Header** in a conversation: back button, small face, name, status word. Pressing the name opens the info sheet from the bottom (a bottom sheet with a grab bar), not from the side.
- **Question cards** stack their choices full width, recommended first and filled, each at least 44 px tall for a thumb.
- **Input** is 16 px text, so iOS does not zoom on focus; the send button is a round `↑`.
- **Connection pill** in the list header: `● 家の PC` while reachable, `PC に届きません` when the last request failed.
- **Pairing screen**: one face, a short line, six digit boxes, one button.
- **Notifications** use the same two titles as the desktop.
- Faces, colors, copy, fonts, light and dark themes are the PC page's, unchanged.

## Safety summary

| Threat | What stops it |
|---|---|
| A stranger on the internet | Nothing listens off loopback. No router port. Funnel traffic has no identity header and is refused |
| Another device or user in the tailnet, or a shared-in user | Owner login check, then the paired-device cookie |
| A website open in the user's phone browser, including a page served by another machine in the tailnet (same site under `ts.net`) | Every POST needs the exact Origin, JSON, and `X-Kantoku-Bot`; no CORS preflight is answered. The SameSite cookie alone is not enough |
| A lost or stolen phone, locked | Phone lock, then the PIN for writes; remove the device on the PC, and remove the phone from the tailnet in the Tailscale admin page |
| A phone in someone else's hand, unlocked | They can read. Every write needs the PIN; five misses remove the device |
| Guessing the pairing code | Reachable only by the owner's tailnet devices; 10 minutes; 5 tries per code |
| A forged doorbell letter | Unchanged: the letter only carries an id that selects an entry kantoku bot wrote |
| A secret through the phone | Secret routes do not exist on the remote listener |
| A program on the PC running as the user | Out of scope, as today; it can already type into the user's terminals |

One thing the user should know: Tailscale's HTTPS certificate puts the machine name and tailnet name in public certificate logs. The README tells the user to pick a machine name that says nothing about them.

## Files and modules

| File | Change |
|---|---|
| `bot/page/manifest.webmanifest`, `bot/page/sw.js`, `bot/page/icon-192.png`, `bot/page/icon-512.png` | New |
| `bot/page/bot.js`, `bot/page/bot.css`, `bot/page/index.html` | Install button, notifications button, mobile layout, pairing and PIN screens, read-only edit and secret states |
| `bot/notices.ts` | New, pure |
| `bot/webpush.ts` | New, VAPID and `aes128gcm` |
| `bot/devices.ts` | New: pairing codes, device store, PIN check |
| `bot/remote.ts` | New: the remote listener, its checks, its route table |
| `bot/server.ts` | Serves the new page files; exposes routes so `remote.ts` can mount the shared read and write handlers |
| `bot/cli.ts` | `--login-item`, `--remote`, `--owner`, `--remote-host` |
| `skills/kantoku/SKILL.md` | One sentence on `via` in "5. External input" |
| `README.md` | Install as an app, notifications, phone setup with Tailscale, safety |

## Left to the builder

- Icon drawing, and the English labels for the new buttons and notices.
- Exact wording of the pairing and PIN screens.
- Whether the service worker refreshes its shell cache by version string or by hash.

## Calls made by the designer (the user can overturn them)

- PWA plus Tailscale Serve, desktop first.
- Remote port `4871`.
- A PIN on every phone write; passkeys later.
- The phone cannot edit the description or memory, and cannot use secret cards.
- Notifications carry the bot name and a fixed phrase, never text from the files.
- Device cookies last 30 days from last use.

## Later

- **Passkey unlock** in place of the PIN, once a no-dependency WebAuthn check is worth its size.
- **Tray shell.** If the PWA window without a tray falls short in daily use, a thin Tauri shell can load `http://127.0.0.1:4870` and add a tray icon and the badge. It would live in its own repo with its own releases, so the plugin stays plain files.

## Adversarial review (2026-11-19)

Two reviewers attacked a draft of this design with runs against the real `bot/` code and small prototypes. Ten findings survived a rerun; each is fixed above.

| Finding | Fix in this design |
|---|---|
| A cached `/` keeps a dead per-start token, so writes fail after a restart | The service worker never caches `/` |
| An open secret card never notified and the badge showed 0 | Open secret cards count as `waiting` and in the badge |
| Reports have no id; text-based ids re-fire on edits, minute-based ids miss a second report | Done id = report time plus position among reports with that time |
| `redact()` keeps paths and short unlabeled tokens, which would reach the lock screen and the push service | Notifications carry no file text |
| The same notice could show twice (page plus push, or `localhost` plus `127.0.0.1`) | Same tag on both paths, push dropped while a window is visible, one origin |
| A login item pinned to one plugin version keeps starting the old version | A launcher picks the newest version folder at login |
| A form on another site could burn the pairing code | Every remote POST needs the exact Origin, JSON, and `X-Kantoku-Bot`, before any try counts |
| `ts.net` is a public suffix, so another tailnet machine is same-site and could send five wrong PINs | Same check; the SameSite cookie is not relied on |
| A 15-minute unlock let someone who picked up the phone write without the PIN | A PIN on every write |
| Notification text could carry paths and tokens | No file text in notifications |

Not proven by a run, left to plan Task 7 with a real phone and Tailscale: that Serve strips a client-sent `Tailscale-User-Login`, `__Host-` cookie behavior behind Serve, and push on iOS.
