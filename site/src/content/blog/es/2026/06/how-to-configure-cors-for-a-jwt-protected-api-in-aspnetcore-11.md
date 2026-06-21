---
title: "Cómo configurar CORS para una API protegida con JWT en ASP.NET Core 11"
description: "Una guía completa de CORS para una API con token bearer en ASP.NET Core 11: el orden correcto de UseCors respecto a la autenticación, por qué un token bearer en el encabezado Authorization no es una credencial de CORS, por qué AllowAnyHeader funciona pero un comodín manual no cubre Authorization, y cómo evitar que falle el preflight."
pubDate: 2026-06-21
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "cors"
  - "jwt"
  - "security"
lang: "es"
translationOf: "2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Si tu aplicación de página única llama a una API de ASP.NET Core protegida con JWT desde un origen distinto y la consola del navegador muestra "No 'Access-Control-Allow-Origin' header is present" o "Request header field authorization is not allowed", la solución casi nunca está del lado de la autenticación. Necesitas una política de CORS que nombre el origen de tu front-end con `WithOrigins`, permita el encabezado de solicitud `Authorization` y ejecute `app.UseCors(...)` *antes* de `app.UseAuthentication()` y `app.UseAuthorization()`. Lo que la mayoría de las guías se equivocan: un token bearer que tú mismo colocas en el encabezado `Authorization` **no** es una credencial de CORS, así que **no** necesitas `AllowCredentials()` para una API JWT basada en encabezados, y agregarlo te obliga a renunciar a `AllowAnyOrigin` sin ningún beneficio. Este artículo apunta a .NET 11 (preview 5 al momento de escribir), pero las API de CORS y de JWT bearer no han cambiado desde .NET 8, 9 y 10.

## CORS y JWT son dos puertas no relacionadas que fallan al mismo tiempo

Una solicitud de origen cruzado desde `https://app.example.com` hacia `https://api.example.com` pasa por dos verificaciones completamente independientes, y confundirlas es la raíz de casi todas las tardes perdidas aquí.

La primera es CORS. La aplica el navegador, no tu servidor. El navegador decide si JavaScript *puede leer la respuesta* según los encabezados `Access-Control-Allow-*` que envía tu servidor. CORS no sabe nada de quién eres. Solo le importan los orígenes, los métodos y los encabezados de solicitud.

La segunda es la autenticación. El controlador de JWT bearer de ASP.NET Core valida el token en el encabezado `Authorization` y produce un 401 o un `ClaimsPrincipal`. No sabe nada de orígenes.

La trampa es que una política de CORS mal configurada y un token ausente producen errores que se parecen en DevTools. Un 401 sin encabezados de CORS aparece en la consola como un fallo de CORS, porque el navegador descarta la respuesta antes de que tu código pueda verla. Así que pasas una hora con el token cuando el problema real es el orden de la política, o al revés. Mantén las dos puertas separadas en tu cabeza: CORS decide si el navegador te entrega los bytes, la autenticación decide si el servidor los produjo.

## Un token bearer en el encabezado Authorization no es una "credencial" de CORS

Este es el punto peor entendido, y hacerlo bien simplifica todo lo demás.

En la especificación de CORS, "credenciales" significa tres cosas específicas: cookies, certificados de cliente TLS y el encabezado `Authorization` *que el agente de usuario rellena automáticamente* a partir de una autenticación HTTP almacenada. Cuando escribes `fetch(url, { headers: { Authorization: "Bearer " + token } })`, estás estableciendo un encabezado de solicitud definido por el autor. Eso no es una solicitud con credenciales. El modo `credentials` de ese fetch sigue siendo el valor predeterminado `"same-origin"`, que para una llamada de origen cruzado significa "no enviar cookies".

La consecuencia: para una SPA típica que guarda su JWT en memoria o en `localStorage` y lo adjunta manualmente, **no** deberías llamar a `AllowCredentials()`. Solo lo necesitas cuando el token (o un token de actualización, o una sesión) viaja en una cookie, porque las cookies son credenciales reales de CORS y el navegador no las enviará en origen cruzado a menos que la respuesta diga `Access-Control-Allow-Credentials: true`.

¿Por qué importa esto más allá de la pedantería? Porque `AllowCredentials()` es incompatible con `AllowAnyOrigin()`. En el momento en que agregas credenciales, la especificación de CORS prohíbe el comodín de origen `*`, y ASP.NET Core lo aplica lanzando una excepción al iniciar:

```csharp
// .NET 11, C# 14
// This throws ArgumentException at app build time:
// "The CORS protocol does not allow specifying a wildcard (any) origin
//  and credentials at the same time."
options.AddPolicy("bad", policy => policy
    .AllowAnyOrigin()
    .AllowCredentials());
```

Así que si agregas `AllowCredentials()` por reflejo en una API bearer basada en encabezados, has asumido la restricción de fijar orígenes sin ninguno de los beneficios. Déjalo fuera a menos que realmente uses cookies.

## La política que funciona

