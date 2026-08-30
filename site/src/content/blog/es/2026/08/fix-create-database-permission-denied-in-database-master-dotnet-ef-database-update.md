---
title: "Solución: CREATE DATABASE permission denied in database 'master' al ejecutar dotnet ef database update"
description: "Migrate() de EF Core siempre comprueba si la base de datos existe y la crea si no, desde una conexión a master fija en el código. Otorga CREATE ANY DATABASE, arregla el acceso del login a la base de datos existente, o genera un script SQL idempotente."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
lang: "es"
translationOf: "2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update"
translatedBy: "claude"
translationDate: 2026-08-30
---

`dotnet ef database update` no intenta crear tu base de datos porque tú se lo hayas pedido. Cada llamada a `Migrate()` empieza con `if (!_databaseCreator.Exists()) _databaseCreator.Create()`, y no hay ningún interruptor para desactivarlo. Así que o tu login realmente no puede crear bases de datos (otórgale `CREATE ANY DATABASE` en `master`, o agrégalo a `##MS_DatabaseManager##`), o la base de datos ya existe y el login no puede abrirla, algo que EF Core interpreta mal como "no existe". Comprueba primero el segundo caso: `SELECT DB_ID('YourDb')` como `sa`, luego `SELECT DB_ID('YourDb')` como el login de migración. Si el primero devuelve un número y el segundo devuelve `NULL`, la solución es un usuario de base de datos, no un permiso de servidor. Para producción, deja de ejecutar `Migrate()` con un login privilegiado y entrega a un DBA la salida de `dotnet ef migrations script --idempotent`, que no contiene ningún `CREATE DATABASE`.

Todo lo de abajo se verificó con `Microsoft.EntityFrameworkCore.SqlServer` 10.0.11 y la CLI `dotnet-ef` 10.0.11 sobre el SDK de .NET 10.0.302. Las rutas de código `Migrator.Migrate` y `SqlServerDatabaseCreator` citadas aquí no han cambiado entre EF Core 8, 9, 10 y 11, así que el comportamiento y todas las soluciones aplican a las cuatro versiones. Cuando una afirmación proviene de la documentación de SQL Server en lugar de una ejecución en esta máquina, lo digo.

## El error en contexto

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

Esa traza está reconstruida a partir de la cadena de llamadas de EF Core que sigue, no capturada en esta máquina, que no tiene una instancia de SQL Server; los nombres de los frames y los números de error salen del código fuente publicado y de los errores documentados de SQL Server. Dos frames importan. `SqlServerDatabaseCreator.Create()` te dice que EF decidió que la base de datos faltaba. `Error Number:262` es el error de permisos de SQL Server, no un error de conexión, lo que significa que el login se autenticó bien y llegó hasta ejecutar una sentencia.

## Por qué dotnet ef database update toca master

Nada en tu `Program.cs` ni en tu cadena de conexión menciona `master`. Lo pone EF. El código relevante es lo primero que hace `Migrate()`, en [`Migrator.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs):

```csharp
// Microsoft.EntityFrameworkCore.Relational 10.0.11, Migrator.Migrate
if (!_databaseCreator.Exists())
{
    _databaseCreator.Create();
}
```

No hay opción, ni bandera de `DbContextOptionsBuilder`, ni variable de entorno que se lo salte. `dotnet ef database update` pasa exactamente por este método, y también lo hacen `context.Database.Migrate()` al arrancar la aplicación y un bundle de migración producido por `dotnet ef migrations bundle`.

`Create()` entonces construye su propia conexión. De [`SqlServerConnection.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs):

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

`InitialCatalog = "master"` está fijo en el código. De ahí viene el `in database 'master'` del mensaje. Sobre esa conexión EF ejecuta el T-SQL que emite su propio generador para una `SqlServerCreateDatabaseOperation`:

```sql
-- what EF Core 10.0.11 sends on the master connection
CREATE DATABASE [Shop];
GO
IF SERVERPROPERTY('EngineEdition') <> 5
BEGIN
    ALTER DATABASE [Shop] SET READ_COMMITTED_SNAPSHOT ON;
END;
```

