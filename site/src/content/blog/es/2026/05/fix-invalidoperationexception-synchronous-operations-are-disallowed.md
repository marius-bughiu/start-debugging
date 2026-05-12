---
title: "Solución: InvalidOperationException: Synchronous operations are disallowed"
description: "Reemplace la llamada Stream.Read o Write por ReadAsync/WriteAsync. Como último recurso, active AllowSynchronousIO en Kestrel, IIS o por solicitud con IHttpBodyControlFeature."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
  - "kestrel"
lang: "es"
translationOf: "2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed"
translatedBy: "claude"
translationDate: 2026-05-12
---

La solución: ASP.NET Core 3.0 y posteriores deshabilitan por defecto las lecturas y escrituras síncronas sobre `HttpRequest.Body` y `HttpResponse.Body`, por lo que cualquier código que llame a `Stream.Read`, `Stream.Write`, `Stream.Flush`, `StreamReader.ReadToEnd`, `StreamWriter.Write` o `JsonSerializer.Deserialize(stream)` lanzará `InvalidOperationException: Synchronous operations are disallowed`. La solución limpia es cambiar la llamada por su equivalente asíncrono (`ReadAsync`, `WriteAsync`, `DeserializeAsync`) y esperarla con `await`. Si no puede modificar el llamador, active `AllowSynchronousIO = true` en Kestrel o IIS, o cambie `IHttpBodyControlFeature.AllowSynchronousIO` solo en la solicitud problemática.

```text
System.InvalidOperationException: Synchronous operations are disallowed. Call ReadAsync or set AllowSynchronousIO to true instead.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpRequestStream.Read(Byte[] buffer, Int32 offset, Int32 count)
   at System.IO.Stream.CopyTo(Stream destination, Int32 bufferSize)
   at Newtonsoft.Json.JsonSerializer.DeserializeInternal(JsonReader reader, Type objectType)
   at MyApp.LegacyHandler.Parse(HttpRequest request)
```

Esta guía está escrita contra ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4) y Kestrel 11.0.0-preview.4. La verificación existe desde 3.0.0-preview3 (febrero de 2019) y aplica a Kestrel, HTTP.sys, IIS in-process y `TestServer`. El texto de la excepción es idéntico entre versiones; solo han cambiado los servidores por defecto y las APIs de conveniencia a su alrededor.

## Por qué el servidor bloquea la E/S síncrona por defecto

Cada hilo bloqueado dentro de un manejador de solicitud es un hilo que no está disponible para el resto de la aplicación. Una `Stream.Read` síncrona sobre una conexión de cliente lenta puede inmovilizar un hilo del thread pool durante varios segundos. Bajo carga, el pool se queda sin hilos, la latencia de las solicitudes se dispara y el proceso termina pareciendo colgado aunque la CPU esté inactiva. Este patrón, la inanición del thread pool, fue responsable de una larga cola de incidentes en producción en ASP.NET Core 1.x y 2.x donde las aplicaciones se congelaban bajo tráfico irregular.

La versión 3.0 cambió `AllowSynchronousIO` de `true` a `false` en todos los servidores integrados. El runtime ahora rechaza activamente las llamadas síncronas en lugar de dejarlas bloquear en silencio. La excepción no es un bug, es el servidor diciéndole que la llamada habría bloqueado un hilo durante toda la duración de la lectura o escritura de red. Una vez entendido eso, la "solución" deja de ser "desactivar la verificación" y pasa a ser "deje de bloquear el hilo".

El anuncio del equipo del runtime en [aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644) lista los servidores afectados y el escape recomendado vía `IHttpBodyControlFeature`.

## Una reproducción mínima

```csharp
// ASP.NET Core 11, C# 14, Newtonsoft.Json 13.0.4
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/legacy", (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = reader.ReadToEnd();                      // throws
    return Results.Ok(json.Length);
});

app.Run();
```

`StreamReader.ReadToEnd` llama internamente a `Stream.Read`. El `HttpRequestStream` de Kestrel sobrescribe `Read` para lanzar inmediatamente cuando `AllowSynchronousIO` es `false`. El mismo tipo de error aparece con cualquiera de estos llamadores:

- `JsonSerializer.Deserialize<T>(request.Body)` de `System.Text.Json`.
- `JsonSerializer.Create().Deserialize(...)` de `Newtonsoft.Json` cuando recibe `request.Body`.
- `request.Body.CopyTo(target)` para reenviar un cuerpo de solicitud.
- `response.Body.Write(buffer, 0, count)` desde un middleware personalizado.
- `XmlSerializer.Deserialize(request.Body)`.
- Cualquier biblioteca de terceros que llame internamente a `Stream.Read` o `Stream.Write` sobre el stream de request/response.

La traza de pila es su mejor aliada aquí: léala de abajo hacia arriba para encontrar la API síncrona que aterrizó en el stream del servidor.

## Solución 1: cambiar a la API asíncrona (recomendada)

Esta es la única solución que realmente resuelve el problema subyacente. Casi toda API común tiene una hermana asíncrona.

```csharp
// ASP.NET Core 11, C# 14
app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = await reader.ReadToEndAsync();
    return Results.Ok(json.Length);
});
```

Para JSON, prefiera el deserializador en streaming de `System.Text.Json`, que nunca materializa el payload completo como string:

```csharp
// ASP.NET Core 11, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

app.MapPost("/orders", async (HttpRequest request) =>
{
    var order = await JsonSerializer.DeserializeAsync<Order>(
        request.Body,
        cancellationToken: request.HttpContext.RequestAborted);
    return Results.Ok(order);
});

record Order(string Sku, int Quantity);
```

Si está leyendo un modelo en una API mínima, la solución más simple es dejar que el framework lo enlace. Los parámetros `[FromBody]` en APIs mínimas y MVC deserializan de forma asíncrona, por lo que la verificación de E/S síncrona nunca se dispara.

```csharp
app.MapPost("/orders", (Order order) => Results.Ok(order));
```

Para Newtonsoft.Json, el destino de migración es `System.Text.Json` y su deserializador asíncrono. Si no puede migrar, lea el cuerpo a un `MemoryStream` de forma asíncrona primero, y luego entregue ese búfer a Newtonsoft:

```csharp
// ASP.NET Core 11, Newtonsoft.Json 13.0.4
using Newtonsoft.Json;

app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    using var reader = new StreamReader(ms);
    using var jsonReader = new JsonTextReader(reader);
    var serializer = new JsonSerializer();
    var order = serializer.Deserialize<Order>(jsonReader);
    return Results.Ok(order);
});
```

