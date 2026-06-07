---
title: "ASP.NET Core 11 でコントローラーなしに Minimal API のリクエストボディを検証する方法"
description: "ASP.NET Core 11 には Minimal API 向けの組み込み検証があります。AddValidation を呼び出し、リクエストの record を DataAnnotations で注釈すると、ソースジェネレーターがバインド済みモデルを検証し、ハンドラーが実行される前に 400 ProblemDetails を返します。コントローラー不要、FluentValidation 不要、手動チェック不要です。"
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

長年、「Minimal API でリクエストボディをどう検証するのか」という問いに対する正直な答えは「やらない、少なくとも自動的には」でした。Minimal API は、コントローラーが無償で得る `ModelState` の仕組みを持たずに登場したため、`FluentValidation`、`MiniValidation` パッケージ、あるいは各ハンドラーに手書きした `if` ブロックに頼ることになっていました。それが .NET 10 で変わり、.NET 11 でも変わらず使えます。`builder.Services.AddValidation()` を呼び出し、すでに知っている `System.ComponentModel.DataAnnotations` の属性（`[Required]`、`[Range]`、`[EmailAddress]`）でリクエスト型を注釈すると、ソースジェネレーターがエンドポイントフィルターを生成し、ハンドラー本体が実行される前にバインド済みモデルを検証します。無効なリクエストは `ProblemDetails` ボディ付きの `400 Bad Request` として返り、`ModelState.IsValid` のチェックも、コントローラーも、追加パッケージもいりません。以下はすべて `Microsoft.NET.Sdk.Web` と C# 14 を使う .NET 11 を対象としていますが、この機能が最初に登場した .NET 10 でも同一です。

## そもそも Minimal API に検証がなかった理由

これは見落としではなく、設計上の判断でした。MVC のモデル検証はリフレクションベースのパイプラインで動きます。実行時にモデルグラフをたどり、`ValidationAttribute` のインスタンスを発見し、それらを呼び出して `ModelState` を埋めます。そのリフレクションこそ、Minimal API のスタックが避けるために作られた起動時およびリクエストごとのコストそのものであり、トリミングや Native AOT にとって敵対的です。そのため、当初の Minimal API の表面はパラメーターをバインドしてハンドラーを呼び出すだけでした。ボディがでたらめなら、ハンドラーはそのでたらめを受け取りました。

.NET 10 の解決策は、ソースジェネレーターでリフレクションの問題を回避します。コンパイル時に Minimal API のパラメーターとして使われるすべての型を見つけ、それらの型の `DataAnnotations` 属性を読み取り、検証コードを直接生成します。実行時のモデルグラフのリフレクションは存在せず、これこそがこの機能を軽量で AOT に優しいエンドポイントモデルと互換にしています。2 つのエンドポイントスタイルをまだ比較検討しているなら、より広いトレードオフは [ASP.NET Core 11 における Minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)にまとめてあります。このガイドは Minimal API を選んだ上で検証を取り戻したい、という前提に立っています。

## 検証を有効にする 3 ステップ

1. **サービスを登録する。** アプリをビルドする前に `builder.Services.AddValidation()` を呼び出します。これにより検証サービスと、それを実行するエンドポイントフィルターが登録されます。
2. **ソースジェネレーターが有効であることを確認する。** .NET 10 または .NET 11 の Web SDK では、`AddValidation()` を呼び出すと検証ジェネレーターが自動的に組み込まれます。ビルドが正式版より前であったり、切り詰めた `.csproj` をコピーした場合、ジェネレーターは `Microsoft.AspNetCore.Http.Validation.Generated` 名前空間にインターセプターを生成します。その名前空間が `InterceptorsNamespaces` に含まれていることを確認してください（現在のビルドでは SDK が代わりに行います）。
3. **リクエスト型を注釈し、`public` にする。** リクエストの record またはクラスのプロパティ、もしくは位置パラメーターに `DataAnnotations` 属性を付けます。型は `public` でなければなりません。ジェネレーターはアクセス可能な型に対してのみコードを見て生成できるからです。

セットアップはこれだけです。`Program.cs` での配線は次のとおりです。

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();          // step 1
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

`.csproj` でプロパティを明示的に指定する必要がある場合（古い SDK）は、次のようになります。

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

## 無効なリクエストが実際に返すもの

2 つのルールを破るボディを POST すると、エラー処理を 1 行も書かずに機械可読な `400` が返ります。

