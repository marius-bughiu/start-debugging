---
title: "How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer in ASP.NET Core 11"
description: "A deep dive into the built-in OpenAPI transformer pipeline in .NET 11: operation vs schema transformers, the context objects, execution order, DI-activated transformers, and recipes for headers, responses, examples, and per-property tweaks."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
---

The built-in `Microsoft.AspNetCore.OpenApi` generator in .NET 11 owns the OpenAPI document, and the way you change what it emits is with transformers. There are three: `AddDocumentTransformer` for the whole document, `AddOperationTransformer` for every path-plus-method operation, and `AddSchemaTransformer` for every data model. To add a header parameter or a shared response to all endpoints, use an operation transformer. To set a format, example, or description on a type or property, use a schema transformer. This post targets .NET 11 (`net11.0`, C# 14) with `Microsoft.AspNetCore.OpenApi` and `Microsoft.OpenApi` v2, and goes past the one-liners into the context objects, the execution order that trips people up, and the Microsoft.OpenApi v2 type changes that will not compile if you copy .NET 8 samples.

If you have not generated a document yet, start with [how to expose OpenAPI without Swashbuckle](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/); everything below assumes `builder.Services.AddOpenApi()` and `app.MapOpenApi()` are already in place.

## What each transformer is allowed to touch

The three transformer kinds are not interchangeable, and picking the wrong one is the most common mistake. The rule is about scope:

- A **document transformer** sees the entire `OpenApiDocument`. It is the right tool for `Info`, `servers`, top-level `tags`, and security schemes, because those live at the root.
- An **operation transformer** is invoked once per operation, where an operation is a unique path plus HTTP method (`GET /todos/{id}` is one operation, `POST /todos` is another). Reach for it when you want a change on every endpoint, or on endpoints that match a condition you can read from metadata.
- A **schema transformer** is invoked for every schema the generator produces, including nested ones. It is where you touch the shape of request and response bodies: formats, examples, descriptions, nullability, deprecation.

Trying to add a response to "all operations" from a document transformer means hand-walking `document.Paths`; using an operation transformer, the framework hands you each operation directly. The inverse is also true: setting `document.Info` from an operation transformer would run once per endpoint and overwrite itself. Match the transformer to the altitude of the thing you are changing.

## Four steps to add a global header and shape a schema

Here is the core procedure end to end. It registers one operation transformer that stamps a correlation-id header onto every endpoint, and one schema transformer that fixes the format of a type.

1. **Open the `AddOpenApi` options block.** All three `Add*Transformer` methods hang off `OpenApiOptions`, so you register inside the `AddOpenApi(options => { ... })` delegate.

2. **Register an operation transformer for the header.** The delegate signature is `(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)`. Mutate `operation` in place and return a `Task`.

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Description = "Client-supplied request id, echoed back in the response.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    });
});
```

3. **Register a schema transformer for the type.** Its delegate is `(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)`. The classic example is telling consumers that a `decimal` is money-precise, not a float:

```csharp
// .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(decimal))
    {
        schema.Format = "decimal";
    }
    return Task.CompletedTask;
});
```

4. **Regenerate and verify.** Request `/openapi/v1.json`. Every operation should now carry the `X-Correlation-Id` header parameter, and every `decimal` property should show `"format": "decimal"`. Because `MapOpenApi` regenerates the document on each request, there is nothing to restart beyond the app itself.

That is the whole loop. The rest of this post is the detail that makes these transformers reliable instead of surprising.

## The context objects, property by property

Each transformer gets a context, and the contexts differ because each transformer knows different things.

The **operation** context (`OpenApiOperationTransformerContext`) exposes `DocumentName`, `Description` (the `ApiDescription` for the endpoint), and `ApplicationServices` (the `IServiceProvider`). `Description` is the important one: it carries the route, HTTP method, and `ActionDescriptor.EndpointMetadata`, which is how you make a transformer conditional. For example, only add a `429` response to endpoints that actually have a rate-limiting policy attached:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.RateLimiting;

options.AddOperationTransformer((operation, context, cancellationToken) =>
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
});
```

