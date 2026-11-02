---
title: "ASP.NET Core 11 の minimal API バリデーション vs FluentValidation: どちらを選ぶべきか"
description: "Minimal API の組み込み検証と FluentValidation を比較します。非同期ルール、エンドポイントフィルター、バージョン差、ライセンスを整理。"
pubDate: 2026-06-15
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "ja"
translationOf: "2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

ASP.NET Core 10 は `AddValidation()` による Minimal API の組み込み検証を導入しました。.NET 11 では拡張され、Preview 6 から Minimal API で `AsyncValidationAttribute` と `IAsyncValidatableObject` が使えます。そのため、非同期検証が必要という理由だけで .NET 11 に FluentValidation が必須になるわけではありません。

**訂正 — 2026 年 11 月 2 日：** .NET 11 の組み込み非同期検証を比較に反映しました。以下の同期検証サンプルは SDK 10.0.302 と FluentValidation 12.1.1 で確認しました。.NET 11 での実行やベンチマーク結果を示すものではありません。

## 組み込み検証

DataAnnotations は単純な制約をモデルの近くに記述できます。Web SDK のプロジェクトでは、検証を登録してエンドポイントを定義します。

```csharp
// Program.cs: Microsoft.NET.Sdk.Web, net10.0 or later.
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

無効な入力には、ハンドラーを実行する前に検証問題を示す 400 応答が返ります。この位置指定 record のパラメーター属性は検証ジェネレーターでサポートされています。モデルを宣言する通常のクラスライブラリには、`Microsoft.Extensions.Validation` パッケージと、公式資料にあるアセンブリごとの登録が必要です。

.NET 10 の組み込みパイプラインは同期式です。.NET 11 の非同期検証では、公式の非同期 API と使用するプレビューまたはリリースのバージョンを確認してください。外部問い合わせには引き続きキャンセルと実行時間の制限が必要で、一意性はデータ保存時にも保証する必要があります。

## エンドポイントフィルターで FluentValidation を使う

FluentValidation はルールを別のクラスに記述します。ルールの合成、ルールセット、条件分岐、既存の採用状況によって便利な選択肢になります。次は単一エンドポイント専用のフィルターです。

```csharp
// Program.cs: add a PackageReference to FluentValidation 12.1.1.
using FluentValidation;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .AddEndpointFilter(async (context, next) =>
    {
        var product = context.GetArgument<CreateProduct>(0);
        var validator = context.HttpContext.RequestServices
            .GetRequiredService<IValidator<CreateProduct>>();
        var result = await validator.ValidateAsync(
            product, context.HttpContext.RequestAborted);
        if (!result.IsValid)
            return Results.ValidationProblem(result.ToDictionary());
        return await next(context);
    });

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);

public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator()
    {
        RuleFor(x => x.Sku).NotEmpty().Length(3, 20);
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2);
        RuleFor(x => x.Quantity).InclusiveBetween(1, 10_000);
    }
}
```

このフィルターは `CreateProduct` が引数 0 にあることを前提にしています。シグネチャが異なるハンドラーのグループに、そのまま適用しないでください。非同期ルールを含む可能性がある場合は `ValidateAsync` を使い、リクエストのキャンセルトークンを渡します。必要なサービスは DI に登録します。

これは従来の `FluentValidation.AspNetCore` による MVC 自動検証とは別です。従来のパイプラインは同期式で、Minimal API を統合せず、FluentValidation の公式資料は新規プロジェクトでの使用を推奨していません。ASP.NET Core の新しい組み込み検証と混同しないでください。

## 選択基準とライセンス

ルールの保守と再利用、配備するフレームワークのバージョン、クライアントが必要とするエラー形式で判断します。単純な DataAnnotations モデルには組み込み機能が出発点になります。FluentValidation は別の整理・合成方法を提供します。どちらも、あらゆる独自バリデーターや依存関係について性能向上や Native AOT 対応を保証しません。実際の publish 結果と動作を確認してください。

ここで使う FluentValidation 12.1.1 は Apache License 2.0 です。FluentAssertions は別のプロジェクトで、そのライセンスに関する報道は FluentValidation のライセンスを決める根拠になりません。配布する正確なバージョンを確認してください。

エンドポイントの整理については、[MapGroup によるルートグループ](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)を参照してください。

## 出典

- [ASP.NET Core validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-11.0)
- [.NET 11: asynchronous Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0#async-validation-for-minimal-apis)
- [FluentValidation: ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)
- [FluentValidation: asynchronous rules](https://docs.fluentvalidation.net/en/latest/async.html)
- [FluentValidation 12.1.1 license](https://github.com/FluentValidation/FluentValidation/blob/12.1.1/License.txt)
