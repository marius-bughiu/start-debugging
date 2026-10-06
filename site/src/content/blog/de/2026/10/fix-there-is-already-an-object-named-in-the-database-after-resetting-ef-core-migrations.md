---
title: "Lösung: There is already an object named 'X' in the database nach dem Zurücksetzen der EF Core Migrationen"
description: "Nachdem der Migrations-Ordner gelöscht und ein neues InitialCreate erzeugt wurde, weiß EF Core nicht, dass Ihre Tabellen existieren. Löschen Sie eine Entwicklungsdatenbank oder tragen Sie die neue Migration in __EFMigrationsHistory ein, ohne sie auszuführen."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "dotnet"
lang: "de"
translationOf: "2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-10-06
---

Sie haben den Ordner `Migrations` gelöscht, `dotnet ef migrations add InitialCreate` ausgeführt, und jetzt schlägt `dotnet ef database update` mit `There is already an object named 'Blogs' in the database` fehl. EF Core entscheidet, was ausgeführt wird, indem es die Migrations-IDs in Ihrer Assembly mit den Zeilen in `__EFMigrationsHistory` vergleicht. Ihr neues `InitialCreate` hat einen neuen Zeitstempel, also behandelt EF Core es als ausstehend und versucht `CREATE TABLE` auf Tabellen, die bereits existieren. Ist die Datenbank wegwerfbar, löschen Sie sie (`dotnet ef database drop --force`) und aktualisieren Sie erneut. Enthält sie Daten, löschen Sie die alten Historienzeilen und fügen Sie eine Zeile für die neue Migrations-ID ein, damit EF Core sie als angewendet verbucht, ohne sie auszuführen. Alles Folgende wurde mit EF Core 10.0.12 und `dotnet-ef` 10.0.12 auf .NET 10 (SDK 10.0.302) gemessen, und die Logik ist in EF Core 11.0.0-rc.1 unverändert.

## Der Fehler im Kontext

Auf SQL Server ist das Engine-Fehler 2714, der als `SqlException` aus `dotnet ef database update` oder aus `Database.Migrate()` beim Start auftaucht. Für diesen Artikel stand keine SQL-Server-Instanz zur Verfügung, daher ist der folgende Block der SQLite-Lauf, in dem DDL und Engine-Meldung durch die von SQL Server ersetzt wurden:

```text
Applying migration '20261006110224_InitialCreate'.
Failed executing DbCommand (12ms) [Parameters=[], CommandType='Text', CommandTimeout='30']
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
Microsoft.Data.SqlClient.SqlException (0x80131904): There is already an object named 'Blogs' in the database.
```

Dieselbe Ursache zeigt sich bei anderen Providern mit anderem Text. Die SQLite-Zeile stammt aus der Reproduktion für diesen Artikel; die Zeilen für PostgreSQL und MySQL sind die Engine-Fehler für dieselbe `CREATE TABLE`-Anweisung:

```text
SQLite:      SQLite Error 1: 'table "Blogs" already exists'.
PostgreSQL:  42P07: relation "Blogs" already exists
MySQL:       Table 'Blogs' already exists        (error 1050)
SQL Server:  There is already an object named 'Blogs' in the database.   (error 2714)
```

Die entscheidende Zeile ist die erste: `Applying migration '..._InitialCreate'`. Wenn EF Core Ihre initiale Migration auf eine Datenbank anwendet, die Ihr Schema bereits enthält, sind Sie hier richtig.

## Warum EF Core Tabellen anlegen will, die schon existieren

EF Core untersucht Ihr Schema nicht, um zu entscheiden, welche Migrationen laufen. Es führt eine einzige Abfrage aus, `SELECT MigrationId FROM __EFMigrationsHistory`, und vergleicht das Ergebnis mit den Migrationen, die in Ihre Assembly kompiliert sind. Jede Migration, deren ID nicht in der Tabelle steht, ist ausstehend, und ausstehende Migrationen führen ihre `Up()`-Methode vollständig aus.

Eine Migrations-ID ist das Präfix des Dateinamens: ein UTC-Zeitstempel plus der Name, den Sie eingegeben haben, zum Beispiel `20261006110224_InitialCreate`. Beim Zurücksetzen der Migrationen bekommt das neue `InitialCreate` einen frischen Zeitstempel. Die alten Zeilen (`20261006110219_InitialCreate`, `20261006110221_AddPublished`) stehen weiterhin in der Historientabelle, aber EF Core ignoriert stillschweigend Zeilen, die zu keiner Migration in der Assembly passen. Es warnt nicht davor. Aus Sicht von EF Core hat die Datenbank Ihre neue Migration also nie gesehen, und das erste `CreateTable` trifft auf eine Tabelle, die schon da ist.

