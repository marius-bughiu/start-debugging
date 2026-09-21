---
title: "Wie man mit EF Core und Npgsql atomar an ein PostgreSQL-jsonb-Array anhängt"
description: "Eine Entität laden, List.Add aufrufen und speichern schreibt das gesamte jsonb-Dokument neu und verliert gleichzeitige Anhänge stillschweigend. Verlagern Sie das Anhängen mit dem jsonb-Operator || in ein einziges UPDATE, entweder über ExecuteSqlAsync oder über eine gemappte Funktion in ExecuteUpdateAsync, und machen Sie es mit einem @>-Guard idempotent."
pubDate: 2026-09-21
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "json"
  - "concurrency"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql"
translatedBy: "claude"
translationDate: 2026-09-21
---

Kurze Antwort: Laden Sie nicht die Zeile, rufen Sie nicht `Add` auf der Liste auf und dann `SaveChangesAsync`. EF Core schickt das gesamte `jsonb`-Dokument als Parameter zurück, sodass sich zwei Anfragen, die gleichzeitig anhängen, gegenseitig überschreiben. Senden Sie stattdessen ein einziges `UPDATE`, das das Anhängen in PostgreSQL erledigt: `SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]') || to_jsonb(@label::text))`. Das lässt sich über `Database.ExecuteSqlAsync` absetzen, oder Sie bleiben in LINQ, indem Sie eine kleine Funktion mit `HasDbFunction` mappen und sie in `ExecuteUpdateAsync` aufrufen, wo EF Core 10 das `jsonb_set` für Sie schreibt. Ergänzen Sie `.Where(t => !t.Data.Labels.Contains(label))`, das Npgsql in `@>` übersetzt, und das Anhängen wird zusätzlich idempotent.

Alles Folgende lief auf .NET 10 (SDK 10.0.302) mit `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (das EF Core 10.0.4 mitbringt) gegen PostgreSQL 18.4. Die JSON-Spalte ist so gemappt, wie EF Core 10 es empfiehlt: als Complex Type mit `ToJson()`. Sämtliches SQL und alle hier genannten Zahlen stammen aus echten Durchläufen, nicht aus Rekonstruktion.

## Zwanzig gleichzeitige Anhänge, drei Überlebende

Hier ist das Modell. Ein Ticket hat eine `jsonb`-Spalte mit Labels und einem Ereignisverlauf:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required TicketData Data { get; set; }
}

public class TicketData
{
    public List<string> Labels { get; set; } = [];
    public List<TicketEvent> Events { get; set; } = [];
}

public class TicketEvent
{
    public required string Kind { get; set; }
    public DateTime At { get; set; }
}

public class AppDb : DbContext
{
    public DbSet<Ticket> Tickets => Set<Ticket>();

    protected override void OnModelCreating(ModelBuilder b)
        => b.Entity<Ticket>().ComplexProperty(t => t.Data, d => d.ToJson());
}
```

Npgsql legt dafür `"Data" jsonb NOT NULL` an. Nun der Code, den die meisten zuerst schreiben, ausgeführt von 20 parallelen Tasks gegen dieselbe Zeile, jeder mit eigenem `DbContext`:

```csharp
// .NET 10, EF Core 10.0.4 -- the lost-update version
await using var db = new AppDb();
var t = await db.Tickets.SingleAsync(x => x.Id == id);
t.Data.Labels.Add($"l{i}");
await db.SaveChangesAsync();
```

Die Zeile beginnt mit einem Label, das erwartete Ergebnis ist also 21. Ich bekam **3**, in drei von drei Durchläufen. Der Grund ist im SQL sichtbar, das `SaveChangesAsync` sendet:

```sql
UPDATE "Tickets" SET "Data" = @p0
WHERE "Id" = @p1;
-- @p0='{"Labels":["hardware","urgent","via-savechanges"],"Events":[...]}'
```

EF Core sendet nicht "hänge dieses Element an". Es serialisiert den gesamten Complex Type aus dem Speicher und ersetzt die Spalte damit. Jeder Task hat dasselbe Ausgangsdokument gelesen, sein eigenes Label hinzugefügt und ein Dokument zurückgeschrieben, das von den anderen 19 nichts wusste. Der letzte Schreiber gewinnt, und die Datenbank merkt nicht, dass etwas schiefgelaufen ist, denn aus ihrer Sicht war jedes `UPDATE` eine völlig gültige Ersetzung.

