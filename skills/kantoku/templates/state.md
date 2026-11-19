# <name> state

<!-- On the first `/kantoku <name>` startup, copy this to ~/.kantoku/<name>/state.md.
     Startup step 6 adds the `terminal:` and `run:` lines above "## Tasks"; the patrol adds `patrol_job:` and `patrol_noop:`.
     Keep the `## Tasks` and `## Queue` headings and the Status column: the manager panel (the kantoku mod beside the chat) reads them. -->

## Tasks
<!-- One row per task. Status starts with a short word: "in progress", "waiting for verifier", "done", "merged".
     PR: the URL of the PR this child owns, once it exists. Only the owner's row has it (a verifier's row does not). kantoku-watch sends this PR's events to the row's dispatch ID. -->
| Task | Child worktree | dispatch ID | PR | Status | Pending gate |
|---|---|---|---|---|---|

## Queue
<!-- Tasks not dispatched yet, one bullet each. -->

## Why woken
<!-- One dated line each time the manager is woken: a user request or an external notice. -->
