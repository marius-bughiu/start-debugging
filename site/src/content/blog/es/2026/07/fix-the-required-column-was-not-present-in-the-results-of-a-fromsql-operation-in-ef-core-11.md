---
title: "Solución: \"The required column 'X' was not present in the results of a 'FromSql' operation\" en EF Core 11"
description: "EF Core lanza esto cuando tu SQL en crudo no devuelve todas las columnas que mapea la entidad, o los nombres no coinciden. Devuelve todas las columnas mapeadas con nombres coincidentes, o consulta un tipo escalar o sin clave."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "es"
translationOf: "2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core lanza `The required column 'X' was not present in the results of a 'FromSql' operation` cuando el SQL en crudo que pasaste a `FromSql`, `FromSqlRaw` o `FromSqlInterpolated` no devuelve una columna que el tipo de entidad de destino mapea. El materializador lee los resultados por nombre de columna mapeada, así que la columna de cada propiedad tiene que estar en el conjunto de resultados, escrita como EF espera. Corrígelo devolviendo todas las columnas mapeadas (`SELECT *` o una lista explícita con alias coincidentes) o, si solo quieres un subconjunto o una forma arbitraria, cambia a `Database.SqlQuery<T>` o a un tipo de entidad sin clave en lugar de una entidad completa. Esto aplica a `Microsoft.EntityFrameworkCore` 11.0 en .NET 11 con C# 14, y la regla ha sido la misma desde EF Core 3.0.

## El error en contexto

La excepción completa en tiempo de ejecución se ve así:

```
System.InvalidOperationException: The required column 'Description' was not present in the results of a 'FromSql' operation.
   at Microsoft.EntityFrameworkCore.Query.Internal.RelationalCommandCache...
   at lambda_method(Closure, QueryContext, DbDataReader, ResultContext, ...)
```

El tipo de excepción es `System.InvalidOperationException`, y se lanza mientras se leen los resultados, no cuando construyes la consulta. Eso significa que la traza de pila apunta al pipeline de materialización de EF Core (un `lambda_method` y `RelationalCommandCache`), no a tu cadena SQL. La única pieza útil de información es el nombre de columna entre comillas: `'Description'`. Esa es la columna mapeada que EF buscó en el lector y no pudo encontrar por nombre.

## Por qué ocurre

Cuando `FromSql` devuelve un tipo de entidad mapeado, EF Core no lee las columnas por posición ordinal. Las lee por nombre. Para cada propiedad de la entidad le pide al `DbDataReader` "dame el ordinal de la columna llamada `Description`", y si el lector no tiene tal columna, esa llamada falla y EF la expone como este error. La documentación establece la restricción directamente: la consulta SQL debe devolver datos para todas las propiedades del tipo de entidad, y los nombres de columna del conjunto de resultados deben coincidir con los nombres de columna a los que están mapeadas las propiedades.

Tres cosas lo provocan, en orden aproximado de frecuencia:

- **A la lista SELECT le falta una columna.** Escribiste `SELECT Id, Title FROM Articles` pero la entidad `Article` también mapea una propiedad `Description`. EF quiere `Description` y no está.
- **El nombre de una columna no coincide con el nombre mapeado.** El SQL devuelve `article_description` (o una expresión sin alias, o `Col2` de un procedimiento almacenado generado por scaffolding) pero la propiedad mapea a la columna `Description`. El mismo fallo, y el nombre entre comillas del mensaje es el que EF quería, no el que produjo tu SQL, por lo que el mensaje puede parecer engañoso.
- **Falta una columna de sombra o de tipo owned.** Las claves foráneas sin propiedad CLR, los tokens de concurrencia `[Timestamp]`/rowversion y las columnas de tipos owned están todas mapeadas y todas son obligatorias. Es fácil olvidarlas porque son invisibles en la clase de entidad.

Esta es una decisión de diseño deliberada, no un error. EF6 ignoraba el mapeo propiedad-columna para SQL en crudo y coincidía por nombre de propiedad de forma laxa; EF Core lo hizo estricto para que una consulta de entidad en crudo se comporte exactamente como una normal y pueda ser rastreada, corregida y compuesta de forma segura.

## Reproducción mínima

Aquí está el programa más pequeño que lo reproduce. La entidad mapea tres columnas; el SQL devuelve dos:

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

EF Core mapea `Article` a tres columnas: `Id`, `Title`, `Description`. El lector que vuelve de `SELECT Id, Title` tiene solo dos de ellas, así que la materialización falla en el momento en que `ToListAsync` empieza a leer filas, con `'Description' was not present`.

