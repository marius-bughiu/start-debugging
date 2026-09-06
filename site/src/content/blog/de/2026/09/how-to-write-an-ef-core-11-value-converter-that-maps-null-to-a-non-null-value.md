---
title: "Wie Sie einen EF Core 11 Value Converter schreiben, der ein null aus der Datenbank auf einen Nicht-null-Wert im Code abbildet"
description: "EF Core übergibt standardmäßig niemals null an einen Value Converter. Hier ist der interne convertsNulls-Konstruktor, der das ändert, der IsRequired(false)-Aufruf, von dem er abhängt, warum er für Enums und andere Werttypen nicht funktionieren kann, die WHERE col = NULL Falle, die er erzeugt, und die zwei Muster, die die Aufgabe ohne interne API lösen."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "nullability"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-06
---

Kurze Antwort: EF Core übergibt bewusst niemals `null` an einen Value Converter, weshalb `HasConversion(v => ..., v => v ?? "Unknown")` bei einer NULL-Spalte stillschweigend nichts tut. Der einzige Weg, das zu ändern, ist der vierargumentige Konstruktor von `ValueConverter<TModel, TProvider>` mit `convertsNulls: true`, der als `[EntityFrameworkInternal]` markiert ist und die Warnung `EF1001` erzeugt. Er funktioniert, aber nur für Eigenschaften, deren CLR-Typ ein Referenztyp ist, nur wenn Sie zusätzlich `.IsRequired(false)` aufrufen, und um den Preis, dass jede LINQ-Abfrage bricht, die auf den Sentinel-Wert filtert. Für ein `enum`, `int`, `DateTime` oder jeden anderen nicht nullbaren Werttyp lässt es sich überhaupt nicht zum Laufen bringen. Mappen Sie dort eine nullbare Eigenschaft und stellen Sie eine nicht nullbare Fassade bereit.

Dieser Beitrag behandelt, was EF tatsächlich mit einer NULL-Spalte macht, die genaue Konfiguration, die `convertsNulls` funktionieren lässt, die vier Abfrageformen, die dadurch brechen (mit dem SQL, das EF für jede erzeugt), die harte Grenze bei Werttypen und die zwei unterstützten Muster, die Sie stattdessen verwenden sollten.

