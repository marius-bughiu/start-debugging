---
title: "How to mark a controller action's response as nullable in ASP.NET Core's built-in OpenAPI document"
description: "Microsoft.AspNetCore.OpenApi only marks a response nullable when the action returns a bare T? (and, on .NET 10, not even Task<T?>). ActionResult<T?> and IActionResult lose the annotation on both .NET 10 and .NET 11 RC2. Here is why, a tested operation transformer that fixes it, and the 204 No Content trap that makes the spec lie unless you also change MVC's formatter."
pubDate: 2026-10-20
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "dotnet-11"
  - "dotnet-10"
  - "nullable-reference-types"
  - "how-to"
---

**Short answer:** on .NET 10 (`Microsoft.AspNetCore.OpenApi` 10.0.13) and .NET 11 RC2 (11.0.0-rc.2.26504.105), the built-in generator wraps a response schema in `oneOf: [{ "type": "null" }, ...]` only when the action's own return type is nullable: `Person?`, plus `Task<Person?>` on .NET 11. It never looks inside `ActionResult<Person?>`, and `IActionResult` with `[ProducesResponseType<Person>]` has nothing to look at, so both come out non-nullable. Register an operation transformer that reads the action's `MethodInfo` with `NullabilityInfoContext`, unwraps `Task<>` and `ActionResult<>`, and wraps the 2xx schema itself (code below, tested on both versions). Then decide what null really means on the wire, because MVC sends **204 No Content** for a null result by default, not `200` with `null`.

I hit this while generating a client with Kiota from a controller API: the generated method for `GET /people/{id}` returned a non-nullable `Person`, even though the action was declared `ActionResult<Person?>`. Everything below was measured against a scratch app on SDK 10.0.302 (runtime 10.0.10) and SDK 11.0.100-rc.2.26504.105, by dumping `/openapi/v1.json` and curling each endpoint.

## What the generator emits for each return shape

The test controller has one action per shape, all returning `null`, with `<Nullable>enable</Nullable>`:

```csharp
// .NET 10 / .NET 11 RC2, C# 14, <Nullable>enable</Nullable>
[ApiController]
[Route("people")]
public class PeopleController : ControllerBase
{
    [HttpGet("plain")]
    public Person? GetPlain() => null;

    [HttpGet("taskplain")]
    public async Task<Person?> GetTaskPlain() { await Task.Yield(); return null; }

    [HttpGet("actionresult")]
    public ActionResult<Person?> GetActionResult() => (Person?)null;

    [HttpGet("task")]
    public async Task<ActionResult<Person?>> GetTask() { await Task.Yield(); return (Person?)null; }

    [HttpGet("attr")]
    [ProducesResponseType<Person>(StatusCodes.Status200OK)]
    public IActionResult GetAttr() => Ok(null);

    [HttpGet("arint")]
    public ActionResult<int?> GetArInt() => (int?)null;
}
```

This is the `200` response schema each one produced:

| Return type | .NET 10.0.13 | .NET 11 RC2 |
|---|---|---|
| `Person?` | nullable (`oneOf`) | nullable (`oneOf`) |
| `Task<Person?>` | **not nullable** | nullable |
| `ActionResult<Person?>` | **not nullable** | **not nullable** |
| `Task<ActionResult<Person?>>` | **not nullable** | **not nullable** |
| `IActionResult` + `[ProducesResponseType<Person>]` | **not nullable** | **not nullable** |
| `ActionResult<int?>` | `type: ["null", "integer", "string"]`, no `oneOf` | nullable (`oneOf`) |
| Minimal API `Person? () => null` | nullable (`oneOf`) | nullable (`oneOf`) |

"Nullable" here means the schema came out as:

```json
"schema": {
  "oneOf": [
    { "type": "null" },
    { "$ref": "#/components/schemas/Person" }
  ]
}
```

and "not nullable" means a bare `{ "$ref": "#/components/schemas/Person" }`. The `Person` component itself is never marked nullable. That is deliberate: since .NET 10 RC1 ([dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)) the generator keeps one shared component per type and expresses nullability at the use site with an inline `oneOf` wrapper, so a type that is nullable in one endpoint and non-nullable in another does not fork into two components.

## Why ActionResult<T?> loses the annotation

