---
title: "Cómo usar la división de consultas para evitar una explosión cartesiana en EF Core 11"
description: "Cuando haces Include de dos colecciones hermanas, EF Core 11 devuelve el producto cartesiano y tu número de filas se dispara. Aquí tienes cómo lo arregla AsSplitQuery, cómo activarlo de forma global y los detalles de consistencia y orden que debes vigilar."
pubDate: 2026-06-01
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "sql-server"
  - "how-to"
lang: "es"
translationOf: "2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-01
---

Respuesta corta: cuando una sola consulta LINQ carga dos o más navegaciones de colección al mismo nivel (`.Include(b => b.Posts).Include(b => b.Contributors)`), EF Core la traduce a una sola sentencia SQL con JOINs hermanos, y la base de datos devuelve el producto cartesiano de ambas colecciones. Un blog con 50 posts y 20 contribuidores vuelve como 1000 filas. Llama a `.AsSplitQuery()` y EF Core 11 emite una consulta por colección en su lugar, así que obtienes 50 + 20 = 70 filas repartidas en viajes de ida y vuelta separados. La solución es una sola llamada a un método, pero hay tres cosas que muerden a la gente: la consistencia de los datos entre las consultas divididas, los joins de referencia extra repetidos en cada consulta, y la corrección del orden con `Skip`/`Take`.

Este post es sobre .NET 11 y EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) contra SQL Server, pero la mecánica de la explosión cartesiana y la API `AsSplitQuery` son idénticas en PostgreSQL y SQLite. Mostraré el SQL explotado, el SQL dividido, cómo establecer el comportamiento por consulta y de forma global, y cómo decidir entre los dos.

## Qué es realmente una explosión cartesiana

Un JOIN relacional entre un padre y una sola colección hija está bien. El problema empieza cuando haces JOIN de un padre a dos colecciones hijas que cuelgan del mismo padre. Toma el modelo canónico de blog:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; set; } = [];
    public List<Contributor> Contributors { get; set; } = [];
}

public sealed class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string Title { get; set; } = "";
}

public sealed class Contributor
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string FirstName { get; set; } = "";
}
```

Ahora carga un blog con ambas colecciones en una sola consulta:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .ToListAsync();
```

EF Core 11 produce una sola sentencia con dos `LEFT JOIN`s al mismo nivel:

```sql
SELECT [b].[Id], [b].[Name],
       [p].[Id], [p].[BlogId], [p].[Title],
       [c].[Id], [c].[BlogId], [c].[FirstName]
FROM [Blogs] AS [b]
LEFT JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
LEFT JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id], [p].[Id]
```

Como `Posts` y `Contributors` son ambas colecciones de `Blog`, la base de datos no tiene más opción que devolver un producto cartesiano: cada fila de post se empareja con cada fila de contribuidor de ese blog. Un blog con 50 posts y 20 contribuidores produce 50 * 20 = 1000 filas, y cada una de esas filas repite todas las columnas de `Blog` y las columnas de post y las columnas de contribuidor. EF Core de-duplica los objetos materializados en el cliente, así que sigues obteniendo un `Blog` con 50 posts y 20 contribuidores, pero el cable pagó por 1000 filas de datos redundantes.

El multiplicador es el producto de los tamaños de las colecciones, no la suma. Añade una tercera colección hermana con 10 filas y estarás en 50 * 20 * 10 = 10 000 filas para un solo padre. Por eso una consulta que parece inocente en desarrollo, donde cada blog tiene dos posts, puede transferir cientos de megabytes en producción donde los blogs tienen cientos de posts. La [guía oficial de consultas únicas vs. divididas de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries) documenta un caso real donde el número de filas cayó de más de 133 000 a poco más de 1000 tras dividir.

Un caso importante que no aplica: los includes anidados a diferentes niveles no explotan. `.Include(b => b.Posts).ThenInclude(p => p.Comments)` es `Comments` colgando de `Post`, no de `Blog`, así que cada comentario mapea a exactamente una fila y no hay producto cartesiano. La explosión cartesiana se trata específicamente de colecciones hermanas al mismo nivel.

## La advertencia que EF Core ya te da

