---
title: "Solución: Unable to find the required 'IAuthenticationService' service con [Authorize(Policy = ...)] en Blazor"
description: "Una página de Blazor Web App con [Authorize] se convierte en un endpoint que revisa AuthorizationMiddleware, y una comprobación fallida llama a ChallengeAsync, que necesita AddAuthentication. Registra un esquema real, o deja pasar los endpoints de componentes hacia AuthorizeRouteView."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-10"
  - "authorization"
lang: "es"
translationOf: "2026/09/fix-unable-to-find-the-required-iauthenticationservice-blazor-authorize-policy"
translatedBy: "claude"
translationDate: 2026-09-24
---

`Unable to find the required 'IAuthenticationService' service` en una página de Blazor con `@attribute [Authorize(Policy = "...")]` significa que el `AuthorizationMiddleware` de ASP.NET Core evaluó tu política para la solicitud HTTP, la comprobación falló e intentó llamar a `HttpContext.ChallengeAsync()` sin servicios de autenticación registrados. La solución de fondo es `builder.Services.AddAuthentication(...)` con un esquema (normalmente cookies), para que el challenge tenga a dónde ir. Si tu aplicación autentica únicamente mediante un `AuthenticationStateProvider` personalizado, registra un `IAuthorizationMiddlewareResultHandler` que deje pasar los endpoints de componentes Razor, y deja que `AuthorizeRouteView` aplique la política.

Todo lo que sigue se reprodujo en .NET 10.0.10 (SDK 10.0.302) y .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) con la plantilla estándar `dotnet new blazor -int Server`. Ambos runtimes dieron resultados idénticos en todos los escenarios.

## El error en contexto

El navegador recibe un 500 en la primera solicitud a la página protegida. El registro muestra que el challenge proviene del middleware de autorización, no de Blazor:

```text
fail: Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddleware[1]
      An unhandled exception has occurred while executing the request.
      System.InvalidOperationException: Unable to find the required 'IAuthenticationService' service. Please add all the required services by calling 'IServiceCollection.AddAuthentication' in the application startup code.
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.GetAuthenticationService(HttpContext context)
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.ChallengeAsync(HttpContext context)
         at Microsoft.AspNetCore.Authorization.Policy.AuthorizationMiddlewareResultHandler.<>c__DisplayClass0_0.<<HandleAsync>g__Handle|0>d.MoveNext()
      --- End of stack trace from previous location ---
         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)
         at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
```

El patrón delator que lleva a la gente a Stack Overflow y a [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678): navegar a la página desde dentro de la aplicación funciona, pero recargarla, abrirla desde un marcador o abrirla como primera página de una sesión provoca el fallo.

## Por qué ocurre

Tres piezas de ASP.NET Core se combinan para producir la excepción.

1. **Un componente enrutable es un endpoint HTTP.** Desde .NET 8, `MapRazorComponents<App>()` crea un endpoint por cada `@page`. `RazorComponentEndpointFactory` copia todos los atributos del tipo del componente en los metadatos del endpoint, incluido `[Authorize]` (consulta el comentario "All attributes defined for the type are included as metadata" en el código fuente).
2. **`UseAuthorization()` se agrega por ti.** `WebApplicationBuilder` inserta el middleware de autorización automáticamente siempre que `IAuthorizationHandlerProvider` está registrado, y `AddAuthorizationCore()` lo registra. No necesitas llamar a `app.UseAuthorization()` para verte afectado; mi reproducción nunca lo llama.
3. **Una política fallida se convierte en un challenge.** El `AuthorizationMiddlewareResultHandler` predeterminado llama a `context.ChallengeAsync()` para un usuario anónimo y a `context.ForbidAsync()` para uno autenticado que no cumple la política. Ambos necesitan `IAuthenticationService`, que solo registra `AddAuthentication()`.

Así que el middleware ejecuta tu política contra `HttpContext.User`. Tu `AuthenticationStateProvider` personalizado no se consulta en absoluto en este camino, y por eso el siguiente punto sorprende a la gente: **el error también ocurre para usuarios que tu provider considera autenticados**. En mi reproducción, un provider que devuelve un principal con el rol `Admin` igualmente recibió un 500 en `/admin`, porque `HttpContext.User` era anónimo.

