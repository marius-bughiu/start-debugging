---
title: "Migrar de System.Web.HttpContext a Microsoft.AspNetCore.Http.HttpContext"
description: "Una migración práctica del System.Web.HttpContext de ASP.NET Framework al HttpContext de ASP.NET Core 11: HttpContext.Current, el mapa de propiedades, Server.MapPath, Session y el shim de los adaptadores System.Web para migraciones incrementales."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "httpcontext"
  - "system-web"
lang: "es"
translationOf: "2026/06/migrate-from-system-web-httpcontext-to-aspnetcore-httpcontext"
translatedBy: "claude"
translationDate: 2026-06-06
---

La única línea que rompe más migraciones de ASP.NET Framework que cualquier otra es `HttpContext.Current`. No existe en ASP.NET Core. No hay un contexto ambiental estático al que acceder desde una clase arbitraria, el tipo `HttpContext` es un tipo distinto en un espacio de nombres distinto (`Microsoft.AspNetCore.Http.HttpContext`, no `System.Web.HttpContext`), y la mayoría de las propiedades de las que dependías se movieron, cambiaron de forma o desaparecieron. Este artículo mapea la API antigua a la nueva para .NET 11 / ASP.NET Core 11, y luego muestra los dos caminos reales hacia adelante: una reescritura limpia para el código que controlas, y los adaptadores oficiales `System.Web` cuando tienes un montón de bibliotecas compartidas que pasan `HttpContext` de un lado a otro y no se pueden reescribir de una sola vez.

Para un handler pequeño o un único controlador, la reescritura es de una hora. Para un monolito donde `HttpContext.Current` está enhebrado a través de una capa de negocio en un ensamblado separado, calcula días y echa mano de los adaptadores para que las bibliotecas sigan compilando contra ambos frameworks mientras migras aplicación por aplicación. Nada de la semántica HTTP cambia; lo que cambia es cómo alcanzas la solicitud, que el ciclo de vida ahora está estrictamente vinculado a la solicitud, y que no hay afinidad de hilo en la que apoyarse.

## Por qué esta migración no es un buscar-y-reemplazar

`System.Web.HttpContext` y `Microsoft.AspNetCore.Http.HttpContext` son objetos genuinamente distintos, y las brechas son de comportamiento, no solo cosméticas:

- **`HttpContext.Current` desapareció.** ASP.NET Framework daba a cada solicitud afinidad de hilo, así que un accesor estático podía encontrar el contexto correcto desde el hilo actual. ASP.NET Core no ofrece tal garantía, por lo que no hay nada equivalente que leer de forma estática. En su lugar inyectas el contexto.
- **El contexto no puede sobrevivir a la solicitud.** En ASP.NET Core el contexto se recicla al final de la solicitud. Tocarlo después (una referencia capturada en una tarea fire-and-forget, un campo en caché) lanza `ObjectDisposedException`. En Framework eso a menudo "funcionaba" por accidente.
- **Sin afinidad de hilo.** Una sola solicitud puede saltar de hilo a través de los puntos `await`. Leer y escribir `HttpContext` de forma concurrente es ahora una condición de carrera que te pertenece.
- **Las lecturas y escrituras pasan a ser asíncronas.** `Response.Write` se convierte en `await Response.WriteAsync`. Leer el formulario o el cuerpo es `await ReadFormAsync()` / una lectura de stream. Las cabeceras y cookies de respuesta deben establecerse antes de que comience la respuesta.

La propia [guía de migración de HttpContext](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0) de Microsoft plantea esto como dos estrategias, y la elección dirige todo lo de abajo: reescritura completa, o adaptadores `System.Web` para un movimiento incremental.

## Qué se rompe

