---
title: "Fix: Complex entry original ordinal '-1' is invalid beim Speichern einer ToJson-Complex-Collection"
description: "Aktualisieren Sie Microsoft.EntityFrameworkCore auf 10.0.10 oder neuer. Davor stürzte SaveChanges ab, wenn eine verschachtelte Collection unter einer zweiten ToJson-Complex-Property wuchs."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "change-tracker"
  - "json"
  - "dotnet-10"
lang: "de"
translationOf: "2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection"
translatedBy: "claude"
translationDate: 2026-09-09
---

Aktualisieren Sie `Microsoft.EntityFrameworkCore` auf 10.0.10 oder neuer. Zwischen 10.0.0 und 10.0.9 galt: Wenn eine Entität zwei oder mehr Complex Properties mit `ToJson()` abbildete und eine darin verschachtelte Collection zwischen Laden und Speichern ein Element dazugewann, zwang der Change Tracker jeden abgeflachten Complex Entry in `Modified` oder `Unchanged`, einschließlich der Einträge, die berechtigterweise `Added` waren. Ein `Added`-Element hat konstruktionsbedingt das ursprüngliche Ordinal `-1`, also lief der Zustandswechsel direkt in `ValidateOrdinal` und warf eine Exception. Der Fix ist eine einzeilige Absicherung in `InternalEntryBase`, er ist providerunabhängig, und nach dem Update müssen Sie keine Konfiguration ändern.

## Der Fehler im Kontext

Die Exception tritt aus `SaveChanges` oder `SaveChangesAsync` auf, bevor SQL gesendet wird:

```
System.InvalidOperationException: Complex entry original ordinal '-1' is invalid for property
'XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner' as it's outside of the collection
of length '1'.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.
      InternalComplexCollectionEntry.ValidateOrdinal(InternalComplexEntry entry, Boolean original)
```

Der Property-Pfad in der Meldung ist eine abgeflachte Kette, kein C#-Ausdruck. `[]` markiert einen Sprung durch eine Complex Collection, `XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner` liest sich also als "die Collection `Inner` auf `XInnerEntry`, die in einem `XDeepItem`-Element liegt, das in einem `XMiddleData`-Element liegt, das an `XDeepData` auf `XWidget` hängt". Dieser Pfad ist der schnellste Weg zur betroffenen Property.

Zwei Details lohnen sich vor dem Weiterlesen, denn sie unterscheiden diesen Fehler von seinen Doppelgängern. Erstens sagt die Meldung **original ordinal** und **for property**. Die Schwestermeldung sagt **ordinal** und **for the collection** und hat eine andere Ursache. Zweitens ist die Zahl am Ende die Größe der *ursprünglichen* Collection, also der aus der Datenbank geladenen, nicht die der Collection, die Sie speichern wollen.

## Warum das Ordinal -1 ist: was EF Core bei einer Complex Collection tatsächlich verfolgt

Complex Collections kamen mit EF Core 10 und müssen bei relationalen Providern über `ToJson()` auf eine einzelne JSON-Spalte abgebildet werden. Eine eigene Tabelle ist nicht möglich. Diese Einschränkung ist hier entscheidend: Da es weder Tabelle noch Schlüssel gibt, kann EF ein Element nicht über seinen Primärschlüssel identifizieren wie bei einer Owned Entity. Es identifiziert es über die **Position im Array**.

Der Change Tracker hält deshalb zwei Positionen pro Element vor, in `InternalComplexEntry`:

```csharp
// EF Core 10.0 / 11.0, src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs
public int Ordinal
{
    // -1 is used to indicate that the entry is deleted
    get;
    set { /* ... */ }
}

public int OriginalOrdinal
{
    // -1 is used to indicate that the entry is added
    get;
    set { /* ... */ }
}
```

`Ordinal` ist die Position des Elements in der Collection, die Sie gleich speichern. `OriginalOrdinal` ist die Position in der Collection, die EF materialisiert hat. Die beiden Sentinel-Werte erklären alles:

