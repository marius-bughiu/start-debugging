---
title: "So erzeugen Sie einen Primärschlüssel beim Insert aus einer Datenbanksequenz in EF Core 11"
description: "Einen Schlüssel in EF Core 11 mit UseSequence von IDENTITY auf eine SQL Server-Sequenz umstellen: das exakte SQL, das EF erzeugt, warum explizite Schlüsselwerte plötzlich ohne IDENTITY_INSERT funktionieren, die bigint-Sequenz an einer int-Spalte und die Lücken, die Sie einplanen müssen."
pubDate: 2026-08-17
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "primary-keys"
  - "migrations"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-17
---

Kurze Antwort: Rufen Sie `UseSequence` auf der Schlüsseleigenschaft auf. EF Core setzt die Eigenschaft auf `ValueGenerated.OnAdd`, gibt der Spalte in der Migration eine `DEFAULT (NEXT VALUE FOR [schema].[SequenceName])`-Einschränkung und liest den erzeugten Wert über eine `OUTPUT`-Klausel am Insert zurück. Das kostet exakt gleich viele Roundtrips wie `IDENTITY`, wird genauso gebündelt und erlaubt das Einfügen expliziter Schlüsselwerte ohne `SET IDENTITY_INSERT`. Die beiden Stolperstellen sind der Sequenztyp (EF legt eine `bigint`-Sequenz an, sofern Sie sie nicht selbst deklarieren) und die Lücken, die SQL Server als unvermeidbar dokumentiert.

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Order>()
    .Property(o => o.Id)
    .UseSequence("OrderNumbers", "shared");
```

Das SQL in diesem Artikel wurde aus EF Cores eigenem `ICommandBatchPreparer` und aus `GenerateCreateScript()` mit **EF Core 10.0.11 auf .NET SDK 10.0.201** abgegriffen, da EF Core 11 die .NET 11-Runtime voraussetzt und diese Maschine sie nicht hat. Das fällt hier weniger ins Gewicht als sonst: Die [EF Core 11 Release Notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) enthalten überhaupt keine Einträge zu Sequenzen oder zur Erzeugung von Schlüsselwerten, und `SqlServerPropertyBuilderExtensions.UseSequence` ist auf `main` unverändert. Jede Anweisung unten ist echte EF-Ausgabe, nichts davon habe ich abgetippt. Verhalten, das einen laufenden Server zur Beobachtung braucht (Lücken durch Rollback, Cache-Verlust), ist aus der SQL Server-Dokumentation zitiert und entsprechend gekennzeichnet.

## Warum man einen Schlüssel von IDENTITY wegholt

`IDENTITY` ist der SQL Server-Standard und für die meisten Tabellen völlig ausreichend. Drei Situationen sprechen dagegen:

- **Zwei Tabellen müssen aus demselben Nummernkreis schöpfen.** Bestellungen und Rechnungen, die nie dieselbe Belegnummer tragen dürfen, können nicht beide ein eigenes `IDENTITY` besitzen. Eine Sequenz hängt an keiner Tabelle, also können beide daraus ziehen.
- **Sie brauchen den Wert vor dem Insert.** `NEXT VALUE FOR` lässt sich eigenständig aufrufen. Sie können also einen Schlüssel reservieren, einen Beleg darum herum aufbauen und später einfügen. `IDENTITY` liefert einen Wert nur als Nebeneffekt eines Inserts.
- **Sie importieren Zeilen mit bereits vergebenen Schlüsseln.** Mit `IDENTITY` braucht jeder solche Insert ein `SET IDENTITY_INSERT dbo.Orders ON` drumherum, einen verbindungsgebundenen Schalter für jeweils eine Tabelle, den EF nicht für Sie verwaltet. Bei einer Sequenz ist die Spalte eine gewöhnliche Spalte mit Standardwert, ein expliziter Wert geht also einfach durch.

## Die Zwei-Zeilen-Fassung

Deklarieren Sie die Sequenz und richten Sie den Schlüssel darauf aus:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.HasSequence<int>("DocumentNumbers", schema: "shared")
        .StartsAt(1000)
        .IncrementsBy(1);

    modelBuilder.Entity<Order>()
        .Property(o => o.Id)
        .UseSequence("DocumentNumbers", "shared");

    modelBuilder.Entity<Invoice>()
        .Property(i => i.Id)
        .UseSequence("DocumentNumbers", "shared");
}
```

