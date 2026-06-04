---
title: "EF Core ExecuteUpdate frente a cargar entidades y SaveChanges: ¿cuál deberías usar?"
description: "Una guía de decisión y un benchmark real para EF Core 11: usa ExecuteUpdate para escrituras basadas en conjuntos por predicado, y la ruta cargar-luego-SaveChanges solo cuando necesitas el rastreador de cambios, los interceptores o un grafo de objetos complejo."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "es"
translationOf: "2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges"
translatedBy: "claude"
translationDate: 2026-06-04
---

Respuesta corta: si estás cambiando filas que coinciden con un predicado y no necesitas las entidades en memoria después, usa `ExecuteUpdateAsync`. Compila a un único `UPDATE` que se ejecuta enteramente en la base de datos, sin cargar filas y sin rastreo de cambios, y es uno o dos órdenes de magnitud más rápido una vez que superas unos cientos de filas. Vuelve al patrón cargar-luego-`SaveChanges` solo cuando realmente necesitas lo que te ofrece el rastreador de cambios: tokens de concurrencia comprobados automáticamente, interceptores de `SaveChanges` y eventos de dominio, comportamiento de cascada sobre un grafo rastreado, o lógica detallada por entidad que no puede expresarse como una única sentencia SQL.

Este artículo compara los dos enfoques en `Microsoft.EntityFrameworkCore` 11.0.0 ejecutándose sobre .NET 11 contra SQL Server 2025, con C# 14. Los dos no son herramientas intercambiables que simplemente difieren en velocidad: viven en capas distintas. `SaveChanges` es la unidad de trabajo sobre entidades rastreadas; `ExecuteUpdate` es un envoltorio tipado sobre una sentencia SQL basada en conjuntos. Elegir correctamente consiste sobre todo en ser honesto acerca de en qué capa vive realmente tu operación.

## Las dos formas, lado a lado

La ruta rastreada carga, muta y guarda:

```csharp
// .NET 11, EF Core 11.0.0 - tracked: load, mutate, save
var employees = await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ToListAsync();

foreach (var e in employees)
{
    e.Salary += 1000;
}

await context.SaveChangesAsync();
```

La ruta basada en conjuntos describe el cambio como un predicado más un asignador:

```csharp
// .NET 11, EF Core 11.0.0 - set-based: one UPDATE, nothing loaded
await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ExecuteUpdateAsync(s => s.SetProperty(e => e.Salary, e => e.Salary + 1000));
```

La primera versión realiza un `SELECT` que trae cada fila coincidente al cliente, construye una instantánea de rastreo de cambios por entidad, las compara en `SaveChanges` y luego emite un `UPDATE` por fila modificada (por lotes, pero aún parametrizado individualmente). La segunda emite una única sentencia:

```sql
UPDATE [e]
SET [e].[Salary] = [e].[Salary] + 1000
FROM [Employees] AS [e]
WHERE [e].[DepartmentId] = @departmentId
```

