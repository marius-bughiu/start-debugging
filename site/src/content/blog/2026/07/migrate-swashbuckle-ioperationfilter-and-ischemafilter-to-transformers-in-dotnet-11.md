---
title: "Migrate Swashbuckle IOperationFilter and ISchemaFilter to OpenAPI transformers in .NET 11"
description: "A filter-by-filter porting reference for moving Swashbuckle IOperationFilter and ISchemaFilter code to the built-in operation and schema transformers in .NET 11, with the context-object field mapping and the Microsoft.OpenApi v2 changes that bite."
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
---

If you have already swapped `AddSwaggerGen()` for `AddOpenApi()` on `net11.0`, the registration is the easy part. The work that actually eats the afternoon is your custom filters: every `IOperationFilter` and `ISchemaFilter` you wrote against Swashbuckle stops being invoked the moment the generator changes, because the built-in `Microsoft.AspNetCore.OpenApi` generator has no concept of filters. It has transformers. This post is the filter-by-filter porting reference: how the two filter interfaces map to `IOpenApiOperationTransformer` and `IOpenApiSchemaTransformer`, what each context property becomes, and the Microsoft.OpenApi v2 type changes that will not compile until you fix them. It targets .NET 11 (`net11.0`, C# 14), `Microsoft.AspNetCore.OpenApi` v11, and `Microsoft.OpenApi` v2, porting from Swashbuckle.AspNetCore v10.

For a handful of filters this is under an hour. For a large service with a dozen filters, an example provider, and a polymorphism filter, budget half a day. The mechanical shape of each port is nearly identical, so the cost is not the rewrite: it is the two context objects that expose different information, and the type-model changes in Microsoft.OpenApi v2. If you have not done the surrounding registration swap yet, do that first with [the full Swashbuckle-to-built-in migration guide](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/); everything below assumes `AddOpenApi()` and `MapOpenApi()` are already in place.

## Why port the filters at all

- The filters are dead code the moment you drop Swashbuckle's generator. They compile (the types still exist while the package is referenced) but never run, so your document silently loses every customization they applied.
- Transformers reuse the same `System.Text.Json` metadata the rest of your app serializes with, so a schema transformer sees exactly the type shape your API emits, not a reflection approximation.
- Transformers are Native AOT compatible. Swashbuckle's reflection-driven filter pipeline is not, so an AOT service has no filter option at all.
- One extensibility model covers document, operation, and schema instead of three filter interfaces plus annotation attributes.

## What breaks

| Area | Swashbuckle | Built-in .NET 11 | Severity |
| --- | --- | --- | --- |
| Operation hook | `IOperationFilter.Apply(OpenApiOperation, OperationFilterContext)` | `IOpenApiOperationTransformer.TransformAsync(...)` | high |
| Schema hook | `ISchemaFilter.Apply(OpenApiSchema, SchemaFilterContext)` | `IOpenApiSchemaTransformer.TransformAsync(...)` | high |
| Method signature | synchronous `void Apply` | `Task TransformAsync(..., CancellationToken)` | medium |
| Registration | `c.OperationFilter<T>(args)` / `c.SchemaFilter<T>(args)` | `options.AddOperationTransformer<T>()` / `AddSchemaTransformer<T>()` | medium |
| Schema examples | `OpenApiString` / `IOpenApiAny` | `System.Text.Json.Nodes.JsonNode` | medium |
| Schema type field | `schema.Type = "string"` string + `Nullable` | `JsonSchemaType` flags enum, `Null` flag | medium |
| Reflection member | `context.MemberInfo` (`MemberInfo`) | `context.JsonPropertyInfo` (`JsonPropertyInfo`) | medium |
| Sub-schema generation | `context.SchemaGenerator.GenerateSchema(...)` | `context.GetOrCreateSchemaAsync(...)` | low |

## Pre-flight checklist

1. Confirm the .NET 11 SDK is installed on every dev machine and CI runner: `dotnet --list-sdks` should list `11.0.x`.
2. Inventory the filters. Grep the solution for `IOperationFilter`, `ISchemaFilter`, `IDocumentFilter`, `OperationFilter<`, and `SchemaFilter<`. That list is the exact scope of this port; nothing else here changes.
3. Save a baseline document. With Swashbuckle still wired up, request `/swagger/v1/swagger.json` and keep the file. You will diff the ported document against it, endpoint by endpoint.
4. Confirm `AddOpenApi()` and `MapOpenApi()` already produce a document at `/openapi/v1.json`. If not, port the registration first.
5. Do the work on a branch with a clean baseline commit so rollback is one `git checkout`.

## The two context objects, mapped

Before the recipes, the mapping that makes every port mechanical. A Swashbuckle filter and a built-in transformer hand you the same OpenAPI object to mutate (`OpenApiOperation` or `OpenApiSchema`), but the context around it differs.

`OperationFilterContext` to `OpenApiOperationTransformerContext`:

| Swashbuckle | Built-in | Notes |
| --- | --- | --- |
| `ApiDescription` | `Description` | Same `ApiDescription` type; renamed property. Route, method, and `ActionDescriptor.EndpointMetadata` all carry over. |
| `MethodInfo` | `Description.ActionDescriptor` | Read metadata off the descriptor rather than the raw `MethodInfo`. |
| `SchemaRepository` | `Document` | Register shared schemas with `Document.AddComponent(...)`. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | A method on the context now, not a separate generator object. |
| `DocumentName` | `DocumentName` | Unchanged. |

`SchemaFilterContext` to `OpenApiSchemaTransformerContext`:

| Swashbuckle | Built-in | Notes |
| --- | --- | --- |
| `Type` | `JsonTypeInfo.Type` | The CLR `Type` is one hop deeper, under the `System.Text.Json` metadata. |
| `MemberInfo` | `JsonPropertyInfo` | Non-null only for a property schema. Read attributes via `JsonPropertyInfo.AttributeProvider`. |
| `ParameterInfo` | `ParameterDescription` | An `ApiParameterDescription`; null for a response schema. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Same as above. |
| `DocumentName` | `DocumentName` | Unchanged. |

Keep these two tables open while you port. Ninety percent of each rewrite is renaming a context property and adjusting for `JsonTypeInfo`.

## Migration steps

### 1. Map each filter to its transformer interface and registration

Every `IOperationFilter` becomes an `IOpenApiOperationTransformer` (or an inline `AddOperationTransformer` delegate), and every `ISchemaFilter` becomes an `IOpenApiSchemaTransformer`. A synchronous `void Apply` becomes an async `TransformAsync` returning a `Task` and taking a `CancellationToken`. Registration moves from the `AddSwaggerGen` callback to the `AddOpenApi` options block.

```csharp
// Before -- Swashbuckle registration, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.OperationFilter<AddCorrelationHeaderFilter>();
    c.SchemaFilter<MarkMoneyFormatFilter>();
});
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer<AddCorrelationHeaderTransformer>();
    options.AddSchemaTransformer<MarkMoneyFormatTransformer>();
});
```

**Verify:** the project still builds with the old filter classes deleted or renamed, and `AddOpenApi` compiles with the new registrations. Nothing runs correctly yet; the next steps fill in the bodies.

### 2. Port an IOperationFilter that adds a response or header

This is the most common filter and the most mechanical port. The body barely changes: you mutate `operation` in place. Guard against a null `Parameters` or `Responses` collection, which the built-in model leaves null rather than pre-allocating.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddCorrelationHeaderFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = "string" }
        });
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class AddCorrelationHeaderTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    }
}
```

Two changes beyond the signature: `Type = "string"` becomes `Type = JsonSchemaType.String` (the schema type is a flags enum in Microsoft.OpenApi v2, not a string), and the namespace for `OpenApiParameter` and friends is `Microsoft.OpenApi`, not `Microsoft.OpenApi.Models`. **Verify:** request `/openapi/v1.json` and confirm every operation now carries the `X-Correlation-Id` header parameter.

### 3. Port an IOperationFilter that reads the endpoint

Conditional filters keyed off route, HTTP method, or metadata are where `OperationFilterContext` mattered. The `ApiDescription` you read is the same type; it is exposed as `context.Description`. The pattern of sniffing `EndpointMetadata` for an attribute carries over verbatim.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi;

internal sealed class ThrottleResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        var isRateLimited = context.Description.ActionDescriptor.EndpointMetadata
            .OfType<EnableRateLimitingAttribute>()
            .Any();

        if (isRateLimited)
        {
            operation.Responses ??= new OpenApiResponses();
            operation.Responses["429"] = new OpenApiResponse
            {
                Description = "Too many requests. Retry after the window resets."
            };
        }

        return Task.CompletedTask;
    }
}
```

