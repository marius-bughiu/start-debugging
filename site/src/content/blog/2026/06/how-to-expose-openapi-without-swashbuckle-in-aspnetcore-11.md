---
title: "How to expose OpenAPI without Swashbuckle in ASP.NET Core 11"
description: "Swashbuckle is gone from the ASP.NET Core templates. Here is how to generate and serve an OpenAPI document in .NET 11 with the built-in Microsoft.AspNetCore.OpenApi package: AddOpenApi, MapOpenApi, transformers, multiple documents, build-time generation, and a UI on top."
pubDate: 2026-06-08
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
---

If you created an ASP.NET Core Web API recently and went looking for `AddSwaggerGen` and `UseSwagger`, they were not there. Since .NET 9, the Web API templates ship with Microsoft's own OpenAPI generator instead of Swashbuckle. To expose an OpenAPI document in .NET 11 you install `Microsoft.AspNetCore.OpenApi`, call `builder.Services.AddOpenApi()`, and call `app.MapOpenApi()`. That serves the document at `/openapi/v1.json`. There is no UI in the box: if you want an interactive page you add Scalar or Swagger UI separately and point it at that JSON endpoint. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14, but the same API exists on .NET 9 and 10.

## Why Swashbuckle left the template

Swashbuckle.AspNetCore was the default OpenAPI story for years, but it was a third-party package pinned into the official templates, and it lagged badly behind .NET releases. The .NET 6 era is the cautionary tale: Swashbuckle's maintenance stalled, the package sat without a stable release that targeted the latest runtime, and teams upgrading to a new .NET version were stuck waiting on a dependency they did not own. Microsoft decided OpenAPI generation was core enough to ship in the box, the same way the JSON serializer and the DI container are.

