---
title: "Cómo agregar flujos de autenticación de OpenAPI a Swagger UI en .NET 11"
description: "En .NET 11 el documento OpenAPI lo genera Microsoft.AspNetCore.OpenApi y Swagger UI ya no viene en la plantilla. Así se conectan Bearer, OAuth2 con PKCE y OpenID Connect para que el botón Authorize realmente funcione."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "openapi"
  - "swagger"
  - "authentication"
  - "dotnet-11"
template: how-to
lang: "es"
translationOf: "2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-28
---

En .NET 11 el documento OpenAPI lo produce `Microsoft.AspNetCore.OpenApi` y Swagger UI ya no viene en la plantilla del proyecto. Para conseguir un botón Authorize que realmente envíe encabezados, necesitas tres piezas conectadas entre sí: un transformador de documento que registre un esquema de seguridad en el documento OpenAPI, un requisito de seguridad global o por operación para que los endpoints declaren lo que necesitan, y el middleware de Swagger UI (`Swashbuckle.AspNetCore.SwaggerUI`) configurado con los ajustes de cliente OAuth si usas OAuth2 u OpenID Connect. Este post recorre Bearer JWT, OAuth2 con authorization code y PKCE, y OpenID Connect, todo sobre .NET 11 GA.

Versiones referenciadas a lo largo del post: .NET 11.0 GA, `Microsoft.AspNetCore.OpenApi` 11.0, `Swashbuckle.AspNetCore.SwaggerUI` 7.x, `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0. Los ejemplos son minimal API, pero los mismos transformadores funcionan en controllers MVC.

## Qué cambió desde .NET 8

En .NET 8 y anteriores, `Swashbuckle.AspNetCore` venía como opción por defecto. Llamabas a `AddSwaggerGen()` y configurabas todo (esquemas de auth, requisitos, opciones de UI) en un solo lugar. Desde .NET 9 la plantilla incluye `Microsoft.AspNetCore.OpenApi` para la generación del documento y elimina Swagger UI por completo. .NET 11 mantiene esa separación.

Esto implica dos cosas para los flujos de autenticación:

1. El documento OpenAPI ya no es responsabilidad de Swashbuckle, así que todos los ejemplos de `OperationFilter` y `DocumentFilter` en Stack Overflow están obsoletos. El nuevo punto de extensión es `IOpenApiDocumentTransformer` y `IOpenApiOperationTransformer`.
2. Swagger UI ahora es opcional. Si lo quieres de vuelta, instalas `Swashbuckle.AspNetCore.SwaggerUI` (solo el paquete de UI, alrededor de 600 KB) y lo apuntas al documento JSON que emite el nuevo generador.

Si lo único que necesitas es una UI de "probar el endpoint", [Scalar es una alternativa más liviana](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) que lee el mismo documento OpenAPI. Los transformadores de abajo producen un modelo de seguridad OpenAPI 3.x válido, así que cualquier UI que respete la especificación detectará los flujos de auth.

## La configuración mínima de Bearer JWT

Empieza por el esquema más simple: `http` con `bearer` y la pista de formato JWT. Instala el generador de OpenAPI, la UI y la autenticación JWT bearer:

```bash
# .NET 11
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Swashbuckle.AspNetCore.SwaggerUI
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Agrega un transformador de documento que registre el esquema:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header,
            Description = "Paste a JWT issued by your IdP."
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "Bearer"
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

Regístralo y sirve el JSON junto con la UI:

```csharp
// .NET 11, C# 14, Program.cs
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "https://login.example.com/";
        o.Audience = "api://my-api";
    });

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapOpenApi();           // serves /openapi/v1.json
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
});

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/secret", () => "hello").RequireAuthorization();
app.Run();
```

Abre `/swagger`, haz clic en **Authorize**, pega el token, y Swagger UI ahora envía `Authorization: Bearer <token>` en cada llamada. Los `SecurityRequirements` globales hacen que cada operación herede el requisito; si quieres un endpoint público, lo sobrescribes por operación (lo cubre la sección "Múltiples esquemas" más abajo).

## OAuth2 authorization code con PKCE

La configuración de Bearer está bien para "ya tengo un token, lo pego aquí", pero la mayoría de los equipos quiere que Swagger UI guíe al usuario por un login OAuth real. Para flujos tipo SPA, usa authorization code con PKCE.

