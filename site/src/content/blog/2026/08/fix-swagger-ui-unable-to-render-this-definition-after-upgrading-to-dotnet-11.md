---
title: "Fix: Swagger UI shows Unable to render this definition after upgrading to .NET 11"
description: "ASP.NET Core 11 emits openapi 3.2.0 by default and Swagger UI below 10.1.5 rejects it. Upgrade Swashbuckle.AspNetCore.SwaggerUI, or pin OpenApiVersion back to OpenApi3_1."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "openapi"
  - "swagger"
  - "swashbuckle"
  - "aspnetcore"
  - "dotnet-11"
---

Your API still starts, `/openapi/v1.json` still returns 200, but the Swagger UI page renders a grey box saying the definition does not specify a valid version field. The cause is a default change in .NET 11: `AddOpenApi` now writes `"openapi": "3.2.0"` instead of `"openapi": "3.1.1"`, and the Swagger UI bundle shipped in `Swashbuckle.AspNetCore.SwaggerUI` 10.1.4 and earlier only accepts `3.0.x` and `3.1.x`. Upgrade that package to 10.1.5 or later, or set `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1` and move on. Nothing about your endpoints, transformers, or schemas is broken.

Everything below was measured on .NET SDK `11.0.100-preview.7.26381.103` with `Microsoft.AspNetCore.OpenApi` `11.0.0-preview.7.26381.103` (which resolves `Microsoft.OpenApi` 3.9.0), compared against .NET SDK 10.0.201 with `Microsoft.AspNetCore.OpenApi` 10.0.10.

## The error in context

Swagger UI replaces the entire operations list with this panel:

```text
Unable to render this definition

The provided definition does not specify a valid version field.

Please indicate a valid Swagger or OpenAPI version field. Supported version
fields are swagger: "2.0" and those that match openapi: 3.x.y (for example,
openapi: 3.1.0).
```

The wording is misleading in two ways. The document does have a version field, and `3.2.0` does match the shape `3.x.y` that the message describes. What the bundle actually does is compare the major and minor components against a fixed allow-list, and `3.2` is not on it in older builds.

There is no server-side exception to find. The document endpoint is healthy:

```bash
curl -s http://localhost:5331/openapi/v1.json | head -3
```

```json
{
  "openapi": "3.2.0",
  "info": {
```

That first line is the whole bug. If you see `3.2.0` there and a grey box in the browser, you are on the right page.

## Why .NET 11 emits openapi 3.2.0

`OpenApiOptions.OpenApiVersion` changed its default from `OpenApiSpecVersion.OpenApi3_1` to `OpenApiSpecVersion.OpenApi3_2` in .NET 11 Preview 6. Microsoft documents this as an intentional behavioural change so apps pick up the newest specification without extra configuration ([OpenApiVersion defaults to OpenApi3_2](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0)).

That default became reachable because of a second change one preview earlier: in .NET 11 Preview 3, `Microsoft.AspNetCore.OpenApi` moved from `Microsoft.OpenApi` 2.x to 3.x, and the 3.x line is what added serializers for OpenAPI 3.2.0 ([Microsoft.OpenApi upgraded to 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)). The dependency pin is visible in the package itself: `Microsoft.AspNetCore.OpenApi` 11.0.0-preview.7 declares `Microsoft.OpenApi` `[3.9.0, 4.0.0)`, where 10.0.10 declared `2.0.0`.

The important consequence is that the version string moved but the document did not. More on that below.

## Minimal repro

Three lines of API and one Swagger UI registration are enough.

```xml
<!-- net11.0, .NET SDK 11.0.100-preview.7.26381.103 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0-preview.7.26381.103" />
    <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.OpenApi 11.0.0-preview.7.26381.103
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));

app.MapGet("/todos/{id:int}", (int id) => new Todo(id, "write post", Status.Open, null));
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.Run();

internal enum Status { Open, Done }
internal record Todo(int Id, string Title, Status Status, DateTimeOffset? DueAt);
```

Load `/swagger` and you get the grey box. Nothing in the console, nothing in the logs, HTTP 200 on both the page and the document.

