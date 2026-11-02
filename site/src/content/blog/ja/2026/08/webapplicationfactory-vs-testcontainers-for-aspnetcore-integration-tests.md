---
title: "ASP.NET Core の統合テストにおける WebApplicationFactory と Testcontainers の比較"
description: "ASP.NET Core の統合テストで確認する対象に応じて、HTTP ルーティング、本番データベース、発行済みアプリイメージのどこを実行するか選びます。"
pubDate: 2026-08-07
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "ja"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

`WebApplicationFactory<TEntryPoint>` はテスト対象のアプリを起動し、Testcontainers は PostgreSQL や SQL Server などの依存サービスを起動します。両者は組み合わせられます。アサーションが観測すべき動作から構成を選びます。

**訂正、2026 年 11 月 2 日。** `:int` ルート制約に一致しない場合は通常 404 です。以前の版は 400 とし、実ソケットを使えるのはコンテナー内のアプリだけと説明していました。HTTP 例は ASP.NET Core 10.0.10、SDK 10.0.302 で確認しました。計測コードを公開していなかったフィクスチャーの所要時間は削除しました。

## 確認する境界を選ぶ

| テストで確認すること | 構成 | 確認項目 |
| --- | --- | --- |
| ルーティング、認可、シリアライズ | Factory の既定 `TestServer` とテスト用サービス | ステータス、ヘッダー、本文 |
| 本番データベースの動作 | Factory と Testcontainers で本番と同じエンジンを起動 | 制約、移行、クエリ変換、同時実行 |
| 発行したイメージが起動すること | アプリイメージをビルドして依存サービスと実行 | Dockerfile、エントリーポイント、設定、ネットワーク |

Factory は既定でプロセス内 HTTP サーバーを使います。.NET 10 以降では初期化前に `UseKestrel()` を呼ぶと、Kestrel の実ポートを使えます。TLS と HTTP/2 には対応するサーバーとクライアントの設定も必要です。イメージ自体が対象ならアプリコンテナーをテストします。

## データベース不要の HTTP テスト

```csharp
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id:int}", (int id) => TypedResults.Ok(id));
app.MapGet("/bound/{id}", (int id) => TypedResults.Ok(id));
app.Run();
```

`GET /orders/7` は 200 です。`GET /orders/abc` は制約に合わず、一致するルートがないため 404 です。`GET /bound/abc` はルートに一致しますが、整数へのバインドに失敗して 400 です。Kestrel のループバックでこの結果を確認しました。Factory の設定、サービス差し替え、認証テストは [WebApplicationFactory ガイド](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)を参照してください。

## データベース検証には対象のプロバイダーを使う

SQLite は一意性などの制約を適用しますが、`VARCHAR(16)` 自体は 16 文字の上限を強制しません。PostgreSQL は `varchar(16)` を超える余分な非空白文字を含む値を拒否します。SQLite で成功しても PostgreSQL のこのルールは確認できません。プロバイダー固有 SQL、移行、[rowversion による同時実行制御](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)も同様です。

SQL Server を利用するエンドポイントなら、SQL Server コンテナーを起動し、移行を適用し、Factory に接続文字列を設定してデータベースの結果を確認します。[SQL Server の Testcontainers ガイド](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)に設定手順があります。HTTP だけを扱うテストは Docker から独立させられます。

## 再現可能なフィクスチャー

コンテナーを共有するときはテストデータを隔離します。グループ別のスキーマやデータベース、または明示的なリセットで先行テストの書き込みを分離します。計測時はイメージ取得、起動、スキーマ作成、リクエストを別々に記録します。ローカルのキャッシュ済みイメージと新規 CI ワーカーでは所要時間が異なります。

## 出典

- [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests?view=aspnetcore-10.0)
- [Route constraints](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0#route-constraints)
- [WebApplicationFactory.UseKestrel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel?view=aspnetcore-10.0)
- [Testcontainers for .NET](https://dotnet.testcontainers.org/)
- [SQLite VARCHAR limits](https://sqlite.org/faq.html#q9) · [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html)
