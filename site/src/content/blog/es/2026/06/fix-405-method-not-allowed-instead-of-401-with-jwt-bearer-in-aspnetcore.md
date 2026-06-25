---
title: "Solución: 405 Method Not Allowed en lugar de 401 con JWT bearer en ASP.NET Core"
description: "Un endpoint protegido que devuelve 405 en lugar de 401 casi siempre significa que el enrutamiento rechazó el verbo HTTP antes de que corriera la autenticación, o que un esquema de cookies robó el challenge. Aquí te explico cómo distinguirlo."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "es"
translationOf: "2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-25
---

Agregaste `[Authorize]` (o `RequireAuthorization()`) a un endpoint, enviaste una solicitud sin token esperando un `401 Unauthorized` limpio y, en cambio, obtuviste `405 Method Not Allowed`. El 405 es engañoso: casi nunca significa que tu autenticación esté rota. Significa que la solicitud nunca llegó a la etapa de autorización, porque el enrutamiento de endpoints rechazó el verbo HTTP primero y cortocircuitó con un 405, o, con menos frecuencia, un esquema de autenticación por cookies es el challenge predeterminado y respondió en lugar del handler de JWT bearer. La solución para el caso común es enviar el verbo que el endpoint realmente mapea (`POST` a un `MapPost`, no `GET`); la solución para el caso del esquema es establecer `DefaultChallengeScheme` al esquema bearer. Este post usa .NET 11 con `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0 y C# 14, pero el comportamiento del enrutamiento es idéntico hasta .NET 6.

## El error en contexto

```text
HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Length: 0
```

Ese encabezado `Allow` es la pista. Una falla de autenticación genuina devuelve:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Si ves `Allow` y no `WWW-Authenticate`, el enrutamiento produjo esta respuesta, no el handler de JWT bearer. Si ves `WWW-Authenticate: Bearer`, el handler corrió y tienes un problema real de autenticación, lo cual es otro post: [por qué tu JWT devuelve 401 incluso con un token válido](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) cubre ese camino.

## Por qué el enrutamiento gana antes de que corra la autorización

El pipeline de ASP.NET Core está ordenado. En una app por defecto de minimal API o de controladores se ve así:

```csharp
// .NET 11, ASP.NET Core 11.0.0
var app = builder.Build();

app.UseRouting();        // 1. selects the endpoint (including method matching)
app.UseAuthentication(); // 2. reads the token, sets HttpContext.User
app.UseAuthorization();  // 3. enforces [Authorize] on the selected endpoint

app.MapControllers();
app.Run();
```

`UseRouting` corre primero. El enrutamiento hace coincidir según la ruta de la solicitud *y* el método HTTP. Cuando una ruta coincide con una ruta registrada pero el método no, el enrutamiento no cae a "ningún endpoint." Selecciona un endpoint sintético integrado producido por `HttpMethodMatcherPolicy`, cuyo único trabajo es devolver `405 Method Not Allowed` con un encabezado `Allow` que lista los verbos que *sí* están mapeados para esa ruta. Consulta la [documentación de fundamentos de enrutamiento](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) para ver cómo las políticas de matcher alimentan la selección de endpoints.

Ese endpoint sintético de 405 no lleva metadatos de autorización. Así que cuando `UseAuthorization` mira el endpoint seleccionado, no encuentra nada que aplicar, deja pasar la solicitud, y el 405 se escribe en la respuesta. Tu acción decorada con `[Authorize]` nunca fue candidata, porque el verbo la eliminó durante la coincidencia. La autorización literalmente no puede correr sobre un endpoint que el enrutamiento no seleccionó.

Por eso agregar `[Authorize]` parece "causar" el 405: no lo causa. El 405 ya estaba ahí antes de que agregaras la autenticación, solo que no lo estabas mirando, porque sin `[Authorize]` un `GET` a un endpoint que solo acepta `POST` también devuelve 405. Agregar `[Authorize]` cambia tu *expectativa* a 401, lo cual expone el desajuste de verbo que ya tenías.

## Reproducción mínima

```csharp
// .NET 11, C# 14, ASP.NET Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(); // appsettings supplies Authority/Audience

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