Para la mecánica completa de los métodos basados en conjuntos, el SQL que emiten, los asignadores de varias columnas y los asignadores delegados de EF Core 10, consulta la guía complementaria sobre [ExecuteUpdate y ExecuteDelete para escrituras masivas](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Este artículo trata sobre elegir entre ellos y la ruta rastreada.

## Matriz de características

| Característica | Cargar + SaveChanges | ExecuteUpdate / ExecuteDelete |
| ----------------------------- | ------------------------------------ | --------------------------------- |
| Filas cargadas al cliente | todas las filas coincidentes | ninguna |
| Instantánea del rastreador | una por entidad | ninguna |
| Viajes de ida y vuelta | 1 SELECT + UPDATE por lotes | 1 |
| SQL emitido | un UPDATE por entidad (por lotes) | un UPDATE basado en conjuntos |
| Tokens de concurrencia automáticos | sí (`DbUpdateConcurrencyException`) | no, a mano vía conteo de filas |
| Interceptores / eventos de SaveChanges | sí | no |
| Borrado en cascada sobre el grafo | sí (rastreado) | solo cascada de FK en la base de datos |
| Disponible desde | siempre | EF Core 7.0 |
| Soporte de inserción | sí (`Add`) | no, solo actualizar y borrar |
| Atómico entre sentencias | una transacción por SaveChanges | tú abres la transacción |

La matriz se divide limpiamente a lo largo de un eje: todo lo que `SaveChanges` hace por ti es consecuencia de materializar y rastrear entidades, y todo en lo que `ExecuteUpdate` es más rápido es consecuencia de negarse a hacerlo.

## Cuándo elegir ExecuteUpdate / ExecuteDelete

- **Escrituras basadas en conjuntos por predicado.** "Marcar como archivado cada pedido de más de 90 días", "borrar todas las filas marcadas como eliminadas", "incrementar un contador". El cambio es expresable como `WHERE` más `SET`, y no necesitas las filas después. Esta es la opción predeterminada para trabajos de mantenimiento masivo y limpieza en EF Core 11.
- **Lectura-modificación-escritura atómica sobre un único valor.** `SetProperty(b => b.Balance, b => b.Balance - amount)` calcula el nuevo valor en la base de datos en una única sentencia, sin ventana para que otra transacción se cuele entre tu lectura y tu escritura. La ruta rastreada abre exactamente esa ventana porque lee en un viaje y escribe en otro.
- **Endpoints de una sola fila en rutas calientes con un token de concurrencia.** Pon el token en el `Where` y comprueba el conteo de filas afectadas. Esto suele ser más rápido que la ruta rastreada incluso para una sola fila, porque omite el `SELECT` y la instantánea por completo. Combina de forma natural con las [consultas compiladas en rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Ya estás luchando contra viajes de ida y vuelta por fila.** Si recurriste a un `foreach` sobre una consulta de rastreo, estás haciendo lo mismo que hace lenta a una [consulta N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): trabajo fila a fila que la base de datos podría hacer en una única operación basada en conjuntos.

## Cuándo elegir cargar + SaveChanges

- **Necesitas concurrencia optimista automática.** Con un token `[Timestamp]` / `rowversion`, `SaveChanges` lo añade al `WHERE`, cuenta las filas afectadas y lanza `DbUpdateConcurrencyException` para que resuelvas el conflicto. `ExecuteUpdate` no hará esto por ti; tienes que inspeccionar el conteo tú mismo.
- **Interceptores de `SaveChanges`, auditoría o eventos de dominio.** Si tienes un `ISaveChangesInterceptor` estampando `ModifiedUtc`, escribiendo una fila de auditoría o despachando eventos de dominio, una sentencia basada en conjuntos lo elude todo. La escritura ocurre, pero nada de tu lógica transversal se ejecuta.
- **Grafos de objetos complejos y comportamiento de cascada.** Insertar o modificar un padre con hijos, donde EF Core calcula el orden y las cascadas, es exactamente para lo que sirve la unidad de trabajo rastreada. No hay `ExecuteInsert`, y las cascadas que has configurado como comportamientos de EF (en lugar de cascadas de FK de la base de datos) solo se ejecutan a través de `SaveChanges`.
- **Lógica por entidad que no es una única expresión SQL.** Si el nuevo valor de cada fila depende de código de aplicación (llamar a un servicio, ramificar según datos que no están en la tabla, calcular algo que SQL no puede expresar), tienes que cargar las entidades y mutarlas en C#.

## El benchmark

Esto es una ejecución de BenchmarkDotNet, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, contra SQL Server 2025 en el mismo host (Windows 11, 12 núcleos / 32 GB, TCP local, pool de conexiones caliente). Cada iteración actualiza una única columna `decimal` en cada fila coincidente de una tabla `Employees` de 200 000 filas, variando la selectividad del predicado. El procesamiento por lotes predeterminado se deja intacto (SQL Server limita un lote de `SaveChanges` a 42 sentencias). Los tiempos son la media de la fase de medición de BenchmarkDotNet; menos es mejor.

| Filas cambiadas | Cargar + SaveChanges | ExecuteUpdate | Aceleración |
| --------------- | -------------------- | ------------- | ----------- |
| 100 | 11,4 ms | 2,1 ms | ~5x |
| 1 000 | 92 ms | 3,0 ms | ~30x |
| 10 000 | 880 ms | 8,7 ms | ~100x |
| 100 000 | 9 100 ms | 64 ms | ~140x |

La forma es el titular, no las cifras exactas: la ruta rastreada escala aproximadamente de forma lineal con el número de filas porque paga por una instantánea materializada y un `UPDATE` parametrizado por fila, mientras que `ExecuteUpdate` se mantiene casi plano porque la base de datos hace todo en una sentencia y el cliente nunca ve las filas. Con 100 filas la diferencia es real pero lo bastante pequeña como para que otras preocupaciones (tokens de concurrencia, interceptores) puedan decidir legítimamente por ti. Con 10 000 filas la ruta rastreada está haciendo un trabajo que la sentencia basada en conjuntos simplemente no hace, y ninguna cantidad de ajuste de `MaxBatchSize` cierra esa brecha, porque el costo es la materialización y los viajes de ida y vuelta, no el tamaño del lote. Estas cifras coinciden con las diferencias de orden de magnitud reportadas en la propia [guía de actualización eficiente](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating) de Microsoft y en benchmarks independientes como el [artículo sobre actualizaciones masivas en EF Core](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates) de Milan Jovanovic. Vuelve a ejecutar siempre sobre tu propio esquema y hardware antes de citar un multiplicador; la selectividad, los índices y el ancho de fila lo mueven todo.

Una cosa que la tabla oculta: ajustar `MaxBatchSize` ayuda a la ruta rastreada solo en la parte media del rango. La documentación señala que el procesamiento por lotes es menos eficiente por debajo de 4 sentencias y el beneficio se degrada pasadas unas 40 para SQL Server, por lo que el límite predeterminado es 42. Subirlo a 100 recorta un poco la columna rastreada con 1 000 filas y no hace nada significativo con 100 000, porque sigues enviando un `UPDATE` por fila a través del cable.

## El detalle que decide por ti: el rastreador de cambios queda obsoleto

La decisión no siempre es sobre velocidad. El error más común cuando estas dos rutas se encuentran es mezclarlas en la misma unidad de trabajo. `ExecuteUpdate` escribe SQL directamente y nunca le dice nada al rastreador de cambios, así que cualquier entidad que ya hayas cargado conserva su instantánea obsoleta:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var blog = await context.Blogs.SingleAsync(b => b.Id == id); // tracked, Rating == 5

await context.Blogs
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, b => b.Rating + 1)); // DB now 6

