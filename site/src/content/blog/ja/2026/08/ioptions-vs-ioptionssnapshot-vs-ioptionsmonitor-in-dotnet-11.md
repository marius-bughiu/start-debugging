---
title: ".NET 11 における IOptions<T> と IOptionsSnapshot<T> と IOptionsMonitor<T> の違い"
description: "既定では IOptions<T> を使ってください。シングルトンが設定のリロードを見る必要がある場合は IOptionsMonitor<T> を、スコープ付きの利用側が 1 リクエストの間だけ安定した値を必要とする場合にのみ IOptionsSnapshot<T> を選びます。判断軸は設定の形ではなく、利用側のライフタイムです。"
pubDate: 2026-08-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-01
---

明確な理由がない限り `IOptions<T>` を注入してください。これはシングルトンであり、設定クラスをプロセスの生存期間中にちょうど 1 回だけバインドし、3 つの中で解決コストが最も小さいものです。長時間動作するサービスが再起動なしに設定変更を観測する必要がある場合は `IOptionsMonitor<T>` を、そして `IOptionsSnapshot<T>` は 1 つの限られたケース、つまり単一のリクエストの間は安定していてリクエスト間では異なってよい値を必要とするスコープ付きまたは一時的な利用側の場合にのみ選びます。これを決める軸は、注入される設定の形ではなく、注入する側のクラスのライフタイムです。以下の内容はすべて .NET 11 (Preview 6、SDK `11.0.100-preview.6.26359.118` で検証) と C# 14、`Microsoft.Extensions.Options` 11.0.0 を対象としています。これら 3 つのインターフェースは .NET Core 2.0 以来この動作なので、すべて .NET 10 GA でもそのまま動きます。本当に新しいのは最後に触れる .NET 11 の検証まわりだけです。

## 機能マトリクス

| 機能 | `IOptions<T>` | `IOptionsSnapshot<T>` | `IOptionsMonitor<T>` |
| --- | --- | --- | --- |
| 具体的な実装 | `UnnamedOptionsManager<T>` | `OptionsManager<T>` | `OptionsMonitor<T>` |
| DI でのライフタイム | Singleton | **Scoped** | Singleton |
| シングルトンへ注入できるか | できる | できない、キャプティブ依存になる | できる |
| 設定のリロードを見るか | 一切見ない | 見る、次のスコープから | 見る、即座に |
| 名前付きオプション | 非対応 | 対応、`Get(name)` | 対応、`Get(name)` |
| 変更コールバック | なし | なし | あり、`OnChange` |
| 値へのアクセス | `.Value` | `.Value`、`.Get(name)` | `.CurrentValue`、`.Get(name)` |
| バインダーが動く頻度 | プロセスごとに 1 回 | スコープごと、名前ごとに 1 回 | 変更ごと、名前ごとに 1 回 |
| インスタンスのキャッシュ先 | シングルトンのフィールド | スコープ付きマネージャー内の `OptionsCache<T>` | シングルトンの `IOptionsMonitorCache<T>` |

重要なのは主に 2 行です。ライフタイムの行は起動時の例外を生み、「バインダーが動く頻度」の行はホットパスでの予想外の CPU 使用を生みます。それ以外はこの 2 行から導かれます。

3 つとも `AddOptions()` が登録し、これはホストが呼び出してくれます。[OptionsServiceCollectionExtensions](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs) より:

```csharp
// Microsoft.Extensions.Options 11.0.0 -- what AddOptions() actually registers
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptions<>), typeof(UnnamedOptionsManager<>)));
services.TryAdd(ServiceDescriptor.Scoped(typeof(IOptionsSnapshot<>), typeof(OptionsManager<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitor<>), typeof(OptionsMonitor<>)));
services.TryAdd(ServiceDescriptor.Transient(typeof(IOptionsFactory<>), typeof(OptionsFactory<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitorCache<>), typeof(OptionsCache<>)));
```

`IOptionsFactory<T>` が transient で、実際の作業を担っている点に注目してください。登録されたすべての `IConfigureOptions<T>` を順に実行し、続いてすべての `IPostConfigureOptions<T>` を実行し、その後に検証を行います。3 つのアクセサー用インターフェースは、このファクトリーの出力をどれだけ積極的にキャッシュするかだけが異なります。話はそれだけであり、だからこそ選択はライフタイムの問題になるのです。

設定クラスと登録コードは 3 つとも同一です:

```csharp
// .NET 11, C# 14
public sealed class PaymentOptions
{
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
}

// Program.cs
builder.Services.Configure<PaymentOptions>(
    builder.Configuration.GetSection("Payment"));
```

## IOptions を選ぶべき場面

これを既定にしてください。リロード対応を諦めることになりますが、ほとんどのサービスではそれは実質的な損失ではありません。

