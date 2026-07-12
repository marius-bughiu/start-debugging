---
title: "Cómo agregar output caching a una minimal API en ASP.NET Core 11"
description: "Una guía completa y funcional sobre output caching en una minimal API de ASP.NET Core 11: AddOutputCache y UseOutputCache, CacheOutput en endpoints y MapGroup, políticas nombradas y base, Expire, VaryByQuery y VaryByHeader, invalidación por tags con EvictByTagAsync, protección contra cache stampede, revalidación con ETag y un almacén de respaldo en Redis."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
  - "caching"
lang: "es"
translationOf: "2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Para agregar output caching a una minimal API en ASP.NET Core 11 necesitas exactamente tres piezas: registrar los servicios con `builder.Services.AddOutputCache()`, agregar el middleware con `app.UseOutputCache()` y marcar los endpoints que quieres cachear con `.CacheOutput()`. Eso basta para cachear una respuesta HTTP completa en memoria y devolverla sin volver a ejecutar tu handler. Todo lo que viene después (ventanas de expiración, claves de caché por consulta, invalidación por tags, un almacén de respaldo en Redis) es refinamiento. Este post recorre el camino completo de principio a fin. Apunta a .NET 11 (Preview 5 al momento de escribir esto, GA en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14, pero la API de output caching es estable desde ASP.NET Core 7, así que cada paso de aquí funciona sin cambios en .NET 8, 9 y 10.

## Output caching no es response caching

Lo primero que hay que aclarar, porque hace tropezar a casi todos: output caching y response caching son características distintas que resuelven problemas distintos.

Response caching (`AddResponseCaching`) es el middleware más antiguo. Participa en el caché HTTP: lee y escribe los encabezados `Cache-Control`, `Vary` y `Expires`, y solo cachea cuando la respuesta acepta hacerlo con los encabezados correctos. En realidad es un caché de proxy compartido que vive dentro de tu aplicación, y es fácil equivocarse porque un `Set-Cookie` perdido o un `Cache-Control: public` faltante lo desactivan en silencio.

Output caching (`AddOutputCache`, agregado en ASP.NET Core 7) está controlado por el servidor. El servidor decide qué cachear y por cuánto tiempo, sin importar los encabezados de la solicitud del cliente. Soporta variación de la clave de caché sobre valores arbitrarios, invalidación por tags para que puedas purgar un grupo de entradas cuando cambian los datos subyacentes, y protección incorporada contra cache stampede. Para una API donde tú controlas ambos extremos, output caching es casi siempre el que quieres. Este post trata por completo sobre output caching.

## Conecta las tres piezas

Output caching vive en el shared framework, así que no hay ningún paquete de NuGet que instalar para el caso en memoria. Registra los servicios y agrega el middleware:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/time", () => new { now = DateTime.UtcNow })
    .CacheOutput();

app.Run();
```

Tres cosas para notar. Primero, `AddOutputCache()` y `UseOutputCache()` por sí solos no hacen nada: dejan disponible el caché pero no cachean nada hasta que un endpoint acepta hacerlo. Segundo, `.CacheOutput()` sin argumentos aplica la política predeterminada, que cachea durante 60 segundos. Llama a `/time` dos veces dentro de un minuto y obtendrás la misma marca de tiempo, porque la segunda solicitud nunca ejecuta tu lambda.

Tercero, y este es el que causa bugs en producción: el orden del middleware importa. `UseOutputCache()` debe ir después de `UseCors()`, después de `UseAuthentication()` y después de `UseAuthorization()`. Si se ejecuta antes de la autorización, el middleware puede servir una respuesta cacheada para un usuario anónimo a uno autenticado, o al revés. En aplicaciones de Razor Pages y controllers también debe ir después de `UseRouting()`. El host mínimo `WebApplication` conecta el enrutamiento por ti, pero si agregas autenticación eres responsable del orden:

```csharp
// .NET 11, C# 14 -- correct ordering with auth
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache();   // after auth, not before
```

## Define una ventana de expiración con una política nombrada

La ventana predeterminada de 60 segundos rara vez es lo que quieres. Para controlarla, llama a `.CacheOutput()` con un builder en línea, o define una política nombrada una vez y referénciala por nombre. Las políticas nombradas mantienen `Program.cs` legible cuando varios endpoints comparten la misma configuración:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddPolicy("Short", policy => policy.Expire(TimeSpan.FromSeconds(10)));
    options.AddPolicy("Long", policy => policy.Expire(TimeSpan.FromMinutes(30)));
});
```

