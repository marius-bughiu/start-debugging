---
title: "Solución: los endpoints de API de ASP.NET Core devuelven 401 en lugar de redirigir a la página de login tras actualizar a .NET 10"
description: "En .NET 10 la autenticación por cookies responde a los endpoints de tipo API con 401/403 en lugar de redirigir al login. Restáuralo por endpoint, globalmente o con un switch de AppContext."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "authentication"
  - "cookies"
  - "csharp"
lang: "es"
translationOf: "2026/09/fix-aspnetcore-api-endpoints-return-401-instead-of-redirecting-to-login-dotnet-10"
translatedBy: "claude"
translationDate: 2026-09-15
---

En ASP.NET Core 10, las solicitudes no autenticadas a endpoints "con forma de API" protegidos por autenticación por cookies reciben un `401` (y las prohibidas un `403`) en lugar de un `302` a tu `LoginPath`. Eso abarca los controladores `[ApiController]`, las minimal APIs que leen o escriben JSON, los retornos `TypedResults` y SignalR. El cambio es intencional. Si un navegador realmente navega a uno de esos endpoints, agrega `.AllowCookieRedirect()` (o `[AllowCookieRedirect]`) a ese endpoint. Para recuperar el comportamiento de .NET 9 en toda la aplicación, sobrescribe `OnRedirectToLogin`/`OnRedirectToAccessDenied`, o activa el switch de AppContext `Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata`. Todo lo que sigue se midió en ASP.NET Core 10.0.10 (SDK 10.0.302) frente a 9.0.20.

## El error en contexto

Después de la actualización no hay ninguna excepción ni nada en el registro. La página de login simplemente deja de aparecer. Una solicitud que antes rebotaba a `/login` ahora vuelve así:

```text
HTTP/1.1 401 Unauthorized
Content-Length: 0
Server: Kestrel
Location: http://localhost:5103/login?ReturnUrl=%2Fm%2Fdto
```

Fíjate en que el header `Location` sigue ahí. El handler de cookies calcula la URL de login exactamente igual que antes y la escribe en la respuesta, pero establece el estado en `401` en lugar de `302`, así que ni los navegadores ni `HttpClient` la siguen. Un usuario autenticado que no cumple una política de autorización recibe el mismo trato: `403 Forbidden` con `Location: /denied?ReturnUrl=...` en lugar de una redirección a `AccessDeniedPath`.

Síntomas típicos:

- Una aplicación de Razor Pages o MVC con algunos endpoints de minimal API: al abrir uno de ellos en una pestaña del navegador aparece una página en blanco (o la propia página 401 del navegador) en lugar del formulario de login.
- Un `fetch` del frontend que antes seguía el `302`, llegaba al HTML del login y lo detectaba con `res.redirected` ahora recibe un `401` y lanza una excepción en otra ruta del código.
- Las pruebas de integración que verificaban la redirección al login (un `302` con `AllowAutoRedirect = false`, o una URL final en `/Account/Login` con el cliente por defecto) ahora fallan justo para los endpoints listados arriba, mientras que el resto siguen pasando.

## Por qué .NET 10 dejó de redirigir en estos endpoints