La navegación del lado del cliente dentro de un circuito interactivo nunca hace una solicitud HTTP, así que el middleware nunca la ve. Ahí es `AuthorizeRouteView` quien evalúa `[Authorize]`, usando el `AuthenticationStateProvider`. Esa es toda la explicación de "funciona cuando hago clic en el enlace, falla con F5".

Esto funcionaba en Blazor Server de .NET 7 porque `_Host.cshtml` era el único endpoint y los componentes nunca se mapeaban individualmente. [Migrar a una Blazor Web App](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) es justamente cuando la mayoría se encuentra con este error.

## Reproducción mínima

Una Blazor Web App que se autentica contra una API externa y expone el resultado solo mediante un `AuthenticationStateProvider` personalizado, sin ningún esquema de autenticación de ASP.NET Core:

```csharp
// .NET 10.0.10 / .NET 11 RC 1, Program.cs
using System.Security.Claims;
using AuthRepro.Components;
using Microsoft.AspNetCore.Components.Authorization;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<AuthenticationStateProvider, ApiTokenAuthStateProvider>();
builder.Services.AddAuthorizationCore(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));

var app = builder.Build();
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();

class ApiTokenAuthStateProvider : AuthenticationStateProvider
{
    public override Task<AuthenticationState> GetAuthenticationStateAsync() =>
        Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
}
```

```razor
@* .NET 10 / 11, Components/Pages/Admin.razor *@
@page "/admin"
@attribute [Authorize(Policy = "Admins")]
<h1>Admin area</h1>
```

`Routes.razor` usa `<AuthorizeRouteView>` con un bloque `<NotAuthorized>`. Hacer curl a la aplicación en ejecución da:

| Solicitud | Resultado |
| --- | --- |
| `GET /` | 200 |
| `GET /admin` | 500, excepción de `IAuthenticationService` |
| `GET /admin`, el provider devuelve un Admin | 500, la misma excepción |

## Solución 1: registra un esquema de autenticación real (recomendado)

Si los usuarios inician sesión en tu aplicación de alguna forma, dale a ASP.NET Core un esquema que sepa quiénes son en la solicitud HTTP. Para una aplicación Blazor renderizada en el servidor, eso casi siempre significa cookies:

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authentication.Cookies;

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.LoginPath = "/login";
        o.AccessDeniedPath = "/access-denied";
    });

builder.Services.AddAuthorization(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));
```

Con eso en su lugar, `GET /admin` como usuario anónimo devuelve `302` hacia `/login?ReturnUrl=%2Fadmin` en vez de lanzar la excepción. Un usuario que inició sesión pero no tiene el rol es enviado a `AccessDeniedPath`.

Dos pasos adicionales hacen que esto sea correcto y no solo silencioso:

- **Inicia sesión con la cookie.** Si tu flujo de inicio de sesión llama a una API externa y recibe un token, termínalo con `HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal)` desde una página de SSR estático o un endpoint de minimal API, con los claims que te interesan (roles, id de usuario). Puedes guardar el token de la API en las `AuthenticationProperties` de la cookie si llamadas posteriores lo necesitan.
- **Elimina el `AuthenticationStateProvider` personalizado si solo duplicaba ese trabajo.** El `ServerAuthenticationStateProvider` integrado de Blazor lee `HttpContext.User` durante el prerenderizado y lo pasa al circuito, así que las páginas, `AuthorizeView` y el middleware coinciden en quién es el usuario.

Si no tienes claro si te convienen cookies o tokens, [JWT vs autenticación con cookies en ASP.NET Core](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) analiza las ventajas y desventajas. Para una Blazor Web App que sirve su propia interfaz, las cookies ganan casi siempre.

Un detalle que conviene saber: desde .NET 7, cuando hay exactamente un esquema registrado, este se vuelve el predeterminado automáticamente. `AddAuthentication().AddCookie()` sin argumento de esquema predeterminado también funcionó en mi reproducción, redirigiendo al `/Account/Login` predeterminado del handler de cookies. En cuanto agregas un segundo esquema (OpenID Connect, JWT bearer), nombra los predeterminados explícitamente o cambiarás este error por `No authenticationScheme was specified, and there was no DefaultChallengeScheme found`.

## Solución 2: deja pasar los endpoints de componentes hacia AuthorizeRouteView

Algunas aplicaciones realmente no tienen identidad a nivel HTTP: la aplicación Blazor Server llama a una Web API separada, guarda el token en el estado del circuito y expone al usuario solo mediante un `AuthenticationStateProvider` personalizado. Agregar ahí un esquema de cookies implica reconstruir el flujo de inicio de sesión. La alternativa es cambiar lo que hace el middleware de autorización cuando una política falla, usando el punto de extensión documentado [`IAuthorizationMiddlewareResultHandler`](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse):

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Components.Endpoints;

builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    BlazorAuthorizationMiddlewareResultHandler>();

sealed class BlazorAuthorizationMiddlewareResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context,
        AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        // Razor component pages: let the request through. AuthorizeRouteView
        // re-checks [Authorize] against the AuthenticationStateProvider.
        if (context.GetEndpoint()?.Metadata.GetMetadata<ComponentTypeMetadata>() is not null)
            return next(context);

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
```

