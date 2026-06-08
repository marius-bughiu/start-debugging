---
title: "EF Core 11 Interceptors für Auditing verwenden"
description: "Stempeln Sie CreatedBy/ModifiedOn-Spalten und schreiben Sie einen vollständigen Änderungsverlauf mit einem ISaveChangesInterceptor in EF Core 11, inklusive DI-Lebensdauer, aktuellem Benutzer und ExecuteUpdate-Fallstricken."
pubDate: 2026-06-08
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "de"
translationOf: "2026/06/how-to-use-ef-core-11-interceptors-for-auditing"
translatedBy: "claude"
translationDate: 2026-06-08
---

Um Änderungen in EF Core 11 zu auditieren, implementieren Sie `ISaveChangesInterceptor` (oder leiten Sie von der No-op-Basisklasse `SaveChangesInterceptor` ab), überschreiben Sie `SavingChangesAsync`, um `context.ChangeTracker.Entries()` zu durchlaufen, bevor der Schreibvorgang die Datenbank erreicht, und registrieren Sie ihn mit `optionsBuilder.AddInterceptors(...)`. Innerhalb des Interceptors stempeln Sie entweder Audit-Spalten (`CreatedBy`, `CreatedOnUtc`, `ModifiedBy`, `ModifiedOnUtc`) auf Entitäten, die ein `IAuditable`-Markierungsinterface implementieren, oder Sie bauen pro geänderter Eigenschaft eine separate Änderungsverlaufszeile auf. Das Ganze läuft innerhalb derselben Transaktion wie Ihr `SaveChanges`, sodass ein fehlgeschlagenes Audit den fachlichen Schreibvorgang mit zurückrollt. Dieser Artikel verwendet .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) und C# 14.

Interceptors sind hier genau deshalb das richtige Werkzeug, weil sie an dem Engpass sitzen, den jeder Schreibvorgang passieren muss. Sie können nicht vergessen, sie aufzurufen, Sie können sie nicht über eine vergessene Repository-Methode umgehen, und sie sehen den vollständig befüllten `ChangeTracker` mit Original- und aktuellen Werten für jede Eigenschaft. Das sind genau die Daten, die ein Audit-Log benötigt.

## Warum ein Interceptor das Überschreiben von SaveChanges schlägt

Die landläufige Antwort auf "stemple meine Zeitstempel" lautet, `SaveChanges` auf einem Basis-`DbContext` zu überschreiben:

```csharp
// The pattern people reach for first -- it works, but it has problems
public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<IAuditable>())
    {
        if (entry.State == EntityState.Added)
            entry.Entity.CreatedOnUtc = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

Das koppelt das Auditing an Ihre `DbContext`-Subklasse. Sobald Sie einen zweiten Context haben, eine Bibliothek, die ihren eigenen Context mitliefert, oder einen Test, der einen blanken `DbContext` verwendet, verschwindet das Verhalten stillschweigend. Es zwingt Sie außerdem, sowohl `SaveChanges` als auch `SaveChangesAsync` von Hand zu überschreiben, und es gibt Ihnen keinen sauberen Ort, um den aktuellen Benutzer einzuschleusen, ohne den Context mit HTTP-Belangen vertraut zu machen.

Ein `ISaveChangesInterceptor` ist eine separate, testbare Klasse mit nur einer Verantwortung. Sie registrieren ihn einmal, er gilt für jeden Context, an den er angehängt ist, und EF Core ruft automatisch die synchrone oder asynchrone Variante auf, abhängig davon, welche `SaveChanges`-Überladung der Aufrufer verwendet hat. Die offiziellen EF-Core-Docs beschreiben Interceptors als den unterstützten Hook für genau diese Art von Querschnittsbelang, siehe den [Microsoft-Learn-Leitfaden zu Interceptors](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors).

## Die Interceptor-Oberfläche, die Sie tatsächlich nutzen

`ISaveChangesInterceptor` definiert sechs Methoden, drei synchrone und drei asynchrone:

- `SavingChanges` / `SavingChangesAsync` -- feuern, bevor EF das SQL generiert und sendet. Hier gehört die Audit-Arbeit hin, weil der `ChangeTracker` noch widerspiegelt, was die Anwendung gesetzt hat.
- `SavedChanges` / `SavedChangesAsync` -- feuern nach einem erfolgreichen Schreibvorgang. Verwenden Sie sie, um datenbankgenerierte Werte (Identity-Schlüssel, berechnete Spalten) zu erfassen, die vor dem Schreibvorgang nicht bekannt waren.
- `SaveChangesFailed` / `SaveChangesFailedAsync` -- feuern, wenn der Schreibvorgang eine Ausnahme wirft, sodass Sie eine in Bearbeitung befindliche Audit-Zeile als fehlgeschlagen markieren können.

Sie implementieren das Interface selten direkt. Leiten Sie von `SaveChangesInterceptor` ab, das No-op-virtuelle Implementierungen aller sechs Methoden bereitstellt, und überschreiben Sie nur, was Sie benötigen.

```csharp
// .NET 11, EF Core 11, C# 14
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class AuditableEntityInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    private static void StampAuditColumns(DbContext? context)
    {
        if (context is null) return;
        // implementation below
    }
}
```

Zwei Details, über die Leute stolpern. Erstens ist `eventData.Context` nullbar, also prüfen Sie es ab. Zweitens müssen Sie sowohl `SavingChanges` als auch `SavingChangesAsync` überschreiben; EF Core leitet das eine nicht an das andere weiter. Wenn Sie nur die asynchrone Version überschreiben und irgendwo in Ihrem Codepfad das synchrone `SaveChanges()` aufgerufen wird, läuft Ihre Audit-Logik nie. Beide mit einer gemeinsamen privaten Methode zu überschreiben, ist die sichere Standardlösung. Wenn Sie alles auf den asynchronen Pfad zwingen wollen, werfen Sie `NotSupportedException` aus der synchronen Überschreibung, sodass ein verirrter synchroner Aufruf laut scheitert, statt das Audit stillschweigend zu überspringen.

Der Rückgabewert `InterceptionResult<int>` ist die Art, wie Sie den Schreibvorgang unterdrücken oder ersetzen würden. Beim Auditing wollen Sie das fast nie, daher ist es korrekt, das eingehende `result` direkt durchzureichen (was `base.Saving...` tut).

## Audit-Spalten auf auditierbaren Entitäten stempeln

Das leichtgewichtige Muster: ein Markierungsinterface plus Shadow- oder echte Eigenschaften. Definieren Sie den Vertrag einmal.

```csharp
// .NET 11, C# 14
public interface IAuditable
{
    DateTime CreatedOnUtc { get; set; }
    string? CreatedBy { get; set; }
    DateTime? ModifiedOnUtc { get; set; }
    string? ModifiedBy { get; set; }
}
```

Füllen Sie nun `StampAuditColumns` aus. Der entscheidende Aufruf ist `ChangeTracker.Entries<IAuditable>()`, der nur die getrackten Entitäten zurückgibt, die das Interface implementieren, bereits partitioniert nach `EntityState`.

```csharp
// .NET 11, EF Core 11, C# 14
private void StampAuditColumns(DbContext? context)
{
    if (context is null) return;

    var now = _timeProvider.GetUtcNow().UtcDateTime; // TimeProvider, .NET 8+
    var user = _currentUser.UserId ?? "system";

    foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
    {
        switch (entry.State)
        {
            case EntityState.Added:
                entry.Entity.CreatedOnUtc = now;
                entry.Entity.CreatedBy = user;
                break;

            case EntityState.Modified:
                entry.Entity.ModifiedOnUtc = now;
                entry.Entity.ModifiedBy = user;
                break;

            case EntityState.Deleted:
                // optional: convert hard delete to soft delete here
                break;
        }
    }
}
```

Eine erwähnenswerte Feinheit: Eine Entität, deren einzige geänderte Eigenschaft die Zugehörigkeit zu einer Owned-Collection ist oder deren Änderung eine verwandte Entität betrifft, kann hier als `Modified` auftauchen. Wenn Sie "nur geändert, weil ein Kind sich geändert hat" ignorieren wollen, können Sie zusätzlich `entry.Properties.Any(p => p.IsModified)` prüfen. Für die meisten Anwendungsfälle von Audit-Spalten ist die einfache `State`-Prüfung das, was Sie wollen.

Injizieren Sie `TimeProvider`, statt direkt `DateTime.UtcNow` aufzurufen. Das macht den Interceptor mit einer gefälschten Uhr unit-testbar, was wichtig ist, weil der Zeitstempel das ist, was Sie in Tests am ehesten überprüfen wollen.

## Den Interceptor mit der richtigen Lebensdauer registrieren

Hier ist der Fallstrick, der die meisten Bug-Reports erzeugt. Der Interceptor benötigt den aktuellen Benutzer, der üblicherweise aus `IHttpContextAccessor` stammt. Das macht den Interceptor effektiv scoped (pro Anfrage). Aber das naive `AddInterceptors(new AuditableEntityInterceptor())` erzeugt eine singleton-artige Instanz ohne DI.

Registrieren Sie den Interceptor in DI und lösen Sie ihn beim Konfigurieren des Context auf:

```csharp
// .NET 11, ASP.NET Core 11 -- Program.cs
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, HttpContextCurrentUser>();
builder.Services.AddScoped<AuditableEntityInterceptor>();

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(
        sp.GetRequiredService<AuditableEntityInterceptor>());
});
```

Weil `AddDbContext` standardmäßig scoped ist und der Konfigurations-Callback den anfrage-scoped `IServiceProvider` erhält, gibt das Auflösen eines scoped Interceptors hier jeder Anfrage ihre eigene Instanz mit dem korrekten `ICurrentUser`. Wenn Sie den Interceptor als Singleton registrieren, während er von `IHttpContextAccessor` abhängt, erfassen Sie entweder einen veralteten `HttpContext` oder lösen die Validierung "Cannot consume scoped service from singleton" aus. Wenn Sie genau diese Meldung gesehen haben, geht der [Fix für Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) durch, warum der Container sie ablehnt.

Lesen Sie den Benutzer über den Accessor in dem Moment, in dem `SavingChanges` läuft, nicht im Konstruktor, sodass die Abfrage immer die aktive Anfrage widerspiegelt:

```csharp
// .NET 11, C# 14
public sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

