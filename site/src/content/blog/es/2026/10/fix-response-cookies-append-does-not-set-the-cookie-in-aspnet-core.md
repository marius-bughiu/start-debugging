---
title: "Solución: Response.Cookies.Append no establece la cookie en el navegador en ASP.NET Core"
description: "El encabezado Set-Cookie se envía, pero el navegador lo rechaza o nunca lo guarda. Corrige SameSite=None sin Secure, la falta de credentials: 'include' junto con AllowCredentials, la política de consentimiento y las llamadas tardías a Append."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "cookies"
  - "cors"
lang: "es"
translationOf: "2026/10/fix-response-cookies-append-does-not-set-the-cookie-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-10-28
---

La solución: `Response.Cookies.Append` casi nunca falla en el servidor. Escribe un encabezado `Set-Cookie`, y luego el navegador se niega en silencio a guardarlo. En orden de probabilidad, la causa es: la solicitud era cross-origin y el cliente no envió `credentials: 'include'` (o el servidor no llamó a `AllowCredentials()`), la cookie tiene `SameSite=None` sin `Secure`, una verificación de consentimiento de `CookiePolicy` suprimió una cookie que no está marcada como `IsEssential`, o `Append` se ejecutó después de que la respuesta ya había comenzado. Abre la pestaña Network de las DevTools del navegador, selecciona la respuesta y mira la subpestaña Cookies: Chromium te dice exactamente qué regla la bloqueó.

Todo lo que sigue apunta a .NET 10 y ASP.NET Core 10 (el comportamiento es idéntico en las versiones preliminares de .NET 11 y se mantiene estable desde ASP.NET Core 3.1). El comportamiento del navegador se refiere a las versiones actuales de Chrome, Firefox y Safari a octubre de 2026.

```text
// Roughly what Chrome DevTools shows under Network > (response) > Cookies
Set-Cookie: session=abc123; path=/; samesite=none
  ⚠ This attempt to set a cookie via a Set-Cookie header was blocked because it had the
    "SameSite=None" attribute but did not have the "Secure" attribute, which is required
    in order to use "SameSite=None".
```

Y en el registro de ASP.NET Core, cuando el logger de `Microsoft.AspNetCore.Http.ResponseCookies` está habilitado en `Warning`:

```text
warn: Microsoft.AspNetCore.Http.ResponseCookies
      The cookie 'session' has set 'SameSite=None' and must also set 'Secure'.
```

## Por qué la cookie nunca llega a document.cookie ni a la siguiente solicitud

`Response.Cookies.Append` es un envoltorio delgado. En el código fuente de ASP.NET Core (`src/Http/Http/src/Internal/ResponseCookies.cs`) hace tres cosas: si `SameSite` es `None` y `Secure` es `false` registra la advertencia de arriba, codifica el valor para URL con `Uri.EscapeDataString` y concatena un nuevo encabezado `Set-Cookie` a la respuesta. Eso es todo. No valida el dominio, no revisa CORS y no lanza una excepción cuando la cookie va a ser rechazada. Todas las fallas reales ocurren después, dentro del navegador, que aplica una pila de reglas a cada encabezado `Set-Cookie`:

1. **Modo de credenciales de CORS.** En un `fetch` o `XMLHttpRequest` cross-origin, el navegador ignora `Set-Cookie` por completo a menos que la solicitud se haya hecho en modo de credenciales (`credentials: 'include'` / `withCredentials = true`) y la respuesta haya incluido `Access-Control-Allow-Credentials: true` con un `Access-Control-Allow-Origin` explícito (distinto de `*`).
2. **SameSite.** Todos los navegadores actuales rechazan una cookie `SameSite=None` sin `Secure`. Una cookie `Lax` o `Strict` establecida en una respuesta cross-site se rechaza como cookie de terceros.
3. **Secure.** Una cookie `Secure` establecida sobre `http://` simple se rechaza, con una excepción: Chrome (desde la 89) y Firefox (desde la 75) tratan `http://localhost` como seguro para este fin. Safari no.
4. **Domain y Path.** Se rechaza un atributo `Domain` que no coincide con el dominio del host de la respuesta. Un `Path` que no cubre la URL que solicitas después significa que la cookie se guarda pero nunca se devuelve, lo que se ve idéntico a "no establecida".
5. **Tamaño.** Se descarta una cookie individual (nombre más valor) de más de 4096 bytes.

Además de las reglas del navegador, ASP.NET Core tiene dos lugares propios donde una cookie puede desaparecer antes de salir por la red: la verificación de consentimiento de `CookiePolicyMiddleware` y el límite de "la respuesta ya comenzó".

