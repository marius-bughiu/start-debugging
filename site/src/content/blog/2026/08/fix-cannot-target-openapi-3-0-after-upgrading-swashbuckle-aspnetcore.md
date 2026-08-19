---
title: "Fix: cannot target OpenAPI 3.0 after upgrading Swashbuckle.AspNetCore to v9"
description: "Swashbuckle 8 and later emit openapi 3.0.4, not 3.0.1, and there is no OpenApiSpecVersion for a patch version. Why it changed, and four ways to pin the string your tooling expects."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore"
  - "dotnet-11"
---

You upgraded `Swashbuckle.AspNetCore` to 9.x, your code still says `OpenApiSpecVersion.OpenApi3_0`, and the generated document now reads `"openapi": "3.0.4"` instead of `"openapi": "3.0.1"`. Downstream tooling rejects it, and there is no `OpenApi3_0_1` enum member to select. The version string is a hard-coded literal inside `Microsoft.OpenApi`, not a Swashbuckle setting: 1.6.22 and earlier write `3.0.1`, 1.6.23 and later write `3.0.4`. Swashbuckle 8.0.0 was the release that took the 1.6.23 dependency, so the change lands on anyone crossing the 7.x boundary. The fixes below are, in order: upgrade the consumer, rewrite the property yourself in middleware, or pin the whole Swashbuckle stack at 7.2.0.

Everything here was measured against .NET SDK 10.0.201 on `net10.0`, with Swashbuckle.AspNetCore 6.5.0, 7.2.0, 8.1.4, 9.0.6, and 10.2.3.

## The errors in context

Asking the CLI for the patch version directly:

```text
System.NotSupportedException: The specified OpenAPI version "3.0.1" is not supported.
   at Swashbuckle.AspNetCore.Cli.Program.<>c.<Main>b__1_5(IDictionary`2 namedArgs)
   at Swashbuckle.AspNetCore.Cli.CommandRunner.Run(IEnumerable`1 args)
   at Swashbuckle.AspNetCore.Cli.Program.Main(String[] args)
```

Trying to hold `Microsoft.OpenApi` back while keeping Swashbuckle 9:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.OpenApi from 1.6.25 to 1.6.22.
  Reference the package directly from the project to select a different version.
   MyApi -> Swashbuckle.AspNetCore 9.0.6 -> Swashbuckle.AspNetCore.Swagger 9.0.6 -> Microsoft.OpenApi (>= 1.6.25)
   MyApi -> Microsoft.OpenApi (>= 1.6.22)
```

And, if you silence NU1605 and try anyway:

```text
error CS1705: Assembly 'Swashbuckle.AspNetCore.SwaggerGen' with identity
'Swashbuckle.AspNetCore.SwaggerGen, Version=9.0.6.0, ...' uses 'Microsoft.OpenApi, Version=1.6.25.0, ...'
which has a higher version than referenced assembly 'Microsoft.OpenApi' with identity
'Microsoft.OpenApi, Version=1.6.22.0, ...'
```

Older Swagger UI builds render the document as:

```text
Unable to render this definition
The provided definition does not specify a valid version field.
Please indicate a valid Swagger or OpenAPI version field. Supported version fields are
swagger: "2.0" and those that match openapi: 3.x.y (for example, openapi: 3.1.0).
```

## Why is the version string 3.0.4 and not something I control?

`OpenApiSpecVersion` is a small enum, and none of its members carry a patch number. In `Microsoft.OpenApi` 1.6.25, which is what Swashbuckle 9.0.6 depends on, it has exactly two members:

```text
OpenApi2_0
OpenApi3_0
```

In `Microsoft.OpenApi` 2.7.5, which Swashbuckle 10.2.3 depends on, it gains one more:

```text
OpenApi2_0
OpenApi3_0
OpenApi3_1
```

There is no 3.0.1, 3.0.3, or 3.0.4 member, because the patch version is not a serializer option. `OpenApiDocument.SerializeAsV3` writes a compile-time constant. You can see the change with a string dump of the shipped assemblies:

```text
strings -a -e l on lib/netstandard2.0/Microsoft.OpenApi.dll:
  1.2.3   -> 3.0.1
  1.6.22  -> 3.0.1
  1.6.23  -> 3.0.4
  1.6.25  -> 3.0.4
  2.7.5   -> 3.0.4 and 3.1.1
```

The bump landed in [OpenAPI.NET PR #2011](https://github.com/microsoft/OpenAPI.NET/pull/2011), merged 20 December 2024, which forward-ported the v2 behaviour into the v1 line. It is not a bug: OpenAPI 3.0.4 is a real patch release of the specification, and emitting the newest patch is the correct default. The problem is that a lot of consumers validate the `openapi` field against a hard-coded allow-list instead of a `3.0.x` pattern.

## Which Swashbuckle version emits which patch version?

The `openapi` field follows the `Microsoft.OpenApi` assembly that actually gets resolved, not the Swashbuckle version you typed into the csproj:

| Swashbuckle.AspNetCore | Microsoft.OpenApi (declared) | `openapi` field |
| --- | --- | --- |
| 6.5.0 | 1.2.3 | `3.0.1` |
| 7.2.0 | 1.6.22 | `3.0.1` |
| 8.0.0 to 8.1.4 | 1.6.23 | `3.0.4` |
| 9.0.0 to 9.0.6 | 1.6.23 to 1.6.25 | `3.0.4` |
| 10.0.0 to 10.2.3 | 2.3.0 to 2.7.5 | `3.0.4`, or `3.1.1` with `OpenApi3_1` |

Two things to note. First, 8.0.0 is the real boundary, not 9.0.0: if you jumped from 7.x straight to 9.x you crossed it without seeing it. Second, the NuGet dependency is a floor, not a pin. A project on Swashbuckle 7.2.0 that also references something pulling `Microsoft.OpenApi` 1.6.23 or later resolves to the newer assembly and starts emitting `3.0.4` with no Swashbuckle change at all. If your document changed and your Swashbuckle version did not, run this before you look anywhere else:

```bash
dotnet list package --include-transitive
```

## Minimal repro on net10.0

```csharp
// .NET SDK 10.0.201, net10.0, Swashbuckle.AspNetCore 9.0.6
using Microsoft.OpenApi;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "Demo", Version = "v1" }));