## Einen vollständigen Änderungsverlauf schreiben, nicht nur Zeitstempel

Das Stempeln von Spalten beantwortet "wer hat diese Zeile wann angefasst." Ein Änderungsverlauf beantwortet "was genau hat sich geändert." Dafür durchlaufen Sie die geänderten Eigenschaften und erfassen Original- gegenüber aktuellen Werten. EF Core gibt Ihnen beide über `PropertyEntry`.

```csharp
// .NET 11, EF Core 11, C# 14
private static List<AuditTrail> BuildTrail(DbContext context, DateTime now, string user)
{
    var trail = new List<AuditTrail>();

    foreach (var entry in context.ChangeTracker.Entries())
    {
        if (entry.Entity is AuditTrail) continue; // never audit the audit table
        if (entry.State is EntityState.Detached or EntityState.Unchanged) continue;

        var record = new AuditTrail
        {
            TableName = entry.Metadata.GetTableName(),
            Action = entry.State.ToString(),
            UserId = user,
            TimestampUtc = now,
            Changes = new Dictionary<string, object?>()
        };

        foreach (var prop in entry.Properties)
        {
            if (entry.State == EntityState.Added)
                record.Changes[prop.Metadata.Name] = prop.CurrentValue;
            else if (entry.State == EntityState.Modified && prop.IsModified)
                record.Changes[prop.Metadata.Name] =
                    new { Old = prop.OriginalValue, New = prop.CurrentValue };
            else if (entry.State == EntityState.Deleted)
                record.Changes[prop.Metadata.Name] = prop.OriginalValue;
        }

        trail.Add(record);
    }

    return trail;
}
```

Serialisieren Sie `Changes` in eine JSON-Spalte und Sie haben eine abfragbare Historie. Beachten Sie, dass `entry.Properties` nur skalare Eigenschaften aufzählt; Navigationen und Owned Types benötigen `entry.References` und `entry.Collections`, falls sie Sie interessieren.

## Das Problem temporärer Schlüssel und warum es SavedChanges gibt

Bei eingefügten Zeilen mit datenbankgenerierten Schlüsseln ist `prop.CurrentValue` während `SavingChanges` ein temporärer Platzhalter, nicht der echte Identity-Wert. EF Core hat noch nicht mit der Datenbank gesprochen. Wenn Ihr Audit-Verlauf den Primärschlüssel neuer Zeilen erfasst, schreibt das Erfassen in `SavingChanges` den falschen Wert.

Das ist der ganze Grund, warum es `SavedChanges` gibt. Das saubere Muster ist zweiphasig: Bauen Sie die Audit-Zeilen in `SavingChanges` auf, halten Sie sie auf der Interceptor-Instanz, lösen Sie dann die jetzt echten Schlüsselwerte auf und persistieren Sie den Verlauf in `SavedChangesAsync`.

```csharp
// .NET 11, EF Core 11, C# 14
private readonly List<(EntityEntry Entry, AuditTrail Record)> _pending = [];

public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
    DbContextEventData eventData, InterceptionResult<int> result,
    CancellationToken ct = default)
{
    _pending.Clear();
    var ctx = eventData.Context!;
    foreach (var entry in ctx.ChangeTracker.Entries())
        // ... stash (entry, partial record) into _pending
    return base.SavingChangesAsync(eventData, result, ct);
}

public override async ValueTask<int> SavedChangesAsync(
    SaveChangesCompletedEventData eventData, int result,
    CancellationToken ct = default)
{
    foreach (var (entry, record) in _pending)
        record.EntityId = entry.Property("Id").CurrentValue?.ToString();

    // persist _pending to the audit store now that keys are real
    return await base.SavedChangesAsync(eventData, result, ct);
}
```

Weil der Interceptor jetzt Zustand pro Save in `_pending` hält, muss er scoped oder transient sein, niemals ein geteilter Singleton. Ein Singleton würde `_pending` über gleichzeitige Anfragen hinweg verschränken und den Verlauf beschädigen. Das ist ein weiterer Grund, warum die obige DI-Registrierung `AddScoped` verwendet.