The decision lives in one internal method, `TypeExtensions.ShouldApplyNullableResponseSchema` in `src/OpenApi/src/Extensions/TypeExtensions.cs`. On the `v10.0.0` tag it does this:

1. Get the action's `MethodInfo` from the `ControllerActionDescriptor`.
2. Unwrap `Task<T>` or `ValueTask<T>` from `MethodInfo.ReturnType`.
3. If that type is not *equal* to `ApiResponseType.Type` (the type ApiExplorer reports for the response), return `false`.
4. Otherwise run `NullabilityInfoContext.Create(methodInfo.ReturnParameter)` and check `WriteState == Nullable`.

Step 3 is where `ActionResult<Person?>` falls out. ApiExplorer reports the response type as `Person`, the method returns `ActionResult<Person>`, the two types are not equal, done. It never reaches the nullability check. The same goes for `IActionResult` with an attribute: the return type is `IActionResult`, the response type is `Person`.

Step 4 explains the .NET 10 `Task<Person?>` miss. The unwrapped type matches, but the nullability check runs on the *original* return parameter, which is `Task<Person?>`. The `Task` itself is not nullable, so `WriteState` is `NotNull`.

[dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661), merged in July 2026 and shipped in .NET 11, rewrote the method. It now short-circuits on `ModelMetadata.IsNullableValueType` (which fixes `ActionResult<int?>`), and for reference types it walks `NullabilityInfo.GenericTypeArguments[0]` through `Task<>`/`ValueTask<>` (which fixes `Task<Person?>`). It does not unwrap `ActionResult<>`, so for a reference type, `NullabilityInfo` stops at `ActionResult<Person?>`, which is not null, and the result is still `false`. The PR description says as much: reference-type handling "is still not handled very well in this PR". The RC2 tag and `main` have the same code as RC1, so do not expect this to change before GA.

## Fix: an operation transformer that unwraps ActionResult<T>

The built-in pipeline gives you the full `ApiDescription` in an operation transformer, which is enough to redo the check correctly. This transformer handles two cases: nullability it can infer from the return type, and an explicit `[NullableResponse(statusCode)]` attribute for `IActionResult` actions where there is nothing to infer.

```csharp
// .NET 10 and .NET 11 (Microsoft.AspNetCore.OpenApi 10.0.x / 11.0.0-rc.2)
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class NullableResponseAttribute(int statusCode) : Attribute
{
    public int StatusCode { get; } = statusCode;
}

public sealed class NullableResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.Description.ActionDescriptor is not ControllerActionDescriptor action
            || operation.Responses is null)
        {
            return Task.CompletedTask;
        }

        // 1. Explicit opt-in: [NullableResponse(200)]
        var statusCodes = action.MethodInfo
            .GetCustomAttributes<NullableResponseAttribute>()
            .Select(a => a.StatusCode)
            .ToHashSet();

        // 2. Inferred from the return type: T?, ActionResult<T?>, and their Task/ValueTask forms
        if (TryGetNullableResponseType(action.MethodInfo, out var valueType))
        {
            foreach (var responseType in context.Description.SupportedResponseTypes)
            {
                if (responseType.Type == valueType && responseType.StatusCode is >= 200 and < 300)
                {
                    statusCodes.Add(responseType.StatusCode);
                }
            }
        }

        foreach (var statusCode in statusCodes)
        {
            if (!operation.Responses.TryGetValue(statusCode.ToString(), out var response)
                || response.Content is null)
            {
                continue;
            }

            foreach (var mediaType in response.Content.Values)
            {
                // Microsoft.OpenApi 3.x (.NET 11) exposes IOpenApiMediaType with a read-only Schema.
                if (mediaType is OpenApiMediaType { Schema: { } schema } concrete && !IsNullWrapper(schema))
                {
                    concrete.Schema = new OpenApiSchema
                    {
                        OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, schema]
                    };
                }
            }
        }

        return Task.CompletedTask;
    }

    private static bool TryGetNullableResponseType(MethodInfo method, out Type? valueType)
    {
        var type = method.ReturnType;
        var nullability = new NullabilityInfoContext().Create(method.ReturnParameter);

        if (type.IsGenericType
            && (type.GetGenericTypeDefinition() == typeof(Task<>)
                || type.GetGenericTypeDefinition() == typeof(ValueTask<>)))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ActionResult<>))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        valueType = type;
        return nullability.WriteState == NullabilityState.Nullable;
    }

    private static bool IsNullWrapper(IOpenApiSchema schema) =>
        schema.OneOf?.Any(s => s.Type == JsonSchemaType.Null) == true;
}
```

