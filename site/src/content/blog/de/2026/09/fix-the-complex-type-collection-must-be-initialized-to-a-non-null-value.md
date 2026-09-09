---
title: "Lösung: The complex type collection must be initialized to a non-null value"
description: "In EF Core 10.0.x bricht DetectChanges, wenn eine komplexe Eigenschaft mit einer zweielementigen Sammlung innerhalb einer ToJson-Sammlung auf null gesetzt wird. Behoben in 11.0.0-rc.1."
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
translationOf: "2026/09/fix-the-complex-type-collection-must-be-initialized-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-09
---

`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.` hat zwei Ursachen, die sich eine Meldung teilen. Wenn der Pfad in der Meldung eine Eigenschaft nennt, die Sie schlicht nie zugewiesen haben, initialisieren Sie sie (`public List<Entry> Entries { get; set; } = new();`), und die Sache ist erledigt. Ist die Eigenschaft initialisiert und die Ausnahme fällt aus `DetectChanges` oder `SaveChanges` heraus, dann liegt [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632) vor: In EF Core 10.0.0 bis 10.0.12 bringt das Setzen einer nullbaren komplexen Eigenschaft auf `null` die Änderungserkennung zum Absturz, wenn deren Typ eine Sammlung mit zwei oder mehr Elementen enthält und das Ganze in einer mit `ToJson()` gemappten komplexen Sammlung liegt. Der Absturz passiert, bevor überhaupt SQL erzeugt wird. Die Korrektur ist eingecheckt und in `11.0.0-rc.1` enthalten; der Backport nach 10.0.x trägt den Meilenstein 10.0.13 und ist noch nicht erschienen.

## Die Fehlermeldung im Kontext

Die Meldung stammt aus `CoreStrings.ComplexCollectionNotInitialized`, und es lohnt sich, sie Zeichen für Zeichen zu lesen, denn vier weitere Meldungen aus dieser Ecke des Change Trackers sehen fast genauso aus:

```
System.InvalidOperationException: The complex type collection 'Root[]Group[]Item.Meta.Entries'
must be initialized to a non-null value before the elements can be accessed.
```

Im Fehlerfall laufen die relevanten Frames, von innen nach außen, von `InternalComplexCollectionEntry.GetEntry` über `InternalComplexEntry.set_Ordinal` und `InternalComplexCollectionEntry.RemoveEntry` bis `ChangeDetector.DetectComplexCollectionChanges`. Enthält Ihr Stack Trace `RemoveEntry` und `set_Ordinal`, dann sehen Sie den EF-Bug und nicht Ihr eigenes null. Steht dagegen Ihr eigener Aufruf von `EntityEntry.ComplexCollection(...)` oben auf dem Stack, dann sehen Sie Ursache 1 weiter unten.

Der Eigenschaftspfad ist eine flach gezogene Kette, kein C#-Ausdruck. `[]` markiert einen Sprung durch eine komplexe Sammlung und wird vom Elementtyp gefolgt. `Root[]Group[]Item.Meta.Entries` liest sich also als "die Sammlung `Entries` an `Meta`, das an einem `Item`-Element hängt, das in einem `Group`-Element liegt, das in einer Sammlung an `Root` liegt". Dieser Pfad ist der schnellste Weg zur betroffenen Eigenschaft in einem tiefen Modell.

## Warum der Change Tracker eine null-Sammlung nicht akzeptiert

Komplexe Sammlungen kamen mit EF Core 10, und bei relationalen Providern [müssen sie mit `ToJson()` auf eine einzige JSON-Spalte gemappt werden](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types). Eine eigene Tabelle ist nicht möglich. Genau diese Einschränkung ist der Grund für diese Meldung: Ohne Tabelle und ohne Schlüssel kann EF ein Element nicht über seinen Primärschlüssel identifizieren, wie es das bei einer Owned Entity tut. Es identifiziert das Element über seine **Position in der CLR-Liste**.

`InternalComplexCollectionEntry` führt deshalb zwei parallele Listen von Einträgen, eine für aktuelle und eine für ursprüngliche Werte, und jeder ausgegebene Eintrag leitet sich aus der CLR-Sammlung ab, die tatsächlich am Objekt hängt. `GetEntry` kann keine Position in einer Liste erfinden, die es nicht gibt:

```csharp
// EF Core 10 and 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
if (original)
{
    if (_containingEntry.GetOriginalValue(_complexCollection) == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionEntryOriginalNull(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
else
{
    if (_containingEntry[_complexCollection] == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionNotInitialized(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
```

