---
title: ".NET 11 の依存性注入でキー付きサービスを登録して解決する方法"
description: "AddKeyedSingleton/Scoped/Transient で同じサービス型の複数の実装をキーの下に登録し、[FromKeyedServices]、GetRequiredKeyedService、または KeyedService.AnyKey で解決します。キー付きとキーなしの登録は別々のテーブルであり、それがほぼ全員が引っかかる落とし穴です。"
pubDate: 2026-06-23
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dependency-injection"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection"
translatedBy: "claude"
translationDate: 2026-06-23
---

.NET に組み込まれた依存性注入コンテナーは、同じサービス型の複数の実装を保持し、キーによって区別できます。各実装を `AddKeyedSingleton`、`AddKeyedScoped`、または `AddKeyedTransient` で登録し、`object` 型のキー（一般的には文字列または enum）を渡します。そして特定の実装をコンストラクターやハンドラーのパラメーターに付けた `[FromKeyedServices("key")]`、あるいは `provider.GetRequiredKeyedService<T>("key")` で取り出します。誰もがつまずく唯一の事実は、キー付きの登録とキーなしの登録が 2 つの別々のテーブルに存在するということです。通常の `GetService<T>()` はキー付きの登録を決して見つけられず、`[FromKeyedServices]` はキーなしの登録を決して見つけられません。このガイドは .NET 11（執筆時点では preview 5、一般提供は 2026 年 11 月を予定）と `Microsoft.Extensions.DependencyInjection` 11.0.0 を対象に書かれています。キー付きサービスは .NET 8 で登場し、それ以来 API は安定しているため、ここで紹介するすべてのパターンは .NET 8 と .NET 10 でも変更なく動作します。

## 新しいインターフェースを作る代わりにサービスにキーを付ける理由

`IPaymentGateway` の 2 つの実装を登録する古い方法は、2 つのインターフェース（`IStripeGateway`、`IPayPalGateway`）を考案するか、文字列で分岐するファクトリーのデリゲートを登録することでした。どちらも選択メカニズムを型システムへ漏らしてしまいます。キー付きサービスはインターフェースを単数のままにし、識別子を登録へと移します。これはまさに、デプロイ時または構成時の選択が属するべき場所です。

代表的なケース：

- **1 つの契約の背後に複数のプロバイダー。** 2 つの決済ゲートウェイ、3 つの通知チャネル、プライマリーとフォールバックの HTTP クライアントを、それぞれキーの下に登録し、呼び出し箇所ごとに選択します。
- **名前付きのキャッシュまたは接続。** 短命のキャッシュと長命のキャッシュ、いずれも `IMemoryCache` の形をしており、キー `"short"` と `"long"` を付けます。
- **実行時の戦略ルックアップ。** キーをリクエストから計算する戦略のディクショナリを、手書きの `switch` ではなく `IKeyedServiceProvider` を通じて解決します。

実装が常に 1 つしかないなら、キーに手を伸ばさないでください。キー付きの登録は識別子を追加し、それを登録箇所とすべての解決箇所の間で同期させ続けなければなりません。多重性が現実にあるときに使ってください。

## キー付きサービスの登録

キーなしの登録メソッドにはそれぞれ、最初の引数として `serviceKey` を取るキー付きの双子があります。表面全体を 1 つのブロックに示します。

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Two implementations of the same interface, told apart by a string key.
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");

// Lifetimes work exactly as their non-keyed counterparts.
builder.Services.AddKeyedScoped<IReportBuilder, PdfReportBuilder>("pdf");
builder.Services.AddKeyedTransient<IReportBuilder, CsvReportBuilder>("csv");

// A factory overload gives you the key and the provider, useful when the
// implementation needs to read its own key or build from config.
builder.Services.AddKeyedSingleton<IClock>("utc", (sp, key) => new SystemClock(DateTimeKind.Utc));

