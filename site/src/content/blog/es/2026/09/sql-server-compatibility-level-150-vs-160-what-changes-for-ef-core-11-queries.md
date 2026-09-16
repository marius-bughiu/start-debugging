---
title: "Nivel de compatibilidad 150 vs 160 de SQL Server: qué cambia para las consultas de EF Core 11"
description: "EF Core 11 ahora usa por defecto el nivel de compatibilidad 160 en UseSqlServer, lo que mete LEAST, GREATEST y LTRIM/RTRIM de dos argumentos en tu SQL, incluido cada Take(n).FirstOrDefault(). Quédate en 160 con SQL Server 2022 o posterior; fija UseCompatibilityLevel(150) si algún entorno todavía ejecuta SQL Server 2019."
pubDate: 2026-09-16
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-09-16
---

Respuesta corta: si todas las bases de datos con las que habla tu aplicación ejecutan SQL Server 2022 o posterior, conserva el nuevo valor por defecto de EF Core 11, el nivel de compatibilidad 160. Convierte `Math.Min`/`Math.Max`, `EF.Functions.Least`/`Greatest`, `Min`/`Max` sobre arreglos en línea y las llamadas encadenadas a `Take` en `LEAST`/`GREATEST`, y `TrimStart(char)`/`TrimEnd(char)` en `LTRIM`/`RTRIM` de dos argumentos. Si algún entorno todavía ejecuta SQL Server 2019, llama a `UseCompatibilityLevel(150)` antes de actualizar. En el nivel 160, una consulta tan común como `.Take(pageSize).FirstOrDefaultAsync()` se convierte en `SELECT TOP(LEAST(@p, 1))`, y SQL Server 2019 no tiene `LEAST`.