Dieselbe Diskrepanz entsteht in einigen Situationen, die kein bewusstes Zurücksetzen sind:

1. **Die Datenbank wurde mit `EnsureCreated()` angelegt**. `EnsureCreated()` baut das Schema direkt aus dem Modell und legt `__EFMigrationsHistory` nie an. Das erste `Migrate()` erzeugt eine leere Historientabelle, hält jede Migration für ausstehend und scheitert an der ersten Tabelle.
2. **Die Datenbank kam von woanders**: ein wiederhergestelltes Backup einer anderen Anwendung, ein DB-first-Schema, ein von einem DBA ausgeführtes Skript. Gleiches Bild: Tabellen existieren, Historie nicht.
3. **Die Historientabelle ist umgezogen**. `MigrationsHistoryTable("__MyHistory", "app")` wurde nach der Bereitstellung hinzugefügt oder geändert, oder auf SQL Server verbindet sich ein anderer Login, dessen Standardschema nicht `dbo` ist. EF Core sucht am neuen Ort, findet nichts und beginnt bei null.
4. **Zwei Migrationen legen dieselbe Tabelle an**. Zwei Branches haben je eine Migration hinzugefügt, die `AuditLog` erzeugt, und beide wurden gemergt. Die erste läuft durch, die zweite wirft 2714.

## Minimale Reproduktion mit EF Core 10

Das ist exakt die Abfolge, die ich ausgeführt habe, mit SQLite, damit sie auf jeder Maschine reproduzierbar ist:

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Post { public int Id { get; set; } public string Title { get; set; } = ""; public int BlogId { get; set; } }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=app.db");
}
```

```bash
# dotnet-ef 10.0.12
dotnet ef migrations add InitialCreate
# add a DateTime Published property to Post
dotnet ef migrations add AddPublished
dotnet ef database update            # applies both, history has 2 rows

rm -rf Migrations                    # the "reset"
dotnet ef migrations add InitialCreate
dotnet ef database update            # SQLite Error 1: 'table "Blogs" already exists'.
```

Nach dem Fehlschlag zeigt `dotnet ef migrations list` genau, was EF Core glaubt:

```text
20261006110224_InitialCreate (Pending)
```

Die beiden alten Zeilen stehen weiterhin in der Historientabelle. EF Core 10 kapselt außerdem jede Migration in einer eigenen Transaktion, sodass das fehlgeschlagene `InitialCreate` auf SQLite und SQL Server sauber zurückgerollt wird und nichts halb angewendet zurückbleibt. MySQL ist die Ausnahme, weil DDL dort implizit committet.

## Lösung 1: Datenbank löschen, wenn die Daten egal sind

Bei einer lokalen Entwicklungsdatenbank ist das Zurücksetzen, das Sie eigentlich wollten, "Migrationen und Datenbank fangen gemeinsam neu an". Die [offizielle Dokumentation](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations) beschreibt genau das: den Ordner `Migrations` löschen und die Datenbank verwerfen.

```bash
# dotnet-ef 10.0.12
dotnet ef database drop --force
dotnet ef database update
```

Das ist die richtige Antwort für eine Datenbank auf dem Laptop oder einen Wegwerf-Container. Auf geteilten Systemen ist es tabu: Es löscht die Datenbank samt Daten.

## Lösung 2: Die neue Baseline eintragen, ohne sie auszuführen

Enthält die Datenbank Daten, die Ihnen wichtig sind, wollen Sie das Gegenteil: das Schema behalten und EF Core mitteilen, dass das neue `InitialCreate` bereits angewendet ist. Die Dokumentation nennt das Zusammenfassen (Squashing) von Migrationen. EF Core hat dafür keinen eingebauten Befehl (die Anfrage ist seit Jahren als [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174) offen), also ist es eine manuelle Änderung der Historientabelle.

1. Sichern Sie die Datenbank.
2. Stellen Sie sicher, dass die Datenbank vor dem Zurücksetzen auf der **letzten alten Migration** steht. Hängt sie hinterher, wenden Sie zuerst die fehlenden alten Migrationen mit dem alten Code aus der Versionsverwaltung an. Eine Baseline funktioniert nur, wenn das neue `InitialCreate` das Schema beschreibt, das tatsächlich vorhanden ist.
3. Löschen Sie den Ordner `Migrations` und führen Sie `dotnet ef migrations add InitialCreate` aus.
4. Führen Sie `dotnet ef migrations script 0 InitialCreate` aus und kopieren Sie die `INSERT INTO [__EFMigrationsHistory]`-Anweisung vom Ende der Ausgabe. Sie enthält die exakte Migrations-ID und Produktversion.
5. Ersetzen Sie die alten Historienzeilen durch diese eine Zeile.

Auf SQL Server sieht Schritt 5 so aus:

```sql
-- SQL Server, EF Core 10.0.12 history table
BEGIN TRANSACTION;