Aquí está la configuración completa y correcta para una API mínima que valida JWT y es llamada desde uno o varios orígenes de front-end conocidos. Si todavía estás eligiendo entre las API mínimas y el modelo MVC, las ventajas y desventajas se cubren en [API mínimas vs. controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); CORS es idéntico en ambos casos.

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

const string SpaCors = "spa";

builder.Services.AddCors(options =>
{
    options.AddPolicy(SpaCors, policy => policy
        .WithOrigins("https://app.example.com", "http://localhost:5173")
        .WithHeaders("Authorization", "Content-Type")
        .WithMethods("GET", "POST", "PUT", "DELETE")
        .SetPreflightMaxAge(TimeSpan.FromMinutes(10)));
});

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
        // TokenValidationParameters tuned for your issuer here.
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Order is load-bearing. See the next section.
app.UseCors(SpaCors);
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Tres decisiones deliberadas en esa política:

- `WithOrigins` lista orígenes exactos, esquema y puerto incluidos. `http://localhost:5173` y `https://localhost:5173` son orígenes distintos, y también lo es el mismo host en un puerto diferente.
- `WithHeaders("Authorization", "Content-Type")` permite los dos encabezados de solicitud que una llamada JSON+JWT realmente envía. `Content-Type: application/json` no es un valor incluido en la lista segura de CORS, así que dispara el preflight por sí solo.
- `WithMethods` lista los verbos que expone la API. Un `PUT` o `DELETE` siempre dispara el preflight.

Sin `AllowCredentials()`, porque esta es una API bearer basada en encabezados.

## Por qué UseCors tiene que ejecutarse antes de UseAuthentication

