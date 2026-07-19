---
title: "ASP.NET Core 11 の minimal API にエンドポイントフィルターを追加する方法"
description: "ASP.NET Core 11 の minimal API におけるエンドポイントフィルターの完全な実践ガイドです。インラインのデリゲートを使う AddEndpointFilter、DI を伴う IEndpointFilter クラス、GetArgument と Arguments リスト、Results.Problem によるショートサーキット、複数フィルターでの FIFO/FILO の順序、MapGroup でのグループ単位のフィルター、シグネチャに依存するフィルターのための AddEndpointFilterFactory を扱います。"
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "validation"
lang: "ja"
translationOf: "2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

ASP.NET Core 11 の minimal API にエンドポイントフィルターを追加するには、エンドポイント（またはルートグループ）に対して `.AddEndpointFilter()` を呼び出し、インラインの `async (context, next) => ...` デリゲートか、`IEndpointFilter` を実装したクラスのいずれかを渡します。フィルターはモデルバインディングの後、ハンドラーの前に実行され、`context.GetArgument<T>(index)` を通じてバインド済みの引数を参照し、続行するために `await next(context)` を呼び出すか、リクエストをショートサーキットするために `Results.Problem(...)` のような値を返します。これがモデルのすべてです。この記事ではそれを最初から最後まで解説します。インライン形式、DI を伴うクラス形式、複数のフィルターを重ねたときの順序、フィルターを `MapGroup` 全体に適用する方法、そしてフィルターファクトリという脱出口です。対象は .NET 11（執筆時点では Preview 6、GA は 2026 年 11 月）で、`Microsoft.NET.Sdk.Web` と C# 14 を使用しますが、エンドポイントフィルターは ASP.NET Core 7 以降で安定しているため、ここのすべての例は .NET 8、9、10 でも変更なく動作します。

## エンドポイントフィルターが実際にラップするもの

エンドポイントフィルターは、単一の route ハンドラーの呼び出しをラップするコードです。ミドルウェアはルートが一致したかどうかにかかわらず、パイプラインのその地点を通過するすべてのリクエストに対して実行されますが、それとは異なり、フィルターはそのエンドポイントが選択されたときにのみ実行されます。またミドルウェアとは異なり、フィルターはルーティングの後、パラメーターのバインディングの後に実行されるため、実行される時点でフレームワークはすでにルート値を解析し、リクエスト本文をバインドし、ハンドラーの引数を解決しています。このタイミングこそがフィルターが存在するすべての理由です。ハンドラーがまさに受け取ろうとしている引数を検査し、変更さえでき、ハンドラーが生成した結果を検査したり置き換えたりできます。しかもハンドラー自体には一切触れません。

具体的には、フィルターは 3 つのことができます。

- ハンドラーの前にコードを実行する（引数の検証、ログ出力、ストップウォッチの開始）。
- ショートサーキットする。ハンドラーを呼び出す代わりに結果を返す。
- ハンドラーの後にコードを実行する。戻り値の検査や置き換えも含みます。

これは検証、エンドポイント単位のログ出力、リクエストの整形、そして独自のミドルウェアに値しない軽量な横断的関心事にきれいに対応します。

## エンドポイントフィルターを追加する手順

1. いつものように `WebApplication.CreateBuilder(args)` でサービスを登録し、アプリをビルドします。
2. `MapGet`、`MapPost`、または `MapGroup` でエンドポイントをマッピングします。
3. 返された builder に `.AddEndpointFilter(...)` を連鎖させ、インラインのデリゲートまたは `IEndpointFilter` 型を渡します。
4. フィルター内で `context.GetArgument<T>(index)` を使って引数を読み取り、続行するかどうかを判断します。
5. ハンドラーを実行するために `await next(context)` を呼び出すか、ショートサーキットするために値（例えば `Results.Problem(...)`）を返します。

この記事の残りでは、これらの各点を動作するコードへと展開します。

## インラインのデリゲート形式

フィルターを追加する最も手早い方法はインラインのデリゲートです。これは 2 つのパラメーターを取ります。`EndpointFilterInvocationContext`（`HttpContext` とバインド済みの `Arguments` を公開します）と、パイプラインを続行するために呼び出す `EndpointFilterDelegate` である `next` です。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

