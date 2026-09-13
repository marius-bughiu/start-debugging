---
title: "ASP.NET Core 11 の Minimal API で [AsParameters] を使って複雑なクエリ文字列オブジェクトをバインドする方法"
description: "クラスやレコードに [AsParameters] を付けると、ASP.NET Core 11 の Minimal API でクエリ文字列のフィルター全体をバインドできます。既定値、配列、enum、入れ子のオブジェクト、検証、OpenAPI、そして位置指定レコードで発生する Native AOT ジェネレーターのバグを解説します。"
pubDate: 2026-09-13
template: how-to
tags:
  - "aspnetcore"
  - "minimal-apis"
  - "dotnet-11"
  - "csharp"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-bind-a-complex-query-string-object-with-asparameters-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-09-13
---

**結論:** クエリのキーをクラスのプロパティ (またはレコードのコンストラクター引数) として宣言し、ハンドラーの引数に `[AsParameters]` を付けます: `app.MapGet("/products", ([AsParameters] ProductFilter filter) => ...)`。ASP.NET Core はこの型を個々の引数に展開するので、`?search=lamp&page=2&tags=a&tags=b` は名前によって、大文字と小文字を区別せずに `Search`、`Page`、`Tags` にバインドされます。対応しているのはフラットな型だけです。入れ子のオブジェクトには独自の `TryParse` または `BindAsync` が必要です。また、省略可能な値は null 許容にするかコンストラクターの既定値を持たせる必要があります。`= 1` のようなプロパティ初期化子では、プロパティは省略可能になりません。

以下の内容はすべて .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`、ASP.NET Core `11.0.0-rc.1.26425.128`) で実行したものです。`[AsParameters]` は .NET 7 で導入され、それ以降ルールは変わっていないため、同じコードが .NET 8、9、10 でも動作します。知っておくべき唯一の例外は Native AOT の経路にあるソースジェネレーターのバグで、これは SDK 10.0.302 でも再現します。

## `[FromQuery] ProductFilter` が動作しない理由

MVC のコントローラーから来た人は、反射的に `[FromQuery] ProductFilter filter` と書きます。.NET 11 の Minimal API では、これはコンパイルすら通りません。アナライザー [ASP0020](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020) がビルドエラーとして報告します。

```text
error ASP0020: Parameter 'f' of type ProductFilter should define a bool
TryParse(string, IFormatProvider, out ProductFilter) method, or implement IParsable<ProductFilter>
```

アナライザーを抑制すると、今度はエンドポイントが構築される起動時にアプリが失敗します。

```text
InvalidOperationException: f must have a valid TryParse method to support converting from a string.
No public static bool ProductFilter.TryParse(string, out ProductFilter) method found for f.
```

属性を外すと、さらにわかりにくくなります。バインドソースのない複合型はリクエストボディとして推論され、`MapGet` は推論されたボディを拒否します。

```text
InvalidOperationException: Body was inferred but the method does not allow inferred body parameters.
```

これは設計どおりの動作です。Minimal API は MVC の再帰的なモデルバインダーを使わず、`[FromQuery]` は "1 つのクエリキーを `TryParse` で変換する" という意味です。[パラメーターバインドのドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) には、`AsParametersAttribute` は "enables simple parameter binding to types and not complex or recursive model binding" と書かれています。この属性が行うのは展開です。リクエストデリゲートファクトリーは型のすべてのメンバーを個別のハンドラー引数として扱い、それぞれのメンバーに通常のルール (ルート、クエリ、ヘッダー、サービス、特殊な型) を適用します。このメンタルモデルで、この記事の残りに出てくる動作はすべて説明できます。

## クエリ文字列のフィルターをバインドする手順

1. クエリキー 1 つにつき 1 つのメンバーを持つ型を作成します。
2. 省略可能なメンバーはすべて null 許容にするか、レコードのコンストラクター引数で既定値を与えます。
3. ハンドラーの引数に `[AsParameters]` を付けます。
4. 個々のメンバーの名前やソースを `[FromQuery(Name = ...)]`、`[FromRoute]`、`[FromHeader]` で変更します。
5. 範囲チェックが必要なら、DataAnnotations を追加して `AddValidation()` を呼び出します。

使用したフィルターは次のとおりです。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15, <Nullable>enable</Nullable>
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/products", ([AsParameters] ProductFilter f) => f);

app.Run();

enum SortOrder { Asc, Desc }

class ProductFilter
{
    public string? Search { get; set; }
    public int? Page { get; set; }
    public int? PageSize { get; set; }
    public SortOrder? Sort { get; set; }
    public DateOnly? Since { get; set; }
    public string[] Tags { get; set; } = [];
    [FromQuery(Name = "q")] public string? Keyword { get; set; }
}
```

