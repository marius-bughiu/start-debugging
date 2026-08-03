---
title: "Optimistische Nebenläufigkeit mit einem rowversion-Token in EF Core 11 implementieren"
description: "Ein rowversion-Concurrency-Token in EF Core 11 einrichten: die Konfiguration mit [Timestamp] und IsRowVersion, das SQL, das EF tatsächlich erzeugt, DbUpdateConcurrencyException abfangen, Datenbank gewinnt vs Client gewinnt vs Merge, getrennte APIs mit ETags und die fünf Fallen, die alles unbemerkt aushebeln."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "rowversion"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Kurze Antwort: Legen Sie eine `byte[]`-Eigenschaft auf der Entität an, markieren Sie sie mit `[Timestamp]` (oder rufen Sie `.IsRowVersion()` in `OnModelCreating` auf), und EF Core 11 bildet sie auf eine SQL Server-Spalte vom Typ `rowversion` ab und ergänzt jedes UPDATE und DELETE für diese Entität um `AND [RowVersion] = @original`. Wurde die Zeile zwischenzeitlich von jemand anderem geändert, betrifft die Anweisung null Zeilen und `SaveChangesAsync` wirft `DbUpdateConcurrencyException`, die Sie abfangen und auflösen. Die gesamte Funktion sind etwa sechs Zeilen Konfiguration. Schwierig sind die fünf Wege, sie versehentlich abzuschalten, ohne einen Fehler zu bekommen.

Dieser Beitrag behandelt die Einrichtung, das SQL und den exakten Ausnahmetext, die drei Auflösungsstrategien, den getrennten Web-API-Umlauf, den die meisten Tutorials überspringen, und die Fallen, die Ihnen ein Token hinterlassen, das nichts schützt.

Eine Anmerkung dazu, wie die folgenden Details verifiziert wurden. EF Core 11 benötigt die .NET 11-Laufzeit, und das einzige SDK auf dieser Maschine ist .NET 10.0.201. Die ausführbaren Experimente liefen daher auf `Microsoft.EntityFrameworkCore` 10.0.10 gegen SQLite, dazu der DDL-Generator des SQL Server-Providers (der offline läuft, ohne Server). Die Concurrency-Token-API und die Form des erzeugten SQL sind zwischen EF Core 8 und 11 unverändert: Die [Release Notes zu EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) führen keine Änderungen an Concurrency-Tokens, an der Konflikterkennung von `SaveChanges` oder an `DbUpdateConcurrencyException` auf. Alles EF Core 11-Spezifische ist als solches gekennzeichnet.

## Was eine rowversion-Spalte tatsächlich ist

`rowversion` ist ein SQL Server-Datentyp, kein EF Core-Konzept. Laut der [rowversion-Dokumentation](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) sind es 8 Byte automatisch erzeugter, eindeutiger Binärdaten. Drei Eigenschaften sind für die Arbeit mit Nebenläufigkeit relevant:

- **Es ist ein Zähler, keine Uhr.** Es speichert weder Datum noch Uhrzeit. Jede Datenbank hat genau einen Zähler, der bei jedem Insert oder Update auf einer Tabelle mit `rowversion`-Spalte hochgezählt wird. Zwei Zeilen in verschiedenen Tabellen können nie denselben Wert haben, aber Sie können nicht zwei Werte subtrahieren und eine verstrichene Zeit erhalten.
- **Eine Tabelle darf genau eine haben.** Deshalb schützt ein rowversion-Token immer die gesamte Zeile, nie eine Teilmenge der Spalten.
- **Jedes UPDATE erhöht ihn, auch ein wirkungsloses.** Die Dokumentation ist eindeutig: Eine Spalte auf den Wert zu setzen, den sie bereits hat, zählt als Update und erhöht die Version. Ein "Speichern", das nichts ändert, invalidiert trotzdem das Token aller anderen Leser.

