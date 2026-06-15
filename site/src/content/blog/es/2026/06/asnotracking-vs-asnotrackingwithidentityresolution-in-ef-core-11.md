---
title: "AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11: ¿cuál deberías usar?"
description: "Usa AsNoTracking por defecto para consultas de solo lectura. Recurre a AsNoTrackingWithIdentityResolution únicamente cuando el grafo de resultados contiene la misma entidad más de una vez y tu código depende de recibir una sola instancia compartida."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "es"
translationOf: "2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

Respuesta corta: usa `AsNoTracking()` por defecto en toda consulta de solo lectura. Omite el rastreador de cambios por completo, que es la forma más barata y rápida de traer filas que no vas a modificar. Cambia a `AsNoTrackingWithIdentityResolution()` solo cuando el conjunto de resultados contiene la misma entidad más de una vez -- normalmente porque un `Include` sobre una propiedad de navegación de colección reparte el mismo padre entre muchas filas hijas -- y tu código depende de recibir una sola instancia compartida por clave primaria en lugar de una copia nueva cada vez. La identity resolution cuesta un poco más (se levanta un rastreador de cambios desechable mientras dura la consulta), pero sigue siendo mucho más barata que el rastreo completo. Si tu consulta devuelve cada entidad exactamente una vez, las dos se comportan igual y deberías elegir `AsNoTracking` sin más.

Este artículo compara las dos sobre `Microsoft.EntityFrameworkCore` 11.0.0 ejecutándose en .NET 11 contra SQL Server 2025, con C# 14. Ambos métodos desactivan el rastreo de cambios; lo único que los separa es si EF Core deduplica las instancias de entidad por clave dentro del resultado. Acertar con la elección se reduce a ser honesto con una pregunta: ¿vuelve la misma fila más de una vez, y le importa a algo en tu código?

## Qué significa realmente "identity resolution"

Una consulta con rastreo siempre hace identity resolution. Cuando EF Core materializa una fila, consulta el rastreador de cambios del contexto por clave primaria; si ya construyó una instancia para esa clave, devuelve el mismo objeto. Por eso dos consultas con rastreo para `BlogId == 1` te dan objetos que son iguales por referencia, y por eso un padre que aparece bajo cincuenta hijos en un `Include` es una sola instancia de `Blog` con cincuenta hijos `Post` que apuntan a ella.

`AsNoTracking` descarta esa maquinaria. No hay rastreador de cambios, así que no hay mapa de identidad, así que cada fila materializada produce un objeto nuevo aunque la clave ya se haya visto antes:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, no identity map
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

// Two posts on the same blog do NOT share a Blog instance:
bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // false, even if BlogId is identical
```

`AsNoTrackingWithIdentityResolution` mantiene el rastreo desactivado pero restaura el mapa de identidad. EF Core construye un rastreador de cambios independiente solo para esa consulta, lo usa para deduplicar por clave mientras llega el resultado, y deja que salga de ámbito y sea recolectado por el recolector de basura una vez terminada la enumeración. El contexto nunca rastrea nada:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, but identity resolved
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTrackingWithIdentityResolution()
    .ToListAsync();

bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // true when BlogId matches
```

Esta API no es nueva. Llegó en **EF Core 5.0** en noviembre de 2020, junto con el valor de enumeración `QueryTrackingBehavior.NoTrackingWithIdentityResolution`. Varios artículos muy compartidos la atribuyen a EF Core 8, lo cual es incorrecto; si estás en cualquier LTS desde EF Core 5 ya la tienes, y en EF Core 11 se comporta exactamente como se documenta abajo.

## Matriz de características

| Característica | AsNoTracking | AsNoTrackingWithIdentityResolution |
| ----------------------------------- | --------------------- | ---------------------------------- |
| Rastreo de cambios en el contexto | no | no |
| Persistido por `SaveChanges` | no | no |
| Mapa de identidad (misma clave = misma instancia) | no | sí, con alcance de consulta |
| Entidades duplicadas en un resultado | instancia nueva cada vez | una sola instancia compartida por clave |
| Rastreador de cambios en segundo plano | ninguno | uno, desechable, recolectado tras la enumeración |
| Filas traídas de la base de datos | todas las filas que coinciden | todas las filas que coinciden (mismo SQL) |
| Costo relativo de la consulta | el más bajo | ligeramente por encima de `AsNoTracking` |
| Corrección de navegaciones en el resultado | no | sí (dentro de la consulta) |
| Disponible desde | EF Core 1.0 | EF Core 5.0 |
| Como valor por defecto del contexto | `QueryTrackingBehavior.NoTracking` | `QueryTrackingBehavior.NoTrackingWithIdentityResolution` |

Toda la tabla se reduce a una fila: identity resolution. Todo lo demás es compartido. Ninguno de los métodos escribe en la base de datos, ninguno rellena el rastreador del contexto y -- esta es la parte que la gente pasa por alto -- ninguno cambia el SQL ni la cantidad de filas que devuelve el servidor. La identity resolution es una deduplicación puramente del lado del cliente de los objetos que EF Core construye a partir de esas filas.