実際のレスポンスは次のとおりです。

```text
GET /products?search=lamp&page=2&pageSize=10&sort=Desc&since=2026-01-31&tags=a&tags=b&q=kw
200 {"search":"lamp","page":2,"pageSize":10,"sort":1,"since":"2026-01-31","tags":["a","b"],"keyword":"kw"}

GET /products?SEARCH=lamp&PAGE=3
200 {"search":"lamp","page":3,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}

GET /products
200 {"search":null,"page":null,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}
```

クエリキーはメンバー名で、大文字と小文字を区別せずに照合されます。`[FromQuery(Name = "q")]` を使うと 1 つのメンバーについてそれを上書きできます。繰り返されたキーは配列に格納されます。`DateOnly` は ISO の `yyyy-MM-dd` 形式の文字列を解析します。静的な `TryParse` を持つメンバー型 (すべてのプリミティブ型、`Guid`、`DateTimeOffset`、enum、そして独自の `IParsable<T>` 型) はどれも、1 つのキーからバインドされます。

## 必須と省略可能: プロパティ初期化子の罠

これは私が最もよく見かける間違いです。妥当な既定値を持つクラスのように見えます。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
class RequiredFilter
{
    public int Page { get; set; } = 1;
    public bool InStock { get; set; }
    public string Search { get; set; } = "";
}
```

クエリ文字列なしの `GET /required` は `400` を返します。

```text
BadHttpRequestException: Required parameter "int Page" was not provided from query string.
```

ファクトリーは、メンバーが省略可能かどうかをその null 許容性と、コンストラクター引数の場合は宣言された既定値から判断します。プロパティ初期化子はコンストラクター内のコードにすぎず、リフレクションからは見えません。そのため、null 非許容の `int`、`bool`、`string` プロパティは、何を代入していても必須になります。生成される OpenAPI ドキュメントもこれと一致しており、3 つすべてを `required: true` としてマークします。

修正方法は 2 つあります。メンバーを null 許容にしてハンドラー内で既定値を適用する (`f.Page ?? 1`) か、コンストラクターの既定値が有効になる位置指定レコードに切り替えます。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
record ProductQuery(string? Search, int Page = 1, int PageSize = 20,
    SortOrder Sort = SortOrder.Asc, string[]? Tags = null);

app.MapGet("/products-record", ([AsParameters] ProductQuery q) => q);
```

```text
GET /products-record         -> {"search":null,"page":1,"pageSize":20,"sort":0,"tags":[]}
GET /products-record?page=4  -> {"search":null,"page":4,"pageSize":20,"sort":0,"tags":[]}
```

`= null` という既定値にもかかわらず、`Tags` が `null` ではなく `[]` として返ってきている点に注意してください。一致するキーのない配列は空の配列としてバインドされます。`record struct PagingStruct(int Page = 1, int PageSize = 20)` もまったく同じように動作し、`{"page":1,"pageSize":20}` を返しました。ドキュメントでは、`struct` はリクエストごとの割り当てを避けられるため `record` クラスより "can be more performant" と説明されています。私はベンチマークを取っていないので、これはドキュメントの主張として受け取ってください。

