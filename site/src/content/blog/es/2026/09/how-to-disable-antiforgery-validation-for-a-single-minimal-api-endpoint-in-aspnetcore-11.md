---
title: "Cómo desactivar la validación antiforgery en un solo endpoint de formulario de minimal API en ASP.NET Core 11"
description: "Llama a .DisableAntiforgery() en ese único endpoint, o en un MapGroup. En ASP.NET Core 11 eso lo excluye tanto del middleware de tokens como de la nueva comprobación CSRF automática. Matriz medida, trampas de precedencia y alternativas más acotadas."
pubDate: 2026-09-22
template: how-to
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "security"
  - "csrf"
lang: "es"
translationOf: "2026/09/how-to-disable-antiforgery-validation-for-a-single-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Respuesta corta:** encadena `.DisableAntiforgery()` a esa única llamada a `MapPost` (o a un `MapGroup` que contenga solo endpoints de máquina a máquina). En ASP.NET Core 11 esa sola llamada excluye al endpoint de **las dos** capas que pueden rechazar un post de formulario: el middleware `UseAntiforgery()` basado en tokens y la nueva comprobación CSRF automática de origen cruzado que `WebApplication` inyecta por ti. `[RequireAntiforgeryToken(false)]` en el handler hace lo mismo. No recurras al interruptor global `DisableCsrfProtection` para arreglar un endpoint: en una app que nunca llama a `UseAntiforgery()`, convierte cualquier otro endpoint de formulario en un `500`.

Todo lo que sigue se midió con el SDK de .NET 11 RC 1 (`11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1`), con una ejecución en .NET 10.0.10 como comparación. La matriz de solicitudes, las trampas de precedencia y las alternativas más acotadas son la parte que la documentación te deja descubrir por tu cuenta.

## Por qué un endpoint de formulario rechaza solicitudes que no esperabas

Desde .NET 8, cualquier handler de minimal API con un parámetro enlazado desde el formulario (`[FromForm]`, `IFormFile`, `IFormCollection`) recibe metadatos antiforgery automáticamente. Puedes verlo en `RequestDelegateFactory.InferAntiforgeryMetadata`: cuando la fábrica enlaza un parámetro desde el formulario, agrega al endpoint un `IAntiforgeryMetadata` con `RequiresValidation = true`. Nunca escribiste un atributo; el tipo del parámetro lo hizo por ti.

Lo que lee esos metadatos cambió en .NET 11.

- **.NET 8 a 10**: solo `app.UseAntiforgery()` actúa sobre ellos. Si nunca lo llamaste, el middleware de endpoints lanza `InvalidOperationException: Endpoint HTTP: POST /protected contains anti-forgery metadata, but a middleware was not found that supports anti-forgery.` y cada solicitud es un `500`. Si lo llamaste, cada post sin un token válido (y su cookie) es un `400`.
- **.NET 11**: `WebApplication` además inyecta automáticamente un `CsrfProtectionMiddleware` después del enrutamiento (agregado en Preview 6, consulta [ASP.NET Core 11 activa la protección CSRF automática](/es/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)). Lee los mismos metadatos, revisa `Sec-Fetch-Site` y `Origin`, y registra un veredicto en `IAntiforgeryValidationFeature`. Luego el enlazador de formularios aplica ese veredicto con un `400`.

Así que en .NET 11 hay dos formas en que se puede rechazar un post de formulario, y fallan para clientes distintos. El middleware de tokens rechaza todo lo que no traiga token, incluidos curl y los servidores de tu proveedor de pagos. La comprobación CSRF deja pasar a los clientes que no son navegadores, pero rechaza los posts de navegador de origen cruzado: el caso clásico es una página de terceros que te devuelve un formulario HTML por POST (una página de pago alojada, un callback estilo SAML, el formulario "enviar a" de un socio).

## Lo que recibe realmente cada cliente

Construí una app de prueba con cinco endpoints y golpeé cada uno con cuatro formas de solicitud, en cuatro configuraciones del pipeline. "plain" es curl sin encabezados de navegador, "cross-site" envía `Sec-Fetch-Site: cross-site` más un `Origin` ajeno, "same-origin" envía `Sec-Fetch-Site: same-origin`, y "foreign Origin only" imita a un navegador antiguo que envía `Origin` pero no Fetch Metadata.

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
app.MapPost("/protected", ([FromForm] string name) => $"hello {name}");

app.MapPost("/disabled", ([FromForm] string name) => $"hello {name}")
   .DisableAntiforgery();

app.MapPost("/attr",
    [RequireAntiforgeryToken(false)] ([FromForm] string name) => $"hello {name}");

var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => $"hello {name}");

app.MapPost("/manual", async (HttpRequest req) =>
    $"hello {(await req.ReadFormAsync())["name"]}");
