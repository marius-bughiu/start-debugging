---
title: "OpenAPI-Authentifizierungsflüsse in Swagger UI unter .NET 11 einrichten"
description: "Unter .NET 11 wird das OpenAPI-Dokument von Microsoft.AspNetCore.OpenApi erzeugt und Swagger UI ist nicht mehr Teil des Templates. So verkabeln Sie Bearer, OAuth2 mit PKCE und OpenID Connect, damit der Authorize-Button tatsächlich funktioniert."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "openapi"
  - "swagger"
  - "authentication"
  - "dotnet-11"
template: how-to
lang: "de"
translationOf: "2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-28
---

Unter .NET 11 wird das OpenAPI-Dokument von `Microsoft.AspNetCore.OpenApi` erzeugt und Swagger UI ist nicht mehr Teil des Projekt-Templates. Damit der Authorize-Button tatsächlich Header sendet, brauchen Sie drei zusammenarbeitende Bausteine: einen Document Transformer, der ein Sicherheitsschema im OpenAPI-Dokument registriert, ein globales oder operations-bezogenes Security Requirement, damit Endpunkte deklarieren, was sie brauchen, und die Swagger-UI-Middleware (`Swashbuckle.AspNetCore.SwaggerUI`), konfiguriert mit OAuth-Client-Einstellungen, falls Sie OAuth2 oder OpenID Connect nutzen. Dieser Beitrag durchläuft Bearer JWT, OAuth2 Authorization Code mit PKCE und OpenID Connect, alles unter .NET 11 GA.

Versionen, die im gesamten Beitrag referenziert werden: .NET 11.0 GA, `Microsoft.AspNetCore.OpenApi` 11.0, `Swashbuckle.AspNetCore.SwaggerUI` 7.x, `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0. Die Beispiele nutzen Minimal API, doch die gleichen Transformer funktionieren in MVC-Controllern.

## Was sich seit .NET 8 geändert hat

Unter .NET 8 und früher kam `Swashbuckle.AspNetCore` als Standard mit. Sie riefen `AddSwaggerGen()` auf und konfigurierten alles (Auth-Schemata, Requirements, UI-Optionen) an einer Stelle. Ab .NET 9 liefert das Template `Microsoft.AspNetCore.OpenApi` für die Dokumenterzeugung und entfernt Swagger UI vollständig. .NET 11 behält diese Trennung bei.

Für Authentifizierungsflüsse bedeutet das zwei Dinge:

1. Das OpenAPI-Dokument liegt nicht länger in der Verantwortung von Swashbuckle, alle `OperationFilter`- und `DocumentFilter`-Beispiele auf Stack Overflow sind also veraltet. Der neue Erweiterungspunkt heißt `IOpenApiDocumentTransformer` und `IOpenApiOperationTransformer`.
2. Swagger UI ist jetzt optional. Wer es zurück will, installiert `Swashbuckle.AspNetCore.SwaggerUI` (nur das UI-Paket, etwa 600 KB) und richtet es auf das JSON-Dokument, das der neue Generator ausliefert.

Wenn nur eine Try-it-out-UI gewünscht ist, ist [Scalar eine schlankere Alternative](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/), die dasselbe OpenAPI-Dokument liest. Die Transformer unten erzeugen ein gültiges OpenAPI-3.x-Sicherheitsmodell, sodass jede Spec-konforme UI die Auth-Flows aufgreift.

## Die minimale Bearer-JWT-Konfiguration

Beginnen Sie mit dem einfachsten Schema: `http` mit `bearer` und einem JWT-Format-Hinweis. Installieren Sie den OpenAPI-Generator, die UI und die JWT-Bearer-Authentifizierung:

```bash
# .NET 11
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Swashbuckle.AspNetCore.SwaggerUI
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Fügen Sie einen Document Transformer hinzu, der das Schema registriert:

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

Registrieren Sie ihn und liefern Sie JSON sowie UI aus:

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

