---
title: "Quartz.NET 4.2 macht aus fehlerhaften Cron-Ausdrücken Build-Fehler"
description: "Quartz.NET 4.2.0 liefert einen Roslyn-Analyzer, der nicht parsbare Cron-Literale zur Compile-Zeit als QZ0001 ablehnt, sowie einen Source Generator, der [QuartzJob]- und [CronTrigger]-Attribute in eine AddDeclaredJobs()-Registrierung umwandelt. Hier steht, was geprüft wird, wie der generierte Code aussieht und wie man es deaktiviert."
pubDate: 2026-09-28
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "source-generators"
  - "roslyn-analyzers"
lang: "de"
translationOf: "2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors"
translatedBy: "claude"
translationDate: 2026-09-28
---

Die meisten Quartz.NET-Nutzer haben schon einmal einen Cron-Ausdruck ausgeliefert, der im Review unauffällig wirkte und beim Start eine `FormatException` auslöste. [Quartz.NET 4.2.0](https://github.com/quartznet/quartznet/releases/tag/v4.2.0), veröffentlicht am 25. September 2026 und gefolgt vom Patch 4.2.1 am 27. September, verschiebt diesen Fehler an den Compiler. Das `Quartz`-Paket bringt jetzt seinen eigenen Analyzer und Source Generator mit, ohne dass ein zusätzliches Paket installiert werden muss.

## QZ0001: Der Cron-Parser läuft zur Build-Zeit

Der Analyzer prüft jedes Cron-Literal oder jede Cron-Konstante, die an `WithCronSchedule`, `CronScheduleBuilder.Create`, die `CronExpression`-Konstruktoren, `CronCalendar` und `CronTriggerImpl` übergeben wird. Er verwendet keine zweite Grammatik, sondern bindet die Parser-Quellen des Schedulers selbst ein, und ein Paritäts-Korpus aus 128 Ausdrücken hält beide synchron. Akzeptiert der Compiler ein Literal, akzeptiert es auch der Scheduler.

```csharp
q.AddTrigger(t => t
    .ForJob(jobKey)
    .WithCronSchedule("0 12 * * 1-5"));
// error QZ0001, reported on the literal with the parser's own message
```

Dieses Beispiel ist der klassische Fehler: ein von Linux kopierter Fünf-Felder-Crontab-Ausdruck. Quartz liest sechs oder sieben Felder (Sekunden zuerst) und verlangt ein `?` in einem der beiden Tagesfelder, daher lautet die Quartz-Version `"0 0 12 ? * MON-FRI"`. Wenn Sie tatsächlich die Unix-Grammatik meinen, übergeben Sie `CronFormat.Unix` als Literal, und der Analyzer validiert dagegen.

Drei weitere Regeln kommen dazu:

- **QZ0002** (Fehler): ein Wert in `[JobTimeout("...")]`, der nicht parsbar oder negativ ist.
- **QZ0003** (Warnung): `[PersistJobDataAfterExecution]` ohne `[DisallowConcurrentExecution]`, wobei zwei gleichzeitige Ausführungen sich gegenseitig die Job Data Map überschreiben können.
- **QZ0004** (Info): eine `Execute`-Methode, die ihr `CancellationToken` nie beobachtet.

## Den Job an seiner Klasse deklarieren

Die zweite Hälfte des Features ist ein Generator, der `[QuartzJob]` und `[CronTrigger]` aus Ihren `IJob`-Typen liest:

```csharp
[QuartzJob(Name = "cleanup", Group = "maintenance")]
[CronTrigger("0 0 0/6 * * ?")]
[CronTrigger("0 0 12 ? * MON-FRI", Name = "cleanup-weekday-noon", TimeZone = "Europe/Helsinki")]
public sealed class CleanupJob : IJob
{
    public ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => default;
}

services.AddQuartz(q => q.AddDeclaredJobs());
services.AddQuartzHostedService();
```

`AddDeclaredJobs()` wird als `internal` Extension auf `IQuartzBuilder` in Ihre Assembly generiert. Es enthält genau die `AddJob<T>`- und `AddTrigger<T>`-Aufrufe, die Sie von Hand geschrieben hätten, es findet also kein Assembly-Scanning statt und es gibt nichts, was für Trimming oder Native AOT verwurzelt werden müsste. Die Cron-Strings in den Attributen laufen wie jedes andere Literal durch QZ0001. Setzen Sie `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>`, wenn Sie die generierte `QuartzDeclaredJobs.g.cs` lesen möchten.

Der Generator hat eigene Schutzmechanismen: `QZ1001` lehnt das Attribut auf einem Typ ab, der kein konkreter `IJob` ist, `QZ1002` lehnt zwei Deklarationen mit derselben Identität ab, und `QZ1003` lehnt einen `[CronTrigger]` ohne `[QuartzJob]` ab. Ein Job ohne Trigger wird zwangsweise auf `Durable = true` gesetzt, damit der Store ihn nicht sofort löscht.

## Hinweise zum Upgrade

Der Analyzer ist standardmäßig aktiv, das heißt, ein bestehendes Projekt mit einem fehlerhaften Literal kompiliert nicht mehr. Das ist beabsichtigt, aber achten Sie auch auf QZ0003 unter `TreatWarningsAsErrors`. Um die gesamte Funktion abzuschalten, setzen Sie Folgendes in der Projektdatei:

```xml
<PropertyGroup>
  <DisableQuartzAnalyzers>true</DisableQuartzAnalyzers>
</PropertyGroup>
```

Die Release Notes weisen darauf hin, dass `ExcludeAssets="analyzers"` in der Paketreferenz ihn auf dem .NET 10 SDK nicht deaktiviert. Einzelne Schweregrade lassen sich weiterhin in der `.editorconfig` anpassen.

Wenn Sie einen persistenten Job Store verwenden, erfordert 4.2 außerdem die Migration `database/migrations/4.2/add_continuations_<dialect>.sql`, bevor der erste 4.2-Knoten startet, wegen des neuen Trigger-Continuations-Features. Und wenn Sie den neuen datenbankgestützten Ausführungsverlauf auf einem Schema aktivieren, das aus `tables_sqlServerMOT.sql` oder `tables_sqlServer_Below2016.sql` erstellt wurde, gehen Sie direkt zu [4.2.1](https://github.com/quartznet/quartznet/releases/tag/v4.2.1), das die fehlende `RETRY_ATTEMPT`-Spalte behebt.

Falls Sie noch nicht sicher sind, ob Quartz überhaupt der richtige Scheduler ist: Ich habe ihn mit den Alternativen verglichen in [Hangfire vs Quartz.NET vs IHostedService](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/).