Luego selecciona una política por endpoint según su nombre:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices).CacheOutput("Short");
app.MapGet("/catalog", GetCatalog).CacheOutput("Long");
```

Si prefieres mantener la configuración junto al endpoint, la forma en línea hace lo mismo sin una política registrada:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(10)));
```

También existe un atributo `[OutputCache]` si prefieres atributos en un handler, que es la forma que usan los controllers. En un endpoint de minimal API se ve así: `app.MapGet("/x", [OutputCache(PolicyName = "Short")] () => ...)`, pero el fluido `.CacheOutput("Short")` se lee mejor y es la convención que sigue la mayoría del código de minimal API.

## Cachea todo un grupo de rutas a la vez

Repetir `.CacheOutput()` en cada endpoint se vuelve tedioso rápido. Como `MapGroup` devuelve un `RouteGroupBuilder` que comparte convenciones, puedes adjuntar output caching al grupo y cada endpoint dentro lo hereda. Esto compone limpiamente con los módulos de endpoints por recurso que se cubren en [organizar endpoints de minimal API con MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var catalog = app.MapGroup("/catalog")
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)).Tag("catalog"));

catalog.MapGet("/", GetAllProducts);
catalog.MapGet("/{id:int}", GetProduct);
```

Ahora ambos endpoints cachean durante cinco minutos y llevan el tag `catalog`, que es importante para el paso de invalidación de más abajo.

## Controla la clave de caché para no servir la respuesta equivocada

Por defecto la clave de caché es la URL completa: esquema, host, puerto, ruta y toda la cadena de consulta. Eso significa que `/search?q=widgets` y `/search?q=gadgets` son entradas separadas de forma automática, lo cual normalmente es correcto. Pero dos casos necesitan manejo explícito.

El primero: quieres variar según un valor de consulta específico e ignorar el resto. `SetVaryByQuery` restringe la clave a las claves de consulta que nombras, para que parámetros de seguimiento como `utm_source` no fragmenten tu caché en miles de entradas casi idénticas:

```csharp
// .NET 11, C# 14 -- cache per culture, ignore everything else in the query
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy
        .Expire(TimeSpan.FromMinutes(10))
        .SetVaryByQuery("culture"));
```

El segundo: sirves contenido distinto según un encabezado de la solicitud, como `Accept-Language` o un encabezado de versión de API personalizado. Usa `SetVaryByHeader` para que cada valor de encabezado tenga su propia entrada:

```csharp
// .NET 11, C# 14
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy.SetVaryByHeader("Accept-Language"));
```

Para cualquier cosa que la URL y los encabezados no puedan expresar, `VaryByValue` te permite calcular un fragmento de clave a partir del `HttpContext`. Así es como varías según un id de tenant resuelto desde un claim, o según un bucket A/B:

```csharp
// .NET 11, C# 14 -- separate cache entry per tenant
app.MapGet("/dashboard", GetDashboard)
    .CacheOutput(policy => policy.VaryByValue(context =>
        new KeyValuePair<string, string>(
            "tenant", context.User.FindFirst("tenant")?.Value ?? "public")));
```

Una advertencia con `VaryByValue` sobre datos específicos de usuario: output caching por defecto se niega por completo a cachear respuestas a solicitudes autenticadas, precisamente para evitar filtrar la respuesta de un usuario a otro. Si deliberadamente anulas eso (mira la sección de política personalizada), variar según un valor por usuario es lo que mantiene las entradas separadas, y equivocarte es un bug de fuga de datos, no de rendimiento. Trata el output caching autenticado como un caso avanzado y pruébalo a fondo.

## Invalida bajo demanda con tags

La expiración basada en tiempo es un instrumento burdo. Si tu catálogo cambia dos veces al día pero cacheas durante cinco minutos, estás sirviendo datos obsoletos hasta por cinco minutos cada vez y volviendo a consultar sin sentido el resto del tiempo. Los tags resuelven esto: adjunta un tag a las entradas de caché y luego invalida por tag en el momento en que cambian los datos subyacentes.

Viste `.Tag("catalog")` en el grupo de arriba. Para purgarlo, inyecta `IOutputCacheStore` y llama a `EvictByTagAsync`. El lugar natural para esto es dentro de la operación de escritura que cambió los datos, no un endpoint de administración separado:

```csharp
// .NET 11, C# 14
app.MapPost("/catalog", async (Product product, AppDbContext db, IOutputCacheStore cache) =>
{
    db.Products.Add(product);
    await db.SaveChangesAsync();

    // The catalog changed, so drop every cached catalog response.
    await cache.EvictByTagAsync("catalog", default);

    return Results.Created($"/catalog/{product.Id}", product);
});
```

Ahora el caché sirve lecturas instantáneas y se mantiene fresco: una expiración de cinco minutos (o incluso de una hora) es una red de seguridad, y la invalidación real ocurre exactamente cuando llega una escritura. Si atas la llamada a `EvictByTagAsync` al mismo `SaveChanges` que muta la fila, los lectores nunca ven datos más viejos que la última escritura exitosa. Esto combina bien con rastrear las consultas detrás de esas escrituras; si un endpoint de lectura es tan lento que estás recurriendo al caché, vale la pena descartar primero una [consulta N+1 en EF Core](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), porque cachear una consulta lenta solo esconde el problema.

También puedes registrar tags de forma declarativa en una política base, lo que etiqueta cada endpoint coincidente sin tocar cada uno:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy
        .With(c => c.HttpContext.Request.Path.StartsWithSegments("/catalog"))
        .Tag("catalog"));
});
```

