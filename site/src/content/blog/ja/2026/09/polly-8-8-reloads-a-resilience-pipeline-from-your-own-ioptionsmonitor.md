---
title: "Polly 8.8 は独自の IOptionsMonitor からレジリエンスパイプラインをリロードできます"
description: "Polly 8.8.0 で EnableReloadsWithMonitor が追加され、DI に登録されていない機能フラグやリモート設定のモニターからレジリエンスパイプラインをホットリロードできるようになりました。検証コードで再構築の様子を示すとともに、落とし穴を 1 つ紹介します。context.GetOptions は引き続き DI のモニターを読むため、既定値が返されます。"
pubDate: 2026-09-18
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "configuration"
lang: "ja"
translationOf: "2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor"
translatedBy: "claude"
translationDate: 2026-09-18
---

[Polly 8.8.0](https://github.com/App-vNext/Polly/releases/tag/8.8.0) は 2026-09-14 にリリースされました。目玉の変更は小さなものですが、`Polly.Extensions` の実際の穴を埋めています。これまで、DI に登録したレジリエンスパイプラインをホットリロードする唯一の方法は `context.EnableReloads<TOptions>()` で、これはコンテナーから `IOptionsMonitor<TOptions>` を解決します。リトライ回数やタイムアウトが機能フラグの SDK、リモート設定クライアント、あるいは自作のモニターから来る場合は、先にそれを DI に登録するか、リロードをあきらめるしかありませんでした。

## 新しいオーバーロード

[PR #3140](https://github.com/App-vNext/Polly/pull/3140) は `AddResiliencePipelineContext<TKey>` に `EnableReloadsWithMonitor<TOptions>(IOptionsMonitor<TOptions> monitor, string? name = null)` を追加します。従来の `EnableReloads<TOptions>()` は、DI からモニターを解決して新しいメソッドを呼ぶだけの 1 行になりました。どちらも行き着く先は同じです。レジストリーが `monitor.OnChange` を購読し、それが発火したときにパイプラインを再構築します。

以下は、フラグサービスの代わりに手書きのモニターを使った最小構成の例です。

```csharp
var flags = new FlagMonitor<RetryFlags>(new RetryFlags { MaxRetries = 1 });

services.AddResiliencePipeline("orders", (builder, context) =>
{
    context.EnableReloadsWithMonitor(flags);

    var opts = flags.CurrentValue;
    builder.AddRetry(new() { MaxRetryAttempts = opts.MaxRetries, Delay = TimeSpan.Zero });
});

public sealed class FlagMonitor<T>(T initial) : IOptionsMonitor<T>
{
    private readonly List<Action<T, string?>> _listeners = [];
    public T CurrentValue { get; private set; } = initial;
    public T Get(string? name) => CurrentValue;

    public IDisposable OnChange(Action<T, string?> listener)
    {
        _listeners.Add(listener);
        return new Unsub(() => _listeners.Remove(listener));
    }

    public void Set(T value)
    {
        CurrentValue = value;
        foreach (var l in _listeners.ToArray()) l(value, Options.DefaultName);
    }

    private sealed class Unsub(Action a) : IDisposable { public void Dispose() => a(); }
}
```

これを SDK 10.0.302 上のファイルベースアプリとして、`Polly.Extensions` 8.8.0 に対して実行しました。パイプラインは常に例外をスローするため、試行回数を見れば有効なリトライ設定がわかります。

```text
building pipeline with MaxRetries=1
attempts: 2
building pipeline with MaxRetries=4
attempts after change: 5
same instance: True
```

`flags.Set(...)` の後、構成コールバックが再実行され、次の呼び出しでは 5 回試行されました。`GetPipeline("orders")` から取得した `ResiliencePipeline` は同じオブジェクトのままです。Polly はその背後にある内部パイプラインを差し替えるので、パイプラインをフィールドにキャッシュしているコードも、取得し直すことなく変更を反映します。8.7.0 では同じファイルが CS1061 で失敗します。そこにはこのメソッドが存在しないためです。

## GetOptions の落とし穴

構成コールバックには `context.GetOptions<TOptions>()` もあり、新しいメソッドと並べて使いたくなります。使わないでください。`GetOptions` は引き続きコンテナーから `IOptionsMonitor<TOptions>` を解決します。そして `AddResiliencePipeline` がオプションの基盤を登録しているため、例外はスローされません。代わりに既定のコンストラクターで生成されたインスタンスが返されます。検証では、カスタムモニターが `1`、続いて `4` を示していたのに対し、`context.GetOptions<RetryFlags>().MaxRetries` はどちらのビルドでも `0` を返しました。その値から構築したパイプラインは、黙ってリトライしなくなっていたはずです。

独自のモニターを渡す場合は、コールバック内でも同じモニターから値を読んでください (`flags.CurrentValue` または `flags.Get(name)`)。

## 8.8.0 のその他の変更

[PR #3220](https://github.com/App-vNext/Polly/pull/3220) は Simmy のバグを修正します。空の `FaultGenerator`、または重みの合計が 0 になるものは、何も注入しない代わりに `InvalidOperationException: Nullable object must have a value` をスローしていました。現在はジェネレーターが `null` を返し、カオス戦略は呼び出しをそのまま通します。このリリースには ".NET 11 preparation" の作業や、テストスイートの xunit v3 への移行も含まれています。

そもそも Polly のパイプラインと `Microsoft.Extensions.Http.Resilience` のハンドラーのどちらを使うべきかをまだ決めかねている場合は、[.NET 11 における Polly とレジリエンスハンドラーの比較](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) でトレードオフを解説しています。