If your old filter reached for `context.MethodInfo` to read a custom attribute, prefer `context.Description.ActionDescriptor.EndpointMetadata` instead, since minimal-API endpoints expose their metadata there and may not have a meaningful `MethodInfo`. **Verify:** pick one endpoint that carries the rate-limiting attribute and one that does not, and confirm only the first shows a `429` response in the document.

### 4. Port an ISchemaFilter that shapes a type

The schema filter body changes in exactly one place: `context.Type` becomes `context.JsonTypeInfo.Type`. Everything you did to `schema` stays the same.

```csharp
// Before -- Swashbuckle ISchemaFilter
public class DescribeTodoFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (context.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class DescribeTodoTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
        return Task.CompletedTask;
    }
}
```

**Verify:** find the `Todo` schema under `components.schemas` in the document and confirm the description is present.

### 5. Port an ISchemaFilter that targets a property

Swashbuckle told you a schema was a property schema by handing you a non-null `context.MemberInfo`. The built-in equivalent is a non-null `context.JsonPropertyInfo`. Because the built-in generator is driven by `System.Text.Json`, `JsonPropertyInfo.Name` is the serialized JSON name (already camel-cased if that is your policy), not the CLR member name, which removes a whole class of case-mismatch bugs.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class EmailFormatTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonPropertyInfo?.Name == "email")
        {
            schema.Format = "email";
        }
        return Task.CompletedTask;
    }
}
```

If your old filter read a custom attribute off `MemberInfo`, get it through `context.JsonPropertyInfo?.AttributeProvider?.GetCustomAttributes(...)`, which exposes the underlying `PropertyInfo`. **Verify:** confirm every `email` property across your schemas now carries `"format": "email"`.

### 6. Port an example provider

Schema examples are the single most likely thing to fail to compile. Microsoft.OpenApi v2 removed the entire `IOpenApiAny` hierarchy (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`). Examples are now `System.Text.Json.Nodes.JsonNode`.