- Ein **gelöschtes** Element hat keine Position in der aktuellen Collection, sein `Ordinal` ist also `-1`.
- Ein **hinzugefügtes** Element hat keine Position in der ursprünglichen Collection, sein `OriginalOrdinal` ist also `-1`.

Jeder Zustandswechsel in einen verfolgten Zustand schickt das entsprechende Ordinal durch eine Bereichsprüfung:

```csharp
// EF Core 10.0, InternalEntryBase.InternalComplexCollectionEntry.ValidateOrdinal
public readonly int ValidateOrdinal(InternalComplexEntry entry, bool original, List<InternalComplexEntry?> entries)
{
    var ordinal = original ? entry.OriginalOrdinal : entry.Ordinal;
    if (ordinal < 0 || ordinal >= entries.Count)
    {
        var property = entry.ComplexProperty;
        throw new InvalidOperationException(
            original
                ? CoreStrings.ComplexCollectionEntryOriginalOrdinalInvalid(/* ... */)
                : CoreStrings.ComplexCollectionEntryOrdinalInvalid(/* ... */));
    }
    // ...
}
```

Diese Prüfung ist für sich genommen korrekt. `-1` liegt tatsächlich außerhalb des Bereichs. Der Fehler war, dass weiter oben etwas einen `Added`-Eintrag aufforderte, `Modified` zu werden, und `Added -> Modified` ist genau der Wechsel, der das ursprüngliche Ordinal validiert. Ein Eintrag, der `OriginalOrdinal == -1` haben soll, wurde durch einen Codepfad geschoben, der genau das verbietet.

Der aufrufende Codepfad war `SetComplexCollectionModified`. Wenn die Änderungserkennung feststellte, dass sich eine Complex Collection geändert hatte, lief sie über `GetFlattenedComplexEntries()`, das jeden Complex Entry im gesamten verschachtelten Graphen der Entität zurückgibt, und setzte jeden auf `Modified` oder `Unchanged`. Neu hinzugefügte Elemente wurden dabei mitgerissen.

## Minimales Repro: zwei JSON-Complex-Properties und eine wachsende verschachtelte Collection