`ComponentTypeMetadata` (público, en `Microsoft.AspNetCore.Components.Endpoints`) se adjunta a cada endpoint que crea `MapRazorComponents`, así que el paso directo se aplica solo a las páginas. Todo lo demás mantiene el comportamiento predeterminado.

Resultados medidos con este handler y sin llamar a `AddAuthentication()`:

| Solicitud | Usuario del provider | Resultado |
| --- | --- | --- |
| `GET /admin` | anónimo | 200, se renderiza el contenido de `<NotAuthorized>` |
| `GET /admin` | tiene el rol `Admin` | 200, se renderiza la página |
| `GET /api/secret` (`RequireAuthorization("Admins")`) | cualquiera | 500, excepción de `IAuthenticationService` |

Entiende a qué te comprometes con esta solución:

- **La página la protege `AuthorizeRouteView`, no el middleware.** Renderiza `<NotAuthorized>` en lugar de la página, durante el prerenderizado y en el circuito. Tu `Routes.razor` debe usar `AuthorizeRouteView` (el `RouteView` simple ignora `[Authorize]`), y el contenido de `<NotAuthorized>` es lo que ven los usuarios anónimos, así que pon ahí un enlace para iniciar sesión.
- **La respuesta es 200, no 401 ni 302.** Los crawlers y los monitores de disponibilidad ven una página exitosa. Si necesitas una redirección, hazla desde el bloque `<NotAuthorized>` con `NavigationManager.NavigateTo("/login")`, o usa la Solución 1.
- **Los endpoints que no son componentes siguen necesitando la Solución 1.** La última fila de la tabla es intencional: una minimal API o un controlador detrás de una política no tiene un `AuthorizeRouteView` en el cual apoyarse. Si tienes de esos, necesitas un esquema real de todas formas.

No "arregles" esto registrando un handler de autenticación vacío cuyo challenge no hace nada. El middleware corta el pipeline después de un challenge, así que los usuarios reciben una página 200 vacía sin ninguna explicación, lo cual es peor que la excepción.

## Solución 3: mueve la comprobación al componente

Si solo una sección de la página está restringida, el atributo es la herramienta equivocada. Quita `@attribute [Authorize(...)]` y envuelve el marcado protegido:

```razor
@* .NET 10 / 11 *@
@page "/admin"

<AuthorizeView Policy="Admins">
    <Authorized><h1>Admin area</h1></Authorized>
    <NotAuthorized><p>You need the Admin role.</p></NotAuthorized>
</AuthorizeView>
```

