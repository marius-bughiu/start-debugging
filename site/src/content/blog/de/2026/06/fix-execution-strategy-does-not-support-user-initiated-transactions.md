---
title: "Lösung: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions"
description: "EnableRetryOnFailure steht im Konflikt mit BeginTransaction. Kapseln Sie die gesamte Transaktion in db.Database.CreateExecutionStrategy().ExecuteAsync(...), damit sie als eine Einheit wiederholt wird."
pubDate: 2026-06-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "de"
translationOf: "2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions"
translatedBy: "claude"
translationDate: 2026-06-10
---

Die Lösung: Sie haben die Verbindungsresilienz mit `EnableRetryOnFailure()` aktiviert und dann mit `BeginTransaction()` oder `BeginTransactionAsync()` eine eigene Transaktion geöffnet. Eine wiederholende Ausführungsstrategie kann eine Transaktion, die sie nicht selbst gestartet hat, nicht erneut abspielen, daher verweigert sie das von vornherein. Holen Sie die Strategie über `db.Database.CreateExecutionStrategy()` und führen Sie die gesamte Transaktion innerhalb von `strategy.ExecuteAsync(...)` aus. Der gesamte Delegate wird zu einer einzigen wiederholbaren Einheit.

```text
System.InvalidOperationException: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions. Use the execution strategy returned by 'DbContext.Database.CreateExecutionStrategy()' to execute all the operations in the transaction as a retriable unit.
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, Func`4 operation, Func`4 verifySucceeded, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerExecutionStrategy.Execute[TState,TResult](...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.BeginTransaction()
```

Diese Anleitung ist für .NET 11 und `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0 geschrieben, aber die Meldung und die zugrunde liegende Regel sind seit EF Core 1.1 stabil, als die Verbindungsresilienz eingeführt wurde. Wenn Sie EF Core 6, 8 oder 9 verwenden, gilt alles Folgende unverändert. Der Typname in der Meldung hängt von Ihrem Provider ab: SQL Server wirft `SqlServerRetryingExecutionStrategy`, Npgsql wirft `NpgsqlRetryingExecutionStrategy`, der MySQL-Provider von Pomelo wirft seinen eigenen. Die Lösung ist für alle identisch.

## Warum eine wiederholende Strategie Ihre Transaktion verweigert

Verbindungsresilienz funktioniert, indem jede Datenbankoperation in eine Wiederholungsschleife gekapselt wird. Wenn Sie `EnableRetryOnFailure()` aufrufen, tauscht EF Core die Ausführungsstrategie gegen eine aus, die weiß, welche SQL-Server-Fehlernummern transient sind (Deadlock-Opfer, Verbindungsabbrüche, Azure-SQL-Drosselung), und wiederholt diese Operationen mit exponentiellem Backoff. Das Schlüsselwort ist *jede*. Jede Abfrage und jeder Aufruf von `SaveChangesAsync()` wird zu seiner eigenen wiederholbaren Einheit. Schlägt eine transient fehl, spielt die Strategie genau diese eine Operation erneut ab.

Eine Transaktion durchbricht dieses Modell. Wenn Sie `BeginTransactionAsync()` aufrufen, teilen Sie EF Core mit, dass mehrere Operationen eine einzige atomare Gruppe bilden. Bricht die Verbindung mittendrin ab, ist das Wiederholen einer einzelnen Anweisung sinnlos: Der Server hat die Transaktion bereits zurückgerollt, und das erneute Abspielen eines einzelnen `INSERT` innerhalb einer Transaktion, die nicht mehr existiert, würde fehlschlagen oder, schlimmer, eine unvollständige Arbeit bestätigen. Die Ausführungsstrategie kann nicht wissen, was Ihre Transaktion enthalten sollte, also kann sie sie nicht korrekt abspielen.

Anstatt fehlerhaft zu wiederholen und Datenbeschädigung zu riskieren, wirft EF Core die Ausnahme in dem Moment, in dem Sie eine benutzerdefinierte Transaktion starten möchten, während eine wiederholende Strategie aktiv ist. Die offizielle Anleitung ist deutlich, was auf dem Spiel steht: Ein naiver Wiederholungsversuch über eine Commit-Grenze hinweg "could lead to data corruption", wenn die Operation vom Speicherzustand abhängt. Die Ausnahme ist ein Schutzgeländer, kein Bug.

## Der kleinste Code, der den Fehler auslöst

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(
        connectionString,
        sql => sql.EnableRetryOnFailure())); // <-- resiliency on

// ...somewhere in a service:
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    await using var tx = await _db.Database.BeginTransactionAsync(); // <-- throws here

    var from = await _db.Accounts.FindAsync(fromId);
    var to = await _db.Accounts.FindAsync(toId);
    from!.Balance -= amount;
    to!.Balance += amount;

    await _db.SaveChangesAsync();
    await tx.CommitAsync();
}
```