Zwei Zweige, zwei verschiedene Meldungen. `ComplexCollectionNotInitialized` ist der Zweig für den aktuellen Wert. Erhalten Sie stattdessen `The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'`, dann war die Sammlung beim Materialisieren der Zeile `null` und Sie haben sie erst danach initialisiert.

Beachten Sie, was der `ChangeDetector` tut, denn das erklärt, warum eine null-Sammlung nicht immer knallt. `DetectComplexCollectionChanges` liest beide Seiten und behandelt einen Unterschied in der Nullbarkeit als Änderung, nicht als Fehler:

```csharp
// EF Core 11, ChangeDetector.DetectComplexCollectionChanges
var currentCollection = (IList?)entry[complexProperty];
var originalCollection = (IList?)entry.GetOriginalValue(complexProperty);
var changesFound = currentCollection == null != (originalCollection == null);
```

Beide Element-Schleifen sind durch `!= null` abgesichert. Eine schlicht null-wertige Sammlung übersteht die Änderungserkennung also; sie fällt erst um, wenn etwas auf ein *Element* zugreift.

## Ursache 1: Die Sammlungseigenschaft ist tatsächlich null

Hier tut die Meldung genau ihre Arbeit. Sie greift, sobald Sie den Change-Tracker-Eintrag für eine nie zugewiesene Sammlung indizieren:

```csharp
// .NET 10, EF Core 10.0.12. Throws ComplexCollectionNotInitialized.
public class Distributor
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Address> ShippingCenters { get; set; } = null!;  // never assigned
}

var entry = db.Entry(distributor).ComplexCollection(d => d.ShippingCenters)[0];
```

Die Empfehlung von Microsoft ist eindeutig: Initialisieren Sie die Sammlung inline, damit die Eigenschaft nie null sein kann.

```csharp
// .NET 10, EF Core 10.0.12. The documented shape.
public List<Address> ShippingCenters { get; set; } = new();
```

Anders als bei einer Navigationssammlung legt EF die Liste nicht für Sie an, und es gibt keinen Lazy-Loading-Proxy, der das kaschiert. Zwei Varianten derselben Ursache lohnen eine Prüfung, bevor Sie auf Bug-Jagd gehen:

- **Eine nullbare Sammlungseigenschaft.** Haben Sie `List<Address>? ShippingCenters` deklariert und enthält die JSON-Spalte SQL-`NULL`, dann liefert die Materialisierung getreu `null` zurück, und der erste Elementzugriff wirft. Machen Sie die Eigenschaft entweder nicht nullbar und füllen Sie die Spalte mit `'[]'` auf, oder prüfen Sie auf null, bevor Sie den Change Tracker anfassen.
- **Eine nullbare komplexe Eigenschaft im Pfad.** In `Root[]Group[]Item.Meta.Entries` mag `Entries` in jedem von Ihnen erzeugten `Meta` initialisiert sein, aber wenn `Meta` selbst `null` ist, gibt es kein `Entries` zu lesen. Genau das ist die Form des EF-Bugs weiter unten, und es ist auch eine Form, die Sie selbst erzeugen können, wenn Sie den Tracker an einem Element indizieren, dessen `Meta` Sie gerade geleert haben.

Falls dieser Mapping-Stil neu für Sie ist: [Komplexe Typen im Vergleich zu Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) erklärt, warum sich komplexe Typen anders verhalten als die Owned-Entity-Graphen, von denen die meisten gerade wegmigrieren, und die [Schritt-für-Schritt-Anleitung zum Mapping](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) behandelt die Konfiguration selbst.

## Ursache 2: dotnet/efcore#38632, der Reindex-Pfad

Der interessante Fall ist der, in dem jede Sammlung im Modell initialisiert ist und die Ausnahme trotzdem aus `SaveChangesAsync` fällt. Vier Bedingungen müssen zusammentreffen, und sie sind in einem realen Modell häufig genug, dass man hineinläuft, ohne etwas Ungewöhnliches zu tun.

```csharp
// .NET 10, EF Core 10.0.12. Complex types are never discovered by convention,
// so every value type here carries [ComplexType].
public class Root
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Group> Groups { get; set; } = new();
}

[ComplexType]
public class Group
{
    public required string Title { get; set; }
    public List<Item> Items { get; set; } = new();
}

[ComplexType]
public class Item
{
    public required string Sku { get; set; }
    public Meta? Meta { get; set; }               // nullable complex property
}

[ComplexType]
public class Meta
{
    public required string Kind { get; set; }     // optional complex types need one required property
    public List<Entry> Entries { get; set; } = new();
}

[ComplexType]
public class Entry
{
    public required string Key { get; set; }
    public string? Value { get; set; }
}
```