EF Core 11 no deja que esto suceda en silencio sin una pista. Cuando detecta una consulta que carga múltiples colecciones y no has elegido un comportamiento de división, lanza `MultipleCollectionIncludeWarning` a través del pipeline de registro. Por defecto se registra, no se lanza, así que es fácil pasarlo por alto en un registro ruidoso. Puedes promoverlo a una excepción para que falle rápido en desarrollo:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.ConfigureWarnings(w =>
        w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
});
```

Con esto en su lugar, cualquier consulta que incluya dos colecciones hermanas sin un `AsSingleQuery()` o `AsSplitQuery()` explícito lanza en tiempo de ejecución, obligando al autor a tomar una decisión deliberada. Esta es la misma postura defensiva que recomiendo para cazar regresiones de rendimiento en [la guía para detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): haz que el framework sea ruidoso sobre los patrones que escalan mal, en lugar de descubrirlos bajo carga.

## La solución: AsSplitQuery

Añade un operador a la consulta:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

EF Core 11 ahora emite tres sentencias SQL separadas sobre la misma conexión: la consulta raíz para los blogs, una consulta para los posts, y una para los contribuidores.

```sql
-- Query 1: the roots
SELECT [b].[Id], [b].[Name]
FROM [Blogs] AS [b]
ORDER BY [b].[Id]

-- Query 2: posts, correlated back to the roots
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]

-- Query 3: contributors, correlated back to the roots
SELECT [c].[Id], [c].[BlogId], [c].[FirstName], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id]
```

El mismo blog ahora cuesta 50 filas de post más 20 filas de contribuidor más 1 fila raíz, 71 filas en total en lugar de 1000. No se duplican datos, porque las columnas del blog aparecen una vez en la consulta 1 en lugar de estamparse en cada fila del producto cartesiano. EF Core vuelve a unir los tres conjuntos de resultados en el cliente usando la clave de correlación, por lo cual cada consulta hija vuelve a seleccionar `[b].[Id]` y ordena por ella.

El grafo de objetos devuelto es idéntico byte por byte a la versión de consulta única. `AsSplitQuery` cambia solo cómo viajan los datos, nunca lo que obtienes de vuelta. Eso lo convierte en un reemplazo seguro para cualquier consulta de lectura donde el padre tiene múltiples colecciones grandes.

## Activar la división de consultas de forma global

Si la mayoría de tus consultas se abren en múltiples colecciones, cambiar el valor por defecto es más limpio que esparcir `AsSplitQuery()` por todas partes. Configúralo en las opciones del proveedor con `UseQuerySplittingBehavior`:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString,
        sql => sql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery));
});
```

El enum `QuerySplittingBehavior` tiene dos valores: `SingleQuery` (el valor por defecto del framework, hacer JOIN de todo en una sola sentencia) y `SplitQuery` (una sentencia por colección). Una vez que el valor por defecto global es `SplitQuery`, vuelves a optar consultas individuales por una sola sentencia con `AsSingleQuery()`:

```csharp
var blog = await ctx.Blogs
    .Include(b => b.Posts)
    .AsSingleQuery()       // override the global SplitQuery default
    .FirstAsync(b => b.Id == id);
```

Una regla práctica razonable: usa `AsSingleQuery` para consultas que cargan exactamente una colección (no es posible ninguna explosión, y ahorras un viaje de ida y vuelta), y deja que el valor por defecto global `SplitQuery` maneje todo con dos o más. Establecer el valor por defecto global también silencia `MultipleCollectionIncludeWarning`, porque ahora has tomado una decisión explícita para todo el contexto.

## Cuándo la división de consultas es la elección equivocada

Dividir no es una victoria gratis, y tratarla como tal es cómo cambias un problema de ancho de banda por un problema de latencia o de corrección. Tres desventajas a sopesar:

**Cada división es un viaje de ida y vuelta separado.** Tres colecciones significan tres viajes de ida y vuelta a la base de datos. En una red local de baja latencia eso es invisible, pero contra una base de datos en la nube con 15 ms de latencia de ida y vuelta, tres consultas secuenciales añaden 45 ms de pura espera antes de que empiece cualquier trabajo. Si tus colecciones son pequeñas (un puñado de filas cada una), el producto cartesiano es minúsculo y una sola consulta con JOIN que paga un viaje de ida y vuelta es más rápida que tres consultas divididas que cada una paga el suyo. Las consultas divididas ganan cuando las colecciones son lo suficientemente grandes como para que el número de filas del producto cartesiano eclipse el costo del viaje de ida y vuelta.

**No hay consistencia transaccional entre las divisiones por defecto.** Una sola sentencia SQL ve una instantánea consistente de la base de datos. Las consultas divididas son múltiples sentencias, y si otra transacción confirma entre la consulta 1 y la consulta 2, los posts que cargas pueden no coincidir con el estado del blog que cargaste. La solución, según la documentación oficial, es envolver las lecturas en una transacción serializable o de instantánea:

```csharp
// .NET 11, EF Core 11.0.0
using var tx = await ctx.Database.BeginTransactionAsync(
    System.Data.IsolationLevel.Snapshot);

var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();

await tx.CommitAsync();
```

Para la mayoría de las rutas de lectura la breve ventana de inconsistencia no importa, pero si estás calculando un total entre colecciones que debe concordar, recurre al aislamiento de instantánea.

**Las navegaciones de referencia se unen en cada división.** Si también haces `Include` de una navegación a-uno junto a tus colecciones, cada consulta dividida repite el join a esa tabla de referencia. En EF Core 10 y anteriores esto era puro desperdicio. EF Core 11 lo arregló: como se cubre en [el post sobre EF Core 11 podando los joins de referencia en consultas divididas](/es/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/), el runtime ahora elimina los joins de referencia de las consultas hijas que no los proyectan, así que una búsqueda de `BlogType` ya no se vuelve a unir en la consulta de posts. Ten en cuenta que las referencias uno-a-uno y muchos-a-uno siempre se cargan vía JOIN incluso en modo dividido, porque una referencia no puede multiplicar filas, así que no hay nada que dividir.

## El detalle del orden con Skip y Take

La trampa sutil de corrección es la paginación. Las consultas divididas correlacionan sus conjuntos de resultados ordenando por una clave compartida, y si tu orden no es totalmente único, cada consulta dividida puede elegir un subconjunto de filas diferente cuando se combina con `Skip`/`Take`. Supón que ordenas los blogs por `CreatedDate` y dos blogs comparten la misma fecha:

```csharp
// Risky on older EF: non-unique ordering with paging
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Como las bases de datos relacionales no aplican un orden inherente, la consulta raíz y las consultas hijas podrían resolver cada una el empate de forma diferente, devolviendo posts para un blog que no está en tu página. EF Core 10 y 11 refuerzan esto añadiendo automáticamente la clave primaria al `ORDER BY` generado para que la clave de correlación sea única, pero el hábito seguro es hacer tu propio orden determinista independientemente de la versión de EF:

```csharp
// .NET 11, EF Core 11.0.0 -- fully unique ordering
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .ThenBy(b => b.Id)            // tie-breaker makes the order total
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Añadir `ThenBy(b => b.Id)` hace que el orden sea total, así que cada consulta dividida concuerda sobre qué 10 blogs están en la página. Esto no cuesta nada y elimina una clase de bug que solo aparece cuando dos filas empatan por casualidad.

## Una lista de verificación rápida para decidir

Cuando te topes con una consulta que incluye múltiples colecciones, recorre esto:

1. **¿La consulta carga dos o más colecciones hermanas?** Si no, no puedes tener una explosión cartesiana. Déjala como una sola consulta.
2. **¿Las colecciones son grandes en producción?** Si cada padre tiene cientos de filas por colección, el producto cartesiano es el costo dominante. Divídela.
3. **¿La latencia de la base de datos es alta (nube, entre regiones)?** Si es así y las colecciones son pequeñas, los viajes de ida y vuelta extra pueden costar más que la explosión. Mide antes de dividir.
4. **¿La lectura necesita una instantánea consistente?** Si calculas agregados entre colecciones, envuelve la división en una transacción de instantánea o serializable.
5. **¿Hay paginación?** Haz que el `OrderBy` sea totalmente único con un desempate por clave primaria.

Para rutas calientes donde la consulta se ejecuta miles de veces por segundo, combina la división con [consultas compiladas en EF Core](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) para que la traducción de LINQ a SQL se almacene en caché. Y cuando la lectura está genuinamente en la ruta crítica y la sobrecarga de EF Core importa, vale la pena echar un vistazo a la comparación en [EF Core 11 vs Dapper para operaciones masivas](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), aunque para la carga ordinaria de colecciones `AsSplitQuery` cierra la mayor parte de la brecha. Si transmites los resultados en lugar de materializar una lista, las mismas reglas de división aplican a [las consultas IAsyncEnumerable en EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

La explosión cartesiana es uno de los pocos problemas de rendimiento de EF Core con una solución de una línea y un conjunto de resultados idéntico. La parte difícil no es la llamada a `AsSplitQuery()`, es saber que está sucediendo en absoluto. Convierte `MultipleCollectionIncludeWarning` en una excepción en desarrollo, y el framework te dirá exactamente qué consultas necesitan el tratamiento antes de que lleguen a producción.

Fuente: [Consultas únicas vs. divididas, documentación de EF Core](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries), y las [notas de novedades de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
