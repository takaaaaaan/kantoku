# kantoku app design: desktop window and phone

Status: design. Nothing is implemented yet.
Mockups (open in a browser; all data is made up and nothing is sent):
- Desktop app: [`docs/mockups/kantoku-app-desktop.html`](../mockups/kantoku-app-desktop.html)
- Phone: [`docs/mockups/kantoku-bot-mobile.html`](../mockups/kantoku-bot-mobile.html)

Builds on: [kantoku bot design](2026-11-19-kantoku-bot-design.md) and the secret card (issue #10), which this design assumes has landed.

## Why

kantoku's aim is a Grok Bot-like agent on top of Orca. Grok Bot is an app: it has its own window, a tray icon, OS notifications, and phone apps that reach the same bots. kantoku bot today is a page at `http://127.0.0.1:4870/` that the user opens in a browser tab on the PC. Two things are missing:

1. **An app on the PC.** Its own window, no browser tab to keep open, and an OS notification when a manager waits for the user. Today a question sits unseen until the user happens to look.
2. **The phone.** Away from the PC, the user cannot answer a manager's question or say something to it. A manager that needs one word from the user stops for hours.

The user decides whether to keep using an app from its first look, so the first impression gets as much weight as the function.

## What the user decided (fixed)

- **Desktop first, then the phone.**
- **Modern, with motion, and still cute.** Soft words stay. Screens slide, cards fold away, panels grow and shrink. All motion stops under `prefers-reduced-motion`. The mockups were rebuilt from references the designer collected (see "Look and motion").
- **One list, no tabs.** The bots are not split into "all / waiting / working".
- **Grok Bot-style avatars.** Every manager has its own shape and color with two white eyes, picked in a "new bot" dialog modeled on Grok Bot's. One icon for everyone was too lonely.
- **Built with the user's team design skill** (a private skill; its rules are summarized below).
- **No PIN on the phone.** A paired phone writes as the user with nothing more. The user chose this after seeing the review's proof of what it allows. See "The risk the user accepted" and "Removing a phone".
- **Secret cards work on the phone.** With the clipboard risk written down and a record of every phone registration shown on the PC.
- PIN on every write and passkeys stay as options for a later stage, chosen in a setting.

## Goals

1. kantoku bot installs as an app on Windows and macOS: its own window, its own icon in the taskbar or Dock, a badge with the count of things waiting for the user.
2. An OS notification fires for exactly two events, the same two Grok Bot has: **a manager waits for you** (a new question or secret card) and **a manager finished something** (a new report). Pressing it opens that manager's conversation.
3. Notifications arrive while the app window is closed, as long as the PC and kantoku bot are running.
4. From a phone (iOS and Android), outside the home network, the user can see every manager, read the conversation, answer a question, say something, and register a secret. Notifications reach the phone too.
5. The first look is modern and moves, and keeps the cute avatars and soft copy.
6. Each manager has its own avatar, chosen when it is made, and it shows everywhere that manager appears.
7. The page stays unreachable from the public internet.

## Non-goals (this design)

- A tray icon. Grok Bot has one. A PWA cannot draw one; see "Later" for the optional shell.
- Store apps (App Store, Play Store) and code signing.
- Editing the description, memory, or avatar from the phone, or making a new bot there. The phone shows them; the PC edits them.
- Starting a manager's session from kantoku bot. "作成" makes the files; the user starts it with `/kantoku <name>`.
- Offline use. With the PC off, the phone shows "the PC is not reachable" and nothing else.
- More notification kinds than the two above.

## Anti-goals (a failure even if it works)

- Anyone without a paired phone or the PC can make a manager act on words it treats as the user's. That includes another device in the user's tailnet, a page served by another tailnet machine, a person the device is shared with, and a public visitor through Tailscale Funnel.
- The server listens on anything other than loopback.
- A secret registered from the phone leaves no record the user sees on the PC.
- A secret value is stored anywhere: a file, a log, the page's storage, a notification.
- A phone write can do something the PC page cannot do, or skips a check the PC page has.
- A notification carries text from the files, a token, a path, or a run id.
- Motion that cannot be turned off, or that hides what changed.
- The design needs the user to open a port on the router.

## Constraints

- Same as kantoku bot: Node 22.18+ with TypeScript type stripping, no npm dependencies, `node:test`, public repo with no personal data.
- The manager is an LLM session that proves "this came from the user" by reading a file. Nothing in this design changes that rule; the phone writes the same `from-user.jsonl` entries.
- kantoku ships as a Claude Code plugin. Anything that needs a compiled binary, an app store, or a signing account does not fit that channel.
- The page loads nothing from outside: no web fonts, no animation library. Motion is CSS transitions, keyframes, and the View Transitions API where the browser has it.

## Approaches considered

| | Windows | macOS | iOS | Android | Size | Ships as OSS in the plugin | Closeness to Grok Bot |
|---|---|---|---|---|---|---|---|
| **(a) PWA**: kantoku bot's page gains a manifest and a service worker and installs as an app | Yes (Chrome, Edge) | Yes (Chrome, Edge; Safari "Add to Dock") | Yes, from Safari "Add to Home Screen"; Web Push needs iOS 16.4+ and the installed app | Yes (Chrome) | Small: 4 new files and one server module | Yes, plain files in `bot/page/` | Window, icon, badge, both notifications. No tray |
| **(b) Electron or Tauri shell** around the same page | Yes | Yes | No | No | Medium to large: a second build system (Electron adds a 100 MB+ runtime and npm dependencies; Tauri needs a Rust toolchain), installers, an updater | Poorly: unsigned builds trip SmartScreen and Gatekeeper; signing costs money and an account | Tray, autostart, notifications. No phone |
| **(c) Tailscale Serve** in front of a second loopback listener, so the phone reaches the PC | n/a | n/a | Yes (Tailscale app) | Yes (Tailscale app) | Medium: the listener, pairing | Yes, code in `bot/`. The user installs Tailscale | It is the road, not the app. Combined with (a), the phone gets the same installable app |

**Chosen: (a) for both, with (c) as the road for the phone.** Reasons:

1. One set of page files serves the desktop window and the phone. (b) would serve only the desktop, and the phone would still need (a) and (c).
2. It ships inside the plugin as plain files, with no installer, signing, or updater. Updating kantoku updates the app.
3. Tailscale Serve gives the phone an HTTPS address only devices in the user's tailnet can reach, with no router change. HTTPS is what the phone needs for a service worker and Web Push at all.

What (a) gives up: the tray icon and starting with the OS by itself. The second is covered by a small login-item command (stage 1). The tray is left to "Later".

Rejected outright: binding to the LAN address (no HTTPS on a bare IP, so no service worker or push on the phone, and every device on the Wi-Fi can reach it), Tailscale Funnel (public internet), and a relay in the cloud (a new server to run and trust).

## Order

**Desktop first, then the phone** (the user's choice, and the designer's). The desktop stages add no new way in: the server still answers only the local page. They build the new look, the notice engine, the manifest, the service worker, and Web Push, which the phone then reuses. The phone stage is the one that changes who can reach kantoku bot, so it comes last, on a base that already works, and it gets the most review.

| Stage | Ships | New way in? |
|---|---|---|
| 1. Desktop app | New look and motion, manifest, icons, service worker, notices engine, notifications while the window is open, badge, login item | No |
| 2. Desktop push | Web Push, so notifications arrive with the window closed | No (outbound only) |
| 3. Phone | Remote listener behind Tailscale Serve, owner check, request check, device pairing, phone layout, secret cards with a PC record, phone push | **Yes** |
| 4. Phone lock options | A setting to require a PIN on every phone write, or a passkey (Face ID, fingerprint) | No (narrows it) |
| Later (not planned) | An optional tray shell | — |

## Look and motion

The user asked for a modern look with motion, collected from sites such as motionsites.ai, and then, after seeing the first rebuild, asked for three changes: no tabs that split the list, a Grok Bot-style "new bot" dialog, and a different avatar for every manager. The design follows the user's team design skill (private, so only its rules are written here): tokens for color, spacing, radius, elevation, and type; motion with a purpose and fixed timings; every control working; the six states; accessibility; screenshots checked by the designer.

References the designer looked at in Orca's built-in browser (no sign-in):

| Reference (motionsites.ai) | What it shows | What kantoku bot takes |
|---|---|---|
| Iris Assistant (AI Assistant) | A glowing orb that breathes in the middle of a dark page | The avatar's aura: a soft halo that pulses while a bot waits for you, and a turning ring while it works |
| DeepThink (AI Assistant) | Chat bubbles that rise in one after another over a soft gradient, a rounded input bar | Bubbles rise and un-blur in sequence; the input is a floating glass pill |
| Smart Home (Dashboard) | Frosted glass cards over a soft photo | Frosted glass panels over slow color blobs |
| Dashboard UI (Dashboard) | White rounded tiles with soft shadows that lift on hover | List rows lift on hover and press in on tap; rows come in with a short stagger |
| Apex Program Accordion (Accordion) | Rows that open and close with height motion | Info sections fold open and closed; a question card folds its choices away once answered |

Plus Grok Bot's own "new bot" dialog, which the user showed: a big avatar, a name field, a grid of shapes, a row of colors, Cancel and Create.

### Tokens

- **Color.** Primary ink `#15192a` (dark theme `#eef1f8`). Accent: an orange-to-pink gradient `#ff6a3d → #ff3d7f` for "waiting for you", the recommended choice, and the send button. Purple `#7c5cff` for secret cards. Green `#1a9e6a` for working and "connected". Status colors ok, warn, danger. Light and dark themes swap only the variables.
- **Spacing.** 4 px steps only: 4, 8, 12, 16, 20, 24, 32.
- **Radius.** 10 (inputs, small buttons), 16 (cards, rows), 24 (window, composer, phone rows), 32 (dialogs, phone sheet).
- **Elevation.** 0 flat with a border; 1 rows and bubbles; 2 hover, the composer, the selected row; 3 dialogs and the window.
- **Type.** Page title 26 to 28 / 800 with `-0.03em`; card title 16 / 700; body 14 / 400 with `-0.01em`; caption 12 / 500 muted; mono 12.5 for commands. Rounded system fonts, nothing loaded from outside (the skill's Pretendard is a Korean web font; kantoku bot loads no fonts).
- **Icons.** One line set (Lucide-style paths, stroke 1.9), inline SVG. No emoji as icons.

### One list

The bot list is one list with no tabs or filters. It sorts: waiting for you first, then working, then not started, then asleep; ties keep their order. Each row is the avatar (with its status ring or halo and a status dot), the name, the last line, and a badge when something waits: orange "あなた待ち", purple "秘密", gray "新しい".

### Avatars

Every manager has its own avatar, a shape in a color with two tall white eyes, the way Grok Bot's bots look.

- **13 shapes:** circle, rounded square, capsule, diamond, triangle, star, flower, four-leaf clover, cloud, drop, hexagon, heart, egg.
- **11 colors:** black `#26262b`, brown `#8d5b3c`, red `#e5484d`, orange `#f76b15`, amber `#ffb224`, green `#30a46c`, teal `#12a594`, blue `#3e63dd`, purple `#8e4ec6`, pink `#e93d82`, gray `#8b8d98`.
- Drawn as one inline SVG in a 100 by 100 box. Each shape knows where its eyes sit. The eyes blink about every 6 seconds, each avatar at its own offset. Asleep: the eyes become two closed arcs and the color softens.
- Status around the avatar: a halo pulses while it waits for you, a green ring turns while it works, a small dot shows the status in color, and the status word says it in text.
- **Where it shows:** the list, the conversation header and bubbles, the info panel (large, with "見た目を変える"), the phone list, conversation, and sheet, OS notifications (the notification icon is that bot's avatar), and the PC title bar for kantoku bot itself.
- **Stored** in `~/.kantoku/<name>/bot/avatar.json` as `{"shape":"cloud","color":"pink"}`. kantoku bot is its only writer; it sits in kantoku bot's own `bot/` folder, so no manager file changes. A manager with no `avatar.json` gets a shape and color from a stable hash of its name, so existing managers already look different from each other.

### The "new bot" dialog

The title bar's "+" opens it (only on the PC):

- A big avatar preview at the top that changes as the user picks.
- "Bot に名前を付ける": the manager name. It must match `^[A-Za-z0-9_-]{1,40}$` and not be taken; "作成" stays disabled until it does.
- **Shapes:** a 7-column grid of the 13 shapes in the chosen color. The chosen one gets a soft round frame.
- **Colors:** a row of 11 round swatches. The chosen one gets a double ring.
- "キャンセル" and "作成". White, large rounded card (radius 32). It traps focus, closes on Esc and on the backdrop, and puts focus back on "+".
- **Create** makes `~/.kantoku/<name>/` from the kantoku templates (profile.md and state.md with the name filled in) plus `bot/avatar.json`. It does not start a session. The new bot shows in the list as "新しい", and its conversation shows the empty state: "<name> はまだ動いていません", the command `/kantoku <name>`, and "命令を写す". Starting the session from kantoku bot is left for later.
- The same dialog, opened from the info panel's "見た目を変える", edits the avatar of an existing bot. The name is fixed there.

### Motion

- **Timings** (from the skill): hover, press, and color 150 to 200 ms; folds, tabs, and toggles 200 to 300 ms; dialogs, sheets, and screen changes 300 to 400 ms; stagger 50 ms, at most 12 items; leaving takes about 70% of entering. Two curves: `--ease` `cubic-bezier(.22, 1, .36, 1)` and `--spring` `cubic-bezier(.34, 1.56, .64, 1)`.
- **What moves:**
  1. The window rises in and un-blurs on start.
  2. List rows rise in with a stagger; they lift on hover and press in on tap.
  3. Switching bots uses a View Transition (a cross-fade) where the browser has it, and the conversation rises in.
  4. On the phone, the conversation slides in from the right and the list slides back and fades.
  5. Bubbles rise in and un-blur in sequence.
  6. A question card's choices fold away after an answer, and a "答えた" chip pops in. A secret card folds the same way after "登録", with "登録中…" while it runs.
  7. The info panel grows out to the right on the PC; on the phone it springs up from the bottom as a sheet.
  8. Info sections fold open and closed (grid rows `1fr` to `0fr`, no height measuring).
  9. The dialog pops in; the avatar preview gives a small bump when the shape or color changes.
  10. The waiting count pops when it changes; the send button hops when it sends.
  11. Notifications slide in (PC) or drop in (phone lock screen).
- **What loops:** only the status ring and halo, the eye blink, the connection dot, and the background blobs (30 s). Body text, inputs, and tables never move.
- **Motion off.** Under `prefers-reduced-motion: reduce`, every animation and transition ends at once and View Transitions are skipped; every state still shows. The mockups have a "動きを止める" button to check this.

### States

| State | Where |
|---|---|
| Loading | "登録中…" on the secret card's button while the command runs |
| Empty | A new bot's conversation (avatar, one line, the command, "命令を写す"); "まだありません" in empty info sections |
| Success | A toast, a "答えた" or "登録しました" chip |
| Error | "PC に届きません" in the phone's connection pill; "ほかで変わっていました。もう一度どうぞ" on a 409 (from the kantoku bot design) |
| Confirm | "my phone を外しますか?" with the device name, before removing a phone |
| Skeleton | Not used: everything is local and arrives in one read |

## The desktop app (stages 1 and 2)

### Install

- `bot/page/manifest.webmanifest`: `name` "kantoku bot", `display` "standalone", `start_url` "/", theme colors from the page tokens, icons at 192 and 512 px (kantoku bot's own avatar, drawn as PNG from the SVG).
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

> **Read this first. A paired phone is you.** With no PIN (the user's choice), anyone holding your unlocked, paired phone can answer a manager's question as you, approve a deploy, send words in your name, and register a secret value of their choosing into your CI. If a paired phone is lost, stolen, or handed to someone, remove it right away (see "Removing a phone").

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
3. **Every POST, with no exception,** needs `Origin` exactly `https://<remote-host>`, `Content-Type: application/json`, and the header `X-Kantoku-Bot: 1`. This runs before any route, so it covers `POST /api/pair` before a try is counted. No CORS headers, as today.
4. **Paired device.** A `__Host-kb_device` cookie (Secure, HttpOnly, SameSite=Strict, Path=/) whose SHA-256 is in `~/.kantoku/.bot/devices.json`. Without it the only routes are the pairing page and `POST /api/pair`.

Why check 3 is needed even with the owner check and a SameSite cookie:

- The owner check passes for any page open on the owner's own devices. Tailscale adds the owner's login to every request from the device, whichever site sent it.
- `ts.net` is on the Public Suffix List, so every machine in one tailnet counts as one site. A page served by another machine in the tailnet is "same site", and the browser sends the SameSite=Strict cookie with its form posts.
- The review proved both: without check 3, a form on another site burned the pairing code, and a form on another tailnet machine posted with the user's device cookie. With no PIN, such a post would be a message in the user's name, so check 3 is the line that keeps other pages out.
- A cross-origin page cannot send `X-Kantoku-Bot` or `application/json` without a CORS preflight, and the listener never answers one. The exact `Origin` closes what is left.

The per-start token of the local page is never served on the remote listener.

### Pairing a phone

1. On the PC page (local only), "📱 つないだ電話" in the title bar opens the info panel at "つないだ電話". "電話をつなぐ" shows a 6-digit code and asks for a device name ("my phone").
2. The code is good for 10 minutes and for 5 tries in total. A wrong fifth try burns it. Only requests that pass checks 1 to 3 count as tries.
3. On the phone, the user opens the ts.net address (inside Tailscale) and types the code. The pairing screen says, before the button, that a paired phone can answer, talk, and register secrets as the user, and how to remove it.
4. The server stores `{ id, name, cookieHash, created, lastSeen, lastSecret }` and sets the device cookie. The cookie lasts 30 days from last use.

### The risk the user accepted

Writing from a paired phone needs nothing beyond the phone itself. That means:

- Someone with the phone, unlocked, can answer any question card as the user, including the "always ask" kind: a deploy, a merge, deleting data.
- They can send any message in the user's name. The manager treats it as the user's own words.
- They can register a secret value of their choosing through an open secret card, for example a CI token that leaks the build to them.
- The phone's own lock (passcode, Face ID, fingerprint) is the only barrier. A phone left unlocked on a desk, or handed to a child, is the user.

The review proved this with a run (finding 9 below): three minutes after the user's last answer, another person sent "deploy: yes" from the open app. Stage 4 adds the setting that closes it (a PIN on every write, or a passkey) for users who want it.

What still holds without a PIN: nobody can write without a paired phone; nothing from the internet, another tailnet machine, or another site gets in (checks 1 to 3); a phone can never pair another phone; and every phone action is labeled with the device name on the PC.

### Removing a phone

Do this as soon as a paired phone is lost, stolen, sold, or out of your hands. Any one step stops the phone; do the first one you can reach.

1. **Away from the PC: remove the phone from your tailnet.** Open the Tailscale admin console in any browser (`login.tailscale.com/admin/machines`), find the phone, and choose "Remove". The phone can no longer reach the PC at all. This works from anywhere and is the fastest.
2. **At the PC: remove it in kantoku bot.** Title bar "📱 つないだ電話" → the phone's row → "外す". Its cookie stops working on the next request. Pairing it again needs a new code from the PC.
3. **From a terminal on the PC:** `node bot/cli.ts --remove-phones` removes every paired phone. `--remote` off (restart without it) closes the phone road entirely.

Then look at the record: every phone action in the last days shows on the PC with the device name (below). Tell the affected managers about any answer or secret you did not make.

### What the phone can do

| Action | Phone | Why |
|---|---|---|
| See managers, status, conversation, info sheet | Yes | Read only, same redaction as the PC |
| Say something | Yes | The point of the phone |
| Answer a question card | Yes | The point of the phone |
| Ask to stop a routine | Yes | It is a `say` with fixed text |
| Register a secret through a secret card | Yes, with a record on the PC | The user's choice; see below |
| Edit description, fix or forget memory | No, shown with "edit on the PC" | Rare, and each one rewrites a file the manager relies on. Fewer write routes on the open road |
| Pair or remove devices | No | Only from the PC, so a phone can never add a phone |

The remote listener has its own route table. Routes the phone cannot use do not exist there (they return `404`), rather than being refused by a flag.

### How the manager tells phone words from PC words

Phone entries are the same entries in `from-user.jsonl`, with one more field:

```json
{"id":"d-20261119-094102-5c1e","at":"2026-11-19T09:41:02+09:00","type":"answer","ask":"q-1119","text":"手元で試す","delivery":"sent","via":"phone:my phone"}
```

- The doorbell is unchanged (`kantoku-bot: <id>`, no text in the letter).
- They carry the same weight as words typed in chat. That is the user's choice; the manager does not second-guess it.
- The manager quotes them as `kantoku bot (my phone) から: …`, so the chat and decisions.md show which device spoke.
- SKILL.md "5. External input" gains one sentence: an entry with `via` is still the user's words; quote the device name.

### Secret cards on the phone

The phone shows the same secret card as the PC: the request, the exact command, a password field, and "登録". The value goes from the phone through Tailscale (WireGuard) and Serve's HTTPS to the remote listener, then only to the command's standard input, the same way as on the PC. It is never written to a file, a log, the page's storage, or a notification.

**The clipboard risk.** A secret pasted on a phone almost always comes through the clipboard, and a phone's clipboard is less private than it looks:

- Keyboard apps (Gboard, Samsung Keyboard, and others) keep a clipboard history, sometimes for an hour or more, and some sync it to the cloud.
- Apple's Universal Clipboard can copy it to the user's Mac or iPad nearby.
- Other apps can read the clipboard when they come to the front. iOS and recent Android show a banner when they do; older Android versions do not.

What the card does about it:

- The field is `type="password"` with `autocomplete="off"`, `autocapitalize="off"`, and `spellcheck="false"`, so the keyboard does not learn it.
- The card says, under the field: "スマホのクリップボードは、ほかのアプリやキーボードの履歴に残ることがあります。登録のあと消してください。"
- After a successful Register, the card offers "クリップボードを空にする", which writes an empty string to the clipboard (`navigator.clipboard.writeText('')`, allowed because the user pressed it). It cannot clear a keyboard's own history; the line above says so.
- The README suggests filling the field from a password manager instead of copying, where the phone allows it.

**The record on the PC.** Every secret registered from a phone leaves a record the user sees on the PC:

- The `secret-done` entry in `from-user.jsonl` gets `via: "phone:<device name>"`, like any phone entry. It still holds only the request id and the exit code.
- The PC conversation shows it as a centered purple line: `📱 my phone から登録しました ・ gh secret set NPM_TOKEN --repo example-org/web ・ exit 0 ・ 8:02`.
- The phone's row under "つないだ電話" shows its last registration (`lastSecret`: request id, command, time).
- The manager quotes it as for any phone entry, so decisions.md has it too.

### Phone layout

See the phone mockup. In words:

- **Two screens, not two columns.** The bot list fills the screen; pressing a row slides the conversation in; `‹` slides it back. The PC's two-column layout is kept above 720 px.
- **List** is one list of glass cards with the avatar, name, last line, and a badge: orange "あなた待ち", purple "秘密". No tabs.
- **Header** in a conversation: round back button, small avatar, name, status. Pressing the name springs the info sheet up from the bottom (a floating sheet with a grab bar and folding sections).
- **Question cards** have a gradient border and stack their choices full width, recommended first and filled, each at least 44 px tall.
- **Input** is a floating glass pill with 16 px text, so iOS does not zoom on focus; the send button is a round `↑`.
- **Connection pill** in the list header: a pulsing green dot and `家の PC` while reachable, `PC に届きません` when the last request failed.
- **Pairing screen**: kantoku bot's avatar, a short line, six digit boxes, the warning, one button; a green check pops in when paired.
- **Notifications** use the same two titles as the desktop and no file text.

## Safety summary

| Threat | What stops it |
|---|---|
| A stranger on the internet | Nothing listens off loopback. No router port. Funnel traffic has no identity header and is refused |
| Another device or user in the tailnet, or a shared-in user | Owner login check, then the paired-device cookie |
| A website open in the user's phone browser, including a page served by another machine in the tailnet (same site under `ts.net`) | Every POST needs the exact Origin, JSON, and `X-Kantoku-Bot`; no CORS preflight is answered. The SameSite cookie alone is not enough |
| A lost or stolen phone, locked | The phone's own lock. Then remove it: Tailscale admin console from anywhere, or "外す" on the PC |
| A paired phone in someone else's hand, unlocked | **Not stopped (the user's choice).** They act as the user, secrets included. Every action is labeled with the device on the PC. Stage 4's setting closes this |
| Guessing the pairing code | Reachable only by the owner's tailnet devices; 10 minutes; 5 tries per code |
| A forged doorbell letter | Unchanged: the letter only carries an id that selects an entry kantoku bot wrote |
| A secret value at rest | Never stored: standard input only, field cleared, no page storage, no logs |
| A secret on the phone's clipboard | Warned on the card; one-press clipboard clear; password manager suggested |
| A program on the PC running as the user | Out of scope, as today; it can already type into the user's terminals |

One thing the user should know: Tailscale's HTTPS certificate puts the machine name and tailnet name in public certificate logs. The README tells the user to pick a machine name that says nothing about them.

## Phone lock options (stage 4)

A setting in the PC info panel under "つないだ電話", `phoneWrites`, kept in `~/.kantoku/.bot/settings.json`:

| Value | What a phone write needs |
|---|---|
| `paired` (default, the user's current choice) | A paired phone |
| `pin` | A paired phone and a 4 to 8 digit PIN with every write (scrypt on the PC; five misses in a row remove the phone) |
| `passkey` | A paired phone and a passkey touch (Face ID, fingerprint) with every write, checked with WebAuthn on the PC |

Only the PC can change it. Turning it on asks each paired phone to set its PIN or passkey the next time it writes. `pin` is small (`node:crypto` `scrypt`). `passkey` needs WebAuthn verification (CBOR, COSE keys) with no dependencies, so it is the larger of the two.

## Files and modules

| File | Change |
|---|---|
| `bot/page/manifest.webmanifest`, `bot/page/sw.js`, `bot/page/icon-192.png`, `bot/page/icon-512.png` | New |
| `bot/page/bot.js`, `bot/page/bot.css`, `bot/page/index.html` | New look and motion, install and notifications buttons, phone layout, pairing screen, phone list in the info panel, secret record line |
| `bot/avatar.ts` | New: the 13 shapes, 11 colors, the default from the name hash, read and write `bot/avatar.json` |
| `bot/create.ts` | New: make a manager's home from the templates (local only) |
| `bot/notices.ts` | New, pure |
| `bot/webpush.ts` | New, VAPID and `aes128gcm` |
| `bot/devices.ts` | New: pairing codes, device store |
| `bot/remote.ts` | New: the remote listener, its checks, its route table |
| `bot/server.ts` | Serves the new page files; exposes routes so `remote.ts` can mount the shared read, write, and secret handlers |
| `bot/cli.ts` | `--login-item`, `--remote`, `--owner`, `--remote-host`, `--remove-phones` |
| `skills/kantoku/SKILL.md` | One sentence on `via` in "5. External input" |
| `README.md` | Install as an app, notifications, phone setup with Tailscale, the risk of a paired phone, removing a phone, clipboard advice |

## Left to the builder

- Icon drawing, and the English labels for the new buttons and notices.
- Exact wording of the pairing screen.
- Whether the service worker refreshes its shell cache by version string or by hash.
- Exact blob colors and timings, within "Look and motion".

## Calls made by the designer (the user can overturn them)

- Remote port `4871`.
- The phone cannot edit the description or memory.
- Notifications carry the bot name and a fixed phrase, never text from the files.
- Device cookies last 30 days from last use.
- The desktop mockup is a new file (`kantoku-app-desktop.html`); `kantoku-bot.html` stays as the record of the current page.
- The designer made one design, not the skill's default of six to compare, because the user had named the target (Grok Bot's dialog and look).
- Avatars live in kantoku bot's own `bot/avatar.json`, not in profile.md, so the manager's files do not change.

## Later

- **Tray shell.** If the PWA window without a tray falls short in daily use, a thin Tauri shell can load `http://127.0.0.1:4870` and add a tray icon and the badge. It would live in its own repo with its own releases, so the plugin stays plain files.

## Adversarial review (2026-11-19)

Two reviewers attacked a draft of this design with runs against the real `bot/` code and small prototypes. Ten findings survived a rerun.

| Finding | Outcome in this design |
|---|---|
| A cached `/` keeps a dead per-start token, so writes fail after a restart | Fixed: the service worker never caches `/` |
| An open secret card never notified and the badge showed 0 | Fixed: open secret cards count as `waiting` and in the badge |
| Reports have no id; text-based ids re-fire on edits, minute-based ids miss a second report | Fixed: done id = report time plus position among reports with that time |
| `redact()` keeps paths and short unlabeled tokens, which would reach the lock screen and the push service | Fixed: notifications carry no file text |
| The same notice could show twice (page plus push, or `localhost` plus `127.0.0.1`) | Fixed: same tag on both paths, push dropped while a window is visible, one origin |
| A login item pinned to one plugin version keeps starting the old version | Fixed: a launcher picks the newest version folder at login |
| A form on another site could burn the pairing code | Fixed: every remote POST needs the exact Origin, JSON, and `X-Kantoku-Bot`, before any try counts |
| `ts.net` is a public suffix, so another tailnet machine is same-site and its forms carry the device cookie | Fixed: same check; the SameSite cookie is not relied on |
| A phone in another person's hand can write as the user (proved against a 15-minute unlock: "deploy: yes" three minutes later) | **Accepted by the user** (2026-11-19): no PIN. Written in "The risk the user accepted"; stage 4 adds the setting that closes it |
| Notification text could carry paths and tokens | Fixed: no file text in notifications |

Not proven by a run, left to plan Task 7 with a real phone and Tailscale: that Serve strips a client-sent `Tailscale-User-Login`, `__Host-` cookie behavior behind Serve, and push on iOS.