```csharp
// .NET 10, EF Core 10.0.12. On relational providers a complex collection must be JSON.
modelBuilder.Entity<Root>()
    .ComplexCollection(r => r.Groups, g => g.ToJson());
```

Und die Mutation, die ungefähr so gewöhnlich ist, wie ein Laden-Ändern-Speichern nur sein kann:

```csharp
// .NET 10, EF Core 10.0.12. Throws inside DetectChanges, before any SQL is sent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);

var item = root.Groups[0].Items[0];
// item.Meta.Entries came back from the JSON column with two elements.
item.Meta = null;

await db.SaveChangesAsync();
```

Das Nullsetzen von `Meta` entfernt den umschließenden komplexen Eintrag. Das Entfernen löst eine Neuindizierung der dahinter liegenden Einträge aus, und diese Neuindizierung setzt `Ordinal` auf jedem verbleibenden Eintrag, was wieder in `GetEntry` für `Meta.Entries` führt. Zu diesem Zeitpunkt ist `Meta` bereits `null`, also wirft der oben gezeigte Zweig für den aktuellen Wert. Mit einem Element oder gar keinem in `Entries` gibt es nichts neu zu indizieren, und derselbe Code speichert sauber. Genau das lässt den Bug von außen so willkürlich wirken.

Der Melder traf ihn auf 10.0.9 und 10.0.10, ein Kommentator bestätigte ihn am 2026-08-15 erneut auf 10.0.11, und das Issue ist gegen 10.0.12, den aktuellen stabilen Patch, weiterhin offen. Er ist providerunabhängig und sowohl mit Npgsql als auch mit SQLite bestätigt, weil der Absturz im gemeinsamen Change Tracker oberhalb der Provider-Abstraktion sitzt. Ein reines Provider-Update hilft nicht.

## Die Lösung im Detail

### Auf EF Core 11 RC1 wechseln