| Área | ASP.NET Framework | ASP.NET Core 11 | Severidad |
| --- | --- | --- | --- |
| Contexto ambiental | `HttpContext.Current` | `IHttpContextAccessor` (registrar con `AddHttpContextAccessor`) | alta |
| Ciclo de vida del contexto | Usable tras la solicitud a veces | `ObjectDisposedException` tras finalizar la solicitud | alta |
| Seguridad de hilos | Solicitud con afinidad de hilo | Sin afinidad de hilo a través de `await` | alta |
| Escribir en la respuesta | `Response.Write(s)` | `await Response.WriteAsync(s)` | media |
| Leer formulario / cuerpo | `Request.Form`, `Request.InputStream` (sync) | `await Request.ReadFormAsync()`, `Request.Body` (lectura única) | media |
| Cabeceras / cookies de respuesta | Establecer en cualquier momento | Establecer antes de que comience la respuesta (o vía `OnStarting`) | media |
| Rutas físicas | `Server.MapPath("~/x")` | `IWebHostEnvironment.ContentRootPath` / `WebRootPath` + `Path.Combine` | media |
| Session | `Session["k"]`, auto-serializada, con bloqueo | `HttpContext.Session.GetString/SetString`, basada en bytes, sin bloqueo | media |
| Codificación HTML | `Server.HtmlEncode` | `System.Net.WebUtility.HtmlEncode` / `HtmlEncoder` | baja |
| URL de la solicitud | `Request.Url`, `Request.RawUrl` | `Request.Scheme/Host/Path/QueryString` o `GetDisplayUrl()` | baja |

## Lista de verificación previa

- Instala el SDK de .NET 11 (`dotnet --version` informa `11.x`). Fija `<TargetFramework>net11.0</TargetFramework>` en el proyecto web.
- Inventaría cada referencia a `HttpContext.Current`. `grep -rn "HttpContext.Current"` en toda la solución es la estimación honesta del alcance.
- Inventaría `Server.MapPath`, `Session[`, `Request.Url`, `Response.Write` y `Request.ServerVariables`. Son los infractores de segundo nivel.
- Decide por ensamblado: reescribir a ASP.NET Core nativo, o mantener `System.Web.HttpContext` y agregar el paquete adaptador. Las bibliotecas compartidas que deben seguir sirviendo a la aplicación Framework aún no migrada son candidatas para los adaptadores.
- Ten una suite de pruebas en verde antes de tocar nada. La migración es mecánica, y una suite que pasa es como la mantienes honesta.

## Pasos de migración

### Paso 1: Registra el accesor y deja de recurrir a HttpContext.Current

Reemplaza el acceso ambiental con inyección explícita. En `Program.cs`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddHttpContextAccessor(); // enables IHttpContextAccessor

var app = builder.Build();
app.MapControllers();
app.Run();
```

Un servicio que antes leía `HttpContext.Current` ahora recibe `IHttpContextAccessor`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class CurrentUserService(IHttpContextAccessor accessor)
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

No guardes `accessor.HttpContext` en un campo. Léelo en el punto de uso cada vez, porque el campo capturaría un contexto de una solicitud y lo entregaría a otra, o a ninguna. Dentro de un controlador o de una API mínima ya tienes `HttpContext` como propiedad o parámetro, así que prefiere pasarlo explícitamente y omite el accesor por completo.

**Verifica:** la solución compila sin referencias a `System.Web` en los proyectos reescritos, y una solicitud que ejercita `CurrentUserService` devuelve el id de usuario esperado.

### Paso 2: Traduce las propiedades de la solicitud

La mayoría de los miembros de `Request` se movieron en lugar de desaparecer. El mapeo que cubre los casos comunes:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
string method      = httpContext.Request.Method;          // was HttpMethod
bool   isHttps     = httpContext.Request.IsHttps;         // was IsSecureConnection
string? remoteIp   = httpContext.Connection.RemoteIpAddress?.ToString(); // was UserHostAddress
string userAgent   = httpContext.Request.Headers.UserAgent.ToString();

// Query string: IQueryCollection, indexer never throws on a missing key
string q = httpContext.Request.Query["key"].ToString(); // "" if absent

// Full URL: no single Request.Url anymore
// using Microsoft.AspNetCore.Http.Extensions;
string url = httpContext.Request.GetDisplayUrl();
```

Leer el formulario o el cuerpo es asíncrono y el cuerpo es un stream de solo avance que puedes leer una vez:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
if (httpContext.Request.HasFormContentType)
{
    IFormCollection form = await httpContext.Request.ReadFormAsync();
    string firstName = form["firstname"].ToString();
}
```

**Verifica:** golpea un endpoint que lea query, formulario y una cabecera; comprueba que los valores coinciden con lo que la aplicación Framework devolvía para la misma solicitud.

### Paso 3: Traduce la respuesta, y respeta cuándo se pueden establecer las cabeceras

Escribir es asíncrono, y las cabeceras y cookies deben establecerse antes de que el cuerpo empiece a fluir:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.StatusCode = StatusCodes.Status200OK;
httpContext.Response.ContentType = "application/json";
httpContext.Response.Headers["X-Custom"] = "value"; // before first write
await httpContext.Response.WriteAsync(payload);
```

