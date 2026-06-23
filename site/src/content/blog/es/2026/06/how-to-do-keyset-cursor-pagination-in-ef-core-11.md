---
title: "Cómo hacer paginación por keyset (cursor) en EF Core 11"
description: "Reemplaza Skip/Take con una cláusula WHERE que avanza más allá de la última fila que viste. Ordena por una clave totalmente única, lleva los valores de la última fila como cursor, y EF Core 11 convierte la página siguiente en un seek de índice en lugar de un escaneo OFFSET."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "es"
translationOf: "2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Respuesta corta: deja de paginar con `Skip(n).Take(pageSize)` y empieza a paginar con una cláusula `WHERE`. La paginación por keyset (también llamada paginación por cursor o por seek) recuerda los valores de ordenamiento de la última fila de la página que acabas de mostrar, y luego le pide a la base de datos las filas que ordenan después de ella: `OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Where(x => x.CreatedAt > lastDate || (x.CreatedAt == lastDate && x.Id > lastId)).Take(pageSize)`. Con un índice sobre las columnas de ordenamiento, cada página es un seek de índice de costo constante, en lugar de un `OFFSET` que vuelve a escanear y descarta cada fila antes de la página. El único requisito estricto: ordenar por algo totalmente único, lo que en la práctica significa una clave de ordenamiento real más la clave primaria como desempate.

Este post usa `Microsoft.EntityFrameworkCore` 11.0.0 sobre .NET 11 con C# 14, contra SQL Server 2025. Todo lo de aquí funciona igual en PostgreSQL y SQLite; la única nota específica del proveedor está al final. Si alguna vez viste que la página 500 de una grilla tarda diez veces más que la página 1, esta es la solución.

## Por qué Skip/Take se vuelve más lento mientras más profundo paginas

La paginación por offset es lo primero obvio que todos escriben. Tamaño de página 20, página 30, salta 580 filas:

```csharp
// .NET 11, EF Core 11.0.0 - offset pagination, the slow way
var page = 30;
var pageSize = 20;

var posts = await context.Posts
    .OrderBy(p => p.PostId)
    .Skip((page - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync();
```

EF Core traduce `Skip`/`Take` a SQL `OFFSET`/`FETCH` (o `LIMIT`/`OFFSET` en PostgreSQL y SQLite):

```sql
SELECT [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
ORDER BY [p].[PostId]
OFFSET 580 ROWS FETCH NEXT 20 ROWS ONLY;
```

El problema es lo que `OFFSET 580` hace en realidad. La base de datos no salta a la fila 581. Produce las 600 filas en orden, cuenta las primeras 580, las descarta, y devuelve las últimas 20. El trabajo escala con el offset, no con el tamaño de página, así que las páginas profundas se vuelven progresivamente más costosas. En una tabla caliente esto es exactamente lo contrario de lo que los usuarios esperan: mientras más se desplazan, más lento se pone.