Die Zeile `BeginTransactionAsync()` gibt niemals eine Transaktion zurück. EF Core prüft zuerst, ob eine wiederholende Strategie aktiv ist, und wirft die `InvalidOperationException`. Beachten Sie, dass Sie `BeginTransaction` nicht explizit aufrufen müssen, um in diese Falle zu geraten: Alles, was eine Benutzertransaktion öffnet, zählt, einschließlich eines `TransactionScope`, den Sie selbst erstellt haben.

## Lösung 1: Kapseln Sie die Transaktion in die Ausführungsstrategie

Dies ist die kanonische Lösung und die, die Microsoft dokumentiert. Fordern Sie vom Kontext seine Ausführungsstrategie an und übergeben Sie ihr dann einen Delegate, der die gesamte Transaktion enthält, von `BeginTransactionAsync` bis `CommitAsync`. Tritt irgendwo im Inneren ein transienter Fehler auf, führt die Strategie den gesamten Delegate erneut aus, samt Transaktion.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    var strategy = _db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var from = await _db.Accounts.FindAsync(fromId);
        var to = await _db.Accounts.FindAsync(toId);
        from!.Balance -= amount;
        to!.Balance += amount;

        await _db.SaveChangesAsync();
        await tx.CommitAsync();
    });
}
```

`CreateExecutionStrategy()` gibt dieselbe wiederholende Strategie zurück, die EF Core aus Ihrem `EnableRetryOnFailure()`-Aufruf konfiguriert hat. Ist die Resilienz deaktiviert, gibt es eine wirkungslose Strategie zurück, die den Delegate genau einmal ausführt, daher ist dieser Code auch in Projekten ohne aktivierte Wiederholungen sicher zu schreiben. Das macht `strategy.ExecuteAsync` zu einer sinnvollen Standardkapselung für jede explizite Transaktion, nicht nur für solche in Azure-gehosteten Anwendungen.

Es gibt eine Regel, die Entwickler überrascht: Der Delegate muss idempotent genug sein, um mehrmals von vorne auszuführen. Lesen Sie keinen Wert vor dem Aufruf von `strategy.ExecuteAsync`, verändern ihn und verlassen sich innerhalb der Wiederholung auf diese Lesung. Ziehen Sie jeden Lese- und Schreibvorgang in den Delegate, damit eine Wiederholung bei null beginnt.

## Lösung 2: ExecuteInTransactionAsync, wenn Sie den Commit überprüfen müssen

`strategy.ExecuteAsync` deckt den häufigen Fall ab, hat aber einen blinden Fleck. Bricht die Verbindung ab, *während der Commit in Bearbeitung ist*, weiß die Strategie nicht, ob der Server tatsächlich bestätigt hat. Standardmäßig nimmt sie einen Rollback an und spielt erneut ab, was eine doppelte Zeile einfügen kann, wenn Sie speichergenerierte Schlüssel verwenden.

`ExecuteInTransactionAsync` schließt diese Lücke. Es beginnt und bestätigt die Transaktion für Sie und akzeptiert einen `verifySucceeded`-Delegate, der nach einem transienten Commit-Fehler ausgeführt wird, um zu prüfen, ob die Arbeit angekommen ist.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

var blog = new Blog { Url = "https://startdebugging.net" };
_db.Blogs.Add(blog);

await strategy.ExecuteInTransactionAsync(
    _db,
    operation: (ctx, ct) => ctx.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct),
    verifySucceeded: (ctx, ct) =>
        ctx.Blogs.AsNoTracking().AnyAsync(b => b.BlogId == blog.BlogId, ct));

_db.ChangeTracker.AcceptAllChanges();
```

Zwei Details sind hier wichtig. `SaveChangesAsync` wird mit `acceptAllChangesOnSuccess: false` aufgerufen, damit die nachverfolgten Entitäten im Zustand `Added` bleiben, bis Sie wissen, dass der Commit angekommen ist; genau das ermöglicht eine saubere Wiederholung. Anschließend rufen Sie `ChangeTracker.AcceptAllChanges()` einmal auf, nachdem die Strategie zurückgekehrt ist. Die `verifySucceeded`-Abfrage verwendet `AsNoTracking()`, damit die Überprüfungslesung nicht mit den noch ausstehenden Entitäten im Change-Tracker kollidiert.

Wenn Ihnen der seltene Fehler mitten im Commit wirklich egal ist, lautet Microsofts Option "fast nichts tun", speichergenerierte Schlüssel zu vermeiden (verwenden Sie einen clientseitigen `Guid`), damit eine blinde Wiederholung eine Primärschlüsselverletzung wirft, statt stillschweigend Daten zu duplizieren. Dann genügt Lösung 1.

## Umgebungstransaktionen und TransactionScope