Se trata del breaking change [Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints), incluido en .NET 10 Preview 7 y disponible de forma general desde 10.0.0 (noviembre de 2025). Cierra una petición que data de 2019 ([dotnet/aspnetcore#9039, "ApiController redirects to login page"](https://github.com/dotnet/aspnetcore/issues/9039)): una página de login en HTML no le sirve de nada a un cliente JSON.

El mecanismo son los metadatos del endpoint. El delegado `OnRedirectToLogin` por defecto en `CookieAuthenticationEvents` ahora dice:

```csharp
// ASP.NET Core 10.0.0, src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs (abridged)
public Func<RedirectContext<CookieAuthenticationOptions>, Task> OnRedirectToLogin { get; set; } = context =>
{
    if (IsAjaxRequest(context.Request) || IsCookieRedirectDisabledByMetadata(context.HttpContext))
    {
        context.Response.Headers.Location = context.RedirectUri;
        context.Response.StatusCode = 401;
    }
    else
    {
        context.Response.Redirect(context.RedirectUri);
    }
    return Task.CompletedTask;
};

private static bool IsCookieRedirectDisabledByMetadata(HttpContext context)
{
    if (_ignoreCookieRedirectMetadata) // AppContext switch, read once
    {
        return false;
    }
    var endpoint = context.GetEndpoint();
    return endpoint?.Metadata.GetMetadata<IDisableCookieRedirectMetadata>() is not null &&
        endpoint?.Metadata.GetMetadata<IAllowCookieRedirectMetadata>() is null;
}
```

La rama `IsAjaxRequest` (un header `X-Requested-With: XMLHttpRequest`) existe desde hace años. Lo nuevo es `IDisableCookieRedirectMetadata`, que el framework agrega automáticamente en estos lugares:

- `ApiControllerAttribute` ahora implementa `IDisableCookieRedirectMetadata`, así que todas las acciones de un controlador `[ApiController]` lo llevan.
- `RequestDelegateFactory` (y el Request Delegate Generator que se usa para Native AOT) lo agrega cuando un handler de minimal API tiene un parámetro de cuerpo JSON, o cuando su tipo de retorno se serializa como JSON.
- Los tipos de `TypedResults` orientados a API (`Ok`, `Ok<T>`, `Created`, `Accepted`, `NotFound<T>`, `BadRequest`, `Conflict`, `ValidationProblem`, `ProblemHttpResult`, `JsonHttpResult<T>`, `ServerSentEventsResult<T>` y compañía) lo agregan desde su `PopulateMetadata`.
- `MapHub` y `MapConnectionHandler` lo agregan para SignalR.

Hay un detalle que confunde a quienes buscan este problema: la página de Microsoft Learn todavía llama a la interfaz marcadora `IApiEndpointMetadata`. Ese era su nombre en Preview 7. La revisión de API la renombró antes de la GA en [dotnet/aspnetcore#63283](https://github.com/dotnet/aspnetcore/pull/63283), que además agregó la exclusión `IAllowCookieRedirectMetadata`, los métodos de extensión `AllowCookieRedirect`/`DisableCookieRedirect` y el switch de AppContext. En una aplicación con .NET 10 publicado, `IApiEndpointMetadata` no existe. Los tipos son `IDisableCookieRedirectMetadata` e `IAllowCookieRedirectMetadata` en `Microsoft.AspNetCore.Http.Metadata`.

## Reproducción mínima

Una aplicación basada en un solo archivo, ejecutada una vez con el runtime de .NET 9.0.20 y otra con 10.0.10:

```csharp
// .NET 10, ASP.NET Core 10.0.10, run with: dotnet run probe.cs
#:sdk Microsoft.NET.Sdk.Web

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o => { o.LoginPath = "/login"; o.AccessDeniedPath = "/denied"; });
builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var m = app.MapGroup("/m").RequireAuthorization();
m.MapGet("/string", () => "plain text");                          // text/plain
m.MapGet("/dto", () => new Todo(1, "json"));                       // JSON response
m.MapGet("/typed", () => TypedResults.Ok(new Todo(1, "typed")));   // TypedResults
m.MapGet("/iresult", () => Results.Ok(new Todo(1, "iresult")));    // returns IResult
m.MapPost("/body", (Todo t) => "got body");                        // JSON request body
app.MapControllers();
app.Run();

public record Todo(int Id, string Title);

[ApiController, Route("c/api"), Authorize]
public class ApiCtl : ControllerBase { [HttpGet] public Todo Get() => new(1, "api"); }

[Route("c/mvc"), Authorize]
public class MvcCtl : Controller { [HttpGet] public Todo Get() => new(1, "mvc"); }
```

Estos son los resultados de `curl -D -` sin cookie. Las dos primeras columnas salen del mismo código; la tercera es 10.0.10 con `IgnoreRedirectMetadata` establecido en `true`:

| Endpoint | 9.0.20 | 10.0.10 | 10.0.10 + switch |
| --- | --- | --- | --- |
| `GET /m/string` (devuelve `string`) | 302 | 302 | 302 |
| `GET /m/dto` (devuelve un record) | 302 | **401** | 302 |
| Handler `GET` asíncrono que devuelve `Task<Todo>` | 302 | **401** | 302 |
| `GET /m/typed` (`TypedResults.Ok`) | 302 | **401** | 302 |
| `Results<Ok<Todo>, NotFound>` | 302 | **401** | 302 |
| `TypedResults.Json(...)` | 302 | **401** | 302 |
| `GET /m/iresult` (`Results.Ok`, declarado `IResult`) | 302 | 302 | 302 |
| `TypedResults.Text`, `TypedResults.File`, `TypedResults.Redirect` | 302 | 302 | 302 |
| `POST /m/body` (cuerpo JSON) | 302 | **401** | 302 |
| Acción `[ApiController]` | 302 | **401** | 302 |
| Acción de `Controller` simple (sin `[ApiController]`) | 302 | 302 | 302 |
| Cualquier endpoint con `X-Requested-With: XMLHttpRequest` | 401 | 401 | 401 |
| Autenticado, falla `RequireRole`, endpoint JSON | 302 a `/denied` | **403** | 302 a `/denied` |
| Autenticado, falla `RequireRole`, endpoint `string` | 302 a `/denied` | 302 a `/denied` | 302 a `/denied` |

Así que la regla general no es "APIs" en ningún sentido arquitectónico. Lo que importa son los metadatos del endpoint. `Results.Ok(...)` sigue redirigiendo y `TypedResults.Ok(...)` no, porque `IResult` oculta el tipo concreto a la inferencia de metadatos. La diferencia entre las dos factorías se explica en [typed results vs IResult vs IActionResult](/es/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/).

## La solución, en detalle

Elige la primera opción que coincida con lo que el endpoint realmente es.

### 1. El endpoint se llama desde código: conserva el 401 y corrige el cliente

Si quien llama es `fetch`, `HttpClient` o una aplicación móvil, el nuevo comportamiento es el correcto, y el antiguo `302` a una página HTML era un bug que tenías sorteado. Maneja el código de estado en lugar de detectar redirecciones:

```javascript
// Browser fetch against an ASP.NET Core 10 cookie-authenticated API
const res = await fetch("/api/todos", { credentials: "same-origin" });
if (res.status === 401) {
  // Cookie missing or expired: send the user to the login page ourselves
  location.href = "/login?ReturnUrl=" + encodeURIComponent(location.pathname);
} else if (res.status === 403) {
  location.href = "/denied";
} else {
  const todos = await res.json();
}
```

Aprovecha para eliminar cualquier comprobación de `res.redirected` o `res.url.includes("/login")`: en .NET 10 son código muerto para estos endpoints. Si tu SPA y tu API corren en orígenes distintos, la parte de credenciales y CORS es un tema aparte, tratado en [autenticación JWT vs cookies en ASP.NET Core](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

### 2. Un navegador navega al endpoint: vuelve a habilitarlo con `AllowCookieRedirect`

Para los pocos endpoints que un usuario realmente abre en una pestaña (un enlace de exportación que devuelve JSON, un enlace "ver en bruto" en una página de administración, una acción `[ApiController]` a la que las vistas MVC antiguas enlazan directamente), restaura la redirección por endpoint:

```csharp
// .NET 10, ASP.NET Core 10.0.10
app.MapGet("/export/orders", (OrderService s) => s.GetAll())
   .RequireAuthorization()
   .AllowCookieRedirect();

[ApiController, Route("api/reports"), Authorize]
public class ReportsController : ControllerBase
{
    [HttpGet("download"), AllowCookieRedirect]
    public ReportDto Download() => new(/* ... */);
}
```

`IAllowCookieRedirectMetadata` tiene prioridad sobre `IDisableCookieRedirectMetadata` sin importar el orden, así que también funciona en un grupo (`app.MapGroup("/export").AllowCookieRedirect()`). En la prueba, `/m/dto` con `.AllowCookieRedirect()` volvió a `302`, y lo mismo una acción `[ApiController]` con `[AllowCookieRedirect]`. También existe lo contrario. `.DisableCookieRedirect()` hace que un endpoint que devuelve `string` responda `401`, algo útil para endpoints de salud o de diagnóstico que nunca deberían mostrar una página de login.

### 3. Aplicación mixta: redirige solo las navegaciones reales del navegador

Si tienes muchos endpoints de ambos tipos, es más limpio decidir por solicitud que por endpoint. Todos los navegadores principales actuales (Chrome, Edge, Firefox, Safari 16.4+) envían [`Sec-Fetch-Mode: navigate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Mode) en una navegación de nivel superior y `cors`/`same-origin` en `fetch`:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/login";
        options.AccessDeniedPath = "/denied";

        options.Events.OnRedirectToLogin = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// ... app.Run();

static bool IsBrowserNavigation(HttpRequest request)
{
    var mode = request.Headers["Sec-Fetch-Mode"].ToString();
    if (mode.Length > 0)
        return mode == "navigate";

    // Clients without Fetch Metadata headers: fall back to the Accept header
    return HttpMethods.IsGet(request.Method)
        && request.Headers.Accept.ToString().Contains("text/html");
}
```

Medido en 10.0.10 sobre la mitad de `OnRedirectToLogin`: `/m/dto` con `Sec-Fetch-Mode: navigate` recibió `302`, `/m/string` con `Sec-Fetch-Mode: cors` recibió `401`, y un `curl` sin más (sin Fetch Metadata, `Accept: */*`) recibió `401` en todos los endpoints, incluidos los que el framework habría redirigido. Como esto reemplaza el delegado por defecto, los metadatos del endpoint ya no se consultan en absoluto: decide la solicitud, no el endpoint.

### 4. Redirigir siempre, exactamente como antes

Este es el fragmento de la página del breaking change. Úsalo cuando la aplicación sea un sitio renderizado en el servidor y ninguno de sus endpoints tenga un llamador que no sea un navegador:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
```

Ten en cuenta que esto también redirige las XHR, cosa que .NET 9 no hacía. Si quieres exactamente la semántica de .NET 9 (`401` para `X-Requested-With: XMLHttpRequest`, redirección para todo lo demás), el switch de la opción 5 lo logra con una sola línea.

### 5. El switch de AppContext: el comportamiento de .NET 9 sin escribir eventos

El switch no aparece en la página de Microsoft Learn, pero se incluyó en 10.0.0 (desde el PR #63283) y es la forma menos invasiva de volver a la semántica de .NET 9. Actívalo en el archivo del proyecto:

```xml
<!-- .NET 10, in the web project's .csproj -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata"
                                  Value="true" />
</ItemGroup>
```

o como primera línea de `Program.cs`:

```csharp
// .NET 10, must run before the cookie handler is first used
AppContext.SetSwitch("Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata", true);
```

El elemento `RuntimeHostConfigurationOption` termina como una entrada `configProperties` en `bin/.../<app>.runtimeconfig.json`. Probé tanto esa entrada como la llamada a `SetSwitch`, y cada una produjo la columna "10.0.10 + switch" de arriba: todos los endpoints vuelven a redirigir y las XHR siguen recibiendo `401`. Trátalo como una muleta para la migración, no como un destino. Desactiva los metadatos en toda la aplicación, incluido el marcador de los hubs de SignalR, así que una solicitud de negociación no autenticada vuelve a la regla anterior a .NET 10: solo un header `X-Requested-With: XMLHttpRequest` evita que se redirija a una página HTML.

## Trampas y problemas parecidos

**Ya tenías un `OnRedirectToLogin` personalizado.** Entonces nada cambió para ti, y quizá te preguntes por qué la aplicación de un colega se comporta distinto. La comprobación de metadatos vive dentro del delegado *por defecto*. Cualquier aplicación que haya reemplazado `OnRedirectToLogin` o que herede de `CookieAuthenticationEvents` y sobrescriba `RedirectToLogin` la omite por completo. También funciona al revés: si quieres el nuevo comportamiento *y* un evento personalizado (por ejemplo, para registrar los inicios de sesión fallidos), ejecuta tu lógica y luego reproduce tú mismo la comprobación de `IDisableCookieRedirectMetadata`.

**El switch se lee una sola vez.** `_ignoreCookieRedirectMetadata` es un campo `static readonly` de `CookieAuthenticationEvents`. Activar el switch después de la primera solicitud, o cambiarlo en una prueba después de que el host haya arrancado, no tiene efecto.

**Solo el handler de cookies mira estos metadatos.** En el repositorio de aspnetcore, el único consumidor de `IDisableCookieRedirectMetadata` es `CookieAuthenticationEvents`. Si tu `DefaultChallengeScheme` es OpenID Connect (Microsoft.Identity.Web, Entra ID, Auth0), el handler de OIDC emite el challenge y sigue redirigiendo al proveedor de identidad para todos los endpoints. Si ves un `401` ahí, el esquema de cookies es el esquema de challenge para ese endpoint, normalmente por un `[Authorize(AuthenticationSchemes = ...)]` explícito o por una política.

**Pruebas de integración.** Los clientes de `WebApplicationFactory` siguen las redirecciones por defecto, así que las pruebas que verificaban que "una solicitud no autenticada termina en la página de login" ahora ven un `401` en los endpoints de API. Actualiza la aserción en lugar de agregar `AllowCookieRedirect` solo para que las pruebas pasen; los patrones de configuración están en [pruebas de integración con WebApplicationFactory](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

**Native AOT se comporta igual.** El Request Delegate Generator emite una clase `DisableCookieRedirectMetadata` local al archivo y la agrega bajo las mismas condiciones de JSON que la factoría basada en reflexión, así que las compilaciones AOT y JIT coinciden.

**.NET 11 lo mantiene.** La misma comprobación `IsCookieRedirectDisabledByMetadata` está en `main`, así que si pasas directamente de .NET 8 o 9 a 11, esto va en tu lista junto a los demás cambios de autenticación de [la checklist de migración de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

**No es este problema: 401 con un bearer token, o 405.** Si el endpoint usa JWT bearer y recibes `401` con un header `WWW-Authenticate: Bearer`, lo que se rechaza es el token en sí; consulta [por qué un JWT de ASP.NET Core devuelve 401 incluso con un token válido](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/). Si recibes `405` con un header `Allow`, el enrutamiento rechazó el verbo antes de que se ejecutara la autenticación; consulta [405 Method Not Allowed en lugar de 401 con JWT bearer](/es/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/). El cambio de cookies de .NET 10 siempre produce `401`/`403` con un header `Location` y sin header `WWW-Authenticate`.

## Relacionados

- [Autenticación JWT vs cookies en ASP.NET Core](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)
- [Typed results vs IResult vs IActionResult](/es/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Cómo escribir pruebas de integración con WebApplicationFactory](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Solución: 405 Method Not Allowed en lugar de 401 con JWT bearer](/es/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/)
- [Migrar de .NET 8 a .NET 11: la checklist completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Fuentes

- [Breaking change: Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) (Microsoft Learn) y el anuncio [aspnet/Announcements#525](https://github.com/aspnet/Announcements/issues/525).
- [dotnet/aspnetcore#62816: Avoid cookie login redirects for known API endpoints](https://github.com/dotnet/aspnetcore/pull/62816), el cambio original.
- [dotnet/aspnetcore#63283: Address API review feedback for what was IApiEndpointMetadata](https://github.com/dotnet/aspnetcore/pull/63283), el cambio de nombre, `AllowCookieRedirect` y el switch `IgnoreRedirectMetadata`.
- [`CookieAuthenticationEvents.cs` en v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs) y [`RequestDelegateFactory.cs` en v10.0.12](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Http.Extensions/src/RequestDelegateFactory.cs).
- [dotnet/aspnetcore#9039: ApiController redirects to login page](https://github.com/dotnet/aspnetcore/issues/9039), la petición de 2019 que originó el cambio.
