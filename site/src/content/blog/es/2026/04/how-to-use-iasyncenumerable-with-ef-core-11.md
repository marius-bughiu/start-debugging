---
title: "Cómo usar IAsyncEnumerable<T> con EF Core 11"
description: "Las consultas de EF Core 11 implementan IAsyncEnumerable<T> directamente. Aquí está cómo hacer streaming de filas con await foreach, cuándo preferirlo sobre ToListAsync, y las trampas alrededor de conexiones, tracking y cancelación."
pubDate: 2026-04-22
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "es"
translationOf: "2026/04/how-to-use-iasyncenumerable-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

Si tienes una consulta en EF Core 11 que devuelve muchas filas, no tienes que materializar el conjunto completo en un `List<T>` antes de empezar a procesarla. Un `IQueryable<T>` de EF Core ya implementa `IAsyncEnumerable<T>`, así que puedes hacer `await foreach` directamente sobre él y cada fila se emite conforme la base de datos la produce. Sin `ToListAsync`, sin iterador personalizado, sin el paquete `System.Linq.Async`. Esa es la respuesta corta. Este post recorre la mecánica, los detalles de versión para EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14), y las trampas que muerden a la gente que atornilla el streaming a una base de código que no fue diseñada para ello.

## Por qué EF Core expone `IAsyncEnumerable<T>` en primer lugar

El pipeline de consultas de EF Core está construido alrededor de un data reader. Cuando llamas a `ToListAsync()`, EF Core abre una conexión, ejecuta el comando y saca filas del reader a una lista buffereada hasta que el reader se agota, luego cierra todo. Obtienes un `List<T>`, lo cual es conveniente, pero el conjunto completo ahora vive en la memoria de tu proceso y la primera fila solo es visible para tu código después de que la última fila se haya leído.

`IAsyncEnumerable<T>` le da la vuelta a eso. Pides filas de una en una. EF Core abre la conexión, corre el comando y emite la primera entidad materializada tan pronto como la primera fila sale del cable. Tu código empieza a trabajar de inmediato. La memoria se mantiene acotada a lo que tu cuerpo de bucle retenga. Para reportes, exportaciones y pipelines que transforman filas antes de escribirlas en otro lugar, este es el patrón que quieres.

Como `DbSet<TEntity>` y el `IQueryable<TEntity>` devuelto por cualquier cadena LINQ implementan ambos `IAsyncEnumerable<TEntity>`, no necesitas una llamada explícita a `AsAsyncEnumerable()` para que funcione. La interfaz está ahí. La maquinaria del async foreach la recoge.

## El ejemplo mínimo

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();

await foreach (var invoice in db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt))
{
    await ProcessAsync(invoice);
}
```

Eso es todo. Sin `ToListAsync`. Sin asignación intermedia. El `DbDataReader` subyacente permanece abierto durante toda la duración del bucle. Cada iteración saca otra fila del cable, materializa la `Invoice` y la entrega al cuerpo de tu bucle.

Contrasta con la versión basada en lista:

```csharp
// Buffers every row into memory before the first ProcessAsync call
var invoices = await db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt)
    .ToListAsync();

