---
title: "Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11"
description: "A step-by-step migration from Swashbuckle.AspNetCore to Microsoft.AspNetCore.OpenApi in .NET 11: swapping AddSwaggerGen for AddOpenApi, converting operation, schema, and document filters to transformers, keeping a UI, and the Microsoft.OpenApi v2 breaking changes that bite."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
---

If your ASP.NET Core project still calls `builder.Services.AddSwaggerGen()` and `app.UseSwagger()`, you are running Swashbuckle.AspNetCore, the package that powered .NET's OpenAPI story for the better part of a decade. Since .NET 9 the Web API templates no longer ship it: a fresh project uses Microsoft's own `Microsoft.AspNetCore.OpenApi` package instead. This post migrates an existing Swashbuckle codebase to the built-in generator on `net11.0` with C# 14, covering the part the greenfield guides skip: what to remove, how each `IOperationFilter`, `ISchemaFilter`, and `IDocumentFilter` maps to a transformer, how to keep a clickable UI alive, and the Microsoft.OpenApi v2 breaking changes that will not compile until you fix them.

For a small API with a couple of filters this is an afternoon. For a large service with a dozen custom filters, example providers, and multiple `SwaggerDoc` versions, budget a day. Swashbuckle is not deprecated, so this is a choice rather than a forced march. The reason to make it is that the built-in generator ships in the box, tracks the runtime release for release, supports Native AOT, and emits OpenAPI 3.1 by default. The reason to wait is if you lean on Swashbuckle UI features or community filters that have no transformer equivalent yet. Decide that before you start, not halfway through.

## Why migrate now

- The generator ships with the framework. No third-party package pinned into your build that lags a .NET release, which is exactly the .NET 6 pain that pushed Microsoft to own this.
- It reuses the `System.Text.Json` schema support the rest of your app already uses, so the schemas in your document match what your API actually serializes.
- It is Native AOT compatible. Swashbuckle's reflection-heavy generation is not, so an AOT minimal-API service had to drop Swashbuckle regardless.
- OpenAPI 3.1 and JSON Schema draft 2020-12 are the defaults, not an opt-in.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| `AddSwaggerGen` / `UseSwagger` | Replaced by `AddOpenApi` / `MapOpenApi`; different route (`/openapi/v1.json`, not `/swagger/v1/swagger.json`) | high |
| `IOperationFilter` / `ISchemaFilter` / `IDocumentFilter` | No longer invoked; rewrite as `AddOperationTransformer` / `AddSchemaTransformer` / `AddDocumentTransformer` | high |
| Bundled Swagger UI | The framework generates JSON only; you add a UI (Scalar or the standalone Swagger UI package) yourself | high |
| `Microsoft.OpenApi` namespace | v2 moves types from `Microsoft.OpenApi.Models` to `Microsoft.OpenApi`; `OpenApiSchema` becomes `IOpenApiSchema` | medium |
| Schema examples | `OpenApiString`/`IOpenApiAny` gone; examples are now `System.Text.Json.Nodes.JsonNode` | medium |
| Default spec version | Swashbuckle defaulted to OpenAPI 3.0; the built-in generator defaults to 3.1 | medium |
| `SwaggerDoc("v1", ...)` | Replaced by `AddOpenApi("v1")` plus a document transformer for `Info` | low |
| `[SwaggerOperation]` / `EnableAnnotations` | Replaced by minimal-API metadata (`WithSummary`, `WithDescription`, `WithTags`) | low |

## Pre-flight checklist

1. Install the .NET 11 SDK on every dev machine and CI runner. Verify with `dotnet --list-sdks` and confirm `11.0.x` appears.
2. Inventory your Swashbuckle surface. Grep the solution for `AddSwaggerGen`, `OperationFilter<`, `SchemaFilter<`, `DocumentFilter<`, `SwaggerDoc`, `EnableAnnotations`, and `[SwaggerOperation`. The list of filters is the real scope of the migration.
3. Capture a baseline document. Run the app and save `/swagger/v1/swagger.json` to a file. You will diff the new document against it at the end.
4. Note any consumers locked to OpenAPI 3.0. A downstream client generator that chokes on 3.1 is the single most common surprise, and you handle it with one line below.
5. Commit a clean baseline so rollback is one command.

## Migration steps

### 1. Swap the packages