Si estás en middleware y necesitas establecer cabeceras justo antes de que se envíe la respuesta, usa el callback en lugar de establecerlas tarde:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.OnStarting(static state =>
{
    var ctx = (HttpContext)state;
    ctx.Response.Headers["X-Late"] = "value";
    return Task.CompletedTask;
}, httpContext);
```

**Verifica:** inspecciona las cabeceras de respuesta con `curl -i`; confirma que la cabecera está presente y que no obtienes una excepción `response has already started` bajo carga.

### Paso 4: Reemplaza Server.MapPath con IWebHostEnvironment

`Server.MapPath("~/App_Data/x.json")` no tiene equivalente. Inyecta `IWebHostEnvironment` y combina las rutas tú mismo:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class FileService(IWebHostEnvironment env)
{
    public string DataPath(string name) =>
        Path.Combine(env.ContentRootPath, "App_Data", name); // project root
    public string AssetPath(string name) =>
        Path.Combine(env.WebRootPath, name);                 // wwwroot
}
```

`ContentRootPath` es la raíz del proyecto (el antiguo `~/`), `WebRootPath` es `wwwroot` (la antigua raíz de archivos estáticos). Para la codificación HTML, `Server.HtmlEncode` se convierte en `System.Net.WebUtility.HtmlEncode` o, en DI, un `HtmlEncoder` inyectado.

**Verifica:** una solicitud que carga un archivo resuelve la misma ruta absoluta que esperas, tanto en Windows como en Linux (el `Path.Combine` lo mantiene portable).

### Paso 5: Mueve Session, sabiendo que se comporta de forma distinta

La session de ASP.NET Core es opcional, basada en bytes, no se serializa automáticamente y no ofrece bloqueo por solicitud. Regístrala:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
// ...
app.UseSession(); // before endpoints
```

Luego cambia el indexador por los helpers tipados:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Session.SetString("user", "marius"); // was Session["user"] = "marius"
string? user = httpContext.Session.GetString("user");
httpContext.Session.SetInt32("count", 3);
```

Almacenar un objeto significa serializarlo tú mismo (por ejemplo con `System.Text.Json`) y llamar a `SetString`. No hay una session de objetos automática como tenía Framework. La [guía de migración de session](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0) vale la pena leerla si dependías del bloqueo de session.

**Verifica:** establece un valor en una solicitud, léelo de vuelta en la siguiente; confirma que sobrevive entre solicitudes con la misma cookie de session.

## Cuando una reescritura es demasiado grande: los adaptadores System.Web

Si `HttpContext` está entretejido a través de bibliotecas de clases a las que también llama una aplicación Framework aún no migrada, reescribir cada firma de una vez no es viable. Microsoft entrega los [adaptadores System.Web](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0) exactamente para esto. Reimplementan la forma de `System.Web.HttpContext` sobre el contexto de ASP.NET Core, así que una biblioteca puede apuntar a `netstandard2.0` y servir a ambos runtimes.

Los paquetes que verás:

- `Microsoft.AspNetCore.SystemWebAdapters`: el shim en sí, referenciado por las bibliotecas compartidas. Apunta a .NET Standard 2.0, .NET Framework 4.5+ y .NET 5+.
- `Microsoft.AspNetCore.SystemWebAdapters.CoreServices`: referenciado por la aplicación ASP.NET Core para configurar el comportamiento. Apunta a .NET 6+.
- `Microsoft.AspNetCore.SystemWebAdapters.FrameworkServices`: referenciado por la aplicación Framework durante la migración incremental.

