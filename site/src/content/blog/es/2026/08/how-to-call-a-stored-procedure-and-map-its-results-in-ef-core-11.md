---
title: "Cómo llamar a un procedimiento almacenado y mapear sus resultados en EF Core 11"
description: "Usa FromSql sobre un DbSet cuando el procedimiento devuelve filas completas de una entidad, Database.SqlQuery<T> cuando devuelve una proyección, y ExecuteSql cuando no devuelve nada. Nunca encadenes un operador LINQ sobre un EXEC, y nunca leas un parámetro de salida antes de que el lector se haya liberado."
pubDate: 2026-08-10
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-10
---

Respuesta corta: EF Core 11 te da tres puntos de entrada para llamar a un procedimiento almacenado, y elegir el equivocado es lo que causa la mayor parte del dolor. Usa `FromSql` sobre un `DbSet<T>` cuando el procedimiento devuelve todas las columnas de una entidad mapeada. Usa `Database.SqlQuery<T>` cuando devuelve una proyección que no es una entidad, algo que funciona para DTOs arbitrarios desde EF Core 8. Usa `Database.ExecuteSql` cuando no devuelve ningún conjunto de resultados. Dos reglas aplican a los tres casos: no puedes encadenar un operador LINQ sobre un `EXEC`, y el `Value` de un parámetro de salida es null hasta que el lector subyacente se haya liberado.

Este artículo cubre las tres APIs, las excepciones exactas que obtienes cuando las usas mal, los parámetros de salida y de retorno, los múltiples conjuntos de resultados, y el comportamiento de seguimiento que sorprende a la gente.

Todo lo que sigue se midió contra SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) usando EF Core 10.0.10 sobre el SDK de .NET 10.0.201, ya que EF Core 11 requiere el runtime de .NET 11, que no está instalado en esta máquina. Eso importa menos de lo habitual aquí: EF Core 11 no introduce ningún cambio en `FromSql`, `SqlQuery` ni `ExecuteSql`, y las [notas de la versión de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) no contienen ninguna entrada sobre procedimientos almacenados. Cada mensaje de excepción y cada comportamiento citado aquí es idéntico en EF Core 8, 9, 10 y 11. Donde una afirmación proviene de la documentación en lugar de una medición, lo indico.

El esquema para todos los ejemplos:

```sql
-- SQL Server 2022
CREATE TABLE Blogs (
    Id         int NOT NULL IDENTITY PRIMARY KEY,
    Name       nvarchar(200) NOT NULL,
    Rating     int NOT NULL,
    OwnerEmail nvarchar(200) NULL
);

CREATE PROCEDURE dbo.GetTopBlogs @MinRating int AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs
    WHERE Rating >= @MinRating ORDER BY Rating DESC;
END
```

Fíjate en el `SET NOCOUNT ON`. Sin él, SQL Server emite un mensaje de filas afectadas antes del conjunto de resultados, que algunos controladores exponen como un conjunto de resultados vacío fantasma. No cuesta nada y evita toda una categoría de errores confusos.

## Cuando el procedimiento devuelve filas de entidad: FromSql

`FromSql` es un método de extensión sobre `DbSet<T>`, y es la llamada correcta cuando el conjunto de resultados de tu procedimiento coincide columna por columna con una entidad mapeada:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .ToListAsync();
```

Ese hueco interpolado no es concatenación de cadenas. `FromSql` recibe un `FormattableString` y convierte cada hueco en un `DbParameter`, así que esto es seguro frente a inyección SQL. Puedes ver exactamente qué se envía llamando a `ToQueryString()`:

```text
DECLARE p0 int = 3;

EXEC dbo.GetTopBlogs @MinRating = @p0
```

EF pasó el SQL tal cual. No hay ninguna subconsulta envolvente, que es justamente la razón de ser de la siguiente sección.

Los resultados vuelven con seguimiento, exactamente igual que una consulta LINQ. Medí tres entidades en el rastreador de cambios tras la llamada a un procedimiento de tres filas. Agrega `AsNoTracking()` para rutas de solo lectura, y funciona bien aquí porque no cambia nada del SQL:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsNoTracking()
    .ToListAsync();
```

Para parámetros con nombre, que importan cuando un procedimiento tiene parámetros opcionales, envuelve el valor en un `SqlParameter` y referéncialo por nombre:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("min", 3);

var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {minRating}")
    .AsNoTracking()
    .ToListAsync();
