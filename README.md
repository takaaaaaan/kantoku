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

## Requirements

| Required | Optional (used when present) |
|---|---|
| [Claude Code](https://claude.com/claude-code) | [pstack](https://github.com/cursor/plugins/tree/main/pstack) |
| [Orca](https://github.com/stablyai/orca) (start the manager inside an Orca terminal) | [superpowers](https://github.com/obra/superpowers) (`brainstorming`, `writing-plans`, TDD) |
| `gh` (GitHub CLI) | `agent-desktop`, `jev-desktop`, `claude-in-chrome` (screen control) |
| | Codex CLI (to run the verifier on a different model) |

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

## Tips

- Turn on auto-compact in `/config`, so the manager keeps working when its context fills up.
- The skill itself is [`skills/kantoku/SKILL.md`](./skills/kantoku/SKILL.md). It is currently written in Japanese.

## License

MIT