Remove the generator package and add the framework one. If you want to keep the Swagger UI look, keep only its UI assets package, which is separate from the generator.

```dotnetcli
# .NET 11
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.AspNetCore.OpenApi
```

If you used `Swashbuckle.AspNetCore.Filters` (the community example/auth filter pack), remove it too; its features become transformers. **Verify:** `dotnet build` succeeds or fails only on the now-missing `AddSwaggerGen`/filter symbols you are about to replace. A clean compile here would mean you never actually used Swashbuckle.

### 2. Replace the two registration calls

This is the core swap. Swashbuckle registered a generator and two middlewares; the built-in version registers a service and maps an endpoint.

```csharp
// Before -- Swashbuckle, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Todo API", Version = "v1" });
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
```

The document moves from `/swagger/v1/swagger.json` to `/openapi/v1.json`. The default document name is `v1`, which is where the route name comes from. Note the `IsDevelopment()` gate: an OpenAPI document is a full map of your attack surface, so do not serve it to the public internet by default. **Verify:** run the app and request `/openapi/v1.json`. You should get a 3.1 document listing every endpoint. The `Info` block is generic for now; step 4 fixes that.

### 3. Bring back a UI

Swashbuckle bundled Swagger UI, so `/swagger` just worked. The built-in generator produces JSON only. Pick a viewer and point it at the document. The template default since .NET 9 is Scalar:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

If your team is attached to Swagger UI, install `Swashbuckle.AspNetCore.SwaggerUi` (the UI assets only, not the generator) and point it at the new route:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

**Verify:** browse to `/scalar` (or `/swagger`) and confirm the operations render and "Try it out" reaches your API. The greenfield details on each viewer live in [exposing OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

### 4. Move document metadata into a transformer

`SwaggerDoc("v1", new OpenApiInfo { ... })` set the title, version, and description. In the built-in model that is a document transformer, which runs over the `OpenApiDocument` before it serializes.

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints."
        };
        return Task.CompletedTask;
    });
});
```

Mind the `using`. With Microsoft.OpenApi v2 (which both Swashbuckle v10 and `Microsoft.AspNetCore.OpenApi` now depend on) the model types moved from `Microsoft.OpenApi.Models` to `Microsoft.OpenApi`. If you copy old `OpenApiInfo` code verbatim it will not resolve. **Verify:** reload the document and confirm the `info` block shows your title and description.

### 5. Convert operation filters to operation transformers

An `IOperationFilter` ran once per operation to add a response, header, or description. The transformer signature is different but the body is nearly identical.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddThrottleResponseFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Responses.TryAdd("429",
            new OpenApiResponse { Description = "Too Many Requests" });
    }
}
// registered: c.OperationFilter<AddThrottleResponseFilter>();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too Many Requests"
        };
        return Task.CompletedTask;
    });
});
```

The `OperationFilterContext` had `ApiDescription`; the transformer's `context` exposes the same `ApiDescription` so any conditional logic you keyed on the route, HTTP method, or metadata carries over. **Verify:** find an endpoint your filter targeted and confirm the `429` response (or whatever you added) appears on it in the document.

### 6. Convert schema and document filters

`ISchemaFilter` becomes `AddSchemaTransformer`. The context now hands you a `JsonTypeInfo` rather than a `Type`, so you read `context.JsonTypeInfo.Type`:

```csharp
// After -- .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(Todo))
    {
        schema.Description = "A single task tracking item.";
    }
    return Task.CompletedTask;
});
```