var app = builder.Build();
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.MapGet("/orders/{id}", (int id) => new Order(id, "open", null)).WithName("GetOrder");
app.Run();

record Order(int Id, string Status, string? Note);
```

`GET /swagger/v1/swagger.json` returns:

```json
{
  "openapi": "3.0.4",
  "info": { "title": "Demo", "version": "v1" },
  "paths": { }
}
```

Setting `OpenApiVersion` explicitly changes nothing here, because `OpenApi3_0` is already the default and the enum has no finer granularity to offer.

## Can I pass a patch version to the CLI instead?

No. `dotnet swagger tofile` parses `--openapiversion` against a closed set of three strings. From the v10.2.3 source:

```csharp
// Swashbuckle.AspNetCore.Cli/Program.cs, v10.2.3
specVersion = versionArg switch
{
    "2.0" => OpenApiSpecVersion.OpenApi2_0,
    "3.0" => OpenApiSpecVersion.OpenApi3_0,
    "3.1" => OpenApiSpecVersion.OpenApi3_1,
    _ => throw new NotSupportedException($"The specified OpenAPI version \"{versionArg}\" is not supported."),
};
```

On 9.0.6 the `"3.1"` arm does not exist either, so `2.0` and `3.0` are your only inputs. Measured output for each accepted value on 10.2.3: `2.0` gives `"swagger": "2.0"`, `3.0` gives `"openapi": "3.0.4"`, `3.1` gives `"openapi": "3.1.1"`. Anything else, including `3.0.1` and `3.1.1`, throws.

One aside on the CLI: the 9.0.6 tool ships a `net9.0` apphost, so it refuses to start on a machine that only has the .NET 10 runtime. Set `DOTNET_ROLL_FORWARD=Major` before invoking it, or install the matching runtime.

## Does downgrading Microsoft.OpenApi to 1.6.22 work?

Not on Swashbuckle 9 or 10, and this is the advice you will find most often in old issue threads. Adding a direct reference first trips NU1605, which NuGet treats as an error by default. If you suppress it with `<WarningsNotAsErrors>NU1605</WarningsNotAsErrors>`, restore resolves 1.6.22 and then the compile fails with `CS1705`, because `Swashbuckle.AspNetCore.Swagger` 9.0.6 was built against the 1.6.25 assembly identity. Both failures reproduce on a clean `net10.0` project.

The version-pinning route only works if you move the whole stack back:

```xml
<!-- net10.0, verified: emits "openapi": "3.0.1" -->
<ItemGroup>
  <PackageReference Include="Swashbuckle.AspNetCore" Version="7.2.0" />
  <PackageReference Include="Microsoft.OpenApi" Version="1.6.22" />
