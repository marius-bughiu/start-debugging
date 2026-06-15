---
title: "ASP.NET Core 11 の minimal API バリデーション vs FluentValidation: どちらを選ぶべきか"
description: "ASP.NET Core 11 で属性で表現できる同期的なルールには、ソースジェネレーター生成の組み込みバリデーションを使いましょう。データベースを参照する非同期ルール、複雑なフィールド間ロジック、あるいはバリデーションをドメインモデルの外に保ちたい場合は FluentValidation を選びます。"
pubDate: 2026-06-15
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

ASP.NET Core 11 で新しい minimal API を始めるなら、組み込みのバリデーションを使ってください。`AddValidation()` を呼び出し、リクエストの record を `DataAnnotations` で注釈すれば、ソースジェネレーターがハンドラーの実行前に `400 ProblemDetails` を返します。依存関係はなく、Native AOT もサポートします。FluentValidation（現在 12.1.1、Apache 2.0）に頼るのは、組み込み機能では本当にできないことが必要なときだけにしましょう。データベースを参照する非同期ルール、豊かなフィールド間ロジック、あるいはバリデーションをドメインモデルから完全に切り離して保つ場合です。決め手となる軸は、非同期と複雑な条件付きルールです。それらが必要なら FluentValidation が勝ち、不要なら組み込み機能のほうが摩擦が少ない選択です。以下はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使う .NET 11 を対象としています。組み込み機能は .NET 10 で初めて登場し、11 でも変わっていません。

## 機能マトリクス

これがあなたの探していた表です。各行は .NET 11 と FluentValidation 12.1.1 を反映しています。

| 機能                             | 組み込み（`DataAnnotations`）           | FluentValidation 12                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------- |
| 依存関係                         | なし（標準同梱、.NET 10+）              | NuGet パッケージ、Apache 2.0              |
| 仕組み                           | コンパイル時のソースジェネレーター       | ランタイムのリフレクション + 式ツリー     |
| Native AOT / trimming            | 対応（ランタイムのリフレクションなし）   | 注意が必要、部分的にサポート              |
| 非同期ルール（DB / HTTP 参照）   | 不可                                    | 可（`MustAsync`、`ValidateAsync`）        |
| フィールド間ルール               | `IValidatableObject`（冗長）            | 第一級（`RuleFor(...).When(...)`）        |
| ルールが置かれる場所             | モデル上、属性として                    | 別個のバリデータークラス内                |
| 条件付き / ルールセット          | 限定的                                  | `When`/`Unless`/`WhenAsync`、ルールセット |
| minimal API での自動 `400`       | あり、組み込みのエンドポイントフィルター | 手動: エンドポイントフィルターを自分で書く |
| エラーレスポンスの形             | `ProblemDetails`（RFC 9457）が無償      | 失敗を自分でレスポンスにマッピングする     |
| 再利用可能な複合ルール           | カスタム `ValidationAttribute`          | `SetValidator`、ルールの連鎖、継承        |

要点はこうです。組み込み機能は単純なモデルに対する「有効にして忘れる」を最適化し、FluentValidation は複雑なモデルに対する表現力を最適化します。どちらかが一律に優れているわけではありません。ほとんどの判断を左右する行は、非同期ルールと、ルールが置かれる場所です。

## 組み込みバリデーションを選ぶべきとき

組み込みバリデーションは、[コントローラーなしで minimal API のリクエストボディを検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) で手順を追って解説していますが、次の場合に正しいデフォルトです。