El orden del middleware no es estético. `app.UseCors(...)` debe ir después de `UseRouting` (que `WebApplication` llama de forma implícita) y **antes** de `UseAuthentication` y `UseAuthorization`. La [documentación de CORS](https://learn.microsoft.com/en-us/aspnet/core/security/cors) de Microsoft establece la regla; aquí está lo que realmente se rompe si la ignoras.

Un preflight de CORS es una solicitud `OPTIONS`, y el navegador la envía **sin** el encabezado `Authorization`. Eso es por diseño: el preflight pregunta "¿puedo hacer esta solicitud?" antes de que se adjunte cualquier credencial. Si la autenticación o una verificación de `[Authorize]`/`RequireAuthorization` se ejecuta antes del middleware de CORS, la solicitud `OPTIONS` sin autenticar recibe un 401, el navegador nunca recibe los encabezados `Access-Control-Allow-*` y la solicitud real nunca se envía. Verás un fallo de preflight en la pestaña Network y concluirás, erróneamente, que tu token está mal.

Con `UseCors` colocado primero, el middleware de CORS reconoce el preflight, lo responde con un 204 y los encabezados correctos, y corta el circuito antes de que la autenticación se ejecute. El `GET`/`POST` real que sigue lleva el token y fluye por la autenticación con normalidad.

El mismo orden también soluciona el problema del "401 sin encabezados de CORS" para las solicitudes reales. Cuando falta un token o ha expirado, *quieres* que el 401 siga llevando `Access-Control-Allow-Origin` para que el navegador exponga la respuesta y tu SPA pueda leer el estado y redirigir al inicio de sesión. Eso solo ocurre si CORS se ejecuta antes del middleware de autenticación que produce el 401. Esta brecha exacta fue objeto de un problema de larga data en ASP.NET Core ([dotnet/aspnetcore#16584](https://github.com/dotnet/aspnetcore/issues/16584)) y el orden es la resolución.

## La trampa del comodín en el encabezado Authorization

Esta golpea a quienes intentan ser permisivos en desarrollo y luego ajustan. Según el [estándar Fetch](https://fetch.spec.whatwg.org/), y documentado en [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), el comodín en `Access-Control-Allow-Headers: *` **no** cubre el encabezado `Authorization`. El navegador trata a `Authorization` como especial: debe nombrarse explícitamente, o el preflight de cualquier solicitud que lleve un token bearer falla con "Request header field authorization is not allowed by Access-Control-Allow-Headers".

Así que si implementas CORS a mano en un middleware personalizado con un literal `Access-Control-Allow-Headers: *`, tus llamadas JWT se rompen aunque el comodín parezca permitir todo.

Aquí está la parte tranquilizadora para los usuarios de ASP.NET Core: el `AllowAnyHeader()` integrado **no** emite un literal `*`. El `CorsService` devuelve exactamente los encabezados que el navegador pidió en `Access-Control-Request-Headers`, lo que significa que `Authorization` se refleja y el preflight tiene éxito. Puedes verificarlo en el [código fuente de CorsService](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs): el valor de encabezados permitidos proviene de `GetCommaSeparatedValues(CorsConstants.AccessControlRequestHeaders)`, no de un `*` constante.

La regla práctica que se deriva de esto:

- `AllowAnyHeader()` funciona bien para tokens bearer, porque ASP.NET Core refleja en lugar de usar comodín.
- `WithHeaders(...)` funciona solo si incluyes `"Authorization"` en la lista. Olvidarlo es el fallo de CORS autoinfligido más común en una API JWT, porque `Content-Type` por sí solo parece completo y el error de 403/preflight es poco específico.

En caso de duda, lista `Authorization` explícitamente. No cuesta nada y elimina toda una clase de errores.

## Configurarlo correctamente, paso a paso

1. Registra CORS con una política nombrada en `AddCors`, fijando los orígenes de tu front-end con `WithOrigins` (esquema, host y puerto exactos).
2. Permite los encabezados de solicitud que envía tu cliente. Incluye `"Authorization"` y `"Content-Type"` explícitamente con `WithHeaders`, o usa `AllowAnyHeader()` y confía en el reflejo de encabezados de ASP.NET Core.
3. Permite los métodos HTTP que exponen tus endpoints con `WithMethods`, incluyendo los verbos (`PUT`, `DELETE`) que siempre disparan el preflight.
4. Decide sobre las credenciales: omite `AllowCredentials()` para un token bearer basado en encabezados; agrégalo solo si hay una cookie involucrada, y en ese caso reemplaza `AllowAnyOrigin` por `WithOrigins` explícito.
5. Coloca `app.UseCors("policy")` después del enrutamiento y antes de `app.UseAuthentication()` y `app.UseAuthorization()`.
6. Aplica la política globalmente con `app.UseCors(...)`, o por endpoint con `.RequireCors("policy")` (o `[EnableCors("policy")]` en los controladores). No mezcles CORS de middleware global con el atributo en la misma aplicación.

## Cookies, tokens de actualización y el caso con credenciales

Si tu diseño guarda el token de acceso en memoria pero almacena un token de actualización en una cookie `HttpOnly` (un patrón común y sólido, consulta [cómo implementar tokens de actualización en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), entonces la llamada de actualización *sí* lleva credenciales y las reglas se invierten:

```csharp
// .NET 11, C# 14
options.AddPolicy("spa-with-cookie", policy => policy
    .WithOrigins("https://app.example.com") // exact origins only, no AllowAnyOrigin
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .AllowCredentials());                    // required so the browser sends the cookie
```

En el cliente, ese endpoint en particular necesita `fetch(url, { credentials: "include" })`. El servidor debe responder con un `Access-Control-Allow-Origin` específico (nunca `*`) y `Access-Control-Allow-Credentials: true`, que es exactamente lo que produce la política anterior. ASP.NET Core sigue reflejando los encabezados permitidos en lugar de usar comodín, así que `Authorization` sigue funcionando también en el caso con credenciales. La conclusión: limita `AllowCredentials()` a la política que realmente toca cookies, no a toda tu API.

## Reducir el ruido del preflight

Cada solicitud de origen cruzado con un método o encabezado no simple paga el costo de un viaje de ida y vuelta de preflight. `SetPreflightMaxAge(TimeSpan.FromMinutes(10))` le dice al navegador que puede almacenar en caché el resultado del preflight, de modo que las llamadas repetidas al mismo endpoint se saltan el salto `OPTIONS`. Los navegadores limitan este valor (Chromium honra hasta dos horas, Firefox hasta 24, y ambos tienen sus propios topes), así que trátalo como una sugerencia y no como una garantía. Aun así vale la pena establecerlo en una API muy parlanchina.

Si solo necesitas un par de orígenes de front-end y la misma política en todas partes, `AddDefaultPolicy` más un `app.UseCors()` sin parámetros es algo menos ceremonioso que una política nombrada. Para una API más grande donde distintos grupos de endpoints tienen reglas diferentes, combina una política nombrada con `.RequireCors(...)` en un `MapGroup`, que encaja de forma natural con la estructura descrita en [organizar endpoints de API mínimas con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Cuando el token se rechaza y CORS no es el problema

Una vez que el preflight pasa y la solicitud real lleva `Access-Control-Allow-Origin`, cualquier 401 restante es un fallo de autenticación genuino, y deberías dejar de mirar CORS. Los sospechosos habituales son un `Audience` o `Authority` que no coinciden, un desfase de reloj en la vida útil del token, o herramientas que descartan el encabezado en silencio. Si una interfaz como Scalar o Swagger envía solicitudes sin el token bearer aunque lo hayas pegado, ese es un problema separado y bien documentado que se cubre en [por qué se ignora tu token bearer en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) y en [agregar flujos de autenticación de OpenAPI a Swagger UI](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

El modelo mental que te mantiene fuera de problemas: CORS es el navegador preguntando "¿está permitida esta llamada de origen cruzado, y puedo leer la respuesta?" y JWT bearer es el servidor preguntando "¿confío en este token?". Configura la política para que nombre tus orígenes y el encabezado `Authorization`, ejecuta `UseCors` antes del middleware de autenticación, omite `AllowCredentials` a menos que haya una cookie en juego, y las dos puertas dejarán de interferir entre sí.

Fuentes: [Enable Cross-Origin Requests (CORS) in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/cors), [Access-Control-Allow-Headers - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), [Fetch Standard - WHATWG](https://fetch.spec.whatwg.org/), [CorsService source - dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs), [aspnetcore#16584 - CORS headers and JWT bearer 401](https://github.com/dotnet/aspnetcore/issues/16584).
