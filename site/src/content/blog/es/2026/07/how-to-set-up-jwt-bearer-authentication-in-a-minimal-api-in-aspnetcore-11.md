---
title: "Cómo configurar la autenticación JWT bearer en una minimal API en ASP.NET Core 11"
description: "Una configuración completa y funcional de autenticación JWT bearer en una minimal API de ASP.NET Core 11: instalar el paquete, conectar AddAuthentication().AddJwtBearer(), emitir un token, proteger endpoints con RequireAuthorization, agregar políticas de rol y de claim, y probarlo todo con dotnet user-jwts."
pubDate: 2026-07-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "jwt"
  - "security"
lang: "es"
translationOf: "2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Para proteger una minimal API en ASP.NET Core 11 con tokens JWT bearer necesitas tres piezas: registrar el handler bearer con `builder.Services.AddAuthentication().AddJwtBearer()`, indicarle cómo se ve un token válido (issuer, audience, clave de firma) y marcar los endpoints que quieres proteger con `.RequireAuthorization()`. El host `WebApplication` conecta el middleware de autenticación y autorización por ti, así que una configuración mínima es de verdad un puñado de líneas. Este artículo recorre el camino completo de principio a fin: el paquete, la configuración, la emisión de un token, la protección de endpoints, las políticas de rol y de claim, y la prueba con `dotnet user-jwts`. Está dirigido a .NET 11 (Preview 5 al momento de escribir, GA en noviembre de 2026) con `Microsoft.AspNetCore.Authentication.JwtBearer` y C# 14, pero cada paso funciona sin cambios hasta .NET 8.

## Instala el único paquete que necesitas

El soporte bearer no está en el framework compartido de forma predeterminada. Agrega el paquete:

```bash
# .NET 11 SDK
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Esto incorpora el `JwtBearerHandler`, los métodos de extensión `AddJwtBearer` y la pila de tokens de `Microsoft.IdentityModel` que en realidad valida el token. No necesitas `System.IdentityModel.Tokens.Jwt` por separado para la validación; el handler usa internamente el `JsonWebTokenHandler`, que es más rápido. Sí querrás un tipo de creación de tokens cuando emitas tokens tú mismo, algo que se cubre más abajo.

## La configuración más pequeña que autentica y autoriza

Aquí tienes un `Program.cs` completo que registra el esquema bearer, expone un endpoint abierto y un endpoint protegido:

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
using System.Security.Claims;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication()
    .AddJwtBearer(); // reads options from configuration, see below

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapGet("/", () => "public, no token needed");

app.MapGet("/me", (ClaimsPrincipal user) => $"hello {user.Identity!.Name}")
    .RequireAuthorization();

app.Run();
```

Vale la pena señalar dos cosas, porque hacen tropezar a quienes vienen del antiguo modelo `Startup.cs`.

Primero, no hay ningún `app.UseAuthentication()` ni `app.UseAuthorization()` en ese archivo, y aun así funciona. En el modelo de hosting mínimo, `WebApplication` inspecciona el contenedor de servicios en tiempo de build y, si detecta registrados los servicios de autenticación y autorización, inserta ambos middleware en el orden correcto por ti. Solo necesitas llamar a `UseAuthentication` y `UseAuthorization` a mano cuando debes controlar el orden respecto de otro middleware, siendo el caso clásico CORS, que tiene que ejecutarse primero. Si una SPA de navegador llama a esta API desde otro origen, lee [cómo configurar CORS para una API protegida con JWT](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) antes de suponer que el cableado de auth está mal; un preflight que se come el encabezado se ve idéntico a un token incorrecto.

Segundo, `AddJwtBearer()` sin lambda no está incompleto. Carga sus `TokenValidationParameters` desde la configuración, bajo la sección `Authentication:Schemes:Bearer`. Ese es el patrón moderno, orientado a configuración, y es exactamente lo que `dotnet user-jwts` escribe por ti.

## Dónde viven las reglas del token: configuración vs código

Puedes indicarle al handler cómo se ve un token válido en dos lugares. Elige uno y sé consistente.

El enfoque **orientado a configuración** mantiene issuer y audience fuera de tu código y en `appsettings.json`. El framework busca bajo `Authentication:Schemes:{SchemeName}`, y el nombre de esquema predeterminado para `AddJwtBearer()` es `Bearer`:

```json
{
  "Authentication": {
    "Schemes": {
      "Bearer": {
        "ValidIssuer": "https://my-api.example.com",
        "ValidAudiences": [ "https://localhost:7259" ]
      }
    }
  }
}
```

El enfoque **orientado a código** establece los mismos valores en la lambda, al que recurrirás cuando firmes tokens con tu propia clave simétrica:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.Tokens;
using System.Text;

var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "https://localhost:7259",

            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
        };
    });
