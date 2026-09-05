---
title: "Was ist ein EF Core Interceptor und wann brauchen Sie einen?"
description: "Ein EF Core Interceptor ist eine Klasse, die EF vor und nach Operationen wie dem Ausführen eines Befehls oder SaveChanges aufruft und die diese verändern oder unterdrücken kann, nicht nur beobachten. Hier sind die sieben Interception-Punkte in EF Core 11, die Registrierungs- und Lebensdauerregeln und die Fälle, in denen ein Query-Filter oder schlichte Protokollierung die bessere Antwort ist."
pubDate: 2026-09-05
tags:
  - "ef-core"
  - "dotnet-11"
  - "csharp"
  - "aspnetcore"
lang: "de"
translationOf: "2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-09-05
---

Ein EF Core Interceptor ist eine Klasse, die Sie an einem `DbContext` registrieren und die EF vor und nach einer bestimmten Operation aufruft: Erzeugen oder Ausführen eines Befehls, Öffnen einer Verbindung, Starten einer Transaktion, Aufruf von `SaveChanges`, Materialisieren einer Entität aus Abfrageergebnissen, Kompilieren einer LINQ-Abfrage oder Auflösen eines Identitätskonflikts. Entscheidend ist, und das trennt Interceptors von der Protokollierung, dass die meisten Interception-Punkte die Operation **verändern oder unterdrücken** lassen statt sie nur zu beobachten. Sie brauchen einen, wenn ein Belang für jeden Kontext der Anwendung gelten muss, sich nicht im Modell ausdrücken lässt und das Verhalten ändern soll: Audit-Spalten stempeln, einen Query Hint anhängen, pro Tenant eine Verbindungszeichenfolge auflösen oder eine Nebenläufigkeitsausnahme schlucken, die Sie als harmlos eingestuft haben. Wenn Sie nur das SQL sehen wollen, wollen Sie Protokollierung, und ein Interceptor ist das falsche Werkzeug.

Alles Folgende zielt auf EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). Die Interception-Oberfläche selbst hat sich in EF Core 11 nicht geändert: Die sieben Interfaces sind stabil, seit EF Core 7 `IIdentityResolutionInterceptor` hinzugefügt hat. Was sich drumherum geändert hat, ist wissenswert, und das behandle ich in den Fallstricken.

## Die sieben Interception-Punkte

Jeder Interceptor implementiert eines oder mehrere von `IInterceptor` abgeleitete Interfaces, alle im Namespace `Microsoft.EntityFrameworkCore.Diagnostics`:

| Interface | Was abgefangen wird | Singleton |
| --- | --- | --- |
| `IDbCommandInterceptor` | Befehlserzeugung, Ausführung, Fehler, Freigabe des `DbDataReader` | Nein |
| `IDbConnectionInterceptor` | Erzeugen, Öffnen und Schließen von Verbindungen; Verbindungsfehler | Nein |
| `IDbTransactionInterceptor` | Erzeugen, Verwenden, Committen und Zurückrollen von Transaktionen; Savepoints | Nein |
| `ISaveChangesInterceptor` | `SavingChanges` / `SavedChanges` / `SaveChangesFailed`, optimistische Nebenläufigkeit | Nein |
| `IMaterializationInterceptor` | Erzeugen, Initialisieren und Finalisieren von Entitätsinstanzen aus Abfrageergebnissen | Ja |
| `IQueryExpressionInterceptor` | Der LINQ-Ausdrucksbaum, bevor die Abfrage kompiliert wird | Ja |
| `IIdentityResolutionInterceptor` | Identitätskonflikte, wenn der Kontext eine neue Instanz zu verfolgen beginnt | Ja |

Die ersten drei sind rein relational; Datenbank-Interception steht bei nicht-relationalen Providern wie dem Azure Cosmos DB Provider nicht zur Verfügung. Die Spalte `Singleton` ist nicht kosmetisch, und ich komme weiter unten darauf zurück, weil ein Fehler an dieser Stelle der häufigste Weg ist, mit einem Interceptor still die Performance zu ruinieren.

