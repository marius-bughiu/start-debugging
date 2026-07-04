---
title: "Fix: \"The required column 'X' was not present in the results of a 'FromSql' operation\" in EF Core 11"
description: "EF Core wirft dies, wenn Ihr rohes SQL nicht alle von der Entität gemappten Spalten zurückgibt oder die Namen nicht übereinstimmen. Geben Sie alle gemappten Spalten mit passenden Namen zurück, oder fragen Sie einen skalaren oder schlüssellosen Typ ab."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "de"
translationOf: "2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core wirft `The required column 'X' was not present in the results of a 'FromSql' operation`, wenn das rohe SQL, das Sie an `FromSql`, `FromSqlRaw` oder `FromSqlInterpolated` übergeben haben, eine Spalte nicht zurückgibt, die der Ziel-Entitätstyp mappt. Der Materializer liest die Ergebnisse nach gemapptem Spaltennamen, daher muss die Spalte jeder Eigenschaft im Resultset enthalten sein, geschrieben so, wie EF es erwartet. Beheben Sie es, indem Sie alle gemappten Spalten zurückgeben (`SELECT *` oder eine explizite Liste mit passenden Aliassen), oder wechseln Sie, wenn Sie nur eine Teilmenge oder eine beliebige Form möchten, zu `Database.SqlQuery<T>` oder einem schlüssellosen Entitätstyp statt einer vollständigen Entität. Dies gilt für `Microsoft.EntityFrameworkCore` 11.0 auf .NET 11 mit C# 14, und die Regel ist seit EF Core 3.0 dieselbe.

## Der Fehler im Kontext

Die vollständige Laufzeit-Ausnahme sieht so aus:

```
System.InvalidOperationException: The required column 'Description' was not present in the results of a 'FromSql' operation.
   at Microsoft.EntityFrameworkCore.Query.Internal.RelationalCommandCache...
   at lambda_method(Closure, QueryContext, DbDataReader, ResultContext, ...)
```

Der Ausnahmetyp ist `System.InvalidOperationException`, und sie wird geworfen, während die Ergebnisse gelesen werden, nicht wenn Sie die Abfrage erstellen. Das bedeutet, dass der Stack Trace in die Materialisierungs-Pipeline von EF Core zeigt (ein `lambda_method` und `RelationalCommandCache`), nicht auf Ihre SQL-Zeichenkette. Die einzige nützliche Information ist der Spaltenname in Anführungszeichen: `'Description'`. Das ist die gemappte Spalte, die EF im Reader gesucht und nicht per Name gefunden hat.

## Warum das passiert

Wenn `FromSql` einen gemappten Entitätstyp zurückgibt, liest EF Core die Spalten nicht nach Ordinalposition. Es liest sie nach Namen. Für jede Eigenschaft der Entität fragt es den `DbDataReader` "gib mir das Ordinal der Spalte namens `Description`", und wenn der Reader keine solche Spalte hat, schlägt dieser Aufruf fehl und EF meldet ihn als diesen Fehler. Die Dokumentation formuliert die Einschränkung direkt: Die SQL-Abfrage muss Daten für alle Eigenschaften des Entitätstyps zurückgeben, und die Spaltennamen im Resultset müssen mit den Spaltennamen übereinstimmen, auf die die Eigenschaften gemappt sind.

Drei Dinge lösen es aus, in etwa nach Häufigkeit geordnet:

- **Der SELECT-Liste fehlt eine Spalte.** Sie haben `SELECT Id, Title FROM Articles` geschrieben, aber die Entität `Article` mappt auch eine Eigenschaft `Description`. EF möchte `Description`, und sie ist nicht da.
- **Ein Spaltenname stimmt nicht mit dem gemappten Namen überein.** Das SQL gibt `article_description` zurück (oder einen Ausdruck ohne Alias oder `Col2` aus einer per Scaffolding erzeugten gespeicherten Prozedur), aber die Eigenschaft mappt auf die Spalte `Description`. Derselbe Fehlschlag, und der Name in Anführungszeichen in der Meldung ist der, den EF wollte, nicht der, den Ihr SQL erzeugt hat, weshalb die Meldung irreführend wirken kann.
- **Eine Schatten- oder Owned-Type-Spalte fehlt.** Fremdschlüssel ohne CLR-Eigenschaft, `[Timestamp]`/rowversion-Nebenläufigkeitstoken und Spalten von Owned Types sind alle gemappt und alle erforderlich. Sie werden leicht vergessen, weil sie in der Entitätsklasse unsichtbar sind.