Note that `Swashbuckle.AspNetCore.SwaggerUI` is a standalone package. You do not need the Swashbuckle generator to hit this: the document here comes from the built-in generator, and only the UI assets come from Swashbuckle. If you followed a guide on [exposing OpenAPI without Swashbuckle](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) but kept the familiar `/swagger` page, this is exactly the configuration you are running.

## Which Swagger UI version first renders a 3.2.0 document

I bisected the package against the same 3.2.0 document. The boundary is `Swashbuckle.AspNetCore.SwaggerUI` 10.1.5:

| SwaggerUI package | Bundled swagger-ui | Renders `openapi: 3.2.0` |
| --- | --- | --- |
| 9.0.6 | 5.29.1 | No |
| 10.0.0 | 5.30.2 | No |
| 10.1.0 | 5.31.0 | No |
| 10.1.4 | 5.31.1 | No |
| 10.1.5 | 5.32.0 | Yes |
| 10.1.7 | 5.32.1 | Yes |
| 10.2.3 | 5.32.7 | Yes |

On 10.1.5 and later the header badge reads `OAS 3.2` and every operation and schema renders normally. So the first fix is a one-line package bump:

```xml
<!-- first version whose bundled swagger-ui accepts 3.2.0 -->
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.1.5" />
```

Prefer this one. It keeps your document on the newest specification and costs nothing, because `Swashbuckle.AspNetCore.SwaggerUI` only ships static assets and one middleware extension. If you reference the full `Swashbuckle.AspNetCore` metapackage instead, bumping it to 10.2.x pulls the same UI assets but drags the generator along too; read the notes on [pinning the OpenAPI version string Swashbuckle emits](/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/) before you cross that boundary.

## How to pin the document back to OpenAPI 3.1

If you cannot move the UI package, or if something else downstream also refuses 3.2, set the version explicitly on the generator:

```csharp
// .NET 11, C# 14. Microsoft.OpenApi 3.9.0 supplies OpenApiSpecVersion.
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
});
```

The `using Microsoft.OpenApi;` matters: `OpenApiSpecVersion` lives in the flat root namespace, not in `Microsoft.OpenApi.Models`, which was removed back in the 2.x line that shipped with .NET 10.

With that option set, .NET 11 writes `"openapi": "3.1.2"`, and `Swashbuckle.AspNetCore.SwaggerUI` 9.0.6 renders it with an `OAS 3.1` badge. Note the patch component: .NET 10 wrote `3.1.1`, and .NET 11 with the same enum value writes `3.1.2`. Consumers that string-match the full version rather than the major and minor will still trip. `OpenApiSpecVersion.OpenApi3_0` is also still accepted and produces `3.0.4`.

You can register more than one named document if different consumers need different versions:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("v1");                                   // 3.2.0
builder.Services.AddOpenApi("v1-31", o =>
    o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);               // 3.1.2