Todo lo que sigue se comprobó con `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 sobre el SDK de .NET 11 RC 1 (11.0.100-rc.1.26425.128) con C# 14, y con 10.0.12 sobre el SDK 10.0.302 para la situación anterior. Comparé el SQL que generan ambas versiones. No lo ejecuté contra un SQL Server real, así que el comportamiento del lado del servidor se toma de la documentación de SQL Server, enlazada más abajo.

## 150 vs 160 de un vistazo

| Forma LINQ (EF Core 11) | Nivel 150 (por defecto en EF Core 10) | Nivel 160 (por defecto en EF Core 11) |
| --- | --- | --- |
| `Math.Max(a, b)` en `Where` / `OrderBy` | Lanza "could not be translated" | `GREATEST([a], [b])` |
| `Math.Min(a, b)` en el `Select` final | Se evalúa en el cliente | `LEAST([a], [b])` en el servidor |
| `EF.Functions.Greatest(a, b, c)` en `Where` | Lanza "could not be translated" | `GREATEST([a], [b], [c])` |
| `new[] { a, b }.Max()` | `(SELECT MAX(...) FROM (VALUES ...))` | `GREATEST([a], [b])` |
| `Take(n).FirstOrDefault()` | `TOP(1)` anidado sobre una subconsulta `TOP(@p)` | `TOP(LEAST(@p, 1))` |
| `Skip(s).Take(n).First()` | `TOP(1)` sobre una subconsulta con `OFFSET`/`FETCH` | `FETCH NEXT LEAST(@p1, 1) ROWS ONLY` |
| `TrimStart('0')` en `Where` | Lanza "could not be translated" | `LTRIM([col], N'0')` |
| `ExecuteUpdate` que asigna a una propiedad JSON una columna `DateTime` | Lanza una excepción | `JSON_MODIFY(..., JSON_VALUE(JSON_OBJECT('v': [col]), '$.v'))` |
| DDL / migraciones | Idénticos | Idénticos |
| Columnas JSON | `nvarchar(max)` | `nvarchar(max)` (solo 170 cambia a `json`) |
| Servidor mínimo | SQL Server 2019 | SQL Server 2022 (y nivel 160 de la base de datos para `LTRIM`/`RTRIM` con caracteres) |

## El nivel de compatibilidad de EF no es el nivel de compatibilidad de tu base de datos

Hay dos configuraciones distintas, y ambas se llaman "nivel de compatibilidad".

La **configuración de EF** es lo que pasas a `UseCompatibilityLevel`. EF nunca la lee del servidor. Queda fija cuando se construyen las opciones y solo decide qué características de SQL puede usar el pipeline de consultas. En `SqlServerOptionsExtension`, los valores por defecto en EF Core 11 son `SqlServerDefaultCompatibilityLevel = 160` y `AzureSqlDefaultCompatibilityLevel = 170`. En EF Core 10 el primero era 150. El cambio es [dotnet/efcore#38198](https://github.com/dotnet/efcore/issues/38198), publicado en el PR #38199, y figura como un cambio disruptivo de bajo impacto en EF Core 11.

La **configuración de la base de datos** es `sys.databases.compatibility_level`. Controla el comportamiento del optimizador de consultas y algunas reglas de sintaxis. Con el nivel 160 en la base de datos, SQL Server 2022 activa la optimización de planes sensible a parámetros y la retroalimentación de estimación de cardinalidad. Una base de datos que restauras o adjuntas en un servidor más nuevo conserva su nivel anterior. Así que una base de datos movida de SQL Server 2019 a 2022 puede seguir en 150.

Las dos configuraciones solo interactúan a través del SQL que envía EF. La página de Microsoft sobre el nivel de compatibilidad dice que la nueva sintaxis de T-SQL no está condicionada por el nivel de compatibilidad de la base de datos, salvo cuando podría romper aplicaciones existentes. `GREATEST` y `LEAST` no están en la lista de excepciones, así que funcionan en SQL Server 2022 con cualquier nivel de base de datos. El argumento opcional *characters* de `LTRIM` y `RTRIM` sí es una excepción: su documentación exige el nivel de compatibilidad 160 en la base de datos.

Ten en cuenta también que `UseAzureSql` y `UseSqlServer` son caminos separados. `UseAzureSql` ya usaba 170 por defecto en EF Core 10, así que nada de este artículo cambia para quienes usan Azure SQL. Si apuntas `UseSqlServer` a Azure SQL, acabas de pasar de 150 a 160 como todos los demás.

## Cómo medí la diferencia

La prueba construye el mismo modelo tres veces (por defecto, `UseCompatibilityLevel(150)`, `UseCompatibilityLevel(160)`). Imprime `ToQueryString()` para las consultas. Para `FirstOrDefaultAsync` y `ExecuteUpdateAsync`, un interceptor suprime la conexión y captura el texto del comando, así que no interviene ninguna base de datos:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
var configs = new (string Name, Action<DbContextOptionsBuilder> Configure)[]
{
    ("UseSqlServer (default)", o => o.UseSqlServer(Cs)),
    ("UseSqlServer + 150", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(150))),
    ("UseSqlServer + 160", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(160))),
};

foreach (var (name, configure) in configs)
{
    using var db = Shop.Create(configure); // adds the interceptor, EnableServiceProviderCaching(false)
    Q("Math.Max in Where", () => db.Products
        .Where(p => Math.Max(p.Stock, p.ReorderLevel) > 10).ToQueryString());
    Q("TrimStart('0') in Where", () => db.Products
        .Where(p => p.Sku.TrimStart('0') == "42").ToQueryString());
    // ...one line per shape in the table above
}

class NoDb : DbCommandInterceptor, IDbConnectionInterceptor
{
    public ValueTask<InterceptionResult> ConnectionOpeningAsync(DbConnection c, ConnectionEventData d,
        InterceptionResult r, CancellationToken t = default) => ValueTask.FromResult(InterceptionResult.Suppress());

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand cmd,
        CommandEventData d, InterceptionResult<DbDataReader> r, CancellationToken t = default)
    {
        Capture.Last = cmd.CommandText;
        throw new CapturedException(); // stop before anything needs a real reader
    }
    // ConnectionOpening (sync) and NonQueryExecutingAsync follow the same pattern
}
```

Ejecutar el mismo archivo contra EF Core 10.0.12 dio un control útil. EF Core 10 con `UseCompatibilityLevel(160)` produjo un SQL idéntico al de EF Core 11 por defecto. Ninguna de estas traducciones es nueva en EF Core 11. `Math.Min`/`Math.Max` mediante `LEAST`/`GREATEST` y las sobrecargas con `char` de `TrimStart`/`TrimEnd` llegaron en EF Core 9, condicionadas al nivel 160. EF Core 11 solo movió el valor por defecto para que se activen sin que lo pidas.

## El cambio que duele: Take seguido de First o Single

