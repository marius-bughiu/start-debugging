---
title: "Aspire 13.5.4 verhindert, dass Kafka-Health-Checks bei jeder Prüfung einen Producer verlieren"
description: "Vor Aspire 13.5.4 erzeugte jeder AppHost-Health-Check für eine AddKafka-Ressource einen neuen Confluent-Producer, den niemand freigab. Polling-Threads stapelten sich, und der AppHost verbrannte CPU. Der Fix und die HealthCheckRegistration.Factory-Falle dahinter betreffen auch eigene Health Checks."
pubDate: 2026-09-21
tags:
  - "aspire"
  - "kafka"
  - "dotnet"
  - "health-checks"
  - "dependency-injection"
lang: "de"
translationOf: "2026/09/aspire-13-5-4-fixes-kafka-health-check-thread-leak"
translatedBy: "claude"
translationDate: 2026-09-21
---

[Aspire 13.5.4](https://github.com/microsoft/aspire/releases/tag/v13.5.4) ist am 2026-09-15 erschienen, und dieses Patch-Release lohnt sich, wenn Ihr AppHost `AddKafka` aufruft. Bis einschließlich 13.5.3 erzeugte der Kafka-Health-Check, den `Aspire.Hosting.Kafka` registriert, bei jeder Ausführung einen komplett neuen Confluent.Kafka-Producer und gab ihn nie frei. Jeder Producer startet einen eigenen Polling-Thread, sodass sich ein lange laufender AppHost langsam mit Threads füllte, die in `SafeKafkaHandle.Poll` hingen. Der Bericht in [Issue #20091](https://github.com/microsoft/aspire/issues/20091) zeigt einen AppHost unter macOS bei 350-400 % CPU, mit einem Thread-Sampling-Trace, in dem 1.901 von 1.934 gesampelten Threads in der Poll-Schleife von Kafka steckten.

Wer schon einmal `dotnet run` auf einem AppHost einen Nachmittag lang offen gelassen hat und sich über laute Lüfter wunderte, hat hier einen wahrscheinlichen Kandidaten.

## Woher die Producer kamen

Die Hosting-Integration baute ihren Check in einer `HealthCheckRegistration`-Factory:

```csharp
var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp =>
    {
        var options = new KafkaHealthCheckOptions();
        options.Configuration = new ProducerConfig();
        options.Configuration.BootstrapServers = connectionString
            ?? throw new InvalidOperationException("Connection string is unavailable");
        return new KafkaHealthCheck(options);
    },
    failureStatus: default,
    tags: default);
builder.Services.AddHealthChecks().Add(healthCheckRegistration);
```

`HealthCheckService` ruft diese Factory bei jedem Lauf des Checks auf. `KafkaHealthCheck` erzeugt den Producer verzögert und gibt ihn in `Dispose()` frei, aber das von der Factory zurückgegebene Objekt wurde mit `new` erzeugt und nicht aus dem Container aufgelöst. Der Health-Check-Runner öffnet und verwirft zwar pro Lauf einen DI-Scope, doch ein Scope gibt nur Instanzen frei, die er selbst erzeugt hat. Niemand rief jemals `Dispose()` auf dem Check auf, also hinterließ jede Prüfung einen weiteren Producer und einen weiteren Polling-Thread.

Der Code mied absichtlich `AddKafka(...)` aus dem Health-Check-Paket von Xabaril: Dieser Helper registriert ein Singleton, und bei zwei Kafka-Ressourcen würde die Factory den Connection String der zuletzt hinzugefügten Ressource lesen ([Xabaril #2298](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/issues/2298)). Der Workaround behob den Konfigurationsfehler und führte den Lebensdauerfehler ein.

## Der Fix: DI besitzt den Check

[PR #20092](https://github.com/microsoft/aspire/pull/20092), als #20094 nach 13.5.4 zurückportiert, registriert pro Kafka-Ressource ein Keyed Singleton und lässt die Factory es auflösen:

```csharp
builder.Services.AddKeyedSingleton<KafkaHealthCheck>(healthCheckKey, (sp, _) =>
{
    var options = new KafkaHealthCheckOptions();
    options.Configuration = new ProducerConfig();
    options.Configuration.BootstrapServers = connectionString
        ?? throw new InvalidOperationException("Connection string is unavailable");
    return new KafkaHealthCheck(options);
});

var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp => sp.GetRequiredKeyedService<KafkaHealthCheck>(healthCheckKey),
    failureStatus: default,
    tags: default);
```

Der Schlüssel `"{name}_check"` hält die Bootstrap-Server jeder Ressource getrennt, der Producer wird über Prüfungen hinweg wiederverwendet, und der Root-Container gibt ihn beim Herunterfahren des AppHost frei. Die Messung im PR gegen zwei echte Kafka-8.2.0-Broker: 84 Health-Check-Ausführungen ergaben unter 13.5.3 84 Check-Instanzen und 84 Polling-Threads, mit dem Fix 2 Instanzen und 2 Threads, und nach dem Dispose 0 verbleibende Threads.

## Aktualisieren

Heben Sie die Aspire-Pakete im AppHost-Projekt an:

```xml
<PackageReference Include="Aspire.Hosting.Kafka" Version="13.5.4" />
```

Am AppHost-Code ändert sich nichts, und es gibt keine Änderung an der öffentlichen API. Dasselbe Release behebt außerdem DevTunnel-Fehler bei automatisch gewählten Regionen (eine Regression aus 13.3), blendet die ungenutzte Ressource `azure-environment` in AppHosts mit ausschließlich Emulatoren aus und versieht `IAwsRadiusProviderBuilder` und `IAzureRadiusProviderBuilder` mit der experimentellen Diagnose `ASPIRERADIUS003`. Wer diese Interfaces direkt referenziert, kann dadurch eine neue Warning-as-Error sehen.

## Eigene Health Checks auf dasselbe Muster prüfen

Der Fehler ist nicht Kafka-spezifisch. Jede `HealthCheckRegistration`-Factory, die `new SomethingDisposable(...)` zurückgibt, verliert pro Prüfung eine Instanz, und bei der Standardperiode von 30 Sekunden des Health-Check-Publishers sind das 2.880 verlorene Objekte pro Tag und Check. Entweder wird der Check in DI registriert und in der Factory aufgelöst, wie Aspire es jetzt macht, oder der teure Client (Producer, Verbindung, `HttpClient`) liegt in einem Singleton und der Check bleibt ein billiges, zustandsloses Objekt. Wer noch auf der 13.5-Linie ist, findet im [früheren Beitrag zu `WithTerminal()`](/de/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/) den Rest dessen, was 13.5 am Dashboard geändert hat.