`UseSequence` setzt drei Dinge auf der Eigenschaft: die Strategie zur Werterzeugung auf `SqlServerValueGenerationStrategy.Sequence`, Name und Schema der Sequenz sowie `ValueGenerated.OnAdd`. Außerdem verwirft es jede zuvor gesetzte Hi-Lo- oder Identity-Seed-Konfiguration. Ein Dump des Modells bestätigt das:

```text
Order.Id:   ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
Invoice.Id: ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
```

Beachten Sie, dass EF `DefaultValueSql` für Sie ausgefüllt hat. Diese Zeichenkette haben Sie nicht geschrieben, und Sie sollten sie bei Verwendung von `UseSequence` auch nicht selbst schreiben.

## Was die Migration erzeugt

`dotnet ef migrations add Initial` liefert einen `CreateSequence`-Aufruf plus ein `defaultValueSql` an der Spalte:

```csharp
// .NET 11, EF Core 11 migration output
migrationBuilder.EnsureSchema(name: "shared");

migrationBuilder.CreateSequence<int>(
    name: "DocumentNumbers",
    schema: "shared",
    startValue: 1000L);

migrationBuilder.CreateTable(
    name: "Orders",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false,
            defaultValueSql: "NEXT VALUE FOR [shared].[DocumentNumbers]"),
        Name = table.Column<string>(type: "nvarchar(max)", nullable: false)
    },
    constraints: table =>
    {
        table.PrimaryKey("PK_Orders", x => x.Id);
    });
```

In der Datenbank landet das so:

```sql
-- SQL Server, generated by EF Core
CREATE SEQUENCE [shared].[DocumentNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Orders] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [shared].[DocumentNumbers]),
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Auf der Spalte liegt kein `IDENTITY`. Es ist ein gewöhnliches `int` mit einer Standardwert-Einschränkung.

## Das INSERT, das EF tatsächlich schickt

Das ist der Punkt, an dem viele falsch liegen, wenn sie ihn sich herleiten. Ein Sequenzschlüssel kostet **keinen** zusätzlichen Roundtrip. EF lässt die Spalte im Insert weg, lässt den Standardwert greifen und liest den Wert in derselben Anweisung zurück:

```sql
-- one Order, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Fügen Sie drei Bestellungen in einem einzigen `SaveChangesAsync` hinzu, verwendet EF dieselbe `MERGE ... OUTPUT`-Form wie bei `IDENTITY`, sodass sich die zurückgelieferten Schlüssel über die Position den nachverfolgten Entitäten zuordnen lassen:

```sql
-- three Orders in one batch, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
MERGE [Orders] USING (
VALUES (@p0, 0),
(@p1, 1),
(@p2, 2)) AS i ([Name], _Position) ON 1=0
WHEN NOT MATCHED THEN
INSERT ([Name])
VALUES (i.[Name])
OUTPUT INSERTED.[Id], i._Position;
```

Byte für Byte ist das genau das, was auch ein `IDENTITY`-Schlüssel erzeugt. Der Wechsel auf eine Sequenz ändert nichts an EFs Batching-Strategie. Falls Sie sich also um ein `SELECT NEXT VALUE FOR` pro Zeile gesorgt haben: unnötig. Das passiert nur bei `UseHiLo`, einer anderen Strategie (dazu unten mehr). Wenn Sie das an Ihrem eigenen Modell sehen wollen: [das von EF Core erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) kostet etwa vier Zeilen Konfiguration.