```csharp
// Before -- Swashbuckle, IOpenApiAny example
schema.Example = new OpenApiString("dev@example.com");
```

```csharp
// After -- .NET 11, C# 14
using System.Text.Json.Nodes;

schema.Example = JsonValue.Create("dev@example.com");
```

For a composite example, build a `JsonObject` instead of an `OpenApiObject`: `new JsonObject { ["id"] = 1, ["title"] = "Write" }`. **Verify:** the `example` field on the target schema renders as valid JSON in the document and in your UI.

### 7. Port a filter that needed constructor arguments or services

Swashbuckle let you pass constructor arguments at registration (`c.OperationFilter<T>(arg1, arg2)`) or resolve services because filters were activated from the container. The built-in generic registration `options.AddOperationTransformer<T>()` activates the transformer from DI, so inject through a primary constructor instead of passing positional arguments.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class TosLinkTransformer(IOptions<ApiInfoOptions> options)
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.ExternalDocs = new OpenApiExternalDocs
        {
            Url = options.Value.TermsOfServiceUrl
        };
        return Task.CompletedTask;
    }
}
```

Only the generic overload participates in DI; `AddOperationTransformer(new T(...))` and the delegate overload do not. The generic form is resolved fresh per document generation and disposed afterward, so an `IDisposable` transformer is cleaned up each time the document is built. **Verify:** the injected value appears in the document, and the transformer resolves without a "no service for type" error at first request.

### 8. Port a filter that generated sub-schemas

The trickiest filters called `context.SchemaGenerator.GenerateSchema(type, context.SchemaRepository)` to build a schema for a type the operation did not otherwise reference, for example a shared error body. The built-in replacement is `context.GetOrCreateSchemaAsync(...)` plus `context.Document.AddComponent(...)`.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class ErrorResponseTransformer : IOpenApiOperationTransformer
{
    public async Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        var errorSchema = await context.GetOrCreateSchemaAsync(
            typeof(ProblemDetails), null, cancellationToken);
        context.Document?.AddComponent("Error", errorSchema);

        operation.Responses ??= new OpenApiResponses();
        operation.Responses["4XX"] = new OpenApiResponse
        {
            Description = "Bad request.",
            Content = new Dictionary<string, OpenApiMediaType>
            {
                ["application/problem+json"] = new OpenApiMediaType
                {
                    Schema = new OpenApiSchemaReference("Error", context.Document)
                }
            }
        };
    }
}
```