Register it on every document you expose:

```csharp
// .NET 10 / .NET 11 RC2
builder.Services.AddControllers();
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

And use the attribute where the return type says nothing:

```csharp
// .NET 10 / .NET 11 RC2
[HttpGet("attr")]
[ProducesResponseType<Person>(StatusCodes.Status200OK)]
[NullableResponse(StatusCodes.Status200OK)]
public IActionResult GetAttr() => Ok(null);
```

With the transformer registered, every row in the table above came out as the `oneOf` wrapper on both versions, including `Task<Person?>` on .NET 10. A non-nullable `ActionResult<Person>` stayed a plain `$ref`.

A few design choices worth calling out:

- **It wraps the use site, not the component.** That matches what the framework itself does since #63301. If you instead set `Type |= JsonSchemaType.Null` on the `Person` component in a schema transformer, every endpoint that returns `Person` becomes nullable, including the ones that never return null.
- **It only touches 2xx responses whose type matches the declared `T`.** A `404` with `ProblemDetails` on the same action is left alone.
- **It is idempotent.** If the framework already wrapped the schema (bare `Person?`, or `Task<Person?>` on .NET 11), `IsNullWrapper` skips it, so you do not get `oneOf` inside `oneOf`. When the framework catches up with `ActionResult<T?>`, the transformer silently becomes a no-op.
- **The `is OpenApiMediaType` pattern is there for .NET 11.** `Microsoft.AspNetCore.OpenApi` 10.0.13 pulls in `Microsoft.OpenApi` 2.x, where `Content` values are the concrete `OpenApiMediaType`. The 11.0 RC2 package pulls in `Microsoft.OpenApi` 3.10.2, where `Content` is `IDictionary<string, IOpenApiMediaType>` and `IOpenApiMediaType.Schema` has no setter. Assigning through the interface fails with `CS0200: Property or indexer 'IOpenApiMediaType.Schema' cannot be assigned to -- it is read only`. The pattern match compiles against both.

For the general mechanics of transformers (ordering, DI activation, the context object), see [the transformer deep dive](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## The trap: a null controller result is 204, not 200

Here is what the same endpoints actually returned on the wire, identical on .NET 10 and .NET 11 RC2:

```text
GET /people/actionresult   -> HTTP/1.1 204 No Content   (no body)
GET /people/plain          -> HTTP/1.1 204 No Content
GET /people/taskplain      -> HTTP/1.1 204 No Content
GET /minimal/maybe         -> HTTP/1.1 200 OK, application/json, body: null
```

MVC registers `HttpNoContentOutputFormatter` by default, and its `TreatNullValueAsNoContent` property defaults to `true`: any `null` object result becomes a `204` with an empty body. Minimal APIs do not have that formatter, so they really do send `200` with the JSON literal `null`.

That means for controllers, the framework's own `oneOf` wrapper on a bare `Person?` already describes a response the server never sends: a client generated from that spec expects `200` with `null` and gets `204`. So pick one of two honest contracts.

### Option A: keep 204 and document it

Leave MVC alone, keep the `200` schema non-nullable, and declare the `204`:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 204 No Content
[HttpGet("{id:int}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status204NoContent)]
public async Task<ActionResult<Person?>> Get(int id) => await _people.FindAsync(id);
```

In this setup you do not want the nullable wrapper on `200`, so do not register the transformer, and be aware that a bare `Person?` return still gets the wrapper from the framework. Most client generators treat a bodiless `204` as "no result", which is usually what callers want anyway.

### Option B: send 200 with null and mark 200 nullable

Turn off the no-content conversion, then let the transformer describe it:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 200 OK with body "null"
using Microsoft.AspNetCore.Mvc.Formatters;

builder.Services.AddControllers(o =>
{
    var noContent = o.OutputFormatters.OfType<HttpNoContentOutputFormatter>().Single();
    noContent.TreatNullValueAsNoContent = false;
});
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

