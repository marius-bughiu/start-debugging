---
title: "Complex Types vs. Owned Entities in EF Core 11: wofür sollten Sie sich entscheiden?"
description: "Nutzen Sie in EF Core 11 standardmäßig Complex Types für Value Objects und greifen Sie nur dann zu Owned Entities, wenn Sie eine separate Tabelle oder eine als eigene Zeilen abgebildete Collection benötigen."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "complex-types"
  - "owned-entities"
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/complex-types-vs-owned-entities-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

In EF Core 11 (mit .NET 11 und C# 14) bilden Sie ein Value Object wie `Address`, `Money` oder `DateRange` als **Complex Type** ab und greifen nur dann zu einer **Owned Entity**, wenn die Speicherform es erzwingt: der Wert benötigt eine eigene Tabelle, oder Sie brauchen eine als separate Zeilen gespeicherte Collection. Diese eine Achse entscheidet nahezu jeden Fall. Complex Types haben Wertsemantik und keine Identität, was genau das ist, was ein Value Object ausmacht; Owned Entities sind vollwertige Entitätstypen im Kostüm eines Value Objects, und das Kostüm rutscht ständig. EF Core 11 ist die Version, in der die letzten Gründe, Owned Entities zu bevorzugen, weitgehend verschwunden sind, denn Complex Types funktionieren nun mit TPT/TPC-Vererbung, unterstützen `ExecuteUpdate`, erlauben Collections bei Abbildung auf JSON und können Schlüssel und Indizes tragen.

Dieser Beitrag ist die Entscheidung, nicht die Mechanik. Wenn Sie die schrittweise Konfiguration möchten, lesen Sie [how to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Hier vergleichen wir die beiden Abbildungen direkt miteinander, zeigen, wo jede von ihnen gewinnt, und benennen die Fallstricke, die die Wahl für Sie treffen.

## Die Funktionsmatrix auf einen Bildschirm

Der Grund, warum beide Abbildungen existieren, ist, dass sie unterschiedliche Fragen beantworten. Eine Owned Entity ist die Art und Weise, wie EF Core sagt "das ist eine abhängige Entität, die ich innerhalb ihres Besitzers speichere". Ein Complex Type ist die Art und Weise, wie EF Core sagt "das ist ein Wert, ohne eigene Identität". Alles Weitere folgt daraus.

| Dimension                                        | Complex Type                         | Owned Entity                          |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------- |
| Zugrundeliegende Modellart                       | Wert, kein Schlüssel                 | Entität, Schatten-Primärschlüssel     |
| Identitätssemantik                               | nach Wert (Inhalt)                   | nach Referenz (Identität)             |
| `a == b` in LINQ vergleicht                      | Inhalt                               | Identität                             |
| Zuweisung kopiert Felder (`x.A = x.B`)           | ja, kopiert                          | wirft (geteilte Referenz)             |
| Gleiche Tabelle wie Besitzer (Table Splitting)   | ja (Standard)                        | ja (Standard)                         |
| Separate Tabelle (`ToTable`)                     | nein                                 | ja                                    |
| Einzelne JSON-Spalte (`ToJson`)                  | ja                                   | ja                                    |
| Collection als separate Kindzeilen               | nein                                 | ja (`OwnsMany`)                       |
| Collection innerhalb eines JSON-Dokuments        | ja (`ComplexCollection` + `ToJson`)  | ja (`OwnsMany` + `ToJson`)            |
| `ExecuteUpdate` in ein verschachteltes Member    | ja (EF Core 11)                      | nein                                  |
| CLR-Typ kann ein `struct` oder `record` sein     | ja                                   | nur Referenztyp                       |
| Schlüssel / Indizes über verschachteltem Skalar  | ja (EF Core 11)                      | ja                                    |
| TPT / TPC-Vererbung auf dem Besitzer             | ja (EF Core 11)                      | ja                                    |
| Fußabdruck im Change Tracker                     | auf Spaltenebene, kein separater Knoten | separater getrackter Knoten + Schattenschlüssel |

Lesen Sie diese Tabelle von oben nach unten, und das Muster ist offensichtlich: Complex Types gewinnen jede Zeile, die von Semantik handelt, und Owned Entities gewinnen die zwei Zeilen, die von der Speicherform handeln (separate Tabelle, separate Kindzeilen). Das ist der gesamte Vergleich im Kleinen. Versionen spielen hier eine Rolle, denn drei dieser "ja"-Zellen für Complex Types wurden erst in EF Core 11 wahr; in EF Core 9 war die Rechnung eine andere.

## Wann Sie einen Complex Type wählen sollten

Greifen Sie in diesen Fällen zu `ComplexProperty` (oder dem `[ComplexType]`-Attribut), die die große Mehrheit der Value Objects in einer echten Codebasis abdecken:

- **Der Typ ist vollständig durch seine Daten definiert.** `Address`, `Money`, `GeoPoint`, `DateRange`, `PersonName`. Wenn zwei Instanzen mit identischen Feldern austauschbar sind, ist es ein Wert, und ein Wert möchte Wertsemantik. In EF Core 11 schreiben Sie `b.ComplexProperty(c => c.ShippingAddress)`, und die Felder landen inline in der Tabelle des Besitzers.
- **Sie möchten den Wert natürlich zuweisen oder vergleichen.** `customer.BillingAddress = customer.ShippingAddress` kopiert die Felder und speichert sauber, und `Where(c => c.BillingAddress == c.ShippingAddress)` filtert nach Inhalt. Beides ist mit Owned Entities kaputt, wie unten beschrieben.
- **Sie möchten, dass Massenschreibvorgänge in den Wert hineinreichen.** EF Core 11 unterstützt `ExecuteUpdate` in Complex-Type-Member: `ExecuteUpdateAsync(s => s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"))`. Owned Entities haben das nie erlaubt. Wenn Ihnen der schnelle Schreibpfad wichtig ist, ist allein das ausschlaggebend; die Abwägungen sind dieselben wie in [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).
- **Der Wert ist ein `struct` oder `record`.** Owned Entities müssen Referenztypen sein, die EF Core mit einem Schlüssel versehen und tracken kann. Ein Complex Type kann ein `readonly struct Money` oder ein `record` sein, was zur Idee "keine Identität" passt. Das Zusammenspiel mit Records ist es wert, in voller Länge in [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) gelesen zu werden.

Die Microsoft-Empfehlung ist in diesem Standard nicht subtil. Die Release Notes zu EF Core 11 stellen fest, dass die Stabilisierungsarbeit an Complex Types speziell durchgeführt wurde, "to unblock using complex types as an alternative to the owned entity mapping approach", und die Notes zu EF Core 10 forderten bestehende Owned-Entity-Nutzer auf, zu wechseln. Behandeln Sie Complex Types als Standard und Owned Entities als Ausnahme.

## Wann Sie eine Owned Entity wählen sollten

Es gibt genau zwei strukturelle Gründe und einen Modellierungsgrund, um bei `OwnsOne` / `OwnsMany` zu bleiben:

- **Der Wert muss in einer eigenen Tabelle leben.** Complex Types sind immer inline: entweder als Table-Split-Spalten auf dem Besitzer oder als eine JSON-Spalte auf dem Besitzer. Es gibt kein `ComplexProperty(...).ToTable("Addresses")`. Wenn Ihr Schema die Daten in einer separaten Tabelle mit einem Fremdschlüssel zurück zum Besitzer erfordert (eine Reporting-Sicht knüpft daran an, eine andere Tabelle referenziert sie, ein DBA verlangt es), dann ist das eine Owned Entity, abgebildet mit `OwnsOne(...).ToTable(...)`.
- **Sie benötigen eine Collection als separate Zeilen.** Ein Eins-zu-viele von Value Objects, das jeweils eine eigene Zeile in einer Kindtabelle sein muss, ist `OwnsMany`. Ein Table-Split-Complex-Type muss ein einzelner Wert sein, und obwohl EF Core 11 `ComplexCollection` für Collections hinzugefügt hat, werden diese **innerhalb eines JSON-Dokuments** gespeichert, nicht als Kindzeilen. Wenn Sie die Elemente als erstklassige Zeilen indizieren, joinen oder abfragen möchten, ist `OwnsMany` weiterhin das Werkzeug.
- **Es ist eigentlich gar kein Value Object.** Wenn zwei Instanzen mit demselben Inhalt unterscheidbar bleiben müssen, oder wenn das Ding einen Lebenszyklus hat, der über seine aktuellen Daten hinausreicht, dann hat es Identität. Das ist eine echte verwandte Entität, kein Owned Type und kein Complex Type. Modellieren Sie es mit einem normalen Eins-zu-viele und einem Schlüssel, den Sie kontrollieren.

Beachten Sie, dass keiner dieser Gründe von Semantik oder Bequemlichkeit handelt. Sie handeln vom physischen Schema. Wenn Ihre Antwort auf "braucht das eine separate Tabelle oder separate Zeilen?" nein lautet, haben Sie keinen Grund, in EF Core 11 eine Owned Entity zu verwenden.

## Die drei Owned-Entity-Kanten, die Leute davon wegtreiben

Der Vergleich wird konkret, wenn Sie auf die scharfen Kanten stoßen. Alle drei stammen aus derselben Grundursache: eine Owned Entity ist eine Entität, also gibt EF Core ihr einen Schattenschlüssel und argumentiert über sie nach Referenzidentität.

Erstens können Sie eine Instanz nicht teilen. Das sieht so aus, als sollte es funktionieren, tut es aber nicht:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws: the same owned instance is referenced twice
```

Weil beide Eigenschaften denselben Entitätstyp haben, sieht EF Core eine Entität, die von zwei Stellen referenziert wird, und weist sie zurück. Mit einem Complex Type kopiert die Zuweisung die Felder und speichert sauber.

Zweitens vergleicht LINQ-Gleichheit die Identität, nicht den Inhalt:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var same = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress) // not what you meant
    .ToListAsync();
```

Mit einer Owned Entity übersetzt sich das nicht in einen Feld-für-Feld-Vergleich. Mit einem Complex Type vergleicht EF Core 11 den Inhalt (einschließlich verschachtelter Complex Types, nach einem bestimmten Bugfix in EF Core 11), sodass die Abfrage bedeutet "die beiden Adressen sind wirklich gleich".

Drittens unterstützt `ExecuteUpdate` Owned-Entity-Eigenschaften überhaupt nicht, während die Complex-Type-Variante funktioniert:

```csharp
// .NET 11, EF Core 11 - complex type mapping
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Wenn Ihr Code auf eine dieser drei Kanten trifft, kämpft die Owned-Entity-Abbildung gegen Sie, und die Lösung besteht darin, die Abbildung zu wechseln, nicht darin, das Symptom zu umgehen.

## Leistung: es geht um Tracking-Knoten und Joins, nicht um eine Schlagzeilenzahl

Es gibt hier keine dramatische Durchsatzlücke, die man in ein Diagramm packen könnte, und Sie sollten jedem misstrauen, der Ihnen eine zeigt. Der echte, strukturelle Leistungsunterschied liegt an zwei Stellen.

Der erste ist das Change Tracking. Eine Owned Entity wird als eigener Knoten im Change Tracker getrackt, mit einem Schattenschlüssel, den EF Core verwaltet. Ein Complex Type ist kein separater Knoten: seine Spalten werden als Teil des Besitzers getrackt, auf der Ebene des Spalten-Diffs. In einem Objektgraphen mit vielen Value Objects pro Aggregat sind das weniger Einträge, die beim `SaveChanges` per Snapshot festgehalten, korrigiert und verglichen werden müssen. Der Unterschied ist pro Entität meist gering, skaliert aber mit der Anzahl der Value Objects, die Sie laden, und er spricht strikt zugunsten des Complex Types, weil es schlicht weniger Buchführung gibt.

Der zweite ist der Join, und er gilt nur für den Owned-Entity-Fall, den Sie tatsächlich aus Speichergründen wählen würden. Eine `OwnsOne(...).ToTable("Addresses")`-Abbildung lebt in einer separaten Tabelle, sodass das Lesen des Besitzers mit seinem Value Object ein Join ist. Ein Table-Split-Complex-Type hat keine separate Tabelle und daher keinen Join. Wenn Sie ein Value Object rein aus Gewohnheit zu einer Owned Entity gemacht haben und es ohnehin in der Tabelle des Besitzers gelandet ist (der Standard), sind die beiden speicheräquivalent, und der Tracking-Unterschied ist der einzige, der übrig bleibt. In dem Moment, in dem Sie das Aushängeschild-Feature der Owned Entity tatsächlich nutzen (eine separate Tabelle), nehmen Sie die Join-Kosten auf sich, die Complex Types konstruktionsbedingt vermeiden. Für das umfassendere Bild der Tracking-Kosten treten dieselben Kräfte in [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) auf.

Die ehrliche Leistungsaussage lautet also: Complex Types sind nie langsamer als eine äquivalente Owned Entity in derselben Tabelle und sind strukturell schlanker zu tracken; Owned Entities nehmen genau dann einen Join auf sich, wenn Sie sie für das eine Ding nutzen, das Complex Types nicht können.

## Der Fallstrick, der für Sie entscheidet: EF-Core-Version und die Nullbarkeitsregel

Zwei Dinge können die Entscheidung für Sie treffen, unabhängig von Ihrer Präferenz.

Das erste ist Ihre EF-Core-Version. Alles oben Genannte setzt EF Core 11 voraus. In EF Core 9 und früher konnten Complex Types nicht auf Entitäten mit TPT/TPC-Vererbung verwendet werden, `ExecuteUpdate` in verschachtelte Member hatte Bugs, der Vergleich verschachtelter Complex Types war falsch, und es gab kein `ComplexCollection`. Wenn Sie an EF Core 9 gebunden sind, können Owned Entities für ein vererbtes Value Object oder eine Collection weiterhin die pragmatische Wahl sein, und Sie sollten den Wechsel als Teil Ihres Upgrades einplanen. Der [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) behandelt die Breaking Changes, die dazu neigen, zusammen mit diesem aufzutauchen, und beachten Sie, dass `UseSqlServer` in EF Core 11 nun standardmäßig auf Kompatibilitätsstufe 160 (SQL Server 2022) läuft, was einige JSON-Übersetzungen beeinflusst.

Das zweite ist die Regel für optionale Werte. Ein optionaler (nullbarer) Complex Type muss **mindestens eine erforderliche, nicht-nullbare Eigenschaft** haben, denn EF Core nutzt diese Spalte, um "der gesamte Wert ist null" von "der Wert ist vorhanden, aber seine optionalen Felder sind null" zu unterscheiden. Wenn Sie ein Value Object haben, bei dem wirklich jedes Feld nullbar ist, lässt sich ein optionaler Complex Type nicht kompilieren, und Sie fügen entweder einen Diskriminator hinzu, überdenken die Nullbarkeit oder greifen auf eine Owned Entity zurück. In der Praxis hat eine echte `Address` oder `Money` immer ein erforderliches Feld, sodass das selten zubeißt, aber es ist die eine Modellierungseinschränkung, die Ihnen die Hand in Richtung Owned Entities zwingen kann.

Query-Filter verhalten sich für beide gleich: ein globaler oder benannter Filter wird auf der besitzenden Entität definiert, nicht auf dem Value Object, sodass Soft Delete und Mandantenfähigkeit identisch funktionieren, welche Abbildung Sie auch wählen. Wenn das Ihre Sorge ist, siehe [named query filters vs a single global query filter in EF Core 11](/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/); es ist kein Unterscheidungsmerkmal zwischen Complex Types und Owned Entities.

## Die Empfehlung, klar formuliert

Nutzen Sie in EF Core 11 standardmäßig Complex Types für Value Objects. Bilden Sie `Address`, `Money`, `GeoPoint`, `DateRange` und ihresgleichen mit `ComplexProperty` ab, erhalten Sie Wertsemantik kostenlos und genießen Sie `ExecuteUpdate`, Struct/Record-Unterstützung und saubere Gleichheit. Greifen Sie nur dann zu einer Owned Entity, wenn das physische Schema es verlangt: der Wert muss in einer eigenen Tabelle sitzen, oder eine Collection von Werten muss als separate Kindzeilen gespeichert werden. Und wenn das Ding eine echte Identität hat, die über seine Daten hinausreicht, war es nie ein Value Object, also modellieren Sie es als echte verwandte Entität mit einem Schlüssel, den Sie besitzen.

Die Faustregel ist dieselbe, die einen `record` von einer `class` trennt: wenn das Ding durch seine Daten definiert ist, ist es ein Wert, und ein Wert ist ein Complex Type. Wenn es eine Identität hat, die Sie tracken müssen, ist es eine Entität. EF Core 11 lässt dieses mentale Modell endlich eins zu eins auf das Framework abbilden, wobei Owned Entities für die engen Speicherfälle reserviert bleiben, in denen sie schon immer am besten waren.

## Weiterführende Lektüre

- [How to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) ist die vollständige Schritt-für-Schritt-Anleitung, einschließlich der Migration von `OwnsOne` zu `ComplexProperty`.
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) geht tiefer auf Records als Complex Types gegenüber Entitäten ein.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt die JSON-Speicheroption, die beide Abbildungen teilen.
- [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) rahmt den Massen-Update-Pfad ein, den Complex Types für Value Objects freischalten.
- [How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) ist der Begleiter, wenn Ihr Besitzer in einer Vererbungshierarchie sitzt.

## Quellen

- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