string ColorName(string color) => $"Color specified: {color}";

app.MapGet("/color/{color}", ColorName)
    .AddEndpointFilter(async (context, next) =>
    {
        var color = context.GetArgument<string>(0);

        if (color == "Red")
        {
            // Short-circuit: the handler never runs.
            return Results.Problem("Red is not allowed.");
        }

        // Continue to the next filter, or the handler if this is the last one.
        return await next(context);
    });

app.Run();
```

`context.GetArgument<string>(0)` は `ColorName` に渡された最初の引数、つまり `color` を取り出します。インデックスは位置ベースです。これはルートテンプレートのセグメントの順序ではなく、ハンドラーの宣言でパラメーターが現れる順序に一致します。位置を数えたくない場合、`context.Arguments` は反復処理できる `IList<object?>` であり、`GetArguments()` は同じリストを返します。

フィルターの戻り値の型は `ValueTask<object?>` です。`Results.Problem(...)`（または任意の `IResult`）を返すとショートサーキットし、その結果がレスポンスに書き込まれます。`await next(context)` を返すとハンドラーが実行され、その結果がチェーンを上に向かって渡されます。戻り値は各フィルターを通って戻ってくるため、出ていく途中でそれを変換することもできます。

## DI を伴う IEndpointFilter クラス形式

インラインのデリゲートは一度きりのロジックには最適ですが、エンドポイント間で再利用したいフィルターはクラスに属します。単一のメソッドを持つ `IEndpointFilter` を実装します。

```csharp
// .NET 11, C# 14
public class ValidationFilter<T> : IEndpointFilter where T : class
{
    private readonly ILogger<ValidationFilter<T>> _logger;

    public ValidationFilter(ILogger<ValidationFilter<T>> logger)
    {
        _logger = logger;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var model = context.Arguments.OfType<T>().FirstOrDefault();

        if (model is null)
        {
            return Results.Problem($"No {typeof(T).Name} argument found.");
        }

        var errors = Validate(model);
        if (errors.Count > 0)
        {
            _logger.LogWarning("Validation failed for {Type}", typeof(T).Name);
            return Results.ValidationProblem(errors);
        }

        return await next(context);
    }

