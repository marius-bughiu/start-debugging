---
title: "BackgroundService vs IHostedService vs Hangfire für Hintergrundaufgaben in .NET 11"
description: "Wählen Sie BackgroundService für In-Process-Schleifen, ein reines IHostedService für feine Lebenszyklus-Kontrolle und Hangfire, wenn Aufgaben einen Neustart überleben müssen. Eine Entscheidungsmatrix mit Code und das eine Detail, das für Sie entscheidet."
pubDate: 2026-06-03
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
lang: "de"
translationOf: "2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-03
---

Für Hintergrundarbeit in einer .NET-11-Anwendung lautet die kurze Antwort: Verwenden Sie `BackgroundService` für kontinuierliche In-Process-Schleifen und Queue-Consumer, greifen Sie nur dann auf ein reines `IHostedService` zurück, wenn Sie expliziten geordneten Start oder ein geordnetes Herunterfahren benötigen, und greifen Sie zu Hangfire, sobald eine Aufgabe einen Neustart des Prozesses überleben muss oder für "nächsten Dienstag um 2 Uhr morgens" geplant werden soll. Die ersten beiden sind dieselbe Hosting-Primitive auf unterschiedlicher Höhe und kosten Sie nichts zusätzlich. Hangfire ist eine separate Abhängigkeit mit einer Datenbank dahinter, und genau diese Datenbank ist das, wofür Sie bezahlen. Dieser Beitrag baut die Entscheidungsmatrix auf, zeigt den minimalen Code für jede Option und benennt die einzige Anforderung (Dauerhaftigkeit), die die Entscheidung meist für Sie trifft.

Alle Beispiele zielen auf .NET 11 und C# 14 ab. Die Hangfire-Beispiele verwenden Hangfire 1.8.x (`Hangfire.AspNetCore` plus `Hangfire.SqlServer`).

## Die Feature-Matrix

Das ist die Tabelle, wegen der Sie gekommen sind. Lesen Sie zuerst die Zeile "Überlebt einen Neustart"; sie teilt das Feld.

| Feature                          | IHostedService          | BackgroundService        | Hangfire                       |
| -------------------------------- | ----------------------- | ------------------------ | ------------------------------ |
| In .NET 11 integriert            | ja                      | ja                       | nein (NuGet + Speicher)        |
| Zusätzliche Infrastruktur        | keine                   | keine                    | SQL Server / Redis / Postgres  |
| Lebenszyklus-Oberfläche          | `StartAsync`/`StopAsync`| ein `ExecuteAsync`       | keine (Sie reihen Aufgaben ein)|
| Am besten für                    | Start-/Stopp-Schritte   | langlaufende Schleifen   | einmalige und geplante Aufgaben|
| Überlebt einen Neustart          | nein                    | nein                     | ja                             |
| Wiederholungen bei Fehlern       | Sie schreiben sie       | Sie schreiben sie        | automatisch, konfigurierbar    |
| Planung (Cron, Verzögerung)      | Sie schreiben sie       | Sie schreiben sie        | eingebaut                      |
| Läuft über mehrere Instanzen     | läuft auf jeder Instanz | läuft auf jeder Instanz  | ein Worker nimmt jede Aufgabe  |
| Dashboard / Sichtbarkeit         | keines                  | keines                   | eingebautes Web-Dashboard      |
| Kosten                           | kostenlos               | kostenlos                | OSS-Kern; teils Pro-Lizenz     |

`BackgroundService` ist keine Alternative zu `IHostedService`; es ist eine abstrakte Klasse, die es implementiert. Die eigentliche Wahl ist also zweigeteilt: ein In-Process-Hosting-Dienst (in einer seiner beiden Formen) gegenüber einem externen dauerhaften Aufgabensystem. Gehen wir der Reihe nach vor.

## IHostedService: der reine Lebenszyklus-Vertrag

`IHostedService` ist die Low-Level-Schnittstelle, die der generische Host von .NET beim Start und beim Herunterfahren aufruft. Sie hat genau zwei Methoden:

```csharp
// .NET 11, C# 14
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

Der Host wartet (mit `await`) auf das `StartAsync` jedes registrierten Dienstes in Registrierungsreihenfolge, bevor er die erste Anfrage bedient, und er wartet auf das `StopAsync` (bis zu `HostOptions.ShutdownTimeout`, standardmäßig 30 Sekunden), bevor der Prozess endet. Diese Reihenfolgegarantie ist der Grund, die reine Schnittstelle zu verwenden: Sie ist der richtige Ort für Arbeit, die abgeschlossen sein muss, bevor Traffic eintrifft (einen Cache aufwärmen, eine einmalige Migrationsprüfung ausführen, eine langlebige Verbindung öffnen).

```csharp
// .NET 11, C# 14
public sealed class CacheWarmer(IMemoryCache cache, IProductRepository repo) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // Runs to completion BEFORE the app starts serving requests.
        var hot = await repo.GetHotProductsAsync(ct);
        cache.Set("hot-products", hot);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Die Falle beim reinen `IHostedService` ist, langlaufende Arbeit innerhalb von `StartAsync` zu erledigen. Wenn Sie dort eine Endlosschleife starten und sie mit `await` abwarten, schließt der Host den Start nie ab. Sie müssen die Schleife starten, ohne sie abzuwarten, und den `Task` selbst verfolgen, um ihn dann in `StopAsync` abzubrechen und abzuwarten. Genau diese Buchführung soll `BackgroundService` beseitigen.

