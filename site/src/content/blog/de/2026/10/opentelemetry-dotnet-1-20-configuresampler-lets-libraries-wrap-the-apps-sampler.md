---
title: "OpenTelemetry .NET 1.20: ConfigureSampler lässt Bibliotheken den Sampler der App umschließen"
description: "OpenTelemetry .NET 1.20.0, veröffentlicht am 15. Oktober 2026, ergänzt TracerProviderBuilder.ConfigureSampler. Eine Bibliothek kann nun den Sampler umschließen, den das SDK aus SetSampler, OTEL_TRACES_SAMPLER oder dem Standard ermittelt hat, statt ihn stillschweigend zu überschreiben."
pubDate: 2026-10-19
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "tracing"
lang: "de"
translationOf: "2026/10/opentelemetry-dotnet-1-20-configuresampler-lets-libraries-wrap-the-apps-sampler"
translatedBy: "claude"
translationDate: 2026-10-19
---

[OpenTelemetry .NET 1.20.0](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.20.0) wurde am 15. Oktober 2026 veröffentlicht. Der größte Teil des Changelogs besteht aus Fehlerbehebungen (ein Refcount-Leck in `SuppressInstrumentationScope`, `ResourceBuilder.CreateDefault` ignorierte `OTEL_SERVICE_NAME`, zwei Race Conditions bei Metriken), aber eine neue API ändert, wie Bibliotheken und Distros das Sampling anfassen sollten: `TracerProviderBuilder.ConfigureSampler`.

## SetSampler war immer "der Letzte gewinnt"

Bis 1.19.x war `SetSampler` die einzige Möglichkeit, den Trace-Sampler zu beeinflussen. Ein programmatisch gesetzter Sampler hat Vorrang vor der Umgebungsvariablen `OTEL_TRACES_SAMPLER`, und diese wiederum vor dem Standard `ParentBased(AlwaysOnSampler)`. Diese Rangfolge ist für Anwendungscode in Ordnung, für Bibliotheken aber feindlich. Ein Paket, das seine eigenen störenden Spans verwerfen wollte, musste `SetSampler` aufrufen, und in dem Moment wurde das `OTEL_TRACES_SAMPLER=traceidratio` des Betreibers als ignoriert protokolliert und verworfen. Zwei Bibliotheken, die dasselbe taten, gerieten stillschweigend in Konflikt: Wer sich zuletzt registrierte, gewann.

## Was ConfigureSampler macht

[PR #7780](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7780) ergänzt einen Callback, der den bereits vom SDK ermittelten Sampler erhält und den zu verwendenden zurückgibt:

```csharp
public static TracerProviderBuilder ConfigureSampler(
    this TracerProviderBuilder tracerProviderBuilder,
    Func<IServiceProvider, Sampler, Sampler> configureSampler);
```

Die Regeln laut XML-Dokumentation:

- Callbacks laufen, nachdem das SDK einen Sampler aus `SetSampler`, `OTEL_TRACES_SAMPLER` oder dem Standard gewählt hat, unabhängig davon, ob sie vor oder nach `SetSampler` registriert wurden.
- Jeder Callback läuft einmal, während `Build()`. Der Sampler des Providers bleibt danach unveränderlich.
- Mehrere Callbacks werden in der Reihenfolge ihrer Registrierung verkettet, und jeder erhält das Ergebnis des vorherigen.
- Die Rückgabe von `null` oder eine ausgelöste Ausnahme lässt den Build des Providers fehlschlagen.

Eine Bibliothek kann also den von der App konfigurierten Sampler dekorieren, statt ihn zu ersetzen:

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

Mit gesetztem `OTEL_TRACES_SAMPLER=traceidratio` und `OTEL_TRACES_SAMPLER_ARG=0.1` erfasst die App weiterhin 10% der Traces, und die Bibliothek verwirft lediglich ihre Poll-Spans vor dieser Entscheidung. Ersetzen Sie die Umgebungsvariable durch ein explizites `SetSampler(new AlwaysOnSampler())` in `Program.cs`, und der Wrapper übernimmt auch das, ohne Spiele mit der Reihenfolge.

## Der Haken bei der Freigabe

Der Provider gibt nur den finalen Sampler frei (Dispose). Wenn Ihr Callback den erhaltenen Sampler verwirft oder umschließt, liegt die Lebensdauer des inneren Samplers in Ihrer Verantwortung. Bei zustandslosen Samplern wie `TraceIdRatioBasedSampler` spielt das keine Rolle. Bei allem, was einen Timer oder eine Verbindung zu einer Remote-Konfiguration hält, sollten Sie `Dispose` von Ihrem Wrapper aus weiterreichen.

## Wer umsteigen sollte

Wenn Sie eine Bibliothek oder eine interne Distro pflegen, die heute `SetSampler` aufruft, wechseln Sie zu `ConfigureSampler`, damit Sie die Konfiguration des Betreibers nicht mehr überschreiben. Anwendungscode kann weiterhin `SetSampler` verwenden, denn es hat nach wie vor den Platz mit der höchsten Priorität. Der PR versteht sich außerdem als Grundlage für ferngesteuertes Sampling und deklarative Konfiguration, bei denen die Wahl des Samplers vollständig aus dem Code verschwindet.

Aktualisieren Sie die Kernpakete gemeinsam, da sie im Gleichschritt versioniert werden:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.20.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.20.0
```

Falls Sie den vorherigen Patch übersprungen haben: Der [Fix für den Wildcard-Regex in 1.19.1](/de/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/) ist ebenfalls enthalten.