## Las políticas base aplican en todas partes por defecto

`AddBasePolicy` se diferencia de `AddPolicy` en algo importante: una política base aplica a todos los endpoints (o a todos los endpoints que coinciden con su predicado `With`) sin ninguna llamada a `.CacheOutput()` en el endpoint. Así es como estableces una expiración predeterminada o un esquema de etiquetado en toda la aplicación:

```csharp
// .NET 11, C# 14 -- cache everything for 30 seconds unless overridden
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Sé deliberado aquí. Una política base general cacheará con gusto endpoints que nunca quisiste cachear. Acótala con `.With(...)` a un prefijo de ruta, o prefiere llamadas explícitas a `.CacheOutput()` por endpoint si tu API mezcla lecturas cacheables y escrituras no cacheables, que es lo que la mayoría hace.

## Qué cacheará y qué no la política predeterminada

Incluso después de que aceptes un endpoint, output caching aplica salvaguardas. De fábrica solo cachea cuando:

- El estado de la respuesta es `HTTP 200`.
- El método de la solicitud es `GET` o `HEAD`.
- La respuesta no establece cookies (cualquier `Set-Cookie` desactiva el caché para esa respuesta).
- La solicitud no está autenticada.

Estas reglas son la razón por la que `.CacheOutput()` en un endpoint `POST` parece no hacer nada: `POST` está excluido por defecto. Existen para evitar que caches algo inseguro por accidente. Si de verdad necesitas cachear un `POST`, o cachear respuestas `301`, o cachear respuestas autenticadas, escribes una `IOutputCachePolicy` personalizada y aceptas hacerlo explícitamente:

```csharp
// .NET 11, C# 14 -- excerpt of a custom policy that allows POST
public sealed class CachePostPolicy : IOutputCachePolicy
{
    public static readonly CachePostPolicy Instance = new();

    ValueTask IOutputCachePolicy.CacheRequestAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
    {
        var request = context.HttpContext.Request;
        var attempt = HttpMethods.IsGet(request.Method)
                   || HttpMethods.IsHead(request.Method)
                   || HttpMethods.IsPost(request.Method);

        context.EnableOutputCaching = true;
        context.AllowCacheLookup = attempt;
        context.AllowCacheStorage = attempt;
        context.AllowLocking = true;
        context.CacheVaryByRules.QueryKeys = "*";
        return ValueTask.CompletedTask;
    }