Wenn Sie noch feinere Kontrolle benötigen (einen Hook, der ausgeführt wird, *nachdem jeder* Hosting-Dienst gestartet ist, oder kurz bevor das Herunterfahren beginnt), hat .NET 8 `IHostedLifecycleService` hinzugefügt, das `IHostedService` um `StartingAsync`/`StartedAsync` und `StoppingAsync`/`StoppedAsync` erweitert. Es ist in .NET 11 weiterhin aktuell und der dokumentierte Ort für eine dienstübergreifende "Jetzt ist alles oben"-Validierung, wie es die [Vorstellung der Schnittstelle von Steve Gordon](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) beschreibt.

## BackgroundService: die Schleife, die Sie eigentlich wollen

`BackgroundService` ist die abstrakte Basisklasse, die `IHostedService` mithilfe des Template-Method-Musters für Sie implementiert. Sie überschreiben eine einzige Methode:

```csharp
// .NET 11, C# 14
public sealed class QueuePump(IServiceScopeFactory scopeFactory, ILogger<QueuePump> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
                await processor.DrainOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // normal shutdown
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Order pump iteration failed; retrying");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
```

Das Framework ruft `ExecuteAsync` aus seinem eigenen `StartAsync` heraus auf, signalisiert den `stoppingToken`, wenn der Host stoppt, und wartet beim Herunterfahren mit `await` auf den `Task`, den Sie zurückgeben. Zwei Details treffen Entwickler häufig genug, um sie hervorzuheben:

- **Ein `BackgroundService` ist ein Singleton.** Sie können einen Scoped-Dienst wie einen `DbContext` nicht direkt injizieren; Sie nehmen `IServiceScopeFactory` und öffnen einen Scope pro Arbeitseinheit, genau wie oben. Ich habe eine eigene Anleitung zum [Verwenden von Scoped-Diensten innerhalb eines BackgroundService](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) geschrieben.
- **Eine nicht behandelte Ausnahme in `ExecuteAsync` stoppt den Dienst stillschweigend** (und seit .NET 6 standardmäßig den gesamten Host über `BackgroundServiceExceptionBehavior.StopHost`). Umschließen Sie den Schleifenrumpf mit try/catch, wenn eine einzelne fehlerhafte Iteration den Dienst nicht beenden soll, wie gezeigt.