Este es el que no esperaba, y afecta a código que no tiene nada que ver con `Math`. Cuando una consulta ya tiene un límite de filas y añades otro, EF los combina. Si ambos límites son constantes, se queda con el menor. Si no, llama a `GenerateLeast`, que devuelve una expresión `LEAST` solo en el nivel 160 o superior. Por debajo de 160 devuelve null, y EF recurre a una consulta anidada.

`FirstOrDefaultAsync` añade un límite de 1, y `SingleOrDefaultAsync` un límite de 2. EF parametriza el valor que pasas a `Take`, incluso un literal como `Take(20)`. Así, un repositorio que devuelve un `IQueryable` paginado, seguido de un llamador que pide la primera fila, se ve así:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var first = await db.Products
    .OrderBy(p => p.Id)
    .Take(pageSize)
    .FirstOrDefaultAsync();
```

En el nivel 160 (el valor por defecto de EF Core 11):

```sql
SELECT TOP(LEAST(@p, 1)) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
FROM [Products] AS [p]
ORDER BY [p].[Id]
```

En el nivel 150 (el valor por defecto de EF Core 10):

```sql
SELECT TOP(1) [p0].[Id], [p0].[CreatedAt], [p0].[ListPrice], [p0].[Name], ...
FROM (
    SELECT TOP(@p) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
    FROM [Products] AS [p]
    ORDER BY [p].[Id]
) AS [p0]
ORDER BY [p0].[Id]
```

Con `Skip`, el límite pasa a `OFFSET @p ROWS FETCH NEXT LEAST(@p1, 1) ROWS ONLY`. `Take(n).Take(m)` con dos parámetros produce `TOP(LEAST(@p, @p1))`. `Take(n).AnyAsync()` y `Take(n).CountAsync()` no se ven afectados, porque envuelven la consulta limitada en lugar de apilar un segundo límite. `Take(n).Take(n)` con el mismo parámetro tampoco se ve afectado, porque EF ve dos límites iguales y conserva uno.

En SQL Server 2022 la forma de 160 es simplemente un SQL más corto. En SQL Server 2019 el servidor rechaza `LEAST` como una función integrada desconocida. Este código compilaba, pasaba las pruebas contra un servidor más nuevo y funcionaba en EF Core 10. Por eso una suite de pruebas que se ejecuta contra un contenedor de SQL Server 2022 no te avisará.

## Math.Min, Math.Max y arreglos en línea

En 150, `Math.Max` y `EF.Functions.Greatest` no se pueden traducir en absoluto. En un `Where` u `OrderBy` obtienes la habitual `InvalidOperationException` que te pide reescribir la consulta o pasar a evaluación en el cliente. En la proyección final, EF selecciona en silencio ambas columnas y ejecuta `Math.Min` en el cliente:

```sql
-- level 150: Select(p => new { p.Id, Effective = Math.Min(p.Price, p.ListPrice) })
SELECT [p].[Id], [p].[Price], [p].[ListPrice]
FROM [Products] AS [p]

-- level 160
SELECT [p].[Id], LEAST([p].[Price], [p].[ListPrice]) AS [Effective]
FROM [Products] AS [p]
```

Esa proyección es el segundo cambio silencioso tras actualizar: el mismo LINQ ahora depende de que el servidor tenga `LEAST`.

Los arreglos en línea tenían una alternativa funcional en 150, una subconsulta `VALUES` correlacionada:

```sql
-- level 150: Where(p => new[] { p.Stock, p.ReorderLevel }.Max() > 10)
WHERE (
    SELECT MAX([v].[Value])
    FROM (VALUES ([p].[Stock]), ([p].[ReorderLevel])) AS [v]([Value])) > 10

-- level 160
WHERE GREATEST([p].[Stock], [p].[ReorderLevel]) > 10
```

La semántica de null coincide. `GREATEST` y `LEAST` ignoran los argumentos `NULL` salvo que todos sean `NULL`, igual que `MAX` sobre las filas de `VALUES` y como `Enumerable.Min` sobre un `decimal?[]`. EF también lo comprueba: para un tipo de resultado anulable solo elige `LEAST`/`GREATEST` cuando la función no propaga nulls. Así, `new decimal?[] { p.SalePrice, p.Price }.Min()` se convierte en `LEAST([p].[SalePrice], [p].[Price])` sin cambiar los resultados.

## TrimStart y TrimEnd con caracteres

Recortar sin argumentos es `LTRIM(col)` en todos los niveles. Recortar caracteres específicos necesita la forma de dos argumentos de SQL Server 2022, y EF solo la usa en 160:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var bySku = db.Products.Where(p => p.Sku.TrimStart('0') == "42");
var byName = db.Products.Where(p => p.Name.TrimEnd(' ', '.') == "Widget");
```