## Reproducción mínima: un servidor de desarrollo de React llamando a una API de ASP.NET Core

Esta es la configuración detrás de la mayoría de las preguntas de "cookie no establecida" en Stack Overflow: una SPA en un puerto y una API en otro.

```csharp
// .NET 10, ASP.NET Core 10 - Program.cs (broken)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

app.MapPost("/login", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Append("session", "abc123", new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.None
    });
    return Results.Ok();
});

app.MapGet("/me", (HttpContext ctx) =>
    ctx.Request.Cookies.TryGetValue("session", out var s)
        ? Results.Ok(s)
        : Results.Unauthorized());

app.Run();
```

```javascript
// Vite dev server on http://localhost:5173
await fetch("https://localhost:7001/login", { method: "POST" });
const me = await fetch("https://localhost:7001/me");
console.log(me.status); // 401
```

Aquí se acumulan tres bugs distintos. Las llamadas a `fetch` usan el valor predeterminado `credentials: 'same-origin'`, así que el navegador descarta `Set-Cookie` de la respuesta cross-origin y no adjunta cookies a `/me`. La política de CORS no tiene `AllowCredentials()`. Y la cookie es `SameSite=None` sin `Secure`. Si corriges solo uno de ellos, sigues viendo el mismo 401, y por eso este problema parece tan aleatorio.

## Solución 1: envía credenciales y permítelas en la política de CORS

En cualquier llamada cross-origin, ambos lados tienen que aceptarlo explícitamente. En el cliente:

```javascript
// Browser, any framework
await fetch("https://localhost:7001/login", {
  method: "POST",
  credentials: "include"
});

// axios equivalent
axios.post("https://localhost:7001/login", null, { withCredentials: true });
```

En el servidor, enumera los orígenes exactos y llama a `AllowCredentials()`:

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "https://app.example.com")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));
```

No puedes combinar `AllowAnyOrigin()` con `AllowCredentials()`. La especificación de CORS prohíbe `Access-Control-Allow-Origin: *` en una respuesta con credenciales, y ASP.NET Core lo hace cumplir al construir la política lanzando `InvalidOperationException: The CORS protocol does not allow specifying a wildcard (any) origin and credentials at the same time.` Si necesitas orígenes dinámicos, usa `SetIsOriginAllowed(origin => ...)` con una verificación real, nunca `_ => true`, porque reflejar cualquier origen con credenciales habilitadas es un agujero CSRF de manual. La configuración completa de la política, incluido el almacenamiento en caché de preflight, se cubre en [configurar CORS para una API protegida con JWT en ASP.NET Core 11](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

El orden del middleware también importa: `app.UseCors()` debe ejecutarse antes del endpoint que agrega la cookie, y antes de `UseAuthentication()` / `UseAuthorization()`.

## Solución 2: combina SameSite=None con Secure, o evita SameSite=None

El valor predeterminado de `CookieOptions.SameSite` es `SameSiteMode.Unspecified`, lo que significa que ASP.NET Core no emite ningún atributo `SameSite` y el navegador aplica su propio valor predeterminado. Chromium trata un atributo ausente como `Lax`. Ese valor predeterminado es correcto para casi cualquier aplicación same-site, y solo deberías recurrir a `None` cuando la cookie realmente tiene que viajar en solicitudes cross-site (un iframe incrustado en otro sitio, un widget de terceros, un callback de un proveedor de identidad que usa `form_post`).

Si de verdad necesitas `None`, `Secure` es obligatorio:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("session", token, new CookieOptions
{
    HttpOnly = true,
    Secure = true,                  // required with SameSite=None
    SameSite = SameSiteMode.None,
    Path = "/",
    MaxAge = TimeSpan.FromHours(8)
});
```

Esta es la distinción que confunde a la gente: **SameSite trata del sitio, CORS trata del origen.** Un sitio es el esquema más el dominio registrable, e ignora el puerto. Así que `http://localhost:5173` llamando a `http://localhost:5001` es cross-origin (CORS aplica, necesitas la Solución 1) pero same-site (las cookies `Lax` funcionan). `app.example.com` llamando a `api.example.com` también es same-site. En esas configuraciones no necesitas `SameSite=None` en absoluto; mantén `Lax` y solo corrige las credenciales.

El esquema sí cuenta, eso sí. Chrome usa "schemeful same-site" desde Chrome 89, así que `http://localhost:5173` llamando a `https://localhost:7001` es cross-site, y una cookie `Lax` establecida por la API HTTPS no se enviará desde las solicitudes de la página HTTP. O ejecutas ambos servidores de desarrollo con el mismo esquema (el plugin `basicSsl` de Vite o `dotnet dev-certs https` funcionan), o pones la API detrás del proxy del servidor de desarrollo para que el navegador solo hable con un origen. La opción del proxy es la más robusta porque reproduce la implementación same-origin de producción.