Das ist kein Npgsql-Bug. Es ist das gewöhnliche Lost-Update-Problem, und eine JSON-Spalte verschärft es: Bei skalaren Spalten kollidieren zwei Anfragen, die *verschiedene* Spalten ändern, nicht, hier aber schreibt jede Änderung an einem Label oder Ereignis die eine Spalte neu, die sie alle enthält.

## Warum ein Anhängen in der Datenbank atomar ist

Der PostgreSQL-Operator `jsonb || jsonb` verkettet. Ist die linke Seite ein Array und die rechte ein Skalar oder Objekt, wird die rechte Seite als ein Element angehängt:

```sql
SELECT '["a"]'::jsonb || to_jsonb('b'::text);     -- ["a", "b"]
SELECT '["a"]'::jsonb || '{"k": 1}'::jsonb;       -- ["a", {"k": 1}]
```

Entscheidend ist nicht der Operator, sondern woher der alte Wert kommt. In `SET "Data" = ... "Data" || ...` ist das rechte `"Data"` der aktuelle Wert der Zeile in dem Moment, in dem das `UPDATE` ausgeführt wird. Unter der Standardisolation `READ COMMITTED` blockiert bei zwei Transaktionen, die dieselbe Zeile aktualisieren, die zweite auf der Zeilensperre, bis die erste committet, liest dann die *neue* Zeilenversion und wertet sowohl ihre `WHERE`-Klausel als auch ihre `SET`-Ausdrücke erneut dagegen aus. Jedes Anhängen baut also auf dem vorherigen auf. Keine Retry-Schleife, keine Versionsspalte, kein Lese-Roundtrip.

## Option 1: ein UPDATE über ExecuteSqlAsync

Die direkteste Lösung ist, die Anweisung selbst zu schreiben:

```csharp
// .NET 10, EF Core 10.0.4, PostgreSQL 18.4
var label = "urgent";
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]'::jsonb) || to_jsonb({{label}}::text))
    WHERE "Id" = {{id}}
    """);
```

`ExecuteSqlAsync` nimmt einen `FormattableString`, daher werden `{{label}}` und `{{id}}` zu echten Parametern (`@p0`, `@p1`) und nicht zu String-Verkettung. Der `$$`-Raw-String ist Absicht: Er erlaubt dem jsonb-Pfadliteral `'{Labels}'`, seine einfachen geschweiften Klammern zu behalten, während `{{...}}` die Platzhalter markiert. Mit denselben 20 parallelen Tasks endet diese Variante jedes Mal mit 21 Labels.

Drei Teile dieser Anweisung haben jeweils einen Grund:

- `jsonb_set(doc, '{Labels}', newArray)` ersetzt nur den Schlüssel `Labels` und lässt jeden anderen Schlüssel im Dokument so, wie er *genau jetzt* ist, einschließlich eines `Events`-Eintrags, den eine andere Anfrage vor einer Millisekunde angehängt hat.
- `COALESCE("Data"->'Labels', '[]'::jsonb)` deckt Zeilen ab, die geschrieben wurden, bevor es `Labels` gab. `NULL || anything` ist `NULL`, und `jsonb_set` mit einem `NULL` als neuem Wert gibt `NULL` für das gesamte Dokument zurück, was auf einer `NOT NULL`-Spalte ein Fehler und auf einer nullbaren Spalte Datenverlust ist.
- `::text` am Parameter gibt `to_jsonb` einen konkreten Typ. Ohne ihn scheitert ein Literal, das Sie selbst inline einsetzen, mit `42804: could not determine polymorphic type because input has type unknown`.

Das Anhängen eines Objekts, etwa eines neuen Verlaufsereignisses, funktioniert genauso. Serialisieren Sie es und casten Sie es nach `jsonb`:

```csharp
// .NET 10, EF Core 10.0.4, System.Text.Json
var ev = new TicketEvent { Kind = "escalated", At = DateTime.UtcNow };
var json = JsonSerializer.Serialize(ev);
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Events}', COALESCE("Data"->'Events', '[]'::jsonb) || jsonb_build_array({{json}}::jsonb))
    WHERE "Id" = {{id}}
    """);
```

Das Ergebnis war `{"Events": [{"At": "2026-09-21T08:00:00Z", "Kind": "escalated"}], ...}`, und beim Zurücklesen des Tickets über EF wurde das Ereignis mit `DateTimeKind.Utc` materialisiert. Verwenden Sie im JSON die Eigenschaftsnamen von EF (hier `Kind` und `At`, der Standard, wenn das Modell kein `HasJsonPropertyName` enthält), denn EF liest das Dokument über diese Schlüssel.

