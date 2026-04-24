---
title: "Wie man IAsyncEnumerable<T> mit EF Core 11 verwendet"
description: "EF Core 11 Queries implementieren IAsyncEnumerable<T> direkt. So streamen Sie Zeilen mit await foreach, wann Sie es gegenüber ToListAsync bevorzugen sollten, und die Fallstricke rund um Verbindungen, Tracking und Cancellation."
pubDate: 2026-04-22
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "de"
translationOf: "2026/04/how-to-use-iasyncenumerable-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

Wenn Sie eine Query in EF Core 11 haben, die viele Zeilen zurückgibt, müssen Sie nicht das gesamte Ergebnis in einer `List<T>` materialisieren, bevor Sie mit der Verarbeitung beginnen. Ein EF Core `IQueryable<T>` implementiert bereits `IAsyncEnumerable<T>`, sodass Sie direkt per `await foreach` darüber iterieren können, und jede Zeile wird ausgegeben, sobald die Datenbank sie produziert. Kein `ToListAsync` nötig, kein eigener Iterator, kein `System.Linq.Async`-Paket. Das ist die kurze Antwort. Dieser Beitrag geht durch die Mechanik, die Versionsdetails für EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14), und die Fallstricke, die Leute beißen, die Streaming auf eine Codebase schrauben, die nicht dafür ausgelegt war.

## Warum EF Core `IAsyncEnumerable<T>` überhaupt anbietet

Die Query-Pipeline von EF Core ist um einen Data Reader gebaut. Wenn Sie `ToListAsync()` aufrufen, öffnet EF Core eine Verbindung, führt das Kommando aus und zieht Zeilen aus dem Reader in eine gepufferte Liste, bis der Reader erschöpft ist, dann schließt es alles. Sie bekommen eine `List<T>`, was bequem ist, aber das gesamte Ergebnis lebt jetzt im Speicher Ihres Prozesses, und die erste Zeile ist für Ihren Code erst sichtbar, nachdem die letzte Zeile gelesen wurde.

`IAsyncEnumerable<T>` dreht das um. Sie fragen die Zeilen einzeln ab. EF Core öffnet die Verbindung, führt das Kommando aus, und liefert die erste materialisierte Entität, sobald die erste Zeile über die Leitung kommt. Ihr Code fängt sofort an zu arbeiten. Der Speicher bleibt auf das begrenzt, was Ihr Schleifenrumpf festhält. Für Berichte, Exporte und Pipelines, die Zeilen transformieren, bevor sie anderswohin geschrieben werden, ist das genau das gewünschte Muster.

Da `DbSet<TEntity>` und der `IQueryable<TEntity>`, der von einer LINQ-Kette zurückgegeben wird, beide `IAsyncEnumerable<TEntity>` implementieren, brauchen Sie keinen expliziten `AsAsyncEnumerable()`-Aufruf. Die Schnittstelle ist da. Die async-foreach-Maschinerie findet sie.

## Das minimale Beispiel

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();

await foreach (var invoice in db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt))
{
    await ProcessAsync(invoice);
}
```

Das ist die ganze Sache. Kein `ToListAsync`. Keine Zwischenallokation. Der darunterliegende `DbDataReader` bleibt für die Dauer der Schleife offen. Jede Iteration zieht eine weitere Zeile von der Leitung, materialisiert die `Invoice` und übergibt sie dem Schleifenrumpf.

Vergleichen Sie mit der listenbasierten Version:

```csharp
// Buffers every row into memory before the first ProcessAsync call
var invoices = await db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt)
    .ToListAsync();

