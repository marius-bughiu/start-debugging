---
title: "Cómo agregar rate limiting por endpoint en ASP.NET Core 11"
description: "Una guía completa de rate limiting por endpoint en ASP.NET Core 11: cuándo elegir fixed window vs sliding window vs token bucket vs concurrency, en qué se diferencian RequireRateLimiting y [EnableRateLimiting], cómo particionar por usuario o IP, el callback OnRejected, y la trampa de despliegue distribuido en la que cae todo el mundo."
pubDate: 2026-04-30
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "rate-limiting"
lang: "es"
translationOf: "2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

Para limitar la tasa de un endpoint específico en ASP.NET Core 11, registra una política con nombre en `AddRateLimiter`, llama a `app.UseRateLimiter()` después del enrutamiento, y asocia la política al endpoint con `RequireRateLimiting("name")` en una minimal API o `[EnableRateLimiting("name")]` en una acción de MVC. El runtime trae cuatro algoritmos integrados en `Microsoft.AspNetCore.RateLimiting`: fixed window, sliding window, token bucket y concurrency. El middleware devuelve `429 Too Many Requests` cuando una solicitud es rechazada y expone un callback `OnRejected` para respuestas personalizadas, incluido `Retry-After`. Esta guía cubre .NET 11 preview 3 con C# 14, pero la API es estable desde .NET 7 y cada ejemplo de código compila sin cambios en .NET 8, 9 y 10.

## Por qué el rate limiting "global" rara vez es lo que quieres

La configuración más simple, un único limitador global que descarta solicitudes cuando todo el proceso supera el presupuesto, es atractiva durante unos diez segundos. Después te das cuenta de que el endpoint de login y la sonda estática de salud comparten ese presupuesto. Una botnet martillando `/login` con gusto tirará abajo `/health`, y tu balanceador de carga sacará la instancia de la rotación porque la sonda barata empezó a devolver 429.

El rate limiting por endpoint arregla eso. Cada endpoint declara su propia política con límites ajustados a su coste real: `/login` recibe un token bucket por IP estricto, `/api/search` recibe una sliding window generosa, el endpoint de subida de archivos recibe un limitador de concurrency, y `/health` no recibe nada. El limitador global, si lo conservas, se convierte en una red de seguridad para abusos a nivel de protocolo en lugar de la defensa principal.

El middleware `Microsoft.AspNetCore.RateLimiting` salió de preview en .NET 7 y desde entonces solo ha tenido refinamientos de calidad de vida. Es parte de primera clase del framework en .NET 11, sin paquete NuGet adicional que instalar.

## El Program.cs mínimo

Aquí tienes la configuración más pequeña que agrega dos políticas distintas por endpoint, aplica una a un endpoint de minimal API y deja el resto de la aplicación sin limitar.

```csharp
// .NET 11 preview 3, C# 14
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter(policyName: "search", o =>
    {
        o.PermitLimit = 30;
        o.Window = TimeSpan.FromSeconds(10);
        o.QueueLimit = 0;
    });

    options.AddTokenBucketLimiter(policyName: "login", o =>
    {
        o.TokenLimit = 5;
        o.TokensPerPeriod = 5;
        o.ReplenishmentPeriod = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
        o.AutoReplenishment = true;
    });
});

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/api/search", (string q) => Results.Ok(new { q }))
   .RequireRateLimiting("search");

app.MapPost("/api/login", (LoginRequest body) => Results.Ok())
   .RequireRateLimiting("login");

app.MapGet("/health", () => Results.Ok("ok"));

app.Run();

record LoginRequest(string Email, string Password);
```

Dos cosas que notar. Primero, `RejectionStatusCode` por defecto es `503 Service Unavailable`, lo cual es incorrecto para casi cualquier API pública. Establécelo a `429` una sola vez, en `AddRateLimiter`, y olvídate. Segundo, `app.UseRateLimiter()` debe ir después de `app.UseRouting()` si llamas al enrutamiento explícitamente, porque el middleware lee los metadatos del endpoint para decidir qué política se aplica. El `WebApplication` integrado agrega el enrutamiento automáticamente antes del middleware terminal, así que la llamada explícita a `UseRouting` solo es necesaria si tienes otro middleware que necesita situarse entre el enrutamiento y el rate limiting.

## RequireRateLimiting vs [EnableRateLimiting]

ASP.NET Core tiene dos formas igualmente válidas de asociar una política a un endpoint, y existen porque las minimal APIs y MVC tienen historias de metadatos distintas.

Para minimal APIs y grupos de endpoints, el método fluido `RequireRateLimiting` sobre `IEndpointConventionBuilder` es la llamada correcta:

```csharp
// .NET 11, C# 14
var api = app.MapGroup("/api/v1").RequireRateLimiting("search");

api.MapGet("/products", (...) => ...);          // inherits "search"
api.MapGet("/orders", (...) => ...);            // inherits "search"
api.MapPost("/login", (...) => ...)
   .RequireRateLimiting("login");               // overrides to "login"
```

Los metadatos a nivel de endpoint ganan a los metadatos a nivel de grupo, así que la sobrescritura en `/login` hace lo que esperarías: solo se aplica la política más específica del endpoint.

Para controladores MVC, la forma con atributo es la llamada correcta:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("api/[controller]")]
[EnableRateLimiting("search")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(/* ... */);

    [HttpGet("{id}")]
    [EnableRateLimiting("hot")]    // narrower policy for a hot endpoint
    public IActionResult Get(int id) => Ok(/* ... */);

    [HttpPost("import")]
    [DisableRateLimiting]          // bypass entirely for an internal endpoint
    public IActionResult Import() => Ok();
}
```

`[EnableRateLimiting]` y `[DisableRateLimiting]` siguen las reglas estándar de resolución de atributos de ASP.NET Core: lo de nivel de acción gana sobre lo de nivel de controlador, y `DisableRateLimiting` siempre gana. Mezclar los estilos fluido y de atributo está bien, el pipeline de metadatos los lee igual.

Un error común es poner `[EnableRateLimiting]` en un endpoint de minimal API con `.WithMetadata(new EnableRateLimitingAttribute("search"))`. Funciona, pero `RequireRateLimiting("search")` es más corto y más claro.

## Elegir un algoritmo

Los cuatro algoritmos integrados responden a cuatro formas distintas de "¿con qué frecuencia es demasiado?", y elegir mal se manifiesta como picos de tráfico que rompen tu límite o como usuarios legítimos recibiendo 429 durante ráfagas normales.

**Fixed window** cuenta solicitudes en cubos de tiempo no superpuestos. `PermitLimit = 100, Window = 1s` significa hasta 100 solicitudes en cada segundo alineado con el reloj. Barato de calcular y fácil de razonar, pero permite una ráfaga de 200 solicitudes en el límite de la ventana: 100 en el último milisegundo de una ventana, 100 en el primer milisegundo de la siguiente. Úsalo para límites de coste donde la ráfaga es aceptable, o para anti-abuso no crítico donde no quieres gastar CPU en hacer seguimiento.

**Sliding window** divide la ventana en segmentos y los hace rodar hacia adelante. `PermitLimit = 100, Window = 1s, SegmentsPerWindow = 10` significa 100 solicitudes en cualquier rebanada de 1 segundo, evaluado en incrementos de 100ms. Elimina la ráfaga del límite a costa de más contabilidad por solicitud. Este es el valor por defecto sensato para endpoints públicos de lectura.

**Token bucket** rellena `TokensPerPeriod` tokens cada `ReplenishmentPeriod`, hasta `TokenLimit`. Cada solicitud toma un token. Se permiten ráfagas hasta `TokenLimit`, luego la tasa se estabiliza en la tasa de reposición. Este es el modelo correcto para cualquier endpoint donde quieras permitir una pequeña ráfaga (un usuario logueado abre cinco pestañas) pero limitar la tasa sostenida (nada de scraping). Login, restablecimiento de contraseña y endpoints de envío de correo son todos candidatos para token bucket.

**Concurrency** limita el número de solicitudes en vuelo al mismo tiempo, sin importar la duración. `PermitLimit = 4` significa como máximo cuatro solicitudes concurrentes; la quinta o se encola o es rechazada. Úsalo para endpoints que golpean un recurso lento aguas abajo: subidas grandes de archivos, generación de informes costosa, o cualquier endpoint donde el coste sea tiempo de reloj en un worker en lugar del recuento de solicitudes.

Las opciones `QueueLimit` y `QueueProcessingOrder` se comparten entre los cuatro. `QueueLimit = 0` significa "rechazar inmediatamente cuando se llega a la capacidad", que es lo que quieres para la mayoría de las APIs HTTP porque los clientes reintentarán al recibir 429 de todas formas. Los límites de cola distintos de cero tienen sentido para limitadores de concurrency donde el trabajo es corto y encolar durante 200ms es más barato que enviar al cliente por un bucle de reintentos.

## Particionado: por usuario, por IP, por inquilino

Un único bucket compartido por endpoint rara vez es lo que quieres. Si `/api/search` permite 30 solicitudes por 10 segundos globalmente, un cliente ruidoso bloquea a todos los demás. Los limitadores particionados dan a cada "clave" su propio bucket.

La sobrecarga fluida `AddPolicy` toma un `HttpContext` y devuelve un `RateLimitPartition<TKey>`:

```csharp
// .NET 11, C# 14
options.AddPolicy("per-user-search", context =>
{
    var key = context.User.Identity?.IsAuthenticated == true
        ? context.User.FindFirst("sub")?.Value ?? "anon"
        : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
    {
        PermitLimit = 60,
        Window = TimeSpan.FromMinutes(1),
        SegmentsPerWindow = 6,
        QueueLimit = 0
    });
});
```

La fábrica se llama una vez por clave de partición. El runtime cachea el limitador resultante en un `PartitionedRateLimiter`, así que las solicitudes siguientes con la misma clave reutilizan la misma instancia de limitador. El uso de memoria escala con el número de claves distintas que llegues a ver, por lo que deberías evictar limitadores inactivos: el framework hace esto automáticamente cuando un limitador ha estado inactivo durante `IdleTimeout` (por defecto 1 minuto), pero puedes ajustarlo con las sobrecargas `RateLimitPartition.GetSlidingWindowLimiter(key, factory)`.

Dos trampas de particionado:

1. **`RemoteIpAddress` es `null` detrás de un reverse proxy** a menos que llames a `app.UseForwardedHeaders()` con `ForwardedHeaders.XForwardedFor` configurado y una lista `KnownProxies` o `KnownNetworks`. Sin eso, cada solicitud obtiene la clave de partición `"unknown"` y de nuevo tienes un limitador global.
2. **Los usuarios autenticados y anónimos se mezclan en la misma partición** si solo usas como clave `sub`. Usa un prefijo como `"user:"` o `"ip:"` para que un atacante no autenticado no pueda colisionar con el bucket de un usuario real.

Para políticas más complejas (por inquilino, por API key, varios limitadores encadenados), implementa `IRateLimiterPolicy<TKey>` y regístralo con `options.AddPolicy<string, MyPolicy>("name")`. La interfaz de política te da el mismo método `GetPartition` más un callback `OnRejected` con alcance a esa política.

## Personalizar la respuesta de rechazo

La respuesta 429 por defecto es un cuerpo vacío sin cabecera `Retry-After`. Eso está bien para APIs internas, pero los clientes públicos (navegadores, SDKs, integraciones de terceros) esperan una pista. El callback `OnRejected` se ejecuta después de que el limitador rechaza pero antes de que se escriba la respuesta:

```csharp
// .NET 11, C# 14
options.OnRejected = async (context, cancellationToken) =>
{
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)retryAfter.TotalSeconds).ToString();
    }

    context.HttpContext.Response.ContentType = "application/problem+json";
    await context.HttpContext.Response.WriteAsJsonAsync(new
    {
        type = "https://tools.ietf.org/html/rfc6585#section-4",
        title = "Too Many Requests",
        status = 429,
        detail = "Rate limit exceeded. Retry after the indicated period."
    }, cancellationToken);
};
```

Dos detalles que es fácil equivocar. Primero, `MetadataName.RetryAfter` solo lo rellenan los limitadores de token bucket y de reposición, no los de fixed window o sliding window. Los limitadores de sliding window pueden calcular un retry-after a partir de `Window / SegmentsPerWindow`, pero tienes que hacer las cuentas tú. Segundo, el callback `OnRejected` se ejecuta en la ruta del middleware del rate limiter, no dentro del endpoint, así que acceder a servicios específicos del endpoint a través de `context.HttpContext.RequestServices` funciona pero acceder a filtros de controlador o al contexto de acción no, todavía no están vinculados.

Si quieres un `OnRejected` por política en lugar de uno global, implementa `IRateLimiterPolicy<TKey>` y sobrescribe `OnRejected` en la política. El callback de nivel de política se ejecuta además del global, así que ten cuidado de no escribir el cuerpo de respuesta dos veces.

## La trampa del despliegue distribuido

Cada ejemplo de código anterior almacena el estado del rate limit en memoria del proceso. Eso está bien cuando ejecutas una sola instancia, y es catastrófico cuando escalas horizontalmente. Tres réplicas detrás de un balanceador de carga con `PermitLimit = 100` por 10 segundos en realidad permiten 300 solicitudes por 10 segundos, porque cada réplica cuenta de forma independiente. Las sesiones pegajosas ayudan solo si tu hash distribuye las claves de partición de manera uniforme, lo que típicamente no hace.

No hay un rate limiter distribuido integrado en `Microsoft.AspNetCore.RateLimiting`. Las opciones mantenidas a fecha de .NET 11 son:

- **Empuja el límite al balanceador de carga.** NGINX `limit_req`, reglas basadas en tasa de AWS WAF, rate limiting de Azure Front Door, Cloudflare Rate Limiting Rules. Esta es la respuesta correcta para anti-abuso grueso en el borde de la red.
- **Usa una biblioteca con respaldo en Redis.** `RateLimit.Redis` (muestra de Microsoft en GitHub) y `AspNetCoreRateLimit.Redis` ambos implementan `PartitionedRateLimiter<HttpContext>` contra un sorted set de Redis o un incremento atómico. La ida y vuelta a Redis añade 0.5-2ms por solicitud, lo cual es aceptable para endpoints que no están en la ruta caliente.
- **Combina ambos.** El borde aplica un límite generoso; la aplicación aplica un límite por usuario en Redis; en proceso queda reservado para backpressure sobre downstreams lentos vía el limitador de concurrency.

No implementes tu propio limitador distribuido sobre `IDistributedCache` y `INCRBY` a menos que hayas leído [el post del blog de Cloudflare sobre contadores deslizantes distribuidos](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) y tengas una opinión sólida sobre el sesgo del reloj.

## Probar endpoints con rate limit

Las pruebas de integración con `WebApplicationFactory<TEntryPoint>` funcionan, pero el rate limiter no se reinicia entre pruebas por defecto. Dos estrategias:

1. **Sobrescribe la política en el host de pruebas.** Inyecta un limitador permisivo (`PermitLimit = int.MaxValue`) para el entorno de pruebas, y escribe un conjunto separado de pruebas que golpeen el limitador explícitamente con una política real.
2. **Desactiva el limitador para el endpoint bajo prueba.** Envuelve tus llamadas `MapGroup`/`RequireRateLimiting` en `if (!env.IsEnvironment("Testing"))`, o usa `[DisableRateLimiting]` en sobrescrituras de prueba.

El middleware también expone `RateLimiterOptions.GlobalLimiter` para un limitador particionado de nivel superior que se ejecuta en cada solicitud antes que las políticas por endpoint. Es el lugar correcto para una puerta por IP del tipo "obviamente eres un bot", y el lugar correcto para añadir una cabecera `Retry-After` en cada rechazo independientemente de qué política con nombre disparó. No lo uses como sustituto de las políticas por endpoint; los dos se componen, no se reemplazan.

## Cuando el middleware integrado no es suficiente

El middleware cubre el 90% de los casos. El 10% restante normalmente involucra uno de:

- **Límites basados en coste**: cada solicitud consume N tokens dependiendo de su coste calculado (una búsqueda con 5 facetas cuesta más que un listado plano). El middleware no tiene un hook para consumo variable de tokens, así que envuelves el endpoint con una llamada manual a `RateLimiter.AcquireAsync(permitCount)` dentro del handler.
- **Límites blandos con degradación**: en lugar de devolver 429, sirves una respuesta cacheada o submuestreada. Implementa esto en el endpoint, no en el middleware: comprueba `context.Features.Get<IRateLimitFeature>()` (añadido por el middleware en .NET 9) y bifurca según eso.
- **Exposición de métricas por ruta**: el middleware emite `aspnetcore.rate_limiting.request_lease.duration` y métricas similares vía el meter `Microsoft.AspNetCore.RateLimiting`. Conéctalo a través de `OpenTelemetry` para obtener conteos de 429 por política en tu dashboard. Los contadores integrados no se desglosan por endpoint; si necesitas eso, etiqueta el meter tú mismo en `OnRejected`.

## Relacionado

- [Cómo agregar un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) cubre las reglas de orden de middleware que también se aplican a `UseRateLimiter`.
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para las implicaciones de seguridad de trim de `IRateLimiterPolicy<T>`.
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) para el patrón de test host referenciado arriba.
- [Cómo añadir flujos de autenticación OpenAPI a Swagger UI en .NET 11](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para la historia de la clave de partición cuando las API keys llevan la identidad del usuario.
- [Cómo generar código cliente fuertemente tipado a partir de una especificación OpenAPI en .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) para el lado del consumidor del contrato 429.

## Fuentes

- [Middleware de rate limiting en ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) en MS Learn.
- [Referencia de la API `Microsoft.AspNetCore.RateLimiting`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting).
- [Código fuente del paquete `System.Threading.RateLimiting`](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.RateLimiting) para las primitivas subyacentes del limitador.
- [RFC 6585 sección 4](https://www.rfc-editor.org/rfc/rfc6585#section-4) para la definición canónica de `429 Too Many Requests` y la cabecera `Retry-After`.