Für die vier Nicht-Singleton-Interfaces gibt es Basisklassen ohne Logik: `DbCommandInterceptor`, `DbConnectionInterceptor`, `DbTransactionInterceptor` und `SaveChangesInterceptor`. Leiten Sie davon ab und überschreiben Sie nur die zwei oder drei Methoden, die Sie interessieren, statt 20 Interface-Member von Hand zu implementieren.

## Die Form eines Methodenpaars, und was "unterdrücken" bedeutet

Jeder Interception-Punkt kommt als Vorher/Nachher-Paar, und jede Hälfte kommt in einer synchronen und einer asynchronen Variante. `ReaderExecuting` läuft, bevor die Abfrage an die Datenbank geht; `ReaderExecuted` läuft, nachdem sie zurückkehrt. `SavingChanges` läuft vor dem Speichern, `SavedChanges` nach einem erfolgreichen Speichern.

Die "Vorher"-Methoden geben ein `InterceptionResult` oder ein `InterceptionResult<T>` zurück, und dieser Rückgabewert ist der Steuerkanal:

- Geben Sie das Argument `result` unverändert zurück, und EF macht normal weiter. Das ist der reine Beobachtungsfall.
- Geben Sie `InterceptionResult.Suppress()` zurück, und EF überspringt die Operation vollständig. Wird bei Operationen ohne Rückgabewert verwendet, etwa beim Interception-Punkt `ThrowingConcurrencyException`, wo Unterdrücken bedeutet: "wirf keine `DbUpdateConcurrencyException`".
- Geben Sie `InterceptionResult<T>.SuppressWithResult(value)` zurück, und EF überspringt die Operation und verwendet stattdessen Ihren Wert. Wird bei Operationen verwendet, die etwas erzeugen, etwa um statt einer SQL-Ausführung einen gefertigten `DbDataReader` aus einem Cache zu liefern.

Das ist das gesamte mentale Modell. Protokollierung sagt Ihnen, was EF getan hat; ein Interceptor bekommt ein Vetorecht.

Hier ist ein minimaler, wirklich nützlicher Command-Interceptor: jeden Befehl protokollieren, der länger als ein Schwellwert dauert, samt der EF-Komponente, die ihn ausgelöst hat.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore.Relational 11.0
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

public sealed class SlowCommandInterceptor(ILogger<SlowCommandInterceptor> logger)
    : DbCommandInterceptor
{
    private static readonly TimeSpan Threshold = TimeSpan.FromMilliseconds(200);

    public override DbDataReader ReaderExecuted(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result)
    {
        Report(command, eventData);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        Report(command, eventData);
        return new ValueTask<DbDataReader>(result);
    }

    private void Report(DbCommand command, CommandExecutedEventData eventData)
    {
        if (eventData.Duration < Threshold)
        {
            return;
        }

        logger.LogWarning(
            "Slow command ({DurationMs} ms, source {Source}): {Sql}",
            (int)eventData.Duration.TotalMilliseconds,
            eventData.CommandSource,
            command.CommandText);
    }
}
```

Zwei Details darin werden häufig übersehen. Erstens sind sowohl die synchrone als auch die asynchrone Überschreibung implementiert. EF ruft die auf, die zum Aufruf der Anwendung passt, also bewirkt ein Interceptor, der nur `ReaderExecuted` implementiert, in einer asynchronen Codebasis still gar nichts. Zweitens sagt `eventData.CommandSource`, ob der Befehl aus einer Abfrage, aus `SaveChanges`, aus `ExecuteUpdate` oder aus einer Migration stammt, und das ist meist der Filter, den Sie tatsächlich wollen.

## Einen Interceptor registrieren

Die Registrierung erfolgt bei der Konfiguration des Kontexts, über `DbContextOptionsBuilder.AddInterceptors`:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .AddInterceptors(sp.GetRequiredService<SlowCommandInterceptor>()));
```

Den Interceptor aus dem Service Provider aufzulösen ist das, was ihm Konstruktorabhängigkeiten erlaubt, und so bekommt er oben seinen `ILogger`. Registrieren Sie zuerst den Interceptor selbst (hier `builder.Services.AddSingleton<SlowCommandInterceptor>()`, da er keinen Zustand pro Request hält).

