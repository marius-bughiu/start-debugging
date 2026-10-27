---
title: "Polly 8.8.1: Der Circuit Breaker hält die AsyncLocal-Werte des ersten Aufrufers nicht mehr am Leben"
description: "Polly.Core 8.8.1 startet die Hintergrundschleife des Circuit Breakers unter ExecutionContext.SuppressFlow, sodass eine langlebige Pipeline die AsyncLocal-Werte ihres Erstellers nicht mehr festhält. Ein 15-Zeilen-Repro zeigt das Leck in 8.8.0 und den Fix in 8.8.1."
pubDate: 2026-10-27
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "memory-leaks"
lang: "de"
translationOf: "2026/10/polly-8-8-1-circuit-breaker-no-longer-keeps-the-first-callers-asynclocal-values-alive"
translatedBy: "claude"
translationDate: 2026-10-27
---

[Polly 8.8.1](https://github.com/App-vNext/Polly/releases/tag/8.8.1) ist am 2026-10-26 erschienen, und der wichtigste Fix betrifft ein Speicherleck, das man leicht hat, ohne es zu merken. Jede Circuit-Breaker-Strategie, die mit Polly.Core 8.8.0 oder älter gebaut wurde, hielt den `ExecutionContext` des Codes, der sie gebaut hat, für die gesamte Lebensdauer der Pipeline am Leben. Dazu gehört jeder `AsyncLocal<T>`-Wert, der in diesem Moment gesetzt war.

## Warum ein Circuit Breaker Ihren Kontext eingefangen hat

Der Circuit Breaker nutzt einen internen `ScheduledTaskExecutor`, um seine Callbacks für Zustandswechsel (`OnOpened`, `OnClosed`, `OnHalfOpened`) abseits des Hot Paths auszuführen. Sein Konstruktor startete eine Verarbeitungsschleife mit `Task.Run(StartProcessingAsync)`. `Task.Run` gibt den aktuellen `ExecutionContext` standardmäßig weiter, und die Schleife wartet dann auf einem `SemaphoreSlim`, bis die Pipeline freigegeben wird.

Wer also zufällig den Build auslöste, vermachte seinen Umgebungszustand einem Task, der nie endet. Für eine Pipeline in einer `ResiliencePipelineRegistry` oder eine, die `Microsoft.Extensions.Http.Resilience` für einen benannten `HttpClient` baut, bedeutet "die Lebensdauer der Pipeline" die Lebensdauer der Anwendung. [Issue #3275](https://github.com/App-vNext/Polly/issues/3275) beschreibt den schlimmsten Fall: In einer Blazor-Server-App baut die Circuit des ersten Benutzers die Pipeline, ein `AsyncLocal`-basierter Accessor trägt die Services dieser Circuit, und die Circuit wird nach dem Verlassen durch den Benutzer nie eingesammelt.

## Reproduktion in einer dateibasierten App

Das läuft unverändert mit `dotnet run repro.cs` auf dem .NET 10 SDK. Zum Vergleich die Paketversion ändern:

```csharp
#:package Polly.Core@8.8.0
using System.Runtime.CompilerServices;
using Polly;

AsyncLocal<object?> current = new();

var (pipeline, value) = Build();
for (int i = 0; i < 3; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
GC.KeepAlive(pipeline);
Console.WriteLine($"alive: {value.IsAlive}");

[MethodImpl(MethodImplOptions.NoInlining)]
(ResiliencePipeline, WeakReference) Build()
{
    object payload = new byte[1024];
    current.Value = payload; // whatever the first caller's flow carries
    var p = new ResiliencePipelineBuilder().AddCircuitBreaker(new()).Build();
    current.Value = null;
    return (p, new WeakReference(payload));
}
```

Auf meinem Rechner (SDK 10.0.302) gibt `Polly.Core@8.8.0` `alive: True` aus und `Polly.Core@8.8.1` `alive: False`. Das `AsyncLocal` danach zu leeren hilft in 8.8.0 nicht, weil der Hintergrund-Task einen Snapshot des Kontexts vom Zeitpunkt seines Starts hält, keine Live-Ansicht.

## Der Fix

[PR #3284](https://github.com/App-vNext/Polly/pull/3284) umfasst drei Zeilen:

```csharp
public ScheduledTaskExecutor()
{
    using (ExecutionContext.SuppressFlow())
    {
        ProcessingTask = Task.Run(StartProcessingAsync);
    }
}
```

Eine Verhaltensänderung sollten Sie kennen: Ihre Callbacks für Zustandswechsel sehen die `AsyncLocal`-Werte des Pipeline-Erstellers nicht mehr. Die Werte der Anfrage, die den Breaker tatsächlich ausgelöst hat, haben sie ohnehin nie zuverlässig gesehen, nur die des Codes, der die Pipeline gebaut hat. Wer sich darauf verlassen hat, etwa beim Lesen von `Activity.Current` oder eines Tenant-Accessors in `OnOpened`, übergibt das Benötigte stattdessen über `ResilienceContext` oder die Callback-Argumente.

## Was zu tun ist

Aktualisieren Sie `Polly.Core` (und `Polly.Extensions`, falls direkt referenziert) auf 8.8.1. `Microsoft.Extensions.Http.Resilience` zieht Polly transitiv herein, also fügen Sie eine explizite Referenz hinzu, falls Ihre Lock-Datei noch auf 8.8.0 steht:

```xml
<PackageReference Include="Polly.Core" Version="8.8.1" />
```

Wenn ein Upgrade noch nicht möglich ist, lautet der Workaround aus dem Issue: die Pipelines beim Start vorab innerhalb von `ExecutionContext.SuppressFlow()` bauen, bevor irgendeine Anfrage diejenige sein kann, die sie baut.

Dasselbe Release beschleunigt außerdem die Pipeline-Ausführung ([#3287](https://github.com/App-vNext/Polly/pull/3287)) und schließt eine verwandte Aufräumlücke in der Registry ([#3288](https://github.com/App-vNext/Polly/pull/3288)): Wenn zwei Aufrufer gleichzeitig denselben Schlüssel initialisierten, wurde die unterlegene Pipeline verworfen, behielt aber ihre Ressourcen und Reload-Registrierungen. Jetzt durchläuft sie denselben asynchronen Freigabepfad wie Reloads, was relevant ist, wenn Sie [`EnableReloadsWithMonitor` aus Polly 8.8](/de/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/) einsetzen.