Sin metadatos en el endpoint, sin comprobación del middleware, sin excepción: en la misma reproducción (todavía sin `AddAuthentication()`), esta página devolvió 200 con el contenido de `<NotAuthorized>` para un usuario anónimo y el marcado de administración para un Admin. Esto coincide con la observación de quien reportó #55678 de que `<AuthorizeView>` en la primera página nunca fallaba. Sirve bien para restringir la interfaz, pero recuerda que todo lo que se renderiza en el servidor se sigue enviando a los usuarios que pasan la comprobación, así que el acceso a datos en el componente también debe verificar la autorización, no solo el marcado.

## Trampas y errores parecidos

**Una `FallbackPolicy` rompe todas las páginas, incluida la de inicio.** `AddAuthorization(o => o.FallbackPolicy = ...RequireAuthenticatedUser()...)` se aplica a todo endpoint que no tenga sus propios metadatos de autorización. En mi reproducción, `GET /` pasó de 200 a 500 con la misma excepción. Las aplicaciones Blazor Server clásicas que aún usan `_Host.cshtml` y `MapBlazorHub()` se topan con el error de esta forma (o mediante `MapBlazorHub().RequireAuthorization()`), ya que sus componentes no son endpoints individuales.

**`AddAuthorizationCore()` vs `AddAuthorization()` no es la causa.** Ambos registran el handler provider que hace que `WebApplicationBuilder` inserte `UseAuthorization()`. Cambiar de uno a otro no cambia nada aquí.

**Blazor WebAssembly standalone nunca muestra este error.** No hay pipeline de ASP.NET Core en el cliente. Si una aplicación WebAssembly cree que el usuario es anónimo después de iniciar sesión, es un problema distinto, cubierto en [IsAuthenticated es false después de actualizar MSAL](/es/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/).

**El modo de renderizado no importa.** La solicitud que falla es el GET HTTP inicial que sirve la página, antes de que empiece cualquier interactividad. Las páginas Static SSR, Interactive Server, WebAssembly y Auto se comportan igual. Si los modos de renderizado todavía te resultan confusos, [qué modo de renderizado ejecuta mi componente](/es/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) explica dónde se ejecuta cada uno.

**El usuario del `AuthenticationStateProvider` no llega a `HttpContext.User`.** El flujo solo va en la otra dirección: `ServerAuthenticationStateProvider` lee de `HttpContext`. Todo lo que se ejecuta antes de que los componentes se rendericen (middleware, filtros de endpoint, limitación de tasa particionada por usuario) solo ve lo que un handler de autenticación puso ahí.

## Relacionado

- [Migrar una aplicación Blazor Server a una Blazor Web App en .NET 11](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), la migración que suele sacar a la luz este error.
- [JWT vs autenticación con cookies en ASP.NET Core 11](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), para elegir el esquema de la Solución 1.
- [¿Qué es un modo de renderizado de Blazor y cuál ejecuta mi componente?](/es/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [Solución: JavaScript interop calls cannot be issued at this time durante el prerenderizado de Blazor](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/), otro error que solo aparece en la primera solicitud HTTP.

## Fuentes

- [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678), "Exception triggered by AuthorizeAttribute on the first page loaded in a circuit", y [#53732](https://github.com/dotnet/aspnetcore/issues/53732) sobre `AddAuthorizationCore` sin autenticación en Blazor Web Apps de .NET 8.
- [`RazorComponentEndpointFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointFactory.cs) y [`ComponentTypeMetadata.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/ComponentTypeMetadata.cs) en el tag `v10.0.0`.
- [`WebApplicationBuilder.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/DefaultBuilder/src/WebApplicationBuilder.cs) (`UseAuthentication` / `UseAuthorization` automáticos) y [`AuthorizationMiddlewareResultHandler.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authorization/Policy/src/AuthorizationMiddlewareResultHandler.cs).
- [Personalizar el comportamiento de AuthorizationMiddleware](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) y [Autenticación y autorización en Blazor de ASP.NET Core](https://learn.microsoft.com/aspnet/core/blazor/security/) en Microsoft Learn.
- [Authentication uses single scheme as DefaultScheme](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-7.0#authentication-uses-single-scheme-as-defaultscheme) en Novedades de ASP.NET Core 7.0.