```bash
# .NET 11
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"x","name":"","quantity":0}'
```

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."],
    "Quantity": ["The field Quantity must be between 1 and 10000."]
  }
}
```

このペイロードは `HttpValidationProblemDetails` であり、MVC が生成するのと同じ RFC 9457 / RFC 7807 の形式です。そのため、すでに `errors` を解析している既存のクライアントは引き続き動作します。ハンドラーは決して実行されません。`ModelState` も、`IsValid` のチェックも、忘れる対象も何もありません。エラーの辞書はプロパティ名でキー付けされ、ネストしたメンバーはドット区切りのパスを使います。これはモデルがフラットでなくなった途端に重要になります。

## ネストしたオブジェクトは再帰的に検証される

検証は複合プロパティの中へ自動的に入っていきます。住所オブジェクトを含むリクエストは住所も検証し、エラーのキーはパスを反映します。

```csharp
// .NET 11, C# 14
public record CreateOrder(
    [Required, EmailAddress] string CustomerEmail,
    [Required] BillingAddress Billing);

public record BillingAddress(
    [Required, MinLength(2)] string Street,
    [Required, Length(2, 10)] string PostalCode,
    [Required, RegularExpression("^[A-Z]{2}$")] string CountryCode);
```

不正な郵便番号を持つ注文を POST すると、エラーのキーは平坦化された `PostalCode` ではなく `Billing.PostalCode` になります。`CreateOrder` が `BillingAddress` を参照しているため、ジェネレーターはそれを発見しました。ネストした型をどこかに登録する必要はありませんでした。この再帰的な発見こそ、この機能を単一フィールドのボディ向けのおもちゃではなく、本当に有用なものにしている部分です。

## 型がハンドラーのシグネチャに直接ない場合

ジェネレーターは Minimal API のハンドラーのパラメーターと、そこから到達可能なメンバーを見て型を見つけます。型が基底クラス、インターフェース、またはポリモーフィズム経由でのみ参照される場合、ジェネレーターはそれを発見しないことがあります。そうした場合は、型そのものを `Microsoft.AspNetCore.Http.Validation` の `[ValidatableType]` で注釈し、その型に対して明示的に検証ロジックを生成するようジェネレーターに伝えます。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.Validation;
using System.ComponentModel.DataAnnotations;

[ValidatableType]
public abstract record PaymentMethod
{
    [Required, Length(2, 40)] public string Holder { get; init; } = "";
}

public sealed record CardPayment : PaymentMethod
{
    [Required, CreditCard] public string Number { get; init; } = "";
}
```

`[ValidatableType]` は手動の脱出ハッチです。検証が期待した型で静かに発火しないときに使ってください。それはほぼ常に、ジェネレーターがハンドラーのパラメーターからその型に到達できなかったことを意味します。

## IValidatableObject によるプロパティ間のルール

属性は一度に 1 つのメンバーを検証します。複数のフィールドにまたがるルール（「終了日は開始日より後でなければならない」「割引が設定されている場合は理由が必須」）には `IValidatableObject` を実装します。その `Validate` メソッドは属性チェックの後に実行され、`ValidationResult` のエントリを生成します。

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

2 番目の引数として渡す文字列配列は、エラーが `errors` 辞書のどのキーに入るかを制御します。`[nameof(End)]` を渡すとクライアントには `"End": ["End must be after Start."]` が見え、省略するとエラーは空のキーの下にモデルレベルのエラーとして入ります。UI が正しいフィールドを強調できるよう、メンバー名を使ってください。

## 組み込みでは足りないときのカスタム ValidationAttribute

組み込みの属性も `IValidatableObject` も合わないときは、`ValidationAttribute` を書きます。ソースジェネレーターは、`[Range]` を拾うのと同じようにカスタム属性も拾います。

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

カスタム属性はルールをデータのそばに保ち、`Booking` を受け取るすべてのエンドポイントで再利用可能にします。これこそ、ハンドラー中に散らばったインラインの `if` ブロックに対する、属性ベースの検証の眼目です。

## クエリ、ルート、ヘッダーのパラメーターも検証される

この機能は JSON ボディに限りません。ルート、クエリ文字列、ヘッダーからバインドされるスカラーパラメーターの属性も、同じ仕組みで検証されます。

```csharp
// .NET 11, C# 14
app.MapGet("/search",
    ([Range(1, 100)] int pageSize,
     [Required, MinLength(2)] string query) =>
        TypedResults.Ok(new { pageSize, query }));
```

`/search?pageSize=500&query=x` へのリクエストは、ハンドラーが実行される前に `400` で拒否され、`pageSize` と `query` の両方が `errors` に列挙されます。これは、ボディの次に人々がぶつかる最も一般的な検証の穴、つまり以前は未チェックで通り抜けていたページングやフィルターのパラメーターをふさぎます。

## 1 つのエンドポイントで検証を切る

