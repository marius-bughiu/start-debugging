---
title: "Aspire 13.6 のダッシュボードは直近 10 回の実行を SQLite に保持します"
description: "Aspire 13.6.0 でダッシュボードが永続化されます。リソースのスナップショットとテレメトリは SQLite データベースに保存され、AppHost はアプリケーションごとに最大 10 回分の実行を保持し、完了した実行は読み取り専用で参照できます。Run、Resume、None の各モードの動作と、スタンドアロンダッシュボードの設定方法を解説します。"
pubDate: 2026-09-30
tags:
  - "aspire"
  - "dotnet"
  - "opentelemetry"
  - "observability"
lang: "ja"
translationOf: "2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs"
translatedBy: "claude"
translationDate: 2026-09-30
---

[Aspire 13.6.0](https://github.com/microsoft/aspire/releases/tag/v13.6.0) が 2026 年 9 月 29 日にリリースされました。最初に気づく変更は、AppHost を停止してもダッシュボードがすべてを忘れなくなったことです。13.5 まで、ダッシュボードはテレメトリをメモリに保持していたため、バグを再現した直後に Ctrl+C を押すと、必要だったトレースは消えてしまいました。13.6 ではダッシュボードがリソースのスナップショットとテレメトリをバージョン管理された SQLite データベースに保存し、ヘッダーのセレクターで現在の実行と過去の実行を切り替えられます。

## AppHost の既定の動作

AppHost がダッシュボードを起動する場合、オプトインなしで **Run** 永続化が使われます。`aspire run` を実行するたびに別のエントリになり、アプリケーションごとに最大 10 回分の実行が保持されます。完了した実行は読み取り専用なので、修正前の実行を開き、そのリソース、構造化ログ、トレース、メトリクスを現在の実行と並べて比較できます。

AppHost のコードは何も変わりません。昨日と同じファイルのままです。

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithReference(cache);

builder.Build().Run();
```

データは既定で `<ASPIRE_HOME>/dashboard` 配下に、アプリケーション名ごとに分けて保存されます。

## バッファーは大きくなりましたが、上限はあります

同じリリースで、コンソールログメッセージ、構造化ログ、トレースの既定の上限が、それぞれ 100,000 件に引き上げられました。これらは依然としてリングバッファーであり、アーカイブではありません。上限を超えると、古いエントリから破棄されます。増減したい場合は既存の設定を使用します。たとえば `Dashboard:TelemetryLimits:MaxLogCount`、`Dashboard:TelemetryLimits:MaxTraceCount`、`Dashboard:Frontend:MaxConsoleLogCount` があり、`DASHBOARD__TELEMETRYLIMITS__MAXLOGCOUNT` のような形式の環境変数でも指定できます。

## スタンドアロンダッシュボード: None、Run、Resume

スタンドアロンダッシュボードの既定の動作は従来どおりで、**None** 永続化です。ダッシュボードの停止時に削除される一時データベースを使用します。再起動をまたいでデータを保持するには、固定のアプリケーション名を指定して **Resume** を使用します。

```bash
aspire dashboard run --application-name my-app --persistence Resume
```

コンテナーでは、データディレクトリをボリュームにマウントし、毎回同じ 3 つの値を渡します。

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  -v aspire-dashboard-data:/data \
  -e ASPIRE_DASHBOARD_DATA_DIRECTORY=/data \
  -e ASPIRE_DASHBOARD_APPLICATION_NAME=my-app \
  -e ASPIRE_DASHBOARD_PERSISTENCE_MODE=Resume \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

再起動の間にアプリケーション名、ディレクトリ、モードのいずれかが変わると、履歴は引き継がれず、新しいデータベースが作成されます。アプリケーション名は、ダッシュボードの認証Cookieと antiforgery Cookie の名前のスコープにも使われるため、アプリごとに 1 つ決めて変えないでください。

## データベースはシークレットとして扱ってください

リリースノートにははっきりと書かれています。SQLite ファイルには機密性のあるリソース値やテレメトリ値が含まれる可能性があり、暗号化も独自の認可レイヤーもありません。Unix ではファイルのアクセス許可が所有者のみに制限されますが、Windows では ACL は設定されません。リソースに注入する環境変数、リソースのスナップショットに含まれる接続文字列、アプリがログに出力した内容は、実行が終わった後もディスク上に残ります。そのボリュームを共有の場所にマウントしないでください。また、`ASPIRE_HOME` を開発コンテナーのイメージにコミットしないでください。

ダッシュボード自体にも内部的な変更があります。Native AOT で提供されるようになり、折りたたみ可能なナビゲーションレールを備えた Fluent UI v5 に移行しました。AppHost が所有するターミナルはダッシュボードのドックで開くようになり、[13.5 の `WithTerminal` の取り組み](/ja/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/)を拡張しています。さらに 13.6 では、その上にオプトイン方式の `WithRepl()` データベースクライアントが追加されました。破壊的変更を含む全リストは [What's new in Aspire 13.6](https://aspire.dev/whats-new/aspire-13-6/) にあります。