Las cookies verdaderamente cross-site (la SPA en `myapp.com`, la API en `myapi.net`) son cookies de terceros. Chrome las mantuvo habilitadas por defecto después de que Google abandonara su plan de deprecación en abril de 2025, pero Safari las bloquea directamente y Firefox las particiona bajo Total Cookie Protection. No construyas sobre ellas. Mueve la API bajo el mismo dominio registrable, o cambia a un Backend-for-Frontend para que el navegador guarde una cookie de primera parte. Si tienes que incrustar cross-site, revisa las cookies particionadas (CHIPS). `CookieOptions` en ASP.NET Core 10 no tiene una propiedad `Partitioned`, pero `Extensions` te permite agregar el atributo tú mismo:

```csharp
// .NET 10, ASP.NET Core 10 - CHIPS partitioned cookie for a cross-site iframe
var options = new CookieOptions
{
    Secure = true,
    SameSite = SameSiteMode.None,
    HttpOnly = true
};
options.Extensions.Add("Partitioned");
ctx.Response.Cookies.Append("widget-state", value, options);
```

## Solución 3: marca la cookie como IsEssential, o deja de exigir consentimiento

Si tu aplicación llama a `app.UseCookiePolicy()` con `CheckConsentNeeded` devolviendo `true`, el `CookiePolicyMiddleware` envuelve la colección de cookies de la respuesta y descarta en silencio toda cookie que no esté marcada como esencial hasta que el usuario haya aceptado la cookie de consentimiento. No se registra nada en el nivel predeterminado, y la llamada a `Append` parece haber funcionado. Las plantillas de ASP.NET Core 2.1 a 2.2 venían con esto habilitado, así que los proyectos antiguos que se actualizaron paso a paso a menudo todavía lo arrastran.

```csharp
// .NET 10, ASP.NET Core 10 - the configuration that eats cookies
builder.Services.Configure<CookiePolicyOptions>(o =>
{
    o.CheckConsentNeeded = _ => true;
    o.MinimumSameSitePolicy = SameSiteMode.Lax;
});
// ...
app.UseCookiePolicy();
```

O la cookie es necesaria para que la aplicación funcione, en cuyo caso establece `IsEssential = true` (y sé honesto al respecto en tu política de privacidad), o no lo es, y el comportamiento correcto es esperar el consentimiento:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("cart", cartId, new CookieOptions
{
    IsEssential = true,
    HttpOnly = true,
    Secure = true
});
```

Puedes revisar el estado del consentimiento explícitamente con `ctx.Features.Get<ITrackingConsentFeature>()`, cuya propiedad `CanTrack` te dice si se escribirán las cookies no esenciales. `MinimumSameSitePolicy` en las mismas opciones también puede reescribir el `SameSite` de tu cookie a algo más estricto de lo que pasaste, así que si una cookie aparece con un `SameSite` distinto al que estableciste, busca aquí.

## Solución 4: agrega la cookie antes de que comience la respuesta

Los encabezados de la respuesta se envían en el momento en que se vacía el primer byte del cuerpo. A partir de ese punto, `Response.Cookies.Append` lanza `InvalidOperationException: Headers are read-only, response has already started.` Los lugares clásicos donde ocurre esto son un middleware que agrega una cookie después de `await next()`, un endpoint que escribe en `Response.Body` y luego establece una cookie, y código dentro de una respuesta en streaming o de un bucle SSE.

```csharp
// .NET 10, ASP.NET Core 10 - broken: the endpoint already wrote the body
app.Use(async (ctx, next) =>
{
    await next();
    ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
});