Agrega otro transformador:

```csharp
// .NET 11, C# 14
internal sealed class OAuth2SecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oauth2"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OAuth2,
            Flows = new OpenApiOAuthFlows
            {
                AuthorizationCode = new OpenApiOAuthFlow
                {
                    AuthorizationUrl = new Uri($"{authority}/oauth2/authorize"),
                    TokenUrl = new Uri($"{authority}/oauth2/token"),
                    Scopes = new Dictionary<string, string>
                    {
                        ["api://my-api/read"]  = "Read your data",
                        ["api://my-api/write"] = "Write your data"
                    }
                }
            }
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oauth2"
                }
            }] = ["api://my-api/read", "api://my-api/write"]
        });

        return Task.CompletedTask;
    }
}
```

Con esto, el lado del documento OpenAPI está listo. Swagger UI también necesita saber quién es *él* para el IdP, si no la redirección desde el endpoint authorize falla con `invalid_client`:

```csharp
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");

    c.OAuthClientId("swagger-ui");        // public client registered with the IdP
    c.OAuthUsePkce();                     // mandatory for public clients
    c.OAuthScopes("api://my-api/read");
    c.OAuthAppName("Swagger UI for My API");
});
```

Dos detalles del registro en el IdP que suelen pillar a la gente:

- La URI de redirección debe ser exactamente `https://your-host/swagger/oauth2-redirect.html`. Swashbuckle ya envía esa página; no inventes otra.
- El cliente debe ser un cliente *público* (sin secreto). Si tu IdP rechaza clientes públicos, cambia a client credentials para máquina-a-máquina y olvídate del flujo en la UI.

## OpenID Connect vía discovery

Si tu IdP expone un documento de discovery, prefiere `openIdConnect` antes que codificar URLs a mano. Swagger UI 7.x lee el documento de discovery y deduce el resto:

```csharp
// .NET 11, C# 14
internal sealed class OidcSecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oidc"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OpenIdConnect,
            OpenIdConnectUrl = new Uri($"{authority}/.well-known/openid-configuration")
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oidc"
                }
            }] = ["openid", "profile", "api://my-api/read"]
        });

        return Task.CompletedTask;
    }
}
```

El esquema `openIdConnect` es OpenAPI 3.x válido desde 3.0.1 y le da a Swagger UI una única fuente de verdad para `authorization_endpoint`, `token_endpoint` y `scopes_supported`. En la práctica, esta es la configuración más limpia cuando trabajas contra Microsoft Entra ID, Auth0, Keycloak o cualquier otro IdP que exponga `/.well-known/openid-configuration`. Aun así necesitas `OAuthClientId` y `OAuthUsePkce` en el lado de Swagger UI; el documento de discovery solo cubre el lado *servidor* del contrato.

## Múltiples esquemas y requisitos por operación

Las APIs reales suelen mezclar: un par de endpoints aceptan una API key, el resto requiere OAuth, la sonda de health es anónima. Quita la llamada global `SecurityRequirements.Add(...)` del transformador de documento y aplica los requisitos por operación.

Agrega un transformador de operación que lea metadatos del endpoint:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authorization;