foreach (var invoice in invoices)
{
    await ProcessAsync(invoice);
}
```

Bei 50 Zeilen ist der Unterschied unsichtbar. Bei 5 Millionen Zeilen beendet die Streaming-Version die erste Invoice, bevor die gepufferte Version die Liste fertig allokiert hat.

## Einen Cancellation-Token richtig weitergeben

Die `IQueryable<T>.GetAsyncEnumerator(CancellationToken)`-Überladung akzeptiert einen Token, aber wenn Sie `await foreach (var x in query)` schreiben, gibt es keinen Platz, um einen zu übergeben. Die Lösung ist `WithCancellation`:

```csharp
public async Task ExportPendingAsync(CancellationToken ct)
{
    await foreach (var invoice in db.Invoices
        .Where(i => i.Status == InvoiceStatus.Pending)
        .AsNoTracking()
        .WithCancellation(ct))
    {
        ct.ThrowIfCancellationRequested();
        await writer.WriteAsync(invoice, ct);
    }
}
```

`WithCancellation` wickelt die Sequenz nicht in einen weiteren Iterator. Es fädelt den Token lediglich in den Aufruf von `GetAsyncEnumerator` ein, den EF Core an `DbDataReader.ReadAsync` weiterreicht. Wenn der Aufrufer den Token abbricht, wird das ausstehende `ReadAsync` abgebrochen, das Kommando auf dem Server abgewürgt und `OperationCanceledException` sprudelt durch Ihr `await foreach` nach oben.

Überspringen Sie den Token nicht. Ein vergessener Token auf einer Streaming-EF-Core-Query ist eine hängende Request in Produktion, wenn der HTTP-Client die Verbindung trennt. Der listenbasierte Pfad scheitert auf die gleiche Weise, aber hier schmerzt es mehr, weil die Verbindung für die gesamte Schleife gehalten wird, nicht nur für den Materialisierungsschritt.

## Tracking ausschalten, sofern Sie es nicht wirklich brauchen

`AsNoTracking()` ist bei Streaming wichtiger als bei Buffering. Mit aktiviertem Change Tracking wird jede vom Enumerator ausgegebene Entität dem `ChangeTracker` hinzugefügt. Das ist eine Referenz, die der GC nicht einsammeln kann, bevor Sie den `DbContext` entsorgen. Eine Million Zeilen in eine getrackte Query zu streamen, zerstört den Sinn von Streaming: Der Speicher wächst linear mit den Zeilen, genau wie bei `ToListAsync`.

```csharp
await foreach (var row in db.AuditEvents
    .AsNoTracking()
    .Where(e => e.OccurredAt >= cutoff)
    .WithCancellation(ct))
{
    await sink.WriteAsync(row, ct);
}
```

Tracking nur behalten, wenn Sie vorhaben, die Entitäten zu mutieren und `SaveChangesAsync` im Schleifenrumpf aufzurufen, was Sie, wie der nächste Abschnitt argumentiert, fast nie tun sollten.

## Sie können keine zweite Query auf demselben Kontext öffnen, während eine streamt

Das ist der häufigste Produktionsfallstrick. Der `DbDataReader`, den EF Core öffnet, wenn Sie die Enumeration starten, hält die Verbindung. Wenn Sie innerhalb der Schleife eine andere EF-Core-Methode aufrufen, die diese Verbindung braucht, bekommen Sie:

```
System.InvalidOperationException: There is already an open DataReader associated
with this Connection which must be closed first.
```

Auf SQL Server können Sie das umgehen, indem Sie Multiple Active Result Sets (`MultipleActiveResultSets=True` im Connection String) aktivieren, aber MARS hat eigene Performance-Trade-offs und wird nicht von jedem Provider unterstützt. Das bessere Muster ist, Operationen nicht auf einem Kontext zu vermischen. Entweder:

- Zuerst die benötigten IDs einsammeln, den Stream schließen, dann die Nacharbeit machen; oder
- Einen zweiten `DbContext` für die inneren Aufrufe verwenden.

```csharp
await foreach (var order in queryCtx.Orders
    .AsNoTracking()
    .WithCancellation(ct))
{
    await using var writeCtx = await factory.CreateDbContextAsync(ct);
    writeCtx.Orders.Attach(order);
    order.ProcessedAt = DateTime.UtcNow;
    await writeCtx.SaveChangesAsync(ct);
}
```

`IDbContextFactory<TContext>` (über `AddDbContextFactory` in der DI-Verdrahtung registriert) ist der sauberste Weg, diesen zweiten Kontext zu bekommen, ohne mit scoped Lifetimes zu kämpfen.

## Streaming und Transaktionen passen nicht gut zusammen

Ein Streaming-Enumerator hält eine Verbindung offen, solange Ihre Schleife läuft. Wenn diese Schleife auch in einer Transaktion mitwirkt, bleibt die Transaktion für die gesamte Schleife offen. Lang laufende Transaktionen sind der Weg zu Lock-Eskalation, blockierten Writern und der Art von Timeouts, die nur unter Last auftreten.

Zwei Regeln, die das in Schach halten:

1. Öffnen Sie keine Transaktion um einen Streaming-Read, es sei denn, Sie brauchen gezielt einen konsistenten Snapshot.
2. Wenn Sie einen Snapshot brauchen, ziehen Sie `SNAPSHOT`-Isolation auf SQL Server oder `REPEATABLE READ`-Isolation auf dem Provider Ihrer Wahl in Betracht und behandeln Sie den Schleifenrumpf als heißen Pfad. Keine HTTP-Aufrufe, keine nutzerseitigen Wartezeiten.

Für Bulk-Verarbeitungsjobs ist die übliche Form: streamen, pro Zeile oder in Batches in einer kurzen Transaktion auf einem separaten Kontext schreiben, committen, weitermachen.

## `AsAsyncEnumerable` gibt es, und manchmal brauchen Sie es

Wenn Sie eine Methode haben, die `IAsyncEnumerable<T>` akzeptiert, und Sie möchten ihr eine EF-Core-Query zuführen, kompiliert das direkte Übergeben des `IQueryable<T>`, weil die Schnittstelle implementiert ist, aber an der Aufrufstelle sieht es falsch aus. `AsAsyncEnumerable` ist zur Laufzeit ein No-op, macht die Absicht aber explizit:

```csharp
public async Task ExportAsync(IAsyncEnumerable<Invoice> source, CancellationToken ct)
{
    // Consumes a generic async sequence. Does not know it is EF.
}

