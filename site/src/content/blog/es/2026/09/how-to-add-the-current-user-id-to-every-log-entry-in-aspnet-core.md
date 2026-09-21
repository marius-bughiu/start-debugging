---
title: "Cómo agregar el id del usuario actual a cada entrada de registro en ASP.NET Core"
description: "Un middleware con BeginScope no cubre el registro de error del manejador de excepciones ni la línea Request finished. Registra un ILogEnricher que lea el usuario desde IHttpContextAccessor, abre un scope solo cuando el trabajo sale de la solicitud y cuidado con AddSerilog de Serilog, que cancela el enriquecimiento sin avisar."
pubDate: 2026-09-21
template: how-to
tags:
  - "aspnet-core"
  - "dotnet-10"
  - "logging"
  - "observability"
  - "opentelemetry"
  - "serilog"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-09-21
---

Respuesta corta: no pases el id del usuario en cada llamada a `LogInformation`, y no te quedes en un middleware que envuelve el pipeline en `ILogger.BeginScope`. Ese scope solo cubre las llamadas de registro hechas *dentro* de él, así que se pierde las dos líneas que más te interesan cuando algo falla: el error de `ExceptionHandlerMiddleware` y la entrada "Request finished" del hosting. En su lugar, agrega `Microsoft.Extensions.Telemetry`, llama a `builder.Logging.EnableEnrichment()` y registra un `ILogEnricher` con `builder.Services.AddLogEnricher<UserIdEnricher>()` que lea `ClaimTypes.NameIdentifier` desde `IHttpContextAccessor`. Se ejecuta una vez por cada registro, para todas las categorías, incluidas las del propio framework. El único caso en que no ayuda es el trabajo que sobrevive a la solicitud, así que captura el id antes de pasar el trabajo a `Task.Run` o a una cola y abre un scope ahí.

Todo lo que sigue se ejecutó en .NET 10 (SDK 10.0.302, runtime de ASP.NET Core 10.0.10) con `Microsoft.Extensions.Telemetry` 10.10.0, `OpenTelemetry.Extensions.Hosting` y `OpenTelemetry.Exporter.Console` 1.19.1, y `Serilog.AspNetCore` 10.0.0. La tabla de resultados viene de solicitudes reales contra una pequeña aplicación de prueba, no de leer documentación.

## Por qué un middleware con BeginScope parece correcto y no lo es

La primera respuesta que encuentras en StackOverflow es un middleware como este:

```csharp
// .NET 10, ASP.NET Core 10: the common approach, and its gap
app.UseExceptionHandler("/error");
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (userId is null) { await next(ctx); return; }

    var logger = ctx.RequestServices.GetRequiredService<ILoggerFactory>()
        .CreateLogger("UserScope");
    using (logger.BeginScope(new Dictionary<string, object?> { ["UserId"] = userId }))
    {
        await next(ctx);
    }
});

app.UseAuthorization();
```

Funciona para tu propio código. Un `log.LogInformation("Loading orders")` dentro de un endpoint sale con `"UserId":"u-42"` en sus scopes. El problema es estructural. Los scopes de registro viven en un `AsyncLocal`, así que se adjuntan a las llamadas de registro hechas mientras el bloque `using` está en la pila. Dos líneas de registro importantes se escriben después de que ese bloque ya se liberó:

- `UseExceptionHandler` está fuera del middleware del scope (tiene que estarlo, o no podría capturar excepciones de la autenticación). Para cuando registra "An unhandled exception has occurred while executing the request.", la excepción ya atravesó tu `using` y el scope desapareció.
- "Request finished ... 500" lo escribe `Microsoft.AspNetCore.Hosting.Diagnostics`, que envuelve todo el pipeline de middleware. Ningún middleware que escribas puede poner un scope alrededor.

Así que el registro de error, la única entrada que soporte va a buscar por id de usuario, es la entrada sin id de usuario. Mover el middleware del scope por encima de `UseExceptionHandler` tampoco lo arregla, porque el usuario no se conoce hasta que la autenticación se ejecutó.

El mismo comportamiento de `AsyncLocal` tiene una ventaja que al enriquecedor le falta: un scope fluye con el `ExecutionContext` hacia `Task.Run` y otras continuaciones, así que el trabajo fire-and-forget iniciado dentro de la solicitud conserva el id incluso después de enviar la respuesta.

## Qué etiqueta realmente cada enfoque

