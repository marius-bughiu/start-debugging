---
title: "Cómo añadir un filtro global de excepciones en ASP.NET Core 11"
description: "Guía completa de manejo global de excepciones en ASP.NET Core 11: por qué IExceptionFilter es la herramienta equivocada, cómo IExceptionHandler y UseExceptionHandler funcionan juntos, respuestas con ProblemDetails, cadenas de varios manejadores y el cambio disruptivo de .NET 10 sobre la supresión de diagnósticos."
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "error-handling"
lang: "es"
translationOf: "2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-26
---

Para capturar cada excepción no controlada en una aplicación ASP.NET Core 11 y convertirla en una respuesta HTTP limpia, implementa `IExceptionHandler`, regístralo con `services.AddExceptionHandler<T>()` y coloca `app.UseExceptionHandler()` al inicio del pipeline de middleware. El antiguo `IExceptionFilter` de MVC solo se dispara para las acciones de los controladores, así que omite los endpoints de minimal API, las excepciones del middleware, los fallos de model binding y cualquier cosa lanzada antes de que MVC se ejecute. El enfoque basado en handlers lo reemplaza en todo el pipeline, se integra con `ProblemDetails` para respuestas RFC 7807 y funciona igual en Native AOT, minimal APIs y controladores. Todo en esta guía apunta a .NET 11 (preview 3) con `Microsoft.NET.Sdk.Web` y C# 14, pero la API ha sido estable desde .NET 8 y los patrones se aplican sin cambios en .NET 9 y .NET 10.

## "Filtro de excepciones" es el término de búsqueda, pero casi nunca quieres uno

Cuando quien desarrolla pregunta cómo añadir un "filtro global de excepciones", el resultado mejor posicionado en los buscadores suele ser una respuesta de Stack Overflow de 2017 que apunta a `IExceptionFilter` y a `MvcOptions.Filters.Add<T>`. Ese código sigue compilando y sigue ejecutándose, pero no ha sido la respuesta correcta desde ASP.NET Core 8.

`IExceptionFilter` vive en `Microsoft.AspNetCore.Mvc.Filters`. Forma parte del pipeline de MVC, lo que significa tres cosas:

1. Solo captura excepciones lanzadas dentro de una acción MVC, un filtro MVC o un ejecutor de resultados. Cualquier cosa lanzada antes en el pipeline (errores de model binding, fallos de autenticación, 404 de enrutamiento) nunca lo alcanza.
2. No ve las excepciones de los endpoints de minimal API (`app.MapGet("/", ...)`). Las minimal API no pasan por `MvcRoutedActionInvoker`, así que los filtros MVC permanecen en silencio para ellas.
3. Se ejecuta después de que el model binding ya haya producido un error en `ModelState`, así que un cuerpo de solicitud malformado devuelve un 400 del framework antes de que tu filtro vea siquiera la excepción que querías traducir.

El equivalente moderno es `IExceptionHandler`, introducido en `Microsoft.AspNetCore.Diagnostics` 8.0 y sin cambios en .NET 11. Se ejecuta desde dentro del middleware `UseExceptionHandler`, que se sitúa en lo más alto del pipeline, así que un solo handler cubre controladores, minimal APIs, gRPC, la negociación de SignalR, archivos estáticos y excepciones lanzadas por el middleware en un único lugar. Eso es lo que la gente quiere decir cuando dice "global".

El resto de esta guía es el camino de `IExceptionHandler`. La última sección cubre los pocos casos en los que un filtro MVC sigue siendo la herramienta correcta.

## El IExceptionHandler mínimo

`IExceptionHandler` es una interfaz de un solo método:

```csharp
// .NET 11, C# 14
namespace Microsoft.AspNetCore.Diagnostics;

public interface IExceptionHandler
{
    ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken);
}
```

Devuelve `true` si escribiste la respuesta y quieres que el middleware se detenga. Devuelve `false` para pasar al siguiente handler en la cadena (o, si ninguno la maneja, a la respuesta de error predeterminada del framework).

Un handler funcional que "traduce cada excepción en un 500 con un cuerpo JSON" tiene unas 30 líneas:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

internal sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.6.1",
                Title = "An unexpected error occurred",
                Status = StatusCodes.Status500InternalServerError,
            },
        });
    }
}
```

Dos detalles importan aquí. Primero, el handler es `sealed` y usa inyección por constructor primario, que es el idiom de C# 12+. Segundo, delegamos el cuerpo real de la respuesta a `IProblemDetailsService` en lugar de llamar a `httpContext.Response.WriteAsJsonAsync(...)` nosotros mismos. Ese único cambio es lo que hace que la respuesta respete la cabecera `Accept` del cliente, el conjunto de `IProblemDetailsWriter` registrados y cualquier callback `CustomizeProblemDetails` que hayas configurado. Volvemos a esto en la sección de ProblemDetails.

## Conectar el handler en Program.cs

Tres líneas añaden el handler. El orden del middleware importa:

```csharp
// .NET 11, C# 14, Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // must come before UseAuthorization, MapControllers, etc.
app.UseStatusCodePages();    // optional, formats 4xx the same way