Note the typed `OpenApiSchemaReference("Error", context.Document)` instead of a hand-built `OpenApiReference`. **Verify:** the `Error` schema appears once under `components.schemas` and the operations reference it rather than inlining a copy. The transformer-first mechanics of `GetOrCreateSchemaAsync` are covered in depth in [customizing OpenAPI with operation and schema transformers](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Verification

Run this before deleting the old filter classes:

- `dotnet build` is clean with zero references to `Microsoft.OpenApi.Models` or `Swashbuckle.AspNetCore.SwaggerGen` filter interfaces.
- Diff the ported `/openapi/v1.json` against the baseline you saved in pre-flight. Expect the spec version and `nullable` handling to differ (3.1 vs 3.0); every response, header, description, and example your filters produced should match operation for operation.
- Every property a schema filter targeted still shows the same format, example, or description.
- `dotnet test` passes, including any contract test that asserted on the document shape.
- If you feed the document to a client generator, regenerate and confirm it still builds. See [generating a strongly typed client from an OpenAPI spec](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Rollback plan

This port is reversible until you delete the filter classes. Because each rewrite is a new transformer class beside the old filter, the safest rollback is the clean git baseline from pre-flight: `git checkout` the commit and re-add `c.OperationFilter<T>()` / `c.SchemaFilter<T>()` in the `AddSwaggerGen` block. Keep both the filters and the transformers in the tree until the ported document has run in a real environment, then delete the filters in a separate commit.

## Gotchas we hit

**Schema transformers run more than once for the same type.** A schema transformer fires per schema occurrence, and the pass that deduplicates identical schemas into `components.schemas` runs after transformers. A type used in three places has its transformer invoked three times, so keep the logic idempotent: check before you add, and never append to a list you might revisit. Swashbuckle's `ISchemaFilter` had a related sharp edge (it was not invoked for already-referenced schemas), so do not assume the old invocation count carries over.

**Execution order is schemas, then operations, then documents.** Filters in Swashbuckle ran in registration order within each kind. The built-in pipeline runs all schema transformers first, then operation transformers, then document transformers, and it runs per document generation. An operation transformer cannot depend on a document transformer having run, because documents run last. This trips up anyone who put a security scheme in a document transformer and tried to reference it from an operation transformer in the same pass.

**`context.Type` is now two hops away.** The most common compile error after a bulk find-and-replace is leaving `context.Type` in a schema transformer. It is `context.JsonTypeInfo.Type`. A close second is `context.MemberInfo`, which is `context.JsonPropertyInfo`.

**The document regenerates on every request.** `MapOpenApi` runs the full transformer pipeline each time the route is hit, so keep transformers cheap. For a busy document, cache it with `.CacheOutput()` on the endpoint or generate it at build time. Swashbuckle cached more aggressively, so a heavy filter that was fine before can show up as latency now.

**`OpenApiSchema` is a concrete type in the transformer, but `IOpenApiSchema` shows up elsewhere.** The transformer delegate hands you a mutable `OpenApiSchema`. Other v2 APIs return `IOpenApiSchema`, so a helper method that used to take `OpenApiSchema` may need the interface. If you wired up a security scheme through a document transformer and the viewer ignores the token, that is almost always a malformed scheme rather than a client bug, traced end to end in [why your Bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

The mental model is small once it clicks: a filter and a transformer both hand you the same OpenAPI object to mutate, so the body barely changes. The port is renaming context properties, switching to `JsonTypeInfo`, moving examples to `JsonNode`, and keeping schema logic idempotent because it now runs more than once. Do it filter by filter, diff against the baseline, and the document you serve is the one your consumers already expect.

## Related reading

- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to customize OpenAPI with operation and schema transformers in ASP.NET Core 11](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Scalar in ASP.NET Core: why your Bearer token is ignored](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)

## Sources

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [OpenApiSchemaTransformerContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.openapischematransformercontext)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