```

Pipeline predeterminado de .NET 11 (sin `AddAntiforgery`, sin `UseAntiforgery`), entorno Production:

| Endpoint | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | 200 | **400** | 200 | **400** |
| `/disabled` | 200 | 200 | 200 | 200 |
| `/attr` | 200 | 200 | 200 | 200 |
| `/hooks/payments` | 200 | 200 | 200 | 200 |
| `/manual` | 200 | 200 | 200 | 200 |

Con `builder.Services.AddAntiforgery()` y `app.UseAntiforgery()` (lo que suelen tener las apps Blazor y MVC actualizadas desde .NET 8-10):

| Endpoint | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | **400** | **400** | **400** | **400** |
| `/disabled`, `/attr`, `/hooks/payments` | 200 | 200 | 200 | 200 |

Con `DisableCsrfProtection=true` y sin `UseAntiforgery()`: `/protected` es un **500** para cada solicitud, exactamente igual que .NET 10.0.10 sin `UseAntiforgery()`, que también medí. Los endpoints excluidos se quedan en 200.

Los registros del servidor te dicen qué capa dijo que no. La capa CSRF registra `Cross-origin CSRF protection marked request POST /protected from origin 'https://evil.example' as invalid.` en `Debug` bajo `Microsoft.AspNetCore.Antiforgery.CsrfProtectionMiddleware`, y luego el enlazador registra `Antiforgery validation failed when reading parameter "string name" from the request body as form.` con una `CsrfValidationException` interna. La capa de tokens produce el mismo mensaje del enlazador con una `AntiforgeryValidationException: The required antiforgery cookie ".AspNetCore.Antiforgery.<suffix>" is not present.` interna. En Production el cuerpo de la respuesta está vacío, así que activa `Debug` para `Microsoft.AspNetCore.Http.RequestDelegateFactory` y `Microsoft.AspNetCore.Antiforgery` cuando estés persiguiendo un `400` misterioso.

## Desactívalo en un endpoint, paso a paso

1. Confirma que el endpoint realmente no es un endpoint con cookies de navegador. Los únicos candidatos seguros son llamadores que se autentican de otra forma: un webhook firmado con HMAC, una API key, un bearer token, mTLS. Si el navegador de un usuario con sesión iniciada puede hacer POST ahí y el handler actúa según su identidad de cookie, mantén la protección.
2. Encadena `.DisableAntiforgery()` a ese `MapPost`. Es una extensión sobre cualquier `IEndpointConventionBuilder` en `Microsoft.AspNetCore.Builder`, así que no hace falta ningún `using` extra en un proyecto web.
3. Reemplaza la protección que acabas de quitar con la prueba propia del llamador. Para un webhook codificado como formulario, eso es una comprobación de firma sobre el cuerpo sin procesar, hecha en middleware para que se ejecute antes de que algo enlace el formulario.
4. Vuelve a probar con la forma de solicitud cross-site de arriba (`-H 'Sec-Fetch-Site: cross-site' -H 'Origin: https://other.example'`) y con curl simple, para saber que ambas capas quedaron fuera del camino.

Aquí está todo junto para un proveedor que hace POST de `application/x-www-form-urlencoded` y firma el cuerpo sin procesar con HMAC-SHA256:

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var secret = Encoding.UTF8.GetBytes(app.Configuration["Sms:WebhookSecret"]!);

// Verify the signature over the raw body before anything binds the form.
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/webhooks/sms"), branch =>
    branch.Use(async (ctx, next) =>
    {
        ctx.Request.EnableBuffering();
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        ctx.Request.Body.Position = 0;

        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, ms.ToArray()));
        var actual = ctx.Request.Headers["X-Signature"].ToString();

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual)))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await next(ctx);
    }));

app.MapPost("/webhooks/sms", ([FromForm] SmsStatus status) =>
        Results.Ok($"{status.MessageId}: {status.Status}"))
   .DisableAntiforgery();

app.Run();

record SmsStatus(string MessageId, string Status);
```

Medido: un post firmado correctamente devolvió 200 tanto con curl simple como con los encabezados de navegador cross-site, y una firma incorrecta devolvió 401.

Mi primer borrador ponía esa comprobación en un endpoint filter, y falló con cada solicitud firmada. Para cuando se ejecuta un endpoint filter, el parámetro `[FromForm]` ya se enlazó, el lector de formularios ya vació el stream de la solicitud y `EnableBuffering` en ese punto no tiene nada que almacenar en búfer: el filtro calculó el hash de **0 bytes**. Las comprobaciones de firma sobre el cuerpo sin procesar pertenecen al middleware, que es uno de los casos concretos en [endpoint filters frente a middleware](/es/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/). Un endpoint filter sirve bien para comprobaciones que solo usan encabezados, como una API key.