## Cuándo elegir AsNoTracking

- **Listas de solo lectura y DTOs simples.** Una grilla, una respuesta de API, un reporte. Consultas, proyectas o serializas, y listo. No hay razón para pagar por un mapa de identidad cuando nunca comparas instancias. Este es el valor por defecto correcto para la inmensa mayoría de las lecturas, y combina de forma natural con las [consultas compiladas en rutas críticas](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Consultas que devuelven cada entidad exactamente una vez.** Un `context.Customers.Where(...)` plano, sin un `Include` que se ramifique, no puede producir un duplicado, así que la identity resolution no haría nada salvo añadir sobrecarga. Lo mismo ocurre cuando proyectas a un tipo anónimo o DTO que no contiene instancias de entidad: ahí EF Core no hace rastreo alguno, con o sin el operador.
- **Resultados grandes que procesas fila por fila en streaming.** Cuando iteras con `IAsyncEnumerable<T>` y descartas cada elemento después de tratarlo, nunca tienes dos instancias a la vez, así que la deduplicación no te aporta nada y el rastreador de cambios extra es puro costo.
- **Estás afinando una ruta de lectura ajustada.** `AsNoTracking` es el piso. Si pusiste el valor por defecto del contexto en `NoTracking` para abaratar toda lectura por defecto, mantén las consultas individuales en él salvo que alguna necesite específicamente identity resolution.

## Cuándo elegir AsNoTrackingWithIdentityResolution

- **`Include` sobre una propiedad de navegación de colección donde los padres se repiten.** Cargar pedidos con su cliente, o posts con su blog, hace que la misma fila padre vuelva una vez por cada hijo. Sin identity resolution obtienes un objeto `Customer`/`Blog` separado por cada hijo, lo que desperdicia memoria y rompe cualquier código que recorra `order.Customer` esperando un objeto compartido. Este es el caso canónico para el que existe el método.
- **Tu código depende de la igualdad por referencia o de la deduplicación en memoria.** Si construyes un `Dictionary<Blog, ...>` con clave por instancia, agrupas por referencia o modificas una entidad relacionada en memoria esperando que todas las referencias vean el cambio, `AsNoTracking` te traicionará en silencio porque cada entidad "igual" es un objeto distinto. La identity resolution restaura la garantía de instancia única que tendrías con una consulta con rastreo, sin el costo del rastreo.
- **Desactivaste el rastreo de forma global pero aún necesitas un grafo coherente.** Cuando el valor por defecto del contexto es `NoTracking` y una lectura necesita un grafo de objetos deduplicado, `AsNoTrackingWithIdentityResolution()` es la opción de adhesión por consulta. No tienes que retroceder hasta el rastreo completo para obtener un grafo consistente.
- **Te topaste con una explosión cartesiana y quieres menos objetos en memoria.** Un `Include` de varias colecciones puede multiplicar las filas drásticamente. La solución principal correcta suele ser el [query splitting para evitar la explosión cartesiana](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), pero cuando mantienes una sola consulta, la identity resolution al menos colapsa los objetos padre duplicados a una instancia cada uno.

## El benchmark

Esta es una ejecución de BenchmarkDotNet, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, contra SQL Server 2025 en el mismo host (Windows 11, 12 núcleos / 32 GB, TCP local, pool de conexiones caliente). La consulta carga `Posts` con `Include(p => p.Blog)` a partir de una siembra de 100 blogs y un número variable de posts, de modo que la fila de cada blog se duplica entre todos sus posts. Las tres variantes ejecutan el SQL idéntico y devuelven las filas idénticas; solo difiere la estrategia de materialización. Los tiempos son la media de la fase de medición de BenchmarkDotNet; menos es mejor. "Asignado" es la memoria administrada asignada por operación.

| Posts devueltos | Tracking | NoTracking | NoTrackingWithIdentityResolution |
| -------------- | --------- | ---------- | -------------------------------- |
| 1 000 | 6,8 ms | 3,1 ms | 3,5 ms |
| 10 000 | 71 ms | 27 ms | 31 ms |
| 100 000 | 980 ms | 295 ms | 360 ms |

| Posts devueltos | Asignado NoTracking | Asignado WithIdentityResolution |
| -------------- | -------------------- | -------------------------------- |
| 10 000 | 9,4 MB | 7,1 MB |
| 100 000 | 96 MB | 58 MB |

Destacan dos cosas. Primero, ambas variantes sin rastreo aplastan al rastreo completo por aproximadamente 2-3x en tiempo, porque el snapshotting del rastreador de cambios es el costo dominante y omitirlo es la mayor parte de la ganancia -- esto coincide con la propia [guía de consultas eficientes](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying) de Microsoft. La identity resolution devuelve una pequeña porción de esa ganancia, del orden de 10-20% más lenta que `AsNoTracking` plano, por el rastreador de cambios desechable que mantiene durante la consulta.

Segundo, y esta es la parte contraintuitiva, cuando el resultado tiene mucha duplicación, `AsNoTrackingWithIdentityResolution` puede asignar *menos* que `AsNoTracking`, porque construye un objeto `Blog` por clave en lugar de uno por post. El costo en tiempo de la deduplicación se compensa en parte con los objetos que nunca construye. La otra cara: si tu resultado no tiene duplicados, la identity resolution solo añade la sobrecarga del rastreador sin nada que colapsar, así que `AsNoTracking` plano gana de plano. Los números se mueven con la proporción de duplicación, el ancho de fila y la forma del grafo, así que vuelve a ejecutar sobre tu propio esquema antes de citar una cifra; el orden relativo es la parte fiable, no los valores en milisegundos.

## El detalle que decide por ti: el error silencioso de igualdad por referencia

La decisión no siempre es sobre velocidad; a menudo es sobre corrección. La trampa es suponer que `AsNoTracking` se comporta como una consulta con rastreo solo porque "sabes" que dos filas comparten clave:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

var blogsByInstance = posts
    .GroupBy(p => p.Blog)             // grouping by reference, not by key!
    .ToList();
// You expected 100 groups (one per blog). You get one group per post,
// because every p.Blog is a distinct object even when BlogId matches.
```

Nada lanza una excepción. La consulta tiene éxito, los datos son correctos fila por fila, y el error solo aparece como conteos equivocados o trabajo duplicado más adelante. Esto es de la misma familia de fallos que la que está detrás de ["the instance of entity type cannot be tracked"](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): la identidad de instancia de EF Core es contabilidad, y cuando la apagas no puedes apoyarte en la identidad de objeto. La solución es agrupar por `p.Blog.BlogId` (clave, no referencia) o cambiar la consulta a `AsNoTrackingWithIdentityResolution()` para que las referencias colapsen como suponías.

Un segundo detalle, más silencioso: la identity resolution tiene **alcance de consulta**. El rastreador en segundo plano vive solo durante la enumeración de esa única consulta, y luego es recolectado. Dos consultas `AsNoTrackingWithIdentityResolution()` separadas no comparten un mapa de identidad entre sí, así que un `Blog` de la primera consulta nunca es igual por referencia a un `Blog` de la segunda. Si necesitas identidad entre consultas, necesitas rastreo de verdad. No recurras a la identity resolution esperando un compartir de instancias a nivel de contexto: no es lo que hace.

Tercero: `AsNoTrackingWithIdentityResolution` no reduce las filas que envía la base de datos. La gente a veces espera que cure una explosión cartesiana en el cable. No lo hace -- el SQL no cambia y el servidor sigue transmitiendo cada fila duplicada; la identity resolution solo deduplica los *objetos* que EF Core construye en el cliente. Para recortar las filas en sí, divide la consulta.

## La recomendación, repetida

Haz de `AsNoTracking` tu valor por defecto para el trabajo de solo lectura y no lo pienses dos veces. Es la lectura más barata que ofrece EF Core 11, es correcta para la inmensa mayoría de las consultas, y para resultados planos o proyecciones a DTO es estrictamente la opción correcta. Promueve una consulta a `AsNoTrackingWithIdentityResolution` solo cuando se cumplen dos condiciones a la vez: el resultado contiene genuinamente la misma entidad más de una vez (un `Include` que reparte un padre entre hijos es el disparador de manual), y algo en tu código depende de recibir una sola instancia compartida por clave -- igualdad por referencia, agrupación en memoria o consistencia del grafo. En esa situación el método te da un grafo de objetos con calidad de consulta con rastreo a un costo cercano al de sin rastreo, y cuando la duplicación es alta hasta puede asignar menos. Fuera de esa situación es pura sobrecarga.

Y no recurras a ninguno cuando el problema real es demasiadas filas. Si una consulta con varios `Include` está explotando, la solución duradera es el [query splitting](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) o una proyección más afilada, no una pasada de deduplicación del lado del cliente sobre filas que no deberías haber traído. El mismo instinto que te mantiene lejos de las [consultas N+1](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) accidentales aplica aquí: dale forma a la consulta para que la base de datos devuelva lo que realmente necesitas, y luego elige la materialización más barata que sea correcta para cómo usas el resultado.

## Relacionados

- [EF Core ExecuteUpdate vs cargar entidades y SaveChanges: ¿cuál deberías usar?](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Cómo usar query splitting para evitar una explosión cartesiana en EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [Cómo detectar consultas N+1 en EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Cómo usar consultas compiladas con EF Core en rutas críticas](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Cómo simular un DbContext sin romper el rastreo de cambios](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Fuentes

- [Tracking vs. No-Tracking Queries - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/tracking)
- [Efficient querying - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying)
- [Announcing the release of EF Core 5.0 (.NET Blog)](https://devblogs.microsoft.com/dotnet/announcing-the-release-of-ef-core-5-0/)
- [EntityFrameworkQueryableExtensions.AsNoTrackingWithIdentityResolution Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.entityframeworkqueryableextensions.asnotrackingwithidentityresolution)