```sql
-- level 160
WHERE LTRIM([p].[Sku], N'0') = N'42'
WHERE RTRIM([p].[Name], N' .') = N'Widget'
```

En 150 ambas lanzan "could not be translated". En un `Select` final se ejecutan en el cliente, y en 160 pasan al servidor. Este es el caso que además depende del nivel propio de la base de datos. En SQL Server 2022, la documentación de `LTRIM` exige el nivel de compatibilidad 160 en la base de datos para el argumento characters. Una base de datos restaurada desde 2019 a la que nunca se le subió el nivel lo rechazará, aunque `GREATEST` funcione sin problemas en el mismo servidor.

## ExecuteUpdate sobre columnas JSON

Para tipos complejos mapeados a JSON, asignar a una propiedad una columna `int` o `string` funciona en ambos niveles. Asignarle una columna de otro tipo, como `DateTime`, necesita `JSON_OBJECT`, que también es de SQL Server 2022:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
await db.Products.ExecuteUpdateAsync(s =>
    s.SetProperty(p => p.Details.LastPriceChange, p => p.CreatedAt));
```

En 160 eso se convierte en `JSON_MODIFY([p].[Details], '$.LastPriceChange', JSON_VALUE(JSON_OBJECT('v': [p].[CreatedAt]), '$.v'))`. En 150 EF lanza una excepción. EF Core 10.0.12 lanza un mensaje que te dice qué hacer: "'ExecuteUpdate' cannot set a property in a JSON column to an expression containing a column on SQL Server versions before 2022". EF Core 11 RC 1 lo envuelve en el mensaje genérico "could not be translated, see inner exception".

## Qué no cambia entre 150 y 160

El esquema. `GenerateCreateScript()` devolvió un DDL idéntico en 150 y 160 para un modelo con un tipo complejo JSON. `SupportsJsonType` solo cambia en 170, así que las columnas JSON siguen siendo `nvarchar(max)` y cambiar entre 150 y 160 no genera ninguna migración. Las consultas JSON basadas en `OPENJSON` que necesitan el nivel 130 no se tocan. Todo lo que necesita 170 (el tipo nativo `json`, `JSON_CONTAINS`, `.modify()`) sigue desactivado en ambos niveles.

## Cuándo conservar 160

- **Todos los entornos son SQL Server 2022 o 2025, o Azure SQL / Managed Instance.** Obtienes un SQL más corto para las consultas paginadas, `Math.Min`/`Math.Max` en el servidor y un recorte de caracteres que se traduce en lugar de lanzar una excepción.
- **Antes configurabas `UseCompatibilityLevel(160)` a mano.** Puedes eliminar la llamada. El resultado es el mismo, como mostró la ejecución de control con EF Core 10.
- **Dependías de la evaluación en el cliente de `Math.Min` o `TrimStart('0')` en proyecciones.** Mover ese trabajo al servidor suele ser lo que querías de todos modos.

## Cuándo fijar 150

- **Algún entorno ejecuta SQL Server 2019.** Eso incluye staging, la instalación local de un cliente o una réplica de recuperación ante desastres. La documentación del proveedor de EF Core 11 todavía lista SQL Server 2019 como compatible, pero solo en el nivel 150.
- **Tus bases de datos corren en SQL Server 2022 con nivel 150 en la base de datos, y no controlas eso.** Por ejemplo, un proveedor es dueño de la base de datos y no subirá el nivel porque 160 cambia los planes de consulta. `GREATEST`/`LEAST` seguirían funcionando ahí, pero `LTRIM`/`RTRIM` con caracteres no. Fijar 150 es la única configuración del lado de EF que cubre ambos casos.
- **Distribuyes un mismo binario a muchos inquilinos con versiones desconocidas de SQL Server.** Elige el nivel que pueda ejecutar el servidor compatible más antiguo.

## Haz explícito el nivel y compruébalo al iniciar

La propia documentación del proveedor de Microsoft recomienda configurar el nivel de forma explícita, y este cambio de valor por defecto es una buena razón para seguir ese consejo. Léelo de la configuración para que cada entorno declare qué ejecuta:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
var level = builder.Configuration.GetValue("Database:CompatibilityLevel", 150);

builder.Services.AddDbContext<Shop>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop"),
        sql => sql.UseCompatibilityLevel(level)));
```