The result is `Microsoft.AspNetCore.OpenApi`. It generates [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) documents by default, uses [JSON Schema draft 2020-12](https://json-schema.org/specification-links#2020-12), reuses the `System.Text.Json` schema support that the rest of the framework already relies on, and is compatible with Native AOT. The one thing it deliberately does not do is render a UI. Swashbuckle bundled both the document generator and the Swagger UI web assets; Microsoft split those concerns. The framework produces the spec, and you choose the viewer.

## The two calls that generate the document

Add the package:

```dotnetcli
dotnet add package Microsoft.AspNetCore.OpenApi
```

Then register the services and map the endpoint:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapGet("/todos/{id}", (int id) => new Todo(id, "Write the spec", false));

app.Run();

record Todo(int Id, string Title, bool Done);
```

Run the app and request `https://localhost:{port}/openapi/v1.json`. You get a complete OpenAPI 3.1 document describing every endpoint the API explorer can see, with schemas inferred from your parameter and return types. `AddOpenApi()` registers the document services and `MapOpenApi()` adds the route handler that serializes the document on request.

The default document name is `v1`, which is why the route is `/openapi/v1.json`. The `MapOpenApi` route template is `/openapi/{documentName}.json`. Two things are worth noticing in the snippet above. First, the document endpoint is gated behind `IsDevelopment()`. That is the framework's own recommendation: an OpenAPI document is a full map of your attack surface, so do not serve it to the public internet by default. Second, there is no UI yet. Hitting `/openapi/v1.json` gives you raw JSON, which is exactly what tooling wants but not what a human wants to click through.

## Bring your own UI

This is the part that trips people up coming from Swashbuckle, where `/swagger` just worked. In .NET 11 you pick a viewer and wire it to the document route.

The template default since .NET 9 leans toward Scalar. Install `Scalar.AspNetCore` and map it:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Navigate to `https://localhost:{port}/scalar` and you get an interactive reference UI that reads the `/openapi/v1.json` document. Scalar autodetects the standard route, so there is nothing else to configure for the common case.

If your team is attached to Swagger UI, it still works. Install `Swashbuckle.AspNetCore.SwaggerUi` (just the UI assets, not the generator) and point it at the document:

```csharp
// .NET 11, C# 14
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

That serves Swagger UI at `/swagger`, reading the framework-generated document rather than a Swashbuckle-generated one. ReDoc works the same way: serve the static UI and feed it the `/openapi/v1.json` URL. The framework does not care which viewer you use because it only owns the JSON. As a security note, keep all three UIs behind a development-only check for the same reason you gate the document itself.

## Add titles, descriptions, and metadata

A bare document has a generic title and no descriptions. You enrich it in two places: per-endpoint metadata and document-wide transformers.

Per-endpoint metadata uses the same minimal API conventions you already use for routing. `WithSummary`, `WithDescription`, and `WithTags` flow straight into the operation:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

For document-level information like the API title, version, and contact, register a document transformer. A transformer runs over the generated `OpenApiDocument` before it is serialized, so you can set or rewrite anything:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi.Models;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints for the Start Debugging sample.",
            Contact = new OpenApiContact { Name = "API team", Email = "api@example.com" }
        };
        return Task.CompletedTask;
    });
});
```

Transformers are the extension point that replaces most of what you did with Swashbuckle filters. There are three kinds, and they run in the order you register them:

- `AddDocumentTransformer` modifies the whole document. Use it for `Info`, `servers`, top-level security schemes, and tags.
- `AddOperationTransformer` runs once per operation. Use it to add a common response, a header parameter, or a description to every endpoint.
- `AddSchemaTransformer` runs once per generated schema. Use it to add examples, tweak formats, or mark properties.

A common real task is declaring a Bearer security scheme so the UI shows an Authorize button. That is a document transformer that adds the scheme and a global requirement. If you have hit the case where the token is silently ignored by the viewer, the cause is almost always a missing or malformed security scheme in the document, which I covered in detail in [why your Bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

For a strongly typed transformer you implement `IOpenApiDocumentTransformer` (or the operation and schema equivalents) and register the type. That lets you inject services, for example to read the registered authentication schemes and emit matching security definitions:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };
        return Task.CompletedTask;
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

## Generate more than one document

Swashbuckle handled "v1 and v2" or "public and internal" with multiple `SwaggerDoc` calls. The built-in generator does it with multiple `AddOpenApi` calls, each with its own name and options:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public");
builder.Services.AddOpenApi("internal");
```

Each named document gets its own route: `/openapi/public.json` and `/openapi/internal.json`. Which endpoints land in which document is decided by the `ShouldInclude` delegate on `OpenApiOptions`. By default it uses the endpoint group name, set with `WithGroupName` or the `[EndpointGroupName]` attribute, and any endpoint without a group name is included in every document. You can replace `ShouldInclude` with any predicate over the `ApiDescription`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
```

If you are running API versioning, the versioning libraries integrate with this same document model rather than fighting it, which is a real improvement over the old setup. See [Asp.Versioning with built-in OpenAPI](/2026/04/api-versioning-openapi-dotnet-10/) for the per-version document pattern.

## Generate the document at build time

Serving the document over HTTP is fine for development, but sometimes you want the JSON file as a build artifact: to commit it to source control, to run contract tests against it, to feed a [client code generator](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/), or to serve it as a static file in production instead of exposing a live endpoint. For that, add the build-time package:

```dotnetcli
dotnet add package Microsoft.Extensions.ApiDescription.Server
```

With the package installed, `dotnet build` emits the document into `obj/` named after the project. To control where it lands and whether it generates, set MSBuild properties in the `.csproj`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>
</PropertyGroup>
```

`OpenApiDocumentsDirectory` is resolved relative to the project file, so the value above drops the JSON next to the `.csproj`. To rename the file or select a single document when you generate several, use `OpenApiGenerateDocumentsOptions`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocumentsOptions>--file-name my-api --document-name public</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

Build-time generation works by launching your app's entry point against a mock server, so your `Program.cs` actually runs. That means startup code, configuration reads, and DI registrations all execute during the build. If something in startup should not run in that context, for example connecting to a database, guard it on the entry assembly name:

```csharp
// .NET 11, C# 14
using System.Reflection;

if (Assembly.GetEntryAssembly()?.GetName().Name != "GetDocument.Insider")
{
    builder.Services.AddDbContext<AppDbContext>(/* ... */);
}
```

One current limitation: build-time generation produces JSON only. YAML output is supported at runtime (give `MapOpenApi` a `.yaml` route) but not yet at build time.

## Gotchas worth knowing before you ship

**The document regenerates on every request.** `MapOpenApi` runs the full generation pipeline each time the endpoint is hit, on purpose, so transformers can react to live state. For a busy document you can cache it with output caching and `.CacheOutput()` on the endpoint, or just rely on build-time generation and serve a static file.

**The default spec version is 3.1, and that can break old tooling.** Some consumers still only understand OpenAPI 3.0. If a downstream generator chokes on a 3.1 document, downgrade explicitly:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

At build time the equivalent is `<OpenApiGenerateDocumentsOptions>--openapi-version OpenApi3_1</OpenApiGenerateDocumentsOptions>`.

**The endpoint has no authorization by default.** If you do expose the document outside development, gate it. `MapOpenApi()` returns an endpoint convention builder, so `app.MapOpenApi().RequireAuthorization("SomePolicy")` works the same as on any minimal endpoint.

**It only documents what the API explorer sees.** Minimal API endpoints are discovered automatically, but if you return `IResult` without a typed overload or `Produces` call, the generator cannot infer the response schema. Annotate with `Produces<T>` and `Accepts<T>` so the document is accurate. This is the same discipline minimal APIs reward elsewhere, and it pairs well with keeping endpoints organized via [MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), since group-level conventions like `WithTags` flow into every operation in the group.

The mental shift from Swashbuckle is small once you internalize it: the framework owns the document, transformers replace filters, and the UI is a separate, swappable concern. You write two lines to get JSON, one more line to get a viewer, and a handful of transformers to make the document presentable. Nothing is pinned to a package that ships on someone else's schedule.

## Related reading

- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to add OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [How to generate strongly typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar in ASP.NET Core: why your Bearer token is ignored](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [Generate OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Use the generated OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Microsoft.AspNetCore.OpenApi on NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
</invoke>