```

Reutilizar una única instancia de `SqlParameter` en dos ejecuciones consecutivas funciona, en contra de una creencia común heredada de ADO.NET puro, donde un parámetro solo puede pertenecer a la colección de un comando. Pasé la misma instancia por dos llamadas a `FromSqlRaw` seguidas sin ninguna excepción.

### El conjunto de resultados debe contener todas las columnas mapeadas

Este es el fallo que la gente encuentra primero. Quita `OwnerEmail` del `SELECT` del procedimiento y la consulta muere:

```text
InvalidOperationException: The required column 'OwnerEmail' was not present
in the results of a 'FromSql' operation.
```

EF materializa la entidad completa, así que el lector tiene que suministrar todas las propiedades mapeadas, incluidas las propiedades sombra y los discriminadores. Los nombres de columna deben coincidir con los nombres de columna mapeados, no con los nombres de las propiedades, lo cual es un cambio de comportamiento real respecto a EF6. El orden no importa y la coincidencia no distingue mayúsculas de minúsculas. Si no puedes modificar el procedimiento para que devuelva las columnas faltantes, no estás devolviendo una entidad, y deberías usar `SqlQuery<T>` en su lugar. Analicé esa excepción concreta con más profundidad en [la guía sobre el error de columna faltante en FromSql](/es/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

### No puedes componer LINQ sobre un EXEC

Esto es lo segundo con lo que todos tropiezan. SQL Server no puede anidar una llamada a un procedimiento dentro de una subconsulta, así que en el momento en que agregas un operador que modifica el SQL, EF se rinde:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .Where(b => b.Rating > 4)          // composition
    .ToListAsync();
```

```text
InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable
SQL and with a query composing over it. Consider calling 'AsEnumerable' after the
method to perform the composition on the client side.
```

La misma excepción se dispara con `Include`, `OrderBy`, `Skip`/`Take`, y con un `First()` o `Single()` a secas, ya que todos ellos añaden `TOP` u `ORDER BY`. Confirmé que `Include` también la lanza, así que la carga eager de una navegación a partir de una llamada a un procedimiento no está disponible.

La solución es la que nombra el propio mensaje. Inserta `AsEnumerable()` (o `AsAsyncEnumerable()`) directamente después de `FromSql` para trazar una línea explícita entre lo que hace la base de datos y lo que hace tu proceso:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsEnumerable()                    // everything after this runs in memory
    .Where(b => b.Rating > 4)
    .ToList();
```

Sé honesto contigo mismo sobre lo que eso cuesta: cada fila que devuelve el procedimiento cruza la red y se materializa antes de que se ejecute el `Where`. Si el procedimiento devuelve 200 000 filas y te quedas con cuatro, empuja el filtro dentro del procedimiento como un parámetro. `AsEnumerable` es una corrección de exactitud, no de rendimiento.

El seguimiento de cambios sigue aplicándose después de `AsEnumerable`, lo cual confunde a la gente. El límite del lado del cliente solo mueve los operadores de consulta; la materialización ya ocurrió del lado de EF. Medí tres entidades con seguimiento tras `FromSql(...).AsEnumerable().ToList()`. Agrega `AsNoTracking()` antes de `AsEnumerable()` si no las quieres.

Por contraste, un `SELECT` componible sí se envuelve y se empuja hacia abajo, que es lo que hace a `FromSql` genuinamente útil para SQL que no sea un procedimiento:

```csharp
// .NET 11, C# 14, EF Core 11
var q = context.Blogs
    .FromSql($"SELECT * FROM Blogs WHERE Rating >= {3}")
    .Where(b => b.Name.StartsWith("S"));
```

```sql
SELECT [b].[Id], [b].[Name], [b].[OwnerEmail], [b].[Rating]
FROM (
    SELECT * FROM Blogs WHERE Rating >= @p0
) AS [b]
WHERE [b].[Name] LIKE N'S%'
```

Esa es toda la distinción. El SQL componible empieza con `SELECT` y sobrevive a convertirse en una subconsulta; `EXEC` no.

## Cuando el procedimiento devuelve una proyección: SqlQuery&lt;T&gt;

La mayoría de los procedimientos almacenados reales no devuelven filas de entidad. Devuelven una forma de informe: un join, un `GROUP BY`, algunas columnas calculadas. Para esos, `Database.SqlQuery<T>` mapea el conjunto de resultados sobre un tipo CLR plano que no está en tu modelo en absoluto. Esta es la API que la mayoría de los artículos sobre el tema siguen describiendo como exclusiva para escalares; eso dejó de ser cierto en EF Core 8, que la extendió a [cualquier tipo CLR mapeable](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types).

```sql
CREATE PROCEDURE dbo.GetBlogStats @MinViews int AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.Name AS BlogName, COUNT(p.Id) AS PostCount, SUM(p.Views) AS TotalViews
    FROM Blogs b JOIN Posts p ON p.BlogId = b.Id
    WHERE p.Views >= @MinViews
    GROUP BY b.Name;