## La solución, en detalle

Las soluciones están ordenadas de la mejor (devolver una entidad real y completa) a las alternativas que usas cuando realmente no quieres la entidad completa.

### 1. Devuelve todas las columnas mapeadas

Si quieres recibir entidades `Article` rastreadas, el SQL tiene que producir todas las columnas que la entidad mapea. La forma correcta más simple es `SELECT *` contra la tabla (o una vista/TVF cuyas columnas encajen):

```csharp
// .NET 11, EF Core 11 -- returns Id, Title, Description: all three mapped columns
var articles = await db.Articles
    .FromSql($"SELECT * FROM Articles")
    .ToListAsync();
```

`SELECT *` está bien aquí precisamente porque EF coincide por nombre, así que el orden de las columnas no importa y las columnas extra se ignoran. Si prefieres una lista explícita (más segura frente a la deriva de esquema y más clara en la revisión de código), lista todas las columnas mapeadas y asegúrate de que no falte ninguna:

```csharp
// .NET 11, EF Core 11 -- explicit, complete column list
var articles = await db.Articles
    .FromSql($"SELECT Id, Title, Description FROM Articles WHERE Title LIKE {'%' + term + '%'}")
    .ToListAsync();
```

Recuerda que "todas las columnas mapeadas" incluye columnas sin una propiedad CLR obvia: claves foráneas de sombra, un token de concurrencia `RowVersion`, columnas discriminadoras para la herencia TPH. Si tu entidad tiene un `[Timestamp] public byte[] RowVersion` o un discriminador de herencia, esa columna también debe estar en el conjunto de resultados.

### 2. Da alias a las columnas para que los nombres coincidan

Cuando el SQL no puede usar los nombres mapeados directamente, por ejemplo un procedimiento almacenado o una tabla heredada que devuelve `article_desc`, da alias a las columnas de salida con los nombres que EF espera. La coincidencia no distingue mayúsculas y minúsculas, pero el nombre tiene que estar presente:

```csharp
// .NET 11, EF Core 11 -- alias legacy names onto mapped column names
var articles = await db.Articles
    .FromSqlRaw(@"SELECT article_id AS Id,
                         article_title AS Title,
                         article_desc AS Description
                  FROM legacy_articles")
    .ToListAsync();
```

Si prefieres cambiar el mapeo en lugar del SQL, mapea la propiedad al nombre de columna real con `[Column("article_desc")]` o `HasColumnName("article_desc")` en `OnModelCreating`, y entonces el SQL en crudo que devuelve `article_desc` coincide sin alias. Elige un lado; no pelees contigo mismo en ambos.

### 3. Consulta un escalar o proyección con `SqlQuery<T>`

Si solo quieres un par de campos, no fuerces una entidad completa. `Database.SqlQuery<T>` (EF Core 7.0+, sigue siendo la API actual en 11.0) lee un tipo arbitrario sin la regla de "todas las columnas mapeadas". Para una sola columna escalar:

```csharp
// .NET 11, EF Core 11 -- no entity involved, so no missing-column rule
var titles = await db.Database
    .SqlQuery<string>($"SELECT Title FROM Articles WHERE Id > {minId}")
    .ToListAsync();
```

Para una forma de varias columnas, declara un record plano cuyos nombres de propiedad coincidan con las columnas de resultado (posiblemente con alias) y consúltalo. Este tipo no forma parte de tu modelo, así que EF no exige nada sobre completitud:

```csharp
// .NET 11, EF Core 11 -- lightweight read model, matched by name
public record ArticleSummary(int Id, string Title);

var summaries = await db.Database
    .SqlQuery<ArticleSummary>($"SELECT Id, Title FROM Articles")
    .ToListAsync();
```

`SqlQuery<T>` nunca rastrea resultados, que es exactamente lo que quieres para un resumen de solo lectura. Es la herramienta correcta en el momento en que te descubres queriendo una entidad parcial.

### 4. Modela el resultado como un tipo de entidad sin clave

Para una forma que reutilizas en toda la aplicación, especialmente la salida de una vista o un procedimiento almacenado de reportes, declara un tipo de entidad sin clave. Participa en el modelo (así que puedes usar `Include` y componer sobre él en algunos casos) pero no tiene clave y nunca se rastrea. Configúralo con `HasNoKey`:

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