## La forma con atributo, para handlers que mantienes en métodos

Si tus handlers son métodos estáticos en lugar de lambdas, el atributo se lee mejor y sobrevive a refactorizaciones que muevan el mapeo:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

app.MapPost("/webhooks/payments", PaymentHooks.Handle);

static class PaymentHooks
{
    [RequireAntiforgeryToken(false)]
    public static IResult Handle([FromForm] string eventId) => Results.Ok(eventId);
}
```

`RequireAntiforgeryTokenAttribute` implementa `IAntiforgeryMetadata` directamente, y ambos middlewares le piden al endpoint `GetMetadata<IAntiforgeryMetadata>()`, así que el resultado es idéntico a `.DisableAntiforgery()`. Para controladores MVC el equivalente es `[IgnoreAntiforgeryToken]`; el `AntiforgeryMiddlewareAuthorizationFilter` de .NET 11 respeta el veredicto de cualquiera de los dos middlewares.

## Desactívalo para un grupo de webhooks

Cuando tienes varios callbacks de proveedores, ponlos bajo un mismo prefijo y excluye al grupo una sola vez:

```csharp
// .NET 11 RC 1
var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => Results.Ok());
hooks.MapPost("/sms", ([FromForm] string name) => Results.Ok());
```

Esto mantiene la decisión de seguridad en un solo lugar visible en vez de dispersa entre archivos, que es el principal argumento para [organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) en primer lugar.

## Trampas de precedencia con las que me topé en la prueba

**La exclusión a nivel de grupo gana a la activación a nivel de endpoint.** Esperaba que esto volviera a activar la protección para un endpoint dentro del grupo desactivado:

```csharp
// .NET 11 RC 1: does NOT re-enable validation
hooks.MapPost("/strict", ([FromForm] string name) => $"hello {name}")
     .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

No lo hace. `/hooks/strict` devolvió 200 para la solicitud cross-site en ambos modos del pipeline. La razón está en el propio `DisableAntiforgery`: registra sus metadatos con `builder.Finally(...)`, que se ejecuta después de las convenciones propias del endpoint, y `GetMetadata<T>()` devuelve el último elemento que coincide. El "no requerido" del grupo queda al final y gana. Si un endpoint dentro de un prefijo debe seguir protegido, no desactives a nivel de grupo; desactiva por endpoint, o divide el prefijo en dos grupos.

**El mismo orden de `Finally` es la razón por la que `.DisableAntiforgery()` siempre gana sobre los metadatos inferidos.** El enlazador de formularios agrega `RequiresValidation = true` mientras construye el endpoint; el callback de `Finally` agrega `false` después. No necesitas preocuparte por el orden en que encadenas las llamadas.

**Los handlers que leen el formulario a mano no reciben ninguna protección.** El endpoint `/manual` de arriba lee `req.ReadFormAsync()` sin un parámetro enlazado desde el formulario, así que no se infieren metadatos y ningún middleware lo revisa: los posts cross-site recibieron un 200 en todos los modos. Si quieres protección ahí, tienes que activarla con `.WithMetadata(new RequireAntiforgeryTokenAttribute())`. Pero entonces cambia el modo de fallo: cuando el veredicto es inválido, `FormFeature` se niega a leer el cuerpo y lanza `InvalidOperationException: This form is being accessed with a failed antiforgery validation. Validate the IAntiforgeryValidationFeature on the request before reading from the form.`, que es un 500, no un 400. Revisa tú mismo la feature primero:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/manual-protected", async (HttpContext ctx) =>
    {
        if (ctx.Features.Get<IAntiforgeryValidationFeature>() is { IsValid: false })
            return Results.BadRequest();

        var form = await ctx.Request.ReadFormAsync();
        return Results.Ok(form["name"].ToString());
    })
    .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

**`DisableCsrfProtection` no es una herramienta por endpoint.** Elimina el middleware inyectado automáticamente para toda la app. Ese middleware también es lo que satisface la comprobación "a middleware was not found that supports anti-forgery" en las apps que nunca llaman a `UseAntiforgery()`, así que activar el interruptor para arreglar un webhook rompe cualquier otro endpoint de formulario con un 500 (medido arriba). La documentación lo llama una vía de escape; trátalo como tal.

## Alternativas más acotadas antes de desactivar nada

Desactivar es lo correcto para llamadas firmadas de servidor a servidor. Para el tráfico de navegador hay dos opciones más estrictas.

**Confía en un llamador específico de origen cruzado mediante CORS.** La implementación predeterminada de `ICsrfProtection` consulta la política CORS que aplica al endpoint: si el `Origin` de la solicitud está permitido por una política con nombre o por la predeterminada, el post se acepta aunque `Sec-Fetch-Site` sea `cross-site`. `AllowAnyOrigin` se ignora deliberadamente.