// Only POST is mapped for /orders
app.MapPost("/orders", () => Results.Ok())
   .RequireAuthorization();

app.Run();
```

Ahora llámalo con el verbo incorrecto y sin token:

```bash
curl -i http://localhost:5000/orders        # implicit GET
# HTTP/1.1 405 Method Not Allowed
# Allow: POST
```

Hay un endpoint `POST /orders`, así que la ruta coincide, pero `GET` no está permitido, así que el enrutamiento devuelve 405. Esperabas 401 porque olvidaste que el endpoint solo acepta `POST`. Envía el verbo correcto y aparece el 401 que querías:

```bash
curl -i -X POST http://localhost:5000/orders
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
```

## Solución 1: envía el verbo que el endpoint mapea (la causa habitual)

Nueve de cada diez veces el error está en quien llama. El front-end, la colección de Postman, o el test de integración está usando un verbo que la ruta no mapea. Verifica, en orden:

1. **El método HTTP en la solicitud.** Un `fetch` que por defecto usa `GET` contra un `MapPost`, un formulario haciendo posting donde la API espera `PUT`, o un cliente golpeando `/api/orders` con `GET` cuando el endpoint de lectura es en realidad `/api/orders/{id}`. El encabezado `Allow` te dice exactamente qué verbos soporta la ruta, así que léelo.
2. **El atributo de verbo en la acción.** En controladores, una acción con `[Route("orders")]` pero sin `[HttpPost]` no responde a cada verbo de la forma que podrías suponer bajo enrutamiento por atributos. Fija el verbo explícitamente con `[HttpPost("orders")]` para que un `GET` a la misma ruta produzca un 405 deliberado, no una sorpresa.
3. **Plantillas de ruta que colisionan.** Dos endpoints en la misma ruta con verbos diferentes están bien. Pero un `MapGet("/orders/{id}")` y un `MapPost("/orders")` son rutas diferentes; un `POST /orders/5` no coincide limpiamente con ninguna y puedes obtener un 405 o un 404 dependiendo de la plantilla. Usa `MapGroup` para mantener los verbos de un prefijo visibles en un solo lugar: [organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) muestra el patrón.

Si quieres que un recurso protegido responda 401 para *cada* verbo que un cliente pueda intentar, incluyendo los no mapeados, tienes que mapear un catch-all. Eso rara vez es lo que quieres, pero es posible con `MapMethods` cubriendo los verbos que te importan más un fallback.

## Solución 2: evita que un esquema de cookies responda el challenge

La segunda causa aparece cuando combinas ASP.NET Core Identity (que registra autenticación por cookies) con JWT bearer y nunca estableces un predeterminado explícito. Como se documenta en este [hilo de Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u), el challenge entonces corre a través del handler de cookies de Identity en lugar del handler bearer. El challenge del handler de cookies es una redirección a una página de login, y cuando esa ruta de login no acepta el verbo de la solicitud original, terminas en un 405 en lugar del 401 del bearer.

La solución es ser explícito sobre qué esquema autentica y qué esquema hace el challenge:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidAudience = builder.Configuration["Jwt:Audience"],
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!))
    };
});
```

