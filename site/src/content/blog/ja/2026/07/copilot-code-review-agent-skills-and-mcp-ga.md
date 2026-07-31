---
title: "Copilot code review が .github/skills フォルダーを読むようになりました"
description: "GitHub Copilot code review の agent skills と MCP サーバー対応が 2026-07-29 に一般提供されました。ファイルの置き場所、skills が head ブランチから読み込まれる理由、レビュー中の MCP ツール呼び出しがすべて読み取り専用である理由を解説します。"
pubDate: 2026-07-31
tags:
  - "github-copilot"
  - "agent-skills"
  - "mcp"
  - "code-review"
  - "ai-agents"
lang: "ja"
translationOf: "2026/07/copilot-code-review-agent-skills-and-mcp-ga"
translatedBy: "claude"
translationDate: 2026-07-31
---

2026-07-29 に GitHub は [Copilot code review の agent skills と MCP サポート](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/)を Copilot Pro、Pro+、Business、Enterprise 向けに一般提供しました。これまでレビュー担当のエージェントが読めるのは差分とカスタム指示だけで、それがコンテキストウィンドウのすべてでした。今後はコーディングエージェントが使うのと同じ skill フォルダーに加えて、MCP サーバーからの読み取り専用のコンテキストも取り込めます。

これで自動レビューの最も厄介な穴がふさがります。ボットは `null` チェックが抜けていることは指摘できても、チームが EF Core のマイグレーションごとに空でない `Down()` を必須にしていることは知らず、この PR が閉じる issue が前のスプリントで既に取り消されていたかどうかを調べる手段もありませんでした。

## skill はフォルダーであり、レビュー側が自分で選ぶ

skill とは `.github/skills` 配下のディレクトリで、その中に `SKILL.md` を置いたものです。Copilot はタスクと各 skill の `description` を照合し、関連しそうなものだけを読み込みます。したがってレビュー向けの skill には、レビュー作業だと分かるディレクトリ名と説明文が必要です。

```md
---
name: ef-core-migration-review
description: Review EF Core migrations for a non-empty Down(), no data loss on column drops, and an explicit index name. Use when the diff touches Migrations/.
---

## What to flag

- A `Down()` method with only `// no-op` or an empty body. Every migration must be reversible.
- `DropColumn` without a preceding data copy. Comment with the backfill snippet from `references/backfill.md`.
- `CreateIndex` without an explicit `name:` argument.
```

押さえておく価値のある点として、Copilot code review は指示と skills をベースブランチではなく **head ブランチ**から読み込みます。skill を編集して PR を開けば、その PR 自体が編集後の skill でレビューされます。つまりレビュールールをマージ前に反復して試せるわけで、これは CI ベースの lint 設定の大半とは逆の挙動です。

## MCP は既定で有効、そして設計上つねに読み取り専用

レビュー用の MCP サーバーはリポジトリ設定の Copilot > MCP servers で構成し、クラウドエージェントが使うのと同じ JSON を利用します。GitHub と Playwright のサーバーは最初から有効です。

```json
{
  "mcpServers": {
    "issue-tracker": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $COPILOT_MCP_TRACKER_TOKEN" },
      "tools": ["search_issues", "get_issue"]
    }
  }
}
```

トークンはリポジトリ設定の Secrets and variables > Agents に置き、`$COPILOT_MCP_*` として参照します。レビュー中に実行される MCP ツール呼び出しはすべて読み取り専用に制限されます。これは妥当な判断です。issue tracker に書き込めるレビュー担当エージェントは、pull request の本文からプロンプトインジェクションを受けうるレビュー担当エージェントでもあるからです。なお `"tools": ["*"]` も依然として受け付けられますが、GitHub 自身は個別のツールを許可リストに入れることを推奨しています。エージェントは承認ステップなしに自律的にツールを使うためです。

MCP をクラウドエージェント専用にとどめたい場合、リポジトリ設定の "Allow Copilot to use MCP tools when reviewing pull requests" は既定で有効になっており、無効化できます。skill や MCP ツールに基づくレビューコメントには帰属情報が付くようになったので、どのルールがどの指摘を生んだのかを判別できます。

リポジトリにまだ `.github/prompts/` フォルダーが残っているなら、[prompt ファイルを agent skills へ移行する](/2026/07/migrate-copilot-prompt-files-to-agent-skills/)作業を終わらせる好機です。同じ `SKILL.md` が IDE、クラウドエージェント、レビュー担当エージェントのすべてを動かします。