    ValueTask IOutputCachePolicy.ServeFromCacheAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    ValueTask IOutputCachePolicy.ServeResponseAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;
}
```

Regístrala como una política nombrada con `options.AddPolicy("CachePost", CachePostPolicy.Instance)` y selecciónala con `.CacheOutput("CachePost")`. Cachear un `POST` es inusual y deberías tener una razón específica, pero el punto de extensión está ahí.

## La protección contra stampede está activada por defecto

Cuando una entrada de caché muy solicitada expira y llegan cien solicitudes a la vez, un caché ingenuo deja que las cien fallen y golpeen tu base de datos simultáneamente. Eso es un cache stampede, o thundering herd. Output caching lo mitiga con bloqueo de recursos: cuando se está generando una entrada, las solicitudes concurrentes para la misma clave esperan a que termine la primera en lugar de generar cada una la suya. Esto está activado por defecto y es una de las ventajas concretas sobre el código artesanal con `IMemoryCache`, que no hace esto a menos que lo construyas tú mismo.

Puedes desactivar el bloqueo por política con `SetLocking(false)` si un endpoint es barato de generar y prefieres que las solicitudes no esperen:

```csharp
// .NET 11, C# 14
app.MapGet("/cheap", GetCheapThing)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(5)).SetLocking(false));
```

Déjalo activado para cualquier cosa costosa. La protección contra stampede es exactamente lo que quieres bajo carga, y es la misma clase de problema que [HybridCache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) resuelve para el caché de datos en lugar del caché de respuesta completa.

## Revalidación barata con ETags

Output caching también coopera con las solicitudes condicionales de HTTP. Si tu handler establece un encabezado `ETag`, el middleware responderá a un `If-None-Match` coincidente con un `304 Not Modified` y un cuerpo vacío en lugar de reenviar toda la carga útil. Para una respuesta grande servida a un cliente que ya la tiene, eso convierte una transferencia completa en unos pocos bytes:

```csharp
// .NET 11, C# 14
app.MapGet("/report", async (HttpContext context) =>
{
    context.Response.Headers.ETag = $"\"{ComputeReportVersion()}\"";
    await WriteReport(context);
}).CacheOutput();
```

No se necesita configuración extra más allá de habilitar output caching. Lo mismo funciona con `If-Modified-Since` contra la hora de creación de la entrada de caché.

## Ajusta los límites y, cuando escales horizontalmente, cambia a Redis

Vale la pena conocer dos límites de `OutputCacheOptions` antes de publicar. `MaximumBodySize` tiene un valor predeterminado de 64 MB: una respuesta más grande que eso nunca se cachea, lo cual es un valor por defecto sensato pero silencioso si te preguntabas por qué una exportación grande nunca se cachea. `SizeLimit` tiene un valor predeterminado de 100 MB de almacenamiento total de caché, después del cual las entradas nuevas esperan a que se desalojen las viejas. `DefaultExpirationTimeSpan` son los 60 segundos que obtienes cuando una política no establece un `Expire` explícito.

El almacén predeterminado es memoria en el proceso, lo que significa que cada instancia de servidor tiene su propio caché y se evapora al reiniciar. Detrás de un balanceador de carga con varias instancias, eso a menudo está bien para endpoints con muchas lecturas, pero sí significa que una invalidación por `tag` en un nodo no limpia los demás. Cuando necesitas un caché compartido que sobreviva a los reinicios y desaloje de forma consistente entre nodos, agrega el almacén de Redis. Es un paquete aparte:

```bash
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp";
});

builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Nota que el método es `AddStackExchangeRedisOutputCache`, no el similarmente nombrado `AddStackExchangeRedisCache` que se usa para `IDistributedCache`. Esa distinción importa, porque Microsoft recomienda explícitamente no respaldar output caching con un `IDistributedCache` simple: esa interfaz carece de las operaciones atómicas de las que depende la invalidación por tags, así que los tags no se desalojarían de forma confiable. Usa el almacén de output cache de Redis incorporado o un `IOutputCacheStore` personalizado, no `IDistributedCache`.

## La forma que hay que recordar

Output caching en una minimal API se reduce a un conjunto pequeño y componible de piezas. Registra con `AddOutputCache`, inserta `UseOutputCache` después de tu middleware de autenticación y acepta endpoints con `.CacheOutput()` o un `.CacheOutput()` a nivel de grupo. Recurre a `Expire` para fijar la ventana, a `SetVaryByQuery` y `SetVaryByHeader` para mantener las claves correctas, y a `Tag` más `EvictByTagAsync` para invalidar en el instante en que tus datos cambian en lugar de esperar a que se agote un temporizador. Deja la protección contra stampede activada para el trabajo costoso, respeta las salvaguardas predeterminadas que mantienen fuera del caché las respuestas autenticadas y con cookies, y cambia el almacén en memoria por Redis solo cuando de verdad ejecutas más de una instancia. Eso cubre la gran mayoría de las APIs reales, y cada línea de arriba corre en .NET 8 hasta .NET 11 sin cambios.

## Relacionados

- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)

## Fuentes

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [IOutputCacheStore.EvictByTagAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.ioutputcachestore.evictbytagasync)
- [OutputCachePolicyBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.outputcachepolicybuilder)