## Option 2: in LINQ bleiben mit einer gemappten Funktion und ExecuteUpdateAsync

Raw SQL funktioniert, legt aber Tabellen- und Spaltennamen fest, die sonst EF verwaltet. EF Core 10 hat `ExecuteUpdateAsync`-Unterstützung für Eigenschaften innerhalb eines `ToJson()`-Complex-Types eingeführt, also liegt dieser Versuch nahe:

```csharp
// Does NOT translate in EF Core 10.0.4 / Npgsql 10.0.3
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => t.Data.Labels.Append("x").ToList()));
```

Er scheitert mit `The LINQ expression '...AsQueryable().Append("x")' could not be translated`, und die Variante `Concat(new[] { "y" }).ToList()` scheitert mit `does not represent a valid value`. Npgsql übersetzt Listen-Anhängeoperatoren auf einer primitiven JSON-Collection in einem Setter nicht.

Was *funktioniert*, ist eine benutzerdefinierte Funktion, deren Rückgabetyp der Collection-Typ ist. EF erlaubt sie auf der rechten Seite von `SetProperty` und umschließt sie selbst mit dem `jsonb_set`. Legen Sie die Funktion in einer Migration an:

```csharp
// EF Core 10 migration
migrationBuilder.Sql("""
    CREATE OR REPLACE FUNCTION jsonb_append_text(arr jsonb, elem text)
    RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $$ SELECT COALESCE(NULLIF(arr, 'null'::jsonb), '[]'::jsonb) || to_jsonb(elem) $$;
    """);
```

Dann deklarieren Sie einen C#-Stub und mappen ihn:

```csharp
// .NET 10, EF Core 10.0.4
public static class JsonbFn
{
    public static List<string> Append(List<string> array, string element)
        => throw new InvalidOperationException("Only usable in EF Core queries.");
}

// in OnModelCreating
b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Append))!)
    .HasName("jsonb_append_text");
```

Die Aufrufstelle ist jetzt schlichtes, typisiertes EF:

```csharp
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => JsonbFn.Append(t.Data.Labels, label)));
```

und das SQL, das EF erzeugt, lautet:

```sql
UPDATE "Tickets" AS t
SET "Data" = jsonb_set(t."Data", '{Labels}', COALESCE(to_jsonb(jsonb_append_text(t."Data" -> 'Labels', @label)), 'null'::jsonb))
WHERE t."Id" = @id
```

Zwanzig parallele Aufrufer, 21 Labels, bei jedem Durchlauf. Das zusätzliche `to_jsonb(...)` um einen Wert, der bereits `jsonb` ist, ist ein No-op, das EF bei jeder JSON-Eigenschaft ergänzt, die es setzt. Das `NULLIF(arr, 'null'::jsonb)` in der Funktion deckt ein Dokument ab, das `"Labels": null` enthält statt gar keinen Schlüssel. Ohne es erzeugt `'null'::jsonb || '"x"'` stillschweigend `[null, "x"]`.

### Dasselbe ohne Migration: HasTranslation

Wenn Sie keine Datenbankobjekte anlegen können, lassen Sie EF stattdessen eingebaute Funktionen ausgeben. `jsonb_insert(array, '{-1}', element, true)` fügt nach dem letzten Element ein, was einem Anhängen entspricht:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore.Query.SqlExpressions;

b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Push))!)
    .HasTranslation(a =>
    {
        var jsonb = a[0].TypeMapping;
        var arr = new SqlFunctionExpression("COALESCE",
            [
                new SqlFunctionExpression("NULLIF", [a[0], new SqlFragmentExpression("'null'::jsonb")],
                    nullable: true, argumentsPropagateNullability: [false, false], typeof(string), jsonb),
                new SqlFragmentExpression("'[]'::jsonb"),
            ],
            nullable: false, argumentsPropagateNullability: [false, false], typeof(string), jsonb);
        var elem = new SqlFunctionExpression("to_jsonb",
            [new SqlUnaryExpression(ExpressionType.Convert, a[1], typeof(string), a[1].TypeMapping)],
            nullable: true, argumentsPropagateNullability: [true], typeof(string), jsonb);
        return new SqlFunctionExpression("jsonb_insert",
            [arr, new SqlFragmentExpression("'{-1}'"), elem, new SqlFragmentExpression("true")],
            nullable: true, argumentsPropagateNullability: [false, false, true, false],
            typeof(List<string>), jsonb);
    });
