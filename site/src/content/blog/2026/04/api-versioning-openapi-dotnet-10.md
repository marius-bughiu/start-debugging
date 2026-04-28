---
title: "Asp.Versioning 10.0 finally plays nicely with built-in OpenAPI in .NET 10"
description: "Asp.Versioning 10.0 is the first release that targets .NET 10 and the new Microsoft.AspNetCore.OpenApi pipeline. Sander ten Brinke's April 23 walkthrough shows how to register one OpenAPI document per API version with WithDocumentPerVersion()."
pubDate: 2026-04-28
tags:
  - "dotnet-10"
  - "aspnetcore"
  - "openapi"
  - "api-versioning"
---

When ASP.NET Core 9 swapped Swashbuckle for the built-in [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/overview?view=aspnetcore-10.0) generator, one bit of glue went missing: there was no clean way to wire the new pipeline up to `Asp.Versioning` and emit a separate document per version. The fix landed last week. Sander ten Brinke's [April 23 .NET Blog post](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) is the official "do it like this" walkthrough, and it pairs with the first `Asp.Versioning` packages that target .NET 10.

## The packages that changed

For minimal APIs you now reference three packages, all current as of April 2026:

- `Asp.Versioning.Http` 10.0.0
- `Asp.Versioning.Mvc.ApiExplorer` 10.0.0
- `Asp.Versioning.OpenApi` 10.0.0-rc.1

For controllers, swap `Asp.Versioning.Http` for `Asp.Versioning.Mvc` 10.0.0. The `OpenApi` package is the one doing the actual work: it bridges the API explorer model that the versioning library already produces into the document transformer pipeline that `Microsoft.AspNetCore.OpenApi` expects. Before this release, you had to hand-write a transformer that read `IApiVersionDescriptionProvider` and filtered operations per document. That code is now in the box.

## One document per version, in three lines

Service registration is unchanged from the pre-OpenAPI versioning story, with one extra `.AddOpenApi()` call:

```csharp
builder.Services.AddApiVersioning()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
    })
    .AddOpenApi();
```

The endpoint side is where the new extension shows up:

```csharp
app.MapOpenApi().WithDocumentPerVersion();
```

`WithDocumentPerVersion()` enumerates whatever `DescribeApiVersions()` returns and registers one document per version. You hit `/openapi/v1.json` and `/openapi/v2.json` and get exactly the operations that belong to each version, with no shared operation IDs or duplicated schemas leaking across docs. Both Scalar (`app.MapScalarApiReference()`) and Swagger UI (`app.UseSwaggerUI()`) auto-discover the documents through the same API version description provider, so the picker in the browser is wired up for free.

## Versioned route groups

For minimal APIs the route side stays compact. You declare a versioned API once and hang per-version groups off it:

```csharp
var usersApi = app.NewVersionedApi("Users");

var usersV1 = usersApi.MapGroup("api/users").HasApiVersion("1.0");
var usersV2 = usersApi.MapGroup("api/users").HasApiVersion("2.0");

usersV1.MapGet("", () => Results.Ok(new { shape = "v1" }));
usersV2.MapGet("", () => Results.Ok(new { shape = "v2" }));
```

The `Users` name becomes the API group; `HasApiVersion` is what the API explorer reads to decide which OpenAPI document each endpoint belongs in.

## Why this matters now

If you started a new ASP.NET Core 9 or 10 app and skipped Swashbuckle on principle, versioning was the one thing pulling you back. With `Asp.Versioning.OpenApi` 10.0.0-rc.1 that escape hatch closes. The RC suffix is the only reason to wait: the API surface is the one that ships, and the team is targeting GA alongside the .NET 10 servicing train. The full sample lives in [Sander's repo linked from the post](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) and is worth cloning before the next time you reach for a hand-rolled transformer.