`timestamp` ist ein veraltetes Synonym für denselben Typ. Verwenden Sie in DDL `rowversion`. Verwirrenderweise heißt das EF Core-Attribut weiterhin `[Timestamp]`, weil es älter als die Umbenennung ist.

## Die Einrichtung in vier Schritten

1. **Fügen Sie der Entität eine `byte[]`-Eigenschaft hinzu.** Der CLR-Typ muss `byte[]` sein, damit der SQL Server-Provider sie auf `rowversion` abbildet. Der Name ist frei wählbar; `RowVersion` und `Version` sind die üblichen Varianten.
2. **Markieren Sie sie als Zeilenversion.** Entweder `[Timestamp]` als Data Annotation oder `.Property(p => p.RowVersion).IsRowVersion()` in `OnModelCreating`. Beides ist gleichwertig.
3. **Erstellen Sie eine Migration und wenden Sie sie an.** EF erzeugt `[RowVersion] rowversion NOT NULL`, und SQL Server füllt jede bestehende Zeile beim nächsten Update nach.
4. **Fangen Sie `DbUpdateConcurrencyException` an jeder Aufrufstelle ab, die diese Entität speichert.** Ohne diesen Schritt haben Sie lediglich ein stilles verlorenes Update gegen eine 500er-Antwort getauscht, was besser ist, aber nicht viel.

Hier die Entität in beiden Varianten:

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = default!;
}
```

```csharp
// Fluent equivalent, no attribute needed on the entity
protected override void OnModelCreating(ModelBuilder modelBuilder)
    => modelBuilder.Entity<Product>()
        .Property(p => p.RowVersion)
        .IsRowVersion();
```

Der Create-Script-Generator des SQL Server-Providers erzeugt für dieses Modell:

```sql
CREATE TABLE [Products] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Price] decimal(18,2) NOT NULL,
    [RowVersion] rowversion NOT NULL,
    CONSTRAINT [PK_Products] PRIMARY KEY ([Id])
);
```

Interessant ist nicht das DDL, sondern die Modell-Metadaten, die EF daraus ableitet. Ein Dump von `IProperty` für diese Spalte liefert `colType=rowversion`, `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. Dieses letzte Flag sollte man sich merken: EF Core schreibt niemals einen Wert in diese Spalte. Sie wird aus INSERT und UPDATE ausgeschlossen, und der neue Wert wird anschließend zurückgelesen. Die Datenbank besitzt sie vollständig.

## Das SQL, das EF Core erzeugt, und die Ausnahme im Fehlerfall

Sobald die Eigenschaft ein Concurrency-Token ist, führt jedes UPDATE, das EF für die Entität erzeugt, den Originalwert neben dem Schlüssel in der `WHERE`-Klausel mit. Auf SQLite mit einem anwendungsverwalteten Token sieht das genau so aus (aufgezeichnet mit `LogTo`, gefiltert auf `RelationalEventId.CommandExecuted`):

```sql
UPDATE "Products" SET "Price" = @p0, "Version" = @p1
WHERE "Id" = @p2 AND "Version" = @p3
RETURNING 1;
```