## Explizite Schlüsselwerte, der Grund für die meisten Umstellungen

Setzen Sie den Schlüssel selbst, dann merkt EF, dass die Eigenschaft nicht mehr auf ihrem CLR-Standardwert steht, nimmt die Spalte in den Insert auf und lässt die `OUTPUT`-Klausel weg:

```csharp
// .NET 11, C# 14, EF Core 11
db.Orders.Add(new Order { Id = 5000, Name = "imported" });
await db.SaveChangesAsync();
```

```sql
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p0, @p1);
```

Ein `IDENTITY`-Schlüssel erzeugt die *identische* Anweisung, und SQL Server lehnt sie mit `Cannot insert explicit value for identity column in table 'Orders' when IDENTITY_INSERT is set to OFF` ab, sofern Sie `IDENTITY_INSERT` nicht selbst um den Aufruf herum umschalten. Bei einer sequenzgestützten Spalte gibt es nichts umzuschalten: Die Spalte hat einen Standardwert, und ein mitgelieferter Wert überschreibt ihn einfach. Das ist der praktische Unterschied, und deshalb wird Import- und Datenmigrationscode nach der Umstellung deutlich kürzer.

Zwei Einschränkungen dazu:

**Null ist kein expliziter Wert.** EF entscheidet über den Vergleich mit dem CLR-Standardwert, ob der Benutzer den Schlüssel gesetzt hat. `new Order { Id = 0 }` ist von `new Order { }` nicht zu unterscheiden, also greift die Sequenz:

```sql
-- Order { Id = 0, Name = "zero" }
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Falls Null in Ihren Daten ein gültiger Schlüssel ist, machen Sie die Eigenschaft im Modell nullbar oder verwenden Sie einen Wert, der nicht dem CLR-Standardwert entspricht.

**Beides zu mischen zerlegt den Batch.** Fügen Sie eine Entität mit explizitem Schlüssel und eine ohne hinzu, erzeugt EF zwei getrennte Anweisungen statt eines `MERGE`, die generierte Zeile zuerst:

```sql
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p1, @p2);
```

Immer noch ein Roundtrip, aber der Batching-Vorteil ist weg. Halten Sie bei einem Massenimport Inserts mit explizitem Schlüssel in einem eigenen `SaveChanges`-Aufruf. Wenn es ausschließlich um Durchsatz geht, lohnt vorher ein Blick auf die Zahlen in [EF Core 11 vs Dapper für Bulk Inserts](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Die bigint-Sequenz an einer int-Spalte

Das ist die scharfe Kante. `UseSequence` benennt bereitwillig eine Sequenz, die Sie nie deklariert haben, und EF legt sie für Sie mit dem SQL Server-Standardtyp an, und der ist `bigint`:

```csharp
// no HasSequence call anywhere in the model
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Docs] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [OrderNumbers]),
    ...
);
```

Kein `AS int`. Die [CREATE SEQUENCE-Dokumentation](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) ist eindeutig: "If no data type is provided, the bigint data type is used as the default." Eine `bigint`-Sequenz an einer `int`-Spalte funktioniert für die ersten 2.147.483.647 Werte einwandfrei und reicht der Spalte danach Zahlen, die sie nicht speichern kann. Für die meisten Tabellen ist das weit weg, in der Zwischenzeit aber eine stille Fehlkonfiguration, die in keinem Test auffällt.

Deklarieren Sie die Sequenz mit dem gewünschten Typ, dann verschwindet die Diskrepanz:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;
```

Faustregel: Lassen Sie `UseSequence` die Sequenz niemals implizit anlegen. Kombinieren Sie es immer mit einem `HasSequence<T>`, das dieselbe Sequenz benennt.

## Benennung, und eine falsche Zeile in der Dokumentation