Eine Anmerkung zu Versionen. EF Core 11 befindet sich im September 2026 in der Preview und erscheint mit .NET 11 im November 2026, laut der [Seite zu EF Core Releases und Planung](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 benötigt die .NET 11 Laufzeit, und das einzige SDK auf diesem Rechner ist .NET 10.0.302. Alles Folgende wurde daher gegen `Microsoft.EntityFrameworkCore.Sqlite` 10.0.10 auf einer In-Memory-SQLite-Datenbank gemessen. In diesem Bereich hat sich in EF11 nichts geändert: die Seite [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) listet keine Änderungen an Value Conversions oder an der Null-Behandlung auf, und `convertsNulls` ist seit EF Core 6.0 intern.

## Warum Ihr Converter bei einer NULL-Spalte nie ausgeführt wird

Die [Dokumentation zu Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) formuliert die Regel unmissverständlich: ein null-Wert wird niemals an einen Value Converter übergeben, und ein null in einer Datenbankspalte ist immer ein null in der Entitätsinstanz. Das ist kein Versehen. Genau das erlaubt es, einen Converter zwischen einem nicht nullbaren Primärschlüssel und den nullbaren Fremdschlüsseln zu teilen, die auf ihn zeigen, ohne die Null-Behandlung zweimal zu schreiben.

Die Folge ist, dass der naheliegende Code nichts bewirkt:

```csharp
// .NET 11, C# 14 - this ?? is dead code
modelBuilder.Entity<Order>()
    .Property(o => o.Notes)
    .HasConversion(v => v, v => v ?? "");
```

Der Zweig `v ?? ""` wird nie erreicht, weil EF die Konvertierung abkürzt, bevor er dorthin gelangt.

Was danach passiert, hängt vom CLR-Typ ab. Nehmen Sie eine Alttabelle, in der die Spalte nullbar ist und NULL eine Bedeutung trägt:

```sql
CREATE TABLE Orders (
    Id     INTEGER PRIMARY KEY AUTOINCREMENT,
    Notes  TEXT NULL,   -- NULL means "no notes"
    Status TEXT NULL    -- NULL means "status unknown"
);
INSERT INTO Orders (Notes, Status) VALUES (NULL, NULL);
INSERT INTO Orders (Notes, Status) VALUES ('hi', 'Shipped');
```

abgebildet auf eine Entität, die Nicht-null verspricht:

```csharp
// .NET 11, C# 14
public enum ShippingStatus { Unknown, Pending, Shipped }

public class Order
{
    public int Id { get; set; }
    public string Notes { get; set; } = "";      // never null, we hope
    public ShippingStatus Status { get; set; }   // Unknown, we hope
}
```

Lesen Sie Zeile 1 zurück, und `Notes` ist `null`, trotz Initialisierer und trotz nicht nullbarer Deklaration, weil EF den Spaltenwert direkt auf die Eigenschaft schreibt. `Status` ist schlimmer: der Data Reader des Providers wirft, bevor EF überhaupt eingreifen kann, was unter SQLite so aussieht:

```
System.InvalidOperationException: The data is NULL at ordinal 2. This method can't be
called on NULL values. Check using IsDBNull before calling.
```

Diese Ausnahme ist der mit Abstand häufigste Weg, auf dem dieses Problem entdeckt wird. Der genaue Typ variiert je nach Provider, die Ursache ist aber immer dieselbe: EF erzeugt eine `IsDBNull`-Prüfung nur für eine Spalte, die es für nullbar hält, und davon kann hier keine Rede sein. Das ist ein anderer Fehler als [die Eigenschaft konnte nicht gemappt werden, weil sie kein unterstützter primitiver Typ ist](/de/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/), der beim Modellaufbau statt beim Materialisieren auftritt.

## Der Converter, der nulls tatsächlich konvertiert

`ValueConverter<TModel, TProvider>` besitzt einen zweiten Konstruktor, hinzugefügt in EF Core 6.0, der ein `convertsNulls`-Flag entgegennimmt:

```csharp
[Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkInternal]
public ValueConverter(
    Expression<Func<TModel, TProvider>> convertToProviderExpression,
    Expression<Func<TProvider, TModel>> convertFromProviderExpression,
    bool convertsNulls,
    ConverterMappingHints? mappingHints = default);
```

Es gibt keine `HasConversion`-Überladung dafür, Sie müssen also ableiten. Das Vorgehen umfasst drei Schritte:

1. Schreiben Sie eine Converter-Klasse, deren Provider-Typ explizit nullbar ist, und übergeben Sie `convertsNulls: true` an den Basiskonstruktor.
2. Unterdrücken Sie `EF1001` um die Klasse herum, da der Konstruktor intern ist.
3. Rufen Sie `.IsRequired(false)` auf der Eigenschaft auf, damit EF die Spalte als nullbar behandelt und die `IsDBNull`-Prüfung erzeugt, die der Lesepfad benötigt.

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToEmptyString : ValueConverter<string, string?>
{
    public NullToEmptyString()
        : base(
            v => v.Length == 0 ? null : v,   // model -> provider
            v => v ?? "",                    // provider -> model
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Notes)
        .HasConversion(new NullToEmptyString())
        .IsRequired(false);
}
```

Ohne das `#pragma` gibt der Build aus:

```
warning EF1001: Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<string, string?>
is an internal API that supports the Entity Framework Core infrastructure and not subject to the same
compatibility standards as public APIs. It may be changed or removed without notice in any release.
```

Das ist eine Warnung, kein Fehler, wird aber unter `TreatWarningsAsErrors` zum Fehler, und genau deshalb stoßen die meisten überhaupt erst auf diese API.

Mit dieser Konfiguration funktionieren beide Richtungen. Zeile 1 materialisiert mit `Notes` gleich `""` statt `null`, und das Speichern einer neuen Entität mit `Notes` gleich `""` schreibt ein echtes `NULL` in die Spalte, bestätigt durch anschließendes Lesen der rohen Tabelle.

Schritt 3 ist nicht optional und wird fast immer übersprungen. Lassen Sie `.IsRequired(false)` weg, bleibt `Notes` im Modell nicht nullbar (`IsNullable = False`), EF lässt die Null-Prüfung aus, und das Lesen wirft dieselbe Ausnahme `The data is NULL at ordinal 1` wie zuvor. Der Converter ist korrekt konfiguriert und wird nie aufgerufen. Falls Sie unsicher sind, in welchem Zustand Sie sich befinden, beantwortet `context.Model.FindEntityType(typeof(Order))!.FindProperty("Notes")!.IsNullable` das in einer Zeile.

## Die Abfragefalle: WHERE col = NULL

Hier folgt der Teil, vor dem die [EF Core Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) warnt, ohne ihn zu zeigen, und er ist der Grund, warum die API intern ist. EF wendet die Modell-zu-Provider-Hälfte Ihres Converters auch auf Konstanten in der Abfrage an. Ihr Sentinel wird zu `null`, und EF setzt dieses `null` als gewöhnlichen Vergleichsoperanden ins SQL.

Vier Wege zu fragen "welche Bestellungen haben keine Notizen", das SQL, das EF Core 10.0.10 jeweils erzeugt, und die zurückgegebenen Zeilen gegen eine Tabelle mit einer NULL-Zeile und einer `'hi'`-Zeile:

| LINQ | Erzeugtes SQL-Prädikat | Zeilen |
| --- | --- | --- |
| `o.Notes == ""` | `"o"."Notes" = NULL` | 0 |
| `o.Notes == null!` | `"o"."Notes" IS NULL` | 1 |
| `string.IsNullOrEmpty(o.Notes)` | `"o"."Notes" IS NULL OR "o"."Notes" = NULL` | 1 |
| `o.Notes.Length == 0` | `length("o"."Notes") = 0` | 0 |

Die natürliche Abfrage, der Vergleich mit dem selbst erfundenen Sentinel, liefert nichts. `= NULL` ist unter der dreiwertigen Logik von SQL nie wahr, die Zeile wird also stillschweigend übersprungen. Keine Ausnahme, keine Warnung, nur ein Filter, der in der Produktion leise null Zeilen trifft.

Die Abfrage, die funktioniert, ist `o.Notes == null`, ein Vergleich, den der Analyzer für nullbare Referenztypen als immer falsch meldet, auf einer Eigenschaft, die nach der Materialisierung tatsächlich nie null ist. Sie schreiben Code, den der Compiler für tot hält, um das SQL zu erzeugen, das Sie brauchen. `string.IsNullOrEmpty` überlebt nur zufällig, weil EF es in zwei Prädikate aufspaltet und die `IS NULL`-Hälfte das Ergebnis trägt. `Length == 0` scheitert aus dem gewöhnlichen Grund, dass NULL sich durch `length()` fortpflanzt.

Das ist kein Fehler, der sich nachgelagert beheben ließe. Genau das meint [Issue #26230](https://github.com/dotnet/efcore/issues/26230) mit "value conversion to null in the store generates bad queries", und genau deshalb hat das EF-Team den Konstruktor für 6.0 als intern markiert, statt ihn öffentlich auszuliefern: der Fehler ist unsichtbar und nicht leicht zu entdecken. Wenn Sie diesen Weg gehen, besteht die Absicherung darin, das Prädikat zu prüfen statt ihm zu vertrauen, entweder mit `ToQueryString()` in einem Test oder indem Sie [das SQL protokollieren, das EF Core 11 generiert](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Warum es für ein Enum, int oder DateTime nicht funktionieren kann

Bei einem nicht nullbaren Werttyp bringt Sie `convertsNulls` bis zur Hälfte und dann nicht weiter. Schreiben Sie den Converter:

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToUnknown : ValueConverter<ShippingStatus, string?>
{
    public NullToUnknown()
        : base(
            v => v == ShippingStatus.Unknown ? null : v.ToString(),
            v => v == null ? ShippingStatus.Unknown : Enum.Parse<ShippingStatus>(v),
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001
```

Die Schreibseite funktioniert: das Speichern von `ShippingStatus.Unknown` schreibt `NULL`. Die Leseseite nicht, und Schritt 3 von oben ist der Grund. `.IsRequired(false)` wirft beim Modellaufbau:

```
System.InvalidOperationException: The property 'Order.Status' cannot be marked as
nullable/optional because the type of the property is 'ShippingStatus' which is not a
nullable type. Any property can be marked as non-nullable/required, but only properties
of nullable types can be marked as nullable/optional.
```

Die Nullbarkeitsprüfung von EF betrachtet den CLR-Typ, nicht den Converter, weshalb keine Kombination von Einstellungen ans Ziel führt. Lassen Sie den Aufruf weg, behält das Modell `IsNullable = False`, EF überspringt die `IsDBNull`-Prüfung, und jedes Lesen einer NULL-Zeile wirft. Eine dritte Option gibt es nicht. `convertsNulls` auf einem nicht nullbaren Werttyp ist ein reines Schreib-Feature, und das ist schlimmer als nutzlos: es persistiert bereitwillig NULLs, die dasselbe Modell nicht zurücklesen kann.

## Die zwei Muster, die tatsächlich funktionieren

### Eine nullbare Eigenschaft mappen und eine nicht nullbare Fassade bereitstellen

Die gemappte Eigenschaft bildet die Nullbarkeit der Datenbank ehrlich ab. Die Domänen-Eigenschaft erledigt das Coalescing in reinem C#, wo kein Abfrageübersetzer beteiligt ist:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    public ShippingStatus? StatusRaw { get; set; }

    [NotMapped]
    public ShippingStatus Status
    {
        get => StatusRaw ?? ShippingStatus.Unknown;
        set => StatusRaw = value == ShippingStatus.Unknown ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.StatusRaw)
        .HasColumnName("Status")
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

Keine interne API, kein `EF1001`, und die Abfragen sind konstruktionsbedingt korrekt: `Where(o => o.StatusRaw == null)` erzeugt `WHERE "o"."Status" IS NULL` und trifft die NULL-Zeile, während `Where(o => o.StatusRaw == ShippingStatus.Shipped)` `WHERE "o"."Status" = 'Shipped'` erzeugt. Die Enum-zu-String-Hälfte ist die gewöhnliche eingebaute Konvertierung, behandelt in [Wie man ein Enum mit einem Value Converter als String speichert](/de/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), einschließlich des `HasMaxLength`, das SQL Server daran hindert, Ihnen ein nicht indizierbares `nvarchar(max)` zu geben.

Der Preis ist, dass LINQ `StatusRaw` benennen muss, nicht `Status`. Ein Verweis auf `Status` in einem `Where` liefert Ihnen [der LINQ-Ausdruck konnte nicht übersetzt werden](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), weil `[NotMapped]`-Member kein SQL-Gegenstück haben. Das ist ein fairer Tausch: der Übersetzer verweigert die Arbeit, statt still `= NULL` zu erzeugen.

### Ein privates Backing Field mappen

Wenn Sie die öffentliche Oberfläche nicht um ein `StatusRaw` erweitern möchten, mappen Sie ein Feld und behalten eine einzige öffentliche Eigenschaft:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    private string? _notes;

    public string Notes
    {
        get => _notes ?? "";
        set => _notes = value.Length == 0 ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>(e =>
    {
        e.Ignore(o => o.Notes);
        e.Property<string?>("_notes")
            .HasColumnName("Notes")
            .UsePropertyAccessMode(PropertyAccessMode.Field);
    });
}
```

Lesen und Schreiben verhalten sich identisch zur Fassaden-Variante, und `Where(o => EF.Property<string>(o, "_notes") == null)` übersetzt zu `WHERE "o"."Notes" IS NULL`. Der Nachteil: jede Abfrage auf diese Spalte läuft über das string-basierte `EF.Property<T>`, dem kein Umbenennungs-Refactoring folgt. Bevorzugen Sie die Fassade, sofern die zusätzliche öffentliche Eigenschaft nicht wirklich inakzeptabel ist.

### Oder ändern Sie die Daten

Das gehört klar gesagt, denn oft ist es die richtige Antwort: wenn NULL und Ihr Sentinel exakt dasselbe bedeuten, trägt das Schema eine Unterscheidung, die die Domäne nicht hat. Ein `UPDATE Orders SET Status = 'Unknown' WHERE Status IS NULL`, ein `ALTER COLUMN ... NOT NULL` und ein `HasDefaultValue("Unknown")` beseitigen das Problem, statt es zu umgehen. Das ist eine Datenmigration und kein Mapping-Trick, und [Wie Sie eine Tabelle in einer Migration umbenennen, ohne Daten zu verlieren](/de/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) behandelt die allgemeine Form, eine Migration von Hand zu bearbeiten, damit Datenänderungen neben Schemaänderungen mitlaufen.

## Wo das Feature steht

[Issue #13850](https://github.com/dotnet/efcore/issues/13850), "Allow HasConversion/ValueConverters to convert nulls", ist weiterhin offen und liegt ohne Termin im Backlog-Milestone. Eine Anfrage aus dem Jahr 2026 nach einer öffentlichen `HasConversion`-Überladung mit `convertsNulls`, [Issue #36365](https://github.com/dotnet/efcore/issues/36365), wurde als Duplikat davon geschlossen. Für EF Core 11 bleibt es damit beim vierargumentigen Konstruktor, Warnung inklusive.

Verwenden Sie ihn, wenn die Modelleigenschaft ein Referenztyp ist, der Sentinel nie als Filter dient und Sie für jede Abfrage auf dieser Spalte einen Test mit `ToQueryString()` haben. Überall sonst, und bei Werttypen immer, mappen Sie die nullbare Eigenschaft und machen das Coalescing in C#.

### Weiterlesen

- [Wie man ein Enum in EF Core 11 mit einem Value Converter als String speichert](/de/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)
- [Lösung: "The LINQ expression could not be translated" in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Lösung: "The property could not be mapped, because it is not a supported primitive type or a valid entity type" in EF Core 11](/de/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)
- [So protokollieren Sie das SQL, das EF Core 11 generiert](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Lösung: CS8618 "Non-nullable property must contain a non-null value when exiting constructor" in C#](/de/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)

### Quellen

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), EF Core Dokumentation
- [ValueConverter&lt;TModel,TProvider&gt; Konstruktoren](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.valueconverter-2.-ctor), .NET API-Referenz
- [Issue #26230: Problems with value converters that convert nulls](https://github.com/dotnet/efcore/issues/26230), dotnet/efcore
- [Issue #13850: Allow HasConversion/ValueConverters to convert nulls](https://github.com/dotnet/efcore/issues/13850), dotnet/efcore
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), EF Core Dokumentation
