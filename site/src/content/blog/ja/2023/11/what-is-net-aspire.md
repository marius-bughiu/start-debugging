---
title: ".NET Aspire とは？AppHost、サービス検出、ダッシュボードの役割"
description: "Aspire の AppHost が API とフロントエンドをどう接続するか、ServiceDefaults の設定とダッシュボードで確認できる情報を解説します。"
pubDate: 2023-11-14
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

API とフロントエンドが両方とも起動していても、呼び出し先のポートが間違っていれば通信できません。Aspire では、サービスと依存関係を **AppHost** に記述します。ローカル実行時には Aspire がリソースを起動し、各リソースを参照するサービスに接続情報を渡します。

## フロントエンドが API を見つける仕組み

C# の AppHost が `Api` と `Web` というプロジェクトを参照しているとします。次の例では両方をリソースとして登録し、Web サービスが API を必要とすることを指定します。

```cs
var builder = DistributedApplication.CreateBuilder(args);
var api = builder.AddProject<Projects.Api>("api");
builder.AddProject<Projects.Web>("web").WithReference(api);
builder.Build().Run();
```

`WithReference(api)` により、Web プロジェクトに `api` リソースのエンドポイント情報が渡ります。サービス検出を設定したクライアントは、その論理名を利用できます。HTTP 要求の送信はフロントエンド、処理は API の役割です。参照先がデータベースの場合は、同じ方法で接続文字列を渡せます。

## 他の構成要素の役割

スターターテンプレートの **ServiceDefaults** プロジェクトには、サービス検出、ヘルスチェック、テレメトリの共通設定があります。各サービスが拡張メソッドを呼び出して設定を適用します。**ダッシュボード**にはリソースの状態とエンドポイントが表示されます。サービスが出力したログや分散トレースをたどれば、ページ表示の遅延がフロントエンドの処理によるものか、API の応答待ちによるものかを調べられます。

**2026年11月2日訂正:** [.NET 8 プレビュー発表時](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/)のホスティング API は旧版のものです。上の例は Aspire 13.x の C# AppHost モデルを示します。プロジェクト参照だけですべてのクライアントが自動設定されるわけではありません。

[Aspire CLI をインストール](/ja/2023/11/how-to-install-net-aspire/)したら、[スターターアプリを作成して実行](/ja/2023/11/getting-started-with-net-aspire/)し、ダッシュボードでサービスのエンドポイントを確認できます。
