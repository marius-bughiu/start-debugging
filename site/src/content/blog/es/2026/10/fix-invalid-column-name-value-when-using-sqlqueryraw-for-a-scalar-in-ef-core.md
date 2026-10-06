---
title: "Solución: Invalid column name 'Value' al usar SqlQueryRaw<T> para un resultado escalar en EF Core"
description: "EF Core envuelve un SqlQuery<T> escalar en una subconsulta y selecciona una columna llamada Value en cuanto añades First, Where, Max o Single. Ponle el alias AS Value a tu columna SQL, o materializa primero."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "efcore"
  - "ef-core-11"
  - "dotnet"
lang: "es"
translationOf: "2026/10/fix-invalid-column-name-value-when-using-sqlqueryraw-for-a-scalar-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-06
---

`Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First()` falla con `Invalid column name 'Value'` porque cualquier operador LINQ que encadenes a un `SqlQuery<T>` o `SqlQueryRaw<T>` escalar hace que EF Core envuelva tu SQL en una subconsulta y seleccione de ella una columna llamada literalmente `Value`. Se soluciona poniendo un alias a la única columna de salida: `SELECT COUNT(*) AS Value FROM Blogs`, entre comillas como `AS "Value"` en PostgreSQL. Si no puedes cambiar el SQL, materializa primero (`ToListAsync()` y luego elige la fila en memoria). Todo lo que sigue se midió en EF Core 10.0.12 y EF Core 11.0.0-rc.1, que se comportan igual en este caso, y la regla existe desde que `SqlQuery<T>` se lanzó en EF Core 7.0.

## El error en contexto

En SQL Server la excepción es una `SqlException`, número 207:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Invalid column name 'Value'.
```

El mismo error se ve distinto en cada proveedor, y por eso es difícil de buscar. Los mensajes de SQLite y PostgreSQL están copiados de las ejecuciones de laboratorio que aparecen más abajo; las líneas de SQL Server son los errores del motor para el SQL que envía EF (no había ninguna instancia de SQL Server disponible para este artículo):

```text
SQLite:      SQLite Error 1: 'no such column: s.Value'.
PostgreSQL:  42703: column s.Value does not exist
SQL Server:  Invalid column name 'Value'.                       (error 207)
SQL Server:  No column name was specified for column 1 of 's'.  (error 8155, unaliased COUNT(*), MAX(...) etc.)
```

La variante de SQL Server que obtengas depende de tu SQL. Si tu consulta devuelve una columna con nombre, como `SELECT Id FROM Blogs`, SQL Server se queja de que `Value` no existe. Si devuelve una expresión sin nombre, como `COUNT(*)`, SQL Server falla antes, porque una tabla derivada no puede contener una columna sin nombre. Ambos casos tienen la misma solución.

## Por qué EF Core pide una columna llamada Value

`SqlQuery<T>` para un `T` escalar se traduce en `RelationalQueryableMethodTranslatingExpressionVisitor`. En el código fuente de EF Core 11 RC 1, el traductor crea un `FromSqlExpression` para tu SQL con el alias de tabla `s` (generado a partir de `"sql"`), y una columna de proyección cuyo nombre sale de una constante fija:

```csharp
// EF Core 11.0.0-rc.1, src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs
private const string SqlQuerySingleColumnAlias = "Value";
```

No hay ninguna API para cambiar ese nombre. Mientras no se componga nada encima, EF envía tu SQL sin cambios y lee la primera columna por posición, así que el nombre de la columna no importa y `ToList()` funciona. En cuanto añades un operador que tiene que referenciar la columna en SQL, EF genera un `SELECT [s].[Value] FROM (<your SQL>) AS [s]` externo y la base de datos busca una columna que no existe.

La [documentación de SQL sin procesar de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types) enuncia la regla en una frase: cuando compones LINQ sobre una consulta SQL escalar, "you must name the output column `Value`". La trampa es que métodos como `First()` y `Single()` no parecen composición, pero lo son.

## Reproducción mínima

La siguiente aplicación de consola lo reproduce con SQLite en memoria, así que no necesita un servidor. Las sentencias de SQL Server citadas más adelante se capturaron desde el proveedor de SQL Server con un interceptor que suprime la conexión y registra `DbCommand.CommandText`, de modo que son exactamente las sentencias que envía EF; no intervino ninguna instancia de SQL Server.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (identical on .NET 10 + EF Core 10.0.12)
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).Options);
db.Database.EnsureCreated();
db.Blogs.AddRange(new Blog { Name = "a", Views = 5 }, new Blog { Name = "b", Views = 50 });
db.SaveChanges();

// Works: no composition, EF reads column 0 by position.
var all = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").ToList();

// Throws: SQLite Error 1: 'no such column: s.Value'.
var count = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First();

class Blog { public int Id { get; set; } public string Name { get; set; } = ""; public int Views { get; set; } }
class Db(DbContextOptions<Db> o) : DbContext(o) { public DbSet<Blog> Blogs => Set<Blog>(); }
```