Un tipo de entidad sin clave sigue requiriendo que sus propias columnas mapeadas estén presentes, pero tú controlas ese mapeo, así que lo dimensionas exactamente a las columnas que tu SQL devuelve en lugar de a una entidad de tabla completa.

## Detalles y variantes

**La columna entre comillas no es la que falta en tu SQL.** Como EF coincide por nombre, si tu SQL devuelve `Desc` y la entidad mapea `Description`, el mensaje dice `'Description' was not present`, no `'Desc' was unexpected`. Compara la lista de columnas que tu consulta realmente devuelve con las columnas mapeadas de la entidad, y busca la discrepancia en vez de confiar en que la columna nombrada esté literalmente ausente. Esta confusión exacta está registrada en [dotnet/efcore issue #33748](https://github.com/dotnet/efcore/issues/33748).

**Los procedimientos almacenados generados por scaffolding producen `Col1`, `Col2`.** Cuando un procedimiento almacenado devuelve una columna calculada sin nombre (`SELECT COUNT(*)` en lugar de `SELECT COUNT(*) AS Total`), las herramientas de ingeniería inversa la nombran `Col0`, `Col1`, etc., y entonces el tipo de resultado generado espera esos nombres. Da un alias explícito a cada columna en el procedimiento y el problema desaparece en su origen.

**Un procedimiento almacenado que proyecta un subconjunto.** `EXECUTE dbo.GetArticleTitles` que devuelve solo `Id, Title` no puede materializar un `Article` completo. No lo pases por `context.Articles.FromSql`; pásalo por `Database.SqlQuery<T>` o un tipo sin clave dimensionado a lo que el procedimiento devuelve. Recuerda también que no puedes componer LINQ sobre una llamada a procedimiento almacenado, así que añade `AsEnumerable()` justo después de `FromSql` si necesitas más trabajo en memoria.

**Tipos owned y división de tabla.** Si `Article` posee un objeto de valor tipo `Address` almacenado en la misma tabla, las columnas del tipo owned forman parte de la entidad y deben estar en el conjunto de resultados. Omitirlas provoca el mismo error para una columna que quizá no te das cuenta de que existe. Inclúyelas o divide la lectura en una proyección sin clave.

**Funcionaba antes de una actualización desde EF6.** EF6 coincidía los resultados de SQL en crudo por nombre de propiedad y era laxo con columnas faltantes o mal nombradas. EF Core es estricto. Si estás moviendo una base de código a través de esa frontera, este es uno de varios comportamientos de SQL en crudo que cambiaron, y va de la mano con el conjunto más amplio de [cambios disruptivos que realmente muerden al migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Un `NULL` en una columna no anulable es un error distinto.** Si la columna está presente pero el valor es `NULL` y la propiedad es un tipo de valor no anulable, obtienes una `System.Data.SqlTypes.SqlNullValueException` o un error de materialización sobre convertir null, no este. Ese es un problema de datos, no de forma; haz la propiedad anulable o usa `ISNULL`/`COALESCE` en SQL.

El modelo mental que te mantiene fuera de este error para siempre: `FromSql` sobre un `DbSet<T>` es una promesa de devolver un `T` completo y correctamente nombrado. Si no puedes o no quieres mantener esa promesa, no uses una entidad. Usa `SqlQuery<T>` para escalares y records ad-hoc, o un tipo sin clave para una forma que nombras y reutilizas. Reserva `context.Set<T>().FromSql` para el caso en que el SQL realmente hidrata toda la entidad.

## Relacionados

- [Solución: "The LINQ expression could not be translated" en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) es el error hermano que encuentras cuando vas por el otro camino y te quedas en LINQ.
- [Consultas compiladas de EF Core vs SQL en crudo vs Dapper](/es/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) sopesa cuándo el SQL en crudo vale sus aristas afiladas que acabas de conocer.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre otro caso donde la forma del resultado y el mapeo de la entidad tienen que alinearse.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11](/es/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) importa una vez que tu consulta de entidad en crudo funciona y quieres que la lectura sea barata.
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) vale la pena revisarla cuando el SQL en crudo es tu respuesta a una consulta que EF generó mal.

## Fuentes

- [Consultas SQL en crudo, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) (ver la sección "Limitations": deben devolverse todas las columnas mapeadas y los nombres deben coincidir)
- [Tipos de entidad sin clave, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [RelationalDatabaseFacadeExtensions.SqlQuery, referencia de la API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlquery)
- [dotnet/efcore issue #33748: texto engañoso de "missing column" para una columna equivocada](https://github.com/dotnet/efcore/issues/33748)
