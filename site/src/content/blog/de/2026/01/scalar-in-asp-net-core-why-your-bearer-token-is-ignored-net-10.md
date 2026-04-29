---
title: "Scalar in ASP.NET Core: warum Ihr Bearer-Token ignoriert wird (.NET 10)"
description: "Wenn Ihr Bearer-Token in Postman funktioniert, in Scalar aber nicht, liegt das Problem wahrscheinlich an Ihrem OpenAPI-Dokument. So deklarieren Sie ein passendes Security-Schema in .NET 10."
pubDate: 2026-01-23
tags:
  - "aspnet"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Scalar taucht immer öfter als saubere UI-Alternative für OpenAPI-Dokumente in ASP.NET Core auf. Eine frische r/dotnet-Frage zeigt eine häufige Falle: Sie fügen einen Token in Scalars Auth-UI ein, Postman funktioniert, aber Scalar-Aufrufe treffen Ihre API weiterhin ohne `Authorization: Bearer ...`: [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).

Das Problem ist selten "JWT-Auth ist kaputt". Meistens deklariert Ihr OpenAPI-Dokument schlicht kein passendes HTTP-Bearer-Security-Schema, sodass die UI nichts Verlässliches hat, das sie auf Ihre Operationen anwenden kann.

## Scalar folgt Ihrem OpenAPI-Vertrag, nicht Ihrer Middleware

In .NET 10 können Sie Authentifizierung vollständig in der Pipeline konfigurieren und trotzdem ein OpenAPI-Dokument ausliefern, das nichts über Auth aussagt. In dem Fall verhalten sich Tools inkonsistent:

-   Postman funktioniert, weil Sie Header manuell hinzufügen.
-   Scalar (oder jede UI) kann Sicherheitsanforderungen nicht ableiten, solange das OpenAPI-Dokument sie nicht deklariert.

Die offizielle ASP.NET-Core-Integration-Doku von Scalar ist hier der beste Anker: [https://scalar.com/products/api-references/integrations/aspnetcore/integration](https://scalar.com/products/api-references/integrations/aspnetcore/integration).

## Bearer-Sicherheit im OpenAPI-Dokument deklarieren

Wenn Sie die eingebaute OpenAPI-Unterstützung verwenden, lautet die Lösung: einen Transformer hinzufügen, der das `http`-`bearer`-Schema einspeist und auf die Operationen anwendet (global oder selektiv).

Das ist die benötigte Form (auf das Wesentliche gekürzt):

```cs
using Microsoft.OpenApi.Models;

// Program.cs (.NET 10)
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer((document, context, ct) =>
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, OpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT"
        };

        // Apply globally (or attach per operation if you prefer)
        document.SecurityRequirements ??= new List<OpenApiSecurityRequirement>();
        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme { Reference = new OpenApiReference
                { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }] = Array.Empty<string>()
        });

        return ValueTask.CompletedTask;
    });
});
```

Sobald das Dokument das Security-Schema ausdrückt, kann Scalar den von Ihnen eingegebenen Token vorhersagbar auf Anfragen anwenden.

## Stellen Sie sicher, dass Scalar auf denselben OpenAPI-Endpunkt zeigt

Die zweite Stolperfalle ist die Verdrahtung: Scalar muss auf das soeben reparierte OpenAPI-Dokument zeigen (zum Beispiel `"/openapi/v1.json"`). Halten Sie das Mapping nahe an Ihrer OpenAPI-Konfiguration, damit Sie Scalar nicht versehentlich gegen ein älteres Dokument bereitstellen.

In Scalar gibt es außerdem eine Option, HTTP-Bearer-Auth in der UI-Mapping-Schicht zu konfigurieren. Wenn Sie das nutzen, behandeln Sie es als Bequemlichkeit, nicht als Source of Truth. Der OpenAPI-Vertrag sollte das Bearer-Schema weiterhin deklarieren.

## Ein schneller Realitätscheck

Wenn Sie die Ursache in Minuten bestätigen wollen:

-   Öffnen Sie Ihr generiertes OpenAPI-JSON und suchen Sie nach `"securitySchemes"` und `"bearer"`.
-   Fehlt das, dann "ignoriert" Scalar nicht Ihren Token. Es folgt schlicht dem Vertrag, den Sie ihm gegeben haben.

Ursprünglicher Auslöser-Thread (inkl. Screenshots): [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).