foreach (var invoice in invoices)
{
    await ProcessAsync(invoice);
}
```

Para 50 filas, la diferencia es invisible. Para 5 millones de filas, la versión de streaming termina la primera factura antes de que la versión buffereada haya terminado de asignar la lista.

## Pasando un token de cancelación de la forma correcta

La sobrecarga `IQueryable<T>.GetAsyncEnumerator(CancellationToken)` toma un token, pero cuando escribes `await foreach (var x in query)` no tienes un sitio para pasar uno. El arreglo es `WithCancellation`:

```csharp
public async Task ExportPendingAsync(CancellationToken ct)
{
    await foreach (var invoice in db.Invoices
        .Where(i => i.Status == InvoiceStatus.Pending)
        .AsNoTracking()
        .WithCancellation(ct))
    {
        ct.ThrowIfCancellationRequested();
        await writer.WriteAsync(invoice, ct);
    }
}
```

`WithCancellation` no envuelve la secuencia en otro iterador. Solo enhebra el token en la llamada a `GetAsyncEnumerator`, que EF Core reenvía a `DbDataReader.ReadAsync`. Si el llamador cancela el token, el `ReadAsync` pendiente se cancela, el comando se aborta en el servidor y `OperationCanceledException` burbujea a través de tu `await foreach`.

No te saltes el token. Un token olvidado en una consulta de EF Core en streaming es una request colgada en producción cuando el cliente HTTP se desconecta. La ruta basada en lista falla de la misma forma, pero aquí duele más porque la conexión se mantiene durante todo el bucle, no solo durante el paso de materialización.

## Desactiva el tracking a menos que realmente lo necesites

`AsNoTracking()` importa más cuando haces streaming que cuando buffereas. Con el change tracking activado, cada entidad emitida por el enumerador se agrega al `ChangeTracker`. Esa es una referencia que el GC no puede recolectar hasta que liberes el `DbContext`. Hacer streaming de un millón de filas en una consulta con tracking derrota el propósito del streaming: la memoria crece linealmente con las filas, igual que `ToListAsync`.

```csharp
await foreach (var row in db.AuditEvents
    .AsNoTracking()
    .Where(e => e.OccurredAt >= cutoff)
    .WithCancellation(ct))
{
    await sink.WriteAsync(row, ct);
}
```

Solo mantén el tracking si tu intención es mutar las entidades y llamar a `SaveChangesAsync` dentro del bucle, lo cual, como argumenta la siguiente sección, casi nunca deberías hacer.

## No puedes abrir una segunda consulta en el mismo contexto mientras una está haciendo streaming

Esta es la trampa más común en producción. El `DbDataReader` que EF Core abre cuando empiezas a enumerar retiene la conexión. Si dentro del bucle llamas a otro método de EF Core que necesite esa conexión, obtienes:

```
System.InvalidOperationException: There is already an open DataReader associated
with this Connection which must be closed first.
```

En SQL Server puedes sortearlo activando Multiple Active Result Sets (`MultipleActiveResultSets=True` en el connection string), pero MARS tiene sus propias compensaciones de rendimiento y no está soportado en todos los proveedores. El mejor patrón es no mezclar operaciones en un único contexto. Opciones:

- Recoger los IDs que necesitas primero, cerrar el stream y luego hacer el trabajo de seguimiento; o
- Usar un segundo `DbContext` para las llamadas internas.

```csharp
await foreach (var order in queryCtx.Orders
    .AsNoTracking()
    .WithCancellation(ct))
{
    await using var writeCtx = await factory.CreateDbContextAsync(ct);
    writeCtx.Orders.Attach(order);
    order.ProcessedAt = DateTime.UtcNow;
    await writeCtx.SaveChangesAsync(ct);
}
```

`IDbContextFactory<TContext>` (registrado vía `AddDbContextFactory` en tu cableado de DI) es la forma más limpia de obtener ese segundo contexto sin pelear contra los ciclos de vida scoped.

## El streaming y las transacciones no combinan bien

Un enumerador en streaming mantiene una conexión abierta mientras tu bucle corra. Si ese bucle también participa en una transacción, la transacción permanece abierta durante todo el bucle. Las transacciones de larga duración son cómo obtienes escalación de locks, escritores bloqueados y el tipo de timeouts que solo aparecen bajo carga.

Dos reglas que mantienen esto cuerdo:

1. No abras una transacción alrededor de una lectura en streaming a menos que específicamente necesites un snapshot consistente.
2. Si necesitas un snapshot, considera aislamiento `SNAPSHOT` en SQL Server o aislamiento `REPEATABLE READ` en tu proveedor elegido, y trata el cuerpo del bucle como un camino caliente. Sin llamadas HTTP, sin esperas visibles al usuario.

Para trabajos de procesamiento por lotes, la forma usual es: lectura en streaming, escritura por fila o en lotes en una transacción corta en un contexto separado, commit, seguir adelante.

## `AsAsyncEnumerable` existe, y a veces lo necesitas

Si tienes un método que acepta `IAsyncEnumerable<T>` y quieres alimentarlo con una consulta EF Core, pasar el `IQueryable<T>` directamente compila porque la interfaz está implementada, pero se ve mal en el sitio de llamada. `AsAsyncEnumerable` es un no-op en runtime que hace explícita la intención:

```csharp
public async Task ExportAsync(IAsyncEnumerable<Invoice> source, CancellationToken ct)
{
    // Consumes a generic async sequence. Does not know it is EF.
}

await ExportAsync(
    db.Invoices.AsNoTracking().AsAsyncEnumerable(),
    ct);