Auf SQL Server muss die Anweisung zusätzlich die neu erzeugte `rowversion` zurücklesen, da die Spalte `ValueGenerated.OnAddOrUpdate` ist. Die im [Razor Pages-Tutorial zur Nebenläufigkeit](https://learn.microsoft.com/en-us/aspnet/core/data/ef-rp/concurrency) dokumentierte Form kombiniert das abgesicherte UPDATE mit einem über `@@ROWCOUNT` bedingten SELECT:

```sql
SET NOCOUNT ON;
UPDATE [Products] SET [Price] = @p0
WHERE [Id] = @p1 AND [RowVersion] = @p2;
SELECT [RowVersion]
FROM [Products]
WHERE @@ROWCOUNT = 1 AND [Id] = @p1;
```

Die exakte Form der Anweisung hat sich über EF Core-Versionen und Provider hinweg geändert und wird sich weiter ändern. Stabil ist die Semantik, und darauf sollten Sie in einem Test prüfen: Das Token steht im `WHERE`, und ein Ergebnis von null Zeilen wird in eine Ausnahme übersetzt.

Hat jemand anderes die Zeile nach Ihrem Laden geändert, trifft das Prädikat nichts, es kommen null Zeilen zurück, und EF wirft. Die Meldung lohnt sich einzuprägen, weil Sie genau danach in Ihren Logs suchen werden:

```text
The database operation was expected to affect 1 row(s), but actually affected
0 row(s); data may have been modified or deleted since entities were loaded.
```

Zwei Dinge werden dabei häufig falsch verstanden. Erstens wird sie bei Updates *und* Deletes geworfen, bei Inserts praktisch nie. Ein doppelter Insert erzeugt stattdessen eine providerspezifische Ausnahme wegen verletzter Eindeutigkeitsbedingung. Zweitens unterscheidet "0 Zeilen betroffen" nicht zwischen "jemand hat sie geändert" und "jemand hat sie gelöscht". Das müssen Sie bei der Auflösung selbst herausfinden.

Sieht das obige SQL nicht wie das aus, was Ihre Anwendung sendet, finden Sie am schnellsten heraus, was sie *tatsächlich* sendet, indem Sie [das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) und die `WHERE`-Klausel direkt lesen. Ein fehlendes `AND [RowVersion] = ...` bedeutet, dass das Token auf dem Pfad, den Sie vermuten, nicht konfiguriert ist.

## Den Konflikt auflösen: drei Strategien, eine Schleife

`DbUpdateConcurrencyException` stellt `Entries` bereit, die Liste der `EntityEntry`-Objekte, deren Befehle mit der falschen Zeilenanzahl zurückkamen. Jeder Eintrag liefert drei Wertesätze:

- `CurrentValues`: was Sie schreiben wollten.
- `OriginalValues`: was Sie gelesen haben, vor Ihren Änderungen. Hier liegt das veraltete Token.
- `GetDatabaseValuesAsync()`: was gerade in der Datenbank steht, frisch abgefragt.

Jede Auflösungsstrategie ist eine Regel zur Kombination dieser drei, gefolgt vom Auffrischen von `OriginalValues`, damit die `WHERE`-Klausel des erneuten Versuchs das aktuelle Token verwendet.

**Datenbank gewinnt** ist die einfachste Variante und die richtige Vorgabe für alles, was ein Mensch ansieht: Versuch verwerfen, neu laden, Benutzer informieren. `entry.ReloadAsync()` erledigt das in einem Aufruf.

**Client gewinnt** überschreibt, was zwischenzeitlich eingetroffen ist. Nur korrekt, wenn Ihr Schreibvorgang autoritativ ist (ein Admin-Override, das Wiedereinspielen eines kanonischen Ereignisses), und sonst überall ein echter Fehler:

```csharp
// .NET 11, C# 14, EF Core 11
catch (DbUpdateConcurrencyException ex)
{
    foreach (var entry in ex.Entries)
    {
        var databaseValues = await entry.GetDatabaseValuesAsync();
        if (databaseValues is null)
        {
            // The row is gone. There is nothing to overwrite.
            throw new InvalidOperationException("Product was deleted by another user.");
        }

        // Keep CurrentValues as-is, but adopt the database's token so the
        // retried UPDATE targets the row as it exists now.
        entry.OriginalValues.SetValues(databaseValues);
    }

    await context.SaveChangesAsync();
}
```

**Merge** ist die Variante, die sich lohnt, wenn die Entität unabhängige Felder hat. Übernehmen Sie den Datenbankwert für jede Eigenschaft, die Sie nicht angefasst haben, behalten Sie Ihren für die geänderten, und eskalieren Sie nur bei echter Überschneidung:

```csharp
// .NET 11, C# 14, EF Core 11
var saved = false;
while (!saved)
{
    try
    {
        await context.SaveChangesAsync();
        saved = true;
    }
    catch (DbUpdateConcurrencyException ex)
    {
        foreach (var entry in ex.Entries)
        {
            if (entry.Entity is not Product)
            {
                throw new NotSupportedException(
                    $"No conflict policy for {entry.Metadata.Name}.");
            }

            var proposed = entry.CurrentValues;
            var database = await entry.GetDatabaseValuesAsync()
                ?? throw new InvalidOperationException("Row was deleted.");
            var original = entry.OriginalValues;

            foreach (var property in proposed.Properties)
            {
                // Skip the token itself: it is byte[], so Equals compares
                // references, and it is refreshed wholesale below anyway.
                if (property.IsConcurrencyToken) continue;

                var mine = proposed[property];
                var theirs = database[property];
                var wasLoaded = original[property];

                // I did not touch this column: take theirs.
                if (Equals(mine, wasLoaded))
                {
                    proposed[property] = theirs;
                }
                // Both of us changed it to different values: real conflict.
                else if (!Equals(theirs, wasLoaded) && !Equals(mine, theirs))
                {
                    throw new InvalidOperationException(
                        $"Conflicting edits to {property.Name}.");
                }
            }

            entry.OriginalValues.SetValues(database);
        }
    }
}
```

Diese `while (!saved)`-Schleife entspricht der Form, die die [EF Core-Dokumentation zur Nebenläufigkeit](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) empfiehlt, und sie ist wirklich eine Schleife: Ihr erneuter Versuch kann das Rennen ein zweites Mal verlieren. Begrenzen Sie die Versuchszahl in der Produktion, denn ein unbegrenzter Retry gegen eine stark umkämpfte Zeile ist ein Livelock.

Eine Wechselwirkung zum Beachten: Wenn Sie `EnableRetryOnFailure` aktiviert haben, läuft der Retry innerhalb einer `SqlServerRetryingExecutionStrategy`, und diese Schleife in ein manuelles `BeginTransaction` zu hüllen scheitert mit dem Fehler, der in [Die Ausführungsstrategie unterstützt keine benutzerinitiierten Transaktionen](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) beschrieben ist. Verwenden Sie stattdessen `strategy.ExecuteAsync(...)` um die gesamte Arbeitseinheit.

## Der getrennte Umlauf, wo das üblicherweise schiefgeht

Das obige Beispiel mit einem einzigen Kontext ist nicht das, was Ihre API tut. Ihre API lädt ein Produkt in einer Anfrage, gibt es an einen Browser weiter und erhält zehn Minuten später eine Bearbeitung in einem völlig anderen `DbContext`. Das Token muss diese Reise überstehen.

`byte[]` wird in `System.Text.Json` als base64 serialisiert, ein DTO transportiert es also ohne Sonderbehandlung. Die idiomatische HTTP-Form ist ein ETag: Geben Sie das base64-Token beim GET als `ETag`-Antwortheader zurück, fordern Sie es beim PUT als `If-Match` und antworten Sie mit `412 Precondition Failed`, wenn es nicht passt.

Auf der Schreibseite ist die entscheidende Zeile das explizite Setzen von `OriginalValue`. EF weiß nicht, wie die Zeile aussah, als der Client sie gelesen hat, also müssen Sie es mitteilen:

```csharp
// .NET 11, C# 14, EF Core 11
app.MapPut("/products/{id:int}", async (
    int id, ProductDto dto, [FromHeader(Name = "If-Match")] string? ifMatch,
    AppDbContext db) =>
{
    if (string.IsNullOrEmpty(ifMatch)) return Results.BadRequest("If-Match required.");

    var product = await db.Products.FindAsync(id);
    if (product is null) return Results.NotFound();

    product.Name = dto.Name;
    product.Price = dto.Price;

    // Overwrite the token EF loaded with the one the client actually saw.
    db.Entry(product).Property(p => p.RowVersion).OriginalValue =
        Convert.FromBase64String(ifMatch.Trim('"'));

    try
    {
        await db.SaveChangesAsync();
        return Results.Ok(new { eTag = Convert.ToBase64String(product.RowVersion) });
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
    }
});
```

Beachten Sie, dass hier bewusst zuerst abgefragt wird. Sie können die Abfrage mit `Attach` plus `EntityState.Modified` einsparen, das ist ein Roundtrip weniger, aber dann wird jede Spalte geschrieben, ob geändert oder nicht. Ich habe verifiziert, dass sich beide Wege bezüglich des Tokens identisch verhalten: In der SQLite-Reproduktion erzeugte das Setzen von `OriginalValue` auf einer angehängten, nie abgefragten Entität dieselbe tokengesicherte `WHERE`-Klausel wie der Weg mit vorheriger Abfrage und speicherte sauber.

## Fünf Wege, Ihr Concurrency-Token unbemerkt abzuschalten

**Das Originaltoken nicht mitführen.** Trifft eine getrennte Entität mit einem Standard- oder leeren Token ein und Sie rufen `context.Update(entity)` auf, nimmt EF den Wert *am Objekt* als Original. Das erzeugte SQL wird zu `WHERE "Id" = @p3 AND "Version" = @p4` mit einem durchgehend nullwertigen `@p4`, das nichts trifft, und wirklich jedes Speichern wirft `DbUpdateConcurrencyException`. Genau das habe ich auf EF Core 10.0.10 reproduziert. Der Fehlermodus ist laut, was ein Glück ist, denn der umgekehrte Fehler ist still.

**Einen Provider ohne rowversion verwenden.** Dieser Fall erzeugt überhaupt keinen Fehler. Auf SQLite erzeugt `[Timestamp]` auf einem `byte[]` eine Spalte `BLOB NULL`, markiert mit `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. EF schreibt sie also nie, SQLite erzeugt sie nie, und der Wert bleibt für immer `null`. Das erzeugte UPDATE degeneriert zu:

```sql
UPDATE "Products" SET "Price" = @p0
WHERE "Id" = @p1 AND "RowVersion" IS NULL
RETURNING "RowVersion";
```

`IS NULL` trifft jedes Mal. Sie erhalten eine tokenförmige Spalte, null Schutz und keine Warnung. Verifiziert auf EF Core 10.0.10 mit `Microsoft.EntityFrameworkCore.Sqlite`. Laufen Ihre Integrationstests auf SQLite, während die Produktion auf SQL Server läuft, bestehen Ihre Nebenläufigkeitstests aus dem falschen Grund.

Die Lösung für Provider ohne native selbstaktualisierende Spalte ist ein anwendungsverwaltetes Token: eine `Guid`, markiert mit `[ConcurrencyCheck]` (oder `.IsConcurrencyToken()`), die Sie bei jedem Speichern selbst zuweisen. PostgreSQL ist die Ausnahme, die keines von beidem braucht: Npgsql bildet eine `uint`-Eigenschaft mit `[Timestamp]` oder `.IsRowVersion()` auf die Systemspalte `xmin` ab, die die Engine automatisch aktualisiert.

**`[Timestamp]` auf dem falschen CLR-Typ.** EF Core validiert das beim Modellaufbau nicht. Ich habe `[Timestamp]` auf ein `long` gesetzt, und der SQL Server-Provider erzeugte bereitwillig `[RowVersion] bigint NOT NULL` mit `IsConcurrencyToken=True` und `ValueGenerated=OnAddOrUpdate`. SQL Server pflegt gewöhnliche `bigint`-Spalten nicht, und EF wurde angewiesen, sie nicht zu schreiben, also bewegt nichts diesen Wert jemals. Nur `byte[]` wird auf den echten Typ `rowversion` abgebildet.

**Über `ExecuteUpdate` oder `ExecuteDelete` schreiben.** Diese umgehen die Änderungsverfolgung vollständig und damit auch die Nebenläufigkeitsprüfung. Das erzeugte SQL enthält nur Ihr Prädikat:

```sql
UPDATE "Products" AS "p"
SET "Price" = ef_add("p"."Price", '1.0')
WHERE "p"."Name" = 'B'
```

Kein Token, keine Ausnahme, eine betroffene Zeile. Wollen Sie optimistische Nebenläufigkeit auf einem Massenpfad, müssen Sie sie selbst bauen: Token in das `Where` und die zurückgegebene Anzahl betroffener Zeilen gegen den Erwartungswert prüfen. Diese Abwägung, und wann welcher Schreibpfad der richtige ist, behandelt [ExecuteUpdate vs Entitäten laden und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

**Tokens mit `==` in C# vergleichen.** `byte[]` verwendet Referenzgleichheit. Zwei Arrays mit identischen Bytes sind nicht gleich. Verwenden Sie `SequenceEqual` oder vergleichen Sie die base64-Zeichenketten, wann immer Sie ein Token im Anwendungscode prüfen. EF selbst vergleicht in SQL, das trifft Sie also nur in Ihrer eigenen Validierungslogik.

## Wenn ein zeilenweites Token zu grob ist

Ein `rowversion` schützt die gesamte Zeile. Zwei Benutzer, die wirklich unabhängige Felder desselben Datensatzes bearbeiten (einer korrigiert einen Tippfehler in der Beschreibung, der andere passt den Lagerbestand an), kollidieren, obwohl nichts tatsächlich im Konflikt steht. Bei einem stark frequentierten Datensatz ergibt das einen Strom unechter 412er.

Zwei Auswege. Verwenden Sie die obige Merge-Strategie, damit sich Scheinkonflikte automatisch auflösen und nur echte Überschneidungen auftauchen. Oder steigen Sie auf ein anwendungsverwaltetes Token um, das Sie nur dann neu erzeugen, wenn sich die für Sie relevanten Eigenschaften ändern, was sich in einem `SaveChanges`-Interceptor der in [EF Core 11-Interceptors für Auditing](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) beschriebenen Art zentralisieren lässt. Der Preis der zweiten Option: Sie besitzen ab jetzt dauerhaft die Entscheidung "war diese Änderung relevant?", für jede Eigenschaft, die Sie hinzufügen.

Die Alternative auf höherer Ebene ist eine Transaktionsisolationsstufe. Snapshot-Isolation auf SQL Server oder Repeatable Read auf PostgreSQL wirft einen Serialisierungsfehler, wenn der Schreibvorgang Ihrer Transaktion mit einem committeten kollidiert, ganz ohne Token im Modell. Das ist einfacher und genau dann das falsche Werkzeug, wenn ein Mensch beteiligt ist, denn die Transaktion müsste über dessen Bedenkzeit offen bleiben. Concurrency-Tokens existieren genau deshalb, damit die "Transaktion" einen HTTP-Umlauf und eine Kaffeepause überspannen kann.

## Verwandte Beiträge

- [ExecuteUpdate vs Entitäten laden und SaveChanges in EF Core](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core 11-Interceptors für Auditing verwenden](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Fix: Die Ausführungsstrategie unterstützt keine benutzerinitiierten Transaktionen](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: Die Instanz des Entitätstyps kann nicht verfolgt werden, weil bereits eine andere Instanz mit demselben Schlüsselwert verfolgt wird](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Quellen

- [Handling concurrency conflicts](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) auf Microsoft Learn, für die Token-Semantik, die drei Wertesätze und die Retry-Schleife.
- [rowversion (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) für den 8-Byte-Zähler, die Ein-pro-Tabelle-Regel, das Verhalten bei wirkungslosen UPDATEs und die Abkündigung von `timestamp`.
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities) für `Update` gegenüber `Attach` und `CurrentValues.SetValues`.
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), das bestätigt, dass EF11 die .NET 11-Laufzeit benötigt und keine Änderungen an Concurrency-Tokens auflistet.
- [Npgsql concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html) für die `xmin`-Abbildung auf PostgreSQL.