```

Si tus tokens provienen de un proveedor OpenID Connect externo (Entra ID, Auth0, Keycloak, Okta, Duende IdentityServer), te saltas por completo la clave de firma y estableces `options.Authority`, y el handler descubre el issuer y las claves públicas de firma desde los metadatos `/.well-known/openid-configuration` del proveedor. El desglose completo de lo que hace cada flag `Validate*`, y la trampa de los cinco minutos de `ClockSkew` que hace que los tokens vivan más allá de su `exp`, está en [cómo validar el issuer, audience y lifetime de un JWT](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Para esta guía de configuración, el punto clave es que asignar un objeto `TokenValidationParameters` nuevo reemplaza los valores predeterminados por completo, así que enumera cada flag que te importe.

## Establece un esquema predeterminado, o un [Authorize] simple no hace nada

`RequireAuthorization()` (y el atributo `[Authorize]`) desafía al esquema de autenticación *predeterminado*. `AddAuthentication()` sin argumento registra servicios pero no establece un predeterminado. Si lo dejas así, un endpoint protegido no tiene esquema que ejecutar, el usuario permanece anónimo y cada solicitud responde 401 incluso con un token perfecto. Nombrar el esquema lo soluciona:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication.JwtBearer;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
```

`JwtBearerDefaults.AuthenticationScheme` es la cadena `"Bearer"`. Pasarla a `AddAuthentication` establece a la vez `DefaultAuthenticateScheme` y `DefaultChallengeScheme` en una sola llamada, así que un `.RequireAuthorization()` simple ahora sabe que debe ejecutar el handler bearer. Cuando registras un *único* esquema bearer, este es el predeterminado correcto. Esta familia de bugs de "401 silencioso con un token válido", esquema predeterminado ausente, orden de middleware incorrecto, nombre de esquema desajustado, es lo bastante común como para tener su propia guía: [por qué tu JWT de ASP.NET Core devuelve 401 incluso con un token válido](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Emite un token desde un endpoint de login

Si tu API es su propia fuente de identidad, necesitas un endpoint que entregue tokens firmados tras verificar una credencial. Usa `JsonWebTokenHandler.CreateToken` con un `SecurityTokenDescriptor`:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using System.Security.Claims;
using System.Text;

app.MapPost("/login", (LoginRequest req, IConfiguration config) =>
{
    // Replace with a real credential check against your user store.
    if (req is not { Username: "demo", Password: "demo" })
        return Results.Unauthorized();

    var key = new SymmetricSecurityKey(
        Encoding.UTF8.GetBytes(config["Jwt:Secret"]!));

    var descriptor = new SecurityTokenDescriptor
    {
        Issuer = "https://my-api.example.com",
        Audience = "https://localhost:7259",
        Expires = DateTime.UtcNow.AddMinutes(15),
        SigningCredentials = new SigningCredentials(
            key, SecurityAlgorithms.HmacSha256),
        Subject = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.Name, req.Username),
            new Claim(ClaimTypes.Role, "user"),
        }),
    };

    var token = new JsonWebTokenHandler().CreateToken(descriptor);
    return Results.Ok(new { access_token = token });
});

record LoginRequest(string Username, string Password);
```

El secreto HMAC debe tener al menos 256 bits (32 bytes) para `HS256`, o la capa de firma lanza `IDX10720`. Manténlo fuera del código fuente: usa user secrets en desarrollo (`dotnet user-secrets set "Jwt:Secret" "<a-long-random-string>"`) y un almacén de secretos real en producción. Este es un token de acceso autoemitido con un lifetime de 15 minutos; cuando quieras que el cliente permanezca autenticado más allá de eso sin volver a ingresar credenciales, combínalo con un flujo de refresh como se describe en [cómo implementar refresh tokens en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/).

## Protege endpoints y lee los claims del llamante

`.RequireAuthorization()` sin argumento significa "cualquier usuario autenticado". Dentro del handler, inyecta `ClaimsPrincipal` para leer quién es el llamante:

```csharp
// .NET 11, C# 14
app.MapGet("/orders", (ClaimsPrincipal user) =>
{
    var name = user.Identity!.Name;               // ClaimTypes.Name
    var isAdmin = user.IsInRole("admin");         // ClaimTypes.Role
    var sub = user.FindFirstValue(ClaimTypes.NameIdentifier);
    return Results.Ok(new { name, isAdmin, sub });
})
.RequireAuthorization();
```

Un detalle sutil sobre los nombres de claim: `JwtBearerOptions.MapInboundClaims` es `true` de forma predeterminada, lo que reescribe nombres de claim JWT cortos como `sub` y `role` a las URIs largas WS-* (`ClaimTypes.NameIdentifier`, `ClaimTypes.Role`). Si prefieres trabajar con los nombres cortos crudos, establece `options.MapInboundClaims = false` y luego apunta `TokenValidationParameters.NameClaimType` y `RoleClaimType` a lo que tus tokens realmente lleven. Este mapeo es la razón por la que `user.Identity.Name` puede ser null incluso con un token válido: el token no tenía ningún claim que coincidiera con el `NameClaimType` configurado.

## Agrega políticas de rol y de claim para un acceso más fino

"Cualquier usuario autenticado" rara vez basta. Para cualquier cosa más allá de una barrera general, define políticas nombradas una vez y adjúntalas por nombre. `AddAuthorizationBuilder` es la manera amigable con las minimal API:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin_only", policy =>
        policy.RequireRole("admin"))
    .AddPolicy("can_write_orders", policy =>
        policy
            .RequireRole("admin")
            .RequireClaim("scope", "orders_api"));

// ...

app.MapDelete("/orders/{id}", (int id) => Results.NoContent())
    .RequireAuthorization("admin_only");

app.MapPost("/orders", (object order) => Results.Created())
    .RequireAuthorization("can_write_orders");
```

