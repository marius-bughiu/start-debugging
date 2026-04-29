---
title: "Scalar en ASP.NET Core: por qué tu token Bearer es ignorado (.NET 10)"
description: "Si tu token Bearer funciona en Postman pero no en Scalar, el problema probablemente sea tu documento OpenAPI. Aquí está cómo declarar un esquema de seguridad correcto en .NET 10."
pubDate: 2026-01-23
tags:
  - "aspnet"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Scalar aparece cada vez más como una UI alternativa y limpia para docs de OpenAPI en ASP.NET Core. Una pregunta reciente en r/dotnet resalta una trampa común: pegas un token en la UI de auth de Scalar, Postman funciona, pero las llamadas de Scalar siguen golpeando tu API sin `Authorization: Bearer ...`: [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).

El problema rara vez es "la auth JWT está rota". Suele ser que tu documento OpenAPI no declara un esquema de seguridad HTTP Bearer apropiado, así que la UI no tiene nada confiable que aplicar a tus operaciones.

## Scalar sigue tu contrato OpenAPI, no tu middleware

En .NET 10, puedes tener la autenticación totalmente configurada en el pipeline y aun así entregar un doc OpenAPI que no diga nada sobre auth. Cuando eso pasa, las herramientas se comportan de forma inconsistente:

-   Postman funciona porque tú agregas headers manualmente.
-   Scalar (o cualquier UI) no puede inferir requisitos de seguridad a menos que el doc OpenAPI los declare.

La propia documentación de la integración de Scalar con ASP.NET Core es el mejor punto de partida: [https://scalar.com/products/api-references/integrations/aspnetcore/integration](https://scalar.com/products/api-references/integrations/aspnetcore/integration).

## Declarar la seguridad Bearer en el documento OpenAPI

Si usas el soporte OpenAPI integrado, la solución es agregar un transformer que inyecte el esquema `http` `bearer` y lo aplique a las operaciones (globalmente o de forma selectiva).

Esta es la forma que necesitas (recortada a lo esencial):

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

Una vez que el doc expresa el esquema de seguridad, Scalar puede aplicar el token que ingresaste a las solicitudes de manera predecible.

## Asegúrate de que Scalar esté mapeado al mismo endpoint OpenAPI

El segundo escollo es el cableado: Scalar necesita apuntar al documento OpenAPI que acabas de arreglar (por ejemplo `"/openapi/v1.json"`). Mantén el mapeo junto a tu configuración de OpenAPI para no terminar sirviendo Scalar contra un doc más viejo por accidente.

En Scalar también hay una opción para configurar la auth HTTP Bearer en la capa de mapeo de la UI. Si la usas, trátala como una conveniencia, no como la fuente de verdad. El contrato OpenAPI debería seguir declarando el esquema Bearer.

## Una verificación rápida de realidad

Si quieres confirmar la causa raíz en minutos:

-   Abre tu JSON OpenAPI generado y busca `"securitySchemes"` y `"bearer"`.
-   Si falta, Scalar no está "ignorando tu token". Simplemente está siguiendo el contrato que le diste.

Hilo original que disparó esto (con capturas): [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).