Luego falla rápido si el nivel configurado pide más de lo que el servidor puede dar:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<Shop>();

    // EngineEdition 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
    var engineEdition = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [Value]")
        .SingleAsync();
    var serverMajor = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [Value]")
        .SingleAsync();
    var databaseLevel = await db.Database
        .SqlQuery<int>($"SELECT CAST(compatibility_level AS int) AS [Value] FROM sys.databases WHERE name = DB_NAME()")
        .SingleAsync();

    // SQL Server 2019 = 15, 2022 = 16, 2025 = 17; the matching levels are 150, 160, 170
    var isAzure = engineEdition is 5 or 8;
    if ((!isAzure && level > serverMajor * 10) || level > databaseLevel)
        throw new InvalidOperationException(
            $"EF is configured for compatibility level {level}, but the server is version {serverMajor} " +
            $"and the database is at level {databaseLevel}.");
}
```

Azure SQL no informa una versión de SQL Server empaquetada que puedas comparar de esta forma, así que ahí la comprobación se basa solo en el nivel de la base de datos. La comparación con el nivel de la base de datos es más estricta de lo necesario para `LEAST`/`GREATEST`. La prefiero, porque `LTRIM` con caracteres sí depende del nivel de la base de datos, y una comprobación que solo cubre la mitad de los casos es peor que ninguna. Ejecuta la misma comprobación en tus pruebas de integración contra un contenedor con la versión *más antigua* del servidor que soportas, no la más nueva.

## La recomendación, de nuevo

El nivel 160 es el valor por defecto correcto en 2026. SQL Server 2022 lleva casi cuatro años disponible, y el SQL es mejor. Pero el valor por defecto es una suposición sobre tu servidor, y para un equipo que usa SQL Server 2019 es incorrecto de una forma que ningún compilador, analizador ni migración te señalará. La primera señal es un error de SQL en runtime en consultas que funcionaban en EF Core 10. Así que configura `UseCompatibilityLevel` de forma explícita en cada aplicación que migres a EF Core 11: 160 o superior si todos los servidores son 2022+, 150 si aunque sea uno no lo es.

## Relacionado

- El paso a 170 es mucho mayor, porque cambia los tipos de columna: [columna json nativa vs nvarchar(max) en EF Core 11](/es/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/).
- Si vienes de una versión anterior, [los cambios disruptivos de EF Core 6 a 11 que realmente duelen](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre las demás traducciones que dependen de la versión.
- Los fallos del nivel 150 de este artículo son el clásico [error de que la expresión LINQ no se pudo traducir](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), y las reescrituras de allí aplican.
- Para ver qué SQL envía realmente tu aplicación tras actualizar, [registra el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Para detectar la discrepancia de versión del servidor en CI, [ejecuta pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), fijado a tu versión de producción más antigua.

## Fuentes

- [Cambios disruptivos de EF Core 11: el nivel de compatibilidad de SQL Server ahora es 160 por defecto](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes#sqlserver-compatibility-level-160)
- [dotnet/efcore#38198: subir el nivel de compatibilidad por defecto de SQL Server de 150 a 160](https://github.com/dotnet/efcore/issues/38198)
- [dotnet/efcore#38196: Math.Min/Max no se traducen con el antiguo nivel por defecto](https://github.com/dotnet/efcore/issues/38196)
- [Proveedor de SQL Server para EF Core: nivel de compatibilidad](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/#compatibility-level)
- [ALTER DATABASE nivel de compatibilidad: niveles admitidos y diferencias entre 150 y 160](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql)
- [LTRIM (Transact-SQL): el argumento characters requiere el nivel de compatibilidad 160](https://learn.microsoft.com/en-us/sql/t-sql/functions/ltrim-transact-sql)
- Código fuente de EF Core en la etiqueta `v11.0.0-rc.1.26425.128`: `SqlServerSqlTranslatingExpressionVisitor.GenerateGreatest`/`GenerateLeast`, `RelationalQueryableMethodTranslatingExpressionVisitor.ApplyLimit`, `SqlServerStringMethodTranslator.TranslateTrimStartEnd`, `SqlServerSingletonOptions`