Registrieren Sie beide Formen auf dieselbe Weise:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHostedService<QueuePump>();      // BackgroundService
builder.Services.AddHostedService<CacheWarmer>();    // raw IHostedService
```

Ein `BackgroundService` in Kombination mit einem begrenzten `System.Threading.Channel` ist die kanonische In-Process-Aufgabenwarteschlange: Producer schreiben Arbeitselemente, der Dienst leert sie. Wenn Sie jemals aus einem Controller heraus zu `Task.Run` gegriffen haben, ist das das Muster, das Sie eigentlich wollten: siehe [Fire-and-Forget-Arbeit sicher mit einem BackgroundService ausführen](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) und das umfassendere Argument für [Channels statt BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Wann die In-Process-Optionen wählen

**Wählen Sie `BackgroundService`, wenn:**

- Sie eine kontinuierliche Schleife haben: einen Queue-Consumer, einen Poller, einen Heartbeat, einen Metrik-Flusher. Das ist sein Heimspiel.
- Es akzeptabel ist, die Arbeit beim Herunterfahren zu verlieren, oder Sie laufende Elemente im kurzen `StopAsync`-Fenster leeren. E-Mail-Wiederholungen, die ohnehin aus einer Warteschlange erneut angestoßen werden, Cache-Aktualisierungen, Log-Versand.
- Sie keine neue Infrastruktur wollen. Es ist in `Microsoft.Extensions.Hosting` enthalten; es gibt nichts zu installieren oder bereitzustellen.

**Wählen Sie das reine `IHostedService` (oder `IHostedLifecycleService`), wenn:**

- Sie benötigen, dass die Arbeit *vor* dem Bedienen der ersten Anfrage abgeschlossen ist (Cache aufwärmen, Schema prüfen, Feature-Flags vorab laden).
- Sie geordneten Start oder ein geordnetes Herunterfahren über mehrere Dienste hinweg benötigen oder einen Validierungs-Hook "alles grün" nach dem Start.
- Die Arbeit ein einzelner Start-/Stopp-Schritt ist, keine endlose Schleife, sodass die Form mit einem einzigen `ExecuteAsync` von `BackgroundService` nicht passt.

Beide laufen auf *jeder* Instanz Ihrer Anwendung. Wenn Sie auf drei Replikate skalieren, läuft Ihr `BackgroundService` dreimal, parallel, ohne Koordination. Für einen zustandslosen Poller ist das in Ordnung. Für "die nächtliche Rechnungs-E-Mail einmal senden" ist es ein Bug.

## Wann Hangfire wählen

**Wählen Sie Hangfire, wenn eine dieser Bedingungen zutrifft:**

- **Eine Aufgabe muss einen Neustart oder Absturz überleben.** Hangfire schreibt die Aufgabe in den Speicher (SQL Server, Redis oder PostgreSQL), bevor sie ausgeführt wird, sodass ein Deployment mitten in einer Aufgabe sie nicht verliert. Die Aufgabe wird erneut aufgenommen. Das ist das Kernfeature.
- **Sie benötigen Planung.** "In 10 Minuten ausführen", "jeden Werktag um 6 Uhr" (Cron), "zu genau diesem UTC-Zeitpunkt". Eingebaut, ohne Timer-Rechnerei.
- **Sie benötigen automatische Wiederholungen mit Backoff.** Hangfire wiederholt fehlgeschlagene Aufgaben standardmäßig eine konfigurierbare Anzahl von Malen, mit im Dashboard sichtbarem Versuchsverlauf.
- **Sie benötigen eine einmalige Ausführung über N Instanzen.** Hangfire-Server konkurrieren um Aufgaben aus dem gemeinsam genutzten Speicher, sodass jede Aufgabe einmal ausgeführt wird, unabhängig davon, wie viele Anwendungsinstanzen oben sind. Das löst das Problem der "nächtlichen E-Mail dreimal" sauber.
- **Sie wollen operative Sichtbarkeit.** Das mitgelieferte Dashboard zeigt eingereihte, in Bearbeitung befindliche, erfolgreiche und fehlgeschlagene Aufgaben mit Stack Traces, etwas, das Sie sonst selbst bauen müssten.

Minimale Einrichtung in .NET 11:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString("HangfireDb")));

builder.Services.AddHangfireServer();

var app = builder.Build();
app.UseHangfireDashboard("/jobs");  // lock this down in production

// Fire-and-forget, durable:
BackgroundJob.Enqueue<IInvoiceService>(s => s.SendAsync(orderId, CancellationToken.None));

// Recurring (cron):
RecurringJob.AddOrUpdate<IReportService>(
    "nightly-report",
    s => s.BuildAsync(CancellationToken.None),
    Cron.Daily(2));
```

Beachten Sie, was sich gerade geändert hat: Sie besitzen jetzt einen Satz von Datenbanktabellen, den Hangfire verwaltet, einen Connection String, Migrationen dieses Schemas über Hangfire-Upgrades hinweg und einen Dashboard-Endpunkt, den Sie autorisieren müssen. Das ist echtes operatives Gewicht. Sie nehmen es bewusst auf sich, im Austausch für Dauerhaftigkeit und Planung, die Sie sonst schlecht selbst zusammenbauen würden.

## Das Durchsatzbild, mit echten Zahlen

Performance ist hier selten die entscheidende Achse, aber es lohnt sich, ehrlich über die Kosten der Dauerhaftigkeit zu sein. Ein In-Process-`BackgroundService`, der einen `Channel` leert, verursacht pro Element keine I/O über Ihre eigene Arbeit hinaus; der Dispatch-Overhead ist praktisch ein Methodenaufruf und gegenüber der Arbeit selbst nicht messbar. Hangfire hingegen führt pro Aufgabe mindestens einen Speicher-Roundtrip zum Entfernen aus der Warteschlange und einen zum Markieren des Abschlusses aus.