Una política es un conjunto de requisitos que el llamante debe satisfacer. `RequireRole` verifica el claim de rol; `RequireClaim("scope", "orders_api")` verifica que esté presente un claim `scope` con ese valor. Un llamante que se autentica pero falla la política obtiene un **403**, no un 401. Esa distinción importa cuando depuras: 401 significa "no sabemos quién eres" (autenticación), 403 significa "lo sabemos, y no tienes permiso" (autorización). Si ves un 403, deja de mirar el token y mira la política.

Cuando varios endpoints comparten una política, no repitas `.RequireAuthorization("...")` en cada uno. Agrúpalos para que el requisito viva en un solo lugar, lo que además evita que un esquema o política se desvíe silenciosamente entre rutas:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin").RequireAuthorization("admin_only");
admin.MapGet("/stats", () => "admin stats");
admin.MapDelete("/orders/{id}", (int id) => Results.NoContent());
```

Los patrones de agrupamiento, incluidos grupos anidados y filtros por grupo, se cubren en [cómo organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Pruébalo sin construir una interfaz de login

No necesitas un cliente ni un proveedor de identidad real para ejercitar la configuración. La herramienta `dotnet user-jwts` acuña un token firmado con una clave que además conecta en tu configuración de desarrollo, de modo que la validación no puede fallar por un desajuste de clave:

```bash
# .NET 11 SDK, run in the project directory
dotnet user-jwts create
```

Ejecutada contra un proyecto, la herramienta escribe las opciones de validación correspondientes (un `ValidIssuer` de `dotnet-user-jwts` más las URLs de tu app como `ValidAudiences`) en `appsettings.Development.json`, e imprime un token listo para usar. Para acuñar un token que lleve el rol y el scope que tus políticas requieren:

```bash
# .NET 11 SDK
dotnet user-jwts create --role "admin" --scope "orders_api"
```

Luego envíalo:

```bash
# {token} is the value dotnet user-jwts printed
curl -i -H "Authorization: Bearer {token}" https://localhost:7259/orders
```

El formato del encabezado es estricto: la palabra literal `Bearer`, un espacio y luego el token crudo, sin comillas. Si un token de `user-jwts` se autentica pero el de tu proveedor real no, la diferencia está en los claims del token o en la clave de firma, no en tu cableado. Si incluso el token de `user-jwts` responde 401, el cableado sigue mal; revisa de nuevo el esquema predeterminado y el orden del middleware.

## La configuración en siete pasos

Para recapitular todo el flujo como lista de verificación:

1. Agrega el paquete: `dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer`.
2. Registra el esquema y hazlo predeterminado: `builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();`.
3. Agrega autorización: `builder.Services.AddAuthorization();` (o `AddAuthorizationBuilder()` si defines políticas).
4. Configura cómo se ve un token válido, ya sea en la sección de configuración `Authentication:Schemes:Bearer`, vía `options.Authority` para un proveedor OIDC, o vía `TokenValidationParameters` en código para tokens autofirmados.
5. Protege endpoints con `.RequireAuthorization()`, agregando un nombre de política para requisitos de rol o de claim.
6. Deja que `WebApplication` agregue el middleware automáticamente, o llama a `UseAuthentication` y luego a `UseAuthorization` a mano solo cuando el orden (por ejemplo, CORS) lo exija.
7. Prueba con `dotnet user-jwts create` y una solicitud `curl` que lleve el encabezado `Authorization: Bearer`.

Ese es todo el camino feliz. El modelo mental que lo mantiene claro: la autenticación decide *quién* es el llamante validando el token y poblando `HttpContext.User`, y la autorización decide *si* ese llamante puede continuar evaluando políticas. Mantén esos dos trabajos separados en tu cabeza y casi todo problema con JWT se ordena en "el token está mal" (un problema de validación) o "el cableado está mal" (un problema de esquema, middleware o política). Si aún estás decidiendo si los tokens bearer son siquiera la opción correcta para tu app frente a sesiones del lado del servidor, sopesa los compromisos en [JWT vs autenticación por cookie en ASP.NET Core 11](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

## Fuentes

- [Authentication and authorization in Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security), Microsoft Learn, para el registro automático del middleware, `AddAuthorizationBuilder` y el comportamiento de `dotnet user-jwts`.
- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
- [Microsoft.AspNetCore.Authentication.JwtBearer en NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
- [.NET 11 Preview 5 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), .NET Blog, para el preview actual y el objetivo de GA de noviembre de 2026.
