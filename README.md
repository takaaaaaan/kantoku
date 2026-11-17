# kantoku(監督)

kantoku は、2人から学んで作りました。

- [poteto](https://x.com/poteto) さんの [pstack](https://github.com/cursor/plugins/tree/main/pstack)。監督のしかた(検証役を分ける・最初は1件だけ通す・原因に合わせてやり直す)を、その Orchestrate の手順から学びました。
- Grok Bot の開発に携わる [Lee Robinson(leerob)](https://leerob.com/) さん。常駐して動き続けるエージェントの作りの話に感銘を受けました。

この2つを、自分の [Orca](https://github.com/stablyai/orca) 環境で組み立ててみたくて作ったのが kantoku です。

> English: kantoku is inspired by [poteto](https://x.com/poteto)'s [pstack](https://github.com/cursor/plugins/tree/main/pstack), whose Orchestrate playbook taught me how to supervise agents, and by [Lee Robinson (leerob)](https://leerob.com/), whose talk on how Grok Bot's always-on agent is built made me want to build the same idea on my own Orca setup.

## kantoku とは

Claude Code のセッションを1つ「監督」にして、実際の仕事は [Orca](https://github.com/stablyai/orca) の子セッションに配る skill です。
あなたは監督にタスクを渡すだけ。監督は子に配り、子からの質問を仕分け、別の子に検証させ、終わるまで見回ります。

> English: kantoku turns one Claude Code session into a manager. It never does the work itself. It dispatches tasks to Orca child sessions, triages their questions (decide / provisional / ask the human), has a separate verifier check each result, and patrols until done.

```
あなた ──タスク──→ 監督くん ──spec──→ 子セッション(Orca)
   ▲                 │  ▲               │
   │  判断が要るものだけ │  └──質問(ask)──┘
   └─────────────────┘
                     │
                     └──→ 検証役の子(別モデル)── 合格/不合格
```

## できること

- **監督は仕事をしない。** 監督が使ってよい道具を白リストで決めています。実作業はコマンド1本でも子に配ります。
- **子は Orca の見える子セッション。** サイドバーで監督の下に並び、あなたは途中で子と直接話せます。
- **質問を3つに仕分ける。** A 監督が決める / B 仮決めで進めて後で確認 / C 人に回す。人に聞く数を減らします。
- **検証役。** 作った子とは別の子(できれば別のモデル)が、差分を読んでテストを再実行します。合格は head SHA ごと。
- **自律度を仕事ごとに設定。** 外への書き込み(`auto` / `ask`)と merge(`after-verifier` / `never`)を `profile.md` で選べます。取り消せない操作は常に止まって聞きます。
- **名前つきの監督。** `/kantoku infra` と `/kantoku web` で担当と状態を分けて持ちます。タブ名は「<名前>くん」。
- **見回り。** 30分ごとの予備の見回り。変化なしが3回続くと自分で止まります。
- **外からの入力。** Discord bot・GitHub Actions・cron から `orca orchestration send` で監督を起こせます。

## 必要なもの

| 必須 | 任意(あると使う) |
|---|---|
| [Claude Code](https://claude.com/claude-code) | [pstack](https://github.com/cursor/plugins/tree/main/pstack)(`recall` `sharpen` `ketchup` `reflect` `show-me-your-work` `blast-radius` など) |
| [Orca](https://github.com/stablyai/orca)(監督は Orca の端末の中で起動する) | [superpowers](https://github.com/obra/superpowers)(`brainstorming` `writing-plans` TDD) |
| `gh`(GitHub CLI) | `agent-desktop` / `jev-desktop` / `claude-in-chrome`(画面操作) |
| | Codex CLI(検証役を別モデルにする) |

## 入れ方

```bash
/plugin marketplace add takaaaaaan/kantoku
/plugin install kantoku@kantoku
```

プラグインの skill は `/kantoku:kantoku` で呼びます。

## 使い方

1. Orca の端末で Claude Code を開き、`/kantoku:kantoku <名前>` を打つ(例: `/kantoku:kantoku infra`)。
2. 初回は `~/.kantoku/<名前>/profile.md` を監督と一緒に埋める(担当・対象リポ・自律度・必ず聞く一覧)。
3. タスクを渡す。あとは監督が配って、判断が要るものだけまとめて聞いてきます。

状態はすべて `~/.kantoku/<名前>/` のファイルにあります。会話を `/clear` しても続きから再開できます。

```
~/.kantoku/<名前>/
 ├─ profile.md     担当・対象リポ・自律度・必ず聞く一覧
 ├─ state.md       Run ID・子ごとの状態・待ち列・見回りの予約
 ├─ decisions.md   判断の記録
 └─ specs/         子に渡した指示書
```

## ヒント

- `/config` で auto-compact をオンにしてください。監督の会話が上限に届いても止まらなくなります。
- skill 本体は [`skills/kantoku/SKILL.md`](./skills/kantoku/SKILL.md) です。

## ライセンス

MIT