var app = builder.Build();
```

キーは `object` 型で、`Equals` で比較されます。文字列は `appsettings.json` の往復を生き延びるためよく選ばれますが、集合が閉じていてコンパイル時に既知の場合は enum のほうがすっきりします。

```csharp
// .NET 11, C# 14 - enum keys avoid stringly-typed lookups
public enum Channel { Email, Sms, Push }

builder.Services.AddKeyedScoped<INotifier, EmailNotifier>(Channel.Email);
builder.Services.AddKeyedScoped<INotifier, SmsNotifier>(Channel.Sms);
builder.Services.AddKeyedScoped<INotifier, PushNotifier>(Channel.Push);
```

同じ実装型を複数のキーの下に登録できますし、**同じ**キーの下に複数の実装を登録することもできます。後者のケースは `IEnumerable<T>` の解決になります。これは後述します。

## キー付きサービスを解決する 3 つの方法

### `[FromKeyedServices]` によるコンストラクター注入

この属性は `Microsoft.Extensions.DependencyInjection` にあり、単一のコンストラクターパラメーターに印を付けて、コンテナーがそれをキー付きテーブルから解決するようにします。これは通常のサービスやコントローラーで使いたい形です。消費側を `IServiceProvider` への参照から解放できるからです。

```csharp
// .NET 11, C# 14
public sealed class CheckoutService(
    [FromKeyedServices("stripe")] IPaymentGateway gateway)
{
    public Task<string> ChargeAsync(decimal amount) => gateway.ChargeAsync(amount);
}
```

同じ属性は minimal API のハンドラーパラメーターでも機能します。これはキー付きの依存関係をエンドポイントに束縛する最もすっきりした方法です。

```csharp
// .NET 11, C# 14 - keyed dependency straight into a minimal API handler
app.MapPost("/charge/{provider}",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));
```

MVC コントローラーのアクションパラメーターやコントローラーのコンストラクターパラメーターでも機能し、いずれの場合も追加の登録は不要です。

### `GetRequiredKeyedService` による命令的な解決

キーが実行時にしか分からない場合（リクエストから計算する、構成から読み取る）、コンパイル時の属性は使えません。`IServiceProvider` を注入し、キー付きの拡張メソッドを呼び出します。`Build()` が生成するプロバイダーは `IKeyedServiceProvider` を実装しているため、これらは既定のコンテナーに対して常に機能します。

```csharp
// .NET 11, C# 14 - the key is decided at runtime
public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string providerKey, decimal amount)
    {
        // Throws InvalidOperationException if nothing is registered under the key.
        var gateway = services.GetRequiredKeyedService<IPaymentGateway>(providerKey);
        return gateway.ChargeAsync(amount);
    }
}
```

登録の欠如が例外ではなく通常の結果である場合は、`GetKeyedService<T>(key)`（"Required" なし）を使ってください。例外をスローする代わりに `null` を返します。scoped な消費側の内部では、キー付きの scoped インスタンスが正しくスコープされるよう、scoped プロバイダーから解決してください。`BackgroundService` のようなシングルトンの内部でスコープに手を伸ばしているなら、あらゆる [BackgroundService 内の scoped サービス](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)と同じ `IServiceScopeFactory` の規律が適用されます。登録がキー付きであることはライフタイムの規則を変えません。

### あるキーの下のすべての実装を解決する

同じキーの下に複数の実装を登録し、それらを集合として解決します。

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IValidationRule, NotEmptyRule>("order");
builder.Services.AddKeyedSingleton<IValidationRule, PositiveAmountRule>("order");

public sealed class OrderValidator(
    [FromKeyedServices("order")] IEnumerable<IValidationRule> rules)
{
    public bool IsValid(Order o) => rules.All(r => r.Check(o));
}
```

`GetKeyedServices<IValidationRule>("order")` は命令的な同等物で、両方の実装を登録順に返します。

## `KeyedService.AnyKey` で任意のキーに一致させる

ときには、*すべての*キーに対して応答する 1 つの登録が欲しいことがあります。実装は自分が解決されたキーを読み取ります。それが `KeyedService.AnyKey` の役目です。`[ServiceKey]` パラメーターと組み合わせて、実装が構築時に実際のキーを受け取れるようにします。