END
```

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
    public int TotalViews { get; set; }
}

var stats = await context.Database
    .SqlQuery<BlogStat>($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`BlogStat` no necesita ningún `DbSet`, ninguna entrada en `OnModelCreating` ni atributos. Cosas que verifiqué sobre cómo se comporta el mapeo:

- **La coincidencia es por nombre de columna, no por posición.** Devolví las tres columnas en orden desordenado y cada propiedad aterrizó correctamente.
- **La coincidencia no distingue mayúsculas de minúsculas.** Tanto `blogname` como `POSTCOUNT` se enlazaron bien.
- **Las columnas extra del conjunto de resultados se ignoran.** Agregar una cuarta columna `Surprise` no lanzó excepción, pese a que la documentación dice que el tipo "debe tener una propiedad para cada valor del conjunto de resultados". No te apoyes en esto; es comportamiento no documentado, no un contrato.
- **Una columna faltante es fatal.** Quita `TotalViews` del `SELECT` y obtienes el mismo mensaje `The required column 'TotalViews' was not present in the results of a 'FromSql' operation.` que en la ruta de entidad.
- **Un null en una propiedad no anulable lanza** `SqlNullValueException: Data is Null. This method or property cannot be called on Null values.` Declara la propiedad como anulable, o usa `COALESCE` en SQL.

Usa `[Column("...")]` cuando el nombre de una columna del resultado no pueda coincidir con el nombre de tu propiedad:

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    [Column("blog_name")]
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
}
```

La regla de no componibilidad aplica aquí de forma idéntica. `SqlQuery<T>(...).Where(...)` sobre un `EXEC` lanza exactamente la misma excepción de no componibilidad, y `AsEnumerable()` es la misma solución.

Para un único escalar, `SqlQuery<T>` con un tipo primitivo funciona directamente:

```csharp
// .NET 11, C# 14, EF Core 11
var count = (await context.Database
    .SqlQuery<int>($"EXEC dbo.GetBlogCount")
    .ToListAsync()).Single();
```

La documentación de EF Core te dice que alias la columna de salida como `AS Value` para un `SqlQuery` escalar. Ese requisito solo aplica cuando compones LINQ sobre la consulta, porque EF necesita un nombre al que referirse desde el `SELECT` externo que genera. Llamar a un procedimiento sin composición no necesita alias; confirmé que un `SELECT COUNT(*)` sin alias se enlaza bien.

### La alternativa del tipo de entidad sin clave

Antes de EF Core 8, la única forma de mapear una forma de resultado que no fuera una entidad era un tipo de entidad sin clave, y sigue siendo la mejor opción cuando la forma es parte de tu dominio y quieres poder consultarla como un `DbSet`:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<BlogStat>().HasNoKey().ToView(null);
}