- **同期的なルールを持つ新規の .NET 11 minimal API。** バリデーションが「このフィールドは必須、あれは正の整数、メールはメールらしく見えること」であれば、`DataAnnotations` がそのすべてを表現し、ソースジェネレーターが無償でエンドポイントフィルターに変換します。パッケージも、バリデータークラスも、配線も不要です。
- **Native AOT、あるいは積極的に trimming したデプロイ。** 組み込み機能は、ランタイムでモデルグラフのリフレクションを持ち込まないよう、まさにソースジェネレーターを中心に設計されています。これが trimming と Native AOT のもとで安全である理由であり、[Native AOT の minimal API スタック](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) ときれいに統合できる理由でもあります。FluentValidation はリフレクションとコンパイル済みの式ツリーに依存するため、trimming には追加の注意が必要です。
- **`400 ProblemDetails` の契約を渡してほしい。** 組み込みバリデーションは、プロパティ名をキーとした `HttpValidationProblemDetails` のボディを返します。これは MVC が生成するのと同じ RFC 9457 の形で、あなたのコードは不要です。FluentValidation では `ValidationResult` をどう HTTP レスポンスに変換するかを自分で決めますが、小さなサービスではその柔軟性が要らないこともあります。
- **ルールをモデル上に置きたい。** 属性は `[Required]` を、それが守るプロパティのすぐ隣に保ちます。データとその制約を一か所に置くのを好むチームにとって、この同居は欠点ではなく利点です。

## FluentValidation を選ぶべきとき

FluentValidation 12 は、組み込み機能が壁にぶつかったときに、その依存関係に見合う価値を発揮します。

- **非同期ルール。** これがそれに頼る最大の理由です。`DataAnnotations` と `IValidatableObject` は同期的なので、「このユーザー名はすでに使われているか」や「この商品 ID はカタログに存在するか」は、ハンドラー内にデータアクセスを漏らすことなしには組み込み機能では表現できません。FluentValidation は `MustAsync` と `WhenAsync` をサポートし、`ValidateAsync` で呼び出します。ライブラリは明言しています。非同期ルールを含むバリデーターは `ValidateAsync` で呼ばねばならず、`Validate` では決して呼んではならない、さもなければ例外を投げる、と。
- **豊かなフィールド間ロジックと条件付きロジック。** 「終了日は開始日より後」は `IValidatableObject` で実現できますが、「`PaymentType` が `Invoice` なら `PurchaseOrderNumber` は必須、ただし顧客が `Internal` の場合を除く」になると、属性と `IValidatableObject` の組み合わせは `if` ブロックの絡まりと化します。FluentValidation の `RuleFor(x => x.PurchaseOrderNumber).NotEmpty().When(x => x.PaymentType == PaymentType.Invoice)` は、要件そのもののように読めます。
- **バリデーションをドメインモデルの外に保たねばならない。** クリーンアーキテクチャや DDD のコードベースでは、ドメインの record を `[Range]` や `[EmailAddress]` で装飾すると、モデルがプレゼンテーションの関心事に結合します。FluentValidation はすべてのルールを別個の `AbstractValidator<T>` クラスに保つので、モデルは属性のない POCO のままです。
- **多数のリクエスト型にわたる再利用と合成。** `SetValidator`、バリデーターの継承、ルールセットを使えば、価格を持つすべてのリクエストに `MoneyValidator` を合成できます。ルールが構造を持つようになると、カスタムの `ValidationAttribute` 型では及ばない流暢さです。

## それぞれコードでどう見えるか

組み込み版は、すでに知っている注釈に、サービス登録を一つ加えるだけです。

```csharp
// .NET 11, C# 14 -- Program.cs
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

不正なボディはハンドラーに決して届きません。`Sku`、`Name`、`Quantity` をキーとした `ProblemDetails` のペイロードを持つ `400` として自動的に返ります。

FluentValidation の同等版は、ルールをバリデータークラスに移します。そして、組み込みの自動バリデーションのパイプラインは非推奨なので（詳細は後述）、自分で明示的に呼び出すエンドポイントフィルターを通して配線します。

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
using FluentValidation;
using FluentValidation.Results;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
   .AddEndpointFilter(async (ctx, next) =>
   {
       var product = ctx.GetArgument<CreateProduct>(0);
       var validator = ctx.HttpContext.RequestServices
           .GetRequiredService<IValidator<CreateProduct>>();

       ValidationResult result = await validator.ValidateAsync(product);
       if (!result.IsValid)
           return Results.ValidationProblem(result.ToDictionary());

       return await next(ctx);
   });

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

これはより多くのコードですが、力が宿るのもここです。非同期の一意性チェックを加えれば、組み込み機能は単純についていけません。

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator(IProductRepository repo)
    {
        RuleFor(x => x.Sku)
            .NotEmpty()
            .Length(3, 20)
            .MustAsync(async (sku, ct) => !await repo.SkuExistsAsync(sku, ct))
            .WithMessage("A product with this SKU already exists.");
    }
}
```

