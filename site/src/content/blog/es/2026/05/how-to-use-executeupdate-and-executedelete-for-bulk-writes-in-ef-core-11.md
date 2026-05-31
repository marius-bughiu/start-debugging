---
title: "Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11"
description: "Una guía completa de ExecuteUpdate y ExecuteDelete en EF Core 11: el SQL que generan, la trampa del rastreador de cambios que sobrescribe en silencio tu escritura masiva, las transacciones, el control de concurrencia con el conteo de filas afectadas y los setters por delegado de EF Core 10 que permiten construir actualizaciones condicionales con simples sentencias if."
pubDate: 2026-05-31
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Respuesta corta: para actualizar o eliminar muchas filas en una sola sentencia SQL, escribe un `Where` de LINQ para elegir las filas y luego llama a `ExecuteUpdateAsync` o `ExecuteDeleteAsync` sobre la consulta resultante. EF Core 11 traduce todo a un único `UPDATE` o `DELETE` que se ejecuta en la base de datos, sin cargar entidades, sin rastreador de cambios y sin `SaveChanges`. Ambos métodos se ejecutan de inmediato y devuelven el número de filas afectadas. La trampa que sorprende a todo el mundo: como estos métodos nunca tocan el rastreador de cambios, cualquier entidad que ya hayas cargado conserva su valor desactualizado, y un `SaveChanges` posterior sobrescribirá alegremente tu escritura masiva.

Este artículo cubre `ExecuteUpdate` y `ExecuteDelete` en `Microsoft.EntityFrameworkCore` 11.0.0 sobre .NET 11 contra SQL Server 2025: el SQL exacto que generan, las actualizaciones de varias propiedades, cómo referenciar el valor de columna existente, la trampa del rastreo de cambios y cómo esquivarla, la semántica de las transacciones, cómo implementar tu propia concurrencia optimista con el conteo de filas afectadas, los setters condicionales por delegado que llegaron en EF Core 10 y las limitaciones que te devuelven a `SaveChanges`. Las APIs relacionales son idénticas en PostgreSQL y SQLite; solo difiere el dialecto SQL generado.

## Por qué el bucle de SaveChanges es la herramienta equivocada para escrituras masivas

La forma ingenua de hacer un borrado lógico de cada blog con mala puntuación parece razonable hasta que observas el SQL:

```csharp
// .NET 11, EF Core 11.0.0 - the slow way
await foreach (var blog in context.Blogs.Where(b => b.Rating < 3).AsAsyncEnumerable())
{
    context.Blogs.Remove(blog);
}

await context.SaveChangesAsync();
```

Esto consulta cada fila coincidente desde la red, materializa cada una en una entidad rastreada, la marca como `Deleted` en el rastreador de cambios y luego, en `SaveChanges`, emite un `DELETE` por fila. Si coinciden 50.000 blogs, eso es un gran `SELECT`, 50.000 asignaciones y 50.000 sentencias `DELETE` (agrupadas en lotes, pero aún parametrizadas individualmente). La base de datos hace un trabajo enorme para una operación que conceptualmente es una sola sentencia basada en conjuntos.

`ExecuteDelete` reduce todo eso a una sola ida y vuelta:

```csharp
// .NET 11, EF Core 11.0.0
int deleted = await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteDeleteAsync();
```

EF Core 11 traduce el predicado de LINQ a SQL exactamente como lo haría para una consulta, pero emite un `DELETE` en lugar de un `SELECT`:

```sql
DELETE FROM [b]
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

No se carga nada, no se rastrea nada y `deleted` contiene el conteo de filas. Puedes poner cualquier LINQ traducible en el `Where`, incluyendo joins y subconsultas, igual que harías al seleccionar las filas.

## Actualizar en su lugar con ExecuteUpdate

`ExecuteUpdate` es el hermano del `UPDATE`. En lugar de eliminar los blogs con mala puntuación, ocúltalos:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.IsVisible, false));
```

El `Where` selecciona las filas; la llamada a `SetProperty` indica qué columna cambia y a qué valor. EF Core 11 emite:

