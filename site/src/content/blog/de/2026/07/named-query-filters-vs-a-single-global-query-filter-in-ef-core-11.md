---
title: "Benannte Abfragefilter vs ein einzelner globaler Abfragefilter in EF Core 11: Was sollten Sie verwenden?"
description: "Beide erzeugen dasselbe SQL. Greifen Sie nur dann zu benannten Filtern, wenn Sie ein Prädikat unabhängig deaktivieren müssen; ein einzelner kombinierter Filter ist für ein einzelnes Anliegen in EF Core 11 einfacher."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "de"
translationOf: "2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-07
---

Wenn Sie ein einziges Filteranliegen auf einer Entität haben, verwenden Sie ein einzelnes unbenanntes `HasQueryFilter(e => ...)`. Wenn Sie zwei oder mehr Anliegen haben, die zur Abfragezeit unabhängig aufgehoben werden müssen, zum Beispiel einen Soft-Delete-Filter und einen Tenant-Filter, bei dem ein Admin-Bildschirm die gelöschten Zeilen sehen muss, aber niemals die Zeilen eines anderen Tenants, verwenden Sie benannte Filter. Das ist die gesamte Entscheidung. Das erzeugte SQL ist in beiden Fällen identisch; das Einzige, was sich ändert, ist, ob `IgnoreQueryFilters` die Hälfte Ihres Prädikats abschalten kann. Benannte Abfragefilter kamen in EF Core 10 und sind der Standardmechanismus für mehrere Filter in EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14).

Alles Weitere dreht sich um diese eine Achse: die Granularität der Deaktivierung. Da beide Ansätze in dieselbe `WHERE`-Klausel übersetzt werden, gibt es hier keine Performance-Geschichte und keine Ökosystem-Geschichte. Der Vergleich dreht sich rein darum, wie viel Kontrolle Sie über das Abschalten von Filtern benötigen.

## Die zwei Formen nebeneinander

Ein globaler Abfragefilter ist ein Prädikat, das EF Core in jede LINQ-Abfrage für einen Entitätstyp injiziert. Vor EF Core 10 gab es genau einen pro Entität, sodass ein zweites Anliegen `&&` bedeutete:

```csharp
// EF Core 9 style -- one unnamed filter, two concerns welded with &&
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

Die benannte Überladung nimmt zuerst einen String-Schlüssel entgegen, und wiederholte Aufrufe setzen sich zusammen, statt sich zu überschreiben:

```csharp
// EF Core 11 -- two named filters on the same entity
modelBuilder.Entity<Invoice>()
    .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
    .HasQueryFilter("TenantFilter",       i => i.TenantId == _tenantId);
