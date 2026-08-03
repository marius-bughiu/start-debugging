---
title: ".NET 11 で IValidateOptions<T> を使って起動時にオプションを検証する方法"
description: "IValidateOptions<T> を実装し、DI に登録して ValidateOnStart をチェーンすれば、不正な appsettings.json は最初にそれに触れたリクエストではなくプロセスそのものを落とします。.NET 11 の Validate<TValidator>() オーバーロード、IAsyncValidateOptions<T> による非同期検証、そして ValidateOnStart が黙って何もしない 3 つのケースを解説します。"
pubDate: 2026-08-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "configuration"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

不正な設定でアプリを起動時に失敗させるには、`IValidateOptions<TOptions>` を実装したクラスを書き、DI に singleton として登録し、その型の `OptionsBuilder<TOptions>` に `.ValidateOnStart()` をチェーンします。`ValidateOnStart` がなければ、検証は `.Value` への最初のアクセス時に遅延実行されます。それはたいてい、その設定に触れる最初のリクエスト、しかも本番環境の午前 3 時ということになります。付けておけば、`Host.StartAsync` が登録済みのすべてのオプション型に対してバインドと検証を強制し、ホストされたサービスが 1 つも起動する前に完了させます。失敗すると `OptionsValidationException` が `host.RunAsync()` から送出されます。以下の内容はすべて .NET 11、`Microsoft.Extensions.Options` 11.0.0、C# 14 を対象としています。`IValidateOptions<T>` と `ValidateOnStart` の中核は、API が `Microsoft.Extensions.Hosting.dll` から `Microsoft.Extensions.Options.dll` に移って以降ずっとこの挙動なので、.NET 8 から .NET 10 でもそのまま動きます。`Validate<TValidator>()` オーバーロードと非同期パイプラインは .NET 11 の新機能で、その旨を明示しています。

## 遅延検証とは、顧客から知らされる検証のことです

`ValidateDataAnnotations()` も `Validate(delegate)` も、検証をオプションのパイプラインにぶら下げますが、そのパイプラインは設計上遅延実行です。`IOptions<T>` は singleton で、その `.Value` は誰かが最初に読んだときに計算されます。つまり、次の登録は:

```csharp
// .NET 11, C# 14
builder.Services
    .AddOptions<PaymentOptions>()
    .Bind(builder.Configuration.GetSection("Payments"))
    .ValidateDataAnnotations();
```

`Payments` セクションが空でもきれいに起動し、health check を通過し、トラフィックを処理し、そして最初のリクエストが決済エンドポイントに届いた瞬間に `OptionsValidationException` を投げるアプリを生みます。デプロイは成功しました。カナリアは緑でした。障害は顧客のカード決済での 500 として現れました。

起動時検証の狙いは、これを起動時クラッシュに変えることです。オーケストレーターはすでにその扱い方を知っています。コンテナーは非ゼロで終了し、ロールアウトは停止し、以前のリビジョンが処理を続けます。部分的に壊れたプロセスよりはるかにましな失敗です。

## 起動時検証を実際に発火させる手順

1. **セクション名を持つオプションクラスを定義します。** public な読み書き可能プロパティのみ、非 abstract、public な引数なしコンストラクター。フィールドはバインドされません。
2. **検証を `IValidateOptions<TOptions>` を実装するクラスとして書きます。** 最初の 1 件ではなく、すべての失敗を含む `ValidateOptionsResult.Fail` を返します。
3. **検証を DI に登録します。** singleton の `ServiceDescriptor` とともに `TryAddEnumerable` を使ってください。パイプラインは `IEnumerable<IValidateOptions<TOptions>>` を解決するため、素の `AddSingleton` を 2 回呼ぶと検証が二重に登録されます。
4. **builder に `.ValidateOnStart()` をチェーンします。** あるいは `AddOptionsWithValidateOnStart<TOptions>()` から始めれば、忘れようがありません。
5. **ホストを実行します。** `ValidateOnStart` は `Host.StartAsync` が実行されるまで何もしません。ホストをビルドするだけでは不十分です。

