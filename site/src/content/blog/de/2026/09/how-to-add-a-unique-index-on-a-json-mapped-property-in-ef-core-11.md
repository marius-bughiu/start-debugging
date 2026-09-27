---
title: "Einen eindeutigen Index für eine JSON-gemappte Eigenschaft in EF Core 11 anlegen (SQL Server und SQLite)"
description: "HasIndex(...).IsUnique() auf einem ToJson()-Member erzwingt in EF Core 11 RC 1 keine Eindeutigkeit: SQL Server verwirft IsUnique und SQLite indiziert das gesamte Dokument. Legen Sie den JSON-Wert stattdessen als berechnete Spalte offen und setzen Sie den eindeutigen Index darauf."
pubDate: 2026-09-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "sqlite"
  - "json"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/how-to-add-a-unique-index-on-a-json-mapped-property-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-27
---

Kurze Antwort: Setzen Sie in EF Core 11 RC 1 kein `IsUnique()` auf einen Index über ein Member einer `ToJson()`-komplexen Eigenschaft. Es tut nicht das, was das Modell verspricht. Auf SQL Server erzeugt EF `CREATE JSON INDEX`, das keine eindeutige Form kennt, und verwirft `IsUnique()` stillschweigend. Auf SQLite erzeugt EF `CREATE UNIQUE INDEX ... ("Contact")`, sodass das gesamte JSON-Dokument indiziert wird und zwei Zeilen mit derselben E-Mail-Adresse akzeptiert werden. Die Lösung, die bei beiden Providern funktioniert, besteht darin, den JSON-Wert als Shadow Property auf eine berechnete Spalte zu mappen (`JSON_VALUE` auf SQL Server, `json_extract` auf SQLite), `HasIndex(...).IsUnique()` auf diese Spalte zu setzen und über `EF.Property` abzufragen, damit der Index tatsächlich genutzt wird.

Ich habe alles im Folgenden gegen `Microsoft.EntityFrameworkCore.SqlServer` und `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 auf dem .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128), C# 14, geprüft. Die SQLite-Ergebnisse habe ich gegen eine echte In-Memory-Datenbank ausgeführt. Das SQL-Server-DDL habe ich mit `GenerateCreateScript()` und dem SQL-Generator für Migrationen erzeugt, aber nicht gegen einen echten SQL Server 2025 ausgeführt. Wo das Serververhalten eine Rolle spielt, zitiere ich die SQL-Server-Dokumentation.

## Das Modell, das richtig aussieht, es aber nicht ist

EF Core 11 hat Indizes über Eigenschaften innerhalb komplexer Typen eingeführt, einschließlich komplexer Typen, die auf eine JSON-Spalte gemappt sind. Die [What's-New-Seite](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) zeigt, wie `HasIndex("Contact.Address.City")` einen SQL-Server-JSON-Index erzeugt. Es liegt nahe, dort `.IsUnique()` hinzuzufügen und einen Constraint zu erwarten:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Contact Contact { get; set; } = new();
}

public class Contact
{
    public string Email { get; set; } = "";
    public Address Address { get; set; } = new();
}

public class Address { public string City { get; set; } = ""; }

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Customer>().ComplexProperty(c => c.Contact, b => b.ToJson());
    mb.Entity<Customer>().HasIndex("Contact.Email").IsUnique(); // looks fine, is not
}
```

Auf SQL Server bei Kompatibilitätsebene 170 gibt `GenerateCreateScript()` Folgendes aus:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE JSON INDEX [IX_Customers_Contact_Email] ON [Customers]([Contact]) FOR (N'$.Email');
```

Nirgendwo steht ein `UNIQUE`. Die [CREATE-JSON-INDEX-Syntax](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) kennt überhaupt keine Unique-Option. Ein JSON-Index ist eine Suchstruktur für `JSON_VALUE`-, `JSON_PATH_EXISTS`- und `JSON_CONTAINS`-Prädikate, kein Constraint. Auf Ebene 160 erhalten Sie denselben `CREATE JSON INDEX` über eine `nvarchar(max)`-Spalte, der beim Anwenden fehlschlägt, eine Falle, die ich in [native json vs. nvarchar(max) in EF Core 11](/de/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) behandelt habe. Bei Logging auf `Warning` protokollierte EF nichts über das verworfene `IsUnique()`.

SQLite ist schlimmer, weil es so aussieht, als hätte es funktioniert:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_Contact_Email" ON "Customers" ("Contact");
```