```

Führen Sie eine einfache Abfrage gegen eine der beiden Konfigurationen aus, und Sie erhalten dieselben Zeilen und dasselbe SQL:

```sql
-- Identical for both the && filter and the two named filters
SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
```

Das ist das Wichtige, das man verinnerlichen sollte, bevor man wählt: benannte Filter sind keine "leistungsfähigere Filterung". Sie filtern exakt gleich. Was Sie mit der zusätzlichen Zeremonie kaufen, ist ein benannter Handle, den Sie später greifen können.

## Feature-Matrix

| Feature                                   | Einzelner globaler Filter                | Benannte Filter                                |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Filter pro Entität (EF Core 11)           | ein unbenanntes Prädikat                 | viele, jedes mit einem Namen                   |
| Mehrere Anliegen kombinieren              | `&&` in einem Ausdruck                   | ein `HasQueryFilter`-Aufruf pro Anliegen       |
| Erzeugtes SQL                             | `AND`-verknüpftes `WHERE`                | identisches `AND`-verknüpftes `WHERE`          |
| `IgnoreQueryFilters()` (ohne Argumente)   | verwirft den gesamten Filter             | verwirft jeden benannten Filter                |
| `IgnoreQueryFilters(["Name"])`            | nicht anwendbar                          | verwirft nur dieses Prädikat                   |
| Benannt und unbenannt auf einer Entität   | n/v                                      | wirft beim Model-Build; wählen Sie einen Stil  |
| Verfügbar seit                            | EF Core 2.0                              | EF Core 10                                      |
| Auswirkung auf den Abfrageplan-Cache      | parametrisiert, ein Plan                 | parametrisiert, ein Plan                       |
| Zeremonie                                 | am geringsten                            | Filternamen-Konstanten, Extension-Helfer       |

Die einzige Zeile, die je ein Ergebnis ändert, ist die Zeile `IgnoreQueryFilters(["Name"])`. Jeder andere Unterschied ist kosmetisch oder eine Einschränkung, die Sie einmal umgehen.

## Wann Sie einen einzelnen globalen Filter verwenden

Greifen Sie zum einfachen unbenannten Filter, wenn die zusätzliche Adressierbarkeit Ihnen nichts bringt:

- **Ein Anliegen pro Entität.** Eine schreibgeschützte Lookup-Tabelle, die nur `!IsArchived` benötigt, hat nichts, was selektiv deaktiviert werden müsste. `HasQueryFilter(x => !x.IsArchived)` ist die ganze Geschichte, und ein Name wäre totes Gewicht.
- **Sie wollen immer Alles-oder-Nichts.** Wenn der einzige Zeitpunkt, an dem Sie den Filter umgehen, ein Admin- oder Migrationspfad ist, der legitim alles sehen will, ist das parameterlose `IgnoreQueryFilters()` genau richtig. Ein Name würde Ihnen erlauben, weniger zu tun, als Sie wollen, nicht mehr.
- **Mehrere Anliegen, die nie getrennt aufgehoben werden.** Zwei mit `&&` kombinierte Prädikate sind in Ordnung, wenn kein Codepfad das eine an und das andere aus benötigt. Ein `!IsDeleted && OrgId == _orgId`-Filter in einem internen Tool, in dem Sie nie "gelöschte anzeigen" freigeben, ist als ein einziger Ausdruck einfacher.
- **Sie sind auf EF Core 9 oder älter.** Die benannte Überladung existiert vor EF Core 10 nicht, daher ist ein einzelner `&&`-Filter die einzige eingebaute Option. Wenn Sie Anliegen noch auf diese Weise kombinieren, sehen Sie sich [Migration von EF Core 6 zu EF Core 11: Breaking Changes, die wirklich beißen](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) an, bevor Sie sie aufteilen.

Der Vorteil des einzelnen Filters ist, dass er keine magischen Strings hat. Es lauert kein Tippfehler `IgnoreQueryFilters(["SoftDeletonFilter"])`, der still nichts deaktiviert, weil es keinen Namen gibt, den man falsch schreiben könnte.

## Wann Sie benannte Filter verwenden

Benennen Sie Ihre Filter in dem Moment, in dem zwei Anliegen in einer einzigen Abfrage unterschiedliche Lebensdauern benötigen:

- **Soft Delete plus Multi-Tenancy auf derselben Tabelle.** Das ist der kanonische Fall. Ein Admin-Bericht muss gelöschte Rechnungen sehen, muss aber auf den aktuellen Tenant beschränkt bleiben. Mit `IgnoreQueryFilters(["SoftDeletionFilter"])` überlebt das Tenant-Prädikat, sodass Sie einen Berichtsbildschirm nicht in ein tenantübergreifendes Datenleck verwandeln können. Die vollständige Verdrahtung finden Sie in [wie man benannte Abfragefilter für Soft Delete und Multi-Tenancy in EF Core 11 verwendet](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).
- **Ein "umschaltbares" Anliegen neben einem "nie aus"-Anliegen.** Immer wenn ein Prädikat eine Sicherheitsgrenze ist (Tenant, Eigentum, zeilenbasierte Autorisierung) und ein anderes eine Bequemlichkeit (Soft Delete, Zustand veröffentlicht/Entwurf), erlaubt Ihnen die Benennung, den Bequemlichkeitsschalter freizugeben, ohne den Aufrufern jemals eine Möglichkeit zu geben, die Grenze fallen zu lassen.
- **Sie wollen eine absichtsoffenbarende API für das Bypass.** Mit Namen können Sie das Ignore hinter einer Erweiterungsmethode verbergen, sodass kein Aufrufer einen Filterstring tippt:

```csharp
// EF Core 11 -- filter name hidden behind a readable call site
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant     = nameof(Tenant);
}