app.MapControllers();
app.Run();
```

`AddExceptionHandler<T>` registra el handler como singleton, lo cual lo aplica el framework. Si tu handler necesita servicios scoped (un `DbContext`, un logger con scope de solicitud), inyecta `IServiceProvider` y crea un scope por llamada en lugar de tomar el servicio scoped en el constructor:

```csharp
// .NET 11, C# 14
internal sealed class DbBackedExceptionHandler(IServiceScopeFactory scopes) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditDbContext>();
        db.Failures.Add(new FailureRecord(ctx.TraceIdentifier, ex.GetType().FullName!));
        await db.SaveChangesAsync(ct);
        return false; // let another handler write the response
    }
}
```

`UseExceptionHandler()` sin argumentos usa la cadena de `IExceptionHandler` registrados. La sobrecarga que toma una `string` con la ruta o un `Action<IApplicationBuilder>` corresponde al modelo antiguo solo de middleware y omite la cadena de handlers. Elige uno u otro, no ambos.

## ProblemDetails gratis, cuando lo conectas

`AddProblemDetails()` registra el `IProblemDetailsService` predeterminado y un `IProblemDetailsWriter` para `application/problem+json`. Una vez registrado, suceden tres cosas automáticamente:

1. `UseExceptionHandler()` escribe un cuerpo `ProblemDetails` para excepciones no controladas cuando ningún `IExceptionHandler` reclama la respuesta.
2. `UseStatusCodePages()` escribe un cuerpo `ProblemDetails` para respuestas 4xx sin cuerpo.
3. Tu propio handler puede llamar a `problemDetailsService.TryWriteAsync(...)` para obtener la misma negociación de contenido y personalización gratis.

El punto de personalización más útil es `CustomizeProblemDetails`, que se ejecuta después de que tu handler construya el objeto y antes de que se escriba. Un sitio típico añade el identificador de traza para que soporte pueda correlacionar un error visible para el usuario con una entrada de registro:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
        ctx.ProblemDetails.Extensions["requestId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

No pongas mensajes de excepción ni trazas de pila en la respuesta en producción. Filtran estructura interna (nombres de tablas, rutas de archivos, URLs de APIs de terceros) que un atacante puede encadenar en una sonda más dirigida. Condiciona cualquier eco de `ex.Message` a `IHostEnvironment.IsDevelopment()`.

## Varios handlers, ordenados por tipo de excepción

El middleware de excepciones itera los handlers registrados en el orden de registro hasta que uno devuelve `true`. Ese es el lugar correcto para poner traducción por tipo de excepción:

```csharp
// .NET 11, C# 14
internal sealed class ValidationExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not FluentValidation.ValidationException ve) return false;

        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;

        var errors = ve.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new HttpValidationProblemDetails(errors)
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                Title = "One or more validation errors occurred",
                Status = StatusCodes.Status400BadRequest,
            },
        });
    }
}

internal sealed class NotFoundExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not EntityNotFoundException) return false;

        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.5",
                Title = "Resource not found",
                Status = StatusCodes.Status404NotFound,
            },
        });
    }
}
```

Regístralos en orden de prioridad. El handler 500 que captura todo va al final:

```csharp
// .NET 11, C# 14
builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
```

El middleware itera los singletons exactamente en este orden. Si `ValidationExceptionHandler` devuelve `false`, se le pregunta al siguiente handler. Si `GlobalExceptionHandler` devuelve `true`, no se ejecuta ningún handler más.

Resiste el impulso de escribir un mega-handler con un `switch` gigante. Los handlers por tipo de excepción son más fáciles de probar en pruebas unitarias (cada uno es una clase pequeña que toma un fake), más fáciles de borrar cuando un tipo de excepción desaparece y más fáciles de conectar condicionalmente (por ejemplo, solo registrar `ValidationExceptionHandler` cuando FluentValidation está en el proyecto).

## Orden de middleware que rompe el handler

El error más común es poner `UseExceptionHandler()` en el lugar equivocado. La regla es: debe ir antes que cualquier middleware que pueda lanzar una excepción que quieras capturar. En la práctica eso significa que debe ser el primer middleware no relacionado con el entorno.

```csharp
// Wrong: a NullReferenceException from authentication never reaches the handler.
app.UseAuthentication();
app.UseAuthorization();
app.UseExceptionHandler();   // too late
app.MapControllers();

// Right: the handler wraps everything that follows.
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

