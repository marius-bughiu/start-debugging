---
title: "OpenTelemetry .NET 1.20: ConfigureSampler でライブラリがアプリのサンプラーをラップできるようになりました"
description: "2026年10月15日にリリースされた OpenTelemetry .NET 1.20.0 で TracerProviderBuilder.ConfigureSampler が追加されました。ライブラリは、SetSampler、OTEL_TRACES_SAMPLER、またはデフォルトから SDK が解決したサンプラーを黙って上書きするのではなく、ラップできるようになります。"
pubDate: 2026-10-19
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "tracing"
lang: "ja"
translationOf: "2026/10/opentelemetry-dotnet-1-20-configuresampler-lets-libraries-wrap-the-apps-sampler"
translatedBy: "claude"
translationDate: 2026-10-19
---

[OpenTelemetry .NET 1.20.0](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.20.0) が2026年10月15日にリリースされました。変更履歴の大半は修正です(`SuppressInstrumentationScope` の参照カウントリーク、`ResourceBuilder.CreateDefault` が `OTEL_SERVICE_NAME` を無視する問題、2件のメトリクスの競合状態)が、新しい API が1つあり、ライブラリやディストリビューションがサンプリングを扱う方法が変わります。それが `TracerProviderBuilder.ConfigureSampler` です。

## SetSampler は常に最後の書き込みが勝つ方式でした

1.19.x までは、トレースサンプラーに影響を与える方法は `SetSampler` だけでした。プログラムで指定したサンプラーが `OTEL_TRACES_SAMPLER` 環境変数より優先され、環境変数がデフォルトの `ParentBased(AlwaysOnSampler)` より優先されます。この優先順位はアプリケーションコードには問題ありませんが、ライブラリにとっては扱いにくいものです。自分のノイズの多いスパンを破棄したいパッケージは `SetSampler` を呼ぶしかなく、呼んだ瞬間に、運用担当者が設定した `OTEL_TRACES_SAMPLER=traceidratio` は無視されたとログに記録され、破棄されていました。2つのライブラリが同じことをすると黙って衝突し、最後に登録されたほうが勝ちました。

## ConfigureSampler の動作

[PR #7780](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7780) は、SDK がすでに解決したサンプラーを受け取り、使用するサンプラーを返すコールバックを追加します。

```csharp
public static TracerProviderBuilder ConfigureSampler(
    this TracerProviderBuilder tracerProviderBuilder,
    Func<IServiceProvider, Sampler, Sampler> configureSampler);
```

XML ドキュメントに記載されているルールは次のとおりです。

- コールバックは、SDK が `SetSampler`、`OTEL_TRACES_SAMPLER`、またはデフォルトからサンプラーを選んだ後に実行されます。`SetSampler` の前に登録したか後に登録したかは関係ありません。
- 各コールバックは `Build()` の間に1回だけ実行されます。その後、プロバイダーのサンプラーは不変のままです。
- 複数のコールバックは登録順にチェーンされ、それぞれが直前の結果を受け取ります。
- `null` を返すか例外をスローすると、プロバイダーのビルドが失敗します。

これにより、ライブラリはアプリが構成したものを置き換えずに、装飾できます。

```csharp
public sealed class DropPollingSpansSampler(Sampler inner) : Sampler
{
    public override SamplingResult ShouldSample(in SamplingParameters parameters)
    {
        // The library's background poll loop creates a span every second.
        if (parameters.Name == "MyLibrary.Poll")
        {
            return new SamplingResult(SamplingDecision.Drop);
        }

        return inner.ShouldSample(parameters);
    }
}

public static class MyLibraryTracingExtensions
{
    public static TracerProviderBuilder AddMyLibrary(this TracerProviderBuilder builder) =>
        builder
            .AddSource("MyLibrary")
            .ConfigureSampler((_, resolved) => new DropPollingSpansSampler(resolved));
}
```

`OTEL_TRACES_SAMPLER=traceidratio` と `OTEL_TRACES_SAMPLER_ARG=0.1` を設定した場合、アプリは引き続きトレースの10%をサンプリングし、ライブラリはその判定の前段でポーリングのスパンだけを破棄します。環境変数の代わりに `Program.cs` で明示的に `SetSampler(new AlwaysOnSampler())` を指定しても、ラッパーはそれを同じように拾います。順序を気にする必要はありません。

## 破棄に関する注意点

プロバイダーが破棄するのは最終的なサンプラーだけです。コールバックが受け取ったサンプラーを捨てたり、ラップしたりする場合は、内側のサンプラーの寿命を自分で管理する必要があります。`TraceIdRatioBasedSampler` のようなステートレスなサンプラーでは問題になりません。タイマーやリモート設定への接続を保持しているものについては、ラッパーから `Dispose` を転送してください。

## 移行すべき人

現在 `SetSampler` を呼んでいるライブラリや社内ディストリビューションを保守しているなら、運用担当者の設定を上書きしないように `ConfigureSampler` へ移行してください。アプリケーションコードは引き続き `SetSampler` を使えます。最優先の枠は変わりません。この PR は、サンプラーの選択がコードの外に移るリモート制御のサンプリングや宣言的な構成に向けた土台としても位置付けています。

コアパッケージはバージョンが連動しているため、まとめてアップグレードしてください。

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.20.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.20.0
```

前回のパッチをスキップしていた場合も、[1.19.1 のワイルドカード正規表現の修正](/ja/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/)が含まれています。