Öffnen Sie `/swagger`, klicken Sie auf **Authorize**, fügen Sie das Token ein, und Swagger UI sendet ab sofort `Authorization: Bearer <token>` bei jedem Aufruf. Die globalen `SecurityRequirements` sorgen dafür, dass jede Operation das Requirement erbt; soll ein Endpunkt öffentlich sein, überschreiben Sie es operationsweise (siehe Abschnitt "Mehrere Schemata" weiter unten).

## OAuth2 Authorization Code mit PKCE

Die Bearer-Konfiguration genügt für "Ich habe schon ein Token, das füge ich hier ein", aber die meisten Teams wollen, dass Swagger UI den Nutzer durch einen echten OAuth-Login führt. Für SPA-artige Flows nutzen Sie Authorization Code mit PKCE.

Fügen Sie einen weiteren Transformer hinzu:

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

Damit ist die OpenAPI-Seite fertig. Swagger UI muss zusätzlich wissen, wer *es* gegenüber dem IdP ist, sonst scheitert der Redirect vom Authorize-Endpunkt mit `invalid_client`:

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

Zwei Details der IdP-Registrierung, die Teams häufig übersehen:

- Die Redirect-URI muss exakt `https://your-host/swagger/oauth2-redirect.html` lauten. Swashbuckle liefert diese Seite bereits aus; erfinden Sie keine eigene.
- Der Client muss ein *öffentlicher* Client (ohne Secret) sein. Lehnt der IdP öffentliche Clients ab, wechseln Sie für Maschine-zu-Maschine auf Client Credentials und verzichten in der UI auf den Login-Flow.

## OpenID Connect via Discovery

Wenn der IdP ein Discovery-Dokument bereitstellt, ist `openIdConnect` der hartkodierten URL-Konfiguration vorzuziehen. Swagger UI 7.x liest das Discovery-Dokument und erschließt sich den Rest:

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

Das Schema `openIdConnect` ist seit OpenAPI 3.0.1 gültig und gibt Swagger UI eine einzige Quelle der Wahrheit für `authorization_endpoint`, `token_endpoint` und `scopes_supported`. In der Praxis ist das die sauberste Konfiguration gegen Microsoft Entra ID, Auth0, Keycloak oder jeden anderen IdP, der `/.well-known/openid-configuration` ausliefert. `OAuthClientId` und `OAuthUsePkce` sind auf der Swagger-UI-Seite weiterhin nötig; das Discovery-Dokument deckt nur die *Server*-Seite des Vertrags ab.

## Mehrere Schemata und Anforderungen pro Operation

Echte APIs mischen meistens: ein paar Endpunkte akzeptieren einen API Key, der Rest verlangt OAuth, der Health-Probe ist anonym. Entfernen Sie den globalen `SecurityRequirements.Add(...)`-Aufruf aus dem Document Transformer und setzen Sie die Anforderungen stattdessen pro Operation.

Fügen Sie einen Operation Transformer hinzu, der die Metadaten des Endpunkts liest:

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

Registrieren Sie beide Transformer nebeneinander:

```csharp
builder.Services.AddOpenApi(o =>
{
    o.AddDocumentTransformer<OAuth2SecuritySchemeTransformer>();
    o.AddDocumentTransformer<ApiKeySecuritySchemeTransformer>();
    o.AddOperationTransformer<SecurityRequirementOperationTransformer>();
});
```

Jetzt zeichnet `[Authorize]` ein Schloss an die Operation, `[AllowAnonymous]` überspringt sie, und `[Authorize(AuthenticationSchemes = "ApiKey")]` zeichnet das Schloss des passenden Schemas. Das OpenAPI-Dokument verhält sich wieder wie unter dem alten `AddSecurityRequirement`-Overload von Swashbuckle, jedoch ohne `OperationFilter`, der gepflegt werden müsste.

## Stolperfallen, die in Produktion zubeißen

Einige Punkte tauchen nirgends in der offiziellen Dokumentation auf, dafür in jeder Triage:

**`document.Components` kann null sein.** In einem frisch erzeugten `OpenApiDocument` ist `Components` `null`, bis irgendetwas einen Wert zuweist. Die defensive Zeile `document.Components ??= new OpenApiComponents();` in jedem Transformer oben ist nicht optional. Fehlt der Abschnitt, schreibt der Serializer kein `components.securitySchemes`, und Swagger UI ignoriert die Requirement-Referenz stillschweigend, weil das referenzierte Schema nicht existiert.

**`Reference.Id` muss exakt mit dem Dictionary-Schlüssel übereinstimmen.** Wer das Schema als `"Bearer"` registriert, im Requirement aber `"bearer"` benutzt, hat aus OpenAPI-3.x-Sicht eine unaufgelöste `$ref`; Swagger UI zeigt das Schloss-Icon, sendet aber keinen Header. Pro Anwendung eine Schreibweise wählen und durchziehen.

**Persistente Autorisierung ist standardmäßig aus.** Jedes Neuladen löscht das Token. Für mehr Komfort in der Entwicklung aktivieren Sie `c.EnablePersistAuthorization()`. Das Token landet im `localStorage`, also im Produktiv-Deployment auf keinen Fall einschalten.

**OAuth-Redirect-URL bei Nicht-Root-Pfad-Bases.** Wenn die Anwendung hinter einem Reverse Proxy unter `/api` läuft, baut Swagger UI den Redirect als `/api/swagger/oauth2-redirect.html`. Die IdP-Registrierung muss exakt diesen Pfad enthalten, sonst scheitert der Callback mit `redirect_uri_mismatch`. Bei seltsamen Redirects die `Forwarded`-Header und `UsePathBase` prüfen.

**Native AOT.** Stand .NET 11 ist der neue OpenAPI-Generator nicht für beliebige Transformer als trim-safe annotiert, und das statische Auslieferungsverhalten von Swashbuckle.AspNetCore.SwaggerUI funktioniert zwar unter AOT, doch die Transformer sollten Reflection über geschlossene Generics meiden. Treten `RequiresUnreferencedCode`-Warnungen auf, hilft der [Native-AOT-Leitfaden für Minimal API](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) mit dem passenden Muster.

**Operation-Requirements ergänzen, sie ersetzen nicht.** Hat das Dokument ein globales `SecurityRequirements` *und* der Operation Transformer fügt eines hinzu, werden beide als Alternativen ausgewertet (OR-Semantik in OpenAPI). Für einen öffentlichen Endpunkt müssen Sie `operation.Security` explizit leeren, statt einfach den Transformer in Ruhe zu lassen.

## SwaggerUI mit mehreren Dokumenten verkabeln

Wer seine API versioniert und ein OpenAPI-Dokument pro Version ausliefert, braucht im Swagger-UI-Dropdown einen Endpoint je Version:

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

Jedes Dokument trägt seine eigenen `securitySchemes`, daher wird ein Transformer, der pro Dokument läuft, einmal pro Version aufgerufen. Gute Nachricht: kein gemeinsamer Zustand, dem man hinterherjagen müsste. Schlechte Nachricht: Wer den Transformer für das v2-Dokument vergisst, hat das Schloss nur in v1. Das Muster passt sauber zum `WithDocumentPerVersion()` von `Asp.Versioning` 10.0 (im [API-Versioning-Beitrag](/2026/04/api-versioning-openapi-dotnet-10/) behandelt).

## Verwandte Beiträge

- [Scalar in ASP.NET Core: why your Bearer token is ignored (.NET 10)](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Asp.Versioning 10.0 finally plays nicely with built-in OpenAPI in .NET 10](/2026/04/api-versioning-openapi-dotnet-10/)
- [How to generate strongly-typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Quellen

- [Microsoft.AspNetCore.OpenApi-Dokumentation zur Anpassung](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi)
- [API-Referenz `IOpenApiDocumentTransformer`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.openapi.iopenapidocumenttransformer)
- [Quellcode von Swashbuckle.AspNetCore.SwaggerUI 7.x](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/tree/master/src/Swashbuckle.AspNetCore.SwaggerUI)
- [OpenAPI 3.0.3 security requirement object](https://spec.openapis.org/oas/v3.0.3#security-requirement-object)
