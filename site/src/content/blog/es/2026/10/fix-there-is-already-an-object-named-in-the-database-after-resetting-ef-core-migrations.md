---
title: "Solución: There is already an object named 'X' in the database después de reiniciar las migraciones de EF Core"
description: "Después de borrar la carpeta Migrations y generar un nuevo InitialCreate, EF Core no sabe que tus tablas existen. Elimina la base de datos de desarrollo o registra la nueva migración en __EFMigrationsHistory sin ejecutarla."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "dotnet"
lang: "es"
translationOf: "2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-10-06
---

Borraste la carpeta `Migrations`, ejecutaste `dotnet ef migrations add InitialCreate` y ahora `dotnet ef database update` falla con `There is already an object named 'Blogs' in the database`. EF Core decide qué ejecutar comparando los ID de migración de tu ensamblado con las filas de `__EFMigrationsHistory`. Tu nuevo `InitialCreate` tiene una marca de tiempo nueva, así que EF Core lo trata como pendiente e intenta hacer `CREATE TABLE` sobre tablas que ya existen. Si la base de datos es desechable, elimínala (`dotnet ef database drop --force`) y vuelve a actualizar. Si contiene datos, borra las filas antiguas del historial e inserta una fila para el nuevo ID de migración, para que EF Core la registre como aplicada sin ejecutarla. Todo lo que sigue se midió en EF Core 10.0.12 con `dotnet-ef` 10.0.12 sobre .NET 10 (SDK 10.0.302), y la lógica no cambia en EF Core 11.0.0-rc.1.

## El error en contexto

En SQL Server es el error de motor 2714, que aparece como una `SqlException` desde `dotnet ef database update` o desde `Database.Migrate()` al arrancar. No había una instancia de SQL Server disponible para este artículo, así que el bloque siguiente es la ejecución en SQLite con el DDL y el mensaje de motor de SQL Server sustituidos:

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

La misma causa raíz aparece con otro texto en otros proveedores. La línea de SQLite está copiada de la reproducción de este artículo; las de PostgreSQL y MySQL son los errores de motor para la misma sentencia `CREATE TABLE`:

```text
SQLite:      SQLite Error 1: 'table "Blogs" already exists'.
PostgreSQL:  42P07: relation "Blogs" already exists
MySQL:       Table 'Blogs' already exists        (error 1050)
SQL Server:  There is already an object named 'Blogs' in the database.   (error 2714)
```

La línea clave es la primera: `Applying migration '..._InitialCreate'`. Si EF Core está aplicando tu migración inicial sobre una base de datos que ya tiene tu esquema, estás en la página correcta.

## Por qué EF Core intenta crear tablas que ya existen

EF Core no inspecciona tu esquema para decidir qué migraciones ejecutar. Ejecuta una sola consulta, `SELECT MigrationId FROM __EFMigrationsHistory`, y compara el resultado con las migraciones compiladas en tu ensamblado. Cualquier migración cuyo ID no esté en la tabla está pendiente, y las migraciones pendientes ejecutan su método `Up()` completo.

Un ID de migración es el prefijo del nombre de archivo: una marca de tiempo UTC más el nombre que escribiste, por ejemplo `20261006110224_InitialCreate`. Cuando reinicias las migraciones, el nuevo `InitialCreate` recibe una marca de tiempo nueva. Las filas antiguas (`20261006110219_InitialCreate`, `20261006110221_AddPublished`) siguen en la tabla de historial, pero EF Core ignora en silencio las filas que no coinciden con ninguna migración del ensamblado. No avisa de ellas. Así que, desde el punto de vista de EF Core, la base de datos nunca ha visto tu nueva migración, y el primer `CreateTable` choca con una tabla que ya está ahí.

El mismo desajuste ocurre en algunas situaciones que no son un reinicio deliberado:

1. **La base de datos se creó con `EnsureCreated()`**. `EnsureCreated()` construye el esquema directamente desde el modelo y nunca crea `__EFMigrationsHistory`. El primer `Migrate()` crea una tabla de historial vacía, considera pendientes todas las migraciones y falla en la primera tabla.
2. **La base de datos vino de otro lado**: una copia de seguridad restaurada de otra aplicación, un esquema DB-first, un script ejecutado por un DBA. El mismo panorama: las tablas existen, el historial no.
3. **La tabla de historial cambió de lugar**. Se agregó o cambió `MigrationsHistoryTable("__MyHistory", "app")` después de la implementación, o en SQL Server se usa otro inicio de sesión cuyo esquema predeterminado no es `dbo`. EF Core busca en la nueva ubicación, no encuentra nada y empieza desde cero.
4. **Dos migraciones crean la misma tabla**. Dos ramas agregaron cada una una migración que crea `AuditLog`, y ambas se fusionaron. La primera funciona, la segunda lanza el 2714.