Wenn Sie den `ChangeTracker` in einem Hot Path durchlaufen und `DetectChanges` im Profiling auftaucht, überspringt EF Cores [`GetEntriesForState`-API den vollständigen DetectChanges-Scan](/de/2026/04/efcore-11-changetracker-getentriesforstate/), wenn Sie nur Entitäten in einem bestimmten Zustand benötigen.

## Der Fallstrick, der Ihr Audit stillschweigend überspringt: ExecuteUpdate und ExecuteDelete

`SaveChangesInterceptor` feuert nur für `SaveChanges` und `SaveChangesAsync`. Die Bulk-Operationen `ExecuteUpdate` und `ExecuteDelete` übersetzen direkt in eine einzige SQL-Anweisung und laden niemals Entitäten in den `ChangeTracker`, sodass sie Ihren Auditing-Interceptor vollständig umgehen. Das ist beabsichtigt und es ist eine häufige Quelle der Verwirrung "warum ist diese Änderung nicht im Audit-Log."

```csharp
// This UPDATE is NOT audited -- it never touches the ChangeTracker
await db.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled));
```

Wenn ein Codepfad auditiert werden muss, leiten Sie ihn entweder über getrackte Entitäten und `SaveChanges`, oder auditieren Sie die Bulk-Operation explizit an der Aufrufstelle. Die Abwägungen zwischen den beiden Schreibstilen behandelt der Leitfaden zu [ExecuteUpdate und ExecuteDelete für Bulk-Writes in EF Core 11](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Wählen Sie den Bulk-Pfad für den Durchsatz, akzeptieren Sie, dass er außerhalb des Interceptors liegt, und machen Sie das zu einer expliziten Entscheidung statt zu einer Überraschung.

## Soft Deletes aus demselben Hook

Weil der Interceptor `EntityState.Deleted`-Einträge sieht, bevor das SQL generiert wird, ist er der natürliche Ort, um ein Hard Delete in ein Soft Delete umzuwandeln. Kippen Sie den Zustand auf `Modified` und setzen Sie Ihr Flag:

```csharp
// .NET 11, EF Core 11, C# 14
case EntityState.Deleted when entry.Entity is ISoftDeletable sd:
    entry.State = EntityState.Modified;
    sd.IsDeleted = true;
    sd.DeletedOnUtc = now;
    sd.DeletedBy = user;
    break;
```

Kombinieren Sie das mit einem globalen Query-Filter (`modelBuilder.Entity<T>().HasQueryFilter(e => !e.IsDeleted)`), sodass soft-gelöschte Zeilen aus normalen Abfragen verschwinden. Denken Sie nur daran, dass der Interceptor und der Filter zwei Hälften eines Features sind: Der Interceptor schreibt das Flag, der Filter verbirgt es.

## Überprüfen, dass es funktioniert

Interceptors sind leicht zu unit-testen, weil sie einfache Klassen sind. Konstruieren Sie einen mit einem gefälschten `TimeProvider` und `ICurrentUser`, fügen Sie eine Entität zu einem mit dem Interceptor konfigurierten Context hinzu, rufen Sie `SaveChangesAsync` auf und überprüfen Sie die gestempelten Werte. Für End-to-End-Abdeckung übt ein In-Memory- oder SQLite-Context mit dem über `AddInterceptors` registrierten Interceptor die echte EF-Pipeline aus. Wenn Sie dieses Test-Harness um einen gefälschten Context herum bauen, finden sich die Regeln, um das Change Tracking intakt zu halten, in [wie man DbContext mockt, ohne das Change Tracking zu beschädigen](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/), und wenn Ihre Audit-Schreibvorgänge anfangen, über gleichzeitige Context-Nutzung zu werfen, siehe [a second operation was started on this context instance](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/).

Die Kurzfassung: Leiten Sie von `SaveChangesInterceptor` ab, überschreiben Sie sowohl `SavingChanges` als auch `SavingChangesAsync`, durchlaufen Sie `ChangeTracker.Entries()` für die Daten, registrieren Sie den Interceptor als scoped über DI, damit er den aktuellen Benutzer lesen kann, verwenden Sie `SavedChangesAsync`, wenn Sie echte Schlüssel benötigen, und denken Sie daran, dass `ExecuteUpdate`/`ExecuteDelete` das Ganze umgehen. Das deckt die große Mehrheit realer .NET-Auditing-Anforderungen ab, ohne dass auch nur eine Zeile Audit-Code in Ihre Domänenlogik durchsickert.

Primärquelle: die [EF-Core-Interceptors-Dokumentation](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors) auf Microsoft Learn, die das kanonische Beispiel mit separater Audit-Datenbank enthält, auf dem dieser Artikel aufbaut.
