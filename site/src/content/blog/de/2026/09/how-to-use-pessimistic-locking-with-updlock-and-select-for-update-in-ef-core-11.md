---
title: "Pessimistisches Sperren mit UPDLOCK und SELECT ... FOR UPDATE in EF Core 11"
description: "EF Core 11 hat immer noch keine Sperr-API. So nehmen Sie eine echte Zeilensperre mit FromSql: WITH (UPDLOCK, ROWLOCK) auf SQL Server, FOR UPDATE auf PostgreSQL, die Unterabfragen-Falle, die die Sperre unbemerkt ausweitet, NOWAIT und SKIP LOCKED, Deadlock-Wiederholungen und was zu tun ist, wenn die Zeile noch nicht existiert."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-06
---

Kurze Antwort: EF Core 11 hat keine API für pessimistisches Sperren, also nehmen Sie die Sperre selbst mit `FromSql` innerhalb einer expliziten Transaktion. Auf SQL Server ist das `SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {id}`, auf PostgreSQL `SELECT * FROM "Orders" WHERE "Id" = {id} FOR UPDATE`. Zwei Regeln entscheiden darüber, ob es funktioniert, und genau sie werden fast immer verletzt: Die Abfrage muss innerhalb einer selbst geöffneten Transaktion laufen (sonst wird die Sperre in dem Moment freigegeben, in dem der Reader fertig ist), und die `WHERE`-Klausel muss innerhalb der `FromSql`-Zeichenfolge stehen, nicht in einem danach angehängten LINQ-`.Where()`.

Dieser Artikel behandelt das exakte SQL, das EF Core für jede Form erzeugt, warum das Komponieren von LINQ über einer sperrenden Abfrage die Sperre stillschweigend auf die gesamte Tabelle ausweitet, wie `NOWAIT` und `SKIP LOCKED` den Fehlermodus verändern, wie ein Deadlock wiederholt wird, ohne mit der Resilienzstrategie der Verbindung zu kollidieren, und den Fall, über den niemand schreibt: eine Zeile zu sperren, die noch nicht existiert.

