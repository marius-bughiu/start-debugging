---
title: "Nullable enums in .NET 10 built-in OpenAPI vs Swashbuckle: getting `MyEnum?` back in generated clients"
description: "Why NSwag and Kiota turn a nullable enum from Microsoft.AspNetCore.OpenApi into an empty `MyEnum2` class or an `int?`, why switching to OpenAPI 3.0 does not reliably fix it, and a schema transformer that does, tested on .NET 10.0.15 and 11.0.0."
pubDate: 2026-11-16
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "swashbuckle"
  - "nswag"
  - "kiota"
  - "dotnet-10"
  - "dotnet-11"
---

**Short answer:** the `oneOf: [{ "type": "null" }, { "$ref": "..." }]` shape that `Microsoft.AspNetCore.OpenApi` 10.x and 11.0 emit for a `MyEnum?` property is not the problem: NSwag 13.18 and 14.8 both turn it into `MyEnum?`. Two other defects are. If an enum is only (or first) used as `MyEnum?`, the generator writes `null` into the shared `MyEnum` component, and NSwag then emits an empty `MyEnum2` class. And if the enum is serialized as an integer, the component is just `{ "type": "integer" }` with no values, so every generator falls back to `int?`. A schema transformer that strips the `null` and fills in integer values (shown below) gives `MyEnum?` back on both OpenAPI 3.1 and 3.0 output. Setting `OpenApiVersion = OpenApiSpecVersion.OpenApi3_0`, the common workaround, did not change the generated client in any of the cases tested here.