Rufen Sie `UseSequence()` ohne Argumente auf, benennt EF die Sequenz für Sie:

```csharp
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence] ...
```

Die XML-Dokumentation zum Parameter `nameSuffix` sagt, es sei "the name that will suffix the table name". Ist es nicht. Benennen Sie die Tabelle um, bleibt der Sequenzname stehen:

```csharp
modelBuilder.Entity<Doc>().ToTable("ArchivedDocuments");
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence]
// -> CREATE TABLE [ArchivedDocuments] ([Id] int NOT NULL DEFAULT (NEXT VALUE FOR [DocSequence]), ...)
```

Der Name kommt vom Kurznamen des CLR-Entitätstyps plus dem Suffix, das standardmäßig `"Sequence"` lautet. Benennen Sie die Klasse um, ändert sich Ihr Sequenzname unter der Hand, und genau das erzeugt in einer Migration ein überraschendes Paar aus `DropSequence` und `CreateSequence`. Benennen Sie Ihre Sequenzen explizit.

Es gibt auch einen modellweiten Schalter, der jedem Schlüssel eine eigene Sequenz gibt:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.UseKeySequences();
// -> CREATE SEQUENCE [DocSequence] ...
// -> CREATE SEQUENCE [NoteSequence] ...
// -> [Docs].[Id]  int    DEFAULT (NEXT VALUE FOR [DocSequence])
// -> [Notes].[Id] bigint DEFAULT (NEXT VALUE FOR [NoteSequence])
```

Dieselbe `bigint`-Einschränkung gilt für jede Sequenz, die dabei entsteht.

## UseSequence vs HasDefaultValueSql

Die [EF Core-Dokumentation zu Sequenzen](https://learn.microsoft.com/en-us/ef/core/modeling/sequences) zeigt den älteren Ansatz, den Standardausdruck von Hand zu schreiben:

```csharp
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>()
    .Property(d => d.Id)
    .HasDefaultValueSql("NEXT VALUE FOR OrderNumbers");
```

Das Insert-SQL ist Byte für Byte identisch mit `UseSequence`. Die Unterschiede liegen im Modell:

| | `UseSequence` | `HasDefaultValueSql` |
| --- | --- | --- |
| `ValueGenerated` | `OnAdd` | `OnAdd` |
| Strategie | `Sequence` | `None` |
| Standard-SQL | von EF erzeugt, mit Trennzeichen | Ihres, wörtlich ausgegeben |
| Sequenz umbenennen | einen `HasSequence`-Aufruf anpassen | zusätzlich die Zeichenkette anpassen, an jeder Stelle |

Die Zeile "wörtlich ausgegeben" ist entscheidend. Ihre Zeichenkette landet exakt so im DDL, wie Sie sie getippt haben, ohne Trennzeichen:

```sql
[Id] int NOT NULL DEFAULT (NEXT VALUE FOR OrderNumbers)
```

Das bricht in dem Moment, in dem die Sequenz in einem Schema mit einem Namen liegt, der Trennzeichen braucht, oder jemand ein Leerzeichen einfügt. `UseSequence` erzeugt `NEXT VALUE FOR [shared].[DocumentNumbers]` mit bereits gesetzten Klammern. Bevorzugen Sie `UseSequence` für Schlüssel. Behalten Sie `HasDefaultValueSql` für Spalten, die keine Schlüssel sind, denn die unterstützt `UseSequence` nicht.

## Spalten ohne Schlüsselrolle: Bestell- und Rechnungsnummern

Eine häufige Variante ist ein `IDENTITY`-Surrogatschlüssel plus eine für Menschen gedachte Nummer aus einer Sequenz. `HasDefaultValueSql` ist hier das richtige Werkzeug:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("TicketNumbers").StartsAt(500).IncrementsBy(10);

modelBuilder.Entity<Ticket>()
    .Property(t => t.TicketNumber)
    .HasDefaultValueSql("NEXT VALUE FOR TicketNumbers");
```

