---
title: "Polly 8.8 lädt eine Resilience-Pipeline aus Ihrem eigenen IOptionsMonitor neu"
description: "Polly 8.8.0 bringt EnableReloadsWithMonitor, sodass eine Resilience-Pipeline aus einem Feature Flag oder einem Remote-Config-Monitor neu geladen werden kann, der nicht in DI registriert ist. Ein Test zeigt den Neuaufbau, und es gibt eine Falle: context.GetOptions liest weiterhin den DI-Monitor und liefert Standardwerte."
pubDate: 2026-09-18
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "configuration"
lang: "de"
translationOf: "2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor"
translatedBy: "claude"
translationDate: 2026-09-18
---

[Polly 8.8.0](https://github.com/App-vNext/Polly/releases/tag/8.8.0) ist am 2026-09-14 erschienen, und die wichtigste Änderung ist klein, schließt aber eine echte Lücke in `Polly.Extensions`. Bisher gab es nur einen Weg, eine in DI registrierte Resilience-Pipeline im laufenden Betrieb neu zu laden: `context.EnableReloads<TOptions>()`, das `IOptionsMonitor<TOptions>` aus dem Container auflöst. Kamen Ihre Retry-Anzahl oder Timeouts aus einem Feature-Flag-SDK, einem Remote-Config-Client oder einem selbst gebauten Monitor, mussten Sie diesen zuerst in DI registrieren oder auf das Neuladen verzichten.

## Die neue Überladung

[PR #3140](https://github.com/App-vNext/Polly/pull/3140) ergänzt `EnableReloadsWithMonitor<TOptions>(IOptionsMonitor<TOptions> monitor, string? name = null)` auf `AddResiliencePipelineContext<TKey>`. Das alte `EnableReloads<TOptions>()` ist jetzt ein Einzeiler, der den Monitor aus DI auflöst und die neue Methode aufruft. Beide landen an derselben Stelle: Die Registry abonniert `monitor.OnChange` und baut die Pipeline neu auf, sobald das Ereignis auslöst.

Hier eine minimale Version mit einem handgeschriebenen Monitor als Ersatz für einen Flag-Dienst:

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

Ich habe das als dateibasierte App mit SDK 10.0.302 gegen `Polly.Extensions` 8.8.0 ausgeführt. Die Pipeline wirft immer eine Exception, daher zeigt die Anzahl der Versuche, welche Retry-Einstellung aktiv ist:

```text
building pipeline with MaxRetries=1
attempts: 2
building pipeline with MaxRetries=4
attempts after change: 5
same instance: True
```

Nach `flags.Set(...)` lief der Konfigurations-Callback erneut, und der nächste Aufruf machte fünf Versuche. Die `ResiliencePipeline`, die Sie von `GetPipeline("orders")` erhalten haben, ist weiterhin dasselbe Objekt. Polly tauscht die innere Pipeline dahinter aus, sodass Code, der die Pipeline in einem Feld zwischengespeichert hat, die Änderung übernimmt, ohne sie erneut anzufordern. Unter 8.7.0 scheitert dieselbe Datei mit CS1061, weil die Methode dort nicht existiert.

## Die GetOptions-Falle

Der Konfigurations-Callback bietet auch `context.GetOptions<TOptions>()`, und es ist verlockend, das neben der neuen Methode zu verwenden. Lassen Sie es. `GetOptions` löst `IOptionsMonitor<TOptions>` weiterhin aus dem Container auf, und `AddResiliencePipeline` registriert die Options-Infrastruktur, daher wird keine Exception geworfen. Sie erhalten eine Instanz mit Standardwerten. Im Test lieferte `context.GetOptions<RetryFlags>().MaxRetries` bei beiden Builds `0`, während der eigene Monitor `1` und dann `4` meldete. Eine aus diesem Wert gebaute Pipeline hätte stillschweigend aufgehört, Wiederholungen durchzuführen.

Wenn Sie Ihren eigenen Monitor übergeben, lesen Sie die Werte im Callback aus genau diesem Monitor (`flags.CurrentValue` oder `flags.Get(name)`).

## Außerdem in 8.8.0

[PR #3220](https://github.com/App-vNext/Polly/pull/3220) behebt einen Simmy-Fehler: Ein leerer `FaultGenerator` oder einer, dessen Gewichte sich zu null summieren, warf `InvalidOperationException: Nullable object must have a value`, statt einfach nichts zu injizieren. Der Generator gibt jetzt `null` zurück, und die Chaos-Strategie lässt den Aufruf durch. Das Release enthält außerdem Arbeiten zur "Vorbereitung auf .NET 11" und einen Wechsel auf xunit v3 in der Testsuite.

Falls Sie noch entscheiden müssen, ob Sie überhaupt Polly-Pipelines oder `Microsoft.Extensions.Http.Resilience`-Handler wollen, erklärt [Polly vs. Resilience-Handler in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) die Abwägung.