Hangfires eigene Dokumentation beziffert die Speicherwahl: Der Wechsel von SQL Server zu Redis ergibt **mehr als das Vierfache des Durchsatzes** bei leeren Aufgaben, laut dem [Redis-Leitfaden](https://docs.hangfire.io/en/latest/configuration/using-redis.html). Die absoluten Zahlen hängen von der Latenz Ihres Speichers ab, aber die Form ist fest: Hangfires Untergrenze ist "Roundtrips zu einer Datenbank", und die Untergrenze einer In-Process-Warteschlange ist "nichts". Wenn Sie Zehntausende trivialer Elemente pro Sekunde verarbeiten, ist diese Lücke relevant, und eine In-Process-`Channel`-Warteschlange gewinnt klar. Wenn Sie Tausende Aufgaben pro Minute verarbeiten, die jeweils echte Arbeit leisten (eine API aufrufen, ein PDF rendern), verschwinden die Speicherkosten pro Aufgabe im Rauschen und Dauerhaftigkeit ist in der Praxis kostenlos.

Die daraus folgende Regel: Leiten Sie hochfrequente, verlusttolerante Arbeit nicht durch Hangfire, nur weil es da ist. Ein Poller, der jede Sekunde eine Warteschlange prüft, ist ein `BackgroundService`, nicht 86.400 Hangfire-Aufgaben pro Tag.

## Das Detail, das für Sie entscheidet

Zwei Anforderungen beenden die Debatte, bevor Vorlieben ins Spiel kommen:

1. **"Das darf nicht verloren gehen, wenn die Anwendung neu startet."** Wenn eine Aufgabe bei einem Deployment verworfen wird und das ein echter Bug ist (eine Zahlungserfassung, eine Bestätigungs-E-Mail, eine Webhook-Zustellung), benötigen Sie dauerhaften Speicher, und das bedeutet Hangfire (oder einen echten Message Broker). Kein noch so gründliches Leeren in `StopAsync` lässt einen `BackgroundService` ein `kill -9` oder einen Knotenausfall überleben. Die In-Process-Optionen halten die Arbeit im Speicher; der Speicher stirbt mit dem Prozess.

2. **"Das muss über meine Replikate hinweg genau einmal laufen."** Ein `BackgroundService` läuft auf jeder Instanz. Wenn Sie horizontal skalieren und die Aufgabe nicht idempotent ist, erhalten Sie doppelte Arbeit. Hangfires Worker-Modell mit gemeinsam genutztem Speicher liefert die einmalige Ausführung gratis. Das In-Process-Äquivalent ist ein verteiltes Lock, das Sie bauen und richtig hinbekommen müssen.

Wenn keine der beiden Anforderungen zutrifft (die Arbeit ist In-Process, verlusttolerant und läuft entweder einmal, weil Sie eine Instanz betreiben, oder ist von Natur aus idempotent), dann zahlt das Hinzufügen von Hangfire eine Datenbank-Steuer für nichts. Verwenden Sie `BackgroundService`.

Ein üblicher und korrekter Hybrid: Belassen Sie den dauerhaften *Zeitplan und die Wiederholungen* in Hangfire, lassen Sie aber den Rumpf der wiederkehrenden Aufgabe einfach in einen In-Process-`Channel` einreihen, den ein `BackgroundService` leert. Hangfire garantiert, dass die Aufgabe einmal auslöst und Neustarts überlebt; der `Channel` liefert schnellen, gegendruckbewussten In-Process-Durchsatz. Sie erhalten beide Eigenschaften, ohne jedes Element durch den Speicher zwingen zu müssen.

## Die Empfehlung, noch einmal

Greifen Sie standardmäßig zu `BackgroundService` für alles, was In-Process schleift. Greifen Sie nur dann zum reinen `IHostedService` oder zu `IHostedLifecycleService`, wenn Sie speziell Start-Reihenfolge oder Pre-/Post-Shutdown-Hooks benötigen. Setzen Sie Hangfire ein, sobald eine Aufgabe einen Neustart überleben, nach einem Zeitplan laufen, automatisch wiederholen oder über mehrere Instanzen hinweg genau einmal ausgeführt werden muss, und akzeptieren Sie die Datenbank, die es mitbringt, als Preis für diese Garantien. Der Instinkt, "zur Sicherheit" zu Hangfire zu greifen, ist meist verkehrt herum: Beginnen Sie In-Process und lassen Sie eine konkrete Dauerhaftigkeits- oder Planungsanforderung Sie zum schwereren Werkzeug ziehen. Wenn Sie auf den eingebauten Primitiven laufen, [überwachen Sie diese Hintergrundaufgaben mit Health Checks und Metriken](/de/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/), um nicht blind zu fliegen, und stellen Sie sicher, dass Ihre Schleifen beim Herunterfahren [sauber und ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Quellen

- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) -- Microsoft Learn
- [Implement background tasks with IHostedService and BackgroundService](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/multi-container-microservice-net-applications/background-tasks-with-ihostedservice) -- Microsoft Learn
- [Introducing the new IHostedLifecycleService interface in .NET 8](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) -- Steve Gordon
- [Hangfire overview and supported storage](https://www.hangfire.io/) -- Hangfire
- [Using Redis storage (throughput note)](https://docs.hangfire.io/en/latest/configuration/using-redis.html) -- Hangfire Documentation
- [Using SQL Server storage](https://docs.hangfire.io/en/latest/configuration/using-sql-server.html) -- Hangfire Documentation