```

was Folgendes erzeugt:

```sql
SET "Data" = jsonb_set(t."Data", '{Labels}', jsonb_insert(COALESCE(NULLIF(t."Data" -> 'Labels', 'null'::jsonb), '[]'::jsonb), '{-1}', to_jsonb(@lbl::text), true))
```

Zwei Details dieser Übersetzung stammen aus Fehlschlägen, nicht aus Stilfragen. Meine erste Version umschloss das Array direkt mit `COALESCE(a[0], '[]')`, und der Nullability-Prozessor von EF entfernte das `COALESCE`, weil das Modell `Labels` als erforderliche, nicht nullbare Collection ausweist. Wird es zuerst in `NULLIF` gehüllt, ist der Ausdruck nullbar, das `COALESCE` bleibt erhalten, und JSON-`null` wird gleich mit abgedeckt. Der `Convert`-Knoten ist der `::text`-Cast. Ohne ihn setzt ein Aufruf mit einer Konstante (`JsonbFn.Push(t.Data.Labels, "a")`) `'a'` untypisiert inline ein und läuft in denselben `42804`-Fehler wie oben. Mit einer erfassten Variable funktionierte es in beiden Fällen, genau die Art Bug, die durch ein Code-Review rutscht.

Der Weg über eine Funktion in einer Migration ist weniger Code und leichter zu lesen. Greifen Sie zu `HasTranslation` nur, wenn das Anlegen einer Funktion in der Datenbank keine Option ist.

## Das Anhängen idempotent machen

Retries, At-least-once-Nachrichtenzustellung und doppelt geklickte Buttons machen aus "anhängen" ein "zweimal anhängen". Legen Sie den Guard in dieselbe Anweisung:

```csharp
// .NET 10, EF Core 10.0.4
var n = await db.Tickets
    .Where(t => t.Id == id && !t.Data.Labels.Contains(label))
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Data.Labels, t => JsonbFn.Push(t.Data.Labels, label)));
// n == 1 when the label was added, 0 when it was already there
```

Npgsql übersetzt `Contains` auf einer primitiven JSON-Collection in den Containment-Operator:

```sql
WHERE t."Id" = @id AND NOT ((t."Data" -> 'Labels') @> to_jsonb(@l))
```

Da PostgreSQL die `WHERE`-Klausel neu auswertet, nachdem es auf die Zeilensperre gewartet hat, hält das auch unter Nebenläufigkeit, nicht nur sequenziell. Zwanzig parallele Tasks, die alle `"dup"` anhängen, ergaben insgesamt genau eine betroffene Zeile und `["hardware", "dup"]`, bei jedem Durchlauf. Die Anzahl betroffener Zeilen beantwortet zugleich die Frage "habe ich es hinzugefügt", ohne zweite Abfrage. Wenn Sie Mengensemantik über *verschiedene* Zeilen hinweg brauchen, etwa "keine zwei Tickets teilen sich eine externe ID", gehört das in einen eindeutigen Index, nicht in ein JSON-Array.

## Wenn Sie tatsächlich Read-Modify-Write brauchen

Manchmal hängt das neue Element von den bestehenden ab, etwa "anhängen, außer das letzte Ereignis ist bereits `closed`", und diese Logik passt nicht sauber in SQL. Dann behalten Sie `SaveChangesAsync`, machen Lost Updates aber mit einem optimistischen Concurrency-Token erkennbar. Unter PostgreSQL ändert sich die Systemspalte `xmin` bei jedem Update, und Npgsql mappt sie über eine `uint`-Eigenschaft mit `[Timestamp]`:

```csharp
// .NET 10, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required TicketData Data { get; set; }

    [Timestamp]
    public uint Version { get; set; }   // mapped to xmin, no migration column
}
```

Jetzt wirft ein veralteter Schreibvorgang `DbUpdateConcurrencyException`, statt stillschweigend zu gewinnen, und Sie wiederholen den Vorgang nach erneutem Laden. Mit denselben 20 parallelen Anhängern und einer Schleife aus Neuladen und Wiederholen kamen alle 21 Labels an, zum Preis von **167** Konflikten und Wiederholungen. Diese Zahl ist der Grund, warum das Anhängen in der Datenbank die Standardempfehlung ist. Optimistische Nebenläufigkeit ist korrekt, aber unter Konkurrenz auf einer heißen Zeile wird sie zum Retry-Sturm.

## Stolperfallen, die Sie vor der Produktion kennen sollten

- **`ExecuteSqlRawAsync` und `SqlQueryRaw` behandeln geschweifte Klammern als Format-Platzhalter, selbst ohne Parameter.** `ExecuteSqlRawAsync("... jsonb_set(\"Data\", '{Labels}', ...)")` wirft `FormatException: Input string was not in a correct format`, bevor irgendetwas PostgreSQL erreicht. Verdoppeln Sie die Klammern (`'{{Labels}}'`) oder verwenden Sie das interpolierte `ExecuteSqlAsync` mit einem `$$`-Raw-String wie oben gezeigt.
- **Das Anhängen eines Arrays hängt seine Elemente an, nicht das Array.** `'["a"]' || '["b"]'` ergibt `["a", "b"]`. Wenn das angehängte Element selbst ein Array sein kann, umschließen Sie es: `|| jsonb_build_array(@x::jsonb)`.
- **`to_jsonb` auf einem JSON-String liefert einen String.** `'["a"]' || to_jsonb('{"k":1}'::text)` hängt den *Text* `"{\"k\":1}"` an. Serialisierte Objekte brauchen `::jsonb`, nicht `to_jsonb`.
- **`jsonb_set` legt fehlende Elternknoten nicht an.** `jsonb_set('{}', '{A,B}', '[1]')` gibt `{}` unverändert zurück. Stellen Sie bei einem verschachtelten Pfad sicher, dass das Elternobjekt existiert, oder bauen Sie es mit `jsonb_set` Ebene für Ebene auf.
- **Komplexe Collections können nicht Rückgabetyp einer gemappten Funktion sein.** Das Mappen von `List<TicketEvent> PushEvent(List<TicketEvent>, string)` scheitert beim Modellaufbau mit `The DbFunction 'JsonbFn.PushEvent(...)' has an invalid return type 'List<TicketEvent>'`. Für Arrays von Objekten verwenden Sie Option 1.
- **Die Reihenfolge ist die Commit-Reihenfolge, nicht die Aufrufreihenfolge.** Gleichzeitige Anhänge landen in der Reihenfolge, in der ihre Transaktionen committen, sodass `l11` vor `l10` kommen kann. Wenn die Reihenfolge wichtig ist, hängen Sie einen Zeitstempel oder eine Sequenznummer an und sortieren beim Lesen.
- **Achten Sie auf die Dokumentgröße.** Jedes Anhängen schreibt den gesamten `jsonb`-Wert auf der Platte neu (PostgreSQL kennt kein In-place-Update für JSON, und große Werte werden per TOAST ausgelagert). Ein Verlauf, der unbegrenzt wächst, gehört in eine eigene Tabelle.
- **Owned Types bekommen das nicht.** Die `ExecuteUpdate`-Unterstützung von EF Core für JSON setzt `ComplexProperty(...).ToJson()` voraus. Wenn Sie noch auf `OwnsOne(...).ToJson()` sind, bleibt nur Option 1.

### Weiterlesen

- [Wie man JSON-Spalten in EF Core 11 mappt und abfragt](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt das `ToJson()`-Mapping, auf dem dieser Beitrag aufbaut.
- [Complex Types vs. Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) erklärt, warum `ExecuteUpdate` in JSON nur für Complex Types funktioniert.
- [Wie man ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwendet](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) geht tiefer auf mengenbasierte Updates ein, einschließlich ihrer blinden Flecken beim Change Tracker.
- [EF Core ExecuteUpdate vs. Laden von Entitäten und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) vergleicht die beiden Schreibwege allgemein.
- [Wie man optimistische Nebenläufigkeit mit einem rowversion-Token in EF Core 11 umsetzt](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) ist das SQL-Server-Gegenstück zum obigen `xmin`-Ansatz.

### Quellen

- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html), PostgreSQL-Dokumentation (`||`, `@>`, `jsonb_set`, `jsonb_insert`)
- [Transaction Isolation: Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), PostgreSQL-Dokumentation
- [JSON Mapping](https://www.npgsql.org/efcore/mapping/json.html), Dokumentation des Npgsql-EF-Core-Providers
- [Concurrency Tokens](https://www.npgsql.org/efcore/modeling/concurrency.html), Dokumentation des Npgsql-EF-Core-Providers (`xmin`)
- [What's New in EF Core 10: ExecuteUpdate support for relational JSON columns](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#executeupdate-support-for-relational-json-columns), Microsoft Learn
- [User-defined function mapping](https://learn.microsoft.com/en-us/ef/core/querying/user-defined-function-mapping), EF-Core-Dokumentation
- [`NpgsqlQuerySqlGenerator.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Query/Internal/NpgsqlQuerySqlGenerator.cs), npgsql/efcore.pg