Dies ist eine bewusste Designentscheidung, kein Bug. EF6 ignorierte das Eigenschaft-zu-Spalte-Mapping für rohes SQL und glich locker nach Eigenschaftsnamen ab; EF Core machte es strikt, damit sich eine rohe Entitätsabfrage genau wie eine normale verhält und sicher nachverfolgt, korrigiert und darübergeschichtet werden kann.

## Minimale Reproduktion

Hier ist das kleinste Programm, das es reproduziert. Die Entität mappt drei Spalten; das SQL gibt zwei zurück:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new BlogContext();

// Throws: 'Description' is mapped but not in the SELECT list.
var articles = await db.Articles
    .FromSql($"SELECT Id, Title FROM Articles")
    .ToListAsync();

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
}

public class BlogContext : DbContext
{
    public DbSet<Article> Articles => Set<Article>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Blog;Trusted_Connection=True;Encrypt=False");
}
```

EF Core mappt `Article` auf drei Spalten: `Id`, `Title`, `Description`. Der Reader, der von `SELECT Id, Title` zurückkommt, hat nur zwei davon, daher schlägt die Materialisierung in dem Moment fehl, in dem `ToListAsync` beginnt, Zeilen zu lesen, mit `'Description' was not present`.

## Der Fix im Detail

Die Fixes sind vom besten (eine echte, vollständige Entität zurückgeben) bis zu den Alternativen geordnet, zu denen Sie greifen, wenn Sie die vollständige Entität wirklich nicht wollen.

### 1. Geben Sie jede gemappte Spalte zurück

Wenn Sie nachverfolgte `Article`-Entitäten zurückbekommen möchten, muss das SQL jede Spalte erzeugen, die die Entität mappt. Die einfachste korrekte Form ist `SELECT *` gegen die Tabelle (oder eine View/TVF, deren Spalten passen):

```csharp
// .NET 11, EF Core 11 -- returns Id, Title, Description: all three mapped columns
var articles = await db.Articles
    .FromSql($"SELECT * FROM Articles")
    .ToListAsync();
```

`SELECT *` ist hier in Ordnung, gerade weil EF nach Namen abgleicht, sodass die Spaltenreihenfolge keine Rolle spielt und zusätzliche Spalten ignoriert werden. Wenn Sie eine explizite Liste bevorzugen (sicherer gegen Schema-Drift und klarer im Code-Review), listen Sie jede gemappte Spalte auf und stellen Sie sicher, dass keine fehlt:

```csharp
// .NET 11, EF Core 11 -- explicit, complete column list
var articles = await db.Articles
    .FromSql($"SELECT Id, Title, Description FROM Articles WHERE Title LIKE {'%' + term + '%'}")
    .ToListAsync();