La razón de que obtengas un error de *permisos* y no de *login* es que cualquier login de SQL Server puede abrir `master`. El permiso `CONNECT` del usuario `guest` se puede revocar "en cualquier base de datos que no sea `master` o `tempdb`", según la [documentación de principals](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine). Así que EF conecta correctamente y luego tropieza con la sentencia.

## La comprobación de existencia es más laxa de lo que crees

Aquí está la parte que manda a la mayoría por el camino equivocado. `SqlServerDatabaseCreator.Exists()` no consulta `sys.databases`. Abre una conexión a la base de datos destino y ejecuta `SELECT 1`, y trata tres números de `SqlException` como prueba de que la base de datos no existe:

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
private static bool IsDoesNotExist(SqlException exception)
    => exception.Number is 4060 or 1832 or 5120;
```

El error 4060 es `Cannot open database "Shop" requested by the login. The login failed.` SQL Server lo lanza tanto cuando la base de datos falta **como** cuando el login no tiene un usuario mapeado en una base de datos que sí existe, o cuando la base de datos está offline, restaurándose, o en modo `SINGLE_USER`. EF no puede distinguirlos, así que concluye que la base de datos falta y se va a crearla. Entonces obtienes el error 262 sobre `master`, cuando el problema real es un `CREATE USER` que falta en `Shop`.

Distingue los dos casos antes de tocar ningún permiso. Conéctate como administrador y ejecuta:

```sql
-- as sa or a sysadmin
SELECT DB_ID('Shop') AS db_id, state_desc, user_access_desc
FROM sys.databases WHERE name = 'Shop';
```

Luego conéctate con las credenciales exactas de la cadena de conexión de migración y ejecuta:

```sql
-- as the migration login
SELECT DB_ID('Shop') AS visible_to_me;
```

Una fila en la primera consulta más `NULL` en la segunda significa que la base de datos existe y tu login no puede verla. Eso es la siguiente sección. Nada en la primera consulta significa que realmente falta, que es la sección posterior.

## Solución 1: la base de datos existe, el login no puede abrirla

Esta es la forma habitual en CI y en entornos recién restaurados: alguien restauró un `.bak` o creó la base de datos desde un script, y el login a nivel de servidor existe pero no tiene un usuario de base de datos correspondiente, o tiene uno huérfano por SID tras una restauración.

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

Si el usuario ya existe pero quedó huérfano tras una restauración, vuelve a apuntarlo al login en lugar de recrearlo:

```sql
USE [Shop];
GO
ALTER USER [app] WITH LOGIN = [app];
GO
```

`db_ddladmin` es lo que necesitan las migraciones: `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, y la tabla `__EFMigrationsHistory` que EF crea en la primera ejecución. `db_owner` también funciona y es a lo que recurre la mayoría, pero da más de lo que las migraciones requieren.

Dos variantes lanzan 4060 por razones que un usuario de base de datos no arregla. Si `state_desc` no es `ONLINE`, pon la base de datos en línea. Si `user_access_desc` es `SINGLE_USER`, ejecuta `ALTER DATABASE [Shop] SET MULTI_USER;`. En ambos casos EF seguirá intentando crear una base de datos que está justo ahí.

## Solución 2: la base de datos realmente falta y quieres que EF la cree

Esta es la solución correcta para una máquina de desarrollo, un contenedor de CI desechable, o cualquier entorno donde al login de migración se le permite ser dueño de su base de datos.

La opción de menor privilegio en SQL Server 2022 (16.x) y posteriores, y en Azure SQL Database, es el rol fijo de servidor `##MS_DatabaseManager##`. Según la [documentación de roles a nivel de servidor](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles), sus miembros "can create databases, and delete databases they own", y lleva los permisos a nivel de servidor `CREATE ANY DATABASE` y `ALTER ANY DATABASE`:

```sql
-- SQL Server 2022 (16.x)+ and Azure SQL Database
ALTER SERVER ROLE [##MS_DatabaseManager##] ADD MEMBER [app];
```

