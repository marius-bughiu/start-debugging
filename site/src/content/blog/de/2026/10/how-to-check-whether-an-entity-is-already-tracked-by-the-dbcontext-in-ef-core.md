---
title: "So prüfen Sie in EF Core, ob eine Entität bereits vom DbContext verfolgt wird, bevor Sie sie anfügen"
description: "Mit DbSet.Local.FindEntry(key) fragen Sie den Change Tracker, ob eine Entität mit einem bestimmten Schlüssel verfolgt wird, ohne Datenbankzugriff und ohne Scan. Warum Entry(entity).State bei dieser Frage in die Irre führt, warum Find eine Abfrage ausführt, und ein getesteter AttachOrMerge-Helper für EF Core 10."
pubDate: 2026-10-11
template: how-to
tags:
  - "ef-core"
  - "dotnet-10"
  - "csharp"
  - "change-tracker"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Kurze Antwort:** Rufen Sie `db.Set<T>().Local.FindEntry(id)` auf. Die Methode liefert den verfolgten `EntityEntry<T>` für diesen Primärschlüssel oder `null`, wenn nichts mit diesem Schlüssel verfolgt wird, und sie fragt die Datenbank nie ab. Liefert sie einen Entry, kopieren Sie Ihre Werte mit `entry.CurrentValues.SetValues(incoming)` darauf, statt anzufügen. Liefert sie `null`, ist `Attach` oder `Update` unbedenklich. Für zusammengesetzte Schlüssel verwenden Sie `Local.FindEntryUntyped([part1, part2])`. Verwenden Sie für diese Prüfung nicht `db.Entry(incoming).State == EntityState.Detached`: Das sagt nur etwas über diese eine Objektinstanz aus, nicht über den Schlüssel.