```

Denken Sie daran, dass "jede gemappte Spalte" auch Spalten ohne offensichtliche CLR-Eigenschaft umfasst: Schatten-Fremdschlüssel, ein `RowVersion`-Nebenläufigkeitstoken, Diskriminatorspalten für die TPH-Vererbung. Wenn Ihre Entität ein `[Timestamp] public byte[] RowVersion` oder einen Vererbungsdiskriminator hat, muss diese Spalte ebenfalls im Resultset sein.

### 2. Aliasieren Sie die Spalten, damit die Namen übereinstimmen

Wenn das SQL die gemappten Namen nicht direkt verwenden kann, zum Beispiel eine gespeicherte Prozedur oder eine Legacy-Tabelle, die `article_desc` zurückgibt, aliasieren Sie die Ausgabespalten auf die von EF erwarteten Namen. Der Abgleich unterscheidet nicht zwischen Groß- und Kleinschreibung, aber der Name muss vorhanden sein:

```csharp
// .NET 11, EF Core 11 -- alias legacy names onto mapped column names
var articles = await db.Articles
    .FromSqlRaw(@"SELECT article_id AS Id,
                         article_title AS Title,
                         article_desc AS Description
                  FROM legacy_articles")
    .ToListAsync();
```

Wenn Sie lieber das Mapping als das SQL ändern, mappen Sie die Eigenschaft mit `[Column("article_desc")]` oder `HasColumnName("article_desc")` in `OnModelCreating` auf den echten Spaltennamen, und dann passt das rohe SQL, das `article_desc` zurückgibt, ohne Alias. Wählen Sie eine Seite; kämpfen Sie nicht auf beiden gegen sich selbst.

### 3. Fragen Sie einen Skalar oder eine Projektion mit `SqlQuery<T>` ab

Wenn Sie nur ein paar Felder möchten, erzwingen Sie keine vollständige Entität. `Database.SqlQuery<T>` (EF Core 7.0+, weiterhin die aktuelle API in 11.0) liest einen beliebigen Typ ohne die Regel "alle gemappten Spalten". Für eine einzelne skalare Spalte:

```csharp
// .NET 11, EF Core 11 -- no entity involved, so no missing-column rule
var titles = await db.Database
    .SqlQuery<string>($"SELECT Title FROM Articles WHERE Id > {minId}")
    .ToListAsync();
```

Für eine mehrspaltige Form deklarieren Sie einen einfachen Record, dessen Eigenschaftsnamen mit den (möglicherweise aliasierten) Ergebnisspalten übereinstimmen, und fragen ihn ab. Dieser Typ ist nicht Teil Ihres Modells, sodass EF nichts zur Vollständigkeit verlangt:

```csharp
// .NET 11, EF Core 11 -- lightweight read model, matched by name
public record ArticleSummary(int Id, string Title);

var summaries = await db.Database
    .SqlQuery<ArticleSummary>($"SELECT Id, Title FROM Articles")
    .ToListAsync();
```

`SqlQuery<T>` verfolgt Ergebnisse nie nach, was genau das ist, was Sie für eine schreibgeschützte Zusammenfassung wollen. Es ist das richtige Werkzeug in dem Moment, in dem Sie sich dabei ertappen, eine partielle Entität zu wollen.

### 4. Modellieren Sie das Ergebnis als schlüssellosen Entitätstyp

Für eine Form, die Sie in der gesamten Anwendung wiederverwenden, insbesondere die Ausgabe einer View oder einer Reporting-Prozedur, deklarieren Sie einen schlüssellosen Entitätstyp. Er nimmt am Modell teil (sodass Sie `Include` verwenden und in einigen Fällen darüberschichten können), hat aber keinen Schlüssel und wird nie nachverfolgt. Konfigurieren Sie ihn mit `HasNoKey`:

```csharp
// .NET 11, EF Core 11 -- keyless type mapped to a reporting shape
public class ArticleStat
{
    public string Title { get; set; } = "";
    public int ViewCount { get; set; }
}

// in OnModelCreating:
modelBuilder.Entity<ArticleStat>().HasNoKey().ToView(null);

// query:
var stats = await db.Set<ArticleStat>()
    .FromSql($"SELECT Title, COUNT(*) AS ViewCount FROM Views GROUP BY Title")
    .ToListAsync();
```

Ein schlüsselloser Entitätstyp verlangt weiterhin, dass seine eigenen gemappten Spalten vorhanden sind, aber Sie steuern dieses Mapping, sodass Sie es genau auf die Spalten dimensionieren, die Ihr SQL zurückgibt, statt auf eine vollständige Tabellenentität.

## Feinheiten und Varianten

**Die Spalte in Anführungszeichen ist nicht die, die Ihrem SQL fehlt.** Da EF nach Namen abgleicht, sagt die Meldung `'Description' was not present`, nicht `'Desc' was unexpected`, wenn Ihr SQL `Desc` zurückgibt und die Entität `Description` mappt. Vergleichen Sie die Liste der Spalten, die Ihre Abfrage tatsächlich zurückgibt, mit den gemappten Spalten der Entität, und suchen Sie die Abweichung, statt darauf zu vertrauen, dass die genannte Spalte buchstäblich fehlt. Genau diese Verwirrung ist in [dotnet/efcore issue #33748](https://github.com/dotnet/efcore/issues/33748) dokumentiert.

**Per Scaffolding erzeugte gespeicherte Prozeduren erzeugen `Col1`, `Col2`.** Wenn eine gespeicherte Prozedur eine berechnete Spalte ohne Namen zurückgibt (`SELECT COUNT(*)` statt `SELECT COUNT(*) AS Total`), benennen Reverse-Engineering-Tools sie `Col0`, `Col1` und so weiter, und dann erwartet der generierte Ergebnistyp diese Namen. Geben Sie jeder Spalte in der Prozedur einen expliziten Alias, und das Problem verschwindet an der Quelle.

**Eine gespeicherte Prozedur, die eine Teilmenge projiziert.** `EXECUTE dbo.GetArticleTitles`, das nur `Id, Title` zurückgibt, kann kein vollständiges `Article` materialisieren. Lassen Sie es nicht über `context.Articles.FromSql` laufen; lassen Sie es über `Database.SqlQuery<T>` oder einen schlüssellosen Typ laufen, der auf das dimensioniert ist, was die Prozedur zurückgibt. Denken Sie auch daran, dass Sie LINQ nicht über einen Aufruf einer gespeicherten Prozedur schichten können, also fügen Sie direkt nach `FromSql` ein `AsEnumerable()` hinzu, wenn Sie weitere In-Memory-Arbeit brauchen.

**Owned Types und Tabellenaufteilung.** Wenn `Article` ein Wertobjekt vom Typ `Address` besitzt, das in derselben Tabelle gespeichert ist, sind die Spalten des Owned Type Teil der Entität und müssen im Resultset sein. Sie wegzulassen erzeugt denselben Fehler für eine Spalte, deren Existenz Ihnen vielleicht nicht bewusst ist. Nehmen Sie sie auf oder teilen Sie das Lesen in eine schlüssellose Projektion auf.

**Es funktionierte vor einem Upgrade von EF6.** EF6 glich die Ergebnisse von rohem SQL nach Eigenschaftsnamen ab und war locker bei fehlenden oder falsch benannten Spalten. EF Core ist strikt. Wenn Sie eine Codebasis über diese Grenze bewegen, ist dies eines von mehreren Verhalten von rohem SQL, das sich geändert hat, und es geht Hand in Hand mit dem breiteren Satz an [Breaking Changes, die beim Migrieren von EF Core 6 zu EF Core 11 wirklich zubeißen](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Ein `NULL` in einer nicht-nullbaren Spalte ist ein anderer Fehler.** Wenn die Spalte vorhanden ist, der Wert aber `NULL` ist und die Eigenschaft ein nicht-nullbarer Werttyp, erhalten Sie eine `System.Data.SqlTypes.SqlNullValueException` oder einen Materialisierungsfehler über das Konvertieren von null, nicht diesen. Das ist ein Datenproblem, kein Formproblem; machen Sie die Eigenschaft nullbar oder nutzen Sie `ISNULL`/`COALESCE` im SQL.

Das mentale Modell, das Sie dauerhaft aus diesem Fehler heraushält: `FromSql` auf einem `DbSet<T>` ist ein Versprechen, ein vollständiges, korrekt benanntes `T` zurückzugeben. Wenn Sie dieses Versprechen nicht halten können oder wollen, verwenden Sie keine Entität. Nutzen Sie `SqlQuery<T>` für Skalare und Ad-hoc-Records oder einen schlüssellosen Typ für eine Form, die Sie benennen und wiederverwenden. Reservieren Sie `context.Set<T>().FromSql` für den Fall, dass das SQL wirklich die gesamte Entität hydratisiert.

## Verwandt

- [Fix: "The LINQ expression could not be translated" in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) ist der Geschwisterfehler, den Sie treffen, wenn Sie den anderen Weg gehen und bei LINQ bleiben.
- [Kompilierte Abfragen von EF Core vs rohes SQL vs Dapper](/de/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) wägt ab, wann rohes SQL seine scharfen Kanten wert ist, die Sie gerade kennengelernt haben.
- [So mappen und fragen Sie JSON-Spalten in EF Core 11 ab](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt einen weiteren Fall, in dem die Form des Ergebnisses und das Mapping der Entität zusammenpassen müssen.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) ist relevant, sobald Ihre rohe Entitätsabfrage funktioniert und Sie das Lesen günstig machen wollen.
- [So erkennen Sie N+1-Abfragen in EF Core 11](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) lohnt einen Blick, wenn rohes SQL Ihre Antwort auf eine Abfrage ist, die EF schlecht generiert hat.

## Quellen

- [Rohe SQL-Abfragen, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) (siehe den Abschnitt "Limitations": alle gemappten Spalten müssen zurückgegeben werden, und die Namen müssen übereinstimmen)
- [Schlüssellose Entitätstypen, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [RelationalDatabaseFacadeExtensions.SqlQuery, API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlquery)
- [dotnet/efcore issue #33748: irreführender "missing column"-Text für eine falsche Spalte](https://github.com/dotnet/efcore/issues/33748)