</ItemGroup>
```

Swashbuckle 7.2.0 still targets `netstandard2.0` and runs fine on `net10.0`, and it resolves `Microsoft.OpenApi` 1.6.22. The explicit `Microsoft.OpenApi` reference is there to stop a transitive bump from floating you forward again. Treat this as a holding pattern with a deadline, not a fix: you are freezing an OpenAPI generator two majors behind, and 8.x and 9.x contain schema-generation fixes you will eventually want.

## How do I rewrite the version string on Swashbuckle 9 or 10?

There is no hook. The Swashbuckle maintainers have said as much on [issue #3540](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540): `SwaggerMiddleware` serializes straight to the response stream with nothing in between. The workaround they suggest, and the one that actually holds up, is to buffer the response and edit the property. This works identically on 9.0.6 and 10.2.3 because it never touches the object model:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6 and 10.2.3, both verified
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/swagger")
        && ctx.Request.Path.Value!.EndsWith(".json"),
    branch => branch.Use(async (ctx, next) =>
    {
        var original = ctx.Response.Body;
        using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;

        await next();

        ctx.Response.Body = original;
        if (ctx.Response.StatusCode != StatusCodes.Status200OK)
        {
            buffer.Position = 0;
            await buffer.CopyToAsync(original);
            return;
        }

        var json = Encoding.UTF8.GetString(buffer.ToArray())
            .Replace("\"openapi\": \"3.0.4\"", "\"openapi\": \"3.0.1\"", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes);
    }));

app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.UseSwaggerUI();
```

Register it before `UseSwagger`. Swagger UI keeps working, `/swagger/index.html` still returns 200, and the JSON endpoint returns `3.0.1`. Two details matter: reset `ctx.Response.Body` to the original stream before writing, and set `ContentLength` after the rewrite, since the replacement changes the byte count. The `.EndsWith(".json")` guard keeps the buffering off the UI's static assets. If you serve YAML as well, add a branch for it, because the property is written as `openapi: '3.0.4'` there and the JSON replacement will not match.