Para la llamada a `First()`, el proveedor de SQL Server envía:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, captured CommandText
SELECT TOP(1) [s].[Value]
FROM (
    SELECT COUNT(*) FROM Blogs
) AS [s]
```

## Qué operadores lo provocan

Ejecuté cada operador contra un `SELECT Id FROM Blogs` sin alias en ambas versiones de EF. La tabla es el resultado en SQLite; la columna de SQL muestra lo que generó el proveedor de SQL Server para la misma consulta.

| Llamada sobre `SqlQueryRaw<int>(...)` | SQL externo generado (SQL Server) | Resultado sin alias |
|---|---|---|
| `ToList()` / `ToListAsync()` | ninguno, tu SQL se envía tal cual | funciona |
| `AsEnumerable().First()` | ninguno, `First` se ejecuta en memoria | funciona |
| `First()` / `FirstOrDefault()` | `SELECT TOP(1) [s].[Value] FROM (...) AS [s]` | falla |
| `Single()` / `SingleOrDefault()` | `SELECT TOP(2) [s].[Value] FROM (...) AS [s]` | falla |
| `Where(x => x > 1)` | `SELECT [s].[Value] ... WHERE [s].[Value] > 1` | falla |
| `Max()` / `Min()` | `SELECT MAX([s].[Value]) FROM (...) AS [s]` | falla |
| `Count()` | `SELECT COUNT(*) FROM (...) AS [s]` | funciona |
| `Any()` | `SELECT CASE WHEN EXISTS (SELECT 1 FROM (...) AS [s]) ...` | funciona |

`Count()` y `Any()` también envuelven tu SQL, pero nunca referencian la columna, así que se salvan. Así es como el código sobrevive a la revisión: se prueba la ruta de `Count()`, luego alguien la cambia a `FirstOrDefault()` y producción empieza a lanzar excepciones.

## Solución 1: ponle a la columna de salida el alias AS Value

Esta es la solución que recomienda la documentación, y mantiene la composición en el servidor:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = await db.Database
    .SqlQueryRaw<int>("SELECT COUNT(*) AS Value FROM Blogs")
    .FirstAsync();

var bigIds = await db.Database
    .SqlQuery<int>($"SELECT Id AS Value FROM Blogs")
    .Where(id => id > 1)
    .OrderBy(id => id)
    .ToListAsync();
```

Ahora ambas se ejecutan, y la segunda se filtra y se ordena en la base de datos:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider
SELECT [s].[Value]
FROM (
    SELECT Id AS Value FROM Blogs
) AS [s]
WHERE [s].[Value] > 1
ORDER BY [s].[Value]
```

Aquí apareció una pequeña diferencia entre versiones: EF Core 10.0.12 emite `ORDER BY CAST([s].[Value] AS int)` para la misma consulta, mientras que EF Core 11 RC 1 elimina la conversión redundante. No cambia el resultado, pero sí cambia el texto del plan si comparas consultas durante una actualización.

El alias funciona igual con todos los tipos escalares que EF sabe mapear, incluidos `string`, `DateTime`, `Guid` y tipos anulables como `int?`. Para una agregación que puede devolver `NULL`, mapea al tipo anulable. En una tabla vacía, `SqlQueryRaw<int>("SELECT MAX(Views) AS Value FROM Blogs")` lanza `Nullable object must have a value.`, con o sin composición, mientras que la versión con `int?` devuelve `null`:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
int? maxViews = await db.Database
    .SqlQueryRaw<int?>("SELECT MAX(Views) AS Value FROM Blogs")
    .FirstOrDefaultAsync();
```

## Solución 2: entrecomilla el alias en PostgreSQL

PostgreSQL convierte a minúsculas los identificadores sin comillas, y Npgsql entrecomilla la columna que genera. Así, `AS Value` crea una columna llamada `value`, EF pide `s."Value"` y obtienes el mismo error aunque hayas seguido la documentación. Esto se midió en Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 y 11.0.0-rc.1.1 contra PostgreSQL 18:

```csharp
// .NET 11 RC 1, Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.1.1
// Throws: 42703: column s.Value does not exist
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS Value FROM \"Blogs\"").FirstAsync();

// Works
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM \"Blogs\"").FirstAsync();
```

En un literal de cadena sin procesar de C# 11+ las comillas siguen siendo legibles:

```csharp
// .NET 11 RC 1, C# 14
var count = await db.Database.SqlQuery<int>($"""
    SELECT count(*)::int AS "Value" FROM "Blogs"
    """).FirstAsync();
```

SQLite compara los nombres de columna sin distinguir mayúsculas de minúsculas, así que `AS value` funciona allí, y SQL Server sigue la collation de la base de datos, que por defecto no distingue mayúsculas. Escribe `"Value"` con V mayúscula en todas partes y la consulta seguirá siendo portable.

## Solución 3: materializa primero cuando no puedes tocar el SQL

