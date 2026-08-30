---
title: "Fix: CREATE DATABASE permission denied in database 'master' beim Ausführen von dotnet ef database update"
description: "Migrate() von EF Core prüft immer, ob die Datenbank existiert, und legt sie andernfalls über eine fest im Code verdrahtete master-Verbindung an. Vergeben Sie CREATE ANY DATABASE, reparieren Sie den Zugriff des Logins auf die vorhandene Datenbank, oder liefern Sie ein idempotentes SQL-Skript."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
lang: "de"
translationOf: "2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update"
translatedBy: "claude"
translationDate: 2026-08-30
---

`dotnet ef database update` versucht nicht deshalb, Ihre Datenbank anzulegen, weil Sie darum gebeten hätten. Jeder Aufruf von `Migrate()` beginnt mit `if (!_databaseCreator.Exists()) _databaseCreator.Create()`, und es gibt keinen Schalter, um das abzustellen. Entweder kann Ihr Login also tatsächlich keine Datenbanken anlegen (vergeben Sie `CREATE ANY DATABASE` in `master`, oder nehmen Sie es in `##MS_DatabaseManager##` auf), oder die Datenbank existiert bereits und das Login kann sie nicht öffnen, was EF Core fälschlich als "existiert nicht" liest. Prüfen Sie den zweiten Fall zuerst: `SELECT DB_ID('YourDb')` als `sa`, danach `SELECT DB_ID('YourDb')` als Migrations-Login. Liefert das erste eine Zahl und das zweite `NULL`, ist die Lösung ein Datenbankbenutzer und keine Serverberechtigung. In der Produktion führen Sie `Migrate()` gar nicht erst mit einem privilegierten Login aus, sondern geben einem DBA die Ausgabe von `dotnet ef migrations script --idempotent`, die überhaupt kein `CREATE DATABASE` enthält.

Alles Folgende wurde mit `Microsoft.EntityFrameworkCore.SqlServer` 10.0.11 und der `dotnet-ef` CLI 10.0.11 auf dem .NET SDK 10.0.302 verifiziert. Die hier zitierten Codepfade `Migrator.Migrate` und `SqlServerDatabaseCreator` sind über EF Core 8, 9, 10 und 11 unverändert, das Verhalten und jede Lösung gelten also für alle vier Versionen. Wenn eine Aussage aus der SQL Server Dokumentation stammt und nicht aus einem Lauf auf dieser Maschine, sage ich das.

## Der Fehler im Kontext

```text
Build started...
Build succeeded.
Microsoft.Data.SqlClient.SqlException (0x80131904): CREATE DATABASE permission denied in database 'master'.
   at Microsoft.Data.SqlClient.SqlConnection.OnError(SqlException exception, Boolean breakConnection, Action`1 wrapCloseInAction)
   ...
   at Microsoft.EntityFrameworkCore.Migrations.Internal.MigrationCommandExecutor.ExecuteNonQuery(...)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerDatabaseCreator.Create()
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
ClientConnectionId:...
Error Number:262,State:1,Class:14
CREATE DATABASE permission denied in database 'master'.
```

Dieser Trace ist aus der unten gezeigten EF Core Aufrufkette zusammengesetzt und nicht auf dieser Maschine aufgezeichnet, die keine SQL Server Instanz hat; die Frame-Namen und die Fehlernummern stammen aus dem ausgelieferten Quellcode und aus den dokumentierten Fehlern von SQL Server. Zwei Frames sind wichtig. `SqlServerDatabaseCreator.Create()` verrät, dass EF die Datenbank für fehlend hielt. `Error Number:262` ist der Berechtigungsfehler von SQL Server, kein Verbindungsfehler, das Login hat sich also sauber authentifiziert und kam bis zur Ausführung einer Anweisung.

## Warum dotnet ef database update überhaupt master anfasst

Weder Ihre `Program.cs` noch Ihre Verbindungszeichenfolge erwähnt `master`. Das setzt EF. Der relevante Code ist das Erste, was `Migrate()` tut, in [`Migrator.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs):