The **schema** context (`OpenApiSchemaTransformerContext`) exposes `DocumentName`, `JsonTypeInfo`, `JsonPropertyInfo`, and `ApplicationServices`. `JsonTypeInfo` is the `System.Text.Json` metadata for the type being described, so `context.JsonTypeInfo.Type` is the CLR `Type`. `JsonPropertyInfo` is populated only when the schema is being generated for a specific property, which lets you target one member rather than a whole type:

```csharp
// .NET 11, C# 14
using System.Text.Json.Nodes;

options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    // Target the Email property on any type that has one.
    if (context.JsonPropertyInfo?.Name == "email")
    {
        schema.Format = "email";
        schema.Example = JsonValue.Create("dev@example.com");
    }

    return Task.CompletedTask;
});
```

The **document** context (`OpenApiDocumentTransformerContext`) exposes `DocumentName`, `DescriptionGroups` (the `ApiDescriptionGroups`), and `ApplicationServices`. You reach for document transformers when the target is the document root, most often the security scheme, which I cover below.

## Execution order is schema, then operation, then document

This is the part that produces "my change disappeared" bug reports. Transformers do not run in the order you might expect from reading the file. The framework runs them in this order:

- **Schema transformers first.** All schemas are registered to the document before any operation is processed, so every schema transformer runs before any operation transformer. Within schema transformers, they run in registration order, and a later one sees the mutations of an earlier one.
- **Operation transformers next.** Each runs when its operation is added, in registration order, after all schemas exist. By the time an operation transformer runs, the schemas for the types in that operation are already shaped.
- **Document transformers last.** They run on the final pass, when every operation and schema is present. A later document transformer sees the earlier one's edits.

The practical consequence: if a document transformer needs a schema to already be shaped a certain way, it will be, because schemas ran first. But an operation transformer cannot rely on a document transformer having run, because documents run last. When you generate multiple documents, the whole pipeline runs independently per document, so a transformer registered on the `internal` document never touches `public`.

## Strongly typed transformers and dependency injection

Inline delegates are fine for stateless tweaks. When a transformer needs a service, implement the interface and register the type so the framework activates it from DI. The interfaces are `IOpenApiDocumentTransformer`, `IOpenApiOperationTransformer`, and `IOpenApiSchemaTransformer`, each with a single `TransformAsync`. Use a primary constructor to inject:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider authenticationSchemeProvider) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        var schemes = await authenticationSchemeProvider.GetAllSchemesAsync();
        if (schemes.Any(s => s.Name == "Bearer"))
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                In = ParameterLocation.Header,
                BearerFormat = "JSON Web Token"
            };
        }
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

Register a DI-activated transformer with the generic overload (`AddDocumentTransformer<T>()`), a pre-built instance (`AddDocumentTransformer(new T())`), or a delegate. Only the generic form participates in dependency injection. The generic form is resolved fresh per document generation and disposed afterward, so a transformer that implements `IDisposable` is cleaned up each time the document is produced. That per-generation lifetime is why you should keep transformers cheap: with a live `MapOpenApi` endpoint, the pipeline runs on every request to the document route. If the document is expensive to build, cache the endpoint with `.CacheOutput()` or generate it at [build time](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) instead.

