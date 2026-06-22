---
title: "Cómo validar el emisor, la audiencia y la vigencia de un JWT en ASP.NET Core 11"
description: "Una guía completa de TokenValidationParameters en ASP.NET Core 11: cómo funcionan ValidateIssuer, ValidateAudience y ValidateLifetime, cuáles son realmente los valores por defecto, por qué Authority configura automáticamente el emisor y las claves de firma, la trampa de los 5 minutos de ClockSkew y cómo leer los códigos de error IDX cuando se rechaza un token que parece válido."
pubDate: 2026-06-22
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "es"
translationOf: "2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-22
---

El manejador de bearer JWT en ASP.NET Core no se limita a comprobar una firma. Ejecuta una serie de comprobaciones independientes gobernadas por `TokenValidationParameters`: el emisor (`iss`), la audiencia (`aud`), la vigencia (`exp` y `nbf`) y la clave de firma. La buena noticia es que `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` y `ValidateIssuerSigningKey` tienen `true` como valor por defecto, así que un token se comprueba correctamente desde el primer momento. La mala noticia es que "por defecto en true" sin un valor configurado significa que el manejador igual lanza una excepción, y el error de producción más común aquí es un token que sigue vivo cinco minutos después de su `exp` porque `ClockSkew` tiene un valor por defecto de cinco minutos. Este artículo apunta a .NET 11 (preview 5 en el momento de escribir) con `Microsoft.AspNetCore.Authentication.JwtBearer`, pero el modelo de validación no ha cambiado desde .NET 8, 9 y 10.

## Qué valida realmente el manejador de bearer

Cuando llega una solicitud con `Authorization: Bearer <token>`, el `JwtBearerHandler` entrega el token sin procesar a un manejador de tokens (desde .NET 8 el valor por defecto es el más rápido `JsonWebTokenHandler` de `Microsoft.IdentityModel.JsonWebTokens`, no el antiguo `JwtSecurityTokenHandler`). Ese manejador lee `JwtBearerOptions.TokenValidationParameters` y ejecuta cada comprobación habilitada por turnos. Si alguna comprobación falla, lanza una excepción, el manejador produce un 401 y la respuesta lleva un encabezado `WWW-Authenticate: Bearer error="invalid_token"` con una descripción.

Las cuatro comprobaciones que importan para casi cualquier API:

- **Firma** (`ValidateIssuerSigningKey`, activada por defecto): la firma del token se verifica contra una clave. Esto prueba que el token fue acuñado por alguien que posee la clave privada y que no ha sido manipulado.
- **Emisor** (`ValidateIssuer`, activada por defecto): el claim `iss` debe coincidir con `ValidIssuer` (o con uno de `ValidIssuers`). Esto impide que un token de un proveedor de identidad distinto se reenvíe contra tu API.
- **Audiencia** (`ValidateAudience`, activada por defecto): el claim `aud` debe coincidir con `ValidAudience` (o con uno de `ValidAudiences`). Esto impide que un token acuñado para *otra* API del mismo emisor sea aceptado por la tuya.
- **Vigencia** (`ValidateLifetime`, activada por defecto): la hora actual debe ser igual o posterior a `nbf` (not-before) y anterior a `exp` (expiración), dentro de la tolerancia de `ClockSkew`.

Los valores por defecto viven en `Microsoft.IdentityModel.Tokens.TokenValidationParameters`, y puedes confirmarlos en el [código fuente](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs): cada bandera `Validate*` se inicializa en `true`, y `RequireExpirationTime` y `RequireSignedTokens` también son `true`. No activas la validación. Suministras los valores contra los que se valida.

## La configuración correcta más rápida: apuntar a una authority

Si tus tokens provienen de un proveedor OpenID Connect (Entra ID, Auth0, Keycloak, Okta, una instancia de IdentityServer/Duende), casi nunca configuras la clave de firma ni el emisor a mano. Configuras `Authority`, y el manejador descubre todo lo demás desde los metadatos del proveedor.

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        // Discovers issuer + JWKS signing keys from
        // {Authority}/.well-known/openid-configuration
        options.Authority = "https://login.example.com";

        // Maps to TokenValidationParameters.ValidAudience
        options.Audience = "api://my-api";

        // Everything below is already the default, shown for clarity:
        options.TokenValidationParameters.ValidateIssuer = true;
        options.TokenValidationParameters.ValidateAudience = true;
        options.TokenValidationParameters.ValidateLifetime = true;
        options.TokenValidationParameters.ValidateIssuerSigningKey = true;
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Dos cosas ocurren entre bastidores cuando configuras `Authority`:

1. Un `ConfigurationManager` obtiene `{Authority}/.well-known/openid-configuration` y, a partir de ahí, el endpoint JWKS (JSON Web Key Set). Las claves públicas de firma que devuelve ese endpoint se convierten en `IssuerSigningKeys`, y el valor `issuer` de los metadatos se convierte en `ValidIssuer`. El manager lo cachea y lo refresca periódicamente, así que la rotación de claves en el proveedor se gestiona sin un nuevo despliegue.
2. `JwtBearerOptions.Audience` se copia en `TokenValidationParameters.ValidAudience`.