internal sealed class SecurityRequirementOperationTransformer
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken ct)
    {
        var endpoint = context.Description.ActionDescriptor.EndpointMetadata;
        var hasAuth   = endpoint.OfType<IAuthorizeData>().Any();
        var anonymous = endpoint.OfType<IAllowAnonymous>().Any();

        if (!hasAuth || anonymous) return Task.CompletedTask;

        var schemeId = endpoint
            .OfType<AuthorizeAttribute>()
            .Select(a => a.AuthenticationSchemes)
            .FirstOrDefault(s => !string.IsNullOrEmpty(s)) ?? "oauth2";

        operation.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = schemeId
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

Registra ambos transformadores juntos:

```csharp
builder.Services.AddOpenApi(o =>
{
    o.AddDocumentTransformer<OAuth2SecuritySchemeTransformer>();
    o.AddDocumentTransformer<ApiKeySecuritySchemeTransformer>();
    o.AddOperationTransformer<SecurityRequirementOperationTransformer>();
});
```

Ahora `[Authorize]` pinta un candado en la operación, `[AllowAnonymous]` la salta, y `[Authorize(AuthenticationSchemes = "ApiKey")]` pinta el candado del esquema correcto. El documento OpenAPI vuelve a verse como con el viejo overload `AddSecurityRequirement` de Swashbuckle, pero sin `OperationFilter` que mantener.

## Detalles que muerden en producción

Hay cosas que no aparecen en la documentación oficial pero salen en cada triage:

**`document.Components` puede ser null.** En un `OpenApiDocument` recién creado, `Components` es `null` hasta que algo le asigna un valor. La línea defensiva `document.Components ??= new OpenApiComponents();` que aparece en cada transformador de arriba no es opcional. El serializador no escribe `components.securitySchemes` si la sección está ausente, y Swagger UI ignora silenciosamente la referencia del requisito porque el esquema al que apunta no existe.

**`Reference.Id` debe coincidir exactamente con la clave del diccionario.** Si registras el esquema como `"Bearer"` pero el requisito usa `"bearer"`, OpenAPI 3.x lo trata como un `$ref` no resuelto y Swagger UI muestra el icono del candado pero nunca envía el encabezado. Elige una capitalización por aplicación y mantenla.

**La autorización persistida está apagada por defecto.** Cada recarga borra el token. Para mejorar la ergonomía en desarrollo, activa `c.EnablePersistAuthorization()`. El token se guarda en `localStorage`, así que no actives esto en un despliegue de producción.

**URL de redirección OAuth con bases de path no raíz.** Cuando la app corre detrás de un reverse proxy en `/api`, Swagger UI construye la redirección como `/api/swagger/oauth2-redirect.html`. El registro en el IdP debe incluir exactamente ese path o el callback falla con `redirect_uri_mismatch`. Revisa los encabezados `Forwarded` y `UsePathBase` si la redirección se ve mal.

**Native AOT.** A día de .NET 11, el nuevo generador de OpenAPI no está anotado como trim-safe para transformadores arbitrarios, y aunque el servicio estático de Swashbuckle.AspNetCore.SwaggerUI sí funciona bajo AOT, los transformadores deben evitar reflexión sobre genéricos cerrados. Si te encuentras con advertencias `RequiresUnreferencedCode`, mira la [guía de Native AOT con minimal API](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para ver el patrón.

**Los requisitos por operación se acumulan, no reemplazan.** Si el documento tiene un `SecurityRequirements` global *y* el transformador de operación añade otro, ambos se evalúan como alternativas (semántica OR en OpenAPI). Para un endpoint público hay que limpiar `operation.Security` explícitamente, no basta con dejar el transformador en paz.

## Conectar SwaggerUI con varios documentos

Si versionas tu API y emites un documento OpenAPI por versión, el desplegable de Swagger UI necesita un endpoint para cada uno:

```csharp
app.MapOpenApi("/openapi/{documentName}.json");

app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
    c.SwaggerEndpoint("/openapi/v2.json", "API v2");

    c.OAuthClientId("swagger-ui");
    c.OAuthUsePkce();
});
```

Cada documento lleva sus propios `securitySchemes`, así que un transformador que corre por documento se invoca una vez por versión. La buena noticia: no hay estado compartido del que preocuparse. La mala: si te olvidas de registrar el transformador para el documento v2, solo v1 tendrá el candado. El patrón encaja limpiamente con el `WithDocumentPerVersion()` de `Asp.Versioning` 10.0 (cubierto en el [post de versionado de API](/2026/04/api-versioning-openapi-dotnet-10/)).

## Relacionado

- [Scalar in ASP.NET Core: why your Bearer token is ignored (.NET 10)](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Asp.Versioning 10.0 finally plays nicely with built-in OpenAPI in .NET 10](/2026/04/api-versioning-openapi-dotnet-10/)
- [How to generate strongly-typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Fuentes

- [Documentación de personalización de Microsoft.AspNetCore.OpenApi](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi)
- [Referencia de la API `IOpenApiDocumentTransformer`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.openapi.iopenapidocumenttransformer)
- [Código fuente de Swashbuckle.AspNetCore.SwaggerUI 7.x](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/tree/master/src/Swashbuckle.AspNetCore.SwaggerUI)
- [OpenAPI 3.0.3 security requirement object](https://spec.openapis.org/oas/v3.0.3#security-requirement-object)