`OnConfiguring` funktioniert ebenfalls und läuft auch dann, wenn `AddDbContext` verwendet wird, also ist es ein sinnvoller Ort für Interceptors, die unabhängig von der Konstruktion des Kontexts gelten müssen. Eine Interceptor-Instanz kann mehrere der Interfaces gleichzeitig implementieren; registrieren Sie sie einmal, und EF leitet jedes Ereignis an das passende Interface weiter.

## Ein SaveChanges-Interceptor von Anfang bis Ende

Der häufigste echte Interceptor ist der, der Audit-Spalten stempelt. Es lohnt sich, ihn vollständig auszuschreiben, weil sowohl die Sync/Async-Paarung als auch der Aufruf des Change Trackers leicht falsch geraten.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public interface IAuditable
{
    DateTimeOffset CreatedUtc { get; set; }
    DateTimeOffset ModifiedUtc { get; set; }
}

public sealed class TimestampInterceptor(TimeProvider clock) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        Stamp(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Stamp(eventData.Context);
        return new ValueTask<InterceptionResult<int>>(result);
    }

    private void Stamp(DbContext? context)
    {
        if (context is null)
        {
            return;
        }

        // The docs' own auditing sample calls DetectChanges here rather than
        // assuming the states are already current. Do the same.
        context.ChangeTracker.DetectChanges();

        var now = clock.GetUtcNow();

        foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    entry.Entity.CreatedUtc = now;
                    entry.Entity.ModifiedUtc = now;
                    break;
                case EntityState.Modified:
                    entry.Entity.ModifiedUtc = now;
                    break;
            }
        }
    }
}
```

`TimeProvider` entgegenzunehmen statt `DateTimeOffset.UtcNow` direkt zu lesen macht das Ganze testbar; dieselbe Überlegung gilt überall in einer .NET 11 Codebasis und passt zu [zeitabhängigem Code mit FakeTimeProvider testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). Die vollständige Fassung dieses Musters, inklusive Änderungsprotokoll und aktuellem Benutzer, steht separat in [EF Core 11 Interceptors für Auditing verwenden](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Eine Operation unterdrücken: der Nebenläufigkeitsfall

Die klarste Demonstration des Vetos ist `ISaveChangesInterceptor.ThrowingConcurrencyException`. EF ruft die Methode unmittelbar bevor es `DbUpdateConcurrencyException` werfen würde. Wenn zwei Requests dieselbe Zeile gleichzeitig löschen wollen, sieht der Verlierer null betroffene Zeilen und bekommt eine Ausnahme, obwohl der gewünschte Endzustand (die Zeile ist weg) erreicht ist:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
public sealed class SuppressDeleteConcurrencyInterceptor : ISaveChangesInterceptor
{
    public InterceptionResult ThrowingConcurrencyException(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result)
        => eventData.Entries.All(e => e.State == EntityState.Deleted)
            ? InterceptionResult.Suppress()
            : result;

    public ValueTask<InterceptionResult> ThrowingConcurrencyExceptionAsync(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken = default)
        => new(ThrowingConcurrencyException(eventData, result));
}
```

`eventData.Entries` liefert die beteiligten `EntityEntry` Objekte, die Entscheidung fällt also über echten Zustand und nicht über einen Textvergleich mit einer Ausnahmemeldung. Bei einem relationalen Provider können Sie `eventData` zu `RelationalConcurrencyExceptionEventData` casten und zusätzlich den verursachenden `Command` lesen.

## Wann Sie keinen Interceptor brauchen

Interceptors sind der schwerste Haken, den EF anbietet, und zuerst danach zu greifen ist ein verbreiteter Fehler. Prüfen Sie vor dem Schreiben, ob ein leichteres Mittel den Fall abdeckt.

