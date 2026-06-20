---
title: "Binlog MCP サーバーで AI が MSBuild のログを読めるようになります"
description: "Microsoft は 2026-06-17 に Microsoft.AITools.BinlogMcp を公開しました。Claude や Copilot が .binlog ファイルから直接ビルド失敗や遅い target を診断できる 15 個のツールを公開する MCP サーバーです。"
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
lang: "ja"
translationOf: "2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds"
translatedBy: "claude"
translationDate: 2026-06-20
---

2026-06-17 に Microsoft は [Binlog MCP サーバー](https://devblogs.microsoft.com/dotnet/msbuild-binlog-mcp-server/)を公開しました。MSBuild のバイナリログを解析し、それを調査するための 15 個の専用ツールを AI アシスタントに渡す MCP サーバーです。狙いはシンプルです。数メガバイトの `.binlog` を MSBuild Structured Log Viewer で開いてネストした target を手作業で追う代わりに、「なぜビルドが失敗したのか?」と尋ねれば、モデルが代わりにログを読みに行きます。

## なぜ binlog が適切な対象なのか

バイナリログは MSBuild が生成する最も忠実度の高い記録です。すべての target、タスク、プロパティ評価、item に加えて、ビルド時に埋め込まれたソースファイルを記録します。まさにこの詳細さが手作業での読み取りを苦痛にし、まさにそれをモデルはうまくクエリできます。パーサーを Model Context Protocol の背後に置くことで、同じログが任意の MCP クライアント、つまり Claude Code、VS Code の Copilot、Visual Studio で動作します。

いつもどおりの方法で生成します。

```bash
dotnet build /bl:build-a.binlog
```

## MCP クライアントへの組み込み

このサーバーは dotnet ツール `Microsoft.AITools.BinlogMcp` として公開されています。VS Code では `mcp.json` を stdio 経由でそこに向けます。

```json
{
  "servers": {
    "binlog-mcp": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["tool", "run", "Microsoft.AITools.BinlogMcp"]
    }
  }
}
```

起動時にモデルに特定のログを開かせたい場合は、区切り文字 `--` の後に渡します。

```json
{
  "args": ["tool", "run", "Microsoft.AITools.BinlogMcp", "--", "--binlog", "msbuild.binlog"]
}
```

Visual Studio と VS Code は `dotnet/skills` マーケットプレイスの `dotnet-msbuild` プラグイン経由でも取り込めます。これはサーバーを自動検出するため、JSON を完全に省略できます。

## 実際に尋ねる内容ごとにグループ化した 15 個のツール

ツールは 4 つの仕事に分かれます。赤いビルドを診断するには `binlog_overview`(ステータス、所要時間、エラーとプロジェクトの数)、`binlog_errors`、コードでフィルタできる `binlog_warnings`、そして StructuredLog の DSL で全文クエリを実行する `binlog_search` があります。目玉は `binlog_explain_property` です。プロパティの値が実際にどこから来たのかを追跡するため、「なぜここで `TargetFramework` が net8.0 に設定されているのか?」のような質問は、推測ではなく評価チェーンを返します。

遅いビルドには `binlog_expensive_projects`、`binlog_expensive_targets`、`binlog_expensive_tasks` が実時間で順位付けします。そして `binlog_compare` は 2 つのログを diff します。これこそ元を取ると私が期待するツールです。

> `build-a.binlog` と `build-b.binlog` を比較して。どの MSBuild プロパティとパッケージのバージョンが変わった?

この 1 つのプロンプトが、ビルドが自分のマシンでは動くのに CI では失敗するときに行う、退屈な左右比較に取って代わります。

これは、エージェントが操作できるよう Microsoft が .NET の診断を MCP でラップするという、より広いパターンの一部です。サーバーは [`dotnet/skills`](https://github.com/dotnet/skills) にあります。問題はそこに報告してください。誰も開きたがらないログに詰まった不安定な CI ビルドがあるなら、これがモデルをそこに向ける最も手間の少ない方法です。
