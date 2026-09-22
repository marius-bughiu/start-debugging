---
title: "OpenTelemetry .NET 1.19.1 behebt die Wildcard-NotSupportedException unter net8.0"
description: "OpenTelemetry 1.19.0 hat seine Wildcard-Regex für Quellen auf RegexOptions.NonBacktracking umgestellt, was unter net8.0 ab einer gewissen Zahl registrierter Quellen eine Ausnahme wirft. 1.19.1, veröffentlicht am 2026-09-21, kehrt zu einer kompilierten Regex mit Match-Timeout zurück."
pubDate: 2026-09-22
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "dotnet-8"
lang: "de"
translationOf: "2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8"
translatedBy: "claude"
translationDate: 2026-09-22
---

[OpenTelemetry .NET 1.19.1](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.19.1) ist am 2026-09-21 erschienen, drei Tage nach 1.19.0. Es enthält genau eine nennenswerte Änderung, und wenn Ihre App `net8.0` als Ziel hat und eine lange Liste von Activity Sources oder Meters registriert, entscheidet diese Änderung zwischen einem funktionierenden `TracerProvider` und einem Absturz beim Start.

## Was 1.19.0 kaputt gemacht hat

Das SDK wandelt Ihre Namen aus `AddSource("...")` und `AddMeter("...")` in eine einzige Regex um, sobald mindestens einer davon `*` oder `?` enthält. [PR #7760](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7760), für 1.19.0 gemergt, hat diese Regex gehärtet, indem sie auf modernem .NET mit `RegexOptions.NonBacktracking` erstellt wird. Die Absicht war gut: kein katastrophales Backtracking, egal welches Muster in der Liste landet.

Das Problem: Die Non-Backtracking-Engine kompiliert das Muster in einen Automaten mit fester Größenobergrenze, und diese liegt unter .NET 8 bei 1.000 Knoten (10.000 ab .NET 9). Ein Alternationszweig pro Quelle summiert sich schnell. Die Grafana-OpenTelemetry-Distribution, die Dutzende Quellen vorab registriert, stieß sofort darauf, wie in [Issue #7787](https://github.com/open-telemetry/opentelemetry-dotnet/issues/7787) gemeldet:

```text
System.NotSupportedException : The specified pattern with RegexOptions.NonBacktracking
could result in an automata as large as '1285' nodes, which is larger than the configured
limit of '1000'.
   at OpenTelemetry.WildcardHelper.GetWildcardRegex(IEnumerable`1 patterns)
   at OpenTelemetry.Trace.TracerProviderSdk..ctor(IServiceProvider serviceProvider, Boolean ownsServiceProvider)
```

Beachten Sie den Auslöser: Eine einzige Wildcard irgendwo in der Liste zieht jeden Quellnamen in die Regex. Eine Konfiguration wie diese genügt unter `net8.0`, sobald die Liste lang genug ist:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddSource("MyCompany.Orders", "MyCompany.Billing", "MyCompany.Shipping")
        .AddSource(internalSourceNames)   // a few hundred names from config
        .AddSource("AWSSDK.*")            // one wildcard switches on regex mode
        .AddOtlpExporter());
```

Builds für `net9.0`, `net10.0` und .NET Framework waren von der Ausnahme nicht betroffen. Von den Kosten allerdings schon: Laut PR hält eine Non-Backtracking-`Regex` rund 35-mal mehr Speicher als eine mit Backtracking, sodass Testsuiten und Hosts, die über die Prozesslebensdauer viele Provider erstellen, in eine `OutOfMemoryException` laufen konnten.

## Was 1.19.1 stattdessen macht

[PR #7788](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7788) entfernt `NonBacktracking` für jedes Zielframework und kehrt zu einer kompilierten Regex zurück, wobei der Schutz über ein Match-Timeout erhalten bleibt:

```csharp
var pattern = "^(?:" + convertedPattern + ")$";

return new Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, RegexMatchTimeout);
// RegexMatchTimeout = TimeSpan.FromSeconds(1)
```

`WildcardHelper.IsMatch` fängt `RegexMatchTimeoutException` ab und gibt `false` zurück, sodass ein pathologisches Muster dazu führt, dass einer Quelle nicht zugehört wird, statt einen Thread hängen zu lassen. Dieselbe Änderung gilt für Wildcard-Instrumentnamen in `AddView`, die auf modernem .NET ebenfalls `NonBacktracking` verwendet haben.

## Aktualisieren

Heben Sie alle OpenTelemetry-Core-Pakete gemeinsam an, da sie im Gleichschritt versioniert werden:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.19.1
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

Wenn Sie auf 1.18.x sind, können Sie 1.19.0 komplett überspringen. Wenn Sie 1.19.0 bereits unter `net8.0` ausgerollt haben und keine Ausnahme aufgetreten ist, liegen Sie heute unter dem Knotenlimit, doch ein paar zusätzliche Quellen hätten es später beim Start ausgelöst. Aktualisieren Sie also trotzdem. Zur Auffrischung des gesamten Setups gilt meine Anleitung zur [Verwendung von OpenTelemetry mit .NET 11 und einem kostenlosen Backend](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) weiterhin unverändert.

Die allgemeine Lektion lohnt sich zu merken: `RegexOptions.NonBacktracking` ist kein kostenloser Sicherheitsschalter. Es tauscht das Backtracking-Risiko gegen ein Größenlimit des Automaten und einen höheren Speicherbedarf, und unter .NET 8 ist dieses Limit klein genug, um es mit einer gewöhnlichen Konfiguration zu erreichen.