以下が一連の流れです。

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class PaymentOptions
{
    public const string SectionName = "Payments";

    [Required]
    public required string ApiKey { get; set; }

    [Required]
    [Url]
    public required string Endpoint { get; set; }

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [Range(0, 10)]
    public int MaxRetries { get; set; } = 3;
}
```

検証クラスです。最初の失敗で返さずに失敗を集めている点に注目してください。壊れた `appsettings.json` を直す人が、再起動ごとに 1 件ずつではなく、1 回の起動で全リストを受け取れます:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
    public ValidateOptionsResult Validate(string? name, PaymentOptions options)
    {
        var builder = new ValidateOptionsResultBuilder();

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            builder.AddError("ApiKey is missing.", nameof(PaymentOptions.ApiKey));
        }
        else if (!options.ApiKey.StartsWith("pk_", StringComparison.Ordinal))
        {
            builder.AddError(
                "ApiKey must start with 'pk_'. A secret key was probably pasted by mistake.",
                nameof(PaymentOptions.ApiKey));
        }

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out Uri? endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps)
        {
            builder.AddError(
                "Endpoint must be an absolute https URI.",
                nameof(PaymentOptions.Endpoint));
        }

        // Cross-property rule: nothing in DataAnnotations can express this.
        if (options.TimeoutSeconds * (options.MaxRetries + 1) > 300)
        {
            builder.AddError(
                $"TimeoutSeconds ({options.TimeoutSeconds}) times MaxRetries + 1 "
                + $"({options.MaxRetries + 1}) exceeds the 300s gateway budget.");
        }

        return builder.Build();
    }
}
```

`ValidateOptionsResultBuilder` は `Microsoft.Extensions.Options` にあり、まさに `StringBuilder` を手作りしなくて済むように存在しています。何も追加されなければ `Build()` は `ValidateOptionsResult.Success` を返すので、最後に null を扱う手間はありません。`AddError` は省略可能なプロパティ名を受け取り、それがメッセージの先頭に付きます。DataAnnotations の出力を同じ入れ物に流し込むための `AddResult(ValidationResult)` と `AddResults(IEnumerable<ValidationResult>)` もあります。

登録:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection.Extensions;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptionsWithValidateOnStart<PaymentOptions>()
    .Bind(builder.Configuration.GetSection(PaymentOptions.SectionName))
    .ValidateDataAnnotations();

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<PaymentOptions>, ValidatePaymentOptions>());

var app = builder.Build();
await app.RunAsync();
```

`AddOptionsWithValidateOnStart<TOptions>()` は、順序を忘れられなくした `AddOptions<TOptions>().ValidateOnStart()` にすぎません。ジェネリック引数が 2 つの `AddOptionsWithValidateOnStart<TOptions, TValidateOptions>()` というオーバーロードもあり、こちらは検証クラスの登録も行い、上の 2 つの登録を 1 回の呼び出しにまとめます。

`ValidateDataAnnotations()` と手書きの `IValidateOptions<T>` は排他ではありません。属性は個々のプロパティの形を扱い、クラスは複数プロパティにまたがるルールやサービスを必要とするルールを扱います。登録されたすべての検証が実行され、その失敗はすべて集約されます。

## ValidateOnStart が実際に登録しているもの

`ValidateOnStart` は登録時点では何も実行しません。.NET 11 の [ランタイムのソース](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) を読むと、やっているのは 3 つです:

```csharp
optionsBuilder.Services.TryAddTransient<IStartupValidator, StartupValidator>();
optionsBuilder.Services.TryAddTransient<IAsyncStartupValidator, StartupValidator>();
optionsBuilder.Services.AddOptions<StartupValidatorOptions>()
    .Configure<IOptionsMonitor<TOptions>>((vo, options) =>
    {
        // This adds an action that resolves the options value to force evaluation
        // We don't care about the result as duplicates are not important
        vo._validators[(typeof(TOptions), optionsBuilder.Name)] = () => options.Get(optionsBuilder.Name);
    });