Lo único que legítimamente se ejecuta antes de `UseExceptionHandler` es la página de excepciones para desarrollo en entornos no productivos:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler();
    app.UseHsts();
}
```

Si registras ambos, la página de desarrollo gana en dev porque corta la solicitud antes de que se ejecute el middleware del handler. Eso es normalmente lo que quieres: la página de dev muestra la traza de pila y el fragmento de código fuente, que es la razón entera de ejecutarlo localmente.

## El cambio disruptivo de supresión de diagnósticos en .NET 10

En .NET 8 y 9, `UseExceptionHandler` siempre registraba la excepción no controlada en nivel `Error` y emitía la actividad `Microsoft.AspNetCore.Diagnostics.HandlerException`, sin importar si tu `IExceptionHandler` devolvía `true`. Eso facilitaba el doble registro: tu handler registraba, y también lo hacía el framework.

A partir de .NET 10 (y conservado en .NET 11), el framework suprime sus propios diagnósticos para cualquier excepción que un handler haya reclamado devolviendo `true`. Tu handler ahora es el único responsable del registro en ese caso. Las excepciones que pasan sin ser controladas siguen emitiendo el log del framework.

Este es un cambio de comportamiento que puedes encontrar en silencio. Si tienes una alerta en Grafana sobre `aspnetcore.diagnostics.handler.unhandled_exceptions` y actualizas a .NET 10 o posterior, la métrica cae a cero para excepciones controladas y tu dashboard se aplana. La solución es:

```csharp
// Opt back in to the .NET 8/9 behaviour.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = _ => false,
});
```

O, preferentemente, eliminar el dashboard y depender del registro que hace tu handler. Contar dos veces siempre fue un bug.

El callback recibe un `ExceptionHandlerDiagnosticsContext` con la excepción, la solicitud y un flag para indicar si un handler reclamó la respuesta, así que puedes suprimir selectivamente, por ejemplo, no registrar `OperationCanceledException` de una solicitud que el cliente abortó:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = ctx =>
        ctx.Exception is OperationCanceledException &&
        ctx.HttpContext.RequestAborted.IsCancellationRequested,
});
```

Consulta la [nota de cambio disruptivo en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed) para la semántica exacta.

## Cuándo IExceptionFilter sigue siendo la herramienta correcta

Hay dos casos estrechos en los que `IExceptionFilter` de MVC sigue siendo correcto:

1. Quieres traducir una excepción solo para un controlador o acción específicos, y quieres el filtro descubrible en los atributos de la acción. `[TypeFilter(typeof(MyExceptionFilter))]` en la clase del controlador limita el comportamiento sin contaminar el pipeline global. Esto es más bien un filtro de acción para un endpoint raro que una verdadera cosa "global".
2. Necesitas acceso al `ActionContext` de MVC (por ejemplo, el `IModelMetadataProvider` para los parámetros de la acción). `IExceptionHandler` solo ve `HttpContext`, así que esos metadatos no están disponibles allí.

Fuera de eso, gana `IExceptionHandler`. Funciona para minimal APIs, se ejecuta antes de MVC y compone limpiamente con varios handlers registrados. Trata el filtro MVC como una herramienta con scope de acción, no como una global.

## Un error común: lanzar dentro de un IProblemDetailsWriter personalizado

Si implementas un `IProblemDetailsWriter` personalizado (por ejemplo, para emitir un sobre de error específico del proveedor), no lances desde `WriteAsync`. El middleware de excepciones también captura esa excepción, vuelve a entrar en la misma cadena de handlers y obtienes o un desbordamiento de pila o, con suerte, un 500 vacío sin cuerpo. Envuelve la lógica de escritura del cuerpo en un try/catch y devuelve `false` desde `CanWrite` si el writer está en mal estado. La misma regla se aplica al código del handler: no lances desde dentro de `TryHandleAsync`. Devuelve `false` en su lugar.

Una forma segura:

```csharp
// .NET 11, C# 14
public async ValueTask<bool> TryHandleAsync(
    HttpContext ctx, Exception ex, CancellationToken ct)
{
    try
    {
        ctx.Response.StatusCode = MapStatus(ex);
        await pds.TryWriteAsync(BuildContext(ctx, ex));
        return true;
    }
    catch
    {
        return false; // let the framework default kick in
    }
}
```

## Relacionados

- [JsonConverter personalizado en System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) para serializar el diccionario `ProblemDetails.Extensions` como esperan tus clientes.
- [Transmitir un archivo desde un endpoint de ASP.NET Core sin búfer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cubre otra sutileza de orden de middleware en el mismo pipeline.
- [Cancelar una Task de larga duración sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para los patrones de `OperationCanceledException` en los que se basa el callback de diagnósticos de arriba.
- [Generar clientes fuertemente tipados desde una especificación OpenAPI en .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) si publicas el esquema `ProblemDetails` a tus consumidores.

## Fuentes

- Microsoft Learn, [Manejar errores en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling?view=aspnetcore-10.0).
- Microsoft Learn, [Manejar errores en APIs de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0).
- Cambio disruptivo de Microsoft Learn, [Los diagnósticos de excepciones se suprimen cuando IExceptionHandler.TryHandleAsync devuelve true](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed).
- Notas de versión de ASP.NET Core, [.NET 10 preview 7 ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/10.0/preview/preview7/aspnetcore.md).
- Discusión de GitHub, [IExceptionHandler en .NET 8 para manejo global de excepciones](https://github.com/dotnet/aspnetcore/discussions/54613).