```sql
UPDATE [b]
SET [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Para cambiar varias columnas a la vez, encadena llamadas a `SetProperty`. Todas terminan en una sola sentencia:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.IsVisible, false)
        .SetProperty(b => b.Rating, 0));
```

```sql
UPDATE [b]
SET [b].[Rating] = 0,
    [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

### Calcular el nuevo valor a partir del antiguo

El segundo argumento de `SetProperty` no tiene por qué ser una constante. Pasa un lambda y obtienes la fila actual, de modo que puedes calcular el nuevo valor a partir de las columnas existentes. Para incrementar en uno cada puntuación coincidente:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters =>
        setters.SetProperty(b => b.Rating, b => b.Rating + 1));
```

Dentro de ese lambda, `b.Rating` es el valor de columna previo a la actualización, y EF Core traduce toda la expresión a SQL para que la aritmética ocurra en la base de datos, de forma atómica, sin condición de carrera de leer-modificar-escribir:

```sql
UPDATE [b]
SET [b].[Rating] = [b].[Rating] + 1
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Este es el patrón que quieres para contadores, saldos y sellos de versión. Hacerlo a través de `SaveChanges` significa cargar la fila, mutarla en memoria y guardar, lo que abre una ventana en la que otra transacción puede cambiar la misma fila entre tu lectura y tu escritura. El `UPDATE` basado en conjuntos no tiene esa ventana.

## La trampa del rastreador de cambios que se traga tu escritura en silencio

Aquí va lo más importante que debes interiorizar sobre ambos métodos: surten efecto de inmediato y no tienen ninguna interacción con el rastreador de cambios de EF. Esa es la fuente de su velocidad, y también la fuente del único error que todo el mundo comete al menos una vez.

Recorre esta secuencia con atención:

```csharp
// .NET 11, EF Core 11.0.0
// 1. Tracking query: this Blog is now tracked, Rating == 5 in memory.
var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");

// 2. Bump every blog's rating by one in the database. Runs now.
await context.Blogs
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.Rating, b => b.Rating + 1));

// 3. Mutate the tracked instance in memory.
blog.Rating += 2;

// 4. Persist tracked changes.
await context.SaveChangesAsync();
```

Tras el paso 2, la fila de la base de datos vale `6`. Pero la instancia rastreada sigue creyendo que el valor original es `5`, porque `ExecuteUpdate` nunca le dijo nada al rastreador de cambios. El paso 3 fija el valor en memoria a `7`. Cuando se ejecuta `SaveChanges` en el paso 4, EF compara el valor actual `7` con el *original* que registró en el paso 1 (`5`), decide que la propiedad cambió y escribe `7`. Tu `+1` masivo desaparece, sobrescrito por un `SaveChanges` que nunca supo que ocurrió.

La guía oficial de la [documentación de ExecuteUpdate y ExecuteDelete de EF Core](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete) es contundente: evita mezclar modificaciones rastreadas de `SaveChanges` con modificaciones no rastreadas vía `ExecuteUpdate`/`ExecuteDelete` sobre las mismas entidades en la misma unidad de trabajo. En la práctica hay dos formas limpias de evitar problemas:

1. Ejecuta la escritura masiva contra un contexto cuya consulta de esas filas haya usado `AsNoTracking()`, de modo que nada rastreado pueda quedar desactualizado.
2. Si tienes que leer entidades, ejecuta la escritura masiva y luego llama a `context.ChangeTracker.Clear()` antes de volver a consultar, para que la siguiente lectura se repueble desde la base de datos con valores frescos.

```csharp
// .NET 11, EF Core 11.0.0 - re-read fresh after a bulk write
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.IsVisible, false));

context.ChangeTracker.Clear();

var hidden = await context.Blogs
    .AsNoTracking()
    .Where(b => !b.IsVisible)
    .ToListAsync();
