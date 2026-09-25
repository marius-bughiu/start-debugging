---
title: "Refit 16.1 escribe tu bucle de paginación: PagedEnumerable, [Paged] y [PageToken]"
description: "Refit 16.1.0 permite que un método de una interfaz devuelva PagedEnumerable<TPage, TItem>, y el generador de código fuente emite el bucle de una solicitud por página para cursores, offsets, encabezados de respuesta y enlaces next. Aquí tienes cómo declararlo, cómo se comporta la enumeración y el error de compilación RF013 que obtienes por un miembro mal escrito."
pubDate: 2026-09-25
tags:
  - "refit"
  - "httpclient"
  - "dotnet"
  - "csharp"
  - "source-generators"
lang: "es"
translationOf: "2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable"
translatedBy: "claude"
translationDate: 2026-09-25
---

[Refit 16.1.0](https://github.com/reactiveui/refit/releases/tag/v16.1.0) se lanzó el 21 de septiembre de 2026, y su función principal elimina una parte del código repetitivo que casi todos los usuarios de Refit han escrito: el bucle `while (cursor != null)` alrededor de un endpoint de lista. Ahora un método de Refit puede devolver `PagedEnumerable<TPage, TItem>`, y el generador de código fuente escribe el bucle que envía una solicitud por página. El diseño está en [PR #2332](https://github.com/reactiveui/refit/pull/2332).

## Declarar un método paginado

Describes la forma de la página con dos atributos. `[Paged]` nombra el miembro que contiene la continuación, y `[PageToken]` marca el parámetro que la envía de vuelta:

```csharp
public interface IOrdersApi
{
    [Get("/orders")]
    [Paged(Next = nameof(OrderPage.NextCursor))]
    PagedEnumerable<OrderPage, Order> ListOrders(
        [AliasAs("limit")] int pageSize,
        [PageToken] string? cursor = null);
}

public sealed class OrderPage
{
    public List<Order> Items { get; set; } = [];
    public string? NextCursor { get; set; }
}
```

`Items` es opcional aquí: cuando el tipo de página tiene exactamente una secuencia del tipo de elemento, el generador la elige. Un `NextCursor` nulo o vacío termina la secuencia. El parámetro del token se enlaza como cualquier otro, así que `[Header]` o `[Query]` lo sacan de la cadena de consulta.

Llamarlo es un simple `await foreach`, y las solicitudes solo se envían a medida que consumes los elementos. Ejecuté esto contra un handler falso que servía siete pedidos en páginas de tres:

```csharp
await foreach (var order in api.ListOrders(pageSize: 3))
    Console.WriteLine(order.Id);

// Requests sent:
//   /orders?limit=3
//   /orders?limit=3&cursor=3
//   /orders?limit=3&cursor=6
```

Detener la enumeración antes de tiempo detiene las solicitudes. `await api.ListOrders(3).FirstAsync(o => o.Id == 2)` en .NET 10 hizo exactamente una solicitud.

## Páginas, límites y prefetch

`PagedEnumerable<TPage, TItem>` es un `IAsyncEnumerable<TItem>` con algunos miembros adicionales:

- `AsPages()` produce los objetos de página en sí, cuando necesitas `IsTruncated` o un total junto con los elementos.
- `WithMaxPages(n)` limita cuántas solicitudes puede hacer una enumeración.
- `WithPrefetch()` solicita la siguiente página mientras todavía estás procesando la actual.
- `ToObservable()` y `ToPageObservable()` para consumidores de Rx.

```csharp
await foreach (var page in api.ListOrders(3).WithMaxPages(2).AsPages())
    Console.WriteLine($"{page.Items.Count} items, next={page.NextCursor}");
```

## Encabezados, offsets y enlaces next

`[Paged]` también cubre los otros estilos de paginación:

- `NextHeader = "x-ms-continuation"` lee la continuación desde un encabezado de respuesta (al estilo de Cosmos DB). El tipo de página debe ser `ApiResponse<T>`.
- `NextHeader = "Link"` lee la relación `rel="next"`, que es la forma en que pagina GitHub.
- `Total = nameof(Result.Total)` cambia a paginación por offset con un token `int`, para APIs como Jira.
- `Next` apuntando a una URL absoluta, como `@odata.nextLink` de Graph, sigue enlaces.

Seguir enlaces viene con un requisito de seguridad: debes indicar a qué orígenes puede apuntar un enlace con `Origins = ["https://api.github.com"]`, `SameOrigin = true`, o `AnyOrigin = true`. Un enlace a cualquier otro origen lanza `InvalidOperationException` sin llegar a solicitarse, así que tu encabezado `Authorization` nunca se reenvía a un host que un servidor hostil indique.

## Los errores hacen fallar la compilación

Los nombres de los miembros se resuelven en tiempo de compilación como acceso directo a propiedades, sin reflection. Un error de escritura produce el error `RF013`:

```text
error RF013: Method 'ListOrders' cannot be generated as a paged method:
'NextCusor' is not a readable public or internal property or field of 'OrderPage'.
```

Un método paginado tampoco puede ser genérico ni declarar su propio `CancellationToken`, ya que el token proviene de la enumeración. El generador de solicitudes basado en reflection rechaza los retornos paginados, así que esto solo funciona con el cliente generado por el generador de código fuente, y un método paginado que el generador no puede emitir en línea se reporta como `RF007`.

Si estabas evaluando Refit frente a un cliente tipado escrito a mano, consulta [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/). La paginación era uno de los puntos donde el cliente escrito a mano solía ganar en control. Refit ahora genera ese bucle por ti, con un error de compilación cuando la forma de la página es incorrecta.