Alles Folgende wurde mit EF Core 10.0.12 (`Microsoft.EntityFrameworkCore.Sqlite` 10.0.12) auf dem .NET 10 SDK 10.0.302 ausgeführt. Die `LocalView<T>.FindEntry`-Familie wurde in EF Core 8 hinzugefügt ([dotnet/efcore#29686](https://github.com/dotnet/efcore/pull/29686)), derselbe Code funktioniert also in EF Core 8, 9, 10 und den Release Candidates von EF Core 11.

## Warum "wird verfolgt?" eine Frage nach Schlüsseln ist, nicht nach Objekten

Der Change Tracker führt eine Identity Map: pro Entitätstyp eine verfolgte CLR-Instanz je Primärschlüsselwert. Rufen Sie `Attach`, `Update` oder `Add` mit einer zweiten Instanz auf, deren Schlüssel bereits in der Map steht, wirft EF Core die bekannte Ausnahme [`The instance of entity type cannot be tracked because another instance with the same key value is already being tracked`](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

Die Frage, die Sie vor dem Anfügen beantworten müssen, lautet also: "Enthält die Identity Map bereits *irgendeine* Instanz mit diesem Schlüssel?" Das ist etwas anderes als "Wird *diese* Instanz verfolgt?", und die am häufigsten empfohlene Prüfung beantwortet die zweite Frage.

## Ein minimales Beispiel für die Falle

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite
using var db = new Shop(options);

var tracked  = db.Customers.First(c => c.Id == 1);           // tracked, Unchanged
var incoming = new Customer { Id = 1, Name = "changed" };    // e.g. deserialized from a request

Console.WriteLine(db.Entry(tracked).State);   // Unchanged
Console.WriteLine(db.Entry(incoming).State);  // Detached  <-- looks "safe"

db.Attach(incoming);
// InvalidOperationException: The instance of entity type 'Customer' cannot be tracked
// because another instance with the same key value for {'Id'} is already being tracked.
```

`db.Entry(incoming)` liefert bereitwillig einen Entry im Zustand `Detached`, weil `incoming` tatsächlich nicht verfolgt wird. Es wirft nicht und beginnt auch nicht, das Objekt zu verfolgen (der Change Tracker hielt in meinem Lauf danach weiterhin genau einen Entry). Code wie `if (db.Entry(x).State == EntityState.Detached) db.Attach(x);` besteht die Prüfung und wirft dann in der nächsten Zeile. Dieses Muster ist in Ordnung für die Frage "Habe ich genau dieses Objekt schon angefügt?", aber falsch in getrennten Szenarien, in denen das Objekt aus einem DTO, einem Cache oder einem JSON-Body stammt.

## Die Optionen im Vergleich

Ich habe einen Zähler an `CoreEventId.DetectChangesStarting` gehängt und einen `DbCommandInterceptor`, der ausgeführte Reader zählt, und dann jeden Kandidaten gegen einen Kontext laufen lassen, der einen `Customer` verfolgt:

| Prüfung | Beantwortet die Schlüsselfrage? | `DetectChanges`-Durchläufe | Datenbankabfragen |
| --- | --- | --- | --- |
| `db.Entry(incoming).State` | Nein, nur für diese Instanz | 0 | 0 |
| `db.ChangeTracker.Entries<Customer>().Any(e => e.Entity.Id == 1)` | Ja, per linearem Scan | 1 | 0 |
| `db.Customers.Find(1)` (verfolgt) | Ja, liefert die verfolgte Instanz | 0 | 0 |
| `db.Customers.Find(2)` (nicht verfolgt) | Keine Prüfung: lädt die Zeile | 0 | 1 |
| `db.Customers.Local.FindEntry(1)` | Ja, per Identity-Map-Lookup | 1 (vom `Local`-Getter) | 0 |
| `cachedLocal.FindEntry(1)` | Ja | 0 | 0 |

Einige Punkte fallen auf.

**`Find` ist keine Prüfung auf Verfolgung.** Es schaut zuerst in die Identity Map, weshalb der verfolgte Fall nichts kostet, aber wenn der Schlüssel nicht verfolgt wird, geht es zur Datenbank und beginnt, alles Gefundene zu verfolgen. Wer `Find` benutzt, um über das Anfügen zu entscheiden, lädt entweder eine Zeile, die er nicht wollte, oder erhält eine verfolgte Instanz und fügt dann die eigene Kopie darüber an, was eine Ausnahme wirft.

**`ChangeTracker.Entries<T>()` funktioniert, scannt aber.** Es führt zuerst `DetectChanges` aus und durchläuft dann jeden verfolgten Entry dieses Typs. Bei zehn Entitäten ist das vernachlässigbar. Bei einem langlebigen Kontext in einer Desktop-App oder einem Batch-Job mit zehntausenden Entries ist es quadratisch, wenn man es pro eingehendem Element ausführt. (In EF Core 11 überspringt die [`GetEntriesForState`-API](/de/2026/04/efcore-11-changetracker-getentriesforstate/) den `DetectChanges`-Durchlauf, ist aber weiterhin eine Enumeration.)

**`Local.FindEntry` ist die dafür gedachte API.** Sie löst den Schlüssel über dieselbe Identity Map auf, die `Attach` prüft, und liefert damit genau die Antwort, nach der `Attach` handeln wird. Das eine `DetectChanges` in der Tabelle stammt vom `DbSet<T>.Local`-Getter, nicht von `FindEntry`: Als ich die `LocalView<Customer>` in einer Variablen zwischengespeichert und darauf `FindEntry` aufgerufen habe, blieb der Zähler bei null. Die [API-Dokumentation](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry) sagt dasselbe und empfiehlt, das `Local`-Objekt für wiederholte Lookups wiederzuverwenden.

## Prüfen, dann anfügen oder zusammenführen

So gehen Sie bei einer Aktualisierung mit getrennten Entitäten vor, dem Szenario, in dem diese Frage meistens auftaucht:

1. Holen Sie die lokale Sicht einmal: `var local = db.Customers.Local;`.
2. Suchen Sie den Schlüssel mit `local.FindEntry(incoming.Id)`.
3. Kommt ein Entry zurück, kopieren Sie die eingehenden Werte mit `entry.CurrentValues.SetValues(incoming)` auf die verfolgte Instanz. EF Core markiert nur die Eigenschaften als geändert, deren Werte sich tatsächlich unterscheiden.
4. Kommt `null` zurück, hält nichts diesen Schlüssel, sodass `Update(incoming)` (oder `Attach` plus explizite `IsModified`-Flags) unbedenklich ist.
5. Rufen Sie am Ende einmal `SaveChanges` auf.

Als Helper:

```csharp
// .NET 10, EF Core 10.0.12
static Customer AttachOrMerge(Shop db, Customer incoming)
{
    var existing = db.Customers.Local.FindEntry(incoming.Id);
    if (existing is null)
    {
        db.Customers.Update(incoming);   // nothing tracked with this key
        return incoming;
    }

    existing.CurrentValues.SetValues(incoming);  // merge into the tracked instance
    return existing.Entity;
}
```

Ausgeführt gegen den Kontext, der Kunde 1 bereits verfolgt:

```text
Helper: same=True state=Modified name=merged modifiedProps=Name
```

Das zurückgegebene Objekt ist die Instanz, die der Kontext bereits verfolgt hat, sein Zustand wechselte von `Unchanged` zu `Modified`, und nur `Name` ist markiert, sodass das erzeugte `UPDATE` eine einzige Spalte betrifft. Geben Sie den Aufrufern die verfolgte Instanz zurück statt `incoming`: Nach dem Zusammenführen ist `incoming` weiterhin ein getrenntes Objekt, von dem EF Core nichts weiß.

## Eine generische Version für beliebige Entitätstypen

Sie wollen selten einen Helper pro Entität. `FindEntryUntyped` nimmt die Schlüsselwerte als `IEnumerable<object?>` in Schlüsselreihenfolge entgegen, und das Modell verrät, welche Eigenschaften den Primärschlüssel bilden:

```csharp
// .NET 10, EF Core 10.0.12
static EntityEntry<T>? FindTrackedEntry<T>(DbContext db, T entity) where T : class
{
    var key = db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!;
    var entry = db.Entry(entity);   // Detached entry, does not start tracking
    var keyValues = key.Properties
        .Select(p => entry.Property(p.Name).CurrentValue)
        .ToArray();

    return db.Set<T>().Local.FindEntryUntyped(keyValues);
}

static bool IsTracked<T>(DbContext db, params object?[] keyValues) where T : class
    => db.Set<T>().Local.FindEntryUntyped(keyValues) is not null;
```

Den Schlüssel über `db.Entry(entity).Property(...)` statt über Reflection zu lesen, sorgt dafür, dass Schlüssel aus Shadow Properties und auf Felder abgebildete Schlüssel ohne Sonderfälle funktionieren. Im Beispiel fand `FindTrackedEntry(db, incoming)` den verfolgten Kunden, obwohl `incoming` selbst ein anderes Objekt war, also genau das Verhalten, das der `Entry(...).State`-Prüfung fehlt.

## Stolperfallen

### Zusammengesetzte Schlüssel brauchen `FindEntryUntyped`, nicht `FindEntry`

`FindEntry` ist generisch, `FindEntry<TKey>(TKey keyValue)`. Übergeben Sie ein Array oder eine Liste, bindet der Compiler `TKey` bereitwillig an `object[]` oder `List<object?>`, und EF Core behandelt das Ganze als einen einzigen Schlüsselwert:

```csharp
// .NET 10, EF Core 10.0.12. OrderLine has HasKey(x => new { x.OrderId, x.LineNo })
db.OrderLines.Local.FindEntry(new object[] { 10, 1 });
// ArgumentException: Entity type 'OrderLine' is defined with a 2-part composite key,
// but 1 values were passed to the 'Find' method.

db.OrderLines.Local.FindEntryUntyped([10, 1]);   // works, returns the tracked entry
```

Ich habe auch eine Variable vom Typ `IEnumerable<object?>` probiert, in der Hoffnung, eine nicht generische Überladung zu treffen. Dieselbe Ausnahme: Für Primärschlüssel gibt es keine Überladung `FindEntry(IEnumerable<object?>)`, die untypisierte Variante hat einen eigenen Namen.

### Der Schlüsseltyp muss exakt passen

`FindEntry<TKey>` konvertiert nicht. Bei einem `int`-Schlüssel:

```text
FindEntry(1L): ArgumentException: Property 'Customer.Id' is of type 'int' but the generic type provided is of type 'long'.
```

`FindEntryUntyped` ist nicht nachsichtiger, es prüft stattdessen den geboxten Typ:

```text
FindEntryUntyped([1L]): ArgumentException: The 'FindEntry' or 'GetEntries' method was passed a 'long' value for the 'Id' property, when a 'int' value was expected.
```

Das tritt auf, wenn der Schlüssel aus einem Routenwert oder einem generischen Repository kommt, das als `long` oder `object` typisiert ist. Konvertieren Sie vor dem Aufruf in den CLR-Typ der Schlüsseleigenschaft (`key.Properties[i].ClrType`).

### Gelöschte Entitäten werden weiterhin verfolgt

Nach `db.Customers.Remove(customer2)`:

```text
FindEntry(2) after Remove: Deleted; Local.Count=1; Find(2)=entity
```

Die lokale *Collection* blendet `Deleted`-Entitäten aus (`Local.Count` fiel auf 1, wie [die Dokumentation beschreibt](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries#the-local-view)), aber `FindEntry` liefert den Entry weiterhin, ebenso `Find`. Für unseren Zweck ist das richtig, da der Schlüssel noch in der Identity Map steht und `Attach` weiterhin werfen würde. Wenn Ihre Merge-Logik jedoch annimmt, "gefunden" bedeute "lebendig", prüfen Sie `entry.State`, bevor Sie `SetValues` aufrufen, sonst übertragen Sie Eigenschaftsänderungen auf eine Zeile, die `SaveChanges` gleich löscht.

### "Nicht verfolgt" heißt nicht "existiert in der Datenbank"

Liefert `FindEntry` `null`, ruft der Helper `Update` auf, was jede Eigenschaft als geändert markiert und ein `UPDATE` erzeugt. Bei einem Schlüssel, den es in der Tabelle nicht gibt, betrifft `SaveChanges` null Zeilen und wirft `DbUpdateConcurrencyException`. Im Beispiel ließ `AttachOrMerge(db, new Customer { Id = 3 })` die Entität in `Modified`, nicht in `Added`. Wenn das eingehende Objekt neu sein kann, entscheiden Sie das anhand Ihrer eigenen Daten (ein Standardschlüssel, eine Versionsspalte, ein explizites Flag), bevor Sie zwischen `Add` und `Update` wählen. Eine weitere Möglichkeit ist, das Tracking ganz zu umgehen und für den Schreibvorgang [`ExecuteUpdate`](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) zu verwenden.

### Standardschlüsselwerte bei vom Speicher erzeugten Schlüsseln

Wer einen `Customer` mit `Id` gleich `0` anfügt, löst weder eine Ausnahme noch eine Kollision aus: EF Core erkennt einen nicht gesetzten, vom Speicher erzeugten Schlüssel und verfolgt die Entität als `Added` mit einem temporären Wert. `FindEntry(0)` vorab zu prüfen, sagt dort nichts Nützliches aus. Verzweigen Sie anhand von `entry.IsKeySet` (oder `id == default`), bevor Sie den Lookup ausführen.

### Lookups über alternative Schlüssel oder Fremdschlüssel

`LocalView<T>` hat außerdem `FindEntry<TProperty>(string propertyName, TProperty value)` und `GetEntries(...)` für Lookups jenseits des Primärschlüssels, zum Beispiel `Local.FindEntry(nameof(Customer.Email), email)`. Diese sind schnell, wenn die Eigenschaft ein alternativer Schlüssel oder Fremdschlüssel ist, weil EF Core für diese bereits Lookups pflegt. Bei gewöhnlichen Eigenschaften fallen sie auf einen Scan der verfolgten Entries zurück. Im Beispiel lieferte `Local.FindEntry(nameof(Customer.Name), "a")` den richtigen Entry, aber `Name` ist kein Schlüssel, es war also ein Scan.

### AutoDetectChanges ausschalten

Mit `db.ChangeTracker.AutoDetectChangesEnabled = false` löst weder der `Local`-Getter noch `Entries<T>()` ein `DetectChanges` aus (Zähler jeweils bei 0). Identity-Map-Lookups sind davon nicht betroffen, da sich Schlüssel einer verfolgten Entität nicht ändern können. Schalten Sie die automatische Erkennung für eine Massenimport-Schleife aus, rufen Sie vor `SaveChanges` selbst `db.ChangeTracker.DetectChanges()` auf, wenn Sie verfolgte Entitäten direkt verändern.

## Wenn die bessere Lösung ist, gar nicht zu verfolgen

Steht die Prüfung in Ihrem Code, weil ein früheres Lesen im selben Kontext die Entität verfolgt hat, die Sie jetzt aktualisieren wollen, liegt die sauberere Lösung oft weiter vorn. Lesen Sie mit `AsNoTracking()`, wenn das Ergebnis nur angezeigt oder auf ein DTO abgebildet wird (der Vergleich [AsNoTracking vs AsNoTrackingWithIdentityResolution](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) behandelt, welche Variante zu wählen ist), und halten Sie Kontexte kurzlebig, damit eine Arbeitseinheit nicht die verfolgten Entitäten einer anderen erbt. `FindEntry` ist das richtige Werkzeug, wenn ein Kontext legitimerweise denselben Schlüssel aus zwei Richtungen sieht: eine Desktop-App mit langlebigem Kontext, ein Batch-Job, der Datensätze aus mehreren Dateien zusammenführt, oder ein Graph, der sich teilweise mit bereits geladenen Entitäten überschneidet.

Derselbe Lookup ist auch in Tests nützlich. Wenn Sie den Provider durch einen Fake ersetzt haben und Ihre Assertions davon abhängen, was verfolgt wird, liest `Local.FindEntry` die echte Identity Map, was Sie ehrlich hält, wie in [mocking a DbContext without breaking change tracking](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) beschrieben.

### Weiterlesen

- [Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/de/2026/04/efcore-11-changetracker-getentriesforstate/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [ExecuteUpdate vs loading entities and SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Quellen

- [`LocalView<TEntity>.FindEntry` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry), Microsoft Learn.
- [`LocalView<TEntity>.FindEntryUntyped` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentryuntyped), Microsoft Learn.
- [Accessing tracked entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries), EF Core docs (Entry, Find, Entries, die lokale Sicht und ihre `DetectChanges`-Kosten).
- [Lookup entities by primary key, alternate key, or foreign key](https://github.com/dotnet/efcore/pull/29686), dotnet/efcore PR #29686 (im Dezember 2022 gemergt, ausgeliefert in EF Core 8).
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), EF Core docs.