var stats = await context.Set<BlogStat>()
    .FromSql($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`ToView(null)` le dice a EF que el tipo no tiene tabla de respaldo, así que las migraciones no intentarán crear una. Los tipos sin clave nunca reciben seguimiento de cambios, algo que confirmé: cero entradas tras materializar tres filas. Recurre a `SqlQuery<T>` para informes puntuales y a un tipo sin clave cuando la forma se reutiliza en toda la aplicación o necesita [una consulta generada por EF además de un procedimiento](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types).

## Cuando el procedimiento no devuelve nada: ExecuteSql

Para un procedimiento que solo escribe, usa `ExecuteSql`. Devuelve el número de filas afectadas, no nada que el procedimiento haya calculado:

```csharp
// .NET 11, C# 14, EF Core 11
var rowsAffected = await context.Database
    .ExecuteSqlAsync($"EXEC dbo.BumpRatings @By = {1}");
```

`ExecuteSql` parametriza igual que `FromSql`; `ExecuteSqlRaw` es la vía de escape cuando debes construir SQL dinámicamente. Esta es una herramienta distinta de [`ExecuteUpdate` y `ExecuteDelete` para escrituras masivas](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), que generan SQL a partir de LINQ en lugar de llamar a algo que tú escribiste.

Una advertencia importante: `ExecuteSql` se ejecuta fuera del rastreador de cambios. Las filas que modifica en la base de datos no se reflejan en las entidades que el contexto ya cargó, así que un `SaveChanges` posterior puede escribir valores obsoletos encima de ellas. Llámalo antes de cargar, o usa `Reload()` sobre las entradas afectadas después.

## Parámetros de salida, y el problema de sincronización que muerde a todos

Un procedimiento que devuelve tanto un conjunto de resultados como un parámetro de salida es un patrón habitual para la paginación:

```sql
CREATE PROCEDURE dbo.GetTopBlogsWithCount @MinRating int, @TotalCount int OUTPUT AS
BEGIN
    SET NOCOUNT ON;
    SELECT @TotalCount = COUNT(*) FROM Blogs;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs WHERE Rating >= @MinRating;
END
```

Los parámetros de salida necesitan instancias explícitas de `SqlParameter` y `FromSqlRaw`, porque tienes que establecer `Direction` tú mismo:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("MinRating", SqlDbType.Int) { Value = 3 };
var totalCount = new SqlParameter("TotalCount", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};

var blogs = await context.Blogs
    .FromSqlRaw("EXEC dbo.GetTopBlogsWithCount @MinRating, @TotalCount OUTPUT",
        minRating, totalCount)
    .ToListAsync();

var total = (int)totalCount.Value;   // only valid after ToListAsync
```

Fíjate en la palabra clave `OUTPUT` en el texto SQL. Si la omites, SQL Server trata el parámetro como de solo entrada y devuelve nada en silencio.

Ahora la parte que le cuesta una tarde a la gente. `totalCount.Value` es `null` hasta que el `DbDataReader` se cierra, porque es entonces cuando SQL Server envía los valores de los parámetros de salida por el cable. Medido directamente:

```text
before enumeration:  total.Value = null
mid-enumeration:     total.Value = null
after dispose:       total.Value = 5
```

Leer `totalCount.Value` en la línea siguiente a construir la consulta te da `null` y una `NullReferenceException` en la conversión. Tiene que ir después de que la enumeración termine. `ToListAsync()`, `First()` sobre un `AsEnumerable()`, y `await foreach` sobre `AsAsyncEnumerable()` funcionan todos, porque cada uno libera el lector.

El corolario es peor. Si tomas un enumerador y nunca lo liberas, obtienes dos fallos a la vez:

```csharp
// .NET 11, C# 14, EF Core 11 - do not do this
var e = context.Blogs
    .FromSqlRaw("EXEC dbo.ManyRowsWithCount @Total OUTPUT", total)
    .AsEnumerable().GetEnumerator();
e.MoveNext();                        // reader is open and never closed
```

`total.Value` se queda en `null`, y la siguiente consulta sobre ese `DbContext` falla con `InvalidOperationException: There is already an open DataReader associated with this Connection which must be closed first.` Me topé con esto accidentalmente durante las pruebas y rompió todas las consultas posteriores sobre el contexto. Si enumeras manualmente, envuélvelo en un `using`.

## Obtener el valor de RETURN, que no es el parámetro de salida

Un `RETURN 42` de T-SQL es un tercer canal, distinto de los parámetros de salida y de los conjuntos de resultados. El enfoque obvio no funciona:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
```

```text
SqlException: Must declare the scalar variable "@ret".
```

`ParameterDirection.ReturnValue` solo se entiende cuando el comando es un `CommandType.StoredProcedure` real, y EF siempre envía `CommandType.Text`. Dos cosas sí funcionan. La más simple es declarar el parámetro como `Output` y dejar que la sintaxis `EXEC @ret =` lo enlace:

```csharp
// .NET 11, C# 14, EF Core 11
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};
var by = new SqlParameter("By", SqlDbType.Int) { Value = 1 };

context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
var returnValue = (int)ret.Value;   // 42
```

La otra es bajar a un `DbCommand` puro sobre la conexión de EF, que además te da `CommandType.StoredProcedure` y, por tanto, soporte real de `ReturnValue`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.BumpRatings";
cmd.CommandType = CommandType.StoredProcedure;
cmd.Parameters.Add(new SqlParameter("@By", SqlDbType.Int) { Value = 1 });
var ret = new SqlParameter("@ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
cmd.Parameters.Add(ret);

await cmd.ExecuteNonQueryAsync();
var returnValue = (int)ret.Value;   // 42
```

Ambos devolvieron 42. Usa el primero salvo que necesites `CommandType.StoredProcedure` por otra razón. Si abres la conexión tú mismo, recuerda que EF no la cerrará por ti.

## Los múltiples conjuntos de resultados siguen sin estar soportados

Si tu procedimiento devuelve dos conjuntos de resultados, EF lee el primero y descarta el resto en silencio. Sin excepción, sin advertencia. Llamé a un procedimiento que devolvía blogs y posts a través de `FromSql` y obtuve tres blogs de vuelta, con los cinco posts tirados a la basura.

[FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127) lleva abierto desde abril de 2017 y está en el hito Backlog, así que no llegará en EF Core 11. La alternativa es un `DbDataReader` puro y `NextResult()`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.TwoResultSets";
cmd.CommandType = CommandType.StoredProcedure;

await using var reader = await cmd.ExecuteReaderAsync();

var blogs = new List<Blog>();
while (await reader.ReadAsync())
    blogs.Add(new Blog { Id = reader.GetInt32(0), Name = reader.GetString(1) });

await reader.NextResultAsync();

var posts = new List<Post>();
while (await reader.ReadAsync())
    posts.Add(new Post { Id = reader.GetInt32(0), Title = reader.GetString(2) });
```

Eso devolvió tres blogs y cinco posts, correctamente separados. Pierdes la materialización y el seguimiento de EF; si quieres seguimiento, adjunta los resultados manualmente. A este nivel de trabajo manual, `QueryMultiple` de Dapper es algo razonable a lo que recurrir, y las contrapartidas son las que medí en [consultas compiladas vs SQL puro vs Dapper](/es/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/).

## Mapear inserciones, actualizaciones y eliminaciones a procedimientos

Todo lo anterior trata sobre consultar. La dirección inversa, hacer que `SaveChanges` llame a tus procedimientos en lugar de generar `INSERT`/`UPDATE`/`DELETE`, es una funcionalidad aparte añadida en EF Core 7 y sin cambios en la 11:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Person>()
    .InsertUsingStoredProcedure(
        "People_Insert",
        spb =>
        {
            spb.HasParameter(p => p.Name);
            spb.HasResultColumn(p => p.Id);
        })
    .DeleteUsingStoredProcedure(
        "People_Delete",
        spb =>
        {
            spb.HasOriginalValueParameter(p => p.Id);
            spb.HasRowsAffectedResultColumn();
        });
```

Vale la pena conocer dos cosas de la documentación antes de comprometerte con esto. Los parámetros deben declararse en el mismo orden en que aparecen en la definición del procedimiento, porque EF siempre invoca posicionalmente y no por nombre. Y los parámetros de valor original son obligatorios para los valores de clave en los procedimientos de actualización y eliminación. No ejercité esta ruta contra una base de datos, así que trata el ejemplo como procedente de la documentación.

El equipo de EF es directo sobre esta funcionalidad en sus propias notas de versión: el soporte para el mapeo de procedimientos almacenados no implica que los procedimientos almacenados sean recomendables.

## Elegir la API correcta

Si el procedimiento devuelve filas de entidad completas, usa `FromSql` sobre el `DbSet` y acepta el seguimiento. Si devuelve una proyección, usa `Database.SqlQuery<T>` con un DTO plano, o un tipo de entidad sin clave cuando la forma se reutiliza. Si no devuelve nada, usa `ExecuteSql`. Si devuelve múltiples conjuntos de resultados o un valor de `RETURN` que necesitas, baja a un `DbCommand`.

Elijas lo que elijas, pon `AsEnumerable()` después de la llamada en cuanto quieras filtrar, y lee los parámetros de salida solo después de que la enumeración haya terminado. Esas dos reglas cubren la mayoría de las preguntas sobre este tema.

## Relacionados

- [Fix: la columna requerida no estaba presente en los resultados de una operación FromSql](/es/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Consultas compiladas de EF Core vs SQL puro vs Dapper](/es/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: la expresión LINQ no se pudo traducir en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Cómo registrar el SQL que genera EF Core 11](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)

## Fuentes

- [SQL Queries, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Raw SQL queries for unmapped types, novedades de EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)
- [Keyless entity types, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [Stored procedure mapping, novedades de EF Core 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/whatsnew#stored-procedure-mapping)
- [Novedades de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [dotnet/efcore#8127, FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127)
- [RelationalStrings.FromSqlNonComposable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationalstrings.fromsqlnoncomposable)
