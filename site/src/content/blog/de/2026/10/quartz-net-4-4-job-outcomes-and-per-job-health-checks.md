---
title: "Quartz.NET 4.4: Jobs melden, was sie erreicht haben, und ein Health Check bemerkt, wenn sie aufhören"
description: "Quartz.NET 4.4.0 erlaubt einem Job, context.Result auf einen JobRunReport zu setzen (Succeeded, Failed, Cancelled oder Skipped, mit Zusammenfassung und Metriken), speichert diesen pro Job in der Ausführungshistorie und ergänzt RequireSuccessWithin-Health-Checks, die auf Degraded wechseln, wenn ein nächtlicher Job nicht mehr erfolgreich läuft."
pubDate: 2026-10-11
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "health-checks"
  - "background-jobs"
lang: "de"
translationOf: "2026/10/quartz-net-4-4-job-outcomes-and-per-job-health-checks"
translatedBy: "claude"
translationDate: 2026-10-11
---

Quartz.NET [v4.4.0](https://github.com/quartznet/quartznet/releases/tag/v4.4.0) ist am 7. Oktober 2026 erschienen. Die Schlagzeilen betreffen das Clustering (Trigger, die bereits fällig sind, feuern in der Transaktion, die sie erwirbt, und auf PostgreSQL landen bei 20 Triggern pro Sekunde 95 bis 99 % der Auslösungen innerhalb von 50 ms, gegenüber 54 % bei 4.3.0). Die Änderung, die der meiste Anwendungscode nutzen wird, ist jedoch kleiner: Ein Job kann endlich sagen, was seine Ausführung erreicht hat, und Ihr Health-Endpunkt kann darauf reagieren.

## "Es hat keine Exception geworfen" heißt nicht "es hat funktioniert"

Bis 4.3 kannte Quartz zwei Ergebnisse: Der Job warf eine Exception, oder er tat es nicht. Ein Cleanup-Job, der nichts zu bereinigen fand, eine Synchronisierung, die abbrach, weil die Upstream-API eine leere Seite lieferte, und ein Lauf mit echter Arbeit sahen in der Historie identisch aus. Und ein nächtlicher Job, dessen Trigger drei Tage lang pausiert war oder einen Misfire hatte, sah nach gar nichts aus, weil nichts fehlschlug.

## Ein Ergebnis mit JobRunReport melden

In 4.4 setzt ein Job `context.Result` auf einen `JobRunReport`. Es gibt vier Ergebnisse (`Succeeded`, `Failed`, `Cancelled`, `Skipped`), eine optionale Zusammenfassung mit bis zu 1.000 Zeichen und Metriken, die als AOT-sicheres JSON mit maximal 4.000 Zeichen gespeichert werden:

```csharp
public sealed class ReleaseStaleReservationsJob : IJob
{
    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
    {
        int scanned = await CountReservations(cancellationToken);
        int released = await ReleaseStale(cancellationToken);

        context.Result = released == 0
            ? JobRunReport.Skipped("no stale reservations").With("scanned", scanned)
            : JobRunReport.Succeeded($"released {released}")
                .With("scanned", scanned)
                .With("released", released);
    }
}
```

Das aufgezeichnete Ergebnis folgt einer festen Reihenfolge: Eine abgebrochene Auslösung ist `Cancelled`, ein Job, der eine Exception warf, ist `Failed`, andernfalls gilt, was Sie in `context.Result` gesetzt haben, und sonst `Succeeded`. `JobRunReport.Failed(...)` zu melden ist nicht dasselbe wie eine Exception zu werfen. Nur eine geworfene Exception steuert die Retry-Richtlinie und die `OnFailure`-Continuations. Melden Sie daher einen Fehler, wenn ein erneuter Versuch nichts bringen würde.

Die Historie führt pro Job einen `JobRunStatus` (`LastSucceededAtUtc`, `ConsecutiveFailures`, `LastFailureMessage`, Lauf- und Fehleranzahl), die Aufbewahrung kann je nach Ergebnis unterschiedlich sein, und die Metrik `quartz.job.execution.duration` erhält ein Tag `quartz.job.result`, sodass Ihre OpenTelemetry-Dashboards übersprungene von echten Läufen trennen können.

## Ein Health Check pro Job

Das ist der Teil, den ich heute aktivieren würde. `RequireSuccessWithin` meldet einen Job als unhealthy, sobald er innerhalb eines Zeitfensters nicht erfolgreich war. Das fängt den stillen Fall ab: einen pausierten Trigger, einen Misfire, einen Job, der von einem Veto immer wieder übersprungen wird.

```csharp
builder.Services.AddQuartzExecutionHistory();

builder.Services.AddHealthChecks().AddQuartz(options =>
{
    // Degraded once the nightly report has not succeeded for 26 hours.
    options.RequireSuccessWithin(new JobKey("nightly-report", "reports"), TimeSpan.FromHours(26));

    // Unhealthy, so the node leaves rotation, after 90 minutes without a ledger close.
    options.RequireSuccessWithin(
        new JobKey("ledger-close", "billing"),
        TimeSpan.FromMinutes(90),
        HealthStatus.Unhealthy);
});
```

Der Standardstatus ist `Degraded`, und ein `Skipped`-Lauf zählt als Erfolg, sodass der Pfad "nichts zu tun" aus dem obigen Job niemanden alarmiert. Die Liste lässt sich auch über `RequiredJobs` aus der Konfiguration binden. Ist die Ausführungshistorie deaktiviert, schlägt der Host beim Start fehl, statt einen Check zu melden, der nie bestehen kann.

## Upgrade von 4.3

Das Release ist rein additiv: Code für 4.3 lässt sich unverändert kompilieren, und jedes neue Interface-Member hat eine Standardimplementierung. Wenn Sie einen persistenten Job Store mit aktivierter Ausführungshistorie verwenden, führen Sie das Skript `4.4/add_execution_outcome_<dialect>.sql` aus, bevor der erste 4.4-Knoten startet. Das Release bringt außerdem ein Attribut `[RetryPolicy]` für Job-Klassen, `q.RunAtStartup(jobKey)` und Weasel-Schemaverwaltung für MySQL, Oracle und Firebird. Alles ist im [Migrationsleitfaden](https://www.quartz-scheduler.net/documentation/quartz-4.x/migration-guide.html#upgrading-from-4-3-to-4-4) und im [How-to zu Job-Ergebnissen](https://www.quartz-scheduler.net/documentation/quartz-4.x/how-tos/job-outcomes.html) beschrieben.

Wenn Sie noch auf 4.2 sind, bekommen Sie den [Cron-Analyzer und den `[QuartzJob]`-Source-Generator aus 4.2](/de/2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors/) gleich mit.