[PR #38667](https://github.com/dotnet/efcore/pull/38667) wurde am 2026-07-20 mit Meilenstein 11.0-rc1 in `main` gemergt, die Korrektur steckt also heute schon in den Paketen `11.0.0-rc.1.26425.128`. Die Änderung ist eine Umsortierung, keine neue Logik: Getrackte Einträge werden jetzt zurückgegeben, bevor die CLR-Sammlung auf null geprüft wird, sodass die Neuindizierung während des Aufräumens auch dann funktioniert, wenn der übergeordnete komplexe Wert bereits auf `null` steht.

```csharp
// EF Core 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
// Must check tracked entries first to allow reindexing during cleanup when the parent is null.
var existingEntries = original ? _originalEntries : _entries;
if (existingEntries != null
    && (uint)ordinal < (uint)existingEntries.Count
    && existingEntries[ordinal] is { } existingEntry)
{
    return existingEntry;
}
```

```xml
<!-- .NET 10 or .NET 11. Bump the provider package to a matching 11.0.0-rc.1 too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="11.0.0-rc.1.26425.128" />
```

EF Core 11 wird zusammen mit .NET 11 im November 2026 stabil, es handelt sich also um ein kurzes Preview-Fenster und nicht um einen offenen Zeitraum. Es bleibt dennoch eine Vorabversion, lesen Sie also die übrigen Release Notes zu EF Core 11, bevor Sie sie ausliefern.

### 10.0.13 verfolgen, wenn Sie ein Servicing-Release brauchen

Das Issue wurde nach der Korrektur in `main` genau deshalb wieder geöffnet, um den Backport nach `release/10.0` zu verfolgen, und trägt den Meilenstein 10.0.13. Wenn Sie in einem unterstützten Servicing-Band unterwegs sind und keine Vorabversion einsetzen können, ist das die Version, auf die Sie warten. Bis dahin bringt ein Update innerhalb von 10.0.x nichts.

### Die Mutation auf zwei SaveChanges aufteilen

Der Auslöser braucht zwei oder mehr Elemente in der verschachtelten Sammlung genau in dem Moment, in dem der übergeordnete Wert auf null geht. Die Sammlung in einem eigenen Speichervorgang zu leeren, sodass aktueller und ursprünglicher Snapshot vor dem Nullsetzen leer sind, umgeht die Neuindizierung vollständig:

```csharp
// .NET 10, EF Core 10.0.12. Two round trips, no reindex over a null parent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);
var item = root.Groups[0].Items[0];

item.Meta!.Entries.Clear();
await db.SaveChangesAsync();   // original values are accepted here

item.Meta = null;
await db.SaveChangesAsync();
```

Das ist die minimierte Auslöserliste des Melders vom Kopf auf die Füße gestellt, keine Zusage des EF-Teams, und es kostet Sie einen zusätzlichen Roundtrip sowie die Atomarität eines einzelnen Speichervorgangs. Klammern Sie beide Aufrufe in eine explizite Transaktion, wenn der Zwischenzustand für andere Leser nicht sichtbar sein soll, und prüfen Sie das gegen Ihr eigenes Modell, bevor Sie sich darauf verlassen.

### Die JSON-Spalte ohne den Change Tracker schreiben

Der Absturz lebt vollständig in der Änderungserkennung, und `ExecuteUpdateAsync` kommt ihr nie nahe. EF Core 10 kann eine auf JSON gemappte komplexe Sammlung direkt ansprechen:

```csharp
// .NET 10, EF Core 10.0.12. Untracked read, then a set-based write.
var groups = await db.Roots
    .AsNoTracking()
    .Where(r => r.Id == id)
    .Select(r => r.Groups)
    .SingleAsync();

groups[0].Items[0].Meta = null;

await db.Roots
    .Where(r => r.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(r => r.Groups, groups));
```

Für diesen Schreibvorgang geben Sie die üblichen Zusagen von `SaveChanges` auf: keine optimistische Nebenläufigkeitsprüfung, keine `SaveChanges`-Interceptors, und das gesamte JSON-Dokument wird neu geschrieben statt nur des geänderten Pfads. Wenn Sie dieses Muster breiter einsetzen wollen, sind die Abwägungen in [ExecuteUpdate im Vergleich zum Laden von Entitäten und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) durchgearbeitet.

## Ähnlich aussehende Meldungen, die auf dieser Seite landen

Vier weitere Zeichenfolgen in `CoreStrings` erwähnen komplexe Sammlungen und null-Werte und haben mit #38632 nichts zu tun.

**`The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'.`** Das ist `ComplexCollectionEntryOriginalNull`, der Geschwisterzweig desselben `if`. Die Sammlung war beim Materialisieren der Zeile `null`. Ursprungswerte einer Sammlung zu lesen, die nie welche hatte, ist kein Bug, sondern eine Frage ohne Antwort. Laden Sie die Entität neu oder lesen Sie auf diesem Pfad keine Ursprungswerte mehr.

**`The value for the property '...' cannot be set, because it's on the complex type collection element '...[N]' that contains a 'null' value.`** Das ist `ComplexCollectionNullElementSetter`. Die Sammlung existiert, aber eines ihrer *Elemente* ist `null`. Ein JSON-Array der Form `[{...}, null]` genügt dafür. Filtern Sie null-Werte vor dem Speichern heraus, oder schreiben Sie sie gar nicht erst in das Array.

**`Complex entry original ordinal '-1' is invalid for property '...' as it's outside of the collection of length 'N'.`** Ein anderer Bug mit einer anderen Korrektur, behandelt in [Complex entry original ordinal '-1' is invalid beim Speichern einer ToJson-Sammlung komplexer Typen](/de/2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection/). Achten Sie auf den Wortlaut: *original ordinal* und *for property*. Der wurde in 10.0.10 behoben, anders als bei dieser Meldung hilft dort ein Update innerhalb von 10.0.x also sehr wohl.

**`The complex type collection '...' cannot be configured because complex value type collections are not supported.`** Das ist `ComplexValueTypeCollection`, geworfen beim Modellaufbau, nicht beim Speichern. Elemente einer komplexen Sammlung müssen Referenztypen sein; eine `List<Coordinate>`, in der `Coordinate` ein `readonly record struct` ist, lässt sich nicht mappen. Verfolgen Sie [dotnet/efcore#31411](https://github.com/dotnet/efcore/issues/31411), falls Sie das brauchen.

Nennt Ihr Fehler stattdessen `AS JSON option can be specified only for column of nvarchar(max)`, dann ist das ein Problem des SQL-Server-Spaltentyps und keines des Change Trackers; es wird separat in [der Lösung für AS JSON auf Azure SQL](/de/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) behandelt. Für das allgemeine Mapping-Thema ist [wie man JSON-Spalten in EF Core 11 mappt und abfragt](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) der richtige Einstieg.

## Quellen

- [dotnet/efcore#38632: ComplexCollection + ToJson(): DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [dotnet/efcore#38667: die Korrektur, gemergt am 2026-07-20](https://github.com/dotnet/efcore/pull/38667)
- [Komplexe Typen, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [EF-Core-Releases und -Planung](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
- [ChangeDetector.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/ChangeDetector.cs)
- [CoreStrings.resx, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx)