```

That gives you `/openapi/v1.json` and `/openapi/v1-31.json` off the same endpoint metadata, so a legacy code generator can keep consuming 3.1 while the UI and newer clients read 3.2.

## What is actually inside the 3.2.0 document

This is the part worth internalising before you spend an afternoon auditing transformers: for a normal minimal API, the 3.2.0 document and the 3.1.2 document are identical apart from the version string.

I generated all three versions from one app (a record with an int, a string, an enum, a nullable `DateTimeOffset`, plus an `IFormFile` upload) and diffed them. The 3.1 to 3.2 diff was two lines, both of them the `openapi` field and the document title. Not one schema, parameter, response, or component changed.

The 3.0 to 3.1 diff, by contrast, is real, because that is where JSON Schema alignment landed:

```json
// OpenAPI 3.0.4
"dueAt": { "type": "string", "format": "date-time", "nullable": true }
```

```json
// OpenAPI 3.1.2 and 3.2.0
"dueAt": { "type": ["null", "string"], "format": "date-time" }
```

So if a client generator breaks after you upgrade to .NET 11 and you "fix" it by dropping to `OpenApi3_0`, you have changed the nullability encoding of every optional property in your contract. Drop to `OpenApi3_1` instead: that is the version whose payload is byte-for-byte what you were already shipping on .NET 10.

## Does Scalar have the same problem

If you serve your reference with [Scalar instead of Swagger UI](/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), this error does not reach you. I ran the same .NET 11 app against `Scalar.AspNetCore` 2.16.20 and 2.14.14, and both rendered the 3.2.0 document, printing `OpenAPI 3.2.0` in the header.

That holds even though the NuGet graph looks alarming. `Scalar.AspNetCore.Microsoft` 2.16.20 has no `net11.0` target group at all, so a `net11.0` project resolves its `net10.0` assets, which were compiled against `Microsoft.OpenApi` 2.7.5 and then get loaded against the unified 3.9.0 assembly at runtime. That is precisely the binary-compatibility hazard the Microsoft.OpenApi 3.x breaking-change note warns about, and it happens to be benign here: `AddScalarTransformers()` and `ExcludeFromApiReference()` both worked, emitting the expected `x-scalar-ignore` extension.

The same applies to hand-written transformers. A document transformer that registers a bearer security scheme and a schema transformer that stamps `x-schema-id`, both written for .NET 10 against `Microsoft.OpenApi` 2.x, compiled and ran unchanged on .NET 11 with 3.9.0. If your transformers are read-mostly, or only set extensions and security schemes, budget zero for the 2.x to 3.x move. If they walk nested schemas, construct references, or used the removed `ParseNode` parsing infrastructure, read the [transformer pipeline reference](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) and the OpenAPI.NET migration notes first.

## Which lookalike failures are not this bug

**A blank page with no grey box at all.** That is a different failure: the UI never received a document. Check the route. `MapOpenApi` serves `/openapi/{documentName}.json`, and if you changed the pattern you must tell the UI, either with `SwaggerEndpoint` or with Scalar's `WithOpenApiRoutePattern`. Curl the JSON URL the page is actually requesting before blaming versions.

**HTTP 500 on the document URL.** Then a transformer threw and there was nothing to render. The most common one is not a .NET 11 regression at all: `OpenApiSchema.Extensions` is `null` until you assign to it, on both `Microsoft.OpenApi` 2.x and 3.x, so `schema.Extensions["x-foo"] = ...` throws a `NullReferenceException` on .NET 10 and .NET 11 alike. Guard it:

```csharp
// .NET 11, C# 14, Microsoft.OpenApi 3.9.0
options.AddSchemaTransformer((schema, context, ct) =>
{
    schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
    schema.Extensions["x-schema-id"] =
        new JsonNodeExtension(JsonValue.Create(context.JsonTypeInfo.Type.Name));
    return Task.CompletedTask;
});
```

**`error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only`.** This one is a genuine .NET 11 side effect, and it shows up in mixed solutions. If a `net10.0` project ends up resolving `Microsoft.OpenApi` 3.9.0, through central package management, a floating version, or a shared reference from a `net11.0` app, the .NET 10 SDK's OpenAPI XML-comment source generator fails to compile against the 3.x object model. Keep the `net10.0` projects on `Microsoft.OpenApi` 2.x rather than floating the whole solution to one version.

**`System.MissingMethodException: Method not found: '... Microsoft.OpenApi.OpenApiOperation.get_Extensions()'`.** This is the binary-compatibility failure mode, and it means some library in your graph was compiled against a `Microsoft.OpenApi` surface that no longer exists at runtime. The .NET 11 upgrade does not cause it on its own; look for a package pinned well behind the rest, or an explicit `Microsoft.OpenApi` reference in your own csproj fighting the transitive one.

## Related

- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Fix: cannot target OpenAPI 3.0 after upgrading Swashbuckle.AspNetCore to v9](/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)
- [How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [How to serve OpenAPI documentation with Scalar instead of Swagger UI](/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)
- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)

## Sources

- [Breaking change: OpenApiVersion defaults to OpenApi3_2](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0), Microsoft Learn
- [Breaking change: Microsoft.OpenApi upgraded to 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0), Microsoft Learn
- [Generate OpenAPI documents](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0), Microsoft Learn
- [OpenAPI.NET release notes](https://github.com/microsoft/OpenAPI.NET/releases), microsoft/OpenAPI.NET on GitHub
- [Scalar.AspNetCore.Microsoft fails on transformers](https://github.com/scalar/scalar/issues/6020), scalar/scalar issue 6020