```csharp
// .NET 11 RC 1
builder.Services.AddCors(o => o.AddPolicy("partner",
    p => p.WithOrigins("https://pay.partner.example")));

var app = builder.Build();
app.UseCors();

app.MapPost("/partner-callback", ([FromForm] string orderId) => Results.Ok(orderId))
   .RequireCors("partner");
```

Medido en el pipeline predeterminado: el origen del socio obtuvo 200, un origen ajeno y un subdominio hermano `same-site` siguieron obteniendo 400, y curl simple obtuvo 200. Dos advertencias. Sin `app.UseCors()` el endpoint lanza `contains CORS metadata, but a middleware was not found that supports CORS` (500). Y esto solo relaja la capa de Fetch Metadata: con `UseAntiforgery()` en el pipeline, la validación de tokens se ejecuta después, sobrescribe el veredicto, y el post del socio volvió a ser un 400. Si ya combinas CORS con cookies o JWT, el artículo sobre [la configuración de CORS para una API protegida con JWT](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) cubre el lado de la política.

**Deja que el framework maneje los callbacks del proveedor de identidad.** Los callbacks de OpenID Connect `response_mode=form_post` y de WS-Federation son posts de formulario cross-site por diseño. En .NET 11 los handlers de autenticación remota suprimen un veredicto inválido mientras son dueños de la ruta del callback (`RemoteAuthenticationAntiforgery` en el código fuente), porque el parámetro `state` y la cookie de correlación ya los protegen. No necesitas `.DisableAntiforgery()` en `/signin-oidc`, y de todos modos no podrías ponerlo ahí, ya que el handler es middleware, no un endpoint.

## Problemas al actualizar desde .NET 8, 9 o 10

- **Las apps que ya llaman a `UseAntiforgery()` no ven ningún cambio en el tráfico del mismo origen**, porque la validación de tokens es la que manda y sobrescribe el veredicto CSRF. Las llamadas a `.DisableAntiforgery()` que ya tienes siguen funcionando sin cambios.
- **Las apps que nunca llamaron a `UseAntiforgery()` dejan de lanzar 500** en los endpoints de formulario en .NET 11 (el middleware CSRF satisface la comprobación del endpoint), pero empiezan a devolver 400 a los posts de navegador de origen cruzado. Eso puede parecer una regresión aleatoria en un formulario al que un subdominio hermano le hace POST, ya que `same-site` también se rechaza.
- **Un 400 de un endpoint de formulario no siempre es antiforgery.** Un `Content-Type` ausente o incorrecto da un [415 Unsupported Media Type](/es/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/), y los errores en la forma del enlace dan nulls, como en [el diccionario `[FromForm]` que siempre es null](/es/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/). Revisa la categoría del registro antes de desactivar nada.
- **Los errores de token después de una implementación son otro bug.** Si los formularios del mismo origen fallan solo después de escalar horizontalmente o reiniciar, lo que estás viendo son las claves de Data Protection, tratadas en [el token antiforgery no se pudo descifrar](/es/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/), no una exclusión faltante.
- **Las rutas con short-circuit no pueden llevar metadatos antiforgery obligatorios.** `.ShortCircuit()` en un endpoint de formulario que todavía requiere validación es un 500 en tiempo de solicitud (`contains anti-forgery metadata, but this endpoint is marked with short circuit and it will execute on Routing Middleware`). Una vez que el endpoint está desactivado, la comprobación ya no aplica.

## Relacionado

- [ASP.NET Core 11 Preview 6 activa la protección CSRF automática](/es/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Endpoint filters frente a middleware en ASP.NET Core 11](/es/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [Solución: "415 Unsupported Media Type" desde un endpoint de minimal API en ASP.NET Core 11](/es/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Solución: The antiforgery token could not be decrypted en ASP.NET Core](/es/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Fuentes

- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/anti-request-forgery) (MS Learn, secciones sobre la protección CSRF automática y la exclusión por endpoint)
- [Notas de la versión de ASP.NET Core en .NET 11 Preview 6: protección automática de origen cruzado (CSRF)](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)
- [dotnet/aspnetcore #66585](https://github.com/dotnet/aspnetcore/pull/66585) y [#67082](https://github.com/dotnet/aspnetcore/pull/67082), los PR del middleware CSRF
- Código fuente en el tag `v11.0.0-rc.1.26425.128`: [`CsrfProtectionMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/CsrfProtectionMiddleware.cs), [`DefaultCsrfProtection.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/DefaultCsrfProtection.cs), [`RoutingEndpointConventionBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Routing/src/Builder/RoutingEndpointConventionBuilderExtensions.cs), [`RequireAntiforgeryTokenAttribute.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Antiforgery/src/RequireAntiforgeryTokenAttribute.cs)