- **起動時に読むものすべて。** 接続文字列、ベース URL、キュー名、変更するなら再デプロイするような機能フラグなどです。`IOptions<T>` はシングルトンなので、シングルトンにもスコープ付きサービスにも一時的なサービスにも同じように注入できます。設定を配線している最中に `Cannot consume scoped service` エラーが出た場合、`IOptions<T>` は原因ではなく解決策であることがほとんどです。[この例外が起きる理由と解きほぐし方](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)を参照してください。
- **ホットパス。** `UnnamedOptionsManager<T>` はバインド済みインスタンスをフィールドにキャッシュします。初回アクセス以降、`.Value` はフィールドの読み取りです。ディクショナリ検索も名前比較もアロケーションもありません。
- **コンストラクターでの取り込みが安全。** 値が変わることはないため、コンストラクター内の `options.Value` は潜在的なバグではなく正しい書き方です。

```csharp
// .NET 11, C# 14
public sealed class PaymentClient(IOptions<PaymentOptions> options)
{
    // Safe: the value is fixed for the life of the process.
    private readonly PaymentOptions _settings = options.Value;

    public TimeSpan Timeout => TimeSpan.FromSeconds(_settings.TimeoutSeconds);
}
```

`IOptions<T>` の代償はちょうど 1 つ、名前付きオプションに対応していないことです。そのため `Configure<Features>("Personalize", ...)` は見えません。同じクラスの構成が 2 つ必要なら、その時点で `IOptions<T>` は選択肢から外れています。それはまた、実際にモデル化したいものに対して名前付きオプションより [.NET 11 の依存性注入におけるキー付きサービス](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)のほうが適しているかを確認すべきタイミングでもあります。

## IOptionsSnapshot を選ぶべき場面

**スコープ付き**の利用側が、1 つの作業単位の中では一貫していて、作業単位をまたぐと変わってよい値を必要とする場合に使ってください。

- **リクエストの途中でずれてはいけないリクエスト単位の値。** コントローラーとそこから呼ばれる 3 つのサービスは同じスコープ付き `OptionsManager<T>` インスタンスを解決するため、リクエストの途中で `appsettings.json` が書き換えられても 4 者は同一の `PaymentOptions` インスタンスを見ます。`IOptionsMonitor<T>` はそのような保証をしません。同じリクエスト内の 2 回の `CurrentValue` 読み取りが異なるインスタンスを返すことがあります。
- **スコープ付きの利用側での名前付きオプション。** `Get(name)` に対応しており、スコープごとの `OptionsCache<T>` によってリクエスト内の 2 回目の `Get("Personalize")` はキャッシュヒットになります。

```csharp
// .NET 11, C# 14 -- scoped service, values stable for this request
public sealed class CheckoutService(IOptionsSnapshot<PaymentOptions> snapshot)
{
    private readonly PaymentOptions _settings = snapshot.Value;

    public string Key => _settings.ApiKey;
}
```

厳しい制限が 2 つあります。1 つ目に、`IOptionsSnapshot<T>` は `Scoped` として登録されているため、シングルトンへの注入は失敗します。シングルトンである `IHostedService` や `BackgroundService` への注入も同様です。ホストは Development 環境で `ValidateScopes` と `ValidateOnBuild` を有効にするため、そこでは起動時に明確な `Cannot consume scoped service` が出ます。Development 以外ではこれらのチェックは既定で無効であり、同じコードが、黙って一度も更新されないキャプティブ依存を解決してしまいます。失敗を大きな音で知りたいなら、すべての環境でスコープ検証を有効にしてください。回避策は [BackgroundService の内側でスコープを作る](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)ことですが、欲しかったのが新しい値だけなら `IOptionsMonitor<T>` のほうが単純な答えです。2 つ目に、コンソールアプリや素の `IHost` では自分で作らない限り周囲にスコープが存在しないため、Web ホスト以外での `IOptionsSnapshot<T>` は、ほぼ確実に本当は `IOptionsMonitor<T>` が欲しかったということを意味します。

## IOptionsMonitor を選ぶべき場面

**シングルトン**が変更を見る必要がある場合、あるいはコールバックが必要な場合に使ってください。

- **新しい値を取り込むために再起動できないシングルトン。** レート制限、キャッシュポリシー、サンプリング率、ログレベルなどです。
- **読むだけでなく反応する必要がある。** 3 つのうちプッシュ通知があるのは `OnChange` だけです。
- **選択的な無効化。** `IOptionsMonitorCache<T>.TryRemove(name)` は 1 つの名前付きインスタンスだけを次回アクセス時に再構築させます。値が古くなったことをファイル監視ではなく自分のコードが知っている場合に便利です。