En SQL Server 2019 (15.x) y anteriores no existe ese rol, así que otorga el permiso a nivel de servidor directamente. Esta es la versión a preferir sobre `dbcreator`, porque los miembros de `dbcreator` "can create, alter, drop, and restore **any** database", incluidas las que tu migración no tiene por qué tocar:

```sql
-- SQL Server 2016 (13.x) and later, including 2019 (15.x) where no role exists
USE master;
GO
GRANT CREATE ANY DATABASE TO [app];
GO
```

`CREATE DATABASE` y `CREATE ANY DATABASE` no son intercambiables, y confundirlos es un segundo fallo común. `CREATE DATABASE` es un permiso de *ámbito de base de datos* en `master`, así que solo se puede otorgar a un usuario de base de datos, lo que significa que el login necesita antes un usuario en `master`:

```sql
-- the CREATE DATABASE variant needs a user in master
USE master;
GO
CREATE USER [app] FOR LOGIN [app];
GRANT CREATE DATABASE TO [app];
GO
```

`CREATE ANY DATABASE` es de ámbito de servidor y se otorga al login mismo, por eso no necesita usuario en `master`. La [documentación de CREATE DATABASE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) lista `CREATE DATABASE`, `CREATE ANY DATABASE` o `ALTER ANY DATABASE` como suficientes.

En Azure SQL Database la vía antigua es el rol de base de datos `dbmanager` en `master`, que la documentación sigue listando como principal válido para `CREATE DATABASE`:

```sql
-- Azure SQL Database, connected to master
CREATE USER [app] FROM LOGIN [app];
ALTER ROLE dbmanager ADD MEMBER [app];
GO
```

Ten cuidado con esto en Azure. EF emite un `CREATE DATABASE [Shop];` pelado, sin `EDITION` ni `SERVICE_OBJECTIVE`, así que el servidor elige el nivel por defecto y empieza a facturarlo. Esa es exactamente la queja de [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251), "EF Core automatically creates expensive database when executing migrations", que el equipo cerró como no planificado. No otorgues derechos de creación de bases de datos a un login de despliegue apuntado a un servidor de Azure SQL a menos que te parezca bien que un error tipográfico en el nombre de una base de datos aprovisione una nueva base de datos facturable.

## Solución 3: saca el paso de creación del despliegue por completo

Si el login no tiene privilegios a propósito, ninguna cantidad de permisos otorgados es la respuesta correcta. Deja de ejecutar `Migrate()` en ese entorno y aplica SQL en su lugar. El script generado nunca contiene `CREATE DATABASE`, porque el generador de scripts opera solo sobre migraciones y nunca llama a `IRelationalDatabaseCreator`:

```bash
dotnet ef migrations script --idempotent --output migrate.sql
```

En EF Core 10.0.11 eso produce exactamente esto para una única migración inicial:

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

Ni una sola referencia a `master`. La bandera `--idempotent` hace que el script sea seguro de ejecutar contra una base de datos en cualquier nivel de migración, que es lo que quieres cuando un DBA lo aplica a mano. El equipo de EF lo dice en la [documentación sobre aplicar migraciones](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying): `dotnet ef database update` "applies SQL commands directly by the tool, without giving the developer a chance to inspect or modify them", y la documentación señala explícitamente que llamar a `Migrate()` al arrancar "requires elevated access to modify the database schema", lo que choca con el mínimo privilegio en producción.

El flujo pasa a ser: crear la base de datos una vez, a mano o mediante Terraform o Bicep, otorgar al login de la aplicación `db_ddladmin` dentro de ella, y aplicar `migrate.sql` en el pipeline de release. El login de la aplicación nunca necesita un solo permiso en `master`.

## Los bundles de migración no te libran de esto