```

`StartupValidatorOptions` の内部ディクショナリに、`(Type, name)` をキーとして thunk を追加します。thunk は `IOptionsMonitor<TOptions>.Get(name)` を呼び、これが `OptionsFactory<TOptions>.Create` に `IConfigureOptions<T>` のチェーン、続いて `IPostConfigureOptions<T>` のチェーン、続いてすべての `IValidateOptions<T>` を実行させます。検証はバインドを強制した副作用です。

`TryAdd` は重要です。以前のリリースではこれが `AddTransient` だったため、10 個のオプション型に `ValidateOnStart` を呼ぶとコンテナーに `StartupValidator` が 10 個入りました。ディクショナリのキーは古い落とし穴も説明します。`(Type, name)` でキーを取ることで、名前付きインスタンスが最後の 1 つに上書きされず、それぞれ独自のエントリを持てます。

トリガーは `Host.StartAsync` の中、`IHostLifetime.WaitForStartAsync` の後、ホストされたサービスが起動する前にあります:

```csharp
IStartupValidator? validator = Services.GetService<IStartupValidator>();
validator?.Validate();

IAsyncStartupValidator? asyncValidator = Services.GetService<IAsyncStartupValidator>();
if (asyncValidator is not null)
{
    await asyncValidator.ValidateAsync(cancellationToken).ConfigureAwait(false);
}
```

押さえておくべき帰結が 2 つあります。1 つ目は、検証が `IHostedLifecycleService.StartingAsync` より前に走るため、`BackgroundService` が中途半端に正しい設定を目にすることはない点です。2 つ目は、複数のオプション型が失敗した場合、`StartupValidator` が例外を集めて `AggregateException` として再送出する点です。おかげで再起動のたびにモグラ叩きをするのではなく、壊れたセクションが 1 行のログにまとめて出ます。

## .NET 11 の Validate<TValidator>() オーバーロード

.NET 11 より前は、検証を配線するのに互いに一致していなければならない 2 つの文が必要でした。検証クラス用の `AddSingleton` と、別にある `AddOptions` のチェーンです。.NET 11 は、デリゲートではなく型引数を取るジェネリックな [`OptionsBuilder<TOptions>.Validate<TValidator>()`](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries#options-builder-validation-improvements) オーバーロードを追加しました:

```csharp
// .NET 11 only
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

検証の型は `IValidateOptions<TOptions>` を実装し、あらかじめコンテナーに登録されている必要があります。そこが要点で、検証は DI から解決されるため、`IHostEnvironment`、`TimeProvider`、`HttpClient` などをコンストラクターで受け取れます。以前これがやりにくかったのは、`Validate` のデリゲート版がオプションのインスタンスしか渡さず、最大 5 つのサービス注入は `Configure` 側でしか使えなかったからです。

`AddSingleton` を省略しないでください。このオーバーロードは型を解決するだけで、登録はしません。

## IAsyncValidateOptions<T> による非同期検証

.NET 11 の興味深い追加は、起動時検証が I/O を行えるようになったことです。設定の中には、何かに問い合わせないと誤りが見えないものがあります。パースは通るが存在しないデータベースを指す接続文字列、discovery ドキュメントが 404 を返す OIDC authority、マネージド ID が読めない blob コンテナーなどです。.NET 11 より前は、`Validate` の中でスレッドをブロックするか、あきらめて初回利用時に確認するかしか誠実な選択肢はありませんでした。

`IAsyncValidateOptions<TOptions>` は `IValidateOptions<TOptions>` の非同期版です:

```csharp
namespace Microsoft.Extensions.Options;

public interface IAsyncValidateOptions<in TOptions> where TOptions : class
{
    Task<ValidateOptionsResult> ValidateAsync(
        string? name, TOptions options, CancellationToken cancellationToken = default);
}
```

決済エンドポイントに実際に到達できることを確かめる実装です:

```csharp
// .NET 11 only
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentEndpointAsync(IHttpClientFactory httpClientFactory)
    : IAsyncValidateOptions<PaymentOptions>
{
    public async Task<ValidateOptionsResult> ValidateAsync(
        string? name, PaymentOptions options, CancellationToken cancellationToken = default)
    {
        using HttpClient client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                new Uri(new Uri(options.Endpoint), "/.well-known/health"), cancellationToken);

            return response.IsSuccessStatusCode
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Payment endpoint {options.Endpoint} returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return ValidateOptionsResult.Fail(
                $"Payment endpoint {options.Endpoint} is unreachable: {ex.Message}");
        }
    }
}
```

同期版と同じように `IAsyncValidateOptions<PaymentOptions>` に対して `TryAddEnumerable` で登録し、`ValidateOnStart()` の呼び出しはそのまま残します。`OptionsBuilderExtensions` の登録処理は、登録済みの `IAsyncValidateOptions<TOptions>` を `_asyncValidators` という 2 つ目のディクショナリに実体化し、1 つ以上ある場合にのみ非同期デリゲートを設置します。1 つも登録されていなければ何も変わらず、非同期のコストも発生しません。

見込んでおくべき挙動が 2 つあります。非同期の検証は起動時にしか走りません。非同期パイプラインは `IOptionsFactory` ではなく `IAsyncStartupValidator` にぶら下がっているため、後から `.Value` に遅延アクセスしても発火しません。そしてステージ 2 はステージ 1 が成功した場合にのみ走ります。これは意図的です。エンドポイントの URL が `[Url]` 属性で落ちているのに、ネットワークのプローブに 5 秒かける理由はありません。

対応する DataAnnotations 側の作業も同時に入りました。オーバーライド可能な `IsValidAsync` を持つ `AsyncValidationAttribute`、モデルに実装する `IAsyncValidatableObject`、そして `Validator.ValidateObjectAsync` / `TryValidateObjectAsync` / `ValidatePropertyAsync` / `ValidateValueAsync` です。ルールを別クラスではなくプロパティ上の属性として表したい場合はこちらを使ってください。

## [OptionsValidator] で手書きの検証を省く

ルールがすべて DataAnnotations の属性であれば、`Validate` メソッドを書く必要はまったくありません。オプション検証のソースジェネレーターがコンパイル時に `IValidateOptions<T>` の実装を書いてくれます:

```csharp
// .NET 8 and later
using Microsoft.Extensions.Options;

[OptionsValidator]
public sealed partial class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
}
```

空の partial クラスと属性だけで、ジェネレーターは `Validate(string?, PaymentOptions)` を出力します。中身はプロパティごとに、事前に確保された静的な属性インスタンスを使って `Validator.TryValidateValue` を呼び、`ValidateOptionsResultBuilder` に集約するコードです。実行時にオプション型へのリフレクションを行わないので、これが Native AOT に適した形です。プロジェクトが `Microsoft.Extensions.Options` 8.0 以降を参照していればジェネレーターは既定で有効で、これを使うと `ValidateDataAnnotations()` は不要になります。生成コードでは `RangeAttribute`、`MinLengthAttribute`、`MaxLengthAttribute`、`LengthAttribute` もリフレクションを使わない等価物に置き換えられます。ジェネレーターがビルドに何をしているかの背景は [ソースジェネレーターとは何か、いつ必要か](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) の解説を、リフレクションなしの検証が重要な理由は [トリム安全なコード](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) のメモを参照してください。

既定では DataAnnotations の検証は再帰的ではありません。入れ子になったオプションオブジェクトやサブオプションの `List<T>` は、それぞれ `[ValidateObjectMembers]` と `[ValidateEnumeratedItems]` で指定しない限り検証されません。どちらもジェネレーターと併用できます。

## ValidateOnStart が黙って何もしない場所

レビューで誰も気づかない失敗モードは、`ValidateOnStart` が登録されているのに一度も実行されないことです。3 つのケースがあります。

**ホストを一度も起動していない。** `builder.Build()` を呼び、`StartAsync` なしで `host.Services` からサービスを解決するテストやツールは、検証を完全にスキップします。統合テストでチェックしたいなら、`try` の中で `GetRequiredService<IOptions<T>>().Value` を明示的に解決するか、`host.Services.GetService<IStartupValidator>()?.Validate()` を直接呼んでください。