```

El modelo mental más limpio: trata `ExecuteUpdate`/`ExecuteDelete` como si pertenecieran a una capa de acceso a datos distinta y de más bajo nivel que casualmente comparte tu `DbContext`. Hablan SQL, no entidades. Es el mismo límite que respetas cuando [haces mock de un DbContext sin romper el rastreo de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): el rastreador de cambios es algo con estado en memoria, y las escrituras por canal lateral no lo actualizan.

## Transacciones: nada es implícito

Ninguno de los dos métodos abre una transacción por ti. Cada llamada es su propia ida y vuelta y, salvo que la envuelvas, su propia transacción implícita. Esta secuencia son cuatro transacciones separadas:

```csharp
// .NET 11, EF Core 11.0.0 - four independent transactions, NOT atomic
await context.Blogs.ExecuteUpdateAsync(/* update A */);
await context.Blogs.ExecuteUpdateAsync(/* update B */);

var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");
blog.Rating += 2;
await context.SaveChangesAsync();
```

Si la actualización B lanza una excepción, la actualización A ya está confirmada. No hay reversión, porque nunca hubo una transacción compartida. Cuando dos o más escrituras masivas deben tener éxito o fallar juntas, inicia una transacción explícita sobre el [DatabaseFacade](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.databasefacade):

```csharp
// .NET 11, EF Core 11.0.0 - one atomic unit
await using var tx = await context.Database.BeginTransactionAsync();

await context.Blogs
    .Where(b => b.Rating < 0)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, 0));

await context.Posts
    .Where(p => p.IsOrphaned)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Ahora ambas sentencias comparten una transacción y se revierten juntas en caso de fallo. Si una de ellas se ejecuta sobre una tabla lenta y te topas con una [SqlException: Timeout expired](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), la transacción explícita es también el lugar donde fijarías un tiempo de espera de comando más largo para el lote.

## Implementa tu propio control de concurrencia con el conteo de filas

`SaveChanges` te da concurrencia optimista gratis mediante tokens de concurrencia: añade el token a la cláusula `WHERE` y lanza `DbUpdateConcurrencyException` si no coincide ninguna fila. `ExecuteUpdate` y `ExecuteDelete` no tocan el rastreador de cambios, así que no pueden hacer esto automáticamente. En cambio, te dan la materia prima: el conteo de filas afectadas.

Pon el token de concurrencia en tu propio `Where` e inspecciona el valor devuelto:

```csharp
// .NET 11, EF Core 11.0.0 - hand-rolled optimistic concurrency
int updated = await context.Blogs
    .Where(b => b.Id == id && b.Version == expectedVersion)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.Title, newTitle)
        .SetProperty(b => b.Version, b => b.Version + 1));

if (updated == 0)
{
    // Either the row is gone or someone else bumped Version first.
    throw new DbUpdateConcurrencyException("Blog was modified concurrently.");
}
```