Der Index ist nach `Contact_Email` benannt, aber der Schlüssel ist die gesamte `"Contact"`-Spalte. Ich habe zwei Kunden mit derselben E-Mail-Adresse und unterschiedlichen Städten eingefügt, und beide `SaveChanges`-Aufrufe waren erfolgreich. Dann habe ich zwei Kunden eingefügt, deren gesamte `Contact`-Dokumente identisch waren, und der zweite schlug fehl mit `SQLite Error 19: 'UNIQUE constraint failed: Customers.Contact'`. Der Constraint, den Sie damit bekommen, lautet also "keine zwei Kunden dürfen byteidentische Contact-Dokumente haben", was keine Regel ist, die irgendjemand will.

Beide Verhaltensweisen sind upstream gemeldet: [dotnet/efcore#39065](https://github.com/dotnet/efcore/issues/39065) für SQL Server und [dotnet/efcore#39064](https://github.com/dotnet/efcore/issues/39064) für SQLite. Npgsql hat dasselbe Ganze-Spalte-Problem für `jsonb` in [npgsql/efcore.pg#3918](https://github.com/npgsql/efcore.pg/issues/3918).

## Warum ein JSON-Pfad nicht direkt ein eindeutiger Schlüssel sein kann

Ein eindeutiger Index braucht einen skalaren Schlüssel pro Zeile. Ein JSON-Dokument ist ein einzelner Wert in einer einzelnen Spalte. Die Datenbank sieht `$.Email` nur dann als Skalar, wenn etwas ihn extrahiert:

- SQL Server erlaubt es nicht, dass ein Indexschlüssel ein Ausdruck ist. Das dokumentierte Muster in [Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) ist eine berechnete Spalte über `JSON_VALUE` plus ein gewöhnlicher B-Tree-Index darauf. `JSON_VALUE` ist deterministisch, und [CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) erlaubt einen `UNIQUE`-Index auf einer berechneten Spalte, die deterministisch und präzise ist.
- SQLite unterstützt Indizes auf Ausdrücken und unterstützt außerdem generierte Spalten. EF Core hat keine API für einen Ausdrucksindex, wohl aber `HasComputedColumnSql`, das SQLite in eine generierte Spalte umwandelt.

Eine berechnete Spalte ist die eine Form, die beide Provider unterstützen und die EF Core modellieren, migrieren und zurücklesen kann. Das ist die Lösung.

## Die Lösung: eine berechnete Spalte mit eindeutigem Index

1. Fügen Sie eine Shadow Property für den Wert hinzu, der eindeutig sein soll, und mappen Sie sie auf eine berechnete Spalte, die ihn aus der JSON-Spalte extrahiert.
2. Setzen Sie `HasIndex(...).IsUnique()` auf diese Shadow Property, nicht auf den JSON-Pfad.
3. Stellen Sie auf SQL Server sicher, dass EF nicht seinen Standardfilter `IS NOT NULL` zum Index hinzufügt (Details weiter unten).
4. Fügen Sie eine Migration hinzu, prüfen Sie sie vor dem Anwenden auf bestehende Duplikate, und fragen Sie über `EF.Property` ab, damit Lookups den Index nutzen.

Hier ist die Modellkonfiguration, einmal geschrieben für beide Provider:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
protected override void OnModelCreating(ModelBuilder mb)
{
    var customer = mb.Entity<Customer>();
    customer.ComplexProperty(c => c.Contact, b => b.ToJson());

    var emailSql = Database.IsSqlServer()
        ? "CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320))"
        : "json_extract(\"Contact\", '$.Email')";

    customer.Property<string>("ContactEmail")
        .HasMaxLength(320)
        .HasComputedColumnSql(emailSql, stored: false)
        .IsRequired();

    customer.HasIndex("ContactEmail").IsUnique();
}
```

SQL Server, Ebene 170 (Ebene 160 ist identisch, außer dass `[Contact]` `nvarchar(max)` ist):

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)),
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);
```

SQLite:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "ContactEmail" AS (json_extract("Contact", '$.Email')),
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

Mit diesem Modell auf SQLite schlägt ein zweiter Kunde mit `a@x.com` bei `SaveChanges` fehl, mit einer `DbUpdateException`, die `SQLite Error 19: 'UNIQUE constraint failed: Customers.ContactEmail'` umschließt. `ExecuteUpdate` ist ebenfalls abgedeckt: `SetProperty(x => x.Contact.Email, "a@x.com")` auf einer anderen Zeile schlug mit demselben Fehler fehl, weil die generierte Spalte aus dem aktualisierten Dokument neu berechnet wird. Nach `SaveChanges` liest EF den berechneten Wert außerdem zurück in die Shadow Property (`Entry(e).Property("ContactEmail").CurrentValue` gab `a@x.com` zurück), da berechnete Spalten `ValueGenerated.OnAddOrUpdate` sind.

Auf SQL Server taucht das Duplikat als `SqlException`-Nummer 2601 auf ("Cannot insert duplicate key row"). Fangen Sie `DbUpdateException` ab und prüfen Sie die innere Exception, wenn Sie daraus einen Validierungsfehler machen möchten.

Ein paar Entscheidungen in diesem Code sind wichtig:

- **Der `CAST` auf `nvarchar(320)`.** `JSON_VALUE` liefert `nvarchar(4000)` zurück, und die [Index-JSON-data-Seite](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) warnt, dass Indexschlüssel über 1700 Bytes Inserts fehlschlagen lassen. 320 Zeichen sind das praktische Maximum für eine E-Mail-Adresse und sind als `nvarchar` 640 Bytes. Casten Sie auf den schmalsten Typ, der zu Ihrem Wert passt. Bei Zahlen casten Sie auf `int` oder `bigint`.
- **`stored: false`.** Keiner der beiden Provider muss den Wert persistieren, damit er indiziert werden kann. Auf SQL Server kann eine nicht persistierte berechnete Spalte indiziert werden, solange sie deterministisch und präzise ist. Auf SQLite kann eine virtuelle generierte Spalte indiziert werden, und nur virtuelle können später mit `ALTER TABLE` hinzugefügt werden.
- **`IsRequired()`.** Dabei geht es nicht um die Spalte. Es verhindert, dass EF dem Index einen Filter hinzufügt, was der nächste Abschnitt behandelt.

## Die SQL-Server-Filterfalle

Wenn Sie die Shadow Property optional lassen, tut der SQL-Server-Provider von EF das, was er für jeden eindeutigen Index auf einer nullbaren Spalte tut, und fügt einen Filter hinzu:

```sql
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]) WHERE [ContactEmail] IS NOT NULL;
```

Diese Anweisung lässt sich nicht ausführen. Die [CREATE-INDEX-Referenz](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) hält fest: Das Filterprädikat "can't reference a computed column" - es darf sich also nicht auf eine berechnete Spalte beziehen. EF erzeugt den Index trotzdem anstandslos, sodass Sie das erst bemerken, wenn `dotnet ef database update` fehlschlägt.

Zwei Auswege, beide geprüft, dass sie die `WHERE`-Klausel aus dem generierten SQL entfernen:

```csharp
// .NET 11 RC 1, EF Core 11 - either mark the value required...
customer.Property<string>("ContactEmail").IsRequired();

// ...or keep it optional and remove the filter explicitly
customer.HasIndex("ContactEmail").IsUnique().HasFilter(null);
```

Ohne den Filter behandelt SQL Server NULLs in einem eindeutigen Index als gleich, sodass nur eine Zeile ohne E-Mail-Adresse bleiben darf. Wenn Ihre JSON-Eigenschaft wirklich optional ist, falten Sie einen zeilenspezifischen Wert in den Ausdruck ein, damit fehlende E-Mail-Adressen nie kollidieren. Zum Beispiel: `ISNULL(CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)), N'#' + CAST([Id] AS nvarchar(11)))`. Er ist deterministisch und präzise, bleibt also indizierbar. Ich habe diesen nicht gegen einen echten Server ausgeführt. SQLite hat das Problem nicht: In einem eindeutigen SQLite-Index sind NULLs immer verschieden, und EF fügt dort keinen Filter hinzu.

## Über die Spalte abfragen, sonst bleibt der Index ungenutzt

Der eindeutige Index erzwingt die Regel unabhängig davon, wie Sie Abfragen schreiben. Ob Sie ihn für Lookups nutzen, ist eine andere Frage. Ein einfacher LINQ-Filter auf den JSON-Pfad referenziert Ihre berechnete Spalte nicht:

```csharp
// .NET 11 RC 1, EF Core 11
db.Customers.Where(c => c.Contact.Email == email);
// SQL Server 170: WHERE JSON_VALUE([c].[Contact], '$.Email' RETURNING nvarchar(max)) = N'a@x.com'
// SQLite:         WHERE "c"."Contact" ->> 'Email' = 'a@x.com'
```

SQL Server kann einen Abfrageausdruck einer äquivalenten berechneten Spalte zuordnen, aber nur, wenn die Ausdrücke identisch sind. `JSON_VALUE(... RETURNING nvarchar(max))` ist nicht dasselbe wie `CAST(JSON_VALUE(...) AS nvarchar(320))`. SQLite gleicht Ausdrücke generierter Spalten überhaupt nicht ab. Mit der sqlite3-3.50.6-CLI lieferte `EXPLAIN QUERY PLAN` für `Contact ->> 'Email'` und ein von Hand geschriebenes `json_extract(Contact, '$.Email')` jeweils `SCAN c`, und nur die Spaltenreferenz erzeugte `SEARCH c USING INDEX IX_Customers_ContactEmail (ContactEmail=?)`.

Filtern Sie also auf die Shadow Property:

```csharp
// .NET 11 RC 1, EF Core 11 - produces WHERE [c].[ContactEmail] = @email on both providers
var existing = await db.Customers
    .Where(c => EF.Property<string>(c, "ContactEmail") == email)
    .FirstOrDefaultAsync();
```

Wenn Sie die `EF.Property`-Strings stören, mappen Sie stattdessen eine echte, schreibgeschützte Eigenschaft (`public string ContactEmail { get; private set; } = "";`) mit demselben `HasComputedColumnSql`. EF befüllt sie nach jedem Speichern, und Ihre Abfragen bekommen ein normales Lambda.

## Hinzufügen zu einer Tabelle, die bereits Daten enthält

Die Migration, die EF generiert, besteht bei jedem Provider aus zwei Anweisungen:

```sql
-- SQL Server
ALTER TABLE [Customers] ADD [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320));
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);

-- SQLite
ALTER TABLE "Customers" ADD "ContactEmail" AS (json_extract("Contact", '$.Email'));
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

Das `ALTER TABLE` gelingt auch dann, wenn Duplikate existieren. Das `CREATE UNIQUE INDEX` nicht. Auf SQLite mit zwei bereits existierenden `a@x.com`-Zeilen schlug es fehl mit `UNIQUE constraint failed: Customers.ContactEmail (19)`. Finden Sie die Übeltäter zuerst. EF übersetzt die Gruppierung auf den JSON-Pfad auch ohne die neue Spalte:

```csharp
// .NET 11 RC 1, EF Core 11 - run before applying the migration
var duplicates = await db.Customers
    .GroupBy(c => c.Contact.Email)
    .Where(g => g.Count() > 1)
    .Select(g => new { Email = g.Key, Count = g.Count() })
    .ToListAsync();
```

Bereinigen Sie diese Zeilen, und wenden Sie dann die Migration an. Generieren Sie für Produktions-Rollouts das SQL und prüfen Sie es, statt die App sich selbst migrieren zu lassen; der [Workflow für Migration Bundles](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) behandelt das. Wenn Ihr Team Namenskonventionen für Indizes durchsetzt, wird die berechnete Spalte wie jede andere Eigenschaft benannt, sodass die Regeln aus [eigenen Namenskonventionen für Schlüssel und Indizes in EF Core 11](/de/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) ohne Sonderbehandlung auf `IX_Customers_ContactEmail` zutreffen.

## Fallstricke, die Sie vor dem Ausliefern kennen sollten

**Groß-/Kleinschreibung unterscheidet sich zwischen den Providern.** Auf SQLite habe ich `a@x.com` und `A@X.com` eingefügt, und beide wurden akzeptiert, weil SQLite standardmäßig mit der `BINARY`-Kollation vergleicht. Auf SQL Server folgt die Eindeutigkeit der Kollation der Quellspalte, und bei den meisten Datenbanken ist das ohne Berücksichtigung der Groß-/Kleinschreibung, sodass dasselbe Paar kollidieren würde. Wenn die Regel "ein Konto pro E-Mail-Adresse" lautet, normalisieren Sie: Speichern Sie E-Mail-Adressen in Kleinschreibung, oder verwenden Sie auf SQLite `lower(json_extract("Contact", '$.Email'))`, damit beide Provider übereinstimmen. Das Mischen von Providern zwischen Tests und Produktion ist die Stelle, an der das zuschlägt, einer der Gründe, warum [WebApplicationFactory vs. Testcontainers](/de/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) für Tests von Datenregeln wichtig ist.

**Der Name der JSON-Eigenschaft ist Teil des SQL.** `$.Email` muss zu dem passen, was EF in das Dokument schreibt. Wenn Sie die CLR-Eigenschaft umbenennen oder `HasJsonPropertyName("email")` konfigurieren, aktualisieren Sie das SQL der berechneten Spalte in derselben Migration. EF tut das nicht für Sie, weil der Pfad eine undurchsichtige Zeichenfolge ist. Eine Diskrepanz schlägt nicht fehl: Jede Zeile liefert NULL, und Ihre "eindeutige" Regel erzwingt gar nichts mehr.

**Komplexe Collections liegen außerhalb des Anwendungsbereichs.** Ein eindeutiger Index braucht einen Wert pro Zeile. Für "SKU muss über `Items[]` hinweg eindeutig sein" brauchen Sie eine Kindtabelle, keine JSON-Spalte. EF Core 11 kann `Items[].Sku` für Lookups auf SQL Server indizieren, aber das ist ein JSON-Index, kein Constraint.

**Verlassen Sie sich nicht auf ein zukünftiges `IsUnique()`.** Der SQL-Server-Fix, [dotnet/efcore#39090](https://github.com/dotnet/efcore/pull/39090), wurde am 2026-09-26 in `release/11.0` gemergt, nachdem RC 1 erschienen war. Er macht JSON-Indizes nicht eindeutig. Er lässt die Modellvalidierung stattdessen fehlschlagen mit `JSON index '{index}' on entity type '{entityType}' was configured with the '{option}' option, which is not supported on JSON indexes.` Das ist eine Verbesserung, da aus dem stillen Verwerfen ein lauter Fehler wird, aber die Antwort bleibt eine berechnete Spalte. Das SQLite-Issue war noch offen, als ich das hier schrieb.

**Die berechnete Spalte braucht die üblichen SQL-Server-SET-Optionen.** Indizes auf berechneten Spalten erfordern für Sitzungen, die die Tabelle verändern, Einstellungen wie `QUOTED_IDENTIFIER ON` und `ANSI_NULLS ON`. Die Standardwerte von SqlClient erfüllen das, aber ein Legacy-Skript oder -Tool, das sie abschaltet, bekommt beim Schreiben auf `Customers` Fehler.

Wenn Sie sich noch nicht auf ein JSON-Mapping festgelegt haben: [JSON-Spalten in EF Core 11 mappen und abfragen](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt `ComplexProperty(...).ToJson()` von Anfang bis Ende. Alles hier setzt dieses Mapping voraus.

## Quellen

- [What's New in EF Core 11: keys and indexes on complex type properties, JSON indexes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [Index JSON data (computed columns over JSON_VALUE)](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data)
- [CREATE INDEX (Transact-SQL): filtered index and computed column rules](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [SQLite generated columns](https://www.sqlite.org/gencol.html)
- [dotnet/efcore#39065: IsUnique() on an index over a JSON-mapped member is silently dropped](https://github.com/dotnet/efcore/issues/39065)
- [dotnet/efcore#39064: SQLite index on a JSON-mapped member indexes the whole column](https://github.com/dotnet/efcore/issues/39064)
- [dotnet/efcore#39090: Validate unsupported SQL Server JSON index options](https://github.com/dotnet/efcore/pull/39090)
- [npgsql/efcore.pg#3918: index on a JSON-mapped member indexes the whole jsonb column](https://github.com/npgsql/efcore.pg/issues/3918)
