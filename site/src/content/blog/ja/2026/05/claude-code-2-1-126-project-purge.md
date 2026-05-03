---
title: "Claude Code 2.1.126 が `claude project purge` を追加、リポジトリの全状態をまとめて削除"
description: "Claude Code v2.1.126 は claude project purge を導入しました。新しい CLI サブコマンドで、プロジェクトパスに紐づくすべてのトランスクリプト、タスク、ファイル履歴エントリ、設定ブロックを 1 回の操作で削除します。--dry-run、--yes、--interactive、--all をサポートします。"
pubDate: 2026-05-03
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "ja"
translationOf: "2026/05/claude-code-2-1-126-project-purge"
translatedBy: "claude"
translationDate: 2026-05-03
---

2026 年 5 月 1 日にリリースされた Claude Code v2.1.126 は、小さなコマンドながら掃除の物語としては大きな `claude project purge [path]` を追加しました。リポジトリに対して実行すると、CLI はそのプロジェクトパスに紐づくすべてのトランスクリプト、タスク、ファイル履歴エントリ、`~/.claude/projects/...` の設定ブロックを 1 回の操作で削除します。1 年分のセッション履歴がたまったプロジェクトをリセットするために、`~/.claude/projects/` を手で掘り返す必要はもうありません。

## なぜ `rm -rf` ではなく専用コマンドなのか

Claude Code のプロジェクトごとの状態は、同時に複数の場所に存在します。`~/.claude/projects/<encoded-path>/` 配下のプロジェクトディレクトリには JSONL トランスクリプト、保存されたタスク一覧、ファイル履歴のスナップショットが入っています。グローバルな `~/.claude/settings.json` とプロジェクトごとの設定にも、そのディレクトリを絶対パスで指すエントリがあります。プロジェクトフォルダだけを消すと参照が宙ぶらりんになり、設定エントリだけを消すと孤児になったメガバイト単位のトランスクリプトが残ります。

v2.1.126 までは、公式の答えは慎重な手作業のクリーンアップでした。新しいサブコマンドは CLI の他の部分が使うのと同じ内部マップをたどるため、トランスクリプト、タスク、ファイル履歴、設定エントリが 1 回の一貫したパスで消えます。今いるディレクトリに対して実行する場合は、パスを省略できます。

```bash
# Nuke everything Claude Code knows about the current repo
claude project purge

# Or target an absolute path from elsewhere
claude project purge /home/marius/work/legacy-monolith
```

## スクリプトで安全に使えるようにするフラグ

面白いのはフラグの面です。このリリースでは 4 つを提供します。

```bash
# Show what would be deleted without touching anything
claude project purge --dry-run

# Skip the confirmation prompt (CI-friendly)
claude project purge -y
claude project purge --yes

# Walk projects one at a time and choose
claude project purge --interactive

# Purge every project Claude Code has ever recorded
claude project purge --all
```

`--dry-run` は、削除対象となるプロジェクト ID、トランスクリプト数、ディスク上のバイト数を出力します。`--all` は重いハンマーで、記録されたパスの多くがディスク上にもう存在しないノート PC の移行後に便利です。`-i` は長いリストを仕分けするための中間モードです。

## v2.1.126 全体像のなかでの位置付け

`project purge` は、このリリースにおける状態管理のいくつかの変更のひとつです。同じビルドでは、`--dangerously-skip-permissions` が `.claude/`、`.git/`、`.vscode/`、シェル設定ファイルなど、以前は保護されていたパスにも書き込めるようになりました。これは purge モデルと方向性が一致しています。Claude Code は、自身の足跡を吹き飛ばすためのより無骨なツールをユーザーに渡す方向に傾いており、ユーザーが何をしているか分かっていることを前提にしています。以前の [Claude Code 2.1.122 の Bedrock service tier 環境変数](/ja/2026/04/claude-code-2-1-122-bedrock-service-tier/) も「ひとつのつまみ、SDK の変更なし」というスタイルの似たリリースでした。v2.1.126 はそのパターンを続けています。

組織でピン留めされた設定ポリシーである管理下の `~/.claude` のもとで Claude Code を実行している場合、`--all` はあなたのユーザープロファイル配下に状態があるプロジェクトのみを purge します。管理ポリシーファイルそのものには触れません。

詳細は [Claude Code v2.1.126 リリースページ](https://github.com/anthropics/claude-code/releases/tag/v2.1.126) を参照してください。