`OptionsMonitor<T>` は登録されたすべての `IOptionsChangeTokenSource<T>` を購読します。どれかが発火すると `InvokeChanged` が `_cache.TryRemove(name)` を実行し、すぐに `TOptions options = Get(name)` で再構築し、その新しいインスタンスでリスナーを呼び出します。`CurrentValue` は `Get(Options.DefaultName)` の薄いラッパーであり、その中身は `_cache.GetOrAdd(localName, () => localFactory.Create(localName))` です。

```csharp
// .NET 11, C# 14 -- singleton, always current
public sealed class RateLimiter : IDisposable
{
    private readonly IDisposable? _subscription;
    private volatile PaymentOptions _current;

    public RateLimiter(IOptionsMonitor<PaymentOptions> monitor)
    {
        _current = monitor.CurrentValue;
        _subscription = monitor.OnChange(updated => _current = updated);
    }

    public int TimeoutSeconds => _current.TimeoutSeconds;

    public void Dispose() => _subscription?.Dispose();
}
```

この `IDisposable` は重要です。`OnChange` は `ChangeTrackerDisposable` を返し、その `Dispose` は `_monitor._onChange -= OnChange` を実行します。スコープ付きまたは一時的なサービスからコールバックを登録して戻り値を捨てると、リクエストごとにシングルトンのマルチキャストデリゲートへリスナーが追加され、二度と外れません。結果としてゆっくりとしたメモリリークとコールバックの嵐が起き、これは `IOptionsMonitor<T>` の使い方が壊れる最も一般的なパターンの 1 つです。

変更通知が存在するのは `Microsoft.Extensions.Configuration.Json`、`.Ini`、`.Xml`、`.KeyPerFile`、`.UserSecrets` のようなファイルシステムベースの構成プロバイダーだけであり、しかもプロバイダーが `reloadOnChange: true` で追加された場合に限られます。環境変数プロバイダーやコマンドラインプロバイダーは決して発火しないため、それらのソースの上では `IOptionsMonitor<T>` は、少し高価な `IOptions<T>` へと静かに退化します。

## 意味のある計測はナノ秒の数値ではなく回数

ここでは意図的に ns/op の数値を出しません。3 つの解決コストは、あなた自身の `IConfigureOptions<T>` デリゲートと検証処理が何をするかに支配されるため、私のマシンの数値はあなたのマシンについて何も語らないからです。移植可能な数値は**バインダーが何回動くか**であり、これは 15 行ほどで計測できます。

```csharp
// .NET 11 Preview 6, C# 14 -- counts how often the options are actually built
public sealed class CountingConfigure : IConfigureOptions<PaymentOptions>
{
    public static int Count;
    public void Configure(PaymentOptions options) => Interlocked.Increment(ref Count);
}

builder.Services.AddSingleton<IConfigureOptions<PaymentOptions>, CountingConfigure>();

app.MapGet("/probe", (
    IOptions<PaymentOptions> o,
    IOptionsSnapshot<PaymentOptions> s,
    IOptionsMonitor<PaymentOptions> m) =>
{
    _ = o.Value; _ = s.Value; _ = m.CurrentValue;
    return CountingConfigure.Count;
});
```

`/probe` を繰り返し叩くとカウンターはリクエストごとにちょうど 1 ずつ増え、その 1 は `IOptionsSnapshot<T>` によるものです。`IOptions<T>` は最初のリクエストでのみ寄与し、`IOptionsMonitor<T>` は最初のリクエストとその後はリロードごとに 1 回寄与し、`IOptionsSnapshot<T>` はすべてのリクエストで寄与します。新しいスコープは空の `OptionsCache<T>` を持つ新しい `OptionsManager<T>` を意味するからです。この登録に `.ValidateDataAnnotations()` を加えると、検証処理も毎リクエスト再実行されます。毎秒 5,000 リクエストを処理するエンドポイントなら、ほぼ変わらない値のために毎秒 5,000 回の再バインドと 5,000 回の検証が走ることになります。これが `IOptionsSnapshot<T>` を既定にすべきでない具体的な理由であり、グラフを鵜呑みにするのではなく自分のアプリで検証できる主張です。

## 判断を決めてしまう落とし穴

