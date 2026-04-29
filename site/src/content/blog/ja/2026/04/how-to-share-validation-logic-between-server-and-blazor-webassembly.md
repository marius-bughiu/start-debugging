---
title: "サーバーと Blazor WebAssembly でバリデーションロジックを共有する方法"
description: "Blazor WebAssembly + ASP.NET Core アプリでバリデーションがずれていく最大の原因は、ルールを二度書きたくなる衝動です。本記事では .NET 11 で唯一スケールするレイアウトを示します。DTO とそのバリデーターを所有する Shared クラスライブラリを WASM クライアント (EditForm + DataAnnotationsValidator または Blazored.FluentValidation) とサーバー (minimal API のエンドポイントフィルターまたは MVC のモデルバインディング) の両方から参照し、サーバーから返ってきた ValidationProblemDetails を同じ EditContext に書き戻すラウンドトリップまでテスト済みで構築します。"
pubDate: 2026-04-29
tags:
  - "blazor"
  - "blazor-webassembly"
  - "aspnetcore-11"
  - "dotnet-11"
  - "validation"
  - "fluentvalidation"
  - "csharp"
lang: "ja"
translationOf: "2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly"
translatedBy: "claude"
translationDate: 2026-04-29
---

Blazor WebAssembly クライアントと ASP.NET Core API がそれぞれ別個にバリデーションルールのコピーを抱えていると、最初のスプリントのうちにずれが生じ、最悪の種類のバグを生みます。フォームはクライアントを通過し、サーバーが拒否し、ユーザーはインラインメッセージのない 400 を見るだけ、というやつです。唯一の長続きする解決策は、DTO とそのバリデーターを第三のプロジェクトに置き、それをクライアントとサーバーの両方から参照すること、そしてサーバーが返した失敗レスポンスをクライアントが使ったのと同じ `EditContext` に描画することです。本記事では .NET 11 (`Microsoft.AspNetCore.App` 11.0.0、`Microsoft.AspNetCore.Components.Web` 11.0.0、C# 14) でこのレイアウトをエンドツーエンドで構築します。最初は組み込みの `System.ComponentModel.DataAnnotations`、次に data annotations では表現できないルールのために `FluentValidation` 12 を使います。

## なぜ Shared プロジェクトなのか。重複ルールでも NuGet パッケージでもない理由

うまくいかない 2 つのパターンは、振り返れば明らかです。API の DTO から `[Required]` 属性をクライアント側のほぼ同一の view model にコピペすると、誰かが片方を編集してもう片方を忘れるたびにずれが生じます。コントラクトを外部 NuGet パッケージに置くやり方は大規模システムには有効ですが、単一アプリにはやり過ぎです。バージョンバンプ、パッケージ復元のレイテンシ、内部フィードといったコストを、本来プロジェクト参照で済むはずのもののために払うことになります。

同じソリューション内の `Contracts` (または `Shared`) クラスライブラリが正しい形です。ターゲットは `net11.0`、ASP.NET 依存ゼロで、`WebApp.Client` (Blazor WASM プロジェクト) と `WebApp.Server` (ASP.NET Core API) の両方から参照されます。.NET 11 同梱の Blazor WebAssembly プロジェクトテンプレート (`dotnet new blazorwasm --hosted` は .NET 8 で削除され、.NET 11 でも削除されたままです。今は 3 つのプロジェクトを自分で作るか、統合 Blazor テンプレート用に `dotnet new blazor --interactivity WebAssembly --auth Individual` を使います) はすでにこのレイアウトを受け入れます。お使いのスキャフォールドを選んで 3 つ目のプロジェクトを足してください。

```bash
# .NET 11 SDK (11.0.100)
dotnet new sln -n WebApp
dotnet new classlib -n WebApp.Contracts -f net11.0
dotnet new webapi -n WebApp.Server -f net11.0
dotnet new blazorwasm -n WebApp.Client -f net11.0
dotnet sln add WebApp.Contracts WebApp.Server WebApp.Client
dotnet add WebApp.Server reference WebApp.Contracts
dotnet add WebApp.Client reference WebApp.Contracts
```

`WebApp.Contracts` をクリーンに保ち、サーバーコードが誤って WASM バンドルに引き込まれないようにする 2 つのルール:

1. `.csproj` に `FrameworkReference` も `Microsoft.AspNetCore.*` パッケージもリストしません。コントラクトに `IFormFile` や `HttpContext` が必要なら、ワイヤーフォーマットとサーバーロジックを混同しています。分離してください。
2. `<IsTrimmable>true</IsTrimmable>` を設定して、WASM の publish ステップがリフレクションを使うバリデーターのたびに警告を出さないようにします。これは AOT の落とし穴セクションで再び触れます。

## どの例にも登場する DTO

```csharp
// WebApp.Contracts/RegistrationRequest.cs
// .NET 11, C# 14, System.ComponentModel.DataAnnotations 11.0.0
using System.ComponentModel.DataAnnotations;

namespace WebApp.Contracts;

public sealed record RegistrationRequest
{
    [Required, EmailAddress, StringLength(254)]
    public required string Email { get; init; }

    [Required, StringLength(72, MinimumLength = 12)]
    public required string Password { get; init; }

    [Required, Compare(nameof(Password))]
    public required string ConfirmPassword { get; init; }

    [Range(13, 130)]
    public int Age { get; init; }

    [Required, RegularExpression(@"^[a-zA-Z0-9_]{3,20}$",
        ErrorMessage = "Username must be 3-20 letters, digits, or underscores.")]
    public required string Username { get; init; }
}
```

`required` メンバーと `init` 限定セッターの組み合わせにより、クライアントはオブジェクト初期化子構文で構築でき、サーバーでは `System.Text.Json` 11 がパラメーターレスコンストラクターなしで .NET 11 の `required` メンバー経由で `[JsonConstructor]` 相当の推論を通してデシリアライズできる record になります。同じ record が API エンドポイントと `EditForm` モデルが束縛する型です。ルールを変更する場所は 1 か所だけです。

## DataAnnotations ルート: 追加パッケージはゼロ

ほとんどの CRUD アプリでは、共有 DTO 上の data annotations だけで十分です。Blazor の `<DataAnnotationsValidator>` (`Microsoft.AspNetCore.Components.Forms` に含まれる) がモデルをリフレクションでなめて `EditContext` にメッセージを流し込むのでクライアントで動き、ASP.NET Core のモデルバインディングパイプラインが `[ApiController]` でマークされた型や、デフォルトの `IValidationProblemDetailsService` (エンドポイントフィルターバリデーションの作業 [aspnetcore#52281](https://github.com/dotnet/aspnetcore/pull/52281) の一環で導入) を通る minimal API パラメーターに対して `ObjectGraphValidator` を呼ぶのでサーバーでも動きます。

サーバーエンドポイント、minimal API スタイル:

```csharp
// WebApp.Server/Program.cs
// .NET 11, ASP.NET Core 11.0.0
using Microsoft.AspNetCore.Http.HttpResults;
using WebApp.Contracts;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation(); // .NET 11 endpoint filter that runs DataAnnotations

var app = builder.Build();

app.MapPost("/api/register",
    Results<Ok<RegistrationResponse>, ValidationProblem> (RegistrationRequest req) =>
    {
        // model is already validated by the endpoint filter
        return TypedResults.Ok(new RegistrationResponse(Guid.NewGuid()));
    });

app.Run();

public sealed record RegistrationResponse(Guid UserId);
```

`AddValidation()` は .NET 11 のヘルパーで、各パラメーターについて `[Validator]` で発見されたメンバーや `DataAnnotations` で注釈されたメンバーを巡回し、ハンドラーが走る前に `400` の `ValidationProblemDetails` ボディで短絡するエンドポイントフィルターを登録します。レスポンスの形は、後ほどクライアントが読み戻すものと同じです。

クライアントフォーム、`WebApp.Client/Pages/Register.razor`:

```razor
@* Blazor WebAssembly, .NET 11. Microsoft.AspNetCore.Components 11.0.0 *@
@page "/register"
@using System.Net.Http.Json
@using WebApp.Contracts
@inject HttpClient Http

<EditForm Model="model" OnValidSubmit="SubmitAsync" FormName="register">
    <DataAnnotationsValidator />
    <ValidationSummary />

    <label>Email <InputText @bind-Value="model.Email" /></label>
    <ValidationMessage For="() => model.Email" />

    <label>Password <InputText type="password" @bind-Value="model.Password" /></label>
    <ValidationMessage For="() => model.Password" />

    <button type="submit">Register</button>
</EditForm>

@code {
    private RegistrationRequest model = new()
    {
        Email = "", Password = "", ConfirmPassword = "", Username = ""
    };

    private async Task SubmitAsync()
    {
        var response = await Http.PostAsJsonAsync("api/register", model);
        if (!response.IsSuccessStatusCode)
        {
            await ApplyServerValidationAsync(response);
        }
    }
}
```

これを並列の 2 つの話ではなく *共有された* バリデーションの話にしているのは 2 点です。1 つ目、`model` は `RegistrationRequest` で、サーバーが束縛するのと同じ DTO です。2 つ目、`<DataAnnotationsValidator>` がフォームを評価するとき、サーバーのエンドポイントフィルターが行うのと完全に同じ `Validator.TryValidateObject` のパスを実行します。クライアントが受け入れるものはサーバーも受け入れ、サーバーが `EmailAddress` で拒否するものはクライアントも拒否します。

## サーバーの ValidationProblemDetails を EditContext に書き戻す

ルールを共有していても、サーバーからしか出てこない失敗ケースが 2 種類あります。集約をまたぐチェック (ユーザーテーブルでメールアドレスが一意であること) と、インフラ障害 (rate limit、DB 制約) です。これらに対してサーバーは `400` と `ValidationProblemDetails` を返し、クライアントは各フィールドエラーを取り出して `EditContext` 内の正しい `FieldIdentifier` に貼り付ける必要があります。そうすればユーザーは「登録に失敗しました」のような汎用アラートではなく、問題のフィールドの隣にインラインでメッセージを見ます。

```csharp
// WebApp.Client/Validation/EditContextExtensions.cs
// .NET 11, C# 14
using Microsoft.AspNetCore.Components.Forms;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

public static class EditContextExtensions
{
    private static readonly JsonSerializerOptions Options =
        new(JsonSerializerDefaults.Web);

    public static async Task ApplyValidationProblemAsync(
        this EditContext editContext,
        HttpResponseMessage response)
    {
        if ((int)response.StatusCode != 400) return;

        var problem = await response.Content
            .ReadFromJsonAsync<ValidationProblemDetails>(Options);
        if (problem?.Errors is null) return;

        var messageStore = new ValidationMessageStore(editContext);
        messageStore.Clear();

        foreach (var (fieldName, messages) in problem.Errors)
        {
            // ASP.NET Core uses lowercase-first names by default; normalize.
            var pascal = char.ToUpperInvariant(fieldName[0]) + fieldName[1..];
            var identifier = new FieldIdentifier(editContext.Model, pascal);
            foreach (var msg in messages) messageStore.Add(identifier, msg);
        }

        editContext.NotifyValidationStateChanged();
    }
}
```

Razor ファイル内のハンドラーは次のようになります:

```csharp
private EditContext editContext = default!;

protected override void OnInitialized() =>
    editContext = new EditContext(model);

private async Task SubmitAsync()
{
    var response = await Http.PostAsJsonAsync("api/register", model);
    if (response.StatusCode == System.Net.HttpStatusCode.BadRequest)
        await editContext.ApplyValidationProblemAsync(response);
}
```

これが重要なのは、サーバーでしか実行できないチェックがあるからです。「ユーザー名はすでに使われています」というルールは DB 呼び出しを必要とするため、共有ライブラリには置けません。その失敗を同じ `EditContext` に中継することで、ユーザーは単一のメンタルモデルを得ます。エラーは、それがブラウザーで発火したか API で発火したかに関わらず、問題のフィールドの隣に出ます。

## DataAnnotations では足りないとき: 共有プロジェクトでの FluentValidation 12

DataAnnotations は条件付きルール (「Country が 'US' なら Postcode は必須」) を表現できず、サービスに対する非同期チェックも実行できず、エラーメッセージを属性ごとに 1 つのリソースファイルを超えてローカライズするのは扱いづらいです。FluentValidation 12 は 2026 年に .NET 11 のファーストクラスサポート付きでリリースされ、同じ共有プロジェクトに無理なく同居して双方向に動作します。

パッケージを追加し、DTO の隣にバリデーターを書きます:

```bash
dotnet add WebApp.Contracts package FluentValidation --version 12.0.0
```

```csharp
// WebApp.Contracts/RegistrationRequestValidator.cs
// FluentValidation 12.0.0, .NET 11, C# 14
using FluentValidation;

namespace WebApp.Contracts;

public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator()
    {
        RuleFor(r => r.Email).NotEmpty().EmailAddress().MaximumLength(254);
        RuleFor(r => r.Password).NotEmpty().MinimumLength(12).MaximumLength(72);
        RuleFor(r => r.ConfirmPassword).Equal(r => r.Password)
            .WithMessage("Passwords do not match.");
        RuleFor(r => r.Username).Matches(@"^[a-zA-Z0-9_]{3,20}$");
        RuleFor(r => r.Age).InclusiveBetween(13, 130);
    }
}
```

サーバーでは、同じ `AddValidation()` フィルターのバリデーターソースとして FluentValidation を登録するか、minimal API のフィルターから明示的に呼び出します:

```csharp
// WebApp.Server/Program.cs additions
using FluentValidation;
using WebApp.Contracts;

builder.Services.AddScoped<IValidator<RegistrationRequest>,
                           RegistrationRequestValidator>();

app.MapPost("/api/register", async (
    RegistrationRequest req,
    IValidator<RegistrationRequest> validator) =>
{
    var result = await validator.ValidateAsync(req);
    if (!result.IsValid) return Results.ValidationProblem(result.ToDictionary());
    return Results.Ok(new RegistrationResponse(Guid.NewGuid()));
});
```

`result.ToDictionary()` は `Results.ValidationProblem` が期待する `IDictionary<string, string[]>` の形を生成するので、クライアントがデコードするワイヤーフォーマットは DataAnnotations ルートと同一です。`ApplyValidationProblemAsync` 拡張はそのまま動き続けます。

クライアントには `Blazored.FluentValidation` をインストールします (2026 時点で活発にメンテされているのは `aksoftware` フォークで、`net11.0` をターゲットにしたバージョン 2.4.0)。`<DataAnnotationsValidator />` を `<FluentValidationValidator />` に置き換えます:

```bash
dotnet add WebApp.Client package Blazored.FluentValidation --version 2.4.0
```

```razor
@using Blazored.FluentValidation

<EditForm Model="model" OnValidSubmit="SubmitAsync">
    <FluentValidationValidator />
    <ValidationSummary />
    @* same fields as before *@
</EditForm>
```

このコンポーネントは、モデルを含むアセンブリ (つまり `WebApp.Contracts`) の中から、慣習 (`Foo` に対する `FooValidator`) でバリデーターを見つけます。バリデーターが共有プロジェクトにあるため、クライアントとサーバーは同じルールの同じインスタンスを実行します。違いは *どこで* 走るかだけです。

## サーバー専用で走る非同期ルール

FluentValidation は同期ルールと非同期ルールを混在できます。バリデーターに `MustAsync(IsUsernameAvailableAsync)` を載せれば終わり、と思いがちですが、やめてください。クライアント側はあなたの `UserManager` にアクセスできず、同期的な Blazor `EditForm` は打鍵の途中で非同期ルールを await できません。動くパターンは、async 専用ルールを `RuleSet` でマークすることです:

```csharp
public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator(IUserUniqueness? uniqueness = null)
    {
        // rules that run everywhere
        RuleFor(r => r.Email).NotEmpty().EmailAddress();
        // ... shared rules omitted

        RuleSet("Server", () =>
        {
            if (uniqueness is null) return; // skipped on client
            RuleFor(r => r.Email).MustAsync(uniqueness.IsEmailFreeAsync)
                .WithMessage("This email is already registered.");
            RuleFor(r => r.Username).MustAsync(uniqueness.IsUsernameFreeAsync)
                .WithMessage("Username taken.");
        });
    }
}

// WebApp.Contracts/IUserUniqueness.cs - interface only, no implementation
public interface IUserUniqueness
{
    ValueTask<bool> IsEmailFreeAsync(string email, CancellationToken ct);
    ValueTask<bool> IsUsernameFreeAsync(string username, CancellationToken ct);
}
```

インターフェイスはバリデーターをコンパイルするために `WebApp.Contracts` に置きますが、実装はそこには持ちません。サーバーは EF Core を使った本物の実装を提供し、クライアントは何も登録しないのでコンストラクター引数は `null` になり、`Server` ルールセットは何も追加しません。サーバー側で明示的に有効化します:

```csharp
await validator.ValidateAsync(req,
    options => options.IncludeRuleSets("default", "Server"));
```

こうすれば集約をまたぐチェックは実行できる場所でだけ発火し、すでに構築した `ValidationProblemDetails` のマッピングを通じてクライアントに戻ってきます。

## WASM publish ステップでの trim と AOT の落とし穴

.NET 11 の Blazor WebAssembly publish はデフォルトで IL trimming を実行し、`<RunAOTCompilation>true</RunAOTCompilation>` で別途 AOT パスもサポートします。どちらのパスも、ライブラリが境界のないリフレクションを使うと警告を出します。これは DataAnnotations と FluentValidation の双方が行うことです。具体的にやることは 3 つ:

1. 共有プロジェクトを trim 可能とマークします: `WebApp.Contracts.csproj` に `<IsTrimmable>true</IsTrimmable>` と `<IsAotCompatible>true</IsAotCompatible>` を入れます。これにより、SDK は trim 警告を共有ライブラリの中で表面化させて修正できるようにし、ルール発見を消費側で静かに削り落とすことを防ぎます。
2. DataAnnotations については、ランタイムが .NET 8 以来 `Validator.TryValidateObject` に `[DynamicallyAccessedMembers(All)]` 注釈を出荷しており、.NET 11 でも引き続き有効です。DTO が `public` で、trimmer が見えるルートから到達可能であれば、ほかに何もする必要はありません。`EditForm` はジェネリック引数経由でモデル型に到達するので、それで条件は満たされます。
3. FluentValidation 12 については、定義した各バリデーターは起動時にリフレクションで読み取られます。`Blazored.FluentValidation` 2.4.0 のコンポーネントは `[DynamicDependency]` 注釈付きでアセンブリをスキャンするので trimming を生き延びますが、`RunAOTCompilation` で publish するなら、クライアントの `.csproj` に `<TrimmerRootAssembly Include="WebApp.Contracts" />` を追加してください。これは共有アセンブリ全体をルート化し、最も簡単で正しい答えです。WASM サイズコストは小さいです。`WebApp.Contracts` の公開型はすでに使っている DTO とバリデーターだけだからです。

これらのステップを飛ばすと、クライアントは `dotnet run` では健全に見えるのに、Release ビルドを出荷したときにバリデーションが何もしないという事態になります。trimmer が、静的に使われていることを証明できなかったルールを取り除くからです。

## フィールド名の大文字小文字と snake_case の罠

ASP.NET Core 11 のデフォルト JSON オプションはプロパティ名を `camelCase` でシリアライズします。よって `ValidationProblemDetails.Errors` は `Email` ではなく `email` をキーとして返ってきますし、`FieldIdentifier` は大文字小文字を区別します。`ApplyValidationProblemAsync` の `pascal` 正規化はよくあるケースには対応しますが、ネストしたメンバーには対応しません (`Address.PostalCode` は最初の文字だけ大文字化すると `address.PostalCode` になります)。ネスト DTO の場合は `.` で分割し、各セグメントの先頭文字を大文字化し、セグメントを使ってネストオブジェクトに降りていって `FieldIdentifier(parent, propertyName)` のチェーンを構築します。あるいは、JSON オプションを制御できるなら、独自の `IProblemDetailsService` を書いて `ProblemDetails` のためだけに `JsonNamingPolicy = null` を設定してください。シンプルな答えは、大文字小文字の反転が一行で済むくらい DTO をフラットに保つことです。

グローバルに別のネーミングポリシーを採用する場合 (OpenAPI ツーリングのために 2026 年では snake_case が人気) は、同じ考え方が当てはまります。ポリシーをパースし、反転し、修正した名前を `FieldIdentifier` に渡します。`Microsoft.AspNetCore.Components.Forms` にこのための組み込みヘルパーはありません。`EditContext` は `ProblemDetails` が標準のエラー形式になる前に設計されたもので、両者はまだ配線されていません。

## 関連ガイドとソース資料

このガイドが前提とする周辺の配管: ASP.NET Core 11 における [グローバル例外フィルターパターン](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は、500 としてユーザーに到達してはならない非バリデーションの障害を捕捉します。このフォームを支えるエンドポイントを深く見たい方は、[ASP.NET Core Identity のリフレッシュトークン](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) が `/api/register` の続きを示しています。同じ DTO に対して URL を手で打たないように生成された型付きクライアントについては、[.NET 11 で OpenAPI 仕様から強型付けクライアントを生成する](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) を参照してください。JSON 側では、共有 DTO の単一フィールドが線上で異なる形を必要とするときの正しい逃げ道として [`System.Text.Json` のカスタム `JsonConverter`](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) があります。

執筆時に参照した一次情報源:

- [ASP.NET Core 11 minimal API の検証エンドポイントフィルター](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-11.0#validation), MS Learn.
- [Blazor `EditForm` と `DataAnnotationsValidator`](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/validation?view=aspnetcore-11.0), MS Learn.
- [`ValidationProblemDetails` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails), .NET API Browser.
- [FluentValidation 12 ドキュメント](https://docs.fluentvalidation.net/en/latest/blazor.html), Blazor 連携ページ.
- [Blazored.FluentValidation 2.4.0](https://github.com/Blazored/FluentValidation), GitHub README.
- [.NET 11 の Blazor WebAssembly trimming と AOT のガイド](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/configure-trimmer?view=aspnetcore-11.0), MS Learn.