`MustAsync` はバリデーション中にデータベースを参照します。ルール内で `DbContext` を開かずにこれを行う `DataAnnotations` 属性は存在せず、`IValidatableObject.Validate` は同期的なので何も await できません。これがチームを FluentValidation へ向かわせる壁です。

エンドポイントフィルターの定型コードは小さなジェネリックの拡張に切り出せるので、各エンドポイントは `.WithValidation<CreateProduct>()` を連鎖させるだけになります。ルートグループ全体でフィルターを合成する仕組みは [MapGroup で minimal API のエンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) で説明したものと同じなので、単一の `MapGroup(...).AddEndpointFilter(...)` でグループ全体を検証できます。

## ベンチマーク: 定常状態ではなく起動

ここでの正直なパフォーマンスの話は、リクエストのスループットではありません。少数のプロパティなら、どちらの方式もマイクロ秒で検証し、そのコストは JSON のデシリアライズやハンドラーの処理に埋もれます。測定可能な差は端にあります。コールドスタートと AOT です。

組み込み機能はコンパイル時に生成されるため、起動時にリフレクションを足しません。FluentValidation は初回使用時にコンパイルされる式ツリーでルールチェーンを構築するので、各型の初回バリデーションは JIT と式コンパイルの一度きりのコストを払います。暖まったサーバーではそのコストはゼロに償却されます。一方、リクエストを一つ処理して凍結する[コールドスタートするサーバーレス関数](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)では、呼び出しの相当な割合でそれを払うことになります。

より鋭い違いは公開（publish）です。Native AOT と組み込みバリデーターを使う minimal API は、保持すべきリフレクションがないため、trimming 警告なしで公開・実行されます。FluentValidation を使う同じアプリは、ライブラリがモデルとメンバーアクセス式に対してリフレクションを行うため、検証対象の型とそのメンバーをルートに保持しない限り trimming 警告を出します。これは「FluentValidation が遅い」のではなく、「FluentValidation は組み込み機能では不要な trim 安全性の作業を強いる」ということです。デプロイ先が AOT なら、ナノ秒の数え上げではなくこれを決定要因として扱ってください。この .NET 11 サイクルより古い数値は、信頼する前に測り直すべきです。バリデーションの内部は .NET 8 と .NET 10 の間で変わりました。

## あなたの代わりに決めてしまう落とし穴: 非推奨の AspNetCore パッケージ

FluentValidation の ASP.NET Core 統合を探すと、`FluentValidation.AspNetCore` パッケージとその古い自動バリデーションのパイプラインが見つかります。そこから始めないでください。メンテナーはそれを非推奨にしており、ドキュメントは明言しています。"We no longer recommend using this approach for new projects but it is still available for legacy implementations." それは非同期バリデーターを実行せず（例外を投げます）、minimal API も Blazor もサポートしたことがなく、その暗黙的なふるまいはデバッグが難しいものです。2026 年に推奨される道は、上で示した手動の方法です。`IValidator<T>` を DI に登録し、minimal API ならエンドポイントフィルターから、あるいはハンドラーから、自分で `ValidateAsync` を呼びます。チュートリアルが `AddFluentValidationAutoValidation()` を呼べと言うなら、それはこのガイダンス以前のものです。