Der Melder von [dotnet/efcore#38299](https://github.com/dotnet/efcore/issues/38299) grenzte den Auslöser auf vier Bedingungen ein, die gemeinsam erfüllt sein müssen:

1. Die Entität bildet zwei oder mehr Complex Properties mit `ToJson()` ab.
2. Eines dieser JSON-Dokumente enthält verschachtelte Objekte, die selbst Collections halten.
3. Der Elementtyp einer verschachtelten Collection deklariert zwei oder mehr `List<T>`-Untercollections.
4. Eine dieser Untercollections wächst zwischen Laden und Speichern.

Fehlt eine davon, speichert die Entität sauber, weshalb das in einer echten Codebasis sporadisch wirkt. Hier das kleinste Modell, das alle vier erfüllt:

```csharp
// .NET 10, EF Core 10.0.7, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.1
public class Widget
{
    public int Id { get; set; }
    public required FlatData Flat { get; set; }   // JSON column 1
    public required DeepData Deep { get; set; }   // JSON column 2
}

public class FlatData
{
    public string? Note { get; set; }
}

public class DeepData
{
    public List<MiddleData> Middle { get; set; } = [];
}

public class MiddleData
{
    public string Name { get; set; } = "";
    public List<InnerEntry> Inner { get; set; } = [];   // sub-collection 1
    public List<InnerEntry> Extra { get; set; } = [];   // sub-collection 2
}

public class InnerEntry
{
    public string Value { get; set; } = "";
}
```

Das Mapping nutzt `ComplexProperty` für die beiden Wurzeln und `ComplexCollection` für alles Verschachtelte. `ToJson()` auf der Wurzel genügt; die verschachtelten Collections erben das JSON-Mapping:

```csharp
// .NET 10, EF Core 10.0.7
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Widget>(b =>
    {
        b.ComplexProperty(w => w.Flat, c => c.ToJson());

        b.ComplexProperty(w => w.Deep, c =>
        {
            c.ToJson();
            c.ComplexCollection(d => d.Middle, m =>
            {
                m.ComplexCollection(x => x.Inner);
                m.ComplexCollection(x => x.Extra);
            });
        });
    });
}
```

Und die beiden Zeilen, die es zerlegen:

```csharp
// .NET 10, EF Core 10.0.7. Throws on SaveChangesAsync, before any SQL is generated.
var widget = await db.Widgets.SingleAsync(w => w.Id == 1);
widget.Deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });
await db.SaveChangesAsync();
```

Nichts davon ist exotisch. Genau diese Form entsteht, sobald Sie Microsofts eigenem Rat folgen und einen JSON-gemappten Owned-Entity-Graphen auf Complex Types umstellen, weshalb sich die Meldungen bei Teams häufen, die diese Migration gerade machen. Wenn Sie diesen Schritt abwägen: [Complex Types gegenüber Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) behandelt die Abwägungen, und die [Schritt-für-Schritt-Mapping-Anleitung](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) behandelt die Konfiguration.

## Fix, im Detail

### Auf EF Core 10.0.10 oder neuer aktualisieren

Das ist der eigentliche Fix, ausgeliefert mit [PR #38373](https://github.com/dotnet/efcore/pull/38373) gegen `release/10.0`. Heben Sie alle EF-Core-Pakete gemeinsam an, den Provider eingeschlossen:

```xml
<!-- .NET 10. Bump the provider package to a matching 10.0.x too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.12" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.12" />
```

Die Änderung bringt dem rekursiven Durchlauf bei, `Added`-Einträge in Ruhe zu lassen:

```csharp
// EF Core 10.0.10+, InternalEntryBase.SetComplexCollectionModified
if (recurse)
{
    var newElementState = isModified ? EntityState.Modified : EntityState.Unchanged;
    foreach (var complexEntry in GetFlattenedComplexEntries())
    {
        // Added elements represent pending additions with no original ordinal, so forcing them to
        // Modified/Unchanged is incorrect and would fail the original ordinal validation. Leave their
        // state (computed by change detection) untouched, mirroring the bulk state-change logic in
        // InternalComplexCollectionEntry.SetState.
        if (!UseOldBehavior38299
            && complexEntry.EntityState is EntityState.Added)
        {
            continue;
        }

        complexEntry.SetEntityState(newElementState, modifyProperties: true);
    }
}
```

Aus dem Patch folgen zwei Dinge. Die Absicherung sitzt im gemeinsamen Change Tracker, oberhalb der Provider-Abstraktion, und behebt damit SQL Server, Npgsql und SQLite in einem Zug; wer gehofft hat, ein reines Provider-Update genüge, wird enttäuscht. Und dieselbe Absicherung steckt ohne das Flag `UseOldBehavior38299` in der EF-Core-11-Codebasis, ein Update auf EF Core 11 räumt das Problem also ebenfalls aus.

### Wenn Sie unter 10.0.10 festhängen: die JSON-Spalte ohne Change Tracker schreiben

Der Absturz liegt vollständig im Change Tracking. `ExecuteUpdateAsync` kommt ihm nie nahe, und EF Core 10 kann eine JSON-gemappte Complex Property direkt ansprechen:

```csharp
// .NET 10, EF Core 10.0.7. Untracked read, then a set-based write.
var deep = await db.Widgets
    .AsNoTracking()
    .Where(w => w.Id == id)
    .Select(w => w.Deep)
    .SingleAsync();

deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });

await db.Widgets
    .Where(w => w.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Deep, deep));
```

Dafür geben Sie die üblichen Zusagen von `SaveChanges` auf: keine Prüfung des optimistischen Concurrency-Tokens, keine Interceptors auf dem Schreibvorgang, und es wird das gesamte JSON-Dokument neu geschrieben statt nur des geänderten Pfads. Prüfen Sie die Übersetzung gegen Ihren Provider, bevor Sie sich darauf festlegen, und wenn Sie breiter zu `ExecuteUpdate` greifen, sind die Abwägungen in [ExecuteUpdate gegenüber Entitäten laden und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) durchgearbeitet.

### Wenn Sie das Modell ändern können: eine der vier Bedingungen brechen

Bedingung 1 lässt sich am günstigsten beseitigen. Der Durchlauf erzeugt die schlechte Paarung aus `Added` und `-1` nur, wenn die Entität mehr als eine JSON-Complex-Property trägt; die zweite stattdessen per Table Splitting abzubilden nimmt sie aus dem Spiel:

```csharp
// .NET 10, EF Core 10.0.7. Flat becomes Flat_Note on the Widgets table.
b.ComplexProperty(w => w.Flat);   // no ToJson()
```

Das braucht eine Migration und ändert Ihre Speicherform, behandeln Sie es also als letztes Mittel und nicht als schnelle Entsperrung. Bedingung 3 ist das andere weiche Ziel: Deklariert der verschachtelte Elementtyp nur eine `List<T>`, fällt die Form aus dem gemeldeten Auslöser heraus. Keines von beidem ist eine Zusage des EF-Teams, es ist die minimierte Auslöserliste des Melders umgedreht, prüfen Sie es also gegen Ihr eigenes Modell, bevor Sie sich darauf verlassen.

## Fallstricke und Varianten: die anderen Ordinal-Fehler dieser Familie

Drei weitere Meldungen stammen aus derselben Ecke des Change Trackers und werden mit dieser verwechselt.

**`Complex entry ordinal '-1' is invalid for the collection '...' as it's outside of the collection of length 'N'.`** Achten Sie auf den Wortlaut: *ordinal*, nicht *original ordinal*, und *for the collection*, nicht *for property*. Diese Meldung erscheint, wenn Sie eine Entität von `Deleted` zurück auf `Unchanged` setzen, also beim klassischen handgeschriebenen Soft-Delete-Tanz. Das war [dotnet/efcore#37724](https://github.com/dotnet/efcore/issues/37724), behoben in **10.0.6**, indem das aktuelle Ordinal aus dem ursprünglichen wiederhergestellt wird:

```csharp
// EF Core 10.0.6+, InternalComplexEntry.SetEntityState
if (oldState is EntityState.Detached or EntityState.Deleted
    && newState is not EntityState.Detached and not EntityState.Deleted)
{
    if (!UseOldBehavior37724 && Ordinal == -1)
    {
        Ordinal = OriginalOrdinal;
    }

    ContainingEntry.ValidateOrdinal(this, original: false);
}
```

Wenn Sie Soft Delete durch manuelles Umschalten von `EntityState` umsetzen, überdenken Sie das grundsätzlich: [benannte Query-Filter](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) drücken dieselbe Absicht aus, ohne den Change Tracker anzufassen.

**`Index was out of range. Must be non-negative and less than the size of the collection.`** Eine `ArgumentOutOfRangeException`, keine `InvalidOperationException`, geworfen nachdem das Datenbank-Update bereits erfolgreich war, während der Accept-Changes-Phase. Das ist [dotnet/efcore#37585](https://github.com/dotnet/efcore/issues/37585), ausgelöst durch das Entfernen eines Elements aus einer Complex Collection, deren Elemente eigene Listen enthalten. Ebenfalls behoben in **10.0.6**.

**`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.`** Eine nullbare Complex Property, die eine Collection enthält, auf einer verfolgten Entität auf `null` zu setzen, wobei die verschachtelte Collection zwei oder mehr Elemente hat. Das ist [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632), eingeplant für **10.0.13**. Mit EF Core 10.0.12, dem aktuellsten stabilen Patch, ist es noch offen, ein Update hilft bei dieser Meldung also noch nicht.

Es gibt auch einen Fall, in dem der Ordinal-Fehler wirklich Ihr Fehler ist und nicht der von EF. `ComplexCollectionEntry` bietet einen Indexer und `GetOriginalEntry(int)`, und beide validieren:

```csharp
// .NET 10, EF Core 10.0.12. Throws if the collection has fewer than 4 elements.
var entry = db.Entry(widget).ComplexCollection(w => w.Deep.Middle)[3];

// Throws if the collection loaded from the database had fewer than 4 elements,
// even when the current collection is longer.
var original = db.Entry(widget).ComplexCollection(w => w.Deep.Middle).GetOriginalEntry(3);
```

Die zweite Zeile ist die Falle. Einen ursprünglichen Eintrag an einem Index zu lesen, den es erst nach Ihren In-Memory-Ergänzungen gibt, erzeugt denselben *original ordinal*-Wortlaut wie der obige Fehler, nur mit einem positiven Ordinal statt `-1`. Ist das Ordinal in Ihrer Meldung nicht `-1`, sehen Sie Ihre eigene Index-Arithmetik.

## Was macht der Schalter Microsoft.EntityFrameworkCore.Issue38299 wirklich?

Jeder dieser Patches wird auf dem Branch `release/10.0` hinter einem `AppContext`-Kompatibilitätsschalter ausgeliefert:

```csharp
// EF Core 10.0.x, InternalEntryBase.InternalComplexCollectionEntry.cs
internal static readonly bool UseOldBehavior37724 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue37724", out var enabled) && enabled;

internal static readonly bool UseOldBehavior38299 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue38299", out var enabled) && enabled;
```

Lesen Sie die Richtung genau, denn sie ist das Gegenteil dessen, was der Name den meisten nahelegt. Den Schalter auf `true` zu setzen **stellt das alte, fehlerhafte Verhalten wieder her**. Er existiert, damit ein Team, das auf dem Fehler einen Workaround aufgebaut hat, ein Patch-Release übernehmen kann, ohne dass der Workaround bricht. Er ist kein Fix, und ihn einzuschalten bringt genau die Exception zurück, wegen der Sie hier sind.

Wenn Sie das alte Verhalten wirklich vorübergehend festschreiben müssen, gehört das in die Projektdatei und nicht in den Code, damit es gesetzt ist, bevor irgendein EF-Typ geladen wird:

```xml
<!-- .NET 10. Restores pre-10.0.10 behaviour. Do not use this to "fix" the crash. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.Issue38299" Value="true" />
</ItemGroup>
```

Die Schalter dienen zugleich als Changelog. Ein `grep` nach `UseOldBehavior` in `src/EFCore/ChangeTracking/Internal/` liefert die vollständige Liste dessen, was sich im Complex-Collection-Tracking über die 10.0-Patchreihe bewegt hat: `37724` und `38299` auf `InternalEntryBase`, `37585` und `38632` im verschachtelten Struct `InternalComplexCollectionEntry`.

Weil alle vier Fehler im Change Tracking und nicht in der SQL-Generierung liegen, taucht keiner davon in einem Query-Log, in einer Profiler-Trace oder in einem Diff von `dotnet ef migrations script` auf. Das erste Signal ist immer eine Exception bei `SaveChanges` mit einem `ValidateOrdinal`-Frame nahe der Spitze des Stacks. Sehen Sie diesen Frame, hören Sie auf, Ihre Modellkonfiguration zu lesen, und gehen Sie direkt zu Ihren Paketversionen.

## Verwandte Beiträge

- [Complex Types gegenüber Owned Entities in EF Core 11: was sollten Sie wählen?](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Einen Complex Type statt einer Owned Entity in EF Core 11 abbilden](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)
- [JSON-Spalten in EF Core 11 abbilden und abfragen](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [Fix: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause](/de/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)
- [Benannte Query-Filter für Soft Delete und Mandantenfähigkeit in EF Core 11 nutzen](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)

## Quellen

- [dotnet/efcore#38299: ComplexProperty ToJson(): SaveChangesAsync throws "ordinal -1 is invalid" when nested sub-collection grows](https://github.com/dotnet/efcore/issues/38299)
- [dotnet/efcore#38373: der Fix, gegen release/10.0](https://github.com/dotnet/efcore/pull/38373)
- [dotnet/efcore#37724: Can't change state of entity with complex collection](https://github.com/dotnet/efcore/issues/37724)
- [dotnet/efcore#37585: Deleting an item from a ComplexCollection that contains an array results in Error](https://github.com/dotnet/efcore/issues/37585)
- [dotnet/efcore#38632: DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [Complex Types, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [InternalComplexEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