If you would rather not buffer, replace the endpoint outright and serialize the document yourself:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6
app.MapGet("/swagger/v1/swagger.json", (ISwaggerProvider provider) =>
{
    var document = provider.GetSwagger("v1");
    var node = JsonNode.Parse(document.SerializeAsJson(OpenApiSpecVersion.OpenApi3_0))!;
    node["openapi"] = "3.0.1";
    return Results.Text(
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
        "application/json");
}).ExcludeFromDescription();
```

`ExcludeFromDescription()` is not optional. Without it the endpoint discovers itself, and `/swagger/v1/swagger.json` shows up as a documented path in its own output. `SerializeAsJson` lives in `Microsoft.OpenApi.Extensions` on the 1.6.x line; on Swashbuckle 10 with `Microsoft.OpenApi` 2.x that extension is gone, so prefer the middleware there.

For a build-time document produced by `dotnet swagger tofile` or `OpenApiGenerateDocumentsOnBuild`, do not do any of this in code. Generate with `--openapiversion 3.0` and patch the file as a build step:

```bash
jq '.openapi = "3.0.1"' swagger.json > swagger.tmp && mv swagger.tmp swagger.json
```

## Swagger UI still rejects the definition, now what?

If the browser shows "The provided definition does not specify a valid version field", the document is fine and the UI is stale. swagger-ui gained 3.0.4 support in [v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0), released 17 February 2025, via [PR #10247](https://github.com/swagger-api/swagger-ui/pull/10247). Swashbuckle picked that up in `Swashbuckle.AspNetCore.SwaggerUI` 7.3.0. Anything older renders the error against a perfectly valid 3.0.4 document.

The trap is version skew inside a single solution. `Swashbuckle.AspNetCore.SwaggerUI` is a separate package, and projects that reference the three sub-packages individually often bump `Swagger` and `SwaggerGen` while leaving `SwaggerUI` behind. Check all three, then hard-refresh the browser, because the bundled `swagger-ui-bundle.js` is cached aggressively.

If your renderer is the problem rather than your document, this is also a reasonable moment to look at [serving your docs with Scalar instead](/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), which reads 3.0.4 and 3.1 without complaint.

## What if I actually want 3.1?

Then you need Swashbuckle 10 or later, because `Microsoft.OpenApi` 1.6.x has no `OpenApi3_1` member at all. On 10.x it is opt-in, so the default stays 3.0.4 and you ask for 3.1 explicitly:

```csharp
// net10.0, Swashbuckle.AspNetCore 10.2.3, emits "openapi": "3.1.1"
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
```

Budget for the upgrade. Swashbuckle 10 moves to `Microsoft.OpenApi` v2, which flattens the namespaces, so the first thing you hit is:

```text
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi'
```

Delete `using Microsoft.OpenApi.Models;`, since the types now live in `Microsoft.OpenApi` directly. Beyond that, concrete model types become interfaces (`OpenApiSchema` becomes `IOpenApiSchema`), string type names become `JsonSchemaType` enum values, and `WithOpenApi()` is no longer supported. The [v10 migration guide](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md) recommends stepping through 9.0.6 first, which is good advice: it isolates the 9.x breaking changes (dropped `netstandard2.0`, removed obsolete members, removed `--serializeasv2`) from the OpenAPI.NET v2 ones.

## Which fix should I pick?

Ranked by what I would actually do:

1. Upgrade the consumer. `3.0.4` is valid OpenAPI 3.0, and every current validator, generator, and gateway accepts it. Most of these reports come down to a tool three versions behind.
2. If the consumer is a vendor you cannot move, add the middleware rewrite. It is 20 lines, it is version-agnostic, and it does not freeze your dependency graph.
3. Patch the file in CI with `jq` if the document is generated at build time rather than served at runtime.
4. Pin Swashbuckle at 7.2.0 only as a stopgap, with a ticket to remove it.

What does not work, despite what search results will tell you: downgrading `Microsoft.OpenApi` under a current Swashbuckle, or hunting for an `OpenApiSpecVersion` member that encodes the patch version.

## Related

- [Migrating from Swashbuckle to the built-in OpenAPI generator](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) covers the other direction, if you would rather leave Swashbuckle behind than manage its version churn.
- [The 'OpenApiReference' could not be found compile error](/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/) is the sibling failure from the same `Microsoft.OpenApi` v2 namespace flattening.
- [Mapping IOperationFilter and ISchemaFilter onto transformers](/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/) is the piece of the migration that takes the longest.
- [Scalar and Swagger UI compared](/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) is worth a read if the version rejection came from the renderer rather than a downstream service.
- [Generating strongly typed clients from an OpenAPI spec](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) matters if the consumer rejecting your document is a code generator.

## Sources

- [OpenAPI.NET PR #2011: bumps v3 patch version to 3.0.4](https://github.com/microsoft/OpenAPI.NET/pull/2011)
- [Swashbuckle.AspNetCore issue #3540: changing the openapi version in swagger.json](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540)
- [Swashbuckle.AspNetCore issue #3216: 7.2.0 json doc says openapi 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3216)
- [Swashbuckle.AspNetCore issue #3265: add support for OpenAPI 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3265)
- [Swashbuckle.AspNetCore v9.0.0 release notes](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v9.0.0)
- [Swashbuckle.AspNetCore v10.0.0 release notes](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.0.0)
- [Swashbuckle.AspNetCore v10 migration guide](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [swagger-ui v5.19.0 release notes](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)