二つ目の落とし穴は逆向きに、FluentValidation に有利に働きます。ここでライセンスを恐れるのは見当違いです。FluentValidation は商用利用を含めて Apache 2.0 のまま無償です。2025 年 1 月に制限付きの有償ライセンスへ変わったライブラリは Fluent Assertions であり、紛らわしく似た名前の別プロジェクトです。両者は無関係で、FluentValidation を選んでも席単位の料金にさらされることはありません。ポリシーのレビュー担当者があなたの依存関係リストで "Fluent*" を指摘したら、これがすべき区別です。

最後は、FluentValidation 特有の正しさの罠です。バリデーターのルールのどれか一つでも非同期なら、すべての呼び出し箇所が `ValidateAsync` を使わねばなりません。`MustAsync` ルールを含むバリデーターに紛れ込んだ同期的な `Validate()` は、コンパイル時ではなくランタイムに例外を投げるので、その経路を一度も通らないテストは通過し、本番で落ちることがあります。落とし穴を完全に避けるため、どこでも `ValidateAsync` に統一してください。

## 推奨、再び

ASP.NET Core 11 では組み込みバリデーションをデフォルトにしましょう。無償で、AOT に対応し、標準の `ProblemDetails` 契約を渡してくれます。そしてリクエストバリデーションの大半を占める、同期的で属性の形をしたルールについては、依存関係を足すよりも厳密に手間が少ないのです。FluentValidation は意図的に選んでください。具体的な限界にぶつかったとき、すなわち I/O が必要な非同期ルール、`IValidatableObject` では醜くなる条件付きのフィールド間ロジック、あるいはバリデーションがドメインモデルに触れてはならないというアーキテクチャ上の規則があるときです。多くの実システムは両方に行き着きますが、それでよいのです。組み込み機能には単純な DTO を守らせ、FluentValidation には本当に複雑なルールを持つ一握りのリクエスト型を担当させましょう。誤りは、フレームワークがすでに無償で表現できないルールを持つ前に、習慣で新規の .NET 11 サービスにバリデーションライブラリへ手を伸ばすことです。

## 関連記事

- [ASP.NET Core 11 でコントローラーなしに minimal API のリクエストボディを検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) -- 組み込み機能の完全なセットアップ。
- [ASP.NET Core 11 の minimal API vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) -- この判断の土台にあるエンドポイントモデルの選択。
- [ASP.NET Core 11 で MapGroup を使って minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) -- ルートグループ全体にバリデーションフィルターを適用する。
- [ASP.NET Core minimal API で Native AOT を使う](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- trimming のもとでジェネレーターベースのバリデーターが重要な理由。
- [ASP.NET Core 11 でグローバルな例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- バリデーションが捕えないものすべての受け皿。

## 出典

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0)（組み込みの minimal API バリデーション、`AddValidation`、ソースジェネレーター、`ProblemDetails`）。
- FluentValidation ドキュメント, [ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)（自動バリデーションの非推奨化、推奨される手動の `IValidator<T>` 方式）。
- FluentValidation ドキュメント, [Asynchronous Validation](https://docs.fluentvalidation.net/en/latest/async.html)（`MustAsync`、`WhenAsync`、`ValidateAsync` の要件）。
- FluentValidation, [Deprecation of the FluentValidation.AspNetCore package (issue #1960)](https://github.com/FluentValidation/FluentValidation/issues/1960)。
- NuGet, [FluentValidation 12.1.1](https://www.nuget.org/packages/fluentvalidation/)（現行バージョン、Apache 2.0 ライセンス）。
- DevClass, [Another open source project shifts to restrictive license: Fluent Assertions](https://www.devclass.com/development/2025/01/16/another-open-source-project-shifts-to-restrictive-license-fluent-assertions-following-xceed-partnership/)（ライセンス変更は FluentValidation ではなく Fluent Assertions のもの）。
</content>