ときには、他のすべての場所では検証される型をエンドポイントが受け取るが、ここでは生の値が欲しい、という場合があります。たとえば、意図的にそれ以外では無効なデータを受け入れる内部の管理ルートです。その 1 つのエンドポイントに `DisableValidation()` をチェーンします。

```csharp
// .NET 11, C# 14
app.MapPost("/internal/import", (CreateProduct product) =>
        TypedResults.Accepted($"/products/{product.Sku}", product))
    .DisableValidation();
```

これはグローバルな `AddValidation()` の登録に触れずに、その 1 つのエンドポイントから検証フィルターを取り除きます。そのため `CreateProduct` を使う他のすべてのエンドポイントは引き続き検証します。

## 出荷前に知っておくべき細部

最初のときに人をつまずかせる、いくつかの鋭い角があります。

- **リクエスト型は `public` でなければならない。** ソースジェネレーターは名前を付けられる型に対してのみコードを生成できます。`public` なしで宣言された `record` や `class`、または正しいアクセシビリティなしで別の型の中にネストされた型は、静かに検証を受けません。検証が「効かない」場合は、まずアクセス修飾子を確認してください。
- **位置パラメーターの record: 属性の配置が重要。** 位置パラメーターの record の `[Required] string Name` はジェネレーターが読み取りますが、加えて属性が生成された*プロパティ*に付いていることに依存する場合（実行時にそれをリフレクションするツール向け）は、明示的なターゲットを使います。`[property: Required] string Name` です。検証ジェネレーター自体はパラメーターの形を読むため、ほとんどのコードに `property:` は不要ですが、期待を混ぜると混乱の一般的な原因になります。
- **検証はエンドポイントフィルターとして実行されるため、フィルターの順序が効く。** 検証フィルターはエンドポイントごとに追加されます。自分の `AddEndpointFilter` 呼び出しも追加する場合は、検証がチェーンのどこに位置するかに注意してください。route group をまたいでフィルターの順序がどう組み合わさるかは、[ASP.NET Core 11 で MapGroup を使って Minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)を参照してください。
- **これはすべての場合に FluentValidation を置き換えるものではない。** `DataAnnotations` と `IValidatableObject` でリクエスト検証の大多数をカバーできます。ルールエンジン、データベースに当たる非同期ルール、または FluentValidation への大きな既存投資があるなら、それを残してください。組み込みの機能は、依存関係なしに「`[Required]` に実際に何かしてほしいだけ」のためのものです。
- **失敗時にハンドラーはスキップされるため、`TypedResults` の合併に検証用の `BadRequest` の枝は不要。** `400` はフィルターが、ハンドラーが返る前に生成するため、`Results<Created<T>, NotFound>` と型付けされたハンドラーで問題ありません。検証失敗は決してそこに到達しません。400 ProblemDetails は、宣言した戻り値の型とは独立に生成されます。
- **解決時の DI エラーは無関係。** エンドポイントが入力の検証時ではなくサービスのアクティブ化時にスローする場合、それはまったく別の失敗です。それについては [Unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) を参照してください。

持ち帰るべきメンタルモデルはこうです。.NET 11 の Minimal API 検証とは、すでに知っている `DataAnnotations` を、コンパイル時のソースジェネレーターによって自動化し、標準の `ProblemDetails` を返すエンドポイントごとのフィルターを通じて公開したものです。注釈を付け、`AddValidation()` を呼べば、無効なリクエストは入口で止まります。リフレクションベースではなくジェネレーターベースなので、トリミングや Native AOT の邪魔をしません。だからこそ、[Native AOT の Minimal API スタックでトリミング安全に](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)出荷されます。フィルターが捕まえないものについては、[グローバルな例外フィルター](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)が引き続きリクエストパイプラインの残りを支えます。

## 関連記事

- [ASP.NET Core 11 における Minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) まずは 2 つのエンドポイントモデルの選択について。
- [ASP.NET Core 11 で MapGroup を使って Minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) 検証フィルターがグループフィルターに対してどこに位置するかについて。
- [ASP.NET Core Minimal API で Native AOT を使う](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) トリミング下でジェネレーターベースの検証器がなぜ重要かについて。
- [ASP.NET Core 11 でグローバルな例外フィルターを追加する](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) 検証が捕まえないものをすべて捕まえるために。
- [Fix: Unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) 検証失敗のように見えてそうではないアクティブ化エラーについて。

## 出典

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0)（Minimal API の検証サポート、`AddValidation`、`[ValidatableType]`、`DisableValidation`）。
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations)（`ValidationAttribute`、`IValidatableObject`、`ValidationResult`）。
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis)（ネストしたオブジェクトの検証、エラー応答の形式）。