```csharp
// .NET 11, C# 14 - one registration that serves any key
builder.Services.AddKeyedSingleton<ITenantStore>(
    KeyedService.AnyKey,
    (sp, key) => new TenantStore((string)key!));

public sealed class TenantStore : ITenantStore
{
    public TenantStore(string tenantId) => TenantId = tenantId;
    public string TenantId { get; }
}

// A consumer can ask for any tenant; the key flows into the factory.
var acme = app.Services.GetRequiredKeyedService<ITenantStore>("acme");
var globex = app.Services.GetRequiredKeyedService<ITenantStore>("globex");
```

コンストラクターパラメーターの `[ServiceKey]` 属性は、ファクトリーのオーバーロードなしでも機能します。コンテナーはインスタンスの解決に使われたキーを注入します。

```csharp
// .NET 11, C# 14 - the implementation discovers its own key
public sealed class TenantStore(
    [ServiceKey] string tenantId,
    AppDbContext db) : ITenantStore
{
    public string TenantId => tenantId;
}

builder.Services.AddKeyedScoped<ITenantStore, TenantStore>(KeyedService.AnyKey);
```

`AnyKey` には 2 つの規則があります。1 つ目は、両方が存在する場合、正確なキーの登録が `AnyKey` の登録に勝ちます。2 つ目は、`KeyedService.AnyKey` をキーとして*解決*することはできません。これは登録側のセンチネルにすぎません。`GetRequiredKeyedService<T>(KeyedService.AnyKey)` を呼ぶとスローします。

## 最も混乱を招く分離

キー付きとキーなしの登録は、コンテナー内部の 2 つの別個のテーブルです。この唯一の事実が、ほぼすべての「でも登録したのに」というバグ報告を説明します。

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");

var sp = builder.Services.BuildServiceProvider();