## Reproducción mínima en EF Core 10

Esta es la secuencia exacta que ejecuté, con SQLite para que se pueda reproducir en cualquier máquina:

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

Después del fallo, `dotnet ef migrations list` muestra exactamente lo que cree EF Core:

```text
20261006110224_InitialCreate (Pending)
```

Las dos filas antiguas siguen en la tabla de historial. EF Core 10 además envuelve cada migración en su propia transacción, así que en SQLite y SQL Server el `InitialCreate` fallido se revierte limpiamente y no deja nada a medio aplicar. MySQL es la excepción, porque allí el DDL hace commit implícito.

## Solución 1: elimina la base de datos cuando los datos no importan

Para una base de datos de desarrollo local, el reinicio que realmente querías es "las migraciones y la base de datos empiezan de cero juntas". La [documentación oficial](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations) describe justo eso: borrar la carpeta `Migrations` y eliminar la base de datos.

```bash
# dotnet-ef 10.0.12
dotnet ef database drop --force
dotnet ef database update
```

Es la respuesta correcta para una base de datos en tu laptop o un contenedor desechable. No la uses en nada compartido: elimina la base de datos, datos incluidos.

## Solución 2: registra la nueva línea base sin ejecutarla

Si la base de datos tiene datos que te importan, quieres lo contrario: conservar el esquema y decirle a EF Core que el nuevo `InitialCreate` ya está aplicado. Es lo que la documentación llama compactar (squash) migraciones. EF Core no tiene un comando integrado para esto (la petición lleva años abierta como [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174)), así que es una edición manual de la tabla de historial.

1. Haz una copia de seguridad de la base de datos.
2. Asegúrate de que la base de datos esté en la **última migración antigua** antes de reiniciar. Si está atrasada, aplica primero las migraciones antiguas que falten, usando el código antiguo del control de versiones. Una línea base solo funciona si el nuevo `InitialCreate` describe el esquema que realmente está ahí.
3. Borra la carpeta `Migrations` y ejecuta `dotnet ef migrations add InitialCreate`.
4. Ejecuta `dotnet ef migrations script 0 InitialCreate` y copia la sentencia `INSERT INTO [__EFMigrationsHistory]` del final de la salida. Tiene el ID de migración y la versión de producto exactos.
5. Reemplaza las filas antiguas del historial por esa única fila.

En SQL Server, el paso 5 se ve así:

```sql
-- SQL Server, EF Core 10.0.12 history table
BEGIN TRANSACTION;

DELETE FROM [__EFMigrationsHistory];

INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
VALUES (N'20261006110224_InitialCreate', N'10.0.12');

COMMIT;
```

Luego confirma que EF Core está de acuerdo:

```bash
# dotnet-ef 10.0.12
dotnet ef migrations list                      # 20261006110224_InitialCreate, no "(Pending)"
dotnet ef migrations has-pending-model-changes # "No changes have been made to the model since the last migration."
```

En mi reproducción, después de la línea base agregué una propiedad `Url` a `Blog`, generé `AddBlogUrl`, y `dotnet ef database update` aplicó solo esa migración. Ese es el estado que buscas: el historial tiene una fila de línea base y las nuevas migraciones fluyen normalmente encima.

Borrar las filas antiguas no es estrictamente necesario, porque EF Core ignora las filas que no reconoce. Bórralas de todos modos. Si alguien más adelante hace checkout de un commit antiguo y ejecuta `database update` contra esta base de datos, las filas obsoletas hacen que EF Core crea que las migraciones antiguas están aplicadas, y ese fallo es confuso de depurar.

## Línea base en más de un entorno

Compactar es fácil en una base de datos y propenso a errores en cinco. Cada entorno existente necesita el cambio de filas, y cada entorno nuevo necesita que se ejecute el `InitialCreate` completo. La forma más segura de conseguir ambas cosas es una guarda que solo reescribe el historial cuando encuentra la cadena antigua, y no hace nada en otro caso.

Como script SQL que ejecutas una vez por entorno, antes de implementar el código compactado:

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

La guarda está en la **última** migración antigua, no en la primera. Una base de datos que nunca llegó a `AddPublished` no tiene el esquema que describe tu nuevo `InitialCreate`, así que no debe recibir la línea base. Primero hay que actualizarla con el código antiguo.