`IDocumentFilter` becomes `AddDocumentTransformer`, the same hook used for `Info` in step 4. Use it for `servers`, top-level tags, and security schemes. A common one is declaring a Bearer scheme so the UI shows an Authorize button; you can do that inline or with a strongly typed `IOpenApiDocumentTransformer` when you need to inject services. **Verify:** check that the schema description (or security scheme) shows up where the old filter put it. If you also gate the Authorize button on a security scheme and the token is silently ignored by the viewer, that is almost always a malformed scheme, which I dug into in [why your Bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

### 7. Replace annotations with minimal-API metadata

If you used `EnableAnnotations()` and `[SwaggerOperation(Summary = "...", Description = "...")]`, drop the attributes and express the same metadata with endpoint conventions. They flow straight into the operation:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

For controllers, the XML-doc comments and `[ProducesResponseType]` attributes you already have are read by the API explorer, so much of this is free. Keeping endpoints grouped with [MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) lets a single `WithTags` on the group tag every operation in it. **Verify:** the summaries and tags render in the UI, and `EnableAnnotations` no longer appears anywhere in the project.

### 8. Handle multiple documents and versioning

Swashbuckle's repeated `SwaggerDoc("v1", ...)` / `SwaggerDoc("v2", ...)` becomes repeated `AddOpenApi` calls, each with its own name and options. Which endpoints land in which document is decided by `ShouldInclude`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
builder.Services.AddOpenApi("internal");
```

Each name gets its own route: `/openapi/public.json` and `/openapi/internal.json`. If you run `Asp.Versioning`, it integrates with this document model rather than fighting it. **Verify:** request each document route and confirm the right endpoints appear in each.

## Verification

Run this checklist before you delete the old code path:

- `dotnet build` is clean with zero warnings, including no leftover `Microsoft.OpenApi.Models` references.
- `dotnet test` passes, especially any contract test that pinned the old `/swagger/v1/swagger.json` path; update those to `/openapi/v1.json`.
- Diff the new `/openapi/v1.json` against the baseline you saved in pre-flight. Expect the version line to change from `3.0.x` to `3.1.x` and schema `nullable` handling to differ; everything else should match operation for operation.
- Every endpoint your old filters touched still carries the same responses, headers, and descriptions.
- The UI loads and "Try it out" reaches a real endpoint.
- If you generate a client from the spec, regenerate it and confirm it still builds. See [generating a strongly typed client from an OpenAPI spec](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Rollback plan

This migration is reversible until you start deleting filter classes. To roll back, `dotnet remove package Microsoft.AspNetCore.OpenApi`, re-add `Swashbuckle.AspNetCore`, and restore `AddSwaggerGen` / `UseSwagger` / `UseSwaggerUI`. Because the filter-to-transformer rewrites are in-place edits, the clean git baseline from pre-flight is your real rollback: `git checkout` the commit and you are back on Swashbuckle in one step. Do the migration on a branch and keep the baseline commit until the new document has run in a real environment.

## Gotchas we hit

**The OpenAPI 3.1 default breaks 3.0-only tooling.** This is the most common post-migration ticket. If a downstream generator rejects the document, downgrade explicitly rather than reverting the whole migration:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

**Schema examples are `JsonNode` now, not `OpenApiString`.** Microsoft.OpenApi v2 dropped the `IOpenApiAny` hierarchy. If a schema filter set `schema.Example = new OpenApiString("...")`, the transformer equivalent assigns a `System.Text.Json.Nodes.JsonNode`, for example `JsonValue.Create("...")` or a `JsonObject`. This is the single edit most likely to not compile during the rewrite.

**The document regenerates on every request.** `MapOpenApi` runs the full pipeline each time the endpoint is hit, by design, so transformers can react to live state. For a busy document, cache it with `.CacheOutput()` on the endpoint, or generate it at build time with `Microsoft.Extensions.ApiDescription.Server` and serve a static file. Build-time generation runs your `Program.cs`, so guard startup code (like opening a database connection) on the entry assembly name when it should not run during the build.

**Inferred schemas are stricter than Swashbuckle's.** The built-in generator only documents what the API explorer sees. If a minimal endpoint returns `IResult` with no typed overload or `Produces<T>` call, the response schema is missing. Swashbuckle sometimes papered over this with reflection; the new generator wants the annotation. Add `Produces<T>` and `Accepts<T>` where the schema disappears.

**`OpenApiSchema` is an interface now.** Code that declared `OpenApiSchema schema` as a parameter or local may need `IOpenApiSchema`, and the `Nullable` property is gone in favor of `JsonSchemaType.Null`. If you wrote elaborate schema filters, this is where most of the compile errors land.

The mental model is small once it clicks: the framework owns the document, transformers replace filters, and the UI is a separate swappable concern. The bulk of the work is the filter-to-transformer rewrites and the Microsoft.OpenApi v2 namespace and type changes; the registration swap itself is two lines.

## Related reading

- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to generate strongly typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar in ASP.NET Core: why your Bearer token is ignored](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Sources

- [Generate OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.AspNetCore.OpenApi on NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
</invoke>