EF nimmt die Spalte in die `OUTPUT`-Liste auf, wenn Sie sie nicht setzen, und verschiebt sie in die Spaltenliste, sobald Sie sie setzen:

```sql
-- new Ticket { Name = "t1" }
INSERT INTO [Tickets] ([Name])
OUTPUT INSERTED.[Id], INSERTED.[TicketNumber]
VALUES (@p0);

-- new Ticket { Name = "t2", TicketNumber = 42 }
INSERT INTO [Tickets] ([Name], [TicketNumber])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1);
```

Dieselbe CLR-Standardwertregel: `TicketNumber = 0` gilt als nicht gesetzt.

## Lücken sind garantiert, planen Sie sie ein

Wenn irgendein Teil Ihres Systems den Schlüssel als lückenlosen Zähler behandelt, bricht eine Sequenz das, und `IDENTITY` täte es genauso. Die [CREATE SEQUENCE-Dokumentation](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) sagt es unmissverständlich: "Sequence numbers are generated outside the scope of the current transaction. They're consumed whether the transaction using the sequence number is committed or rolled back."

Es gibt eine zweite Lückenquelle. Sequenzen laufen standardmäßig mit `CACHE`, und SQL Server reserviert einen Block von Werten im Speicher vor und persistiert nur die Blockgrenze. Laut derselben Dokumentation gilt: "an unexpected shutdown (such as a power failure) might result in the loss of sequence numbers remaining in the cache." Ein Absturz kann also einen ganzen Cache-Block verbrennen.

`NO CACHE` verkleinert das Fenster, um den Preis eines Schreibvorgangs in die Systemtabelle pro Wert, und selbst dann merkt die Dokumentation an: "gaps can still occur if numbers are requested using the NEXT VALUE FOR or sp_sequence_get_range functions, but then the numbers are either not used or are used in uncommitted transactions."

EFs Fluent API kann das nicht ausdrücken. `SequenceBuilder` bietet `StartsAt`, `IncrementsBy`, `HasMin`, `HasMax` und `IsCyclic`, und sonst nichts. Greifen Sie in der Migration zu rohem SQL:

```csharp
// .NET 11, EF Core 11
migrationBuilder.Sql("ALTER SEQUENCE [shared].[DocumentNumbers] NO CACHE;");
```

Tun Sie das nur dort, wo eine Aufsichtsbehörde es verlangt, nicht standardmäßig. Wenn Sie eine wirklich lückenlose gesetzliche Belegnummer brauchen, erzeugen Sie sie in einer eigenen transaktionalen Tabelle, nicht aus einer Sequenz.

## UseSequence vs UseHiLo

`UseHiLo` ist die andere sequenzgestützte Strategie und verhält sich völlig anders:

```csharp
modelBuilder.Entity<HiLoOrder>().Property(h => h.Id).UseHiLo("HiLoOrderSequence");
// -> CREATE SEQUENCE [HiLoOrderSequence] START WITH 1 INCREMENT BY 10 NO CYCLE;
// -> [HiLoOrders].[Id] int NOT NULL   (no default constraint)
```

Die Spalte bekommt keinen Standardwert. EF ruft die Sequenz einmal auf, um einen Block von zehn zu reservieren, und vergibt die Schlüssel daraus anschließend auf dem Client. Damit sind die Schlüssel schon vor dem Insert bekannt (nützlich, wenn Sie im Speicher einen Objektgraphen aufbauen), zum Preis eines separaten Roundtrips bei jedem aufgebrauchten Block und deutlich größerer Lücken, sobald ein `DbContext` mitten im Block verworfen wird. `UseSequence` belässt die Erzeugung auf dem Server, `UseHiLo` verlagert sie auf den Client. Wählen Sie `UseSequence`, sofern Sie den Schlüssel nicht ausdrücklich schon vor `SaveChanges` in der Hand brauchen.