ファクトリーがメンバーをどう選ぶかは知っておく価値があります。[`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) のロジックは次のとおりです。型に public な引数付きコンストラクターが 1 つだけあれば、その引数をバインドします (プロパティとは名前で対応付けられます)。そうでなければ、引数なしのコンストラクターを使い、**書き込み可能な** プロパティをすべてバインドします。そのようなコンストラクターを持たないクラスの get 専用プロパティは、何の通知もなくスキップされます。public な引数付きコンストラクターが 2 つあると `Only a single public parameterized constructor is allowed for type 'TwoCtors'.` で失敗し、抽象型は `The abstract type 'AbstractFilter' is not supported.` で失敗します。

## ルート値、ヘッダー、サービスを同じ型に混在させる

各メンバーは通常のバインドルールを通るので、1 つの `[AsParameters]` 型でクエリ文字列だけでなく引数リスト全体をまとめられます。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
app.MapGet("/tenants/{tenantId:int}/orders", ([AsParameters] OrderRequest r) => new
{
    r.TenantId, r.Region, r.Status, r.Ids, r.UserAgent,
    Logger = r.Logger.GetType().Name,
    Path = r.Http.Request.Path.Value,
    CanCancel = r.Ct.CanBeCanceled
});

enum OrderStatus { Pending, Shipped, Cancelled }

class OrderRequest
{
    [FromRoute(Name = "tenantId")] public int TenantId { get; set; }
    [FromHeader(Name = "X-Region")] public string? Region { get; set; }
    public OrderStatus? Status { get; set; }
    public int[] Ids { get; set; } = [];
    [FromHeader(Name = "User-Agent")] public string? UserAgent { get; set; }
    public ILogger<OrderRequest> Logger { get; set; } = default!;   // from DI
    public HttpContext Http { get; set; } = default!;              // special type
    public CancellationToken Ct { get; set; }                      // RequestAborted
}
```

```text
GET /tenants/42/orders?status=Shipped&ids=1&ids=2   (X-Region: eu-west)
200 {"tenantId":42,"region":"eu-west","status":1,"ids":[1,2],"userAgent":"curl/8.7.1",
     "logger":"Logger`1","path":"/tenants/42/orders","canCancel":true}
```

これは Microsoft 自身のサンプルが最初に取り上げているユースケースで、長いハンドラーのシグネチャ (`int id, TodoDb db, ...`) を 1 つの型にまとめるものです。ルートのプレフィックスがすでに `{tenantId}` の値を持っている [`MapGroup` によるエンドポイントのグループ化](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) と組み合わせると効果的です。

## 不正な値、大文字と小文字を区別する enum、カンマ区切りのリスト

`TryParse` に失敗する値は、ハンドラーが実行される前に `400` を返します。

```text
GET /products?page=abc    -> 400 Failed to bind parameter "Nullable<int> Page" from "abc".
GET /products?sort=Desc   -> 200
GET /products?sort=desc   -> 400 Failed to bind parameter "Nullable<SortOrder> Sort" from "desc".
```

enum の結果には驚く人が多いでしょう。バインドでは大文字と小文字を区別する `Enum.TryParse` のオーバーロードが使われるため、`Desc` は動作しますが `desc` は拒否されます。クライアントが小文字の値を送ってくる場合は、`string?` でバインドして自分で `Enum.TryParse<SortOrder>(value, ignoreCase: true, out var sort)` を呼び出すか、独自の `TryParse` を持つ小さな型で enum をラップしてください。

Development 環境では、開発者例外ページに上記の `BadHttpRequestException` のテキストが表示されます。Development 以外では、クライアントには理由のない `400` だけが返り、理由はデバッグログにしか出力されません。そのため、このメッセージを API の契約として当てにしないでください。

カンマ区切りのリストは分割されません。

```text
GET /products?tags=a,b              -> 200 "tags":["a,b"]   (one element)
GET /tenants/42/orders?ids=1,2      -> 400 Failed to bind parameter "int[] Ids" from "1,2".
```

配列は繰り返されたキー (`?ids=1&ids=2`) からしかバインドされません。`ids=1,2` を受け付ける必要がある場合は、`string?` でバインドして分割するか、分割を行う `TryParse` をカスタム型に持たせてください。

## 入れ子のオブジェクトには独自のパーサーが必要

実際にバインドしたいのは、次のような形です。

```csharp
class Money { public decimal Min { get; set; } public decimal Max { get; set; } }
class NestedFilter { public string? Q { get; set; } public Money? Price { get; set; } }
```

`Price` はバインドソースのない複合型なので、ファクトリーはこれをボディとして推論します。そして `GET` では、エンドポイントが起動時に先ほどと同じ `Body was inferred but the method does not allow inferred body parameters.` エラーで失敗します。MVC のモデルバインダーが理解する `?price.min=10` 形式のキーは、ここでは何の意味も持ちません。入れ子のメンバーに `[AsParameters]` を付けても解決しません。`NotSupportedException: Nested AsParametersAttribute is not supported and should be used only for handler parameters.` がスローされます。

選択肢は 3 つあり、私が手を伸ばす順に並べると次のようになります。

**フラットにする。** `decimal? MinPrice` と `decimal? MaxPrice` は地味ですが、OpenAPI の出力が最も良く、コードも不要です。

**`IParsable<T>` で 1 つのキーを解析する。** 型が静的な `TryParse` を持つメンバーは、1 つのキーからバインドされます。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15
using System.Diagnostics.CodeAnalysis;
using System.Globalization;

record PriceRange(decimal Min, decimal Max) : IParsable<PriceRange>
{
    public static bool TryParse(string? s, IFormatProvider? provider,
        [MaybeNullWhen(false)] out PriceRange result)
    {
        result = null;
        if (s?.Split('-', 2) is not [var lo, var hi]) return false;
        if (!decimal.TryParse(lo, NumberStyles.Number, CultureInfo.InvariantCulture, out var min)) return false;
        if (!decimal.TryParse(hi, NumberStyles.Number, CultureInfo.InvariantCulture, out var max)) return false;
        if (min > max) return false;
        result = new PriceRange(min, max);
        return true;
    }

    public static PriceRange Parse(string s, IFormatProvider? provider) =>
        TryParse(s, provider, out var r) ? r : throw new FormatException($"'{s}' is not a price range.");
}
```

`?price=10-50` は `{"min":10,"max":50}` にバインドされ、`?price=50-10` は `400 Failed to bind parameter "PriceRange Price" from "50-10".` を返します。

**`BindAsync` でドット区切りのキーを読む。** ワイヤーフォーマットが `budget.min=5&budget.max=99` に固定されている場合は、`BindAsync(HttpContext, ParameterInfo)` を実装します。`[AsParameters]` 型の内部では `parameter.Name` がプロパティ名になるので、プレフィックスは自動的に手に入ります。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.Globalization;
using System.Reflection;

record DottedRange(decimal? Min, decimal? Max)
{
    public static ValueTask<DottedRange?> BindAsync(HttpContext context, ParameterInfo parameter)
    {
        var q = context.Request.Query;
        decimal? Read(string key) => decimal.TryParse(q[$"{parameter.Name}.{key}"],
            NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? v : null;
        var (min, max) = (Read("min"), Read("max"));
        return ValueTask.FromResult(min is null && max is null ? null : new DottedRange(min, max));
    }
}

class RangeFilter
{
    public PriceRange? Price { get; set; }
    public DottedRange? Budget { get; set; }
    public string? Q { get; set; }
}
```

```text
GET /by-range?price=10-50&budget.min=5&budget.max=99&q=chair
200 {"price":{"min":10,"max":50},"budget":{"min":5,"max":99},"q":"chair"}
```

`BindAsync` の代償はドキュメントです。組み込みの OpenAPI ジェネレーターは、このエンドポイントについて `Price` (文字列として) と `Q` を列挙しましたが、`Budget` はまったく含めませんでした。ドキュメント化が必要な場合は、[オペレーショントランスフォーマー](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) で追加してください。

もう 1 つの制約として、`[AsParameters]` の引数自体は null 許容にできません。`[AsParameters] ProductFilter? f` は `The nullable type 'ProductFilter' is not supported, mark the parameter as non-nullable.` で失敗します。

## 検証と OpenAPI の出力

Minimal API の組み込みの検証は、レコードのコンストラクター引数を含め、`[AsParameters]` のメンバーを理解します。`builder.Services.AddValidation()` を登録した状態 ([リクエストボディの検証](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) と同じセットアップ) では次のようになります。

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.ComponentModel.DataAnnotations;

record ValidatedPaging([Range(1, 1000)] int Page = 1, [Range(1, 100)] int PageSize = 20);

app.MapGet("/validated", ([AsParameters] ValidatedPaging p) => p);
```

```text
GET /validated?pageSize=500
400 {"title":"One or more validation errors occurred.","status":400,
     "errors":{"PageSize":["The field PageSize must be between 1 and 100."]}}
```

`Microsoft.AspNetCore.OpenApi` 11.0.0-rc.1 は、同じ型を `minimum`、`maximum`、`default` 付きのクエリパラメーターに変換します。.NET 10 では、まさにこの組み合わせ (`[AsParameters]` レコードのプライマリコンストラクター引数に付けた検証属性) でドキュメント生成が `InvalidCastException` をスローしていました。これは [dotnet/aspnetcore#65348](https://github.com/dotnet/aspnetcore/issues/65348) で、.NET 11 向けに [PR #67284](https://github.com/dotnet/aspnetcore/pull/67284) で修正されています。まだ .NET 10 を使っている場合は、代わりにプロパティを持つクラスに属性を付けてください。また、先ほどの配列の罠が反対側からも見えます。null 非許容の `string[] Tags { get; set; } = []` は、ランタイムがキーの欠落を問題なく空の配列としてバインドするにもかかわらず `required: true` としてドキュメント化されるため、生成されたクライアントはこれを必ず送ろうとします。省略可能な配列は `string[]?` として宣言すれば、ドキュメント上も省略可能としてマークされます。

## Native AOT: null 許容参照型を持つ位置指定レコードはコンパイルできない

`<PublishAot>true</PublishAot>` を指定すると、ビルドで [Request Delegate Generator](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/aot/request-delegate-generator/rdg) が有効になり、ランタイムのファクトリーがソース生成されたコードに置き換わります ([Minimal API での Native AOT](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) で扱ったスタックです)。上で見た起動時エラーのほとんどは、そこではビルド警告になります。入れ子の `[AsParameters]` には `RDG009`、null 許容の引数には `RDG010`、抽象型には `RDG005`、複数のコンストラクターには `RDG008` です。これは改善です。

ただし、バグもあります。次のエンドポイントは、

```csharp
// .NET 11 RC 1 and SDK 10.0.302, <PublishAot>true</PublishAot> or <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
app.MapGet("/a", ([AsParameters] F f) => f.Page?.ToString() ?? "none");

record F(string? Q, int? Page);
```

次のエラーが 4 つ出てビルドに失敗します。

```text
GeneratedRouteBuilderExtensions.g.cs: error CS8639: The typeof operator cannot be used on a nullable reference type
```

ジェネレーターは `typeof(F).GetConstructor(new[] { typeof(string?), typeof(int?) })` を出力してレコードのコンストラクターを見つけようとしますが、`typeof(string?)` は正しい C# ではありません。`int?` は `Nullable<int>` なので問題ありません。ジェネレーターを有効にして、同じエンドポイントの 6 つのバリエーションをビルドしました。

| `[AsParameters]` 型 | ビルドできるか |
| --- | --- |
| `record F(string? Q, int? Page)` | いいえ、CS8639 |
| `record F(string[]? Tags, int? Page)` | いいえ、CS8639 |
| `record F(string Q = "", int? Page = null)` | はい |
| `record struct F(string? Q, int? Page)` | はい |
| `record F { public string? Q { get; init; } ... }` | はい |
| 同じ位置指定レコード、ジェネレーター無効 (通常の JIT ビルド) | はい |

つまり、きっかけはコンストラクターに null 許容参照型の引数を持つ位置指定の `record` クラスです。通常の JIT ビルドでは問題ないため、誰かが `PublishAot` を有効にしたときに初めて表面化しがちです (ドキュメントによると、トリミングでもジェネレーターが有効になります)。修正されるまでは、AOT プロジェクトの `[AsParameters]` 型には、設定可能なプロパティを持つクラス、`init` プロパティを持つレコード、または位置指定の `record struct` を使ってください。執筆時点では、dotnet/aspnetcore にこの問題を追跡する issue は見つかりませんでした。

## 次に読む

- [ASP.NET Core 11 における Minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)。MVC のモデルバインダーがまだ優位な点も含めて解説しています。
- [ASP.NET Core 11 での C# の共用体](/ja/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/)。クエリ文字列だけが協力してくれないバインドソースである、もう 1 つのケースです。
- [EF Core 11 でのキーセット (カーソル) ページネーション](/ja/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)。ここで作ったページングフィルターの自然な利用先です。
- [Minimal API で `[FromForm]` の辞書が常に null になる理由](/ja/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/)。入れ子のオブジェクトの問題のフォームバインド版です。

## 出典

- Microsoft Learn、[Minimal API アプリケーションでのパラメーターバインド](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) (`[AsParameters]` のセクションと、バインドソースの優先順位の一覧)。
- Microsoft Learn、[`AsParametersAttribute` API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.asparametersattribute)。
- Microsoft Learn、[ASP0020: Complex types referenced by route parameters must be parsable](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020)。
- Microsoft Learn、[Request Delegate Generator の診断 RDG009](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG009) と [RDG010](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG010)。
- `v11.0.0-rc.1.26425.128` 時点の dotnet/aspnetcore: [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) (メンバーの展開、null 許容のチェック) と [`RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (入れ子の `[AsParameters]` のチェック)。