blog.Rating += 2;            // in-memory 7, original still recorded as 5
await context.SaveChangesAsync(); // writes 7, silently clobbering the bulk +1
```

Tras la escritura masiva la fila es `6`, pero la instancia rastreada nunca se enteró. `SaveChanges` compara el valor actual `7` contra el original `5` que registró en la instantánea, decide que la propiedad cambió y escribe `7`. Tu incremento masivo desaparece. Esta es la misma categoría de fallo que la que está detrás de ["the instance of entity type cannot be tracked"](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): el rastreador de cambios es contabilidad en memoria con estado, y las escrituras por canal lateral no lo actualizan.

Si debes hacer ambas cosas contra las mismas filas, ejecuta primero la escritura masiva y luego `context.ChangeTracker.Clear()` antes de volver a consultar, o consulta las filas afectadas con `AsNoTracking()` para que nada rastreado pueda quedar obsoleto. El mismo límite es la razón por la que no puedes probar estos métodos a través de un sustituto en memoria; es el razonamiento detrás de [simular un DbContext sin romper el rastreo de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

El segundo detalle son las transacciones. `SaveChanges` envuelve todo su lote en una transacción; dos llamadas a `ExecuteUpdate` son dos transacciones independientes a menos que abras una tú mismo sobre `context.Database.BeginTransactionAsync()`. Si necesitas que dos sentencias masivas tengan éxito o fallen juntas, eso corre por tu cuenta.

## La recomendación, reafirmada

Usa por defecto `ExecuteUpdate` y `ExecuteDelete` para cualquier cosa que sea conceptualmente un cambio basado en conjuntos: describes las filas con un predicado, describes el cambio con un asignador, y dejas que la base de datos lo haga en una sentencia. La diferencia de rendimiento no es marginal una vez que superas unos cientos de filas, y el código es más corto y claro. Trata la ruta cargar-luego-`SaveChanges` como la elección deliberada que haces cuando necesitas los servicios del rastreador de cambios: detección automática de conflictos de concurrencia, interceptores y eventos de dominio, comportamiento de cascada sobre un grafo rastreado, o lógica por fila que no se reduce a SQL. Esas son características reales y valiosas, y cuando las necesitas la ruta rastreada es correcta independientemente de la velocidad. Lo que no deberías hacer es recurrir al bucle de rastreo por costumbre para cambiar diez mil filas que un único `UPDATE` manejaría, y nunca deberías dejar que las dos rutas toquen las mismas entidades en una unidad de trabajo sin limpiar el rastreador entremedias.

Para el caso de *inserción* de alto volumen, ninguno de los métodos es la respuesta, ya que no hay `ExecuteInsert`; ese tiene su propio benchmark en [EF Core 11 frente a Dapper para inserciones masivas](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Relacionado

- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [EF Core 11 frente a Dapper para inserciones masivas: un benchmark real](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Cómo usar consultas compiladas con EF Core en rutas calientes](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Solución: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Fuentes

- [Actualización eficiente - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating)
- [ExecuteUpdate y ExecuteDelete - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)
- [Resumen de guardado de datos - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/)
- [What you need to know about EF Core bulk updates (Milan Jovanovic)](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates)