## Eine bestehende IDENTITY-Tabelle umstellen

`ALTER TABLE ... ALTER COLUMN` kann die `IDENTITY`-Eigenschaft weder hinzufügen noch entfernen. Die [dokumentierte Einschränkung](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) erlaubt nur, den Typ einer bestehenden Identity-Spalte zu ändern, und zwar in einen Typ, der die Identity-Eigenschaft unterstützt. Es gibt also keine Migration an Ort und Stelle; die Spalte muss ersetzt werden. Schritte:

1. Lesen Sie den aktuellen Höchststand mit `SELECT ISNULL(MAX(Id), 0) FROM dbo.Orders` und addieren Sie einen Sicherheitspuffer für Zeilen, die zwischen Lesen und Umstellung eingefügt werden.
2. Ergänzen Sie `modelBuilder.HasSequence<int>("DocumentNumbers", "shared").StartsAt(<high-water mark + margin>)` sowie `UseSequence("DocumentNumbers", "shared")` auf dem Schlüssel und erzeugen Sie dann eine Migration.
3. Ersetzen Sie den erzeugten Rumpf durch SQL, das die Sequenz anlegt, eine neue Tabelle aufbaut, deren `Id` den Sequenz-Standardwert trägt, die Zeilen mit `INSERT INTO ... SELECT` überträgt, die alte Tabelle löscht und die neue umbenennt. Fremdschlüssel, die auf die Tabelle zeigen, müssen rund um den Tausch gelöscht und neu angelegt werden.
4. Führen Sie die Migration innerhalb einer Transaktion aus und prüfen Sie danach, dass `SELECT current_value FROM sys.sequences WHERE name = 'DocumentNumbers'` über dem größten vorhandenen Schlüssel liegt.

Zwei Details lohnen sich zu wissen. `HasData`-Seeding passt nicht in dieses Modell, weil EF literale Schlüsselwerte in den Seed-Daten verlangt und einen speichergenerierten Schlüssel nicht implizit seeden lässt. Genau daraus entsteht [die Seed-Entität kann nicht hinzugefügt werden, weil ein Wert ungleich null erforderlich ist](/de/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/); mit einer Sequenz können Sie die Schlüssel einfach mitgeben, da explizite Werte zulässig sind. Und wenn Sie für den Tabellentausch ohnehin handgeschriebenes Migrations-SQL verfassen, gilt dieselbe Sorgfalt wie beim [Umbenennen einer Tabelle in einer EF Core 11-Migration ohne Datenverlust](/de/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/): erzeugte Ausgabe für strukturelle Änderungen ist ein Ausgangspunkt, nicht die Antwort.

Eine letzte Prüfung nach all dem: Führen Sie `dotnet ef migrations add` erneut aus und stellen Sie sicher, dass eine leere Migration entsteht. Eine Sequenz, deren Modelltyp nicht zu ihrem Datenbanktyp passt, oder eine implizit benannte Sequenz, die beim Umbenennen einer Klasse mitgewandert ist, taucht bei jedem Lauf als Geister-`DropSequence` plus `CreateSequence` auf. `rowversion`-Spalten erzeugen aus demselben Grund dieselbe Art von Geisterdifferenz, und die Schritt-für-Schritt-Anleitung in [optimistische Nebenläufigkeit mit einem rowversion-Token in EF Core 11](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) zeigt, wie man dabei die Annotationen statt des DDL liest.

## Quellen

- [Sequenzen, EF Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/sequences)
- [Werterzeugung unter SQL Server, EF Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/value-generation)
- [CREATE SEQUENCE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql)
- [ALTER TABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql)
- [Neues in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Quellcode von `SqlServerPropertyBuilderExtensions.UseSequence`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerPropertyBuilderExtensions.cs)
- [Quellcode von `SqlServerModelBuilderExtensions.UseKeySequences`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerModelBuilderExtensions.cs)