// fixed: register a callback that runs just before headers are flushed
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
        return Task.CompletedTask;
    });
    await next();
});
```

Si la excepción se traga en algún lugar (un filtro de excepciones, una tarea fire-and-forget), el síntoma visible es solo una cookie faltante, así que revisa `ctx.Response.HasStarted` en un punto de interrupción cuando sospeches esto.

## Trampas que parecen "la cookie no se estableció"

**La cookie está establecida, pero tu JavaScript no puede verla.** `HttpOnly = true` la oculta de `document.cookie` por diseño. Revisa la pestaña Application en las DevTools en su lugar. Este es el comportamiento que quieres para los tokens de sesión, como se explica en [JWT vs autenticación con cookies en ASP.NET Core 11](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

**La cookie se guarda pero no se devuelve.** `CookieOptions` usa `/` como valor predeterminado de `Path`, lo cual está bien, pero si estableces `Path = "/api/auth"` el navegador solo la adjuntará a URLs bajo esa ruta. Lo mismo aplica a un `Domain` establecido en un dominio padre con el que tu host de desarrollo no coincide. Deja `Domain` sin establecer a menos que necesites compartir entre subdominios; una cookie host-only es más estricta y más segura.

**El valor se ve alterado.** `Append` pasa el valor por `Uri.EscapeDataString`, así que `a b=c` llega a `document.cookie` como `a%20b%3Dc`. `Request.Cookies` lo decodifica por ti en el servidor; los lectores en JavaScript necesitan `decodeURIComponent`.

**Safari funciona en producción pero no en localhost.** Safari rechaza las cookies `Secure` sobre `http://localhost`, mientras que Chrome y Firefox las aceptan. Ejecuta el servidor de desarrollo sobre HTTPS con `dotnet dev-certs https --trust`.

**Componentes interactivos de Blazor.** En Blazor Server o en los modos de renderizado interactivos, el componente se ejecuta sobre un circuito de SignalR después de que la respuesta HTTP inicial ya terminó, así que no hay respuesta a la que agregar la cookie y `HttpContext` es null u obsoleto. Establece las cookies desde una Razor Page, un endpoint de minimal API al que llame el cliente, o un envío de formulario de SSR estático. La misma restricción impulsa el diseño detrás de [`[SupplyParameterFromSession]` en SSR estático](/es/2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5/).

**La cookie es demasiado grande.** Los navegadores descartan una cookie cuyo nombre más valor supera los 4096 bytes. El manejador de autenticación con cookies de ASP.NET Core divide automáticamente los tickets grandes en `.AspNetCore.Cookies`, `C1`, `C2` mediante `ChunkingCookieManager`, pero un `Response.Cookies.Append` simple no lo hace. Si estás metiendo un JWT con muchos claims en una cookie, recorta los claims o mantén el token del lado del servidor y pon un identificador corto en la cookie. Los flujos de refresh tokens son una fuente común de esto; consulta [implementar refresh tokens en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) para un diseño que mantiene las cookies pequeñas.

**Las cookies de antiforgery que desaparecen después de una implementación** son un problema distinto con el mismo síntoma. La cookie se establece, pero la siguiente instancia no puede descifrarla. Ese caso se cubre en [corregir "The antiforgery token could not be decrypted"](/es/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Una lista de verificación que encuentra la causa en menos de un minuto

Cuando una cookie no se queda, revisa estos puntos en orden. Cada paso encuentra el bug o descarta una categoría entera:

1. Abre las DevTools, pestaña Network, selecciona la respuesta que debería establecer la cookie y confirma que el encabezado `Set-Cookie` está presente. Si falta, el problema está del lado del servidor: la política de consentimiento, una excepción después de que comenzó la respuesta, o la ruta de código nunca se ejecutó.
2. Si el encabezado está presente, abre la subpestaña Cookies de esa solicitud. Chromium marca las cookies bloqueadas con un ícono de advertencia y la razón exacta (SameSite, Secure, Domain o bloqueo de terceros).
3. Si la llamada es cross-origin, revisa que la solicitud tenga `credentials: 'include'` y que la respuesta tenga `Access-Control-Allow-Credentials: true` más un `Access-Control-Allow-Origin` concreto.
4. Si la cookie se guarda pero la siguiente solicitud no la lleva, compara su `Path`, `Domain`, `SameSite` y `Secure` con la URL y el esquema de esa siguiente solicitud.
5. Si funciona en Chrome y falla en Safari, es `Secure` sobre `http://localhost` o una cookie de terceros.

El código del servidor rara vez es el bug. Trata `Append` como "por favor, considera guardar esto", y depura la respuesta del navegador.

## Fuentes

- [ResponseCookies.cs en dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http/src/Internal/ResponseCookies.cs) (la advertencia de `SameSite=None` y la codificación del valor)
- [Clase CookieOptions en MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.cookieoptions)
- [Habilitar CORS en ASP.NET Core: credenciales en solicitudes cross-origin](https://learn.microsoft.com/en-us/aspnet/core/security/cors#credentials-in-cross-origin-requests)
- [Compatibilidad con el Reglamento General de Protección de Datos (RGPD) de la UE en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/gdpr)
- [Trabajar con cookies SameSite en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/samesite)
- [MDN: Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie)
- [dotnet/aspnetcore#55370: Add support for Partitioned cookies](https://github.com/dotnet/aspnetcore/issues/55370)