Si aplicas las migraciones desde la aplicación al arrancar, la misma guarda cabe delante de `Migrate()`. Lo probé contra tres bases de datos: una en el estado antiguo `AddPublished`, la misma base de datos en una segunda ejecución y un archivo nuevo vacío. Las tres terminaron con `InitialCreate, AddBlogUrl` aplicadas y el esquema correcto.

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

El nombre de la tabla va sin comillas para que el mismo código funcione en SQL Server y SQLite. En PostgreSQL hay que citarlo como `"__EFMigrationsHistory"`, porque allí el identificador distingue mayúsculas y minúsculas. Ejecuta esto en un único paso de migración (un job, un init container o una sola instancia), no en cada réplica. `Migrate()` toma un bloqueo de migración desde EF Core 9, pero este helper se ejecuta antes de adquirir ese bloqueo. Si implementas con bundles, ejecuta la versión SQL antes del bundle, como se explica en [aplicar migraciones de EF Core en producción con migration bundles](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/). Quita el helper cuando todos los entornos tengan su línea base.

## El truco del Up() vacío, y por qué lo evito

Una respuesta común en Stack Overflow dice: comenta el cuerpo de `Up()` en el nuevo `InitialCreate`, ejecuta `database update` para que se registre la fila y luego restaura el cuerpo. Funciona para una base de datos en una máquina. También es exactamente como se hace commit de una migración rota: olvida restaurar el cuerpo y cada entorno nuevo recibe un esquema vacío con una fila de historial que dice que está completo. La línea base en SQL le hace lo mismo a la base de datos sin tocar el archivo de migración, así que no hay nada que olvidar.

## Trampas y errores parecidos

**El código personalizado de las migraciones antiguas desaparece.** Cualquier `migrationBuilder.Sql(...)` que escribiste para vistas, procedimientos almacenados, triggers o filas semilla vivía en los archivos borrados. El nuevo `InitialCreate` solo contiene lo que el modelo conoce. Copia esos bloques a mano en la nueva migración, o los entornos nuevos no tendrán objetos que producción sí tiene.

**La deriva del esquema hace que la línea base mienta.** Si alguien agregó un índice o una columna directamente en producción, el nuevo `InitialCreate` no lo contiene, y la línea base registra un esquema que no coincide. Antes de crear la línea base, compara la salida de `dotnet ef migrations script 0 InitialCreate` con el esquema real (schema compare de SSMS, `pg_dump --schema-only` o `sqlite3 .schema`).

**`EnsureCreated()` junto a `Migrate()`.** Si llegaste aquí porque la base de datos se creó con `EnsureCreated()`, quita esa llamada antes de cualquier otra cosa. Nunca crea la tabla de historial, así que ambos no pueden coexistir. El mismo consejo aparece en el artículo sobre [`CREATE DATABASE permission denied` durante `dotnet ef database update`](/es/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), que es otro síntoma de mezclar los dos.

**El arranque lanza primero otro error.** Desde EF Core 9, `Migrate()` se niega a ejecutarse cuando el modelo tiene cambios que no están capturados en una migración. Si en su lugar ves `The model for context has pending changes`, arregla eso primero, como se describe en [el artículo sobre cambios de modelo pendientes](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), y luego vuelve.

**Migración aplicada a medias después de un timeout.** Si el 2714 aparece en una migración que no es la inicial, la causa puede ser una migración que murió a la mitad. Ese caso se cubre en [cómo solucionar los timeouts de SqlException durante las migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), incluido cómo reparar la fila del historial.

**Los scripts `--idempotent` no te salvan.** `dotnet ef migrations script --idempotent` envuelve cada migración en `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'...')`. Comprueba el ID de migración, no la tabla, así que un nuevo ID de `InitialCreate` sigue ejecutando su `CREATE TABLE` y falla igual.

**`dotnet ef migrations add` falla antes de llegar aquí.** Si la herramienta no puede construir tu contexto durante el reinicio, es un problema de configuración en tiempo de diseño, cubierto en [cómo solucionar "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Relacionado

- [Cómo aplicar migraciones de EF Core 11 en producción con dotnet ef migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Solución: The model for context has pending changes en EF Core 11](/es/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Solución: SqlException: Timeout expired durante las migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Solución: CREATE DATABASE permission denied in database 'master'](/es/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Solución: dotnet ef migrations add "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)

## Fuentes

- [Managing Migrations: Resetting all migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying), Microsoft Learn.
- [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174), la petición de funcionalidad abierta para compactar migraciones.
- [`HistoryRepository.cs` en la rama release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Relational/Migrations/HistoryRepository.cs), que muestra los valores predeterminados del nombre y el esquema de la tabla de historial.