Registering a security scheme is the canonical document-transformer job. If you have wired up a scheme but the viewer still ignores the token, the cause is almost always a malformed scheme in the document rather than a client bug, which I traced end to end in [why your Bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/). For the matching per-endpoint Swagger UI flow, see [adding OpenAPI authentication flows](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

## Per-endpoint operation transformers

You do not always want a change on every operation. An operation transformer registered on a single endpoint runs only for that endpoint, via `AddOpenApiOperationTransformer` on the endpoint builder. Marking one route deprecated is a one-liner:

```csharp
// .NET 11, C# 14
app.MapGet("/v1/report", GenerateReport)
   .AddOpenApiOperationTransformer((operation, context, cancellationToken) =>
   {
       operation.Deprecated = true;
       operation.Description = "Superseded by /v2/report. Removed in the next major version.";
       return Task.CompletedTask;
   });
```

This scopes cleanly: no `context.Description` sniffing, no route matching, just the endpoint you attached it to. It pairs well with grouping endpoints, since a transformer attached to a group flows to every operation in it. See [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for that pattern.

## Generating a schema on the fly

Sometimes an operation transformer needs a schema for a type the endpoint does not otherwise reference, for example a shared error body. Since .NET 10, the transformer context exposes `GetOrCreateSchemaAsync`, which builds a schema with the same logic the generator uses, and `context.Document.AddComponent`, which parks it under `components.schemas` for reuse:

```csharp
// .NET 11, C# 14
options.AddOperationTransformer(async (operation, context, cancellationToken) =>
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
});
```

This is the clean way to document a consistent error contract without decorating every endpoint with `Produces<ProblemDetails>`. If you are shaping error responses themselves rather than just documenting them, that is a separate concern handled by [IProblemDetailsService](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Microsoft.OpenApi v2 type changes that break old samples

.NET 10 upgraded the `Microsoft.OpenApi` dependency to v2, and the object model changed in ways that will not compile if you paste a .NET 8 transformer. Three changes bite the most:

**`OpenApiSchema.Type` is now a flags enum, not a string.** In v1 you wrote `Type = "string"` with a separate `Nullable = true`. In v2, `Type` is a nullable `JsonSchemaType`, and nullability is expressed by unioning the `Null` flag:

```csharp
// .NET 11, Microsoft.OpenApi v2
// A nullable string:
schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
```

**Examples are `JsonNode`, not `OpenApiString`.** The entire `IOpenApiAny` hierarchy (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`) was removed. Assign a `System.Text.Json.Nodes.JsonNode` instead, which is why the property example above used `JsonValue.Create(...)`. For an object example, build a `JsonObject`. This is the single edit most likely to fail to compile when you migrate old schema filters, a point I go deeper on in the [Swashbuckle-to-built-in migration guide](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).

**References are typed.** Instead of hand-building an `OpenApiReference`, use `OpenApiSchemaReference("Name", document)` and `OpenApiSecuritySchemeReference("Bearer", document)`. These resolve against the document you pass, which catches a dangling reference at construction rather than at serialization.

## Gotchas that surface after the document looks right

**Schema transformers can run more than once for the same type.** A schema transformer fires per schema occurrence, and the pass that deduplicates identical schemas into `components.schemas` runs *after* all transformers. So a type used in three places can have its schema transformer invoked three times. Keep the logic idempotent: check before you add, and never append to a list you might revisit.

**Schema reuse is not something you control from a transformer.** Whether a schema is inlined or lifted into `components.schemas` is decided by the framework after transformers run, using `OpenApiOptions.CreateSchemaReferenceId`. Enums are always referenced; to inline them instead, return `null` from that delegate for enum types:

```csharp
// .NET 11, C# 14
options.CreateSchemaReferenceId = type =>
    type.Type.IsEnum ? null : OpenApiOptions.CreateDefaultSchemaReferenceId(type);
```

**An operation transformer cannot see a document transformer's work.** Because documents run last, do not put a scheme in a document transformer and try to reference it from an operation transformer in the same run. Register the scheme *and* the per-operation requirement from the same document transformer, or apply the requirement per operation from a document transformer that walks `document.Paths` at the end.

**Only what the API explorer sees gets documented.** Transformers shape what exists; they cannot invent an operation the explorer never discovered. If a minimal API returns a bare `IResult` with no `Produces<T>`, there is no response schema for a transformer to touch. Annotate the endpoint first. Accurate schemas matter downstream too, since a [strongly typed client generator](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) is only as good as the document you feed it.

The mental model is small once it clicks: schemas are shaped first, operations next, the document last, and each transformer only touches the layer it is named for. Pick the altitude, mutate in place, keep it idempotent, and the document you serve is exactly the one your consumers and code generators expect.

## Related reading

- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Migrate from Swashbuckle to the built-in OpenAPI document generation in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to add OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Scalar in ASP.NET Core: why your Bearer token is ignored](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)

## Sources

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [IOpenApiSchemaTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapischematransformer)
- [Breaking change: Microsoft.OpenApi upgraded to v2, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
