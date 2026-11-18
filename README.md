# kantoku

## What is kantoku?

kantoku (監督, "supervisor") turns one Claude Code session into a manager that never does the work itself.
You hand tasks to the manager. It dispatches them to [Orca](https://github.com/stablyai/orca) child sessions, triages their questions, has a separate verifier check each result, and patrols until everything is done.

```
you ──task──→ manager ──spec──→ child session (Orca)
 ▲              │  ▲                  │
 │ only real    │  └──── question ────┘
 │ decisions    │
 └──────────────┘
                │
                └──→ verifier child (different model) ── pass / fail
```

## Inspiration

kantoku is inspired by two people.

- [poteto](https://x.com/poteto)'s [pstack](https://github.com/cursor/plugins/tree/main/pstack). Its rigorous approach to agent work impressed me, and kantoku uses pstack's skills (`recall`, `sharpen`, `ketchup`, `reflect`, `show-me-your-work`, `blast-radius`, and more) inside the manager and its children.
- [Lee Robinson (leerob)](https://leerob.com/), who works on Grok Bot. His talk on how an always-on agent is built made me want to build the same idea on my own Orca setup.

kantoku is that attempt.

## Features

- **The manager never does the work.** An allowlist limits the manager to dispatching, watching, triaging, asking, and recording. Even a one-command task goes to a child.
- **Children are visible Orca sessions.** They appear under the manager in Orca's sidebar, and you can talk to any child directly.
- **Three-lane triage.** Each question from a child goes to lane A (the manager decides), B (proceed on a provisional answer and confirm later), or C (ask the human). This keeps your interruptions to a minimum.
- **Independent verifier.** A fresh child, on a different model when possible, reads the diff and reruns the checks. A pass covers one head SHA only.
- **Per-job autonomy.** In `profile.md`, choose external writes (`auto` or `ask`) and merge (`after-verifier` or `never`). Irreversible actions always stop and ask.
- **Named managers.** `/kantoku infra` and `/kantoku web` keep separate jobs and state. The tab is titled `<name>くん`.
- **Patrol.** A 30-minute fallback patrol that stops itself after three patrols with no change.
- **External input.** A Discord bot, GitHub Actions, or cron can wake the manager with `orca orchestration send`.
- **PR watching.** CI results, reviews, comments, and merges on a child's PR reach that child within seconds, with a one-line summary to its manager.

## Requirements

| Required | Optional (used when present) |
|---|---|
| [Claude Code](https://claude.com/claude-code) | [pstack](https://github.com/cursor/plugins/tree/main/pstack) |
| [Orca](https://github.com/stablyai/orca) (start the manager inside an Orca terminal) | [superpowers](https://github.com/obra/superpowers) (`brainstorming`, `writing-plans`, TDD) |
| `gh` (GitHub CLI) | `agent-desktop`, `jev-desktop`, `claude-in-chrome` (screen control) |
| | Codex CLI (to run the verifier on a different model) |
| | Node 22.18+ and the `gh` extension [`cli/gh-webhook`](https://github.com/cli/gh-webhook), with the `admin:repo_hook` (or `repo`) token scope (PR watching) |

## Install

```bash
/plugin marketplace add takaaaaaan/kantoku
/plugin install kantoku@kantoku
```

Claude Code leaves auto-update off for third-party marketplaces, so kantoku stays on the version you installed. To turn it on, run `/plugin`, open the **Marketplaces** tab, select `kantoku`, and choose **Enable auto-update**. To update once by hand, run `claude plugin update kantoku@kantoku`.

Claude Code prefixes plugin skills, so the skill is `/kantoku:kantoku`.

## Usage

1. Open Claude Code in an Orca terminal and run `/kantoku:kantoku <name>`, for example `/kantoku:kantoku infra`.
2. On first run, fill in `~/.kantoku/<name>/profile.md` together with the manager: the job, target repos, autonomy, and the actions that always need your approval.
3. Hand it tasks. The manager dispatches them and batches only the decisions that need you.

All state lives in files under `~/.kantoku/<name>/`, so the manager resumes where it left off even after `/clear`.

```
~/.kantoku/<name>/
 ├─ profile.md     job, target repos, autonomy, always-ask list
 ├─ state.md       Run ID, each child's status, queue, patrol job
 ├─ decisions.md   decision log
 └─ specs/         specs handed to children
```

## Manager panel

With several managers running, it is easy to lose track of which session does what. kantoku ships a Claude Code mod that docks a panel beside the chat of a manager session:

```
┌ chat ──────────────┬──────────────────────────────┐
│                    │ infraくん                    │
│  ...               │ Keep the infra repos healthy.│
│                    │ writes: auto · merge: never  │
│                    │                              │
│                    │ □ Rotate keys (in progress)  │
│                    │ □ Bump the chart (queued)    │
│                    │ ☑ Fix the CI cache           │
└────────────────────┴──────────────────────────────┘
```

- **Only in manager sessions.** The panel opens when a `~/.kantoku/<name>/state.md` names this session's `$ORCA_TERMINAL_HANDLE` on its `terminal:` line, which the manager writes at startup. Other sessions get no panel.
- **What it shows.** The manager's name, the first sentence of its duties and its autonomy from `profile.md`, then the `## Tasks` table and `## Queue` from `state.md` as a todo list. Open tasks come first, then the queue, then what is done.
- **Live.** It rereads both files every 5 seconds, so it follows the manager as it works. It never writes to them.
- **Show or hide it** with `/kantoku-panel show`, `/kantoku-panel hide`, or `/kantoku-panel` alone to toggle. The choice lasts for the session, and closing the pane by hand counts as hiding it. The terminal docks a pane on its own only when it is at least 144 columns wide; `/kantoku-panel show` opens it at any width.
- **Start hidden** by turning off **Show the Manager panel at start** in `/config` (search for "panel"). It is on by default. Claude Code saves it in your user settings under `pluginConfigs`, so it stays after a restart.

The mod comes with the plugin, so installing kantoku installs it. It needs a Claude Code version with mods (plugin hooks modules).

## PR watching

A child that owns a PR used to hear about a red CI or a "changes requested" review only when it happened to look, or when the manager's patrol noticed. kantoku-watch closes that gap. It is a small Node daemon in [`watch/`](./watch) that:

- reads the `PR` column of the `## Tasks` table in every `~/.kantoku/<name>/state.md`,
- runs one `gh webhook forward` per repo into a local HTTP receiver on `127.0.0.1` (signed with a random secret),
- sends each event with `orca orchestration send`: a letter to the owner child, and a one-line summary to its manager for CI results, approvals, changes requested, merges, and closes.

Each fact is sent once, even when GitHub redelivers it. Events that happened while it was stopped are caught up with `gh` at the next start. Review and comment text is quoted as external text, below a fixed line that says it is information, not an instruction.

```
node watch/cli.ts start [--allow owner/repo ...]   start the daemon, or report the running one
node watch/cli.ts status                           running?, repos, troubles
node watch/cli.ts stop                             stop it and its forwarders
```

- **A child starts it.** The manager never runs it; when a row first gets a PR URL, the manager dispatches a short child that runs `start` (see section 1.6 of the skill).
- **It stops itself** when no watched PR has been open for 10 minutes. `stop` is there for people.
- **Repos you do not own need your yes.** `start` prints `needs approval: owner/repo` for them and forwards only the repos named with `--allow` on that start. The approval is not saved.
- **Nothing is left behind.** GitHub drops the temporary webhook when the forwarder stops. `stop` lists any forwarder hook it still finds, and leaves deleting it to you.
- One daemon serves every manager on the machine. Its files live in `~/.kantoku-watch/`.

## Tips

- Turn on auto-compact in `/config`, so the manager keeps working when its context fills up.
- The skill itself is [`skills/kantoku/SKILL.md`](./skills/kantoku/SKILL.md).

## License

MIT