DELETE FROM [__EFMigrationsHistory];

INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
VALUES (N'20261006110224_InitialCreate', N'10.0.12');

COMMIT;
```

Danach prüfen Sie, ob EF Core zustimmt:

```bash
# dotnet-ef 10.0.12
dotnet ef migrations list                      # 20261006110224_InitialCreate, no "(Pending)"
dotnet ef migrations has-pending-model-changes # "No changes have been made to the model since the last migration."
```

In meiner Reproduktion habe ich nach der Baseline eine Eigenschaft `Url` zu `Blog` hinzugefügt, `AddBlogUrl` erzeugt, und `dotnet ef database update` hat nur diese Migration angewendet. Genau dieser Zustand ist das Ziel: Die Historie hat eine Baseline-Zeile, und neue Migrationen laufen normal darauf auf.

Das Löschen der alten Zeilen ist nicht zwingend nötig, weil EF Core unbekannte Zeilen ignoriert. Löschen Sie sie trotzdem. Checkt später jemand einen alten Commit aus und führt `database update` gegen diese Datenbank aus, lassen veraltete Zeilen EF Core glauben, alte Migrationen seien angewendet, und dieser Fehler ist mühsam zu debuggen.

## Baseline für mehr als eine Umgebung

Ein Squash ist auf einer Datenbank einfach und auf fünf fehleranfällig. Jede bestehende Umgebung braucht den Zeilentausch, und jede neue Umgebung braucht das vollständige `InitialCreate`. Am sichersten erreicht man beides mit einer Prüfung, die die Historie nur dann umschreibt, wenn sie die alte Kette findet, und sonst nichts tut.

Als SQL-Skript, das Sie einmal pro Umgebung vor der Bereitstellung des zusammengefassten Codes ausführen:

```sql
-- SQL Server, run before deploying the squashed migrations
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
           WHERE [MigrationId] = N'20261006110221_AddPublished')
   AND NOT EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
                   WHERE [MigrationId] = N'20261006110224_InitialCreate')
BEGIN
    DELETE FROM [__EFMigrationsHistory];
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261006110224_InitialCreate', N'10.0.12');
END;

COMMIT;
```

Die Prüfung bezieht sich auf die **letzte** alte Migration, nicht auf die erste. Eine Datenbank, die `AddPublished` nie erreicht hat, besitzt nicht das Schema, das Ihr neues `InitialCreate` beschreibt, und sollte daher keine Baseline bekommen. Sie muss zuerst mit dem alten Code auf Stand gebracht werden.

Wenden Sie Migrationen beim Start aus der Anwendung an, passt dieselbe Prüfung vor `Migrate()`. Ich habe das gegen drei Datenbanken getestet: eine im alten Zustand `AddPublished`, dieselbe Datenbank in einem zweiten Lauf und eine brandneue leere Datei. Alle drei endeten mit angewendeten `InitialCreate, AddBlogUrl` und korrektem Schema.

```csharp
// .NET 10, EF Core 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();
BaselineSquashedMigrations(db);
db.Database.Migrate();

