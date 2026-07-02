---
title: "Binlog MCP Server を CI で実行してビルド失敗を自動でトリアージする"
description: "2026-06-30 に Microsoft は Binlog MCP Server を GitHub Agentic Workflow の中で無人で動かして見せました。CI のビルドが失敗した瞬間にエージェントが .binlog を読み、根本原因をコメントします。"
pubDate: 2026-07-02
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
  - "ci"
lang: "ja"
translationOf: "2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures"
translatedBy: "claude"
translationDate: 2026-07-02
---

2026-06-30 に .NET チームは [MCP Beyond the Chat Window: Build Diagnostics in CI](https://devblogs.microsoft.com/dotnet/mcp-build-diagnostics-workflows/) を公開しました。これは Binlog MCP Server をエディターから取り出し、パイプラインの中に置くものです。2 週間前まで、このサーバーはローカルの `.binlog` に対して Claude や Copilot を手作業で向けるものでした（そのセットアップは [Binlog MCP Server で AI に MSBuild のログを読ませる](/ja/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) で扱いました）。新しいデモはそれを GitHub Actions の中で無人で実行します。ビルドが失敗すると、エージェントがログを読み、誰かが何かをダウンロードするより前に、根本原因のコメントが pull request に届きます。

## なぜ binlog にとって CI がより良い置き場所なのか

インタラクティブな使い方も良いのですが、本当の痛みは CI にあります。ビルドが赤くなり、数メガバイトのバイナリログを runner から取り出し、MSBuild Structured Log Viewer を開き、重要なただ 1 つのエラーを探して入れ子の targets をスクロールします。パーサーをパイプラインに移すと、この一連のループがまるごと消えます。`.binlog` は runner を離れることがなく、読み取りはモデルが行います。

ログの生成方法はこれまでと同じです。MSBuild ベースの任意のコマンドに `/bl` を追加します。

```bash
dotnet build /bl
dotnet test /bl
dotnet pack /bl
```

## GitHub Agentic Workflow への組み込み

重要な違いは、サーバーがコンテナーイメージとして配布される点です。そのため workflow はログを読み取り専用でマウントし、エージェントにクエリさせます。`microsoft/testfx` リポジトリはおおよそ次の形を使っています。

```yaml
mcp-servers:
  binlog-mcp:
    container: "mcr.microsoft.com/dotnet-buildtools/prereqs:azurelinux-3.0-binlog-mcp-amd64"
    mounts:
      - "/tmp/build.binlog:/data/build.binlog:ro"
    allowed: ["*"]
```

ジョブはバイナリログ付きでビルドを実行し、ビルドが失敗したときにのみエージェントを起こします。グリーンのときは何も動かないため、通過したビルドに対してトークンのコストは一切かかりません。

## binlog_diagnose が最初のパスを担う

これを実用的にしているツールが `binlog_diagnose` です。エージェントが `binlog_errors`、`binlog_search`、`binlog_target_reasons` を自分でつなぎ合わせる代わりに、`binlog_diagnose` はログを読み、エラーをグループ化し、根本原因の候補を特定し、1 回の呼び出しで修正案を提示します。残りのツール群（`binlog_overview`、`binlog_compare`、`binlog_task_details`、そしてパフォーマンス、依存関係グラフ、インクリメンタルビルドのイントロスペクションを扱う増え続けるツール群）は、エージェントがさらに深掘りする必要があるときにそのまま使えます。

Microsoft 自身の評価では、これらのツールをエージェントに与えることで、診断の品質スコアはツールなしのベースラインの 3.25 から 3.68 へ上がり、およそ 44% 速く（全体時間で 196s vs 350s）完了しました。速くてより良いというのは珍しい組み合わせで、これはエージェントが生のログテキストを grep するのではなく、構造化データにクエリを投げることから来ています。

開けたい人が誰もいないログを繰り返し生み出す不安定な CI ビルドを抱えているなら、これはチームの時間を本当に節約するセットアップの形です。トリアージは自動的に、PR 上で、失敗がまだ新しいうちに行われます。