**`OnChange` は気にしていない設定でも発火します。** コールバックはあなたのセクションではなく、構成ルートの変更トークンに結び付いています。`IConfiguration` のどこかへの書き込みが 1 つあるだけで、アプリ内のすべての `IOptionsMonitor<T>` リスナーが呼ばれます。.NET チームはこれを [dotnet/runtime#109445](https://github.com/dotnet/runtime/issues/109445) として記録し、対応予定なしとしてクローズしたため、この挙動は恒久的です。構成のどこかが変わる限り、すべての `IOptionsMonitor` インスタンスが自身のコールバックを発火させ得ます。コールバックが高価なリソースを再構築するなら、直前の値をキャッシュして比較してから動いてください。

**`OnChange` は 1 回の保存でも複数回発火します。** エディターはファイルを複数の操作に分けて書き込み、その下にある `IFileProvider.Watch` はそのそれぞれを報告します。そのため 1 回の `Ctrl+S` で 2 回、ときにはそれ以上のコールバックが起きるのが普通です。これは [dotnet/aspnetcore#2542](https://github.com/dotnet/aspnetcore/issues/2542) であり、オプションのスタックのバグではなくファイル監視の副作用です。コールバックを冪等にするか、デバウンスしてください。

**ファイル監視は Docker のボリュームやネットワーク共有では信頼できません。** 代わりにポーリングさせるには `DOTNET_USE_POLLING_FILE_WATCHER=1` を設定します。ポーリング間隔は 4 秒で、設定変更はできません。反映の速さを当てにしていた場合、これは現実的な制約になります。

**`IOptions<T>` の「ずっと」は本当にずっとです。** 値は `.Value` が最初に読まれたときにバインドされ、プロセスの生存期間中キャッシュされます。チームの理解が「設定オブジェクトは更新される」であれば、障害対応中に設定を反映させても何も起きず、`IOptions<T>` が壊れているように見えます。これは設定クラスごとに決めて、文書に残してください。

**スコープ付きサービスでオプションを構成するのは、どのアクセサーを使っていても罠です。** `IOptions<T>` の場合、`IConfigureOptions<T>` はルートプロバイダー経由で解決されるため、構成デリゲートに注入したスコープ付き依存はキャプティブ依存になります。代わりに `IServiceProvider` を解決して `Configure` の内側でスコープを作り、そのスコープはリクエストのスコープではないことを覚えておいてください。

## .NET 11 で加わったもの

知っておく価値があるのは 2 つで、いずれもアクセサー層ではなく検証層の話です。

`OptionsBuilder<TOptions>` に、デリゲートではなく型パラメーターを受け取るジェネリックな `Validate` オーバーロードが加わりました。その型は `IValidateOptions<TOptions>` を実装し、DI コンテナーに登録されている必要があります。これによりオプション検証が通常の DI パターンに揃います:

```csharp
// .NET 11, C# 14
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

`System.ComponentModel.DataAnnotations` も .NET 11 で非同期検証に対応し、`AsyncValidationAttribute`、`IAsyncValidatableObject`、`Validator.ValidateObjectAsync` が使えるようになりました。`Microsoft.Extensions.Options` は新しい `IAsyncStartupValidator` を通じてこれを取り込むため、妥当性がネットワーク呼び出しに依存するオプションでも、初回利用時ではなく起動時にアプリを失敗させられます。どちらの変更も、どのアクセサーを注入すべきかには影響しません。ただし両方とも、`ValidateOnStart` を .NET 10 のときより強い既定にします。

## 改めて推奨

すべての設定クラスは `IOptions<T>` から始めてください。特定のシングルトンに変更を観測する明文化された必要がある場合に `IOptionsMonitor<T>` へ移り、`OnChange` の購読は破棄してください。`IOptionsSnapshot<T>` は、実際に変化する値についてスコープ付きの利用側がリクエスト単位の安定性を必要とする場合にだけ使い、その代償として毎リクエストで完全な再バインドと再検証を支払っていることを受け入れてください。コンパイルエラーが消えたからという理由で `IOptionsSnapshot<T>` に手を伸ばしているなら、それはライフタイムの問題をパフォーマンスの問題で解決したということです。

## 関連記事

- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [ASP.NET Core 11 の BackgroundService でスコープ付きサービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [.NET 11 の依存性注入でキー付きサービスを登録して解決する方法](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [Fix: No connection string named 'DefaultConnection' could be found](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)
- [ASP.NET Core 11 で WebApplicationFactory を使って統合テストを書く方法](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)

## 参考資料

- [.NET のオプションパターン](https://learn.microsoft.com/en-us/dotnet/core/extensions/options)、Microsoft Learn
- [.NET 11 ライブラリの新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries)、Microsoft Learn
- [OptionsServiceCollectionExtensions.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs)、dotnet/runtime
- [OptionsMonitor.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsMonitor.cs)、dotnet/runtime
- [IOptionsMonitor OnChange は IConfiguration で何かが変わるたびに発火する](https://github.com/dotnet/runtime/issues/109445)、dotnet/runtime issue 109445
- [ChangeToken.OnChange は構成変更を購読すると 2 回発火する](https://github.com/dotnet/aspnetcore/issues/2542)、dotnet/aspnetcore issue 2542
- [オプション構成でスコープ付きサービスを使うことの危険と落とし穴](https://andrewlock.net/the-dangers-and-gotchas-of-using-scoped-services-when-configuring-options-in-asp-net-core/)、Andrew Lock