```csharp
// Microsoft.EntityFrameworkCore.Relational 10.0.11, Migrator.Migrate
if (!_databaseCreator.Exists())
{
    _databaseCreator.Create();
}
```

Es gibt keine Option, kein `DbContextOptionsBuilder` Flag und keine Umgebungsvariable, die das überspringt. `dotnet ef database update` läuft genau durch diese Methode, ebenso `context.Database.Migrate()` beim Anwendungsstart und ein Migrations-Bundle aus `dotnet ef migrations bundle`.

`Create()` baut sich dann seine eigene Verbindung. Aus [`SqlServerConnection.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs):

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
public virtual ISqlServerConnection CreateMasterConnection()
{
    var connectionStringBuilder = new SqlConnectionStringBuilder(GetValidatedConnectionString())
        { InitialCatalog = "master" };
    connectionStringBuilder.Remove("AttachDBFilename");
    ...
}
```

`InitialCatalog = "master"` ist fest verdrahtet. Daher stammt das `in database 'master'` in der Meldung. Auf dieser Verbindung führt EF das T-SQL aus, das sein eigener Generator für eine `SqlServerCreateDatabaseOperation` erzeugt:

```sql
-- what EF Core 10.0.11 sends on the master connection
CREATE DATABASE [Shop];
GO
IF SERVERPROPERTY('EngineEdition') <> 5
BEGIN
    ALTER DATABASE [Shop] SET READ_COMMITTED_SNAPSHOT ON;
END;
```

Dass Sie einen *Berechtigungsfehler* und keinen *Login-Fehler* sehen, liegt daran, dass jedes SQL Server Login `master` öffnen darf. Die `CONNECT` Berechtigung des `guest` Benutzers lässt sich "in jeder Datenbank außer `master` oder `tempdb`" entziehen, so die [Dokumentation zu Prinzipalen](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine). EF verbindet sich also erfolgreich und scheitert erst an der Anweisung.

## Die Existenzprüfung ist lockerer als gedacht

Hier ist der Teil, der die meisten auf die falsche Fährte schickt. `SqlServerDatabaseCreator.Exists()` fragt nicht `sys.databases` ab. Es öffnet eine Verbindung zur Zieldatenbank und führt `SELECT 1` aus, und wertet drei `SqlException` Nummern als Beweis dafür, dass die Datenbank fehlt:

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
private static bool IsDoesNotExist(SqlException exception)
    => exception.Number is 4060 or 1832 or 5120;
```

Fehler 4060 lautet `Cannot open database "Shop" requested by the login. The login failed.` SQL Server löst ihn sowohl aus, wenn die Datenbank fehlt, **als auch**, wenn das Login in einer vorhandenen Datenbank keinen zugeordneten Benutzer hat, oder wenn die Datenbank offline ist, wiederhergestellt wird oder im `SINGLE_USER` Modus läuft. EF kann das nicht auseinanderhalten, schließt auf eine fehlende Datenbank und macht sich ans Anlegen. Sie bekommen dann Fehler 262 zu `master`, obwohl das eigentliche Problem ein fehlendes `CREATE USER` in `Shop` ist.

Unterscheiden Sie die beiden Fälle, bevor Sie irgendeine Berechtigung anfassen. Verbinden Sie sich als Administrator und führen Sie aus:

```sql
-- as sa or a sysadmin
SELECT DB_ID('Shop') AS db_id, state_desc, user_access_desc
FROM sys.databases WHERE name = 'Shop';
```

Verbinden Sie sich danach mit exakt den Anmeldedaten aus der Migrations-Verbindungszeichenfolge und führen Sie aus:

```sql
-- as the migration login
SELECT DB_ID('Shop') AS visible_to_me;
```

Eine Zeile aus der ersten Abfrage plus `NULL` aus der zweiten bedeutet: die Datenbank existiert und Ihr Login sieht sie nicht. Das ist der nächste Abschnitt. Nichts aus der ersten Abfrage bedeutet, dass sie wirklich fehlt, das ist der übernächste.

## Lösung 1: die Datenbank existiert, das Login kann sie nicht öffnen

Das ist die übliche Form in CI und in frisch wiederhergestellten Umgebungen: jemand hat ein `.bak` zurückgespielt oder die Datenbank per Skript angelegt, und das Login auf Serverebene existiert, hat aber keinen passenden Datenbankbenutzer, oder einen nach der Wiederherstellung per SID verwaisten.

```sql
-- SQL Server 2019+ / Azure SQL MI; run in the target database
USE [Shop];
GO
CREATE USER [app] FOR LOGIN [app];
ALTER ROLE db_ddladmin ADD MEMBER [app];   -- schema changes
ALTER ROLE db_datareader ADD MEMBER [app];
ALTER ROLE db_datawriter ADD MEMBER [app];
GO
```

Existiert der Benutzer bereits, ist aber nach einer Wiederherstellung verwaist, richten Sie ihn wieder auf das Login aus, statt ihn neu anzulegen:

```sql
USE [Shop];
GO
ALTER USER [app] WITH LOGIN = [app];
GO
```

`db_ddladmin` ist genau das, was Migrationen brauchen: `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` und die Tabelle `__EFMigrationsHistory`, die EF beim ersten Lauf anlegt. `db_owner` funktioniert ebenfalls und ist der Griff der meisten, geht aber über das hinaus, was Migrationen benötigen.

Zwei Varianten lösen 4060 aus Gründen aus, die ein Datenbankbenutzer nicht behebt. Ist `state_desc` nicht `ONLINE`, bringen Sie die Datenbank online. Ist `user_access_desc` gleich `SINGLE_USER`, führen Sie `ALTER DATABASE [Shop] SET MULTI_USER;` aus. In beiden Fällen versucht EF sonst weiter, eine Datenbank anzulegen, die längst da ist.

## Lösung 2: die Datenbank fehlt wirklich und EF soll sie anlegen

Das ist die richtige Lösung für eine Entwicklermaschine, einen Wegwerf-Container in CI oder jede Umgebung, in der das Migrations-Login seine Datenbank besitzen darf.

Die Variante mit den geringsten Rechten auf SQL Server 2022 (16.x) und neuer sowie auf Azure SQL Database ist die feste Serverrolle `##MS_DatabaseManager##`. Laut der [Dokumentation zu Serverrollen](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) können deren Mitglieder "create databases, and delete databases they own", und sie trägt die Serverberechtigungen `CREATE ANY DATABASE` und `ALTER ANY DATABASE`:

```sql
-- SQL Server 2022 (16.x)+ and Azure SQL Database
ALTER SERVER ROLE [##MS_DatabaseManager##] ADD MEMBER [app];
```

Auf SQL Server 2019 (15.x) und älter gibt es diese Rolle nicht, vergeben Sie dort die Serverberechtigung direkt. Diese Variante ist `dbcreator` vorzuziehen, denn Mitglieder von `dbcreator` können "create, alter, drop, and restore **any** database", auch solche, die Ihre Migration nichts angehen:

```sql
-- SQL Server 2016 (13.x) and later, including 2019 (15.x) where no role exists
USE master;
GO
GRANT CREATE ANY DATABASE TO [app];
GO
```

`CREATE DATABASE` und `CREATE ANY DATABASE` sind nicht austauschbar, und die Verwechslung ist ein häufiger zweiter Fehlschlag. `CREATE DATABASE` ist eine Berechtigung mit *Datenbankgültigkeitsbereich* in `master` und lässt sich nur an einen Datenbankbenutzer vergeben, das Login braucht also zuerst einen Benutzer in `master`:

```sql
-- the CREATE DATABASE variant needs a user in master
USE master;
GO
CREATE USER [app] FOR LOGIN [app];
GRANT CREATE DATABASE TO [app];
GO
```

`CREATE ANY DATABASE` hat Servergültigkeitsbereich und wird dem Login selbst erteilt, deshalb braucht es keinen Benutzer in `master`. Die [CREATE DATABASE Dokumentation](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) nennt `CREATE DATABASE`, `CREATE ANY DATABASE` oder `ALTER ANY DATABASE` als ausreichend.

In Azure SQL Database ist der ältere Weg die Datenbankrolle `dbmanager` in `master`, die die Dokumentation weiterhin als gültigen Prinzipal für `CREATE DATABASE` führt:

```sql
-- Azure SQL Database, connected to master
CREATE USER [app] FROM LOGIN [app];
ALTER ROLE dbmanager ADD MEMBER [app];
GO
```

In Azure ist hier Vorsicht geboten. EF sendet ein nacktes `CREATE DATABASE [Shop];` ohne `EDITION` und ohne `SERVICE_OBJECTIVE`, der Server wählt also die Standardstufe und beginnt, sie abzurechnen. Genau das ist die Beschwerde in [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251), "EF Core automatically creates expensive database when executing migrations", das das Team als nicht geplant geschlossen hat. Vergeben Sie Rechte zum Anlegen von Datenbanken nicht an ein Deployment-Login, das auf einen Azure SQL Server zeigt, es sei denn, ein Tippfehler in einem Datenbanknamen darf eine neue kostenpflichtige Datenbank bereitstellen.

## Lösung 3: den Erstellungsschritt ganz aus dem Deployment nehmen

Ist das Login bewusst unprivilegiert, hilft keine noch so großzügige Rechtevergabe. Führen Sie `Migrate()` in dieser Umgebung nicht aus und wenden Sie stattdessen SQL an. Das erzeugte Skript enthält nie ein `CREATE DATABASE`, weil der Skriptgenerator ausschließlich auf Migrationen arbeitet und `IRelationalDatabaseCreator` nie aufruft:

```bash
dotnet ef migrations script --idempotent --output migrate.sql
```

Auf EF Core 10.0.11 entsteht für eine einzelne Initialmigration genau das hier:

```sql
IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL
BEGIN
    CREATE TABLE [__EFMigrationsHistory] (
        [MigrationId] nvarchar(150) NOT NULL,
        [ProductVersion] nvarchar(32) NOT NULL,
        CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
    );
END;
GO

BEGIN TRANSACTION;
IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260830061302_InitialCreate'
)
BEGIN
    CREATE TABLE [Customers] (
        [Id] int NOT NULL IDENTITY,
        [Name] nvarchar(max) NOT NULL,
        CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
    );
END;
...
COMMIT;
GO
```

Kein einziger Verweis auf `master`. Das Flag `--idempotent` macht das Skript sicher gegen eine Datenbank auf jedem Migrationsstand, was Sie genau dann wollen, wenn ein DBA es von Hand anwendet. Das EF Team sagt das so in der [Dokumentation zum Anwenden von Migrationen](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying): `dotnet ef database update` "applies SQL commands directly by the tool, without giving the developer a chance to inspect or modify them", und die Dokumentation weist ausdrücklich darauf hin, dass ein `Migrate()` beim Start "requires elevated access to modify the database schema", was dem Prinzip der geringsten Rechte in der Produktion widerspricht.

Der Ablauf wird damit: Datenbank einmalig anlegen, von Hand oder über Terraform oder Bicep, dem Anwendungslogin darin `db_ddladmin` geben und `migrate.sql` in der Release-Pipeline anwenden. Das Anwendungslogin braucht nie auch nur eine Berechtigung in `master`.

## Migrations-Bundles helfen hier nicht

Ein verbreitetes Missverständnis lautet, `dotnet ef migrations bundle` umgehe das Problem, weil es eine eigenständige ausführbare Datei ohne SDK-Abhängigkeit ist. Tut es nicht. Das Bundle ruft `Migrate()` auf, durchläuft also dasselbe Paar aus `Exists()` und `Create()` und scheitert unter einem unprivilegierten Login am selben Fehler 262. Bundles lösen das Problem "kein SDK auf dem Deployment-Agent", nicht das Berechtigungsproblem. Verbietet Ihre Zielumgebung `CREATE DATABASE`, brauchen Bundles dieselbe Behandlung wie die CLI: erst die Datenbank existent machen und das Login in die Lage versetzen, sie zu öffnen. Die Mechanik dieser Pipeline steht in [EF Core 11 Migrationen in der Produktion mit dotnet ef migrations bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Varianten mit ähnlichem Fehlerbild

**`CREATE TABLE permission denied in database 'master'.`** Gleiche Fehlernummer, andere Anweisung. Hier fehlt in Ihrer Verbindungszeichenfolge `Database=` beziehungsweise `Initial Catalog=` vollständig, SQL Server landet also in der Standarddatenbank des Logins, und die ist bei `sa` `master`. EF legt nichts an, es führt Ihre Migration gegen `master` aus. Ergänzen Sie die Datenbank in der Verbindungszeichenfolge.

**`EnsureCreated()` statt Migrationen.** `Database.EnsureCreated()` löst denselben Fehler aus demselben Grund aus, und zwar schlimmer: es legt das Schema ohne Tabelle `__EFMigrationsHistory` an, sodass sich auf diese Datenbank danach nie Migrationen anwenden lassen. Finden Sie einen `EnsureCreated()` Aufruf in `Program.cs` neben einem Migrations-Ordner, löschen Sie ihn.

**LocalDB.** `(localdb)\MSSQLLocalDB` läuft unter Ihrem Windows-Konto, dem die Instanz gehört, ein 262 dort heißt also fast immer, dass Sie mit einer geteilten Instanz oder einem echten SQL Server verbunden sind, den Sie für LocalDB hielten. Prüfen Sie mit `dotnet ef database update -v` den Servernamen in der Verbindungszeichenfolge, die das Werkzeug tatsächlich geladen hat.

**Ein Timeout, das wie ein Berechtigungsfehler aussieht.** Lautet die Meldung `Execution Timeout Expired` statt Fehler 262, ist mit dem Login alles in Ordnung und die Migration selbst ist langsam. Das ist ein anderes Problem, behandelt in [SqlException: Timeout expired während EF Core Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

**Gar keine Verbindung.** Erreicht `dotnet ef` den SQL Server nie, sehen Sie stattdessen `Unable to create an object of type 'DbContext'`, ein Fehler beim Auffinden zur Entwurfszeit und keiner der Berechtigungen. Das steht in [dotnet ef migrations add schlägt mit "Unable to create an object of type DbContext" fehl](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

Die größere Lehre lautet: die Migrationspipeline von EF Core wurde für die Entwicklerschleife entworfen, in der einem die eigene Datenbank gehört, und der Schritt zum automatischen Anlegen wurde nie optional gemacht. [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839), das genau darum bat, damit eine Migrationsanwendung keine Rechte zum Anlegen von Datenbanken braucht, wurde als nicht geplant geschlossen. Behandeln Sie `Migrate()` als Entwicklungskomfort und SQL-Skripte als Deployment-Mechanismus, dann ist Fehler 262 nichts mehr, was Sie in der Produktion treffen kann.

## Verwandte Artikel

- [EF Core 11 Migrationen in der Produktion mit dotnet ef migrations bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Fix: SqlException: Timeout expired während EF Core Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add schlägt mit "Unable to create an object of type DbContext" fehl](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Fix: dotnet tool install --global dotnet-ef wirft einen Fehler](/de/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Eine Tabelle in einer EF Core 11 Migration umbenennen, ohne Daten zu verlieren](/de/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)

## Quellen

- [Migrator.cs, `Migrate(string? targetMigration)`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) - das bedingungslose Paar aus `Exists()` und `Create()`
- [SqlServerDatabaseCreator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) - `IsDoesNotExist` und die Existenzprüfung per `SELECT 1`
- [SqlServerConnection.cs, `CreateMasterConnection`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) - das fest verdrahtete `InitialCatalog = "master"`
- [CREATE DATABASE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) - erforderliche Berechtigungen auf SQL Server und Azure SQL Database
- [Server-level roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) - `##MS_DatabaseManager##` und `dbcreator`
- [Principals (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) - warum sich `guest` in `master` nicht entziehen lässt
- [Applying migrations - EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) - Skripte, Bundles und der Hinweis auf geringste Rechte
- [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) - "Database Migrate fails to execute for manually created database", als nicht geplant geschlossen
- [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) - "EF Core automatically creates expensive database when executing migrations", als nicht geplant geschlossen
