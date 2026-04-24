---
title: "Agent Skills が Visual Studio 2026 18.5 に到着: Copilot がリポジトリから SKILL.md を自動検出"
description: "Visual Studio 2026 18.5.0 で GitHub Copilot は .github/skills、.claude/skills、~/.copilot/skills から Agent Skills を読み込めるようになりました。再利用可能な SKILL.md インストラクションパックがリポジトリと共に移動します。"
pubDate: 2026-04-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "agent-skills"
  - "dotnet"
lang: "ja"
translationOf: "2026/04/visual-studio-2026-copilot-agent-skills"
translatedBy: "claude"
translationDate: 2026-04-24
---

2026 年 4 月 14 日にリリースされた Visual Studio 2026 (バージョン 18.5.0) は、今年最も有用な Copilot 機能のひとつを静かに追加しました: [Agent Skills](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes) です。過去半年間、「うちのリポジトリではこうやって PR をレビューする」と同じ段落を Copilot Chat にコピペし続けていた方は、もうやめて構いません。Agent Skills は再利用可能なインストラクションパックで、コードの隣に住み、Visual Studio の Copilot がそれらを自動的に検出するようになりました。

## Visual Studio が skills を探す場所

Skill とは、`SKILL.md` ファイルを含むフォルダーです。Visual Studio 2026 18.5 は、6 つのよく知られた場所をスキャンします: 3 つはワークスペースに紐づき、3 つはユーザープロファイルに紐づきます:

- ワークスペース: `.github/skills/`、`.claude/skills/`、`.agents/skills/`
- 個人: `~/.copilot/skills/`、`~/.claude/skills/`、`~/.agents/skills/`

重複は意図的です。[agentskills.io の仕様](https://agentskills.io/specification) はオープンフォーマットで、同じフォルダーが GitHub Copilot CLI、Copilot のクラウドエージェント、VS Code から読まれます。`.github/skills/` に skill を置けば、チームが使うあらゆる Copilot のサーフェスから見えます - あなたのマシンの IDE だけではありません。

## SKILL.md の実物

ファイルは YAML フロントマターヘッダー付きの Markdown です。フロントマターには必須フィールドが 2 つ (`name` と `description`)、そして skill の呼び出し方に関するいくつかのオプションフィールドがあります:

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks Copilot to add, squash, or review a migration under src/Infrastructure/Migrations.
argument-hint: [migration file path]
user-invocable: true
disable-model-invocation: false
---

# EF Core migration review

When reviewing a migration under `src/Infrastructure/Migrations`:

1. Reject any migration that drops a column without a corresponding data backfill step.
2. Flag `AlterColumn` calls that change nullability on tables with more than 10M rows. Point at `docs/ops/large-table-playbook.md`.
3. Require a matching `Down()` that is a true inverse, not an empty stub.

Reference implementation: see `examples/add-index-migration.md` in this skill folder.
```

`name` フィールドは小文字、ハイフン区切り、最大 64 文字で、フォルダー名と一致しなければなりません。`description` フィールドは Copilot が skill をロードするかどうかを判断するために使うので、タグラインのようにではなく、retrieval クエリのように書く価値があります。最大長は 1024 文字で、使い切ってよいです。

## なぜこれがデフォルトを変えるのか

これまでの一般的なパターンは、肥大化した `.github/copilot-instructions.md` や `.agent.md` で定義されたカスタムエージェントでした。Agent Skills は設計上より絞られています: 各 skill は単一の関心事で、オンデマンドでロードされ、description がマッチしたときに本文だけがコンテキストウィンドウに入ります。EF Core マイグレーション、MAUI プラットフォームコード、ASP.NET Core コントローラーを持つ .NET モノレポなら、巨大なインストラクションファイルではなく 3 つの別個の skill を出荷でき、現在のタスクに無関係なガイダンスにトークンを燃やすのをやめられます。

Skills は Custom Agents と組み合わせ可能でもあります。`.agent.md` ファイルは取り込む skills を絞れるので、チームは EF Core と ASP.NET Core の skills だけを見る「backend-reviewer」エージェントと、MAUI と Flutter の skills を見る「mobile-reviewer」エージェントに行き着きます。

Microsoft はブラウジングと作成の UI が後の 18.x アップデートでまだ出る予定だと述べているので、当面はフォルダー内のテキストファイルです。それで構いません。フォルダー内のテキストファイルは、まさにバージョンコントロールのためにあるものです。