Con `DefaultChallengeScheme` establecido al esquema bearer, una solicitud no autenticada obtiene `401 Unauthorized` con `WWW-Authenticate: Bearer`, no una redirección de cookie que degenera en un 405. Si legítimamente tienes ambos esquemas y algunos endpoints deberían usar bearer específicamente, nombra el esquema en el atributo en lugar de depender del predeterminado: `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. La misma trampa de desajuste de esquema es la causa raíz detrás de muchos [tokens válidos que aun así devuelven 401](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/), así que vale la pena dejar los predeterminados bien una sola vez.

## Confirmar qué causa tienes con los logs

No tienes que adivinar. Sube el nivel de logging para el enrutamiento y la autorización y la fuente de la respuesta se vuelve obvia:

```json
// appsettings.Development.json - .NET 11
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Routing": "Debug",
      "Microsoft.AspNetCore.Authentication": "Debug",
      "Microsoft.AspNetCore.Authorization": "Debug"
    }
  }
}
```

Si el verbo es incorrecto, verás el enrutamiento seleccionar el endpoint de method-not-allowed y *ninguna* línea de log de autenticación, porque el handler nunca corrió:

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher
      Endpoint selection: 405 HTTP Method Not Supported
```

Si un esquema de cookies está haciendo el challenge, verás el handler de cookies nombrado explícitamente:

```text
dbug: Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationHandler
      AuthenticationScheme: Identity.Application was challenged.
```

Esa única línea te dice que el handler bearer no es tu esquema de challenge predeterminado, lo cual apunta directo a la Solución 2.

## Trampas y casos parecidos

**El preflight de CORS devuelve 405.** Un navegador envía un preflight `OPTIONS` antes de un `POST` o `PUT` de origen cruzado. Si nunca llamaste a `app.UseCors(...)` con una política que permita el método, el enrutamiento no tiene endpoint `OPTIONS` para la ruta y responde 405, lo que el navegador muestra como una falla de CORS. La solución es configurar CORS, no la autenticación: [configurar CORS para una API protegida con JWT](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) recorre la política y el orden del middleware. Nota que el preflight `OPTIONS` es intencionalmente no autenticado; no pongas `[Authorize]` delante de él.

**Solicitudes HEAD a un endpoint que solo acepta GET.** `MapGet` no responde automáticamente a `HEAD`. Un health check o un CDN sondeando con `HEAD` contra una ruta `MapGet` obtiene 405. Mapea ambos verbos con `app.MapMethods("/health", new[] { "GET", "HEAD" }, handler)` según la [documentación de route handlers](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers). Esto es un desajuste de verbo, no un problema de autenticación.

**403 no es 405.** Si te autenticaste con éxito pero te falta un rol requerido o un claim de política, obtienes `403 Forbidden`, no 405 ni 401. Un 403 significa que el token se validó y el handler corrió; tu problema es una verificación de política o de rol, cubierta cuando [validas el issuer, audience y lifetime de un JWT](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) y los claims que lleva.

**Un middleware personalizado que cortocircuita antes del enrutamiento.** Si escribiste un middleware que corre antes de `UseRouting` y escribe un 405 (por ejemplo, un allowlist de métodos hecho a mano), enmascarará todo lo que esté aguas abajo. Cualquier cosa que llame a `context.Response.StatusCode = 405` antes del enrutamiento produce este síntoma sin un encabezado `Allow` del matcher.

La idea central: el 405 es un estado de *enrutamiento* en ASP.NET Core, decidido antes de que la autenticación y la autorización siquiera miren la solicitud. Cuando esperabas 401 y obtuviste 405, empieza por el verbo y el encabezado `Allow`, no por tu token. Reserva la depuración de autenticación para el caso en que realmente veas `WWW-Authenticate: Bearer`.

## Relacionados

- [Por qué tu JWT de ASP.NET Core devuelve 401 incluso con un token válido](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Cómo validar el issuer, audience y lifetime de un JWT en ASP.NET Core 11](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Cómo configurar CORS para una API protegida con JWT en ASP.NET Core 11](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)

## Fuentes

- [ASP.NET Core routing fundamentals](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) - coincidencia de endpoints y políticas de matcher de métodos
- [Route handlers in minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) - `MapMethods`, HEAD y OPTIONS
- [Microsoft Q&A: 405 Method Not Allowed instead of 401 with JWT](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) - la causa y solución del esquema predeterminado de cookies
- [RFC 9110, sección 15.5.6 (405 Method Not Allowed)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.6) y [15.5.2 (401 Unauthorized)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)