Si el SQL viene de un procedimiento almacenado, de una vista que no es tuya o de una constante compartida, trae las filas al cliente y termina allí:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = (await db.Database
        .SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs")
        .ToListAsync())
    .Single();

// or, synchronously
var count2 = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").AsEnumerable().Single();
```

Ninguna genera una subconsulta, así que el nombre de la columna es irrelevante. Haz esto solo con consultas que devuelven un puñado de filas. `AsEnumerable().Where(...)` transmite todo el resultado al cliente antes de filtrar, que es exactamente lo que componer en el servidor pretendía evitar.

Esta es también la única opción para un procedimiento almacenado, porque un `EXEC` no se puede usar como subconsulta en absoluto. Componer sobre él lanza un error distinto antes de que nada llegue al servidor; cubrí ese caso en la guía sobre [cómo llamar a un procedimiento almacenado y mapear sus resultados](/es/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/).

## Trampas y errores parecidos

**`ORDER BY` dentro de tu SQL más `First()` en SQL Server.** Incluso con el alias, `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs ORDER BY Views DESC").First()` genera `SELECT TOP(1) [s].[Value] FROM (SELECT Views AS Value FROM Blogs ORDER BY Views DESC) AS [s]`. SQLite lo acepta, pero SQL Server lo rechaza con el error 1033 ("The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified"). Aunque SQL Server lo aceptara, un `ORDER BY` dentro de una tabla derivada no garantiza el orden de la consulta externa. Mueve la ordenación a LINQ: `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs").OrderByDescending(v => v).First()`.

**Un DTO en lugar de un escalar.** Con `SqlQuery<BlogStat>` (tipos sin mapear, EF Core 8+), EF no usa `Value`; referencia una columna por propiedad, con el nombre de la propiedad. `SELECT Name AS BlogName, Views FROM Blogs` compuesto con `.Where(b => b.Views > 10)` falla con `no such column: b.Name` en SQLite (el alias ahora es `b`, tomado del nombre del tipo), y la misma consulta sin composición falla con `The required column 'Name' was not present in the results of a 'FromSql' operation`. La solución es ponerle a cada columna el alias del nombre de su propiedad. El segundo mensaje tiene su propia guía: [the required column was not present in the results of a FromSql operation](/es/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

**`FromSql` sobre un `DbSet`.** Las consultas de entidades nunca usan `Value`. Si ves `Invalid column name` ahí, el nombre del mensaje es una de tus columnas mapeadas, y la causa es una columna que falta en tu lista `SELECT`.

**Tu propia columna se llama literalmente `Value`.** Entonces `SELECT Value FROM Settings` se compone sin problemas y sin alias, y por eso algunos ejemplos en línea parecen funcionar sin él. Renombra la columna de la tabla y esos ejemplos se rompen.

**Ver el SQL real.** `ToQueryString()` sobre el `SqlQueryRaw<int>(...)` sin componer solo imprime tu propio SQL, y no puedes llamarlo después de `First()`. Registra en su lugar los comandos ejecutados (`LogTo` con `RelationalEventId.CommandExecuted`, o un interceptor), como se describe en el artículo sobre [cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/). El `SELECT [s].[Value]` externo resulta evidente en cuanto lo ves.

## Cuando el SQL sin procesar es la herramienta equivocada

La mayor parte del SQL escalar sin procesar que veo en las revisiones de código es un `COUNT`, `MAX` o `EXISTS` que LINQ expresa directamente: `db.Blogs.CountAsync()`, `db.Blogs.MaxAsync(b => (int?)b.Views)`, `db.Blogs.AnyAsync(...)`. Esas nunca se topan con este error y el proveedor las traduce con el entrecomillado correcto para cada base de datos. Reserva `SqlQuery<T>` para las consultas que LINQ no puede expresar, y si estás decidiendo entre SQL sin procesar, consultas compiladas y Dapper para una ruta crítica, la [comparación de consultas compiladas de EF Core vs SQL sin procesar vs Dapper](/es/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) trae los números. Si recurriste al SQL sin procesar porque una consulta LINQ no se pudo traducir, la guía para [solucionar "The LINQ expression could not be translated"](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) normalmente te devuelve a LINQ.

## Relacionado

- [Solución: The required column 'X' was not present in the results of a 'FromSql' operation en EF Core 11](/es/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Cómo llamar a un procedimiento almacenado y mapear sus resultados en EF Core 11](/es/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Consultas compiladas de EF Core vs SQL sin procesar vs Dapper](/es/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Solución: The LINQ expression could not be translated en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Fuentes

- [SQL Queries: querying scalar (non-entity) types](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types), documentación de EF Core
- [SQL Queries: composing with LINQ](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#composing-with-linq), incluida la restricción de `ORDER BY` de SQL Server
- [`RelationalQueryableMethodTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs), dotnet/efcore
- [`RelationalDatabaseFacadeExtensions.SqlQueryRaw<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlqueryraw), referencia de la API
- [Database engine errors](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors), documentación de SQL Server (207, 1033, 8155)