```

También fuerza a la llamada a salir del mundo `IQueryable`. Una vez que pasas por `AsAsyncEnumerable()`, cualquier operador LINQ posterior se ejecuta en el cliente como operadores de iterador asíncrono, no como SQL. Ese es el comportamiento que quieres aquí, porque el método receptor no debería reescribir accidentalmente la consulta.

## Qué pasa si rompes el bucle antes de tiempo

Los iteradores asíncronos limpian al liberarse. Cuando el `await foreach` sale, por la razón que sea (break, excepción o completado), el compilador llama a `DisposeAsync` sobre el enumerador, lo que cierra el `DbDataReader` y devuelve la conexión al pool. Por eso el `await using` sobre el `DbContext` sigue importando, pero la consulta individual no necesita su propio bloque using.

Una consecuencia no obvia: si haces `break` tras la primera fila de una consulta de 10 millones de filas, EF Core no lee las otras filas, pero la base de datos puede haber encolado ya muchas. El plan de consulta no sabe que perdiste interés. Para SQL Server, el `DbDataReader.Close` del lado cliente envía un cancel sobre el stream TDS y el servidor se retira, pero para conteos enormes aún puedes ver unos segundos de trabajo del servidor después de que tu bucle sale. Esto casi nunca es un problema, pero vale la pena saberlo cuando un depurador muestra una consulta corriendo en el servidor tras que tu test ya haya pasado.

## No abuses de `ToListAsync` encima de una fuente en streaming

De vez en cuando alguien escribe esto:

```csharp
// Pointless: materializes the whole thing, then streams it
var all = await db.Invoices.ToListAsync(ct);
await foreach (var item in all.ToAsyncEnumerable()) { }
```

No tiene beneficio. Si quieres streaming, ve directamente del `IQueryable` al `await foreach`. Si quieres buffering, mantén el `List<T>` y usa un `foreach` normal. Mezclarlos siempre revela a alguien que no sabía cuál quería.

De forma similar, llamar a `.ToAsyncEnumerable()` sobre una consulta EF Core es redundante en EF Core 11: la fuente ya implementa la interfaz. Compila y funciona, pero no lo añadas.

## La evaluación en cliente aún se cuela

El traductor de consultas de EF Core es bueno, pero no toda expresión LINQ se traduce a SQL. Si no puede, EF Core 11 lanza por defecto sobre el operador final (a diferencia del silencioso client-eval de EF Core 2.x). El streaming no cambia esto: si tu filtro `.Where` referencia un método que EF Core no puede traducir, toda la consulta falla en tiempo de enumeración, no al inicio del `await foreach`.

La sorpresa es que con `await foreach`, la excepción aflora en el primer `MoveNextAsync`, que está dentro del encabezado del bucle, no antes. Envuelve el setup en un `try` si quieres distinguir errores de setup de errores de procesamiento:

```csharp
try
{
    await foreach (var row in query.WithCancellation(ct))
    {
        try { await ProcessAsync(row, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Row {Id} failed", row.Id); }
    }
}
catch (Exception ex)
{
    log.LogError(ex, "Query failed before first row");
    throw;
}
```

## Cuándo `ToListAsync` sigue siendo la respuesta correcta

El streaming no es universalmente mejor. Usa `ToListAsync` cuando:

- El conjunto de resultados es pequeño y acotado (digamos, bajo unos miles de filas).
- Necesitas iterar el resultado más de una vez.
- Necesitas `Count`, indexación o cualquier otra operación de `IList<T>`.
- Planeas bindear el resultado a un control de UI o serializarlo en un cuerpo de respuesta que espera una colección materializada.

El streaming gana cuando el resultado es grande, cuando la memoria importa, cuando el consumidor es en sí asíncrono (un `PipeWriter`, un `IBufferWriter<T>`, un `Channel<T>`, un bus de mensajes), o cuando la latencia de primer byte importa más que el throughput total.

## Checklist rápida para streaming en EF Core 11

- `await foreach` directamente sobre un `IQueryable<T>`. Sin `ToListAsync`.
- Siempre `AsNoTracking()` salvo que tengas una razón concreta para no hacerlo.
- Siempre `WithCancellation(ct)`.
- Usa `IDbContextFactory<TContext>` si necesitas un segundo contexto para escrituras dentro del bucle.
- No envuelvas una lectura en streaming en una transacción larga.
- No abras un segundo reader en el mismo contexto sin MARS.
- Espera que el primer `MoveNextAsync` aflore errores de traducción y de conexión.

## Relacionados

- [Cómo usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) combina bien con lecturas en streaming cuando tus entidades son inmutables.
- [Migraciones en un solo paso con EF Core 11 y `dotnet ef update add`](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) cubre el lado de las herramientas del mismo release.
- [Haciendo streaming de tareas con Task.WhenEach de .NET 9](/2026/01/streaming-tasks-with-net-9-task-wheneach/) para el otro patrón principal de `IAsyncEnumerable<T>` en .NET moderno.
- [HttpClient GetFromJsonAsAsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/) muestra la misma forma de streaming en el lado HTTP.
- [EF Core 11 preview 3 poda joins de referencia en consultas split](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) para el contexto de rendimiento del mismo release.

## Fuentes

- [Async Queries de EF Core, MS Learn](https://learn.microsoft.com/en-us/ef/core/miscellaneous/async).
- [Ciclo de vida y pooling de `DbContext`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/).
- [`IDbContextFactory<TContext>`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- [`AsyncEnumerableReader` en el código fuente de EF Core en GitHub](https://github.com/dotnet/efcore).