Eine Anmerkung zu Versionen. EF Core 11 ist im September 2026 in der Preview und erscheint im November 2026 zusammen mit .NET 11, laut der [Seite zu EF Core Releases und Planung](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 benötigt die .NET 11 Laufzeit. Da das einzige SDK auf dieser Maschine .NET 10.0.302 ist, wurde jedes unten gezeigte generierte SQL mit `ToQueryString()` auf `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10 und `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 erzeugt. In diesem Bereich hat sich in EF11 nichts geändert: Die Seite [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) listet keine Änderungen an `FromSql`, Transaktionen oder Sperren auf.

## EF Core hat weiterhin keine Sperr-API, und das ist Absicht

Die Anfrage ist seit September 2021 offen als [dotnet/efcore#26042, "Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency)"](https://github.com/dotnet/efcore/issues/26042). Sie trägt das Label `needs-design` und liegt im Backlog-Meilenstein ohne Zielversion. EF Core 11 schließt sie nicht.

Warum eine generische API schwierig ist, zeigt der Rest dieses Artikels: SQL Server drückt die Sperre als Tabellenhinweis an einer Tabellenreferenz aus, PostgreSQL als Klausel auf Statement-Ebene mit vier verschiedenen Stärken, und beide sind sich uneinig darüber, was bei Joins, `LIMIT` und nicht existierenden Zeilen passiert. Es gibt keine Form, die sich sauber auf beide abbilden lässt. Also schreiben Sie das SQL selbst.

Die Alternative, zu der Sie zuerst greifen sollten, ist ein `rowversion`-Nebenläufigkeitstoken. Pessimistisches Sperren ist nur dann das richtige Werkzeug, wenn die konkurrierende Arbeit innerhalb einer einzigen kurzen Transaktion auf dem Server abläuft. Sitzt ein Mensch mitten im Lesen-Ändern-Schreiben-Zyklus, verwenden Sie stattdessen [ein rowversion-Nebenläufigkeitstoken in EF Core 11](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/): Eine Datenbanktransaktion lässt sich nicht über die Kaffeepause eines Benutzers offen halten.

## Die Einrichtung in vier Schritten

1. **Öffnen Sie eine explizite Transaktion.** `await using var tx = await context.Database.BeginTransactionAsync();`. Jede Zeilensperre lebt und stirbt mit einer Transaktion. Ohne sie umschließt EF Core den Lesevorgang mit einer eigenen impliziten Transaktion, die committet, sobald der Reader geleert ist, und die Sperre ist Mikrosekunden später weg.
2. **Lesen Sie die Zeile über `FromSql`, mit dem Filter innerhalb der SQL-Zeichenfolge.** Die Sperrsyntax muss an der Tabellenreferenz stehen, die tatsächlich durchlaufen wird.
3. **Ändern Sie die nachverfolgte Entität und rufen Sie `SaveChangesAsync` auf.** `FromSql`-Ergebnisse werden standardmäßig nachverfolgt, genau wie jede andere LINQ-Abfrage, das Update wird also für Sie erzeugt.
4. **Committen Sie.** Die Sperre wird beim Commit oder Rollback freigegeben, nicht früher.

Hier ist die SQL Server Variante von Anfang bis Ende:

```csharp
// EF Core 11 (verified on EF Core 10.0.10), .NET 11, C# 14
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

Und die PostgreSQL Variante, derselbe Code mit einer anderen Zeichenfolge:

```csharp
// Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE""")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

Die Interpolation von `FromSql` ist keine Zeichenfolgenverkettung. Die Lücke `{orderId}` wird zu einem `DbParameter`, weshalb das gegen Injection sicher ist. `ToQueryString()` bestätigt es:

```sql
-- SQL Server, from ToQueryString()
DECLARE p0 int = 42;

SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = @p0
```

Eine Einschränkung aus der [EF Core Dokumentation zu SQL-Abfragen](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries): Das Ergebnis muss eine Spalte für jede gemappte Eigenschaft der Entität enthalten, mit den gemappten Spaltennamen. `SELECT *` erfüllt das. Eine handgeschriebene Spaltenliste, die eine Eigenschaft vergisst, wirft bei der Materialisierung eine Ausnahme, das Thema von [die erforderliche Spalte war in den Ergebnissen einer FromSql-Operation nicht vorhanden](/de/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

## Was UPDLOCK auf SQL Server tatsächlich bringt

`UPDLOCK` nimmt Update-Sperren (U) statt gemeinsamer Sperren (S) und hält sie laut der [Referenz zu Tabellenhinweisen](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) bis zum Ende der Transaktion. Diese zweite Hälfte ist der ganze Punkt. Ein einfaches `SELECT` unter `READ COMMITTED` nimmt gemeinsame Sperren und gibt sie frei, sobald die Zeile gelesen wurde. Zwei Transaktionen können also beide lesen, beide entscheiden zu schreiben und dann in einen Deadlock laufen, während jede ihre S-Sperre in eine X-Sperre umwandeln will. U-Sperren sind untereinander nicht kompatibel, der zweite Leser blockiert also beim Lesen statt beim Schreiben in einen Deadlock zu laufen. Dieser Konvertierungs-Deadlock ist das klassische Symptom, das Entwickler überhaupt erst nach dieser Funktion suchen lässt.

Drei Details, die man verinnerlichen sollte:

- **`ROWLOCK` ist eine Anforderung an die Granularität, keine Garantie.** Es fordert Zeilensperren dort an, wo SQL Server sonst Seiten- oder Tabellensperren nehmen würde. Fügen Sie es hinzu, damit das Durchlaufen weniger Zeilen nicht zu einer Seitensperre über Zeilen eskaliert, die Sie nie angefasst haben. Wenn `UPDLOCK` aus irgendeinem Grund mit `TABLOCK` kombiniert wird, erhalten Sie laut Dokumentation stattdessen eine exklusive Tabellensperre, was selten gewollt ist.
- **`UPDLOCK` allein verhindert keine Inserts.** Es sperrt die Zeilen, die existieren. Lautet Ihre Logik "summiere die Positionen dieser Bestellung und füge dann eine weitere ein", kann eine andere Transaktion eine Position einfügen, die die Summe verändert. Fügen Sie `HOLDLOCK` hinzu, das die Dokumentation als äquivalent zu `SERIALIZABLE` beschreibt, um Schlüsselbereichssperren über dem Prädikat für die Dauer der Transaktion zu erhalten: `WITH (UPDLOCK, HOLDLOCK, ROWLOCK)`.
- **Sperren können auf Indexschlüsseln statt auf Datenzeilen landen.** Der Abschnitt "Remarks" ist eindeutig: Beantwortet ein abdeckender nicht gruppierter Index die Abfrage, wird die Sperre auf dem Indexschlüssel genommen. Meist unsichtbar, gelegentlich der Grund, warum zwei vermeintlich disjunkte Abfragen sich gegenseitig blockieren.

Beachten Sie außerdem die Veraltung: Tabellenhinweise ohne das Schlüsselwort `WITH` werden weiterhin geparst, aber Microsoft hat diese Form zur Entfernung markiert. Schreiben Sie `WITH (UPDLOCK, ROWLOCK)`, mit Kommas zwischen den Hinweisen, nicht `(UPDLOCK ROWLOCK)`.

## PostgreSQL hat vier Sperrstärken, und FOR UPDATE ist die stärkste

Die [Dokumentation der SELECT-Sperrklausel](https://www.postgresql.org/docs/current/sql-select.html) definiert `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` und `FOR KEY SHARE` in absteigender Stärke. `FOR UPDATE` blockiert jeden anderen Sperrenden sowie `UPDATE` und `DELETE`. `FOR NO KEY UPDATE` ist das, was ein einfaches `UPDATE` ohne Änderung einer Schlüsselspalte von sich aus nimmt, und die richtige Wahl, wenn Sie nur Nicht-Schlüsselspalten ändern und die Fremdschlüsselprüfungen von Kindtabellen nicht blockieren wollen, die `FOR KEY SHARE` nehmen.

Das Muster, über das viele stolpern, ist `FOR UPDATE` in Kombination mit `Include`. PostgreSQL weigert sich, die nullbare Seite eines Outer Join zu sperren: "FOR UPDATE cannot be applied to the nullable side of an outer join". Die Lösung ist `FOR UPDATE OF "Orders"`, das nur die Tabelle benennt, die Sie wirklich sperren wollen. In EF Core löst sich dieses Problem meist von selbst, weil `Include` über Ihrem `FromSql` als Unterabfrage komponiert wird und der Join außerhalb landet:

```sql
-- Npgsql, FromSql with FOR UPDATE plus .Include(o => o.Lines)
SELECT o."Id", o."Status", o."Total", o0."Id", o0."OrderId", o0."Quantity"
FROM (
    SELECT * FROM "Orders" WHERE "Id" = @p0 FOR UPDATE
) AS o
LEFT JOIN "OrderLines" AS o0 ON o."Id" = o0."OrderId"
ORDER BY o."Id"
```

Die `Orders`-Zeile ist gesperrt, die `OrderLines`-Zeilen nicht. Wenn Sie auch die Positionen sperren müssen, sperren Sie sie in einem zweiten `FromSql` gegen `OrderLines`, in einer konsistenten Reihenfolge.

## Die Unterabfragen-Falle, die Ihre Sperre unbemerkt ausweitet

Das ist der Fehlermodus, auf den ich in Produktivcode Geld wetten würde. `FromSql` komponiert: Jeder danach angehängte LINQ-Operator macht aus Ihrem SQL eine abgeleitete Tabelle. Verschieben Sie den Filter aus der Zeichenfolge in `.Where()`, und EF Core erzeugt Folgendes:

```sql
-- Npgsql: .FromSql($"""SELECT * FROM "Orders" FOR UPDATE""").Where(o => o.Status == "Pending")
SELECT o."Id", o."Status", o."Total"
FROM (
    SELECT * FROM "Orders" FOR UPDATE
) AS o
WHERE o."Status" = 'Pending'
```

Das `FOR UPDATE` hängt nun an einem ungefilterten Durchlauf von `Orders`. PostgreSQL schiebt das äußere Prädikat nicht in eine Unterabfrage mit Sperrklausel hinein, weil das ändern würde, welche Zeilen gesperrt werden. Die Dokumentation macht denselben Punkt in ihrer `ORDER BY`-Umgehung: `SELECT * FROM (SELECT * FROM mytable FOR UPDATE) ss ORDER BY column1` "sperrt alle Zeilen". Diese Abfrage sperrt also jede Zeile der Tabelle und blockiert jeden anderen Schreiber, und zwar ohne Fehler, ohne Warnung und ohne irgendetwas im Ausführungsplan, das offensichtlich falsch aussieht.

SQL Server erzeugt dieselbe Form und ein subtileres Problem:

```sql
-- SQL Server: .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)").Where(o => o.Status == "Pending")
SELECT [o].[Id], [o].[Status], [o].[Total]
FROM (
    SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)
) AS [o]
WHERE [o].[Status] = N'Pending'
```

Eine abgeleitete Tabelle ist in T-SQL keine Optimierungsbarriere, der Optimierer kann das Prädikat also hineinschieben oder auch nicht. Welche Zeilen am Ende gesperrt sind, wird zu einer Eigenschaft des gewählten Plans statt zu einer Eigenschaft Ihres Codes. Das ist kein Bug, den Sie um 3 Uhr morgens debuggen wollen.

Die Regel: Alles, was die Zeilenmenge einschränkt, gehört in die `FromSql`-Zeichenfolge. Hängen Sie LINQ danach nur für Dinge an, die die Sperre nicht ausweiten können, etwa `Include` oder eine Projektion. Und prüfen Sie es einmal, entweder mit `ToQueryString()` in einem Test oder indem Sie [das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## NOWAIT und SKIP LOCKED: den Fehlerfall wählen

Standardmäßig wartet eine blockierte Sperranforderung. Beide Datenbanken bieten zwei Alternativen.

**Schnell scheitern.** `FOR UPDATE NOWAIT` in PostgreSQL löst sofort SQLSTATE `55P03` (`lock_not_available`) aus, statt zu warten. Der Tabellenhinweis `NOWAIT` in SQL Server ist als äquivalent zu `SET LOCK_TIMEOUT 0` für diese Tabelle dokumentiert und erscheint als Fehler 1222, "Lock request time out period exceeded". So oder so erhalten Sie eine Ausnahme, die Sie in ein 409 übersetzen können, statt einer Anfrage, die dreißig Sekunden lang auf einem Thread festhängt:

```csharp
// Npgsql: fail immediately rather than queue behind another worker
try
{
    var order = await context.Orders
        .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE NOWAIT""")
        .SingleAsync();
}
catch (PostgresException ex) when (ex.SqlState == "55P03")
{
    return Results.Conflict("Order is being modified by another request.");
}
```

**Umstrittene Zeilen überspringen.** Das ist das Muster der Arbeitswarteschlange und der eine Fall, in dem pessimistisches Sperren eindeutig das richtige Design ist. PostgreSQL schreibt es `SKIP LOCKED`, SQL Server schreibt es `READPAST`, das die Dokumentation als genau dafür gebaut beschreibt, "um Sperrkonflikte zu reduzieren, wenn eine Arbeitswarteschlange über eine SQL Server Tabelle implementiert wird".

```csharp
// SQL Server: claim up to 10 unclaimed jobs, skipping rows other workers hold
await using var tx = await context.Database.BeginTransactionAsync();

var jobs = await context.Jobs
    .FromSql($"""
        SELECT TOP (10) * FROM [Jobs] WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE [Status] = 'Queued' ORDER BY [Id]
        """)
    .ToListAsync();

foreach (var job in jobs)
{
    job.Status = "Running";
}

await context.SaveChangesAsync();
await tx.CommitAsync();
```

Zwei Einschränkungen bei `READPAST`. Es überspringt Sperren auf Zeilenebene, aber nicht auf Seitenebene, ein weiterer Grund, es mit `ROWLOCK` zu kombinieren. Und es kann nicht verwendet werden, wenn `READ_COMMITTED_SNAPSHOT` auf `ON` steht und die Isolationsstufe der Sitzung `READ COMMITTED` ist. In dieser Konfiguration müssen Sie den Hinweis `READCOMMITTEDLOCK` ergänzen. In PostgreSQL liefert `SKIP LOCKED` eine bewusst inkonsistente Sicht, was für eine Warteschlange in Ordnung und für alles, was Sie aggregieren wollen, falsch ist.

## Deadlocks passieren weiterhin, also wiederholen Sie

Pessimistisches Sperren verwandelt die meisten Schreibkonflikte in Wartezeit, beseitigt aber keine Deadlocks: Zwei Transaktionen, die Zeile A dann B und B dann A sperren, laufen weiterhin in einen Deadlock (SQL Server Fehler 1205, PostgreSQL SQLSTATE `40P01`). Die günstige strukturelle Lösung ist, Sperren immer in einer deterministischen Reihenfolge zu erwerben, was üblicherweise bedeutet, vor dem Sperren nach dem Primärschlüssel zu sortieren.

Für den Rest gilt: wiederholen. Wenn Sie `EnableRetryOnFailure` aktiviert haben, beachten Sie, dass die wiederholende Ausführungsstrategie sich weigert, eine selbst geöffnete Transaktion zu umschließen, und `InvalidOperationException` wirft. Die gesamte Arbeitseinheit muss durch die Strategie laufen, ausführlich behandelt in [die Ausführungsstrategie unterstützt keine benutzerinitiierten Transaktionen](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/):

```csharp
var strategy = context.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    await using var tx = await context.Database.BeginTransactionAsync();

    var order = await context.Orders
        .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
        .SingleAsync();

    order.Status = "Confirmed";
    await context.SaveChangesAsync();
    await tx.CommitAsync();
});
```

Ein Vorbehalt: Die standardmäßige `SqlServerRetryingExecutionStrategy` von EF wiederholt eine bestimmte Liste transienter SQL Server Fehlernummern. Prüfen Sie, ob Deadlocks in der für Sie relevanten Menge enthalten sind, oder geben Sie eigene `errorNumbersToAdd` an, statt anzunehmen, dass 1205 abgedeckt ist.

## Eine nicht existierende Zeile lässt sich nicht sperren

Die mit Abstand größte Einschränkung. `SELECT ... FOR UPDATE` auf einer noch nicht eingefügten Zeile liefert null Zeilen und sperrt nichts. Das klassische Wettrennen "prüfe, ob dieser Benutzername vergeben ist, und füge ihn dann ein" ist durch Zeilensperren also völlig ungeschützt. Beide Transaktionen sehen nichts, beide fügen ein, und eine erhält eine Verletzung der Eindeutigkeitsbedingung, exakt das Szenario aus [fix 23505 duplicate key value violates unique constraint bei einem nebenläufigen EF Core Insert](/de/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

Drei Auswege, in aufsteigender Reihenfolge, wie sehr sie Ihnen gefallen sollten:

- **Ein eindeutiger Index plus eine abgefangene Ausnahme.** Die Datenbank erzwingt es, Sie übersetzen die Provider-Ausnahme in einen Domänenfehler. Langweilig, korrekt und die Standardantwort.
- **Eine Prädikatssperre.** Auf SQL Server nimmt `WITH (UPDLOCK, HOLDLOCK)` über dem `WHERE`, das getroffen hätte, eine Schlüsselbereichssperre und blockiert das konkurrierende Insert tatsächlich. PostgreSQL hat außer der Isolationsstufe `SERIALIZABLE` kein direktes Äquivalent.
- **Eine Advisory Lock auf den Wert als Schlüssel.** `pg_advisory_xact_lock(key)` in PostgreSQL nimmt eine Sperre auf eine beliebige 64-Bit-Zahl, die am Transaktionsende automatisch freigegeben wird (anders als `pg_advisory_lock`, das sitzungsbezogen ist und ein Rollback überlebt). Das SQL Server Äquivalent ist `sys.sp_getapplock` mit `@LockOwner = 'Transaction'` und einem Ressourcennamen als Zeichenfolge, mit `0` oder `1` bei Erfolg, `-1` bei Timeout und `-3` als Deadlock-Opfer.

```csharp
// PostgreSQL: serialise on a logical key rather than a row
await using var tx = await context.Database.BeginTransactionAsync();
await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({tenantId})");
// ... read, decide, insert ...
await tx.CommitAsync();
```

Advisory Locks sind das richtige Werkzeug, wenn das zu serialisierende Objekt eine Entscheidung statt einer Zeile ist: "nur ein Worker darf die nächtliche Aggregation für diesen Mandanten ausführen".

## Wann etwas völlig anderes die bessere Wahl ist

Wenn die gesamte Operation ein einzelnes arithmetisches Update ist, sperren Sie gar nicht. `UPDATE Accounts SET Balance = Balance - 10 WHERE Id = 1 AND Balance >= 10` ist atomar, nimmt für die Dauer des Statements eine eigene exklusive Sperre und teilt Ihnen über die Anzahl betroffener Zeilen mit, ob die Vorbedingung galt. In EF Core ist das `ExecuteUpdateAsync`, und die Abwägungen gegenüber dem Laden der Entität behandelt [ExecuteUpdate gegenüber dem Laden von Entitäten und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/). Eine pessimistische Sperre lohnt sich nur, wenn zwischen Lesen und Schreiben echte Logik steht, die SQL nicht ausdrücken kann.

Und halten Sie die Transaktion kurz. Alles zwischen `BeginTransactionAsync` und `CommitAsync` ist Zeit, die andere Anfragen blockiert verbringen. Ein HTTP-Aufruf an einen Zahlungsanbieter innerhalb einer sperrenhaltenden Transaktion ist der Weg, auf dem eine einzige langsame Abhängigkeit eine ganze Tabelle lahmlegt.

### Weiterlesen

- [Optimistische Nebenläufigkeit mit einem rowversion-Token in EF Core 11 implementieren](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: die Ausführungsstrategie unterstützt keine benutzerinitiierten Transaktionen](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: die erforderliche Spalte war in den Ergebnissen einer FromSql-Operation in EF Core 11 nicht vorhanden](/de/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ExecuteUpdate gegenüber dem Laden von Entitäten und SaveChanges in EF Core](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Quellen

- [Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency), dotnet/efcore#26042](https://github.com/dotnet/efcore/issues/26042), offen seit 2021 und weiterhin im Backlog-Meilenstein.
- [Table hints (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) für `UPDLOCK`, `HOLDLOCK`, `ROWLOCK`, `READPAST`, `NOWAIT`, die Veraltung des Schlüsselworts `WITH` und das Sperren auf Indexschlüsseln.
- [SELECT, The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) für die vier Sperrstärken, `NOWAIT`, `SKIP LOCKED`, die `OF table` Liste und den Hinweis zum Sperren in Unterabfragen.
- [Explicit locking, PostgreSQL Dokumentation](https://www.postgresql.org/docs/current/explicit-locking.html) für die Konfliktmatrix der Zeilensperren und transaktionsbezogene Advisory Locks.
- [SQL queries in EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) für die Parametrisierung von `FromSql`, Komponierbarkeit, Unterabfragen-Umschließung und Änderungsnachverfolgung.
- [sys.sp_getapplock (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) für Sperrmodi, Transaktions- gegenüber Sitzungsbesitz und Rückgabecodes.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), das bestätigt, dass EF11 die .NET 11 Laufzeit benötigt, und keine Änderungen an Sperren oder `FromSql` auflistet.