static void BaselineSquashedMigrations(AppDb db)
{
    const string lastOldMigration = "20261006110221_AddPublished";
    const string newBaseline = "20261006110224_InitialCreate";

    // Returns every row in __EFMigrationsHistory, including IDs that no longer exist in the assembly.
    // Returns an empty list when the history table does not exist yet (fresh database).
    var applied = db.Database.GetAppliedMigrations().ToHashSet();
    if (!applied.Contains(lastOldMigration) || applied.Contains(newBaseline))
        return;

    using var tx = db.Database.BeginTransaction();
    db.Database.ExecuteSql($"DELETE FROM __EFMigrationsHistory");
    db.Database.ExecuteSql(
        $"INSERT INTO __EFMigrationsHistory (MigrationId, ProductVersion) VALUES ({newBaseline}, {"10.0.12"})");
    tx.Commit();
}
```

Der Tabellenname steht hier ohne Anführungszeichen, damit derselbe Code auf SQL Server und SQLite funktioniert. Auf PostgreSQL muss er als `"__EFMigrationsHistory"` zitiert werden, weil der Bezeichner dort Groß- und Kleinschreibung unterscheidet. Führen Sie das in einem einzigen Migrationsschritt aus (ein Job, ein Init-Container oder eine Instanz), nicht in jedem Replikat. `Migrate()` nimmt seit EF Core 9 einen Migrations-Lock, aber dieser Helper läuft, bevor der Lock erworben wird. Stellen Sie mit Bundles bereit, führen Sie die SQL-Variante vor dem Bundle aus, wie im Artikel zum [Anwenden von EF Core Migrationen in Produktion mit Migration Bundles](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) beschrieben. Entfernen Sie den Helper, sobald jede Umgebung ihre Baseline hat.

## Der Trick mit dem leeren Up(), und warum ich ihn meide

Eine verbreitete Stack-Overflow-Antwort lautet: den Rumpf von `Up()` im neuen `InitialCreate` auskommentieren, `database update` ausführen, damit die Zeile eingetragen wird, und dann den Rumpf wiederherstellen. Das funktioniert für eine Datenbank auf einem Rechner. Es ist aber auch genau der Weg, auf dem eine kaputte Migration committet wird: Wer vergisst, den Rumpf wiederherzustellen, gibt jeder neuen Umgebung ein leeres Schema mit einer Historienzeile, die Vollständigkeit behauptet. Die SQL-Baseline bewirkt in der Datenbank dasselbe, ohne die Migrationsdatei anzufassen, also gibt es nichts zu vergessen.

## Fallstricke und ähnliche Fehler

**Eigener Code in alten Migrationen ist weg.** Jedes `migrationBuilder.Sql(...)`, das Sie für Views, Stored Procedures, Trigger oder Seed-Zeilen geschrieben haben, lebte in den gelöschten Dateien. Das neue `InitialCreate` enthält nur, was das Modell kennt. Kopieren Sie diese Blöcke von Hand in die neue Migration, sonst fehlen neuen Umgebungen Objekte, die es in Produktion gibt.

**Schema-Drift lässt die Baseline lügen.** Hat jemand direkt in Produktion einen Index oder eine Spalte hinzugefügt, enthält das neue `InitialCreate` diese nicht, und die Baseline verbucht ein Schema, das nicht übereinstimmt. Vergleichen Sie vor der Baseline die Ausgabe von `dotnet ef migrations script 0 InitialCreate` mit dem echten Schema (Schema Compare in SSMS, `pg_dump --schema-only` oder `sqlite3 .schema`).

**`EnsureCreated()` neben `Migrate()`.** Wenn Sie hier gelandet sind, weil die Datenbank mit `EnsureCreated()` angelegt wurde, entfernen Sie diesen Aufruf zuerst. Er legt die Historientabelle nie an, also können beide nicht nebeneinander existieren. Derselbe Rat steht im Artikel zu [`CREATE DATABASE permission denied` bei `dotnet ef database update`](/de/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), einem weiteren Symptom dieser Mischung.

**Der Start wirft zuerst einen anderen Fehler.** Seit EF Core 9 verweigert `Migrate()` die Ausführung, wenn das Modell Änderungen enthält, die in keiner Migration erfasst sind. Sehen Sie stattdessen `The model for context has pending changes`, beheben Sie das zuerst, wie im [Artikel zu ausstehenden Modelländerungen](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) beschrieben, und kommen Sie dann zurück.

**Halb angewendete Migration nach einem Timeout.** Taucht 2714 bei einer Migration auf, die nicht die initiale ist, kann eine auf halbem Weg abgebrochene Migration die Ursache sein. Dieser Fall wird in [SqlException-Timeouts bei EF Core Migrationen beheben](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) behandelt, einschließlich der Reparatur der Historienzeile.

**`--idempotent`-Skripte retten Sie nicht.** `dotnet ef migrations script --idempotent` kapselt jede Migration in `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'...')`. Geprüft wird die Migrations-ID, nicht die Tabelle, also führt eine neue `InitialCreate`-ID ihr `CREATE TABLE` trotzdem aus und scheitert genauso.

**`dotnet ef migrations add` scheitert schon vorher.** Kann das Tool Ihren Kontext beim Zurücksetzen nicht erzeugen, ist das ein Problem der Design-Time-Konfiguration, behandelt in [Lösung für "Unable to create an object of type DbContext"](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Verwandte Artikel

- [EF Core 11 Migrationen in Produktion mit dotnet ef migrations bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Lösung: The model for context has pending changes in EF Core 11](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Lösung: SqlException: Timeout expired bei EF Core Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Lösung: CREATE DATABASE permission denied in database 'master'](/de/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Lösung: dotnet ef migrations add "Unable to create an object of type DbContext"](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)

## Quellen

- [Managing Migrations: Resetting all migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying), Microsoft Learn.
- [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174), die offene Feature-Anfrage zum Zusammenfassen von Migrationen.
- [`HistoryRepository.cs` im Branch release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Relational/Migrations/HistoryRepository.cs), der die Standardwerte für Name und Schema der Historientabelle zeigt.