Por eso una configuración mínima de `Authority` + `Audience` valida por completo: emisor, audiencia, vigencia y firma están todos cubiertos. Si tu proveedor solo sirve metadatos por HTTPS (debería), mantén `options.RequireHttpsMetadata = true`, que es el valor por defecto fuera de `Development`.

## Validar un token que firmaste tú mismo (clave simétrica)

Si acuñas tokens en la misma aplicación, por ejemplo una pequeña API propia que emite sus propios tokens de acceso, no hay metadatos OIDC que descubrir. Suministras el emisor, la audiencia y la clave de firma de forma explícita.

```csharp
// .NET 11, C# 14
var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "my-api-clients",

            ValidateLifetime = true,

            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,

            // Default is 5 minutes. See the next section.
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

Ten en cuenta que asignar un `TokenValidationParameters` completamente nuevo reemplaza los valores por defecto por completo, así que enumera todas las banderas que te importen. El secreto HMAC debe tener al menos 256 bits (32 bytes) para `HS256`, o la capa de firma lanza `IDX10720` al crear el token.

## La trampa de los cinco minutos de ClockSkew

Este es el comportamiento más sorprendente, y muerde a quienes escriben una prueba que espera que un token sea rechazado en el instante en que expira.

`TokenValidationParameters.ClockSkew` tiene un valor por defecto de **cinco minutos** (`DefaultClockSkew = TimeSpan.FromMinutes(5)`). Existe para absorber la deriva de reloj entre la máquina que emitió el token y la que lo valida: sin él, una diferencia de un segundo en los relojes del sistema podría rechazar cada token recién acuñado como "aún no válido" o aceptarlo y rechazarlo de forma inconsistente. El costo es que un token con `exp` a las 12:00:00 se sigue aceptando hasta las 12:05:00 en el servidor que valida.

Para la mayoría de las API, cinco minutos de gracia en un token de acceso son inofensivos y el valor por defecto correcto. Pero si emites tokens de corta duración (digamos, tokens de acceso de 60 segundos respaldados por un flujo de refresco, el patrón descrito en [cómo implementar tokens de refresco en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), el skew domina la vigencia y el token vive efectivamente seis minutos, no uno. Ajústalo de forma deliberada:

```csharp
// .NET 11, C# 14
// Strict expiry. Only safe if your servers run NTP-synced clocks.
options.TokenValidationParameters.ClockSkew = TimeSpan.Zero;
```

Configura `ClockSkew = TimeSpan.Zero` solo cuando tu emisor y tu API tengan relojes sincronizados (NTP en ambos, lo normal en cualquier entorno en la nube). Si pueden derivar, un valor pequeño distinto de cero como 30 segundos es el término medio sensato. No "arregles" un rechazo inesperado de token *subiendo* el skew. Un token que está genuinamente expirado debe ser rechazado; subir el skew para ocultar un problema de reloj solo amplía tu ventana de reenvío.

## Por qué ValidateAudience = true sin audiencia es una mina al arrancar

Un error común es dejar `ValidateAudience = true` (el valor por defecto) sin configurar nunca `Audience` / `ValidAudience`. El manejador no tiene nada con qué comparar `aud`, así que lanza una excepción en la primera solicitud:

```text
IDX10208: Unable to validate audience. The 'audience' is null or whitespace
and validationParameters.ValidAudiences is also null or empty.
```

Tienes dos respuestas correctas, y exactamente una incorrecta:

- **Correcta, y preferida**: configura `Audience` (o `ValidAudiences` para varias). La validación de audiencia es un control de seguridad real. Es lo que impide que un token emitido para `api://billing` en tu tenant compartido de Entra se reenvíe contra `api://reporting`.
- **Correcta, solo cuando genuinamente no tienes un claim de audiencia**: configura `ValidateAudience = false` *de forma explícita*, y escribe un comentario explicando por qué. Algunos emisores antiguos no estampan `aud`.
- **Incorrecta**: silenciar la excepción capturándola, o apuntar `ValidAudience` a un valor que no controlas.

La misma forma aplica a `ValidateIssuer = true` sin `ValidIssuer` ni `Authority`: obtienes `IDX10204` ("Unable to validate issuer"). Configurar `Authority` rellena `ValidIssuer` desde los metadatos, por lo que el camino OIDC rara vez choca con esto.

## Aceptar más de un emisor o audiencia

Durante una migración entre proveedores de identidad, o cuando una API sirve a clientes acuñados bajo varios nombres de audiencia, usa las colecciones en plural. Son aditivas respecto a cualquier cosa descubierta desde `Authority`.

```csharp
// .NET 11, C# 14
options.TokenValidationParameters.ValidIssuers = new[]
{
    "https://old-idp.example.com",
    "https://login.example.com",
};
options.TokenValidationParameters.ValidAudiences = new[]
{
    "api://my-api",
    "api://my-api-legacy",
};
```

Un token pasa si su `iss` coincide con *cualquier* entrada de `ValidIssuers` y su `aud` coincide con *cualquier* entrada de `ValidAudiences`. Esto te permite ejecutar ambos emisores en paralelo durante un corte y eliminar el antiguo una vez que el tráfico se haya drenado, sin que haya una ventana en la que se rechacen tokens.