await ExportAsync(
    db.Invoices.AsNoTracking().AsAsyncEnumerable(),
    ct);
```

Es zwingt den Aufruf auch, die `IQueryable`-Welt zu verlassen. Sobald Sie durch `AsAsyncEnumerable()` gehen, laufen weitere LINQ-Operatoren auf dem Client als Async-Iterator-Operatoren, nicht als SQL. Das ist das gewünschte Verhalten hier, weil die empfangende Methode die Query nicht versehentlich umschreiben soll.

## Was passiert, wenn Sie die Schleife früh verlassen

Async-Iteratoren räumen beim Dispose auf. Wenn das `await foreach` aus irgendeinem Grund (break, Exception oder Vollendung) austritt, ruft der Compiler `DisposeAsync` auf dem Enumerator auf, was den `DbDataReader` schließt und die Verbindung an den Pool zurückgibt. Deshalb ist das `await using` auf dem `DbContext` weiterhin wichtig, aber die einzelne Query braucht keinen eigenen using-Block.

Eine nicht offensichtliche Konsequenz: Wenn Sie nach der ersten Zeile einer 10-Millionen-Zeilen-Query `break` machen, liest EF Core die anderen Zeilen nicht, aber die Datenbank hat möglicherweise schon viele davon gespoolt. Der Abfrageplan weiß nicht, dass Sie das Interesse verloren haben. Für SQL Server sendet das clientseitige `DbDataReader.Close` einen Cancel über den TDS-Stream, und der Server zieht sich zurück, aber bei riesigen Zeilenzahlen sehen Sie dennoch ein paar Sekunden Serverarbeit, nachdem Ihre Schleife austritt. Das ist fast nie ein Problem, aber wissenswert, wenn ein Debugger eine Query auf dem Server laufen sieht, nachdem Ihr Test bereits grün war.

## Missbrauchen Sie `ToListAsync` nicht über einer Streaming-Quelle

Hin und wieder schreibt jemand dies:

```csharp
// Pointless: materializes the whole thing, then streams it
var all = await db.Invoices.ToListAsync(ct);
await foreach (var item in all.ToAsyncEnumerable()) { }
```

Das hat keinen Nutzen. Wenn Sie Streaming wollen, gehen Sie direkt vom `IQueryable` in das `await foreach`. Wenn Sie Buffering wollen, behalten Sie die `List<T>` und verwenden ein normales `foreach`. Ein Mischen verrät immer jemanden, der sich nicht sicher war, was er wollte.

Ähnlich ist `.ToAsyncEnumerable()` auf einer EF-Core-Query in EF Core 11 redundant: Die Quelle implementiert die Schnittstelle schon. Es kompiliert und funktioniert, aber fügen Sie es nicht hinzu.

## Client-Evaluation schleicht sich immer noch ein

Der Query-Übersetzer von EF Core ist gut, aber nicht jeder LINQ-Ausdruck wird in SQL übersetzt. Wenn er es nicht kann, wirft EF Core 11 standardmäßig auf dem letzten Operator (anders als der stille Client-Eval von EF Core 2.x). Streaming ändert das nicht: Wenn Ihr `.Where`-Filter eine Methode referenziert, die EF Core nicht übersetzen kann, scheitert die gesamte Query zum Zeitpunkt der Enumeration, nicht beim Start des `await foreach`.

Die Überraschung ist, dass bei `await foreach` die Exception im ersten `MoveNextAsync` auftaucht, also im Schleifenkopf, nicht davor. Wickeln Sie das Setup in ein `try`, wenn Sie Setup-Fehler von Verarbeitungsfehlern unterscheiden möchten:

```csharp
try
{
    await foreach (var row in query.WithCancellation(ct))
    {
        try { await ProcessAsync(row, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Row {Id} failed", row.Id); }
    }
}
catch (Exception ex)
{
    log.LogError(ex, "Query failed before first row");
    throw;
}
```

## Wann `ToListAsync` immer noch die richtige Antwort ist

Streaming ist nicht universell besser. Greifen Sie zu `ToListAsync`, wenn:

- Das Ergebnis klein und beschränkt ist (sagen wir unter ein paar tausend Zeilen).
- Sie das Ergebnis mehrfach iterieren müssen.
- Sie `Count`, Indexierung oder irgendeine andere `IList<T>`-Operation benötigen.
- Sie das Ergebnis an ein UI-Control binden oder in einen Response-Body serialisieren wollen, der eine materialisierte Collection erwartet.

Streaming gewinnt, wenn das Ergebnis groß ist, wenn Speicher wichtig ist, wenn der Konsument selbst async ist (ein `PipeWriter`, ein `IBufferWriter<T>`, ein `Channel<T>`, ein Message Bus), oder wenn die First-Byte-Latenz wichtiger ist als der Gesamtdurchsatz.

## Kurze Checkliste für EF Core 11 Streaming

- `await foreach` direkt über einem `IQueryable<T>`. Kein `ToListAsync`.
- Immer `AsNoTracking()`, sofern Sie keinen konkreten Grund dagegen haben.
- Immer `WithCancellation(ct)`.
- Verwenden Sie `IDbContextFactory<TContext>`, wenn Sie einen zweiten Kontext für Writes innerhalb der Schleife brauchen.
- Verpacken Sie keinen Streaming-Read in eine lange Transaktion.
- Öffnen Sie keinen zweiten Reader auf dem gleichen Kontext ohne MARS.
- Erwarten Sie, dass das erste `MoveNextAsync` Übersetzungs- und Verbindungsfehler sichtbar macht.

## Verwandt

- [Wie man Records mit EF Core 11 korrekt verwendet](/2026/04/how-to-use-records-with-ef-core-11-correctly/) passt gut zu Streaming-Reads, wenn Ihre Entitäten unveränderlich sind.
- [Ein-Schritt-Migrationen mit EF Core 11 `dotnet ef update add`](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) deckt die Tooling-Seite derselben Release ab.
- [Streaming von Tasks mit .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) für das andere Hauptmuster von `IAsyncEnumerable<T>` im modernen .NET.
- [HttpClient GetFromJsonAsAsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/) zeigt das gleiche Streaming-Muster auf der HTTP-Seite.
- [EF Core 11 Preview 3 entfernt Reference Joins in Split Queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) für den Performance-Kontext derselben Release.

## Quellen

- [EF Core Async Queries, MS Learn](https://learn.microsoft.com/en-us/ef/core/miscellaneous/async).
- [`DbContext`-Lifetime und Pooling, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/).
- [`IDbContextFactory<TContext>`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- [`AsyncEnumerableReader` im EF-Core-Quellcode auf GitHub](https://github.com/dotnet/efcore).