sp.GetService<IPaymentGateway>();                 // null - no NON-keyed registration
sp.GetKeyedService<IPaymentGateway>("stripe");    // the StripeGateway
sp.GetKeyedService<IPaymentGateway>("paypal");    // null - nothing under that key
```

通常のコンストラクターパラメーター `IPaymentGateway gateway`（属性なし）はキーなしテーブルからのみ解決し、キー付きの登録は見つけられません。サービスを両方の方法で到達可能にしたいなら、キー付きとキーなしで 2 回登録してください。逆の罠も同じくらいよくあります。通常の `AddSingleton` で登録したサービスに対する `[FromKeyedServices("stripe")]` は何にも解決しません。属性はキー付きテーブルしか読まないからです。

この分離は、`GetServices<T>()`（キーなしの列挙）がキー付きの登録を含まない理由でもあります。「すべての実装」を列挙することに依存するなら、それらがキー付きかどうかを前もって決め、一貫性を保ってください。

## 出荷前に知っておくべき落とし穴

**`ActivatorUtilities.CreateInstance` は `[FromKeyedServices]` を尊重しますが、それが活性化する型に対してのみです。** コンテナー（または `ActivatorUtilities`）が作成した型は、そのキー付きパラメーターが埋められます。あなたが自分で `new` した型は、キー付きであろうとなかろうと何も注入されません。これはファクトリーコードや DI グラフの外側のあらゆるものにとって重要です。

**キーの `Equals` と `GetHashCode` は安定していなければなりません。** 文字列と enum は問題ありません。可変な参照型のキー、または時間とともに変わる値ベースの等価性を持つキーは、静かに一致に失敗します。不変のキーを選んでください。

**`ServiceKey` 注入には正しい型が必要です。** `string` キーの下に登録して `[ServiceKey] int id` と宣言すると、構築は解決時にスローします。宣言したパラメーター型を、登録に使ったキーから代入可能なままにしてください。

**検証は登録ごとに実行され、キーごとではありません。** `ValidateOnBuild` が有効な場合（`WebApplication.CreateBuilder` 下の `Development` では既定）、呼び出し箇所の検証器は各キー付き登録のグラフを、キーなしのものと同様に検査します。シングルトンに捕捉されたキー付きの scoped サービスは依然として `Cannot consume scoped service from singleton` をスローします。キーを付けてもライフタイムの規則は免除されません。解決の失敗にぶつかった場合、メッセージはキーなしのケースと同じように読め、[unable to resolve service while attempting to activate の修正](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)がその読み方を解説しています。ただし、登録が存在するかを確認するときは、キー付きテーブルが別であることを忘れないでください。

**Native AOT とトリミングはサポートされています。** キー付きサービスは AOT に優しく設計されています。解決はあなたの型に対する実行時リフレクションに依存しないため、追加の `DynamicallyAccessedMembers` 注釈なしでトリミングを生き延びます。デプロイモデルを検討しているなら、[Native AOT vs ReadyToRun vs JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)のトレードオフは、グラフにキー付き登録があっても変更なく適用されます。

**すべてのサードパーティコンテナーがキーをサポートするわけではありません。** 組み込みコンテナーはサポートします。古いバージョンの Autofac、Lamar、DryIoc に差し替えている場合は、`[FromKeyedServices]` に依存する前にそのキー付きサービスのブリッジを確認してください。この機能は `Microsoft.Extensions.DependencyInjection.Abstractions` の契約であり、各コンテナーが実装しなければなりません。

## 完全な作例

エンドツーエンドの形を示します。名前でキー付けした 2 つのゲートウェイ、ルートから実行時に 1 つを選ぶルーター、そしてハンドラーに直接注入される既定のゲートウェイです。

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");
builder.Services.AddScoped<PaymentRouter>();

var app = builder.Build();

// Runtime selection: the provider name comes from the URL.
app.MapPost("/charge/{provider}",
    (string provider, decimal amount, PaymentRouter router)
        => router.ChargeAsync(provider, amount));

// Compile-time selection: this endpoint always uses Stripe.
app.MapPost("/charge-stripe",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));

app.Run();

public interface IPaymentGateway { Task<string> ChargeAsync(decimal amount); }

public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string key, decimal amount)
    {
        var gateway = services.GetKeyedService<IPaymentGateway>(key)
            ?? throw new ArgumentException($"Unknown gateway '{key}'", nameof(key));
        return gateway.ChargeAsync(amount);
    }
}
```

この分割は意図的です。`/charge/{provider}` エンドポイントはキーがデータであるため `IServiceProvider` を必要とし、`/charge-stripe` はキーが定数であるため属性を使います。キーがコンパイル時に既知ならいつでも `[FromKeyedServices]` に手を伸ばし、本当に分からないときにのみ `GetKeyedService`/`GetRequiredKeyedService` に戻ってください。

## キー付きサービスが次に収まる場所

キー付き DI は、1 つの契約に構成またはリクエストごとに選択される複数の実際の実装があるときに正しいツールです。単一の実装、options パターンでより適切に扱える横断的関心事、あるいは独自のファクトリー抽象に値するほど複雑な選択ロジックには、間違ったツールです。これに手を伸ばすときは、キーを不変に保ち、意図した解決パスごとに 1 回登録し、キー付きとキーなしのテーブルは決して互いを見ないことを忘れないでください。

隣接するパターンについて。エンドポイントがどこから依存関係を得るかを決めることは、より大きな [minimal API vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)の選択の一部であり、キー付きの登録は、1 つのインターフェースの背後に名前付きのキャッシュインスタンスが欲しいときに [ASP.NET Core 11 の HybridCache](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)とよく組み合わさります。

## 出典

- [Dependency injection in .NET - keyed services](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services), MS Learn。
- [`ServiceCollectionServiceExtensions` keyed methods](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicecollectionserviceextensions), .NET API リファレンス。
- [`FromKeyedServicesAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.fromkeyedservicesattribute) と [`ServiceKeyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicekeyattribute), .NET API リファレンス。
- [`IKeyedServiceProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.ikeyedserviceprovider) と [`KeyedService.AnyKey`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.keyedservice.anykey), .NET API リファレンス。
