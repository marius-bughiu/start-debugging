---
title: "ASP.NET Core minimal API で Native AOT を使う方法"
description: "生成した JSON メタデータで Minimal API を Native AOT に対応させる手順。Builder、配備先ツールチェーン、警告、機能制約を説明。"
pubDate: 2026-04-27
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "ja"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Native AOT は publish 時にアプリケーションをネイティブコードへコンパイルします。起動時間、サイズ、メモリ使用量は変わり得ますが、結果はアプリと対象環境に依存します。ASP.NET Core の全機能や依存関係が自動的に対応するわけではありません。

**訂正 — 2026 年 11 月 2 日：** 以前の版は `CreateSlimBuilder` を必須とし、SignalR サーバーを全面的に除外し、コード生成を `Program.cs` に依存すると説明していました。JSON とグローバリゼーションの制約も修正しました。この例は .NET 10 を対象とし、.NET 11 での実行を主張しません。

## JSON メタデータを明示したアプリ

`MyApi` プロジェクトに次のプロジェクトファイルを使用します。

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

`Program.cs` は次のとおりです。

```csharp
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));

var app = builder.Build();
app.MapGet("/todos", () => TypedResults.Ok(new[] { new Todo(1, "Write docs", false) }));
app.MapPost("/todos", (Todo todo) => TypedResults.Ok(todo));
app.Run();

public record Todo(int Id, string Title, bool IsComplete);

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

この Web SDK プロジェクトでは `PublishAot` が AOT 解析とリクエストデリゲート生成を有効にします。JSON コンテキストはエンドポイントで使用するルート型のメタデータを提供します。契約に応じて別のルート型や多態型も登録します。`object` の登録だけでは任意の実行時型を網羅できません。

ジェネレーターはプロジェクト内のソースファイルを処理します。ルート拡張メソッドを `Program.cs` 以外へ移すこと自体は問題ではありません。別ライブラリには適切な ASP.NET Core 参照とジェネレーター対応が必要で、単一のプロパティだけで任意のコードが対応するわけではありません。

## 具体的なプラットフォームへ publish する

```sh
# Use the RID and native toolchain for your deployment target.
# This command is for an Apple Silicon Mac:
dotnet publish -c Release -r osx-arm64 -o ./publish
./publish/MyApi --urls http://127.0.0.1:5080
# Replace MyApi with your project's executable name.
```

対象に必要なネイティブツールチェーンを用意します。異なる OS への Native AOT 発行は一般にはサポートされないため、適切なビルドホストやコンテナーを使います。自己完結とは管理ランタイムを別途インストールする必要がないという意味で、完全な静的リンクや OS ライブラリからの独立を意味しません。

生成された実行ファイルで、エンドポイント、JSON、認証、失敗経路をテストします。通常の `dotnet run` は JIT 実行なので代用できません。トリミングと AOT の全警告を確認してください。警告をエラーに設定しない限り、警告だけで publish は失敗しません。`IL2026` はトリミング要件、`IL3050` は動的コード要件に関係します。`RequiresDynamicCode` などは要件を呼び出し側へ伝えますが、不適合を修復しません。

## Builder、JSON、グローバリゼーション

`CreateSlimBuilder` は既定機能が少ない便利な出発点ですが、必須 API ではありません。選択した機能と依存関係が対応していれば `CreateBuilder` も使えます。Slim builder は既定で HTTPS と HTTP/3 を設定しないため、必要な Kestrel サポートを追加するか、信頼するプロキシで TLS を終端します。エンドポイント設定だけでは省かれたプロトコル機能を追加できません。

生成済みリゾルバーの登録だけで、すべての実行モードのリフレクションが無効になるわけではありません。Native AOT には適切なメタデータが必要で、未知の JSON 型は実行時に失敗する場合があります。`Results.Json(value)` と `ReadFromJsonAsync<T>()` は設定済みオプションと生成メタデータを使えるため、本質的に禁止されていません。`JsonTypeInfo<T>` を取るオーバーロードなら呼び出し位置で契約を明示できます。

`InvariantGlobalization` は動作の選択であり、AOT 警告のスイッチではありません。カルチャ依存の処理が必要なら、その機能と対象の依存ライブラリを用意します。警告を消すためだけに有効化したり、カルチャの動作がすべて維持されると考えたりしないでください。

## バージョン別に対応状況を確認する

公式の対応表では MVC コントローラーと Razor Pages は一般的な Native AOT の選択肢ではありません。一方、SignalR は .NET 9 でクライアントとサーバーの対応を導入し、制約と JSON ソース生成要件が文書化されています。古い全面除外を新しいバージョンに適用しないでください。

データアクセスもプロバイダーごとの確認が必要です。EF Core の AOT はバージョンとクエリ処理に依存し、通常の Dapper も小さいから安全とは限りません。配備する正確な依存関係で publish と実行を確認します。

対応するハンドラーの整理には [MapGroup のリソースモジュール](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)を参照してください。

## 出典

- [ASP.NET Core Native AOT support](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [.NET Native AOT deployment and prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [.NET 9 SignalR Native AOT support and limitations](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-9.0?view=aspnetcore-9.0#signalr-supports-trimming-and-native-aot)
