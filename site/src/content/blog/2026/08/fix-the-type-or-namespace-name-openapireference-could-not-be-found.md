---
title: "Fix: The type or namespace name 'OpenApiReference' could not be found"
description: "OpenApiReference was deleted in Microsoft.OpenApi 2.0. Changing the using to Microsoft.OpenApi is not enough: replace each usage with a typed reference such as OpenApiSchemaReference."
pubDate: 2026-08-11
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "openapi"
---

`OpenApiReference` no longer exists. Microsoft.OpenApi 2.0 both consolidated every model namespace into `Microsoft.OpenApi` and deleted the generic reference type, so swapping `using Microsoft.OpenApi.Models;` for `using Microsoft.OpenApi;` clears the namespace error and leaves this one behind. The fix is to replace each `new OpenApiReference { Type = ..., Id = "X" }` with the typed reference class for the component you were pointing at, for example `new OpenApiSchemaReference("X", document)` or `new OpenApiSecuritySchemeReference("Bearer", document)`. Everything below is verified against SDK 10.0.201, `Microsoft.AspNetCore.OpenApi` 10.0.10, and `Microsoft.OpenApi` 2.11.0.

## The error in context

There are two errors in this family and searchers land here with either one. If you still have the old `using` directives, the compiler complains about the namespace, not the type:

```
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
error CS0234: The type or namespace name 'Any' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
```

Delete those usings, or replace them with `using Microsoft.OpenApi;`, and you get the error that actually brought you here:

```
error CS0246: The type or namespace name 'OpenApiReference' could not be found (are you missing a using directive or an assembly reference?)
error CS0246: The type or namespace name 'OpenApiString' could not be found (are you missing a using directive or an assembly reference?)
error CS0117: 'OpenApiSecurityScheme' does not contain a definition for 'Reference'
error CS0029: Cannot implicitly convert type 'string' to 'Microsoft.OpenApi.JsonSchemaType?'
error CS1061: 'OpenApiDocument' does not contain a definition for 'SerializeAsJson'
```

That second block is the tell. `CS0234` means "the namespace moved". `CS0246` on `OpenApiReference` specifically means "the type is gone", and no using directive will bring it back.

## Why this happens

`Microsoft.AspNetCore.OpenApi` took a hard dependency on Microsoft.OpenApi 2.x starting with the 10.0 release, and .NET 11 carries that forward. Add the package to a bare `net10.0` web project and you can see the transitive pull:

```
> Microsoft.AspNetCore.OpenApi      10.0.10     10.0.10
   > Microsoft.OpenApi              2.0.0
```

Microsoft.OpenApi 2.0 made three changes that land on the same line of your code:

- **Namespaces were consolidated.** `Microsoft.OpenApi.Models`, `Microsoft.OpenApi.Any`, `Microsoft.OpenApi.Interfaces`, and `Microsoft.OpenApi.Writers` were merged into `Microsoft.OpenApi`. The public assembly now exposes exactly three namespaces: `Microsoft.OpenApi`, `Microsoft.OpenApi.Reader`, and `Microsoft.OpenApi.MicrosoftExtensions`.
- **`OpenApiReference` was removed**, along with the `Reference` property on every referenceable model. `OpenApiSecurityScheme` has no `Reference` member at all now, which is the `CS0117` above.
- **References became first-class types.** Instead of attaching a reference to an empty model, you construct a dedicated reference object that implements the same interface as the thing it points at.

If you are on Swashbuckle rather than the built-in generator, the same cliff exists one package over. Swashbuckle.AspNetCore 9.0.6 resolves `Microsoft.OpenApi` 1.6.25 and your old code keeps compiling; Swashbuckle.AspNetCore 10.1.0 resolves `Microsoft.OpenApi` 2.3.0 and it stops. Upgrading Swashbuckle is what breaks you, not upgrading the SDK.

## Minimal repro

This is the shape almost everyone has, usually inside a Swagger `AddSecurityRequirement` call copied from a JWT tutorial:

```csharp
// FAILS on .NET 10/11 with Microsoft.OpenApi 2.x
using Microsoft.OpenApi.Models;
using Microsoft.OpenApi.Any;

var reference = new OpenApiReference
{
    Type = ReferenceType.SecurityScheme,
    Id = "Bearer"
};

var scheme = new OpenApiSecurityScheme
{
    Reference = reference
};

var schema = new OpenApiSchema
{
    Type = "string",
    Default = new OpenApiString("hello")
};

var json = new OpenApiDocument().SerializeAsJson(OpenApiSpecVersion.OpenApi3_0);
```