Everything below was checked on macOS (Apple Silicon) with ASP.NET Core 10.0.10 runtime + `Microsoft.AspNetCore.OpenApi` 10.0.15 + `Swashbuckle.AspNetCore` 10.3.1, and with SDK 11.0.100 + `Microsoft.AspNetCore.OpenApi` 11.0.0 + `Swashbuckle.AspNetCore` 11.0.1. Clients were generated with `NSwag.ConsoleCore` 14.8.0, `NSwag.ConsoleCore` 13.18.2 (the version Visual Studio's "Connected Services" stamps into generated code) and `Microsoft.OpenApi.Kiota` 1.38.0. .NET 10 and .NET 11 produced the same enum and property schemas in every scenario; only the `openapi` version string differs (3.1.1 vs 3.2.0 by default).

## The symptom people hit after leaving Swashbuckle

The [Stack Overflow question](https://stackoverflow.com/questions/79924789) and [dotnet/aspnetcore#66295](https://github.com/dotnet/aspnetcore/issues/66295) describe the same thing: after moving from Swashbuckle to the built-in generator, a regenerated client has a property typed as `MyEnum2` (or `Priority2`, or whatever your enum is called plus `2`), and that type is a class with nothing in it except `AdditionalProperties`. The client compiles, but you cannot assign or read the enum anymore.

The issue was closed on the assumption that the client tooling does not understand OpenAPI 3.1's `"type": "null"`. That is not what the repro below shows: older and newer NSwag both read the 3.1 shape correctly when the component is clean.

## A repro that separates the two bugs

One minimal API exposes all three documents from the same model: built-in 3.1, built-in 3.0, and Swashbuckle 3.0.

```csharp
// .NET 10, Microsoft.AspNetCore.OpenApi 10.0.15, Swashbuckle.AspNetCore 10.3.1
// (identical results on .NET 11.0.0 / Microsoft.AspNetCore.OpenApi 11.0.0 / Swashbuckle 11.0.1)
using System.Text.Json.Serialization;
using Microsoft.OpenApi;

var builder = WebApplication.CreateBuilder(args);

// Comment these two lines out to test integer enums.
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

builder.Services.AddOpenApi("v31");
builder.Services.AddOpenApi("v30", o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();
app.MapOpenApi();                                                      // /openapi/v31.json, /openapi/v30.json
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0); // /swagger/v1/swagger.json

app.MapPost("/orders", (Order order) => TypedResults.Ok(order));
app.MapPost("/tickets", (Ticket ticket) => TypedResults.Ok(ticket));
app.Run();

public enum OrderStatus { Pending, Shipped, Cancelled }
public record Order(int Id, OrderStatus Status, OrderStatus? PreviousStatus);

public enum Priority { Low, High }            // only ever used as Priority?
public record Ticket(int Id, Priority? Priority);
```

`OrderStatus` is used both ways, with the non-nullable property first. `Priority` is only ever used as `Priority?`. That difference is the whole story.

### With `JsonStringEnumConverter`

Built-in, OpenAPI 3.1 (`/openapi/v31.json`, trimmed):

```json
"previousStatus": { "oneOf": [ { "type": "null" }, { "$ref": "#/components/schemas/OrderStatus" } ] },
"priority":       { "oneOf": [ { "type": "null" }, { "$ref": "#/components/schemas/Priority" } ] },

"OrderStatus": { "enum": [ "Pending", "Shipped", "Cancelled" ] },
"Priority":    { "enum": [ "Low", "High", null ] }
```

The property shapes are identical. The components are not: `Priority` carries a `null` member, because the only schema the generator ever built for it came from `Nullable<Priority>`, and that schema is what got componentized. The 3.0 document has the same components, with the property wrapper spelled `{ "enum": [null], "nullable": true }` instead of `{ "type": "null" }`.

What NSwag 14.8.0 generates from either document:

```csharp
public OrderStatus Status { get; set; }
public OrderStatus? PreviousStatus { get; set; }   // correct
public Priority2 Priority { get; set; }            // broken

public partial class Priority2
{
    // only AdditionalProperties, no relation to the Priority enum
}
```

NSwag 13.18.2 produced the same three lines from the 3.1 and the 3.0 document. So the empty class comes from the `null` inside the component (a `null` in the value list is enough for NJsonSchema to give up on the enum and emit an object type), not from OpenAPI 3.1. Kiota 1.38.0 tolerated it and generated `Priority? Priority`.

This null leak is tracked as [dotnet/aspnetcore#65017](https://github.com/dotnet/aspnetcore/issues/65017), opened against 10.0.101 and still open in the 10.0.x milestone. It is order dependent: whichever usage of the enum is schematized first decides whether the component gets `null`, and per the maintainers' comments that order flipped between 10.0.101 and 10.0.102. That explains why the issue reporter in #66295 saw the 3.0 switch "fix" it while it does nothing in this repro: reshuffling generation is enough to move the `null`. The [related PR #66228](https://github.com/dotnet/aspnetcore/pull/66228) (merged for 11.0 preview 5) fixed non-body parameters only; the body-property case above still reproduces on 11.0.0.

### Without `JsonStringEnumConverter` (integer enums)

Built-in output for the same model:

```json
"OrderStatus": { "type": "integer" },
"Priority":    { "type": "integer" }
```

No `enum` array at all. There is nothing for a generator to build an enum from, so:

| Generator | `Status` | `PreviousStatus` | `Priority` |
| --- | --- | --- | --- |
| NSwag 14.8.0 / 13.18.2 | `int` | `int?` | `int?` |
| Kiota 1.38.0 | `int?` | `OrderStatus?` (empty model class) | `Priority?` (empty model class) |

The Kiota row is the other flavour of "a class with no connection to the original enum": Kiota wraps a `oneOf` around a bare integer schema as a model type.

### What Swashbuckle actually did

People remember Swashbuckle emitting `nullable: true`, but that is not its default. Swashbuckle 10.3.1 with default settings writes a nullable enum as a bare reference, and NSwag then generates a **non-nullable** `OrderStatus`:

```json
"previousStatus": { "$ref": "#/components/schemas/OrderStatus" }
"OrderStatus": { "enum": [ "Pending", "Shipped", "Cancelled" ], "type": "string" }
```

The `nullable: true` shape only appears with one of two opt-ins:

```csharp
// Swashbuckle.AspNetCore 10.3.1
builder.Services.AddSwaggerGen(o =>
{
    o.UseAllOfToExtendReferenceSchemas();
    // -> "previousStatus": { "allOf": [ { "$ref": "#/components/schemas/OrderStatus" } ], "nullable": true }

    // or: o.UseInlineDefinitionsForEnums();
    // -> "previousStatus": { "enum": [ ... ], "type": "string", "nullable": true }
});
```

Two other differences matter for the fix. Swashbuckle always lists integer enum values (`"enum": [0, 1, 2], "type": "integer", "format": "int32"`), and it always states `"type": "string"` for string enums. The built-in generator does neither, so its integer enums are value-less and its string enums are untyped.

## Fix: clean up the enum component with a schema transformer

The goal is not to imitate Swashbuckle's `allOf` + `nullable` shape. The `oneOf` wrapper is valid in both 3.0 and 3.1, and generators read it fine. What needs fixing is the component itself:

1. Unwrap `Nullable<TEnum>` so the transformer sees the enum type no matter which usage built the component.
2. Remove `null` from the component's `enum` array; the property-level `oneOf` still carries nullability.
3. For integer enums, add the values, `format: int32`, and an `x-enumNames` extension so NSwag can name the members.
4. For string enums, state `type: string` explicitly.

```csharp
// .NET 10 (Microsoft.AspNetCore.OpenApi 10.0.15, Microsoft.OpenApi 2.13.0)
// and .NET 11 (Microsoft.AspNetCore.OpenApi 11.0.0, Microsoft.OpenApi 3.11.0): same source compiles on both
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

sealed class EnumSchemaTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)
    {
        // Nullable<TEnum> shares the TEnum component, so unwrap it.
        var type = Nullable.GetUnderlyingType(context.JsonTypeInfo.Type) ?? context.JsonTypeInfo.Type;
        if (!type.IsEnum)
            return Task.CompletedTask;

        // Drop the null that leaks into the shared component (dotnet/aspnetcore#65017).
        var values = schema.Enum?
            .Where(v => v is not null && v.GetValueKind() != JsonValueKind.Null)
            .ToList() ?? [];

        if (values.Count > 0)
        {
            // String enum (JsonStringEnumConverter): keep the names, state the type.
            schema.Enum = values;
            schema.Type = JsonSchemaType.String;
        }
        else
        {
            // Integer enum: the built-in generator emits only { "type": "integer" }.
            schema.Enum = [.. Enum.GetValues(type).Cast<object>()
                .Select(v => (JsonNode)JsonValue.Create(Convert.ToInt64(v)))];
            schema.Type = JsonSchemaType.Integer;
            schema.Format ??= "int32";
            schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
            schema.Extensions["x-enumNames"] = new JsonNodeExtension(
                new JsonArray([.. Enum.GetNames(type).Select(n => (JsonNode)n)]));
        }
        return Task.CompletedTask;
    }
}
```

Register it on every document you expose:

```csharp
// .NET 10 / 11
builder.Services.AddOpenApi(o => o.AddSchemaTransformer<EnumSchemaTransformer>());
```

If you are new to transformers, [the walkthrough of operation and schema transformers in ASP.NET Core 11](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) covers the registration options and the `JsonSchemaType` flags used above.

### What the documents and clients look like after the fix

String enums, 3.1 output:

```json
"priority": { "oneOf": [ { "type": "null" }, { "$ref": "#/components/schemas/Priority" } ] },
"Priority": { "enum": [ "Low", "High" ], "type": "string" }
```

Integer enums, 3.1 output:

```json
"Priority": { "enum": [ 0, 1 ], "type": "integer", "format": "int32", "x-enumNames": [ "Low", "High" ] }
```

Generated properties, regenerated from each fixed document (NSwag 14.8.0 and Kiota gave identical results from 3.1 and 3.0 output; NSwag 13.18.2 was run against the 3.1 output):

| Generator | String enums | Integer enums |
| --- | --- | --- |
| NSwag 14.8.0 | `OrderStatus Status`, `OrderStatus? PreviousStatus`, `Priority? Priority` | same, with `enum OrderStatus { Pending = 0, ... }` |
| NSwag 13.18.2 | same as 14.8.0 | same as 14.8.0 |
| Kiota 1.38.0 | `OrderStatus?` / `OrderStatus?` / `Priority?` (enums) | `int?` / empty model class / empty model class |

For NSwag, that is the `MyEnum?` the question asked for, including from the default 3.1 document. You do not need to downgrade to 3.0.

## Gotchas and variants

**Kiota and integer enums do not mix.** Even with values and `x-enumNames` in the component, Kiota 1.38.0 generated `int?` for the non-nullable property and an empty model class for the `oneOf` ones. If Kiota is your client generator, serialize enums as strings with `JsonStringEnumConverter`; that is the only combination in this test where Kiota produced real enums. For the rest of the Kiota setup, see [generating a strongly typed client from an OpenAPI spec](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

**Do not "fix" it by inlining enums.** Returning `null` from `CreateSchemaReferenceId` for enum types looks like it should give Swashbuckle's `UseInlineDefinitionsForEnums` output. In this repro it inlined the non-nullable `Status`, but `PreviousStatus` still referenced a component, and that component now contained `null`. With string enums, NSwag generated an `OrderStatus2` enum for `Status` and an empty `PreviousStatus` class for `PreviousStatus`: strictly worse.

**The converter must be registered where the OpenAPI generator looks.** Minimal APIs read `Microsoft.AspNetCore.Http.Json.JsonOptions` (`ConfigureHttpJsonOptions`); controllers read `Microsoft.AspNetCore.Mvc.JsonOptions` (`AddControllers().AddJsonOptions(...)`). Register `JsonStringEnumConverter` in the wrong one and the document silently switches to the integer case. A `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` attribute on the enum works for both.

**Naming policies.** If you use `new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)`, the component values are already camel-cased, and the transformer keeps them as-is. Only the integer branch calls `Enum.GetNames`, which is correct there because `x-enumNames` is meant to hold C# member names.

**Annotations on nullable properties.** `[Description]` and `[Obsolete]` on a nullable enum property end up inside the `oneOf` branch instead of on the property, so most generators drop them. That is a separate open bug, [dotnet/aspnetcore#69727](https://github.com/dotnet/aspnetcore/issues/69727); the transformer above does not touch it.

**Swagger UI and 3.2 on .NET 11.** .NET 11 defaults to OpenAPI 3.2.0. NSwag 14.8.0 read the 3.2 document without complaint here, but older Swagger UI bundles do not; see [the Swagger UI fix for .NET 11](/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/). The same null-wrapping logic also applies to nullable *response* types, covered in [marking a controller action response as nullable](/2026/10/how-to-mark-a-controller-action-response-as-nullable-in-aspnetcore-openapi/).

**When the upstream fix lands, delete the null-stripping part.** The maintainers' proposed fix in #65017 always keeps `null` out of componentized enums and puts it on the reference, which is exactly what the transformer does. The integer-values part will still be needed unless the built-in generator starts emitting values for numeric enums.

## How this was tested

Each scenario ran the app with `ASPNETCORE_URLS=http://localhost:5310 dotnet run`, fetched the three documents with `curl`, and generated clients with:

```bash
nswag openapi2csclient /input:builtin-31.json /output:Client.cs /namespace:Gen /generateClientClasses:false
kiota generate -l CSharp -d builtin-31.json -o kiota -n Gen -c Client
```

NSwag 13.18.2 targets older runtimes, so it ran with `DOTNET_ROLL_FORWARD=Major` on the .NET 10 runtime. Only document generation and code generation were checked; no generated client was compiled against a running service or used to round-trip a request.

### Read next

- [Migrating from Swashbuckle to built-in OpenAPI in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Migrate Swashbuckle IOperationFilter and ISchemaFilter to transformers](/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/)
- [How to customize OpenAPI with operation and schema transformers](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Generate a strongly typed client from an OpenAPI spec](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)

### Sources

- [Stack Overflow: .NET 10 OpenAPI generator doesn't generate nullable enums like Swashbuckle](https://stackoverflow.com/questions/79924789)
- [dotnet/aspnetcore#66295: Microsoft.AspNetCore.OpenApi generates incorrect nullable enum](https://github.com/dotnet/aspnetcore/issues/66295)
- [dotnet/aspnetcore#65017: OpenAPI generation adds null value to enum based on parameter order](https://github.com/dotnet/aspnetcore/issues/65017)
- [dotnet/aspnetcore#66228: Fix OpenAPI enum schema for non-body parameters with naming policy](https://github.com/dotnet/aspnetcore/pull/66228)
- [dotnet/aspnetcore#69727: property-level annotations emitted inside the oneOf branch](https://github.com/dotnet/aspnetcore/issues/69727)
- [Microsoft Learn: Customize OpenAPI documents (transformers)](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi)