## Leer el fallo: activa los códigos IDX

Cuando un token que parece correcto recibe un 401, el cuerpo de la respuesta está vacío y el encabezado `WWW-Authenticate` es escueto. La razón real está en la excepción que el manejador se tragó. Conecta `OnAuthenticationFailed` para exponerla mientras depuras:

```csharp
// .NET 11, C# 14
options.Events = new JwtBearerEvents
{
    OnAuthenticationFailed = context =>
    {
        // Logs the underlying SecurityTokenException, e.g. IDX10223
        context.NoResult();
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILogger<Program>>();
        logger.LogWarning(context.Exception, "JWT validation failed");
        return Task.CompletedTask;
    },
};
```

Los códigos `IDX` de `Microsoft.IdentityModel` se corresponden directamente con las cuatro comprobaciones, y conocerlos termina la mayoría de las sesiones de depuración en segundos:

- `IDX10223`: falló la validación de vigencia, el token está expirado. Revisa `exp` y `ClockSkew`.
- `IDX10205` / `IDX10204`: el emisor es inválido o no se pudo validar. El claim `iss` no coincide con `ValidIssuer`/`ValidIssuers`, o no se configuró ninguno.
- `IDX10214` / `IDX10208`: la audiencia es inválida o no se pudo validar. El claim `aud` no coincide, o no se configuró ninguno.
- `IDX10503` / `IDX10500`: falló la validación de firma, a menudo una clave que la API no tiene. Con `Authority`, esto suele significar una caché de metadatos obsoleta o un proveedor que rotó claves; el refresco del `ConfigurationManager` lo resuelve.

Si el token valida pero `User.Identity?.Name` es null o tus comprobaciones `[Authorize(Roles = ...)]` fallan, el problema es el mapeo de claims, no la validación. `JwtBearerOptions.MapInboundClaims` tiene `true` por defecto, lo que reescribe nombres cortos de claim como `sub` y `role` en las URIs largas de WS-*. Configura `options.MapInboundClaims = false` para mantener los nombres cortos originales, y luego configura `TokenValidationParameters.NameClaimType` y `RoleClaimType` con lo que tus tokens usen realmente.

## Juntándolo todo, paso a paso

1. Elige tu ancla de confianza. Para un proveedor OIDC, configura `options.Authority`; el emisor y las claves de firma vienen de los metadatos. Para tokens autofirmados, configura `ValidIssuer` e `IssuerSigningKey` a mano.
2. Configura la audiencia. Asigna `options.Audience` (o `ValidAudiences`) para que `ValidateAudience = true` tenga algo que comprobar. No desactives la validación de audiencia salvo que tus tokens realmente no lleven `aud`.
3. Deja `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` y `ValidateIssuerSigningKey` en su valor por defecto `true`. Estás configurando valores, no interruptores.
4. Configura `ClockSkew` para que coincida con la vigencia de tu token. Mantén el valor por defecto de 5 minutos para tokens de acceso normales; baja a `TimeSpan.Zero` o 30 segundos para tokens de corta duración en relojes sincronizados por NTP.
5. Para escenarios multi-proveedor o multi-audiencia, usa las colecciones en plural `ValidIssuers` / `ValidAudiences` durante el corte.
6. Añade registro de `JwtBearerEvents.OnAuthenticationFailed` fuera de producción para que el código `IDX` te diga cuál de las cuatro comprobaciones falló.
7. Coloca `app.UseAuthentication()` antes de `app.UseAuthorization()`, y si una SPA de navegador llama a la API desde otro origen, acierta el orden del middleware según [cómo configurar CORS para una API protegida con JWT](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

## Cuando la validación pasa pero la solicitud aún falla

Una vez que pasan las cuatro comprobaciones, cualquier fallo restante ya no es un problema de validación de token. Un 403 (no un 401) significa que el token era válido pero no se cumplió una política de autorización o un requisito de rol, que es una capa totalmente distinta. Una solicitud que funciona en código pero falla desde una UI de documentación suele ser la herramienta descartando el encabezado, algo cubierto en [por qué se ignora tu bearer token en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) y en [añadir flujos de autenticación OpenAPI a Swagger UI](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/). Y si estás conectando autenticación a una minimal API, agrupa los endpoints protegidos para que la política se aplique en un solo lugar, como se muestra en [organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

El modelo mental que mantiene esto simple: `TokenValidationParameters` son cuatro preguntas independientes que el manejador hace de cada token. ¿Quién lo firmó? ¿Quién lo emitió? ¿Para quién es? ¿Sigue en vigencia? Los valores por defecto hacen que las cuatro sean obligatorias, así que tu único trabajo es darle a cada una un valor correcto, y recordar que "sigue en vigencia" lleva un colchón de cinco minutos hasta que digas lo contrario.

Fuentes: [TokenValidationParameters source - AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs), [Configure JWT bearer authentication in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), [JwtBearerOptions - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.jwtbearer.jwtbeareroptions), [Microsoft.AspNetCore.Authentication.JwtBearer - NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
