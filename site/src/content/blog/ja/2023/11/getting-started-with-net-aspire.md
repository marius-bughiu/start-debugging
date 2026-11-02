---
title: "初めての Aspire スターターアプリを作成して実行する"
description: "API と Blazor フロントエンドを備えた C# の Aspire アプリを作成し、ダッシュボードを開きます。.NET 8 プレビュー当時のプロジェクトと画像も紹介します。"
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

まず [Aspire CLI と C# の前提条件](/ja/2023/11/how-to-install-net-aspire/)を準備します。**新しい**ソリューション向けの `aspire-starter` テンプレートには、API サービス、Blazor フロントエンド、両者を接続する AppHost が含まれます。既存のソリューションには、[Aspire 13.4 で既存プロジェクトに AppHost を追加する手順](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)があります。

## スターターを作成してダッシュボードを開く

新しいソリューションを配置したいディレクトリで実行します。

```sh
aspire new aspire-starter -n HelloAspire -o HelloAspire
cd HelloAspire
aspire run
```

テンプレートの質問が表示されたら回答します。最初のコマンドが `HelloAspire` にソリューションを生成し、最後のコマンドが AppHost を起動します。ターミナルに表示されたダッシュボード URL を開き、リソース一覧から Web フロントエンドのエンドポイントを開きます。天気のページを表示すると、フロントエンドから API に要求が送られます。ダッシュボードでサービスのログと要求のトレースを確認し、ターミナルで `Ctrl+C` を押してアプリを停止します。

生成された `ApiService` はデータを提供し、`Web` はそのデータを利用します。`ServiceDefaults` は共通設定です。AppHost がプロジェクトを登録し、フロントエンドに依存先を接続します。構成は [C# クイックスタート](https://aspire.dev/get-started/first-app/?lang=csharp)、リソース参照の仕組みは [Aspire の概要](/ja/2023/11/what-is-net-aspire/)で確認できます。

## アーカイブ：2023 年 11 月の .NET 8 プレビュー

**2026年11月2日訂正:** 上の手順は Aspire 13.x の CLI を使用します。以下の画像、Redis のオプション、`AddRedisContainer` API は [2023 年のプレビュー](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/)のものです。当時の AppHost は `net8.0` を対象に [Aspire.Hosting 8.0.0-preview.1.23557.2](https://www.nuget.org/packages/Aspire.Hosting/8.0.0-preview.1.23557.2)を参照していました。

当時の Visual Studio 2022 Preview では **.NET Aspire Starter Application** を選び、**Use Redis for caching** を有効にしていました。対応する CLI コマンドはこちらです。

```sh
dotnet new aspire-starter --use-redis-cache --output Foo
```

[![フィルタリングされた .NET Aspire プロジェクトテンプレートのリストを表示する Visual Studio の新規プロジェクト作成ダイアログ。](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

[![オプションの Use Redis for caching (Docker 必須) を備えた .NET Aspire Starter Application プロジェクトテンプレートの追加情報ダイアログ。](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

AppHost は `ApiService` と `Web` を参照し、両プロジェクトは `ServiceDefaults` を共有していました。当時の依存関係図です。

[![.NET Aspire Starter Application のプロジェクト依存関係グラフ。AppHost が最上位にあり、ApiService と Web に依存し、両者は ServiceDefaults に依存しています。](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

プレビューの AppHost は Redis を `cache`、API を `apiservice` として登録していました。Web フロントエンドは両方を参照します。当時の API は次のような形でした。

```cs
var builder = DistributedApplication.CreateBuilder(args);
var cache = builder.AddRedisContainer("cache");
var api = builder.AddProject<Projects.Foo_ApiService>("apiservice");
builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(api);
builder.Build().Run();
```

当時のダッシュボードにはプロジェクトとコンテナが一緒に表示されました。天気の要求のトレースを開くと、個々のサービス呼び出しを確認できました。

[![.NET Aspire Starter Application プロジェクトテンプレートを実行している .NET Aspire ダッシュボード。](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

[![.NET Aspire ダッシュボード内のリクエストトレース。リクエストがさまざまなアプリケーションコンポーネントを通過するときの段階を示しています。](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)