Un malentendido común es que `dotnet ef migrations bundle` esquiva el problema porque es un ejecutable autónomo sin dependencia del SDK. No lo hace. El bundle llama a `Migrate()`, así que ejecuta el mismo par `Exists()`/`Create()` y falla con el mismo error 262 bajo un login sin privilegios. Los bundles resuelven el problema de "no hay SDK en el agente de despliegue", no el problema de permisos. Si tu entorno destino prohíbe `CREATE DATABASE`, los bundles necesitan el mismo tratamiento que la CLI: haz que la base de datos exista primero y que el login pueda abrirla. La mecánica de ese pipeline está en [aplicar migraciones de EF Core 11 en producción con dotnet ef migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Variantes que producen un error parecido

**`CREATE TABLE permission denied in database 'master'.`** Mismo número de error, sentencia distinta. Este significa que tu cadena de conexión no tiene `Database=` ni `Initial Catalog=`, así que SQL Server te dejó en la base de datos por defecto del login, que para `sa` es `master`. EF no está creando nada; está ejecutando tu migración contra `master`. Añade la base de datos a la cadena de conexión.

**`EnsureCreated()` en lugar de migraciones.** `Database.EnsureCreated()` lanza el error idéntico por la razón idéntica, y es peor: crea el esquema sin una tabla `__EFMigrationsHistory`, así que las migraciones nunca podrán aplicarse a esa base de datos después. Si encuentras una llamada a `EnsureCreated()` en `Program.cs` junto a una carpeta de migraciones, bórrala.

**LocalDB.** `(localdb)\MSSQLLocalDB` se ejecuta como tu cuenta de Windows, que es dueña de la instancia, así que un 262 ahí casi siempre significa que estás conectado a una instancia compartida o a un SQL Server real que creías que era LocalDB. Comprueba el nombre del servidor en la cadena de conexión que la herramienta realmente cargó, con `dotnet ef database update -v`.

**Un timeout que parece un fallo de permisos.** Si el mensaje es `Execution Timeout Expired` en lugar del error 262, el login está bien y la migración en sí es lenta. Ese es otro problema, cubierto en [SqlException: Timeout expired durante las migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

**Ninguna conexión.** Si `dotnet ef` nunca llega a SQL Server, verás `Unable to create an object of type 'DbContext'` en su lugar, que es un fallo de descubrimiento en tiempo de diseño y no de permisos. Eso está cubierto en [dotnet ef migrations add falla con "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

La lección de fondo es que el pipeline de migraciones de EF Core se diseñó para el ciclo interno del desarrollador, donde ser dueño de tu base de datos es el caso normal, y el paso de creación automática nunca se hizo opcional. [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839), que pedía exactamente eso para que una aplicación de migración no necesitara derechos de creación de bases de datos, se cerró como no planificado. Trata `Migrate()` como una comodidad de desarrollo y los scripts SQL como el mecanismo de despliegue, y el error 262 deja de ser algo que puedas encontrarte en producción.

## Relacionados

- [Cómo aplicar migraciones de EF Core 11 en producción con dotnet ef migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Solución: SqlException: Timeout expired durante las migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Solución: dotnet ef migrations add falla con "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Solución: dotnet tool install --global dotnet-ef lanza un error](/es/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Cómo renombrar una tabla en una migración de EF Core 11 sin perder datos](/es/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)

## Fuentes

- [Migrator.cs, `Migrate(string? targetMigration)`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) - el par incondicional `Exists()`/`Create()`
- [SqlServerDatabaseCreator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) - `IsDoesNotExist` y la sonda de existencia con `SELECT 1`
- [SqlServerConnection.cs, `CreateMasterConnection`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) - el `InitialCatalog = "master"` fijo en el código
- [CREATE DATABASE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) - permisos requeridos en SQL Server y Azure SQL Database
- [Server-level roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) - `##MS_DatabaseManager##` y `dbcreator`
- [Principals (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) - por qué `guest` no se puede revocar en `master`
- [Applying migrations - EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) - scripts, bundles y la advertencia sobre mínimo privilegio
- [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) - "Database Migrate fails to execute for manually created database", cerrado como no planificado
- [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) - "EF Core automatically creates expensive database when executing migrations", cerrado como no planificado