**Sie wollen das SQL sehen.** Verwenden Sie `Microsoft.Extensions.Logging` oder die einfache Protokollierung über `LogTo`. Die Dokumentation sagt ausdrücklich, dass Interceptors nicht der Protokollierungsmechanismus sind, und eine Logging-Pipeline liefert Level, Filter und Senken frei Haus. Wenn Sie hinter Abfrageanzahlen statt Abfragetext her sind, kommt der Ansatz in [N+1-Abfragen in EF Core 11 erkennen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) näher an das, was Sie wollen, und die allgemeine Einrichtung strukturierter Protokollierung steht in [Serilog und Seq unter .NET 11](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

**Sie wollen einen Callback beim Speichern oder beim Tracking, und synchron reicht.** `DbContext` stellt gewöhnliche .NET Events bereit: `SavingChanges`, `SavedChanges`, `SaveChangesFailed`, `ChangeTracker.Tracked` und `ChangeTracker.StateChanged`. Sie werden pro Kontextinstanz registriert und lassen sich jederzeit anhängen, was sie einfacher macht als einen Interceptor. Der Haken: Events sind rein synchron und können deshalb keine nicht-blockierende E/A ausführen. Interceptors können das, weil die asynchronen Hälften `ValueTask` zurückgeben.

**Sie wollen dieselbe Information für jeden Kontext im Prozess.** Das ist ein `DiagnosticListener` Abonnement auf die Quelle `"Microsoft.EntityFrameworkCore"`, kein Interceptor. Diagnostic Listener gelten prozessweit und beobachten nur; Interceptors gelten pro Kontext und können verändern. Wählen Sie nach beiden Achsen, nicht nur nach einer.

**Sie wollen jede Abfrage nach Soft Delete oder Mandant filtern.** Das ist ein Query-Filter, kein `IQueryExpressionInterceptor`. Einen `ExpressionVisitor` zu schreiben, der eine `Where` Klausel einschleust, ist sehr viel fragiler Code, um etwas nachzubauen, das das Modell bereits kann, und EF Core 10 und 11 unterstützen mehrere unabhängig abschaltbare Filter pro Entität, also genau den Fall, den man früher von Hand gelöst hat. Siehe [benannte Query-Filter für Soft Delete und Mandantenfähigkeit](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

**Sie wollen einen Eigenschaftswert beim Hin- und Rückweg umwandeln.** Das ist ein Value Converter.

**Das Verhalten gilt für genau eine `DbContext` Unterklasse und nur beim Speichern.** `SaveChangesAsync` zu überschreiben ist einfacher, im Stacktrace besser lesbar und leichter zu testen. Greifen Sie zu `ISaveChangesInterceptor`, wenn die Logik für mehrere Kontexttypen gelten muss oder wenn sie in einer geteilten Bibliothek leben soll, der die Kontextklasse nicht gehört.

## Fallstricke, die echte Zeit kosten

**Singleton-Interceptors und `ManyServiceProvidersCreatedWarning`.** `IMaterializationInterceptor`, `IQueryExpressionInterceptor` und `IIdentityResolutionInterceptor` werden im *internen* Service Provider von EF registriert. Jede eigene Instanz, die Sie an `AddInterceptors` übergeben, lässt einen neuen internen Provider entstehen, also führt ein `new MyMaterializationInterceptor()` innerhalb einer `AddDbContext` Lambda, die pro Scope läuft, irgendwann zu `ManyServiceProvidersCreatedWarning` und ruiniert die Performance. Halten Sie eine Instanz in einem statischen Feld oder lösen Sie ein Singleton aus der Dependency Injection auf. Weil sie geteilt werden, müssen diese Interceptors threadsicher sein und sollten keinen veränderlichen Zustand halten; greifen Sie über die Eigenschaft `Context` der Ereignisdaten auf Scoped-Dinge zu.

**Scoped-Abhängigkeiten in einem `SaveChanges` Interceptor.** Die Nicht-Singleton-Interceptors sind von obiger Einschränkung frei, aber wenn Ihrer von etwas Scoped abhängt (ein Zugriff auf den aktuellen Benutzer, ein Tenant-Resolver), muss er selbst scoped sein und über die Überladung `(sp, options)` von `AddDbContext` aufgelöst werden. Ihn als Singleton zu registrieren und einen Scoped-Service hineinzugeben ist der klassische Weg zu [cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

**`ExecuteUpdate` und `ExecuteDelete` erreichen niemals einen `SaveChanges` Interceptor.** Mengenbasierte Operationen umgehen den Change Tracker und gehen direkt in SQL, also entfallen Audit-Stempel, Soft-Delete-Umschreibung und das Verteilen von Domain Events, die an `SavingChanges` hängen. Das ist so gewollt und der häufigste Weg, auf dem ein Audit-Trail stille Lücken bekommt. Die Abwägung steht in [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Ein `IDbCommandInterceptor` sieht diese Befehle weiterhin, denn am Ende wird alles zu einem `DbCommand`.

**`ConnectionCreating` und `ConnectionCreated` feuern nur, wenn EF die Verbindung erzeugt.** Wenn Ihre Anwendung die `DbConnection` selbst baut und an EF übergibt, laufen diese beiden Interception-Punkte nie. `ConnectionOpening` läuft weiterhin.

**`IIdentityResolutionInterceptor` feuert nicht für Abfrageergebnisse.** Ab EF Core 11 wird er nur aus `Update`, `Attach` und ähnlichen Tracking-Aufrufen aufgerufen, nicht für Entitäten, die aus einer Abfrage zurückkommen. Das wird unter [dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574) verfolgt und kann sich ändern. Wenn Sie beim Attach nur "der letzte Schreibvorgang gewinnt" wollen, spart Ihnen der eingebaute `UpdatingIdentityResolutionInterceptor` das Schreiben.

**Interception des Ausdrucksbaums ist das letzte Mittel.** `IQueryExpressionInterceptor` ist mächtig, und das Beispiel der Dokumentation selbst, das eine stabile Zweitsortierung ergänzt, endet mit der Feststellung, dass ein direktes `.ThenBy(e => e.Id)` an der Abfrage einfacher, verständlicher und immer korrekt ist. Das ist der richtige Instinkt. Ein `ExpressionVisitor`, der still jede Abfrage der Anwendung umschreibt, ist ein Debugging-Problem, das Sie für immer erben.

**Interceptors laufen in einer Reihenfolge und sehen die Entscheidungen der anderen.** Von Erweiterungen eingebrachte Interceptors laufen zuerst, in der Auflösungsreihenfolge des Service Providers, danach die der Anwendung. Ein späterer Interceptor kann über `InterceptionResult<T>.HasResult` prüfen, ob ein früherer die Operation bereits unterdrückt hat, was beim Stapeln wichtig wird.

**Eine EF Core 11 Ergänzung, die man kennen sollte.** `ChangeTracker.GetEntriesForState(added, modified, deleted, unchanged)` ist ein zustandsgefilterter Enumerator, der den impliziten `DetectChanges` Durchlauf von `Entries()` überspringt. Er existiert genau für heiße Pfade wie `SaveChanges` Interceptors und Audit-Hooks, in denen derselbe Durchlauf sonst zweimal pro Speichervorgang läuft. Details und Abwägung stehen in [EF Core 11 ergänzt GetEntriesForState](/de/2026/04/efcore-11-changetracker-getentriesforstate/).

## Die Kurzfassung

Schreiben Sie einen Interceptor, wenn Sie *verändern* müssen, was EF tut, über jeden Kontext hinweg, an einer Stelle, die das Modell nicht ausdrücken kann. Nehmen Sie Protokollierung, wenn Sie sehen wollen, was EF getan hat, .NET Events für einen einfachen synchronen Callback an einem Kontext, einen Diagnostic Listener für prozessweite Beobachtung und einen Query-Filter oder Value Converter, wenn der Belang eigentlich zum Modell gehört. Implementieren Sie beide Hälften, synchron und asynchron, jedes Paars, das Sie überschreiben, halten Sie Singleton-Interceptors zustandslos und geteilt, und denken Sie daran: Was `SaveChanges` umgeht, umgeht auch Ihren `ISaveChangesInterceptor`.

## Verwandt

- [EF Core 11 Interceptors für Auditing verwenden](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 ergänzt GetEntriesForState, um DetectChanges zu überspringen](/de/2026/04/efcore-11-changetracker-getentriesforstate/)
- [Benannte Query-Filter für Soft Delete und Mandantenfähigkeit in EF Core 11 verwenden](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwenden](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Quellen

- [Interceptors -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)
- [.NET events -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/events)
- [Using diagnostic listeners -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/diagnostic-listeners)
- [IIdentityResolutionInterceptor Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.iidentityresolutioninterceptor)
- [CommandExecutedEventData Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.commandexecutedeventdata)
- [What's New in EF Core 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Identity resolution interceptor is not called for query results -- dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574)
