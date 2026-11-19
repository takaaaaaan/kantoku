# Duties of <name>

<!-- On the first `/kantoku <name>` startup, copy this to ~/.kantoku/<name>/profile.md and fill it in.
     The manager starts no child until this is filled in. -->

## Duties
<!-- The work given to this manager, in 1 to 3 sentences. Example: "Move the issues of web app X forward" -->

## Target repos (Orca repoId)
<!-- Look up repoId with `orca repo list --json` -->
| Repo | Path | repoId | Tests |
|---|---|---|---|
| | | | |

## Intake
- Task source: <!-- Example: GitHub issue (`gh issue view <number> -R <owner>/<repo>`) -->
- How to file: <!-- Example: the issue-creation skill to use. Filing always needs user confirmation -->
- Child worktree name: `<repo>-<issue-number>-<short-name>`

## Extra skills (added to child specs)
<!-- Example: an issue and PR workflow skill, a repo-specific rules skill -->

## Autonomy
- External writes: auto <!-- auto | ask. Push to its own branch, create and update PRs, comment on issues, post to chat -->
- merge: after-verifier <!-- after-verifier | never. If the repo rules say "agents do not merge", use never -->

## Always-ask list
<!-- On top of "Always C" in SKILL.md, the operations this work always asks a human about. Example: releasing to production, changing permissions, filing a new issue, forwarding webhooks with kantoku-watch on a repo the user does not own -->

## Browser accounts (used with claude-in-chrome)
<!-- For each site, which Chrome profile and which account to operate with. Unknown cells may stay empty (the manager checks and fills them in the first time) -->
| Site | Chrome profile | Account |
|---|---|---|
| | | |

## External input (what may go into the queue)
<!-- Of the letters that arrive by orca orchestration send, the sources and kinds that may become tasks without asking the user. Anything not listed here goes to the user queue -->
| Source | Kind | Handling |
|---|---|---|
| (Example) chat #requests channel | Config change requests | Put in the queue |
| (Example) GitHub Actions | CI failure notices | Put in the queue (dispatch a child to find the cause) |
| kantoku-watch | CI, review, comment, merge notices | Not a task. The owner child already got the details; check `gh pr view` before acting on the summary |

## Language
<!-- Example: chat in Japanese. Commit messages and PRs in English -->