Hay un segundo problema, más silencioso. La paginación por offset no es estable bajo escrituras concurrentes. La [guía oficial de paginación](https://learn.microsoft.com/en-us/ef/core/querying/pagination) de EF Core lo explica: si se inserta o elimina una fila entre dos solicitudes de página, todo el conjunto de resultados se desplaza en uno, y un usuario que pasa de la página 2 a la página 3 ve una fila dos veces o se salta una por completo. En una grilla de administración nadie lo nota. En un feed de scroll infinito donde constantemente se agregan filas arriba, es un defecto visible y reproducible.

## Qué hace una consulta por keyset en su lugar

La paginación por keyset descarta la idea de un offset. En lugar de "salta 580 filas", dices "dame las filas que vienen después de esta fila específica que ya tengo". Recuerdas los valores de ordenamiento de la última fila, y la página siguiente es un `WHERE` que avanza directamente más allá de ellos:

```csharp
// .NET 11, EF Core 11.0.0 - keyset pagination, single unique key
var pageSize = 20;
int? lastPostId = 580; // the PostId of the last row on the previous page; null for page 1

var query = context.Posts.OrderBy(p => p.PostId).AsQueryable();

if (lastPostId is int cursor)
{
    query = query.Where(p => p.PostId > cursor);
}

var posts = await query.Take(pageSize).ToListAsync();
```

Eso se traduce a:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[PostId] > 580
ORDER BY [p].[PostId];
```

Con un índice sobre `PostId` (la clave primaria agrupada ya lo es), la base de datos hace seek directamente a la primera fila mayor que 580 y lee 20 filas. No hay escaneo-y-descarte. La página 1 y la página 10 000 cuestan lo mismo. Y como el cursor es un valor, no una posición, una inserción o eliminación en otra parte de la tabla no puede desplazar tu ventana: siempre continúas desde la fila exacta que viste por última vez.

La trampa está en el nombre: la paginación por keyset necesita una *clave*. La columna (o columnas) por la que ordenas debe producir un orden estricto y total entre las filas. Si dos filas pueden empatar en la clave de ordenamiento, la comparación `>` no puede decirle a la base de datos de qué lado del límite pertenece una fila empatada, y silenciosamente te saltarás o repetirás filas. `PostId` es único, así que funciona solo. Una marca de tiempo `CreatedAt` casi nunca es única, así que no funciona, y ahí es donde viven la mayoría de las consultas reales.

## Ordenando por una columna no única: agrega un desempate

El caso realista es "los más nuevos primero", ordenando por un `CreatedAt` que puede colisionar hasta el milisegundo. La solución que los docs señalan en una advertencia al inicio de la [página de paginación](https://learn.microsoft.com/en-us/ef/core/querying/pagination) es hacer que el ordenamiento sea totalmente único agregando una columna única, casi siempre la clave primaria:

```csharp
// .NET 11, EF Core 11.0.0 - keyset over (CreatedAt DESC, PostId DESC)
var pageSize = 20;

// Cursor carried from the last row of the previous page (null on page 1).
DateTime? lastCreatedAt = previousCursor?.CreatedAt;
int? lastPostId = previousCursor?.PostId;

var query = context.Posts
    .OrderByDescending(p => p.CreatedAt)
    .ThenByDescending(p => p.PostId)
    .AsQueryable();

if (lastCreatedAt is DateTime ca && lastPostId is int id)
{
    // Rows that sort strictly after the cursor in (CreatedAt DESC, PostId DESC).
    query = query.Where(p =>
        p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
}

var posts = await query.Take(pageSize).ToListAsync();
```

La cláusula `WHERE` es todo el truco, así que léela con cuidado. Estás ordenando de forma descendente, así que "después del cursor" significa más pequeño. Una fila pertenece a la página siguiente si su `CreatedAt` es estrictamente más antiguo que el del cursor (`p.CreatedAt < ca`), o si su `CreatedAt` empata exactamente y su `PostId` desempata en la misma dirección (`p.CreatedAt == ca && p.PostId < id`). Esa rama `==` es la parte que la gente omite, y omitirla es exactamente cómo las filas que comparten una marca de tiempo se saltan en los límites de página. La dirección de comparación en el `WHERE` debe reflejar la dirección del `OrderBy` con precisión: el orden ascendente usa `>`, el descendente usa `<`. Si los mezclas, tus páginas se solapan o dejan huecos.

El SQL generado es un único seek:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[CreatedAt] < @ca OR ([p].[CreatedAt] = @ca AND [p].[PostId] < @id)
ORDER BY [p].[CreatedAt] DESC, [p].[PostId] DESC;
```

## Cómo conectarlo de punta a punta

Aquí está el ciclo completo: codifica el cursor, devuélvelo con la página, decodifícalo en la siguiente solicitud. Los pasos son los mismos ya sea que el cursor viaje en una query string o en el cuerpo de una respuesta de API.

1. **Elige un ordenamiento totalmente único.** Una columna de ordenamiento con significado más la clave primaria como desempate final. El orden de las columnas aquí es el orden que todo lo demás debe seguir.
2. **Define un índice que coincida exactamente con el ordenamiento.** Un índice compuesto sobre `(CreatedAt DESC, PostId DESC)` permite que el seek lea las filas ya en orden. Sin él, la base de datos ordena toda la tabla en cada página y la ventaja se evapora.
3. **Construye el `WHERE` a partir de los valores de la última fila.** Una rama `OR` por columna de ordenamiento, con la dirección de comparación coincidiendo con la dirección de ordenamiento de cada columna.
4. **Toma `pageSize` filas.** Opcionalmente `pageSize + 1` para poder saber si existe una página siguiente sin una segunda consulta.
5. **Emite un cursor a partir de la última fila devuelta** y devuélveselo al llamador para que lo envíe con la siguiente solicitud.

Un endpoint mínimo que devuelve una página más un cursor opaco:

```csharp
// .NET 11, EF Core 11.0.0, C# 14 - minimal API keyset endpoint
app.MapGet("/posts", async (string? cursor, AppDbContext db) =>
{
    const int pageSize = 20;

    var query = db.Posts
        .AsNoTracking()
        .OrderByDescending(p => p.CreatedAt)
        .ThenByDescending(p => p.PostId)
        .AsQueryable();

    if (Cursor.TryDecode(cursor, out var ca, out var id))
    {
        query = query.Where(p =>
            p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
    }

    // Fetch one extra row to detect whether a further page exists.
    var rows = await query.Take(pageSize + 1).ToListAsync();

    var hasMore = rows.Count > pageSize;
    var page = rows.Take(pageSize).ToList();

    var next = hasMore && page.Count > 0
        ? Cursor.Encode(page[^1].CreatedAt, page[^1].PostId)
        : null;

    return Results.Ok(new { items = page, nextCursor = next });
});
```

El helper `Cursor` simplemente empaqueta los dos valores en un token seguro para URL para que los llamadores lo traten como opaco y no puedan manipular la semántica de paginación:

```csharp
// .NET 11, C# 14 - opaque cursor encode/decode
static class Cursor
{
    public static string Encode(DateTime createdAt, int id) =>
        Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{createdAt.Ticks}:{id}"));

    public static bool TryDecode(string? token, out DateTime createdAt, out int id)
    {
        createdAt = default;
        id = default;
        if (string.IsNullOrEmpty(token)) return false;

        var parts = Encoding.UTF8
            .GetString(Convert.FromBase64String(token))
            .Split(':');
        if (parts.Length != 2) return false;

        createdAt = new DateTime(long.Parse(parts[0]), DateTimeKind.Utc);
        id = int.Parse(parts[1]);
        return true;
    }
}
```

Fíjate en el `AsNoTracking()` de la consulta. Estas son filas de lista de solo lectura, así que no hay razón para pagar por el rastreador de cambios; si no estás seguro de cuándo importa eso, mira [AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/). Para un endpoint de lista caliente, esta consulta también es una fuerte candidata para una [consulta compilada](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), ya que la forma nunca cambia entre solicitudes.

## El índice no es opcional

La paginación por keyset solo es rápida si la base de datos puede hacer seek. Eso requiere un índice cuyas columnas de clave y direcciones coincidan exactamente con tu `OrderBy`:

```csharp
// .NET 11, EF Core 11.0.0 - composite index matching the page order
modelBuilder.Entity<Post>()
    .HasIndex(p => new { p.CreatedAt, p.PostId })
    .IsDescending(true, true);
```

La guía oficial es contundente sobre esto en la [sección de índices](https://learn.microsoft.com/en-us/ef/core/querying/pagination): tu índice debe corresponder a tu ordenamiento de paginación. Si ordenas por `(CreatedAt DESC, PostId DESC)` pero indexas `(CreatedAt ASC, PostId ASC)`, muchas bases de datos todavía pueden escanear el índice hacia atrás, pero en el momento en que agregas una tercera columna o una dirección no coincidente, el planificador vuelve a un ordenamiento sobre todo el conjunto filtrado y tu página de costo constante desaparece. La dirección del índice es parte del contrato, no un detalle. Este es el mismo tipo de problema de "el plan de consulta está haciendo algo que no pediste" que una [consulta N+1](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) accidental: el LINQ se ve bien, pero el plan cuenta la verdadera historia, así que revisa el plan de ejecución real una vez antes de publicar.

## Por qué no la sintaxis de tuplas que has visto en SQL crudo

Si has escrito paginación por keyset en SQL hecho a mano, probablemente hayas usado comparación de valores de fila: `WHERE (CreatedAt, PostId) < (@ca, @id)`. Es la forma más limpia de expresar el mismo límite, la mayoría de las bases de datos relacionales la soportan, y tiende a producir un mejor plan que la cadena `OR` desplegada. La mala noticia para EF Core 11: todavía no puedes escribirla en LINQ. Los docs lo señalan explícitamente, y está rastreado por [dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822), que sigue abierto a partir de EF Core 11.0.0. Así que la expansión manual de `OR` de arriba no es un parche que vayas a descartar en la próxima versión; es el enfoque soportado actualmente.

Si ordenas por tres o más columnas, la cadena `OR` crece rápido y se vuelve propensa a errores. El patrón se generaliza de forma mecánica: para las claves de ordenamiento `a, b, c`, el predicado es `a > a0 || (a == a0 && b > b0) || (a == a0 && b == b0 && c > c0)`. Una vez que tienes más de dos claves, recurre a un helper mantenido como `MR.EntityFrameworkCore.KeysetPagination`, que construye este árbol de expresión por ti a partir de la misma definición de `OrderBy` y mantiene el `WHERE` sincronizado con el ordenamiento. Escribir a mano cadenas `OR` de cuatro niveles es cómo se omite la rama `==`.

## Paginar hacia atrás y otros casos límite

Algunas cosas muerden a la gente una vez que el camino feliz funciona:

- **Página anterior.** Para paginar hacia atrás, invierte cada comparación y cada dirección de `OrderBy`, toma una página, y luego invierte la lista en memoria antes de devolverla. No puedes reutilizar la consulta hacia adelante con un cursor "antes de" y el mismo ordenamiento; las filas volverían en el orden incorrecto.
- **El usuario no tiene acceso aleatorio.** La paginación por keyset soporta siguiente y anterior, no "salta a la página 47". Eso es inherente, no un bug. Si genuinamente necesitas saltos por número de página, los docs sugieren un híbrido: keyset para siguiente/anterior, offset solo para el salto aleatorio poco común. La mayoría de los feeds y scrolls infinitos nunca necesitan el salto en absoluto.
- **Conteo total.** El keyset te da filas, no un conteo de páginas restantes. Si la UI necesita "página 3 de 200", ese conteo es una consulta `COUNT(*)` aparte, y en una tabla grande suele ser la parte costosa, así que cachéala o elimina el requisito.
- **Columnas de ordenamiento anulables.** Si tu columna de ordenamiento es anulable, las comparaciones con `NULL` no se comportarán como `>`/`<`, y las filas con `NULL` pueden desaparecer de la paginación. O bien ordena por columnas no anulables o agrega una rama explícita de ordenamiento de `NULL`.
- **Estabilidad del cursor.** El cursor codifica valores, así que sigue siendo válido incluso si se insertan o eliminan filas a su alrededor, que es justamente el punto. Sí se rompe si la *fila a la que apunta* se elimina y dependes de volver a leer esa fila; como solo comparas contra sus valores, eso está bien, pero no asumas que la fila del cursor todavía existe.

La paginación por offset no siempre está mal. Para una tabla de administración pequeña, o cualquier grilla donde los usuarios realmente hacen clic en números de página, `Skip`/`Take` es más simple y la diferencia de rendimiento es invisible. En el momento en que la tabla es grande, intensiva en agregados, o se desplaza profundamente, el keyset es la versión que se mantiene rápida y se mantiene correcta. Ordena por una clave única, construye el `WHERE` para que coincida exactamente, indexa esas columnas en la misma dirección, y tu página más profunda costará lo mismo que la primera.

## Relacionados

- [How to use query splitting to avoid a cartesian explosion in EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)

## Fuentes

- [Pagination - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/pagination)
- [Indexes - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/modeling/indexes)
- [Support row value comparisons for keyset pagination - dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822)
- [MR.EntityFrameworkCore.KeysetPagination (GitHub)](https://github.com/mrahhal/MR.EntityFrameworkCore.KeysetPagination)