Como la comprobación de `Version` forma parte del `WHERE` de SQL, la comparación y la escritura son una sola sentencia atómica. Ninguna fila coincide si otra transacción ya incrementó `Version`, `updated` vuelve como `0` y reaccionas. Esto suele ser *más rápido* que la ruta rastreada para actualizaciones de una sola fila en endpoints muy concurridos, y compone bien con los patrones del lado de lectura en [consultas compiladas para rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Setters condicionales sin árboles de expresión (EF Core 10 y posteriores)

Antes de EF Core 10, el argumento de los setters era un árbol de expresión, lo que hacía dolorosas las actualizaciones dinámicas: no podías colocar una sentencia `if` en medio de una cadena fluida, así que las actualizaciones condicionales implicaban bifurcar toda la llamada o construir árboles de expresión a mano. A partir de EF Core 10, y heredado en EF Core 11, hay una sobrecarga cuyo argumento de setters es un delegado ordinario con un cuerpo de sentencias. Puedes usar el flujo de control normal de C#:

```csharp
// .NET 11, EF Core 11.0.0 - conditional setters with normal control flow
await context.Blogs
    .Where(b => b.Id == id)
    .ExecuteUpdateAsync(setters =>
    {
        setters.SetProperty(b => b.Title, newTitle);

        if (rankChanged)
        {
            setters.SetProperty(b => b.Rating, newRating);
        }

        foreach (var (column, value) in extraFlags)
        {
            // build setters in a loop, one per flag that actually changed
            setters.SetProperty(column, value);
        }
    });
```

El cuerpo del delegado se ejecuta una vez, en C#, para armar la lista de columnas a fijar; EF Core 11 luego lo traduce a un único `UPDATE`. Esta es la forma idiomática de implementar un endpoint PATCH donde el cliente envía solo los campos que quiere cambiar. Construyes exactamente los setters que necesitas y emites una sola sentencia, en lugar de actualizar todas las columnas o recurrir a cargar-mutar-guardar. La antigua sobrecarga basada en expresiones sigue existiendo y está bien para el caso estático de siempre-las-mismas-columnas.

## Referenciar entidades relacionadas, y los límites

`ExecuteUpdate` no puede referenciar una navegación directamente dentro de `SetProperty`. Esto no se traduce:

```csharp
// .NET 11, EF Core 11.0.0 - does NOT work
await context.Blogs.ExecuteUpdateAsync(
    setters => setters.SetProperty(b => b.Rating, b => b.Posts.Average(p => p.Rating)));
```

La solución alternativa es hacer un `Select` a una proyección anónima que calcule el valor primero y luego llamar a `ExecuteUpdate` sobre esa proyección:

```csharp
// .NET 11, EF Core 11.0.0 - set each Blog's rating to the average of its Posts
await context.Blogs
    .Select(b => new { Blog = b, NewRating = b.Posts.Average(p => p.Rating) })
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.Blog.Rating, x => x.NewRating));
```

EF Core 11 convierte el promedio en una subconsulta correlacionada dentro del `UPDATE`:

```sql
UPDATE [b]
SET [b].[Rating] = CAST((
    SELECT AVG(CAST([p].[Rating] AS float))
    FROM [Post] AS [p]
    WHERE [b].[Id] = [p].[BlogId]) AS int)
FROM [Blogs] AS [b]
```

Más allá de las navegaciones, ten presentes estas restricciones:

- **Solo actualizar y eliminar.** No existe `ExecuteInsert`. Las inserciones siguen pasando por `Add` más `SaveChanges`.
- **No devuelve los valores antiguos.** SQL puede devolver las filas que tocó, pero EF Core 11 no lo expone; solo obtienes el conteo.
- **No agrupa en lotes entre llamadas.** Dos llamadas a `ExecuteUpdate` son dos idas y vueltas. No hay equivalente de acumular cambios y vaciarlos una vez.
- **Una tabla por sentencia.** Igual que el `UPDATE`/`DELETE` de SQL crudo, una sola llamada apunta a una sola tabla. Actualizar a través de una jerarquía de herencia TPT que abarca varias tablas no es expresable en una sola llamada.
- **Solo proveedores relacionales.** Son métodos de extensión sobre el proveedor de consultas relacional; el proveedor en memoria no los tiene.

La primera merece detenerse: si tu ruta caliente son *inserciones* de alto volumen, ninguno de los dos métodos ayuda. Ese es un problema distinto con su propia respuesta, medida en [EF Core 11 vs Dapper para inserciones masivas](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Cuándo elegir cuál

La decisión depende en gran medida de si necesitas las entidades. Si estás eliminando o actualizando filas por un predicado y no necesitas los objetos afectados en memoria después, `ExecuteDelete`/`ExecuteUpdate` casi siempre es la opción correcta: una sentencia, sin materialización, sin sobrecarga de rastreo. Es el mismo instinto que te hace rastrear y eliminar una [consulta N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), es decir, negarte a hacer idas y vueltas por fila cuando la base de datos puede hacer todo el trabajo en una sola operación basada en conjuntos.

Vuelve a `SaveChanges` cuando realmente necesites el rastreador de cambios: grafos de objetos complejos, comportamientos en cascada que dependen del estado rastreado, tokens de concurrencia automáticos, o interceptores y eventos de dominio conectados a `SaveChanges`. Y siempre que mezcles ambos, recuerda el límite. Los métodos masivos escriben SQL directamente y dejan tus entidades rastreadas congeladas en el pasado. Limpia el rastreador o consulta con `AsNoTracking()` después de una escritura masiva, envuelve el trabajo de varias sentencias en una transacción explícita y comprueba el conteo de filas devuelto cuando la corrección dependa de cuántas filas cambiaron realmente.