En la aplicación ASP.NET Core lo activas:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddSystemWebAdapters();
// ...
app.UseSystemWebAdapters();
```

Una biblioteca que recibía `System.Web.HttpContext` sigue compilando después de que cambies la referencia a `System.Web` por el paquete adaptador. Para convertir entre las dos representaciones dentro de una solicitud usas las conversiones en caché, lo que te permite reescribir puntos de llamada concretos de forma incremental:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
// Microsoft.AspNetCore.Http.HttpContext -> System.Web.HttpContext
System.Web.HttpContext legacy = coreContext.AsSystemWeb();
// System.Web.HttpContext -> Microsoft.AspNetCore.Http.HttpContext
HttpContext core = legacy.AsAspNetCore();
```

Los adaptadores no son gratis. Agregan sobrecarga frente a las APIs nativas, no todos los miembros están soportados, y dos comportamientos necesitan activarse porque ASP.NET Core no los provee por defecto: un stream de solicitud con búsqueda y completamente almacenado en buffer (`PreBufferRequestStream`) y una respuesta almacenada en buffer (`BufferResponseStream`). Si una biblioteca lee el cuerpo dos veces o depende de `Response.End()`, actívalos en los endpoints relevantes:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapDefaultControllerRoute()
   .PreBufferRequestStream()
   .BufferResponseStream();
```

## Verificación

Después de la migración, recorre esta lista:

- `dotnet build` no informa advertencias sobre `System.Web` en los proyectos que reescribiste.
- `dotnet test` pasa sin pruebas de contexto HTTP omitidas.
- Una prueba de humo de los caminos críticos: inicio de sesión (claims vía `HttpContext.User`), un POST de formulario, una descarga de archivo, un ida y vuelta de session.
- Haz una prueba de carga breve y vigila `ObjectDisposedException` o `response has already started`. Esas dos excepciones son la firma de un bug de contexto capturado o de una escritura tardía de cabeceras.

## Reversión

Esto es una migración de código, no una migración de datos, así que la reversión es un `git revert` de la rama. Lo único a vigilar es el formato del estado de session: la session de ASP.NET Core no es compatible a nivel de cable con la session de ASP.NET Framework, así que si volteaste el tráfico de producción y los usuarios tienen sesiones vivas, una reversión descarta esas sesiones y fuerza un nuevo inicio de sesión. Drena o acepta eso. Nada más aquí es de un solo sentido.

## Trampas que vale la pena conocer antes de empezar

- **`HttpContext` capturado en trabajo en segundo plano.** El fallo de producción más común: un controlador lanza `Task.Run(() => DoWork(HttpContext))` y el contexto ya está liberado para cuando `DoWork` lo lee. Copia primero lo que necesitas en un objeto plano. Esta es la misma trampa de contexto liberado que muerde al `DbContext` de EF Core en código fire-and-forget.
- **`accessor.HttpContext` es null fuera de la solicitud.** En un servicio hospedado o en una tarea de arranque no hay solicitud, así que el accesor devuelve null. Eso es correcto, no un bug. Los servicios en segundo plano tienen su propio [patrón de servicios scoped](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **Leer el cuerpo dos veces.** `Request.Body` es de solo avance. Si el model binding ya lo consumió, una lectura posterior no obtiene nada. Usa `EnableBuffering()` o el `PreBufferRequestStream` de los adaptadores. Las lecturas síncronas también lanzan a menos que las permitas, que es la misma causa raíz detrás de la excepción [synchronous operations are disallowed](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).
- **Orden de registro de DI.** Si un servicio que necesita `IHttpContextAccessor` no puede resolverlo, olvidaste `AddHttpContextAccessor()`, lo que aflora como el familiar error [unable to resolve service for type](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

Si haces esto como parte de un movimiento de framework más amplio, esto encaja dentro de la mayor [migración de .NET Framework 4.8 a .NET 11](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/), y probablemente también estés reemplazando el modelo de hosting en el mismo paso cuando [migres de IWebHostBuilder a WebApplication.CreateBuilder](/es/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/). Para los endpoints nuevos escritos durante la migración, vale la pena sopesar los trade-offs de [APIs mínimas frente a controladores](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) antes de portar la forma del controlador antiguo tal cual.

## Fuentes

- [Migrar el HttpContext de ASP.NET Framework a ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0)
- [Adaptadores System.Web (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0)
- [Acceder a HttpContext en ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-context?view=aspnetcore-10.0)
- [Migración del estado de session de ASP.NET a ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0)
- [dotnet/systemweb-adapters (GitHub)](https://github.com/dotnet/systemweb-adapters)