    private static Dictionary<string, string[]> Validate(T model) => new();
}
```

ジェネリックのオーバーロードで登録します。

```csharp
// .NET 11, C# 14
app.MapPost("/products", (Product product) => Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilter<ValidationFilter<Product>>();
```

このクラスがどう構築されるかについて、2 つの点が重要です。1 つ目、フィルターのコンストラクターの依存関係（上記の `ILogger<T>`）は DI コンテナーから解決されるため、ロガー、options、または登録済みの任意のサービスを注入できます。2 つ目、そしてこれが人をつまずかせる点ですが、フィルター型そのものはサービスとしては解決されません。`ValidationFilter<Product>` を `builder.Services` に登録することはありません。フレームワークが代わりにそれをアクティブ化し、そのコンストラクターを DI から満たしますが、それはコンテナーが管理する singleton や scoped のサービスではありません。`AddEndpointFilter<T>()` がコンテナーから取得することを期待して `builder.Services.AddScoped<ValidationFilter<Product>>()` を試みても、その登録は単純に無視されます。

ここで `Results.ValidationProblem` を使うと、`422` スタイルのエラー辞書を持つ RFC 9457 の problem-details 本文が生成されます。この形をフィルターごとではなく中央で制御したい場合、まさにそのために [IProblemDetailsService の設定](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) があります。

## フィルターを重ねると、順序は入りが FIFO、出が FILO

1 つのエンドポイントに複数のフィルターを付けられますが、その順序はこの機能の中で最も紛らわしい部分です。一度見てしまえば分かります。ルールはこうです。`next` の前のコードはフィルターを登録した順序（先入れ先出し）で実行され、`next` の後のコードは逆順（先入れ後出し）で実行されます。スタックのように入れ子になります。

```csharp
// .NET 11, C# 14
app.MapGet("/demo", () =>
    {
        app.Logger.LogInformation("        Handler");
        return "done";
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("Before A");
        var result = await next(context);
        app.Logger.LogInformation("After A");
        return result;
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("    Before B");
        var result = await next(context);
        app.Logger.LogInformation("    After B");
        return result;
    });
```

これは次のようにログ出力します。

```dotnetcli
Before A
    Before B
        Handler
    After B
After A
```

つまり、最初に追加したフィルターが最も外側のラッパーです。認証のようなゲートをログ出力フィルターより前に実行したい場合は、ゲートを先に追加します。フィルターが `next` を呼ばずに戻ってショートサーキットすると、その後に登録されたすべてのフィルターはスキップされ、その前にあるフィルターは `await next(context)` がショートサーキットの結果を返すため、`next` の後のコードを依然として実行します。だからこそ早期の検証フィルターは安全にリクエストを拒否できます。ハンドラーを含む下流のすべては決して実行されません。

## ハンドラーが見る前に引数を変更する

フィルターはバインディングの後に実行されるため、引数をその場で変更でき、ハンドラーは変更後の値を受け取ります。`Arguments` リストは変更可能です。これは正規化に本当に役立ちます。文字列のトリミング、コードの大文字化、ページサイズのクランプなどです。

```csharp
// .NET 11, C# 14
app.MapGet("/search", (string q, int pageSize) => new { q, pageSize })
    .AddEndpointFilter(async (context, next) =>
    {
        // Normalize the query and clamp the page size before the handler runs.
        if (context.Arguments[0] is string q)
        {
            context.Arguments[0] = q.Trim();
        }
        if (context.Arguments[1] is int size)
        {
            context.Arguments[1] = Math.Clamp(size, 1, 100);
        }

        return await next(context);
    });
```

1 つ注意点を心に留めてください。位置インデックスによる変更は、フィルターをハンドラーのパラメーター順序に結び付けます。ジェネリックで再利用可能なフィルターは、型で一致させる（`context.Arguments.OfType<T>()`）か、`HttpContext` から直接読み取る方がよく、それが上記のクラスベースの `ValidationFilter<T>` をエンドポイントに依存しないものにしています。

## 1 つのフィルターをルートグループ全体に適用する

すべてのエンドポイントで `.AddEndpointFilter<...>()` を繰り返すのはノイズです。`MapGroup` は規約を子に引き継ぐ `RouteGroupBuilder` を返すため、グループに追加されたフィルターはその中のすべてのエンドポイントで実行されます。これは [MapGroup で minimal API のエンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) で扱ったリソース単位のエンドポイントモジュールと組み合わせられます。

```csharp
// .NET 11, C# 14
var products = app.MapGroup("/products")
    .AddEndpointFilter<ValidationFilter<Product>>();

products.MapPost("/", (Product p) => Results.Created($"/products/{p.Id}", p));
products.MapPut("/{id:int}", (int id, Product p) => Results.NoContent());
```

グループのフィルターとエンドポイントのフィルターは組み合わさり、順序はグループのフィルターが外側という同じ入れ子ルールに従います。グループのフィルターは、その中の個々のエンドポイントに追加されたフィルターをラップします。グループを入れ子にすることもでき、各レベルがもう 1 つ層を追加します。

名前付きのグループではなくアプリケーション全体にフィルターを適用したい場合は、ルートをカバーするグループに追加します。`app.MapGroup("").AddEndpointFilter(...)` です。「グローバルフィルター」の個別の登録はありませんが、ルートグループが慣用的な等価物であり、フィルターをミドルウェアに変えるのではなく、ルーティングされたエンドポイントに限定して保ちます。

## シグネチャに依存するフィルターのためのファクトリ形式

`AddEndpointFilterFactory` は高度な扉です。フィルターのインスタンスの代わりに、起動時にエンドポイントごとに一度実行され、ハンドラーの `MethodInfo` を持つ `EndpointFilterFactoryContext` を受け取り、実際のフィルターデリゲートを返すファクトリを提供します。これによりハンドラーのシグネチャを検査して特化したフィルターを構築したり、リフレクションの結果をキャッシュしてリクエストごとではなく一度だけ計算されるようにしたりできます。

```csharp
// .NET 11, C# 14 -- only attach the validation logic when the handler takes a Product first
app.MapPost("/products", (Product product) =>
        Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilterFactory((factoryContext, next) =>
    {
        var parameters = factoryContext.MethodInfo.GetParameters();
        var isProductFirst = parameters.Length >= 1
            && parameters[0].ParameterType == typeof(Product);

        if (!isProductFirst)
        {
            // Pass-through: no per-request cost for endpoints that do not match.
            return context => next(context);
        }

        return async context =>
        {
            var product = context.GetArgument<Product>(0);
            if (string.IsNullOrWhiteSpace(product.Name))
            {
                return Results.Problem("Name is required.");
            }
            return await next(context);
        };
    });
```

ここでの利点は、`MethodInfo` の検査がリクエストごとではなくビルド時に一度だけ行われ、シグネチャが一致しないエンドポイントはパススルーのデリゲート以上のコストを一切支払わないことです。単純なフィルターでは必要なことを表現できない場合にのみファクトリに手を伸ばしてください。検証して続行するという一般的なケースには、クラス形式の方がシンプルで読みやすいです。

## フィルターはミドルウェアでもなく、action filter でもない

2 つの比較が残りの混乱の大部分を解消します。ミドルウェアとの対比では、エンドポイントフィルターは自分のエンドポイントに対してのみ、かつバインディングの後にのみ実行されるため、型付きの引数を参照できます。ミドルウェアはパイプラインの枝全体に対して実行され、生の `HttpContext` しか参照できません。ロジックがバインド済みのモデルを必要とするなら、それはフィルターを求めています。ルーティングの前や、関連のない多数のエンドポイントにまたがって実行する必要があるなら、それはミドルウェアを求めています。MVC の action filter（`IActionFilter`、`IAsyncActionFilter`）との対比では、エンドポイントフィルターは minimal API の等価物ですが、別の namespace にある別の型です。MVC の action filter を minimal API のエンドポイントで再利用することはできません。Microsoft が提供する唯一の橋は、`AddEndpointFilter` がコントローラーの `ControllerActionEndpointConventionBuilder` でも動作することです。したがって、両方をルーティングすれば、1 つのエンドポイントフィルターのデリゲートを minimal API のエンドポイントとコントローラーのアクションで共有できます。

もう 1 つ実践的な注意点です。フィルターは `IResult` でショートサーキットできるため、型付きの結果と自然に組み合わさります。ハンドラーが [型付きの Results ユニオン](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) を返す場合でも、`Results.Problem` を返すフィルターはきれいにはまります。フィルターの戻り値の型は `object?` であり、任意の `IResult` がレスポンスに書き込まれるからです。そして本当に重量級の検証には、ASP.NET Core 11 がフィルターなしで data annotations から実行できる [組み込みのリクエスト検証](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) とフィルターを天秤にかけてください。

## 覚えておくべき形

エンドポイントフィルターの追加は、エンドポイントまたは `MapGroup` に対する `.AddEndpointFilter(...)`、一度きりならインラインのデリゲート、再利用なら `IEndpointFilter` クラス、バインド済みの値を読むための `context.GetArgument<T>(index)`（または `context.Arguments`）、そして続行のための `await next(context)` とショートサーキットのための `IResult` の返却に帰着します。コンストラクターの依存関係は DI から来るがフィルター型そのものは登録されたサービスではないこと、重ねたフィルターは入りが FIFO、出が FILO で入れ子になること、グループのフィルターはエンドポイントのフィルターをラップすること、そしてハンドラーのシグネチャを検査する必要があるまれなケースのために `AddEndpointFilterFactory` が存在することを覚えておいてください。それが表面のすべてであり、上記のすべての行は .NET 8 から .NET 11 まで変更なく動作します。

## 関連記事

- [ASP.NET Core 11 で MapGroup を使って minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 でコントローラーなしに minimal API のリクエスト本文を検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)
- [ASP.NET Core 11 で IProblemDetailsService を使って minimal API の検証エラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [ASP.NET Core 11 で minimal API のエンドポイントから型付きの Results ユニオンを返す方法](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [ASP.NET Core 11 における minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## 参考資料

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
- [EndpointFilterInvocationContext (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterinvocationcontext)
- [RouteHandlerBuilderExtensions.AddEndpointFilter (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterextensions)
