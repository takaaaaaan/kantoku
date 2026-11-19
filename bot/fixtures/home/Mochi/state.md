# Mochi state

terminal: term_fixture-mochi
run: run_fixturemochi
patrol_job:

## タスク
| タスク | 子の worktree | dispatch ID | 状態 | 待っている gate |
|---|---|---|---|---|
| 検索の並び替え | example-sort | ctx_fixture1 | PR 待ち | user: どこで試すか |
| 古い修正 | example-old | ctx_fixture0 | merge 済 | - |

## 待ち列