Six lines, five distinct breaking changes. Fixing them one compiler error at a time is slow, so it helps to know the whole mapping up front.

## The fix, step by step

### 1. Replace the using directives

Every `Microsoft.OpenApi.*` model using collapses to one:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
using Microsoft.OpenApi;
using System.Text.Json.Nodes;   // needed wherever you used IOpenApiAny
```

A project-wide find and replace of `using Microsoft.OpenApi.Models;` to `using Microsoft.OpenApi;` is safe. Just delete `using Microsoft.OpenApi.Any;` and `using Microsoft.OpenApi.Interfaces;` outright.

### 2. Replace OpenApiReference with the typed reference

This is the part no `using` fixes. Microsoft.OpenApi 2.x ships one reference class per referenceable component, all with the same constructor shape `(string referenceId, OpenApiDocument hostDocument = null, string externalResource = null)`:

| Old `ReferenceType` | New type |
| --- | --- |
| `ReferenceType.Schema` | `OpenApiSchemaReference` |
| `ReferenceType.SecurityScheme` | `OpenApiSecuritySchemeReference` |
| `ReferenceType.Parameter` | `OpenApiParameterReference` |
| `ReferenceType.RequestBody` | `OpenApiRequestBodyReference` |
| `ReferenceType.Response` | `OpenApiResponseReference` |
| `ReferenceType.Header` | `OpenApiHeaderReference` |
| `ReferenceType.Example` | `OpenApiExampleReference` |
| `ReferenceType.Link` | `OpenApiLinkReference` |
| `ReferenceType.Callback` | `OpenApiCallbackReference` |
| `ReferenceType.Tag` | `OpenApiTagReference` |
| `ReferenceType.PathItem` | `OpenApiPathItemReference` |

So the security scheme reference becomes a single expression:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
// old: new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }
var schemeRef = new OpenApiSecuritySchemeReference("Bearer", document);
```

These reference types implement the interface of their target (`OpenApiSchemaReference` is an `IOpenApiSchema`, `OpenApiSecuritySchemeReference` is an `IOpenApiSecurityScheme`), so they slot straight into the collections that used to take the model itself.

### 3. Fix the collateral damage on the same lines

Three more renames usually show up in the same block:

- `OpenApiSchema.Type` went from `string` to the flags enum `JsonSchemaType`, whose members are `Null`, `Boolean`, `Integer`, `Number`, `String`, `Object`, and `Array`. Because it is a `[Flags]` enum you express OpenAPI 3.1 nullability as `JsonSchemaType.String | JsonSchemaType.Null` instead of a separate `Nullable` property.
- The whole `IOpenApiAny` hierarchy (`OpenApiString`, `OpenApiInteger`, `OpenApiArray`, `OpenApiObject`, and the rest) was deleted in favour of `JsonNode` from `System.Text.Json.Nodes`.
- `SerializeAsJson` and `SerializeAsYaml` are now async extension methods: `SerializeAsJsonAsync` and `SerializeAsYamlAsync`. `Maximum`, `Minimum`, `ExclusiveMaximum`, and `ExclusiveMinimum` changed from `double?` to `string?` so that arbitrary-precision numbers survive a round trip.

### 4. The complete working version

Here is the repro above, rewritten as the document transformer you would actually register in a .NET 11 app. This compiles clean against `Microsoft.AspNetCore.OpenApi` 10.0.10:

```csharp
// .NET 11, Microsoft.AspNetCore.OpenApi 10.0.10, Microsoft.OpenApi 2.11.0
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

public sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= new List<OpenApiSecurityRequirement>();
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = new List<string>()
        });

        return Task.CompletedTask;
    }
}
```

And the schema-side equivalents:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var schema = new OpenApiSchema
{
    Type = JsonSchemaType.String | JsonSchemaType.Null,   // was Type = "string" + Nullable = true
    Default = (JsonNode)"hello",                          // was new OpenApiString("hello")
    Enum = new List<JsonNode> { (JsonNode)"a", (JsonNode)"b" },
    Maximum = "100"                                       // was double? Maximum = 100
};

IOpenApiSchema widgetRef = new OpenApiSchemaReference("Widget", document);