**ホストが `Microsoft.Extensions.Hosting` のものではない。** 上で引用した呼び出し箇所は `Host.StartAsync` にあります。独自のホストを組み立てるランタイム、最も有名なのは Azure Functions のインプロセスモデルですが、そこには決して到達しません。これがまさに [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034) です。分離ワーカーモデルは通常の generic host なので動きます。変わった環境では、思い込みではなく意図的に壊したセクションで確認してください。

**検証は登録したが builder は登録していない。** `services.Configure<T>(section)` に検証の登録を足しただけでは、遅延検証しか得られません。`Configure<T>` は `OptionsBuilder<T>` を作らないため、`ValidateOnStart` をチェーンする先がありません。`AddOptions<T>().Bind(section)` か `AddOptionsWithValidateOnStart<T>().Bind(section)` が必要です。

もう 1 つ、黙ってはいないものの読み違えやすい点があります。検証は名前付きインスタンスごとに走ります。名前付きの `PaymentOptions` が 3 つあって `AddOptions<PaymentOptions>("primary").ValidateOnStart()` しか呼んでいなければ、残りの 2 つは遅延検証されます。名前ごとに独自のチェーンが必要です。同じ設定クラスの複数のバリエーションを配線する場合、消費側では [.NET 11 の DI におけるキー付きサービス](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) と自然に組み合わさります。

## 例外をどう扱うか

`OptionsValidationException` は `OptionsType`、`OptionsName`、そして `IEnumerable<string>` としての `Failures` を持ちます。`Message` は失敗を `;` で連結したもので、コンテナーのログでは問題ありませんが、ターミナルでは読みづらいものです。アプリが CLI や開発者向けサービスなら、`Main` の先頭で捕捉して 1 行 1 失敗で出力するのはちょっとした親切です:

```csharp
// .NET 11, C# 14
try
{
    await app.RunAsync();
}
catch (OptionsValidationException ex)
{
    Console.Error.WriteLine($"Invalid configuration for {ex.OptionsType.Name}:");
    foreach (string failure in ex.Failures)
    {
        Console.Error.WriteLine($"  - {failure}");
    }
    return 78; // EX_CONFIG
}
```

複数のオプション型を検証しているなら `catch (AggregateException agg)` でも包んでください。`StartupValidator` は複数の失敗をその形で表面化させます。

起動時検証は、.NET アプリで利用できる最も安上がりな信頼性向上策です。すでに手元にある builder へのメソッド呼び出し 1 つで、設定ミスのデプロイという本番障害のカテゴリー全体を、ロールアウトの仕組みがすでに扱い方を知っている起動失敗へと変換します。

## 関連記事

- [.NET 11 における IOptions&lt;T&gt; と IOptionsSnapshot&lt;T&gt; と IOptionsMonitor&lt;T&gt;](/ja/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/)：検証する前に、正しいアクセサーを選ぶための記事です。
- [Fix: Cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)：検証クラスが scoped な依存を受け取ると遭遇する captive dependency エラーを扱います。
- [Fix: No connection string named 'DefaultConnection' could be found](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)：起動時検証が防いでくれる、典型的な遅延設定の失敗です。
- [ソースジェネレーターとは何か、いつ必要か](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)：`[OptionsValidator]` がコンパイル時に何をしているかを説明します。
- [IHostedService 契約とは何か、いつ使うか](/ja/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/)：検証を通過した直後に何が走るかを示します。

## 参考資料

- MS Learn の [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options)：`ValidateOnStart`、`AddOptionsWithValidateOnStart`、再帰検証の属性について。
- [Compile-time options validation source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/options-validation-generator)：`[OptionsValidator]` と生成される出力について。
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries)：`Validate<TValidator>()` オーバーロードと DataAnnotations の非同期検証について。
- dotnet/runtime の [`OptionsBuilderExtensions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) と [`IAsyncValidateOptions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/IAsyncValidateOptions.cs)。
- [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034)、`ValidateOnStart()` does not work in Azure Functions。
