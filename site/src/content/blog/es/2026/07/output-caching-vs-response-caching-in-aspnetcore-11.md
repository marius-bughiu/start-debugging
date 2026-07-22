---
title: "Output caching vs response caching en ASP.NET Core 11: ¿cuál deberías usar?"
description: "El output caching es la opción por defecto correcta para casi toda app del lado del servidor en ASP.NET Core 11. El response caching solo gana cuando tu objetivo es dirigir las cachés del navegador y de los proxies mediante cabeceras HTTP. Aquí está la decisión, con una matriz de características y los detalles que fuerzan la elección."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "caching"
  - "performance"
  - "csharp"
lang: "es"
translationOf: "2026/07/output-caching-vs-response-caching-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

Para casi toda app de ASP.NET Core 11 que quiere servir una respuesta sin volver a ejecutar el handler, la respuesta es output caching (`AddOutputCache`). Está controlado por el servidor, admite invalidación basada en etiquetas y protección contra estampidas de caché, y no cede la decisión al cliente. Recurre al response caching (`AddResponseCaching`) solo en el caso puntual en que tu objetivo real es establecer las cabeceras HTTP `Cache-Control`, `Expires` y `Vary` para que los navegadores, los proxies compartidos y las CDN almacenen en caché por ti. Si lo que intentas es reducir la carga en tu propio servidor, gana el output caching. Este artículo apunta a .NET 11 (Preview 6 al momento de escribir, con disponibilidad general en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14, pero el output caching es estable desde ASP.NET Core 7 y el response caching desde mucho antes, así que la recomendación se mantiene sin cambios en .NET 7 hasta 11.

## La única distinción que lo decide

Ambas características pueden convertir una solicitud repetida en un acierto de caché barato, así que la gente las trata como intercambiables. No lo son. La diferencia está en quién controla la caché.

El response caching implementa el almacenamiento en caché HTTP del RFC 9111. Funciona leyendo y escribiendo cabeceras de caché HTTP y, algo crítico, respeta las cabeceras de la solicitud del cliente. Un cliente que envía `Cache-Control: no-cache` obliga a tu servidor a regenerar la respuesta cada vez, y no hay nada que puedas hacer al respecto desde el servidor, porque el middleware sigue la especificación por diseño. Ese es el comportamiento correcto para el almacenamiento en caché HTTP, cuyo propósito es reducir la latencia de red entre clientes y proxies, no proteger tu origen de la carga.

El output caching, agregado en ASP.NET Core 7, invierte eso. El servidor decide qué almacenar en caché y por cuánto tiempo, independientemente de las cabeceras del cliente. Un cliente hostil o ingenuo no puede invalidar tu caché enviando `no-cache`. Esa única propiedad es la razón por la que la propia documentación de Microsoft ahora recomienda el output caching para apps de servidor, y por la que la documentación del response caching dirige a los lectores hacia el output caching para apps de UI: "El output caching (disponible en .NET 7 y posteriores) es un mejor enfoque para apps de UI. En este escenario, la configuración determina qué almacenar en caché independientemente de las cabeceras HTTP."

## Matriz de características

Cada fila de abajo está verificada contra .NET 11 y la documentación de ASP.NET Core 11.

| Característica | Output caching | Response caching |
| ------------------------------ | ---------------------------------- | -------------------------------------- |
| Introducido | ASP.NET Core 7 | ASP.NET Core 1.x |
| Quién controla el almacenamiento en caché | El servidor | Cabeceras HTTP (el cliente puede sobrescribir) |
| Respeta `Cache-Control: no-cache` del cliente | No (decide el servidor) | Sí (regenera cada vez) |
| Dónde vive la copia | En tu servidor (en memoria o Redis) | Navegador, proxy, CDN y su propio middleware |
| Registro | `AddOutputCache()` + `UseOutputCache()` | `AddResponseCaching()` + `UseResponseCaching()` |
| Adhesión por endpoint | `.CacheOutput()` / `[OutputCache]` | Atributo `[ResponseCache]` + cabeceras |
| Variar por query | `SetVaryByQuery("key")` | `VaryByQueryKeys` (necesita el middleware) |
| Variar por cabecera | `SetVaryByHeader("...")` | `VaryByHeader` -> emite `Vary` |
| Variar por valor arbitrario | `VaryByValue(...)` | No admitido |
| Expulsión basada en etiquetas | Sí, `EvictByTagAsync` | No |
| Protección contra estampidas de caché | Sí, bloqueo de recursos activado por defecto | No |
| Almacén distribuido | Redis vía `AddStackExchangeRedisOutputCache` | No aplicable (solo en memoria) |
| Almacena en caché respuestas autenticadas | No por defecto (adhesión vía política personalizada) | No (y no deberías) |
| Requiere respuesta sin `Set-Cookie` | Sí (las cookies deshabilitan el almacenamiento en caché) | Sí |
| Instruye a las cachés posteriores | No (solo del lado del servidor) | Sí, ese es todo su propósito |

La tabla deja obvia la forma. El output caching tiene las características operativas (etiquetas, bloqueo, un almacén compartido) que una API real necesita. El response caching tiene exactamente una cosa que le falta al output caching: emite las cabeceras HTTP que hacen que las cachés posteriores almacenen tu respuesta.

## Configurar ambos para que la diferencia sea concreta

El output caching necesita tres piezas móviles y ningún paquete NuGet para el caso en memoria:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/catalog", GetCatalog)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)));

app.Run();
```

Golpea `/catalog` dos veces dentro de cinco minutos y la segunda solicitud nunca ejecuta `GetCatalog`. La respuesta se almacena en la memoria del servidor y se sirve directamente. Las cabeceras del cliente son irrelevantes.

El response caching se ve superficialmente similar, pero se comporta de forma diferente:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCaching();
builder.Services.AddControllers();

var app = builder.Build();

app.UseResponseCaching();
app.MapControllers();

app.Run();
```

```csharp
// .NET 11, C# 14 -- a controller action that sets caching headers
[ApiController]
[Route("api/[controller]")]
public sealed class CatalogController : ControllerBase
{
    [HttpGet]
    [ResponseCache(Duration = 300, Location = ResponseCacheLocation.Any)]
    public IActionResult Get() => Ok(LoadCatalog());
}
```

Ese atributo `[ResponseCache]` escribe `Cache-Control: public,max-age=300` en la respuesta. El middleware puede almacenar una copia, pero también lo harán el navegador y cualquier CDN por delante de ti, y cualquier cliente que envíe `no-cache` los omite a todos. La cabecera es el producto aquí, no la copia en memoria del middleware.

## Cuándo elegir output caching

Esta es la opción por defecto para apps del lado del servidor. Elígela cuando:

- **Quieres reducir la carga en tu propia API.** El output caching garantiza que el handler no se ejecute en un acierto, sin importar lo que envíe quien llama. En .NET 11, un `.CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(30)))` en un endpoint de lectura muy solicitado es el camino más corto hacia menos idas y vueltas a la base de datos.
- **Necesitas invalidar en la escritura, no con un temporizador.** Etiqueta un grupo de entradas y descártalas en el instante en que los datos cambian. Esta es la razón individual más grande para preferirlo, y el response caching no tiene equivalente:

  ```csharp
  // .NET 11, C# 14
  var catalog = app.MapGroup("/catalog")
      .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(30)).Tag("catalog"));

  catalog.MapGet("/", GetAllProducts);

  app.MapPost("/catalog", async (Product p, AppDbContext db, IOutputCacheStore cache) =>
  {
      db.Products.Add(p);
      await db.SaveChangesAsync();
      await cache.EvictByTagAsync("catalog", default); // fresh the moment a write lands
      return Results.Created($"/catalog/{p.Id}", p);
  });
  ```

- **Esperas tráfico en ráfagas sobre un endpoint costoso.** El bloqueo de recursos está activado por defecto, así que cuando una entrada muy solicitada expira y llegan cien solicitudes a la vez, solo la primera regenera mientras el resto espera. El response caching no hace nada respecto a la estampida. Este es el mismo tipo de problema que [HybridCache resuelve para el almacenamiento de datos en caché](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) en lugar del almacenamiento en caché de la respuesta completa.
- **Ejecutas más de una instancia.** Cambia el almacén en memoria por Redis con `AddStackExchangeRedisOutputCache` y una expulsión de etiqueta en un nodo las limpia en todos. El response caching no puede abarcar varios nodos.

La configuración completa de extremo a extremo, incluyendo políticas con nombre, `MapGroup` y el almacén de Redis, se cubre en [cómo agregar output caching a una minimal API](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/).

## Cuándo elegir response caching

El response caching no está obsoleto. Es la herramienta correcta cuando la caché que te importa no es la tuya:

- **Quieres que una CDN o un proxy compartido sirva la respuesta.** Si un `GET` público y anónimo debe almacenarse en caché en el borde (Cloudflare, Akamai, Azure Front Door), necesitas emitir `Cache-Control: public,max-age=...`. Eso es precisamente lo que hace `[ResponseCache]`. El output caching almacena una copia en tu servidor, pero no le dice nada al borde.
- **Quieres que el navegador omita la solicitud por completo.** Un `Cache-Control: max-age=3600` en una carga JSON casi estática que rara vez cambia permite que el navegador reutilice su propia copia sin ninguna ida y vuelta. El output caching no puede ahorrar una ida y vuelta que nunca ve.
- **Ya tienes por delante una caché que cumple con la especificación** y solo necesitas que tu app participe correctamente en la semántica del almacenamiento en caché HTTP, incluyendo `Vary`, `Expires` y solicitudes condicionales.

Fíjate en el planteamiento honesto: en la mayoría de estos casos ni siquiera necesitas el middleware de response caching. Necesitas las cabeceras. Agregar `[ResponseCache]` (o escribir `Cache-Control` tú mismo) establece las cabeceras; `AddResponseCaching`/`UseResponseCaching` solo agrega encima una copia de middleware del lado del servidor, y para apps de UI esa copia suele ser inútil porque los navegadores envían cabeceras de solicitud que la suprimen. Así que la recomendación realista es: usa cabeceras de caché HTTP para dirigir las cachés posteriores, y usa output caching para la copia del lado del servidor.

## La medición, para que "más rápido" no sea vaguedad

El objetivo de cualquiera de las dos cachés es omitir el handler. Esto es lo que cuesta un acierto frente a un fallo sobre un handler simulado de 40 ms, medido con `BenchmarkDotNet` 0.15.x en .NET 11 (Preview 6), Windows 11, Ryzen 9 7900X, con `TestServer` en proceso:

| Escenario | Latencia mediana | ¿Se ejecutó el handler? |
| --------------------------------------- | -------------- | ------------ |
| Sin caché (línea base, trabajo de 40 ms) | 40,6 ms | Cada vez |
| Output caching, acierto | 0,11 ms | No |
| Response caching, acierto (cliente que cumple) | 0,12 ms | No |
| Response caching, el cliente envía `no-cache` | 40,5 ms | Sí, cada vez |

Las dos tecnologías de caché son indistinguibles en un acierto limpio: ambas convierten un handler de 40 ms en aproximadamente 0,1 ms de middleware. La fila que importa es la última. Un solo cliente que se comporta mal o que cuida su privacidad enviando `Cache-Control: no-cache` hace colapsar el response caching de vuelta al costo total, mientras que el output caching no se ve afectado porque el servidor, no el cliente, es dueño de la decisión. Si estás almacenando en caché para proteger tu origen, esa fila es todo el argumento.

## El detalle que decide por ti

Tres cosas fuerzan la decisión sin importar la preferencia.

Primero, el **contenido autenticado**. Ambas características se niegan a almacenar en caché respuestas autenticadas por defecto, y para el response caching la documentación lleva una advertencia explícita: nunca almacenes en caché contenido que varíe según la identidad del usuario, porque `Cache-Control: public` puede filtrar la respuesta de un usuario a un proxy compartido que se la sirva a otro. La protección por defecto del output caching (sin almacenar en caché solicitudes autenticadas, sin almacenar en caché cuando hay `Set-Cookie` presente) es más estricta y aplicada por el servidor. Si tu endpoint está detrás de autenticación, el output caching con una política personalizada cuidadosamente probada es el único camino seguro, y deberías tratarlo como un caso avanzado.

Segundo, los **requisitos de invalidación**. Si "los datos pueden cambiar y las lecturas obsoletas son inaceptables" está en tu lista de requisitos, el response caching queda descartado. No tiene mecanismo de purga; una respuesta almacenada en caché vive hasta que su `max-age` expira. El `EvictByTagAsync` del output caching es la característica que en realidad estás pidiendo.

Tercero, **el almacén debe sobrevivir entre nodos**. Detrás de un balanceador de carga con invalidación basada en etiquetas, necesitas el almacén de output cache de Redis. El response caching no tiene historia distribuida. Ten en cuenta que el método es `AddStackExchangeRedisOutputCache`, no el `AddStackExchangeRedisCache` de nombre similar que se usa para `IDistributedCache`, y Microsoft recomienda no respaldar el output caching con un `IDistributedCache` común porque a esa interfaz le faltan las operaciones atómicas de las que dependen las etiquetas.

## La decisión, reafirmada

Usa output caching por defecto en ASP.NET Core 11. Está controlado por el servidor, tiene etiquetas, protección contra estampidas y un almacén distribuido real, y no puede ser derrotado por una cabecera del cliente. Usa response caching, o más precisamente usa cabeceras de caché HTTP vía `[ResponseCache]`, solo cuando la caché que quieres poblar vive más abajo: una CDN, un proxy compartido o el navegador. Las dos no son tanto competidoras como capas diferentes, y la configuración común en producción usa ambas: output caching para la copia del lado del servidor que protege tu base de datos, y cabeceras de caché para las copias del borde y del navegador que protegen tu red. Si solo puedes elegir una, y estás intentando reducir la carga del servidor, elige output caching. Es la que el framework ahora te lleva a preferir.

## Relacionados

- [Cómo agregar output caching a una minimal API en ASP.NET Core 11](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)
- [Cómo usar HybridCache en ASP.NET Core 11 con Redis como caché L2](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache en .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo agregar compresión de respuestas a una API de ASP.NET Core 11](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)

## Fuentes

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Response caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
