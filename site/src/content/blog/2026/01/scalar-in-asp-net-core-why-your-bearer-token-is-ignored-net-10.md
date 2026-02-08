---
title: "Scalar in ASP.NET Core: why your Bearer token is ignored (.NET 10)"
description: "Scalar is showing up more and more as a clean alternative UI for OpenAPI docs in ASP.NET Core. A fresh r/dotnet question highlights a common trap: you paste a token in Scalar’s auth UI, Postman works, but Scalar calls still hit your API without Authorization: Bearer …: https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/. The problem is rarely “JWT auth is…"
pubDate: 2026-01-23
tags:
  - "asp-net"
  - "net"
  - "net-10"
---
Scalar is showing up more and more as a clean alternative UI for OpenAPI docs in ASP.NET Core. A fresh r/dotnet question highlights a common trap: you paste a token in Scalar’s auth UI, Postman works, but Scalar calls still hit your API without `Authorization: Bearer ...`: [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).

The problem is rarely “JWT auth is broken”. It is usually that your OpenAPI document does not declare a proper HTTP Bearer security scheme, so the UI has nothing reliable to apply to your operations.

## Scalar follows your OpenAPI contract, not your middleware

In .NET 10, you can have authentication fully configured in the pipeline and still ship an OpenAPI doc that says nothing about auth. When that happens, tools behave inconsistently:

-   Postman works because you manually add headers.
-   Scalar (or any UI) cannot infer security requirements unless the OpenAPI doc declares them.

Scalar’s own ASP.NET Core integration docs are the best anchor here: [https://scalar.com/products/api-references/integrations/aspnetcore/integration](https://scalar.com/products/api-references/integrations/aspnetcore/integration).

## Declare Bearer security in the OpenAPI document

If you are using the built-in OpenAPI support, the fix is to add a transformer that injects the `http` `bearer` scheme and applies it to operations (globally, or selectively).

This is the shape you need (trimmed to essentials):

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

Once the doc expresses the security scheme, Scalar can apply your entered token to requests in a predictable way.

## Make sure Scalar is mapped to the same OpenAPI endpoint

The second pitfall is wiring: Scalar needs to point at the OpenAPI document you just fixed (for example `"/openapi/v1.json"`). Keep the mapping next to your OpenAPI setup so you do not accidentally serve Scalar against an older doc.

In Scalar, there is also an option to configure HTTP Bearer auth in the UI mapping layer. If you use that, treat it as a convenience, not the source of truth. The OpenAPI contract should still declare the Bearer scheme.

## A quick reality check

If you want to confirm the root cause in minutes:

-   Open your generated OpenAPI JSON and search for `"securitySchemes"` and `"bearer"`.
-   If it is missing, Scalar is not “ignoring your token”. It is simply following the contract you gave it.

Original trigger thread (screenshots included): [https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/](https://www.reddit.com/r/dotnet/comments/1qkjvb0/need_help_with_authentication_using_scalar_aspnet/).
