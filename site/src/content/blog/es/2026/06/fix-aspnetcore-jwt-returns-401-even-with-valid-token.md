---
title: "Por qué tu JWT de ASP.NET Core devuelve 401 incluso con un token válido"
description: "Un token válido que aun así devuelve 401 casi siempre significa que el handler de bearer nunca se ejecutó o se ejecutó bajo el esquema incorrecto. Revisa el orden del middleware, el esquema predeterminado, el nombre del esquema y si el encabezado siquiera llegó al handler."
pubDate: 2026-06-25
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "es"
translationOf: "2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token"
translatedBy: "claude"
translationDate: 2026-06-25
---

Decodificaste el token en [jwt.io](https://jwt.io/), la firma es correcta, el `exp` está a horas de distancia, el `iss` y el `aud` son exactamente lo que configuraste, y ASP.NET Core sigue respondiendo `401 Unauthorized`. Cuando el token en sí es demostrablemente bueno, el error casi nunca está en el token. Es que el handler de JWT bearer o nunca se ejecutó para esta solicitud, o se ejecutó bajo un esquema que tu atributo `[Authorize]` no está pidiendo. Los cuatro culpables habituales, en el orden en que muerden: falta `app.UseAuthentication()` o está después de `app.UseAuthorization()`; no hay un esquema de autenticación predeterminado registrado; el nombre del esquema en `AddJwtBearer` no coincide con el que `[Authorize]` reclama; o el encabezado `Authorization` nunca llegó al handler en absoluto. Este post usa .NET 11 con `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0-preview y C# 14, pero el diagnóstico es idéntico hasta .NET 8.

Si sospechas que las claims del token están realmente mal (una ventana de `ClockSkew` de cinco minutos, una audiencia que no coincide), eso es otro post: [cómo validar el emisor, la audiencia y el tiempo de vida de un JWT](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) recorre el lado de `TokenValidationParameters` en detalle. Aquí asumimos que ya demostraste que el token es válido y el 401 persiste de todos modos.

## Qué te dice realmente el 401

La respuesta que ves es escueta a propósito:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Según [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), un 401 debe llevar un encabezado `WWW-Authenticate` que nombre un challenge, y ASP.NET Core envía `Bearer`. Lo que no envía de forma predeterminada es un motivo. Si el handler se ejecutó y rechazó el token, la causa real es una excepción de `Microsoft.IdentityModel` que el handler se tragó. Si el handler nunca se ejecutó, no hay excepción alguna, solo una política de autorización que no encontró un usuario autenticado y emitió el challenge. Distinguir esos dos casos es todo el juego, y la forma más rápida de hacerlo es hacer que el handler hable (lo cubrimos cerca del final).

Una cosa que descartar de inmediato: un 401 significa "no sabemos quién eres". Un 403 significa "sabemos quién eres, simplemente no tienes permiso". Si estás recibiendo 403, el token se validó bien y tu problema es una comprobación de política o de rol, no de autenticación. No pases una tarde depurando la validación del token por un 403.

## Causa 1: falta UseAuthentication o está después de UseAuthorization

Esta es la causa más común y la más fácil de pasar por alto porque ambas líneas están presentes, solo que en el orden incorrecto. El middleware de autenticación es lo que lee el encabezado `Authorization`, ejecuta el handler de bearer y establece `HttpContext.User`. El middleware de autorización es lo que aplica `[Authorize]`. Si la autorización se ejecuta primero, `HttpContext.User` sigue siendo el predeterminado anónimo, así que cada endpoint protegido emite el challenge con un 401 sin importar lo bueno que sea el token.

```csharp
// .NET 11, C# 14 -- WRONG: authorization runs before the user is set
app.UseAuthorization();
app.UseAuthentication();   // too late, User is already anonymous
```

```csharp
// .NET 11, C# 14 -- correct order
app.UseAuthentication();   // reads the token, populates HttpContext.User
app.UseAuthorization();    // now enforces [Authorize] against a real user
```

La regla es mecánica: `UseAuthentication` antes de `UseAuthorization`, y ambos después de `UseRouting` (en el modelo moderno de hosting mínimo `UseRouting` se agrega por ti, así que en su mayoría solo necesitas las dos llamadas de auth en el orden relativo correcto). Si eliminaste `UseAuthentication` por completo, quizás mientras refactorizabas, el síntoma es idéntico: un 401 universal en cualquier cosa con `[Authorize]`. Vuélvelo a agregar primero antes de tocar cualquier otra cosa.

## Causa 2: no hay un esquema de autenticación predeterminado registrado

Un atributo `[Authorize]` sin un esquema nombrado usa el *esquema de autenticación predeterminado*. Si nunca le dijiste a `AddAuthentication` cuál es ese predeterminado, no hay esquema que ejecutar, el usuario permanece anónimo y obtienes un 401. Esto hace tropezar a la gente porque el registro *parece* completo:

```csharp
// .NET 11, C# 14 -- WRONG: no default scheme, [Authorize] has nothing to run
builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`AddAuthentication()` sin argumento registra los servicios pero no establece ningún esquema predeterminado. La solución es pasar el nombre del esquema como predeterminado, que es exactamente bajo el cual se registra `AddJwtBearer` cuando no lo nombras:

```csharp
// .NET 11, C# 14 -- correct: "Bearer" becomes the default scheme
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`JwtBearerDefaults.AuthenticationScheme` es la cadena `"Bearer"`. Pasarla a `AddAuthentication` establece `DefaultAuthenticateScheme` y `DefaultChallengeScheme` en `"Bearer"` de una sola vez, así que un `[Authorize]` sin más ahora sabe que debe ejecutar el handler de bearer. Si prefieres ser explícito, establece las propiedades directamente:

```csharp
// .NET 11, C# 14 -- the explicit form, equivalent to the above
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options => { /* ... */ });
```

## Causa 3: el nombre del esquema no coincide

En el momento en que le das a `AddJwtBearer` un nombre de esquema personalizado, te has salido del predeterminado y ahora tienes que pedir ese esquema por nombre en todas partes. Esta es la segunda trampa más común de "token válido, aun así 401", y es astuta porque la configuración por lo demás es perfecta.

```csharp
// .NET 11, C# 14 -- registers the handler under "MyApi", not "Bearer"
builder.Services.AddAuthentication()
    .AddJwtBearer("MyApi", options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

```csharp
// .NET 11, C# 14 -- a bare [Authorize] looks for the default scheme,
// which is unset, so the "MyApi" handler never runs -> 401
[Authorize]
public class OrdersController : ControllerBase { /* ... */ }
```

Tienes dos salidas. O haces que `"MyApi"` sea el predeterminado para que un `[Authorize]` sin más lo encuentre, o nombras el esquema en cada atributo que deba usarlo:

```csharp
// .NET 11, C# 14 -- option A: make the named scheme the default
builder.Services.AddAuthentication("MyApi")
    .AddJwtBearer("MyApi", options => { /* ... */ });

// .NET 11, C# 14 -- option B: ask for the scheme by name
[Authorize(AuthenticationSchemes = "MyApi")]
public class OrdersController : ControllerBase { /* ... */ }
```

Esto importa más cuando genuinamente ejecutas más de un esquema, digamos un esquema de bearer para tu API más cookies para un área de administración renderizada en el servidor. Con varios esquemas no hay un único predeterminado sensato, así que los endpoints de bearer deben deletrear `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. Sáltate eso y la solicitud se valida contra cualquier esquema que resulte ser el predeterminado, que no es el tuyo, y el token se ignora.

## Causa 4: el encabezado nunca llegó al handler

Si el handler se ejecutó, no encontró ningún encabezado `Authorization` (o uno mal formado), no puede autenticar a nadie y obtienes un 401 que no tiene nada que ver con el contenido del token. El token en tu pestaña de Postman es válido; simplemente no está llegando de la forma que crees.

El formato es estricto. El valor del encabezado debe ser la palabra literal `Bearer`, un espacio y luego el token en bruto, sin comillas y sin confusión entre `Basic`/`Bearer`:

```text
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

Formas comunes en que esto sale mal en la práctica:

- **El cliente nunca lo adjunta.** Un `HttpClient` tipado cuyo `DefaultRequestHeaders.Authorization` se estableció en una instancia de cliente *diferente*, o una llamada fetch que olvidó el encabezado en los reintentos. Registra los encabezados entrantes en el servidor para ver qué llegó realmente.
- **Se está rechazando un preflight de CORS, no tu solicitud real.** Un navegador envía un preflight `OPTIONS` sin encabezado `Authorization` antes de la llamada real. Si CORS está mal configurado, el navegador bloquea la solicitud real y tu pestaña de red muestra lo que parece un fallo de autenticación. La solución está del lado de CORS, no del token: consulta [cómo configurar CORS para una API protegida con JWT](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) para conocer el orden correcto del middleware y la política.
- **Un proxy inverso o balanceador de carga lo elimina.** Algunos proxies descartan `Authorization` al reenviar a menos que se les indique explícitamente que lo preserven. Si funciona localmente y devuelve 401 solo detrás de nginx, IIS o un ingress controller, sospecha esto primero.
- **Un explorador de API lo está descartando.** Swagger UI y Scalar enviarán solicitudes silenciosamente sin el token si su integración de auth no está cableada. Si tu `curl` funciona pero la interfaz de la documentación no, esa es la señal, cubierto en [por qué tu token de bearer se ignora en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

## Haz que el handler te diga por qué

Deja de adivinar. Cablea `JwtBearerEvents` para que el handler registre el resultado real, y entonces sabrás en una sola solicitud si se ejecutó siquiera y, de ser así, qué comprobación falló.

```csharp
// .NET 11, C# 14
.AddJwtBearer(options =>
{
    options.Authority = "https://login.example.com";
    options.Audience = "api://my-api";

    options.Events = new JwtBearerEvents
    {
        OnAuthenticationFailed = ctx =>
        {
            // Fires only if the handler RAN and the token was rejected.
            // ctx.Exception carries the IDX code (expired, bad audience, etc.)
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning(ctx.Exception, "JWT rejected");
            return Task.CompletedTask;
        },
        OnChallenge = ctx =>
        {
            // Fires whenever a 401 is about to be sent, INCLUDING the
            // "no token / handler never validated anything" case.
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning("JWT challenge: {Error} {Desc}",
                ctx.Error, ctx.ErrorDescription);
            return Task.CompletedTask;
        },
        OnTokenValidated = ctx =>
        {
            // Fires when a token validated successfully. If you see THIS
            // and still get a 401, the problem is authorization, not auth.
            return Task.CompletedTask;
        },
    };
});
```

El árbol de decisión que esto te da es preciso. Si `OnAuthenticationFailed` se dispara, el handler se ejecutó y rechazó un token real; lee `ctx.Exception` para el código `IDX` y salta a la [guía de validación de tokens](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Si solo `OnChallenge` se dispara sin un fallo previo, el handler nunca tuvo un token que validar, así que estás ante las causas 1 a 4 de arriba, no ante el token. Si `OnTokenValidated` se dispara y *aun así* obtienes un no-200, tienes un problema de autorización con forma de 403 disfrazado de 401, y ninguna cantidad de ajustes al token ayudará.

Puedes obtener la misma señal sin código subiendo la categoría de registro en `appsettings.Development.json`:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Authentication": "Debug"
    }
  }
}
```

Eso hace aparecer líneas como "Bearer was not authenticated. Failure message: ..." directamente en la consola, lo cual por sí solo resuelve la mayoría de estos casos en menos de un minuto.

## Un token confiable y conocido como bueno para probar

La mitad del tiempo dedicado a este error es duda sobre si el token es realmente válido. Elimina la duda con la herramienta `dotnet user-jwts`, que acuña un token firmado con una clave que también cablea en tu configuración de desarrollo, de modo que la validación no puede fallar por una clave que no coincide:

```bash
# .NET 11 SDK -- creates a local-dev JWT and configures the app to accept it
dotnet user-jwts create
```

Si un token de `user-jwts` autentica pero el token de tu proveedor real no, las claims del token o la clave de firma son la diferencia y has vuelto a los parámetros de validación. Si incluso el token de `user-jwts` devuelve 401, el token nunca fue el problema, y una de las cuatro causas de cableado de arriba sí lo es. Ese único experimento divide el espacio de búsqueda limpiamente por la mitad.

## Diagnostícalo en orden

Cuando un token válido devuelve 401, trabaja esta lista de verificación de arriba abajo. Los primeros pasos atrapan la abrumadora mayoría, así que no te saltes adelante.

1. **Confirma que es un 401, no un 403.** Un 403 significa que la autenticación ya tuvo éxito; detente aquí y revisa tus políticas de autorización en su lugar.
2. **Revisa el orden del middleware.** `app.UseAuthentication()` debe estar presente y debe ir antes de `app.UseAuthorization()`. Esto por sí solo arregla la mayoría de los casos.
3. **Revisa el esquema predeterminado.** O pasa `JwtBearerDefaults.AuthenticationScheme` a `AddAuthentication`, o establece `DefaultAuthenticateScheme` explícitamente. Un `AddAuthentication()` sin más con un `[Authorize]` sin más no puede funcionar.
4. **Revisa el nombre del esquema.** Si nombraste el esquema en `AddJwtBearer("X")`, o haces que `"X"` sea el predeterminado o usas `[Authorize(AuthenticationSchemes = "X")]` en todas partes.
5. **Confirma que el encabezado llega.** Registra los encabezados de la solicitud entrante en el servidor. Verifica la forma exacta de `Authorization: Bearer <token>`, y descarta que un proxy o un preflight de CORS se lo esté comiendo.
6. **Acuña un token con `dotnet user-jwts` y reintenta.** Si ese autentica, las claims o la clave de tu token real son el problema; pasa a la [guía de parámetros de validación](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Si también devuelve 401, el cableado sigue mal; vuelve a revisar los pasos 2 a 4.
7. **Activa el registro de depuración de `Microsoft.AspNetCore.Authentication`** o cablea `JwtBearerEvents` y lee qué evento se dispara. Eso te dice definitivamente si el handler se ejecutó.

## La única distinción que termina la búsqueda

Cada "token válido pero 401" se reduce a una sola pregunta: ¿se ejecutó el handler de bearer y rechazó el token, o nunca tuvo la oportunidad de ejecutarse? Los parámetros de validación, `ClockSkew`, las discrepancias de emisor y audiencia, todos viven en la primera rama, y solo importan si `OnAuthenticationFailed` se dispara. El orden del middleware, el esquema predeterminado, el nombre del esquema y un encabezado faltante, todos viven en la segunda rama, donde no hay ningún fallo de validación que encontrar porque no había nada que validar. Haz que el handler emita una sola línea de registro y habrás respondido la pregunta; a partir de ahí la solución es mecánica. Cuando vayas a bloquear los endpoints, agrupar las rutas protegidas con [MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) mantiene el requisito del esquema en un solo lugar en vez de esparcido por cada `[Authorize]`, que es como la discrepancia del nombre del esquema se cuela en primer lugar.

## Fuentes

- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn, incluido el desglose de 401 vs 403 y la guía del esquema predeterminado.
- [Authorize with a specific scheme in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/limitingidentitybyscheme), Microsoft Learn, sobre `[Authorize(AuthenticationSchemes = ...)]`.
- [RFC 9110, section 15.5.2](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), que requiere el encabezado `WWW-Authenticate` en un 401.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