El `Deserialize` síncrono de Newtonsoft ahora opera sobre un `MemoryStream`, no sobre el stream de solicitud de Kestrel, así que la verificación pasa. Este patrón también funciona para envolver parsers de terceros que solo son síncronos. Para una planificación a más largo plazo, vea el enfoque de [migración de Newtonsoft.Json a System.Text.Json](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Solución 2: activar AllowSynchronousIO en todo el servidor

Si está atrapado con una biblioteca que no tiene ninguna API asíncrona, puede reactivar la E/S síncrona en el servidor. Este es un escape global y debe acompañarse de un plan registrado para eliminarlo. La configuración depende del servidor que ejecute.

**Kestrel:**

```csharp
// ASP.NET Core 11
builder.WebHost.ConfigureKestrel(options =>
{
    options.AllowSynchronousIO = true;
});
```

**IIS in-process:**

```csharp
// ASP.NET Core 11
builder.Services.Configure<IISServerOptions>(options =>
{
    options.AllowSynchronousIO = true;
});
```

**HTTP.sys:**

```csharp
// ASP.NET Core 11
builder.WebHost.UseHttpSys(options =>
{
    options.AllowSynchronousIO = true;
});
```

La documentación oficial de Kestrel confirma que la propiedad está en `KestrelServerOptions` y por defecto es `false`; vea [Configure options for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io). Activarla en todos lados hace desaparecer la verificación, pero también reintroduce el riesgo de inanición de hilos que el valor por defecto se añadió para prevenir. Trate el flag como una etiqueta que dice "todavía no terminé la migración a asíncrono", no como una configuración permanente.

## Solución 3: activar E/S síncrona en una sola solicitud

Si solo un endpoint tiene una dependencia síncrona, no active el interruptor global del servidor. Use `IHttpBodyControlFeature` para optar por activarlo solo en esa solicitud, idealmente dentro de un middleware acotado a la ruta exacta.

```csharp
// ASP.NET Core 11
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/legacy/export", (HttpContext ctx) =>
{
    var feature = ctx.Features.Get<IHttpBodyControlFeature>();
    if (feature is not null)
    {
        feature.AllowSynchronousIO = true;
    }

    using var writer = new StreamWriter(ctx.Response.Body);
    writer.Write("<huge legacy XML payload>");
    return Results.Empty;
});
```

La feature debe activarse antes de la primera llamada que de otro modo lanzaría. Si lee el cuerpo primero y luego activa el flag, la lectura ya falló. Para MVC, el equivalente es un filtro que se ejecuta en `OnActionExecuting` y activa la feature antes de que el model binder lea el cuerpo.

Este enfoque por solicitud mantiene al resto de la aplicación protegida por el valor por defecto. Es la respuesta correcta cuando tiene un endpoint heredado rodeado de otros modernos y asíncronos.

## Trampas y casos parecidos

**A veces la excepción envuelve un problema distinto.** Una respuesta con `Response.Body.Write(...)` después de `await Response.WriteAsync(...)` puede lanzar la misma excepción aunque el desarrollador creyera que todo era asíncrono; el problema suele ser una llamada oculta a `Flush` dentro de un logger o un `JsonSerializer` que no acepta el token de cancelación. Lea la traza completa, no solo el frame superior.

**`HttpRequest.ReadFormAsync` es la forma segura para datos de formulario.** Un camino común a este error es `request.Form["..."]`, que es un accesor síncrono que internamente llama a `Read`. Cambie a `await request.ReadFormAsync()` y luego acceda al `IFormCollection` resultante.

**Middleware de logging que llama a `Response.Body.Seek` o `CopyTo`.** El middleware personalizado de captura de respuesta casi siempre dispara esta verificación. Reemplace `CopyTo` por `CopyToAsync` y cambie cualquier lectura bloqueante sobre el stream envolvente por sus sobrecargas asíncronas.

**La verificación no se dispara bajo TestServer en algunos escenarios.** `TestServer` no siempre configura el mismo `IHttpBodyControlFeature` que Kestrel. Código que funciona en pruebas puede lanzar en producción. Haga una prueba de humo contra Kestrel localmente antes de desplegar.

**Activar `AllowSynchronousIO = true` no silencia todos los errores relacionados con asíncrono.** Solo cambia la verificación de E/S síncrona. `TaskCanceledException` por desconexión del cliente es otro problema distinto; vea el artículo sobre [TaskCanceledException: A task was canceled en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para esa familia de errores.

**Casos parecidos específicos de JSON.** Un `JsonException: The JSON value could not be converted to System.DateTime` es un error de formato en deserialización, no de E/S, aunque ambos aparezcan dentro de un manejador de solicitud. Si su frame de pila termina en `System.Text.Json`, vea la [guía de deserialización de DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) en su lugar.

**`DisposeAsync` importa.** Llamar a `Dispose` síncrono sobre un stream que el servidor le entregó puede invocar implícitamente a `Flush`, que es una escritura. Use `await using` para cualquier stream que obtenga de `HttpContext`.

```csharp
// ASP.NET Core 11
await using var writer = new StreamWriter(response.Body);
await writer.WriteAsync("done");
```

El patrón `await using` es uno de esos pequeños hábitos que se amortizan a la primera vez que salvan una solicitud de esta excepción.

## Relacionados

- [Cómo hacer streaming de un archivo desde un endpoint de ASP.NET Core sin búfer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cubre los patrones asíncronos que el runtime espera cuando escribe respuestas grandes.
- [Cómo subir un archivo grande con streaming a Azure Blob Storage](/es/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) es la guía correspondiente del lado de escritura.
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) muestra el plomería asíncrona de pruebas que conviene tener alrededor de cualquier manejador que toque cuerpos de request o response.
- [Solución: A second operation was started on this context instance before a previous operation completed](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/) es el primo de EF Core de este error: otro caso donde el runtime detecta un error de sync sobre async.
- [Solución: TaskCanceledException: A task was canceled en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para la familia de timeouts relacionados del lado cliente.

## Fuentes

- [Configure options for the ASP.NET Core Kestrel web server, Synchronous I/O](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) (MS Learn, .NET 10 / 11)
- [Announcement: AllowSynchronousIO disabled in all servers, dotnet/aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644)
- [ASP.NET Core breaking changes for versions 3.0 and 3.1](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnetcore)
- [Referencia de la API `KestrelServerOptions.AllowSynchronousIO`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.server.kestrel.core.kestrelserveroptions.allowsynchronousio)
- [Interfaz `IHttpBodyControlFeature`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpbodycontrolfeature)