Ejecuté tres solicitudes con un usuario autenticado `u-42` contra la misma aplicación en cada configuración: un endpoint que registra, un endpoint que lanza una excepción y un endpoint que inicia un `Task.Run` que registra 300 ms después de enviar la respuesta. La salida pasó por `AddJsonConsole` con `IncludeScopes = true`, y luego se repitió con el exportador de consola de OpenTelemetry.

| Entrada de registro | Middleware `BeginScope` | `ILogEnricher` | Enriquecedor + scope en el traspaso |
| --- | --- | --- | --- |
| "Request starting" (hosting) | no | no | no |
| `LogInformation` propio del endpoint | sí | sí | sí |
| Error de `ExceptionHandlerMiddleware` | **no** | sí | sí |
| "Request finished" (hosting) | **no** | sí | sí |
| Registro de `Task.Run` después de la respuesta | sí | **no** | sí |

"Request starting" no se puede etiquetar por diseño: se escribe antes de que se ejecute la autenticación, así que todavía no existe ningún usuario. Apóyate en el `TraceId` compartido para unirlo con el resto de la solicitud.

## Paso 1: agrega el enriquecedor

El enriquecimiento de registros forma parte de las bibliotecas de `dotnet/extensions`. `ILogEnricher` y `AddLogEnricher` viven en `Microsoft.Extensions.Telemetry.Abstractions`; `EnableEnrichment()` vive en `Microsoft.Extensions.Telemetry`, que referencia las abstracciones, así que basta con un paquete:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.10.0
```

El enriquecedor en sí son unas pocas líneas:

```csharp
// .NET 10, Microsoft.Extensions.Telemetry 10.10.0
using System.Security.Claims;
using Microsoft.Extensions.Diagnostics.Enrichment;

public sealed class UserIdEnricher(IHttpContextAccessor accessor) : ILogEnricher
{
    public void Enrich(IEnrichmentTagCollector collector)
    {
        var userId = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null)
        {
            collector.Add("user.id", userId);
        }
    }
}
```

Luego conéctalo en `Program.cs`:

```csharp
// .NET 10, ASP.NET Core 10, Microsoft.Extensions.Telemetry 10.10.0
var builder = WebApplication.CreateBuilder(args);

builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseExceptionHandler("/error");
app.UseAuthentication();
app.UseAuthorization();
```

No hace falta ningún middleware. `EnableEnrichment()` reemplaza el `LoggerFactory` predeterminado por el extendido de `Microsoft.Extensions.Telemetry`, que llama a cada `ILogEnricher` registrado una vez por cada registro y agrega las etiquetas al estado del registro. Como el enriquecedor lee el usuario en el momento de la llamada de registro y no en el momento en que se abrió un scope, sigue encontrando al usuario cuando el manejador de excepciones y los diagnósticos del hosting escriben sus entradas: `HttpContext` sigue vivo hasta que la solicitud termina.

En la salida JSON de la consola, la etiqueta aparece en `State`, junto a los parámetros de la plantilla del mensaje, y no bajo `Scopes`:

```json
{"EventId":1,"LogLevel":"Error","Category":"Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware","Message":"An unhandled exception has occurred while executing the request.","State":{"user.id":"u-42","exception.type":"System.InvalidOperationException","{OriginalFormat}":"An unhandled exception has occurred while executing the request."}}
```

Eso está recortado del texto de la excepción y de los scopes. Fíjate en la etiqueta `exception.type` que viene gratis: el logger extendido la agrega a cualquier registro que lleve una excepción, lo que convierte "todos los fallos de este usuario, agrupados por tipo de excepción" en una sola consulta.

Aquí importan algunos detalles:

- `AddLogEnricher<T>` registra el enriquecedor como **singleton** (`AddSingleton<ILogEnricher, T>()` en el código fuente). Inyecta solo singletons. `IHttpContextAccessor` es un singleton que lee un `AsyncLocal`, y precisamente por eso funciona; un servicio scoped como tu `DbContext` o un servicio de usuario por solicitud se capturaría una sola vez desde el proveedor raíz.
- Registrarlo dos veces lo ejecuta dos veces, porque usa `AddSingleton`, no `TryAddEnumerable`.
- El enriquecedor se ejecuta para cada registro del proceso, incluidos el arranque y los servicios en segundo plano. Mantenlo sin asignaciones de memoria y deja que retorne sin hacer nada cuando `HttpContext` sea null.

## Paso 2: lleva el id más allá del límite de la solicitud

`IHttpContextAccessor.HttpContext` pasa a ser null en cuanto la solicitud termina, así que el enriquecedor no puede etiquetar el trabajo que sobrevive a la solicitud. Esa es la última fila de la tabla. Captura el id mientras todavía tienes la solicitud y abre un scope dentro del trabajo en segundo plano:

```csharp
// .NET 10, ASP.NET Core 10
app.MapPost("/reports", (HttpContext ctx, ILogger<Program> log) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    _ = Task.Run(async () =>
    {
        using var scope = log.BeginScope("user.id:{user.id}", userId);
        await Task.Delay(300);
        log.LogInformation("Background work finished");
    });

    return Results.Accepted();
});
```

Con ese cambio, la línea en segundo plano salió con un scope `{"Message":"user.id:u-42","user.id":"u-42"}`, así que todas las filas de la tabla quedan etiquetadas excepto "Request starting". Usa la misma clave que el enriquecedor para que tus consultas no necesiten un `OR`.

Dos cosas sobre ese fragmento. Primero, usa la sobrecarga de `BeginScope` con plantilla de mensaje: un scope con un `Dictionary<string, object?>` sin más funciona, pero los exportadores de consola y de OpenTelemetry imprimen su `ToString()`, que es ``System.Collections.Generic.Dictionary`2[System.String,System.Object]``, como mensaje del scope. Segundo, `Task.Run` desde un endpoint es solo un sustituto de un traspaso. Para trabajo fire-and-forget real, pon el id del usuario en el elemento de trabajo que encolas a un `BackgroundService` y abre el scope cuando el worker lo desencola. El patrón y sus trampas están explicados en [ejecutar trabajo fire-and-forget de forma segura con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Paso 3: asegúrate de que tu sink realmente lo muestre

Dónde termina la etiqueta depende del proveedor.

**Formateadores de consola.** Las etiquetas enriquecidas forman parte del estado, así que `AddJsonConsole` las muestra incluso con `IncludeScopes = false`. El scope del traspaso del Paso 2 necesita `IncludeScopes = true`, que está desactivado por defecto en todos los formateadores de consola. El formateador de consola simple no imprime ni las propiedades del estado ni, sin `IncludeScopes`, los scopes, así que usa el formateador JSON o un sink de verdad.

**OpenTelemetry.** Con `builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.AddConsoleExporter(); })` la etiqueta enriquecida se convirtió en un atributo normal del registro (`LogRecord.Attributes: user.id: u-42`) en el registro del endpoint, en el error del manejador de excepciones y en "Request finished", mientras que el scope del traspaso llegó como `[Scope.3]:UserId: u-42` en `ScopeValues`. Sin `IncludeScopes = true` los valores de los scopes se descartan, así que la línea en segundo plano perdería su id. Si de todos modos te estás pasando a OpenTelemetry, [la migración del registro de Serilog a OpenTelemetry](/es/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) cubre la parte del exportador.

**Serilog: la trampa.** Esta es la que más tiempo me costó. `Serilog.AspNetCore` recomienda `builder.Services.AddSerilog(...)`, que registra el `ILoggerFactory` propio de Serilog. `EnableEnrichment()` también reemplaza `ILoggerFactory`. Gana el último registro, y ninguno de los dos te avisa:

| Registro | Resultado |
| --- | --- |
| `Services.AddSerilog(...)`, luego `EnableEnrichment()` | **Ninguna salida de registro**: gana la factory extendida y no tiene proveedores |
| `EnableEnrichment()`, luego `Services.AddSerilog(...)` | Los registros funcionan, pero el enriquecedor nunca se ejecuta; no hay `user.id` en ningún lado |
| `EnableEnrichment()` más `builder.Logging.AddSerilog(logger)` | Funciona en cualquier orden; `user.id` en cada fila que cubre el enriquecedor |

La primera fila no es una forma de hablar. La aplicación atendió solicitudes y escribió cero bytes en stdout. La combinación que funciona registra Serilog como un `ILoggerProvider` bajo la factory de Microsoft:

```csharp
// .NET 10, Serilog.AspNetCore 10.0.0, Microsoft.Extensions.Telemetry 10.10.0
using Serilog;
using Serilog.Formatting.Compact;

var serilog = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(serilog, dispose: true);
builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();
```

Serilog convierte la etiqueta enriquecida en una propiedad `user.id` de primera clase, y además recoge los valores de `BeginScope`, así que el scope del Paso 2 funciona sin cambios. El costo es que `Services.AddSerilog` también es lo que registra el `IDiagnosticContext` de Serilog, que `UseSerilogRequestLogging` necesita. Si dependes de ese middleware, conserva `Services.AddSerilog`, omite `EnableEnrichment` y hazlo a la manera de Serilog: empuja el id con `LogContext.PushProperty("UserId", userId)` en un middleware después de `UseAuthentication`, y agrégalo al evento de finalización con `options.EnrichDiagnosticContext = (dc, http) => dc.Set("UserId", http.User.FindFirstValue(ClaimTypes.NameIdentifier))`. Medí el middleware con `PushProperty` por sí solo y tiene exactamente los mismos huecos que `BeginScope` (sin id en el error del manejador de excepciones ni en "Request finished"), y por eso importa el callback del contexto de diagnóstico. La configuración base de Serilog está en [registro estructurado con Serilog y Seq](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Trampas que te muerden en producción

**El id del usuario es un dato personal.** Bajo el GDPR, un identificador de cuenta estable adjunto a cada línea de registro convierte esos registros en datos personales, lo que afecta la retención y quién puede leerlos. Registra un id interno opaco, nunca una dirección de correo ni un claim `name`, y si tu equipo de cumplimiento lo exige, aplícale hash o redáctalo en la capa de registro. El soporte de redacción de .NET puede hacerlo por propiedad; consulta [redactar valores sensibles con LogProperties](/es/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/).

**Elige el claim correcto.** `ClaimTypes.NameIdentifier` es lo que rellenan ASP.NET Core Identity y la autenticación por cookies. JWT bearer mapea el claim `sub` del token a `NameIdentifier` solo mientras `JwtBearerOptions.MapInboundClaims` sea `true`, que es el valor predeterminado. Muchas APIs lo desactivan para conservar los nombres originales de los claims JWT, y a partir de ahí el sujeto llega como `sub` y el enriquecedor de arriba no registra nada sin avisar. Lee `User.FindFirstValue("sub") ?? User.FindFirstValue(ClaimTypes.NameIdentifier)` si no estás seguro de cuál recibes.

**La autenticación tiene que ejecutarse antes de la llamada de registro, no antes del registro del servicio.** El enriquecedor lee `HttpContext.User` de forma diferida, así que etiqueta todo lo que se registra después de que se ejecutó el middleware de autenticación, esté donde esté ese middleware. Si dependes del middleware de autenticación automático que `WebApplication` agrega cuando hay servicios de autenticación registrados y no llamas a `UseAuthentication` tú mismo, se ejecuta al principio del pipeline y estás cubierto.

**Blazor interactivo y SignalR.** `IHttpContextAccessor` no es una fuente confiable del usuario actual en los componentes interactivos de Blazor Server; la documentación de ASP.NET Core te dice que lo evites con renderizado interactivo. Para circuitos e invocaciones de hubs, obtén el usuario de `AuthenticationStateProvider` o de `HubCallerContext.User` y abre un scope alrededor del trabajo.

**Los enriquecedores son por registro, así que mantenlos baratos.** Buscar en un puñado de claims es trivial, pero no resuelvas servicios, no consultes una base de datos ni asignes strings en `Enrich`. Si un valor es constante para el proceso (versión, región), usa `IStaticLogEnricher`, que se ejecuta una sola vez.

**No pongas además el id en tus plantillas de mensaje.** `LogInformation("User {UserId} loaded orders", userId)` duplica la propiedad y, si las claves difieren, divide tus consultas. Mantén las plantillas centradas en el evento; consulta [pasar de la interpolación de strings a plantillas de mensaje](/es/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) para el resto de esa disciplina.

### Para leer después

- [Cómo configurar el registro estructurado con Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)
- [Migrar del registro con Serilog a OpenTelemetry en .NET 11](/es/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)
- [Cómo redactar valores sensibles de los registros con LogProperties en .NET](/es/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [Cómo ejecutar trabajo fire-and-forget de forma segura en ASP.NET Core con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)

### Fuentes

- [Información general sobre el enriquecimiento de registros](https://learn.microsoft.com/dotnet/core/enrichment/overview) y [Enriquecedor de registros personalizado](https://learn.microsoft.com/dotnet/core/enrichment/custom-enricher) en Microsoft Learn
- [`EnrichmentServiceCollectionExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry.Abstractions/Enrichment/EnrichmentServiceCollectionExtensions.cs) en dotnet/extensions (registro como singleton)
- [Registro en .NET: scopes de registro](https://learn.microsoft.com/dotnet/core/extensions/logging#log-scopes)
- [Acceder a HttpContext en ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/http-context) (incluida la guía para Blazor interactivo)
- [README de Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore)
- [Registros de OpenTelemetry .NET: IncludeScopes](https://github.com/open-telemetry/opentelemetry-dotnet/tree/main/docs/logs)