After this change, `GET /people/actionresult` returned `HTTP/1.1 200 OK`, `Content-Type: application/json; charset=utf-8`, body `null`, which is exactly what the `oneOf` schema says. A `void` action was unaffected (it returned `200` with an empty body before and after the change). The Microsoft Learn formatting page shows the other way to do it, `o.OutputFormatters.RemoveType<HttpNoContentOutputFormatter>()`; I prefer flipping the property because it states the intent and leaves the formatter's other cases alone.

Use Option B when the API is consumed by something that already expects `200`/`null`, or when you are migrating endpoints between controllers and minimal APIs and want them to behave the same. Use Option A for everything else; it is the framework default and needs no transformer.

## Gotchas and edge cases

**Adding any `[ProducesResponseType]` drops the inferred 200.** In my first test I put only `[ProducesResponseType(StatusCodes.Status404NotFound)]` on the `ActionResult<Person?>` action, and the `200` response disappeared from the document entirely, so the transformer had nothing to wrap. Once an action has explicit response metadata, ApiExplorer stops adding the default `200` for `ActionResult<T>`. Add `[ProducesResponseType(StatusCodes.Status200OK)]` (no type needed, `T` is filled in) next to your error codes.

**`string?` is not JSON.** A `string?` action returning null came back as `200` with `Content-Type: text/plain` and an empty body once `TreatNullValueAsNoContent` was off, because `StringOutputFormatter` wins for strings. The document still advertises `application/json` with a nullable string. If you return strings from controllers, add `[Produces("application/json")]` or return a small DTO.

**OpenAPI 3.0 output looks different but means the same thing.** With `o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0`, `Microsoft.OpenApi` serializes the null branch as `{ "enum": [null], "nullable": true }` inside the `oneOf`. That is valid 3.0 and generators understand it. The default is `3.1.1` on .NET 10 and `3.2.0` on .NET 11; if Swagger UI refuses the 3.2 document, see [the Swagger UI fix for .NET 11](/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/).

**Nullable context matters.** `NullabilityInfoContext` reads the compiler's `[Nullable]` metadata. In a file or project with nullable reference types disabled, `Person?` is a warning and `Person` is reported as `Unknown`, not `Nullable`, so neither the framework nor the transformer marks anything. That is the right outcome: oblivious code makes no promise either way.

**Typed results are a separate code path.** Minimal APIs and controllers that return `Results<Ok<Person>, NotFound>` describe responses through `IEndpointMetadataProvider`, not through the method's return type. I checked both a minimal API returning `Results<Ok<Person?>, NotFound>` and a controller action returning `Ok<Person?>`: on .NET 10 and .NET 11 RC2 the `200` schema was a plain `Person` reference. The transformer above does not infer anything from `Ok<T>` either, so put `[NullableResponse(200)]` on those controller actions (for minimal APIs, use `AddOperationTransformer` with a check on the route instead, since there is no `ControllerActionDescriptor`). If you are choosing between the shapes, [typed results vs IResult vs IActionResult](/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/) covers what each one tells ApiExplorer.

**Do not "fix" it in a schema transformer.** It is tempting to make `Person` nullable globally so that every `$ref` accepts null. You lose the distinction between endpoints, and with OpenAPI 3.1+ the `oneOf` wrapper the framework adds elsewhere then has two branches that both match `null`, which makes `oneOf` fail validation (it requires exactly one match). PR #67661 calls out that exact reason for keeping the inner schema non-nullable.

## Read next

- [How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer in ASP.NET Core 11](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Typed results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11](/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to generate strongly typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Fix: Swagger UI shows Unable to render this definition after upgrading to .NET 11](/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)

## Sources

- [TypeExtensions.cs (`ShouldApplyNullableResponseSchema`), dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/OpenApi/src/Extensions/TypeExtensions.cs)
- [Fix nullability handling in OpenApi, dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661)
- [Model nullable types using oneOf in OpenAPI schema, dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)
- [Model nullable types using allOf in JSON schema (tracking issue), dotnet/aspnetcore#63029](https://github.com/dotnet/aspnetcore/issues/63029)
- [Customize OpenAPI documents, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi)
- [Format response data in ASP.NET Core Web API (special-case formatters), Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/web-api/advanced/formatting)
- [HttpNoContentOutputFormatter.TreatNullValueAsNoContent, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.formatters.httpnocontentoutputformatter.treatnullvalueasnocontent)
- [NullabilityInfoContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.nullabilityinfocontext)