public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> q)
    => q.IgnoreQueryFilters([InvoiceFilters.SoftDelete]); // tenant filter stays on

// Reads like English, cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

- **Filter leben in getrennten Konfigurationsklassen.** Wenn Soft Delete aus einer gemeinsamen `IEntityTypeConfiguration<T>`-Konvention kommt und der Tenant-Filter anwendungsspezifisch ist, halten zwei benannte Aufrufe sie entkoppelt, statt eine Klasse zu zwingen, einen kombinierten `&&`-Ausdruck zu besitzen.

## Warum es keinen Benchmark-Abschnitt gibt

Ein Vergleichsartikel schuldet Ihnen normalerweise Zahlen. Dieser nicht, und es lohnt sich, das klar auszusprechen, damit Sie nicht nach einem Unterschied suchen, der nicht existiert. Beide Ansätze werden auf denselben Prädikatbaum heruntergebrochen, sodass EF Core dieselbe `WHERE`-Klausel emittiert und der Query-Planer dasselbe SQL sieht. Der Tenant-Wert wird in beiden Fällen zu einem Abfrageparameter, was bedeutet, dass keiner der Ansätze Ihren Plan-Cache so fragmentiert, wie es eine eingebettete Konstante täte. Es gibt keine Kosten pro Abfrage beim Benennen eines Filters; der Name existiert nur in den Modell-Metadaten, nicht in der übersetzten Abfrage. Falls Sie gehofft hatten, benannte Filter seien auch ein Performance-Hebel: sie sind es nicht. Wählen Sie allein nach der Achse der Deaktivierungsgranularität. Wenn Sie die Abfrageanzahl messen, während Sie irgendeinen Filter hinzufügen, sind es die Joins, die tatsächlich den Ausschlag geben, behandelt in [wie man N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Die Details, die für Sie entscheiden

Drei Einschränkungen können die Entscheidung erzwingen, unabhängig davon, was Sie aus Stilgründen bevorzugen würden.

**Sie können benannte und unbenannte Filter nicht auf einer Entität mischen.** Sobald irgendein Filter auf `Invoice` einen Namen hat, müssen alle einen haben. Das Hinzufügen eines unbenannten `HasQueryFilter(i => ...)` zu einer Entität, die bereits einen benannten Filter hat, wirft beim Model-Build. Die Wahl ist also pro Entität, nicht pro Filter: entscheiden Sie den Stil einmal, und wenn Sie jemals ein zweites unabhängig umgeschaltetes Anliegen erwarten, starten Sie benannt.

**Parameterloses `IgnoreQueryFilters()` macht immer noch alles platt.** Das Benennen Ihrer Filter macht den alten parameterlosen Aufruf nicht sicher. `context.Invoices.IgnoreQueryFilters().ToListAsync()` verwirft auch den Tenant-Filter. Behandeln Sie auf jeder Tabelle, die eine Tenant-Spalte trägt, die argumentlose Überladung als Code Smell und übergeben Sie stets die explizite Liste der Namen, die Sie deaktivieren wollen. Diese eine Gewohnheit ist der Unterschied zwischen einem Soft-Delete-Schalter und einem versehentlichen tenantübergreifenden Lesen.

**Filternamen als magische Strings schlagen still fehl.** `IgnoreQueryFilters(["SoftDeletonFilter"])` mit einem Tippfehler deaktiviert nichts und wirft keinen Fehler, weil EF nicht wissen kann, dass Sie einen echten Filter meinten. Wenn Sie benannt vorgehen, fixieren Sie die Namen in `const`-Feldern (wie im obigen Snippet), sodass ein Tippfehler ein Kompilierfehler ist, kein Leck in der Produktion. Ein einzelner unbenannter Filter hat diese Falle nicht, was ein echter Punkt zu seinen Gunsten ist, wenn Sie nur ein Anliegen haben.

Ein Detail gilt für beide gleichermaßen und ist kein Entscheidungskriterium: ein Filter auf der erforderlichen Seite einer Navigation verwandelt `Include` in ein `INNER JOIN`, sodass ein herausgefilterter Elternteil seine Kinder still verwirft. Dieses Verhalten ist identisch, ob das Prädikat benannt oder mit `&&` kombiniert ist. Die Lösung, ein `LEFT JOIN` über eine optionale Navigation oder ein passender Filter auf beiden Enden, ist in beiden Welten dieselbe und wird im [How-to zu benannten Abfragefiltern](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) Schritt für Schritt durchgegangen.

## Migration von einem kombinierten Filter zu benannten Filtern

Wenn Sie bereits einen `!IsDeleted && TenantId == x`-Filter ausliefern und jetzt "gelöschte anzeigen" freigeben müssen, ohne die Tenant-Beschränkung fallen zu lassen, ist die Migration mechanisch. Teilen Sie den einen Ausdruck in zwei benannte Aufrufe auf:

```csharp
// Before -- one filter, cannot disable half of it
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);

// After -- two named filters, soft delete now independently ignorable
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant,     i => i.TenantId == _tenantId);
```

Nichts am Standard-Abfrageverhalten ändert sich; dieselben Zeilen kommen zurück und dasselbe SQL wird erzeugt. Die einzige neue Fähigkeit ist, dass `IgnoreQueryFilters([InvoiceFilters.SoftDelete])` nun als gezieltes Bypass existiert. Da Sie Stile nicht mischen können, führen Sie diese Aufteilung für die gesamte Entität in einer Bearbeitung durch und prüfen Sie jeden bestehenden `IgnoreQueryFilters()`-Aufruf auf dieser Entität: jeder parameterlose Aufruf, der früher "Admin-Ansicht mit gelöschten" bedeutete, verwarf bereits den Tenant-Filter, und das Aufteilen des Filters ist der Moment, diese Aufrufe explizit zu machen.

## Die Entscheidung

Standardmäßig einen einzelnen unbenannten globalen Abfragefilter. Es ist die Option mit der geringsten Zeremonie, sie hat keine magischen Strings, und für den häufigen Fall eines Anliegens pro Entität ist sie strikt die richtige Wahl. Steigen Sie in dem Augenblick auf benannte Filter um, in dem ein zweites Anliegen unabhängig vom ersten umgeschaltet werden muss, was in der Praxis fast immer "Soft Delete neben einer Tenant- oder Eigentumsgrenze" bedeutet. Die Faustregel: wenn Sie sich eine Abfrage vorstellen können, die ein Prädikat aus und das andere an will, benennen Sie sie jetzt; andernfalls kombinieren Sie mit `&&` und machen Sie weiter. Das SQL wird den Unterschied nicht bemerken, aber Ihr zukünftiges Ich, das debuggt, warum ein Admin-Bericht die Rechnungen eines anderen Tenants durchsickern ließ, sehr wohl.

## Verwandt

- [Wie man benannte Abfragefilter für Soft Delete und Multi-Tenancy in EF Core 11 verwendet](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Wie man EF Core 11 Interceptoren für Auditing verwendet](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core ExecuteUpdate vs Entitäten laden und SaveChanges](/de/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Wie man N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)

## Quellen

- [Global Query Filters, EF Core Dokumentation (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10: multiple query filters per entity, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
- [Named global query filters in Entity Framework Core 10, Tim Deschryver](https://timdeschryver.dev/blog/named-global-query-filters-in-entity-framework-core-10)
- [Add ability to configure multiple query filters on a given DbSet, dotnet/efcore issue #33432](https://github.com/dotnet/efcore/issues/33432)