Dieselbe Kapselung funktioniert mit `TransactionScope`, auch wenn er zwei Kontexte umspannt. Öffnen Sie den Scope und rufen Sie `Complete()` innerhalb des Delegates auf.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    using var scope = new TransactionScope(
        TransactionScopeAsyncFlowOption.Enabled); // required for await inside

    _db.Orders.Add(order);
    await _db.SaveChangesAsync();

    await _auditDb.SaveChangesAsync();

    scope.Complete();
});
```

Ohne `TransactionScopeAsyncFlowOption.Enabled` fließt die Umgebungstransaktion nicht über das `await` hinweg, und Sie erhalten eine separate, schwer zu diagnostizierende `TransactionAbortedException`. Das ist ein anderer Fehler, taucht aber genau im selben Code-Pfad auf, daher setzen Sie das Flag immer, wenn Sie `TransactionScope` mit asynchronen EF-Core-Aufrufen mischen.

## Fallstricke und ähnliche Fehler

**Er kann bei einer einfachen Abfrage auftreten, nicht nur bei einem Schreibvorgang.** Das GitHub-Issue [dotnet/efcore#29396](https://github.com/dotnet/efcore/issues/29396) verfolgt Berichte, in denen die Meldung bei einem einfachen `SELECT` erscheint. Die übliche Ursache ist ein äußerer `TransactionScope`, den Sie vergessen haben (oft in einem Basis-Repository, einer Testvorrichtung oder einem Unit-of-Work-Wrapper geöffnet), sodass die "einfache" Abfrage tatsächlich innerhalb einer Benutzertransaktion läuft. Suchen Sie in Ihrem Aufrufstapel nach jedem `BeginTransaction` oder `new TransactionScope` oberhalb der fehlschlagenden Zeile.

**Azure SQL kann dies aktivieren, ohne dass Sie es verlangen.** Etwa ab EF Core 8 begann der SQL-Server-Provider, standardmäßig eine wiederholende Strategie zu verwenden, wenn er eine Azure-SQL-Verbindungszeichenfolge erkennt (siehe [dotnet/efcore#32165](https://github.com/dotnet/efcore/issues/32165)). Code, der lokal gegen LocalDB funktionierte, schlägt plötzlich in Azure fehl, weil die Resilienz nun aktiv ist. Wenn Sie dies nur in Ihrer Cloud-Umgebung sehen, ist das der Grund. Die Lösung ist dieselbe Kapselung; Sie müssen den Standard nicht deaktivieren.

**Löschen Sie `EnableRetryOnFailure` nicht einfach, damit der Fehler verschwindet.** Das beseitigt den Fehler, indem es die Resilienz beseitigt, die Sie vermutlich wollten. Kapseln Sie stattdessen die Transaktion. Wenn Sie die Resilienz wirklich für eine isolierte Operation umgehen müssen, ist der sauberere Ausweg, der in [dotnet/efcore#24922](https://github.com/dotnet/efcore/issues/24922) diskutiert wird, einen zweiten, separat konfigurierten Kontext ohne Wiederholungen zu verwenden, nicht sie aus Ihrem Hauptkontext zu entfernen.

**Dies ist nicht dasselbe wie "A second operation was started on this context instance".** Dieser Fehler betrifft die gleichzeitige Verwendung eines `DbContext`, nicht Transaktionen und Wiederholungen. Wenn Ihre Meldung von Nebenläufigkeit statt von Ausführungsstrategien spricht, lesen Sie die Lösung für [eine zweite auf diesem Kontext gestartete Operation](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/).

## Verwandt

- [Lösung: SqlException: Timeout expired während EF-Core-Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) behandelt die Familie transienter Fehler von der Migrationsseite.
- [Lösung: ObjectDisposedException: Cannot access a disposed context instance](/de/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) ist die andere EF-Core-Lebenszyklusfalle, die asynchronen Code trifft.
- [EF Core ExecuteUpdate vs. Entitäten laden und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) zeigt, wann Sie eine explizite Transaktion ganz vermeiden können.
- [EF-Core-11-Interceptoren für die Überwachung verwenden](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/), um sich in die Speicher-Pipeline einzuklinken, ohne manuelle Transaktionen.
- [Von EF Core 6 zu EF Core 11 migrieren: Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) weist neben anderen Überraschungen auf den Azure-SQL-Wiederholungsstandard hin.

## Quellen

- [Connection Resiliency, EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) - die kanonische Anleitung zu `CreateExecutionStrategy`, `ExecuteInTransactionAsync` und dem Idempotenzproblem.
- [Implement resilient Entity Framework Core SQL connections](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/implement-resilient-applications/implement-resilient-entity-framework-core-sql-connections) - die Sicht der .NET-Microservices-Architektur auf dasselbe Muster.
- [dotnet/efcore#32165: Azure-SQL-Wiederholungsstrategie-Standard](https://github.com/dotnet/efcore/issues/32165)
- [dotnet/efcore#29396: Fehler bei einem einfachen SELECT](https://github.com/dotnet/efcore/issues/29396)
- [dotnet/efcore#24922: konfigurierte Ausführungsstrategie aussetzen](https://github.com/dotnet/efcore/issues/24922)