string json = await document.SerializeAsJsonAsync(OpenApiSpecVersion.OpenApi3_1);
```

Serializing a document built this way produces exactly what you expect, with the security requirement rendered by scheme name and the component intact:

```json
{
  "openapi": "3.1.1",
  "components": {
    "securitySchemes": {
      "Bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [ { "Bearer": [ ] } ]
}
```

## Gotchas that bite after the code compiles

**Do not "fix" this by upgrading Microsoft.OpenApi to 3.x.** It is tempting, because 3.9.0 is the current version on NuGet while ASP.NET Core 10 pins 2.0.0. Add an explicit `PackageReference` for 3.9.0 to a project that uses the built-in generator and the build fails inside Microsoft's own generated code:

```
obj\Debug\net10.0\Microsoft.AspNetCore.OpenApi.SourceGenerators\...\OpenApiXmlCommentSupport.generated.cs(399,41):
error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only
```

The XML comment source generator that ships with `Microsoft.AspNetCore.OpenApi` 10.0.10 is written against the 2.x surface. Stay on the 2.x line until the ASP.NET Core package moves.

**Do pin Microsoft.OpenApi to 2.7.5 or later.** The 2.0.0 that ASP.NET Core 10.0.10 resolves transitively carries a high-severity advisory, and NuGet will tell you so at restore time:

```
warning NU1903: Package 'Microsoft.OpenApi' 2.0.0 has a known high severity vulnerability
```

That is CVE-2026-49451, uncontrolled recursion on circular schema references, affecting 2.0.0-preview.11 through 2.7.4 and 3.0.0 through 3.5.3. Adding an explicit `<PackageReference Include="Microsoft.OpenApi" Version="2.11.0" />` clears the warning and still builds clean against the 10.0.10 source generator. It matters most if your app parses OpenAPI documents you did not author.

**Collections no longer auto-initialize.** In 1.x, `new OpenApiDocument().Components` handed you an empty `OpenApiComponents`. In 2.x it is null, as are `Components.Schemas`, `Components.SecuritySchemes`, and `Document.Tags`. `Paths` and `Servers` are still initialized. This is why the transformer above uses `??=` on every level before indexing, and it is the single most common `NullReferenceException` right after a successful upgrade build.

**References resolve lazily through the document workspace.** If you build a document by hand rather than letting ASP.NET Core build it, a reference's `Target` stays null and its proxied properties come back empty until the components are registered:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var reference = new OpenApiSchemaReference("Widget", document);
// reference.Target is null here, reference.Description is empty

document.Workspace.RegisterComponents(document);
// reference.Target is now resolved, reference.Description reads through to the target
```

Resolution is lazy, so a reference created before the `RegisterComponents` call starts resolving correctly afterwards. Serialization emits the `$ref` either way; it is reads through the proxy that surprise you.

**Watch the interface types in transformer signatures.** `Components.Schemas` is an `IDictionary<string, IOpenApiSchema>` and `Components.SecuritySchemes` is an `IDictionary<string, IOpenApiSecurityScheme>`, not the concrete classes. Code that assumed the concrete type now needs a cast or a pattern match, because the value might be a reference object rather than an inline schema.

**`OpenApiSecuritySchemeReference` does not render as a `$ref`.** Its `Reference.ReferenceV3` is just `Bearer`, whereas `OpenApiSchemaReference("Widget").Reference.ReferenceV3` is `#/components/schemas/Widget`. That is correct per the OpenAPI spec: a security requirement keys off the scheme name. Do not go looking for a missing `$ref` in the output.

## Related

If you are working through a broader OpenAPI upgrade, these cover the neighbouring pieces: the move off Swashbuckle is walked through in [migrating from Swashbuckle to the built-in OpenAPI generator](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/), and the filter-to-transformer rewrite that usually accompanies it is in [porting IOperationFilter and ISchemaFilter to OpenAPI transformers](/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/). For the transformer API itself, see [customizing the document with AddOperationTransformer and AddSchemaTransformer](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/). Once the document builds again you still need somewhere to render it, which is covered in [serving OpenAPI documentation with Scalar](/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/). And if this error turned up as part of a larger jump, the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) lists the other packages that moved at the same time.

## Sources

- [OpenAPI.NET 2.0 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md), the authoritative list of removed types and renamed properties.
- [dotnet/aspnetcore issue 61123](https://github.com/dotnet/aspnetcore/issues/61123), the report of `OpenApiSecurityScheme.Reference` disappearing in .NET 10 Preview 2.
- [Swashbuckle.AspNetCore issue 3522](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3522), the namespace change as it hit Swashbuckle users.
- [GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc) / CVE-2026-49451, the advisory behind the `NU1903` warning.
