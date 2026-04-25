---
title: "ASP.NET Core 11 がネイティブ OpenTelemetry トレーシングを出荷: 追加の NuGet パッケージを捨てよう"
description: ".NET 11 Preview 2 の ASP.NET Core は OpenTelemetry セマンティック属性を HTTP サーバーアクティビティに直接追加し、OpenTelemetry.Instrumentation.AspNetCore を不要にします。"
pubDate: 2026-04-12
tags:
  - "aspnet-core"
  - "dotnet-11"
  - "opentelemetry"
  - "observability"
lang: "ja"
translationOf: "2026/04/aspnetcore-11-native-opentelemetry-tracing"
translatedBy: "claude"
translationDate: 2026-04-25
---

トレースをエクスポートするすべての ASP.NET Core プロジェクトの `.csproj` には同じ行があります。`OpenTelemetry.Instrumentation.AspNetCore` への参照です。このパッケージはフレームワークの `Activity` ソースをサブスクライブし、各 span にエクスポーターが期待するセマンティック属性をスタンプします。`http.request.method`、`url.path`、`http.response.status_code`、`server.address` などです。

[.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) からは、フレームワーク自身がその仕事を行います。ASP.NET Core は今や標準の OpenTelemetry セマンティック規約属性を HTTP サーバーアクティビティに直接設定するので、ベースラインのトレーシングデータを収集するために別途のインストルメンテーションライブラリは必要ありません。

## フレームワークが提供するようになったもの

.NET 11 Preview 2 でリクエストが Kestrel に到達すると、組み込みのミドルウェアはインストルメンテーションパッケージが追加していたのと同じ属性を書き込みます。

- `http.request.method`
- `url.path` と `url.scheme`
- `http.response.status_code`
- `server.address` と `server.port`
- `network.protocol.version`

これらは、すべての OTLP 互換バックエンドがダッシュボードとアラートのために頼っている [HTTP サーバーセマンティック規約](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) です。

## ビフォーアフター

HTTP トレースを取得するための典型的な .NET 10 のセットアップはこうでした。

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddAspNetCoreInstrumentation()   // requires the NuGet package
            .AddOtlpExporter();
    });
```

.NET 11 では、代わりに組み込みのアクティビティソースをサブスクライブします。

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddSource("Microsoft.AspNetCore")  // no extra package needed
            .AddOtlpExporter();
    });
```

`OpenTelemetry.Instrumentation.AspNetCore` パッケージはなくなったわけではありません。エンリッチメントコールバックや高度なフィルタリングが必要なチームのために依然存在します。しかし、90 % のプロジェクトが必要とするベースライン属性は今やフレームワークに焼き込まれています。

## これがなぜ重要か

パッケージが少ないほど依存グラフが小さくなり、restore 時間が速くなり、メジャーバージョンアップグレード中に同期を保つものが 1 つ減ります。また、NativeAOT で公開された ASP.NET Core アプリが、reflection を多用するインストルメンテーションコードを引き込むことなく標準のトレースを取得することも意味します。

すでにインストルメンテーションパッケージを使用していても、何も壊れません。フレームワーク属性とパッケージ属性は同じ `Activity` 上できれいにマージされます。準備ができたらパッケージ参照を削除し、ダッシュボードをテストして、先に進めます。

[ASP.NET Core .NET 11 Preview 2 の完全なリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/aspnetcore.md) は、Blazor SSR TempData サポートや新しい Web Worker プロジェクトテンプレートを含む残りの変更をカバーしています。
