---
title: "Scalar vs Swagger UI for OpenAPI documentation in ASP.NET Core 11"
description: "Scalar ships 1.02 MiB of gzipped JavaScript and a far better request builder. Swagger UI ships 514 KiB and renders OpenAPI 3.2, which is what .NET 11 now emits by default. Measured payloads, the 3.2 gap, endpoint routing on both sides, and the auth details that decide it."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
---

Pick **Scalar** (`Scalar.AspNetCore` 2.16.20) for a new .NET 11 API if the people reading your docs are external, because the request builder, the multi-language code samples, and the search are genuinely better than anything Swagger UI does. Pick **Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI` 10.2.3, bundling swagger-ui 5.32.7) if you want the smaller payload, if you rely on the OAuth2 redirect flow you already configured, or if you need confident OpenAPI 3.2 rendering today, because .NET 11 emits 3.2 by default and Scalar's 3.2 work is still an open tracking issue. Both are MIT licensed, both are pure renderers with no say in your OpenAPI document, and Microsoft's guidance is that neither should be reachable in production.

Everything measured below was run against .NET SDK 10.0.201 with the exact package versions named, on 2026-08-15. The API surface is identical on .NET 8 through .NET 11, because both packages ship `net8.0`, `net9.0`, and `net10.0` assemblies and take a framework reference on `Microsoft.AspNetCore.App` rather than pinning a runtime.

## The comparison people think they are making is not the one that matters

Since .NET 9, `dotnet new webapi` has not included Swashbuckle. `Microsoft.AspNetCore.OpenApi` generates the document, and it is compatible with trimming and Native AOT. That means the choice in front of you is not "Swashbuckle or Scalar", it is "which JavaScript bundle renders the document my framework already produces". If you are still on Swashbuckle's `SwaggerGen` for generation, that is a separate decision, covered in [exposing OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

This distinction has a practical consequence. `Swashbuckle.AspNetCore` the metapackage drags in `Swashbuckle.AspNetCore.Swagger`, `SwaggerGen`, and `Microsoft.Extensions.ApiDescription.Server` alongside the UI. If you only want the UI, reference `Swashbuckle.AspNetCore.SwaggerUI` directly and nothing else comes with it.

```xml
<!-- .NET 11, C# 14: the UI only, no second document generator -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.2.3" />
</ItemGroup>
```

```xml
<!-- .NET 11, C# 14: the Scalar equivalent, one package, zero NuGet dependencies -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Scalar.AspNetCore" Version="2.16.20" />
</ItemGroup>
```

## The matrix

| | Scalar 2.16.20 | Swagger UI 5.32.7 (Swashbuckle 10.2.3) |
| --- | --- | --- |
| Wire bytes on first load (gzip) | 1,071,277 | 526,322 |
| JavaScript parsed after decompression | 3,711 KB | 1,794 KB |
| Registration | `app.MapScalarApiReference()` | `app.UseSwaggerUI(...)` or `app.MapSwaggerUI(...)` |
| Endpoint routing | Yes, since 1.x | Yes, since 10.2.0 (May 2026) |
| OpenAPI 3.2 | Parser handles it, full support tracked in an open issue | Basic support since swagger-ui 5.32.0 |
| Code samples | 20+ targets (curl, fetch, axios, Python, Go, Java, PHP, Ruby, more) | curl for the request you just sent |
| Asset caching | `Cache-Control: no-cache` plus ETag, hardcoded | ETag by default, `max-age` if you set `CacheLifetime` |
| Persisted credentials | `persistAuth` writes to local storage | `PersistAuthorization` in the config object |
| Cross-origin Try It | Optional `proxyUrl` | Direct browser fetch, CORS is your problem |
| Theming | 12 built-in themes, `customCss`, plugins | `InjectStylesheet`, `InjectJavascript`, swagger-ui plugin system |
| License | MIT | MIT |

## What each one costs the browser, measured

Both packages embed their assets in the assembly as gzip streams and hand those bytes straight to a client that advertises `Accept-Encoding: gzip`. Scalar's ASP.NET Core integration checks `IsGzipAccepted()` and sets `Content-Encoding` plus `Vary: Accept-Encoding` from the stored asset. Swashbuckle's UI middleware carries the same machinery (`IsGZipAccepted`, a `GZipStream` in decompress mode for the rare client that refuses). So the stored resource sizes are the transfer sizes, and you can read them out of the packages without running anything:

```csharp
// .NET SDK 10.0.201, run as a file-based app: dotnet run res.cs <dll>
using System.Reflection;

var asm = Assembly.LoadFrom(args[0]);
foreach (var name in asm.GetManifestResourceNames())
{
    using var s = asm.GetManifestResourceStream(name);
    Console.WriteLine($"{s?.Length,10}  {name}");
}
```

Scalar serves three assets, and only two of them are code:

```text
   1070166  ScalarStaticAssets.scalar.js
      1111  ScalarStaticAssets.scalar.aspnetcore.js
       533  ScalarStaticAssets.favicon.svg
```

Swashbuckle's `index.html` pulls the bundle, the standalone preset, the stylesheet, and its own initializer:

```text
    421507  swagger-ui-bundle.js
     77731  swagger-ui-standalone-preset.js
     26499  swagger-ui.css
       433  index.js
       152  index.css
       739  index.html
```

That is 1,071,277 bytes for Scalar against 526,322 bytes for Swagger UI, a 2.0x difference over the wire. Decompressed, `scalar.js` is 3,708,228 bytes of JavaScript the browser has to parse, against 1,793,552 bytes for Swagger UI's bundle plus preset. The modern-looking option is the heavy one, which is the opposite of what most write-ups imply.

Two caveats before you weigh this too heavily. First, this is a development tool: the bytes land on your machine, over loopback, once per cold load. Second, Swashbuckle's `swagger-ui.js` (92,466 bytes) sits in the package unused by the default page, so the number above is what actually loads, not what ships. If you serve either UI over a real network, the [response compression comparison](/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) does not help you here: both packages have already compressed these assets themselves, and re-compressing a `Content-Encoding: gzip` response is not a thing the middleware will do.

Caching is the part that bites daily. `SwaggerUIOptions.CacheLifetime` documents its default as "0 days (ETags are used to check if resources have been updated)", so out of the box both UIs revalidate. The difference is that Swashbuckle lets you opt into real caching and Scalar does not: its static asset handler hardcodes `Cache-Control: no-cache` and answers a matching `If-None-Match` with a 304. You pay a round trip per asset per page load, forever.

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.CacheLifetime = TimeSpan.FromDays(7); // 304s become cache hits
});
```

## The .NET 11 wrinkle: your document is 3.2 now

This is the fact that should drive the decision in August 2026, and almost nobody has written it down. Microsoft Learn is explicit: "Starting in .NET 11, the default OpenAPI version for generated documents is 3.2. In .NET 10, the default is 3.1." Upgrade an API from .NET 10 to .NET 11, change nothing else, and the document your UI has to render changes specification version.

On the Swagger UI side, swagger-ui 5.32.0 (27 February 2026) shipped "basic OpenAPI 3.2.0 support", and Swashbuckle 10.2.3 bundles 5.32.7, so the renderer at least knows what it is looking at. On the Scalar side, `@scalar/openapi-parser` understands 3.2, but the tracking issue [scalar/scalar#6715](https://github.com/scalar/scalar/issues/6715) is still open, with "set OpenAPI 3.2 as the default version" and deeply nested tag rendering in the sidebar listed as pending work as of its last update on 30 June 2026.

In practice a document generated from minimal API endpoints changes very little between 3.1 and 3.2, so most apps will see no difference at all. If you do see a sidebar that groups wrongly or a schema that renders as empty, pin the version rather than filing a bug against the UI:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    // .NET 11 defaults to OpenApi3_2; pin 3.1 while a renderer catches up
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
});
```

The same knob exists for build-time generation through the `OpenApiGenerateDocumentsOptions` MSBuild property with `--openapi-version OpenApi3_1`. Pinning costs you nothing today: nothing in an ASP.NET Core generated document depends on 3.2 features yet.

## Middleware or endpoint, on both sides now

The strongest architectural argument for Scalar used to be that `MapScalarApiReference` registers an endpoint while `UseSwaggerUI` registers middleware, and middleware terminates the request before endpoint routing gets a say. That argument expired in May 2026. Swashbuckle 10.2.0 added `MapSwaggerUI` and `MapReDoc` "to support endpoint routing". Both UIs can now carry endpoint metadata, appear in `EndpointDataSource`, and take routing conventions directly:

```csharp
// Program.cs -- .NET 11, C# 14
// Scalar: MapScalarApiReference returns an IEndpointConventionBuilder
app.MapScalarApiReference()
   .RequireAuthorization("ApiDocsPolicy");

// Swashbuckle 10.2.0+: same shape
app.MapSwaggerUI()
   .RequireAuthorization("ApiDocsPolicy");
```

If you are behind a reverse proxy, note that Scalar's HTML endpoint redirects a request for `/scalar` to `/scalar/` with a 301 so its relative asset paths resolve, and Swashbuckle's middleware 301s a request for its bare route prefix to `index.html`. An integration test asserting a 200 on the bare path fails against either one.

## Authorize, and what happens after you click it

Both UIs read security schemes from the document, and neither invents them. Scalar's own documentation is blunt about this: your OpenAPI document must already include the schemes for Scalar to work with them. If you have not put them there, the [operation and schema transformer walkthrough](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) is the mechanism you need.

What differs is the ergonomics after that. Scalar pre-fills credentials from server-side configuration and can persist them across reloads:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.20
app.MapScalarApiReference(options =>
{
    options.AddPreferredSecuritySchemes("Bearer")
           .AddHttpAuthentication("Bearer", auth => auth.WithToken(devToken));
    options.PersistentAuthentication = true;
});
```

Swagger UI's equivalent lives in the config object and, for OAuth2, in the `oauth2-redirect.html` page Swashbuckle embeds for you (664 bytes of redirect script that has been in the wild for a decade):

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.OAuthClientId("dev-client");
    options.OAuthUsePkce();
    options.EnablePersistAuthorization();
});
```

The one capability Scalar has that Swagger UI does not is `proxyUrl`. Swagger UI's Try It fires a `fetch` from the documentation origin, so a cross-origin API without permissive CORS produces a browser error that looks like a server failure. Scalar can route the request through a proxy instead. If your documentation is hosted separately from the API, that single option decides it.

## Code samples are the real product difference

Swagger UI shows you the curl command for the request you just executed. Scalar renders the request in every client it knows about before you send anything: shell (curl, httpie), JavaScript (fetch, axios, jquery), Node, Python, Go, Java, Ruby, PHP, and more, controlled by `hiddenClients` and `defaultHttpClient`. For an internal API where the readers are the people who wrote it, that is decoration. For a public API where the reader is deciding whether your product is easy to integrate, it is the whole page.

Scalar also gives you `searchHotKey` (CMD/CTRL+K by default), twelve built-in themes, `customCss`, and a `/scalar/config.js` hook for arbitrary client configuration. Swagger UI's customization goes through `InjectStylesheet`, `InjectJavascript`, and the swagger-ui plugin system, which is more powerful and much less pleasant, and which is the honest summary of the entire comparison.

## When to pick each

Pick Scalar when the documentation is a product surface, when readers are outside your team, when you want the request builder and the code samples, or when the docs are hosted on a different origin than the API and you need the proxy.

Pick Swagger UI when you want the smallest payload and real `max-age` caching, when you have an existing OAuth2 setup that already works, when someone on the team depends on a swagger-ui plugin, or when you want the renderer with explicit 3.2 support while .NET 11 emits 3.2 by default.

Pick neither, and use `Swashbuckle.AspNetCore.ReDoc` or an editor extension, when the document is consumed by generated clients rather than humans. There is no rule that says an API needs a rendered reference at all.

Whatever you choose, Microsoft Learn states the security position plainly: OpenAPI user interfaces should only be enabled in development environments. Both packages make that a one-line environment guard, and the step-by-step version of that setup, including production gating and offline assets, is in the [Scalar walkthrough](/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/).

## The gotchas that pick for you

- **The metapackage.** `Swashbuckle.AspNetCore` 10.2.3 pulls in `SwaggerGen` and `Microsoft.Extensions.ApiDescription.Server`. If you migrated to the built-in generator, you now have two generators and one of them is stale. Reference `Swashbuckle.AspNetCore.SwaggerUI` on its own. The full removal path is in [migrating from Swashbuckle to the built-in OpenAPI generator](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).
- **Neither package targets `net11.0`.** Both ship `net8.0`, `net9.0`, and `net10.0` assemblies with a framework reference. The `net10.0` asset runs on .NET 11 through roll-forward, which is fine but means a `net11.0`-specific fix in either project is not something you can wait for.
- **Scalar assets never cache.** `Cache-Control: no-cache` is not configurable through options. On a slow link to a shared dev environment, you pay a revalidation per asset per load.
- **The trailing slash.** Both UIs 301 the bare path. Strict proxies and integration tests notice.
- **Swagger UI's version header.** Swashbuckle appends `x-swagger-ui-version` to asset responses, which is handy for confirming what actually shipped and which some scanners will flag as information disclosure. Another reason for the environment guard.

Between two MIT-licensed renderers of the same document, this is a reversible decision: swapping one line of `Program.cs` and one package reference moves you either direction in about five minutes. Choose on the reader, not on the framework.

## Related

- [How to serve OpenAPI documentation with Scalar instead of Swagger UI in ASP.NET Core 11](/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) is the full setup: routing, multiple documents, auth, and production gating.
- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) covers the generator half of this split.
- [Migrate from Swashbuckle to the built-in OpenAPI document generation in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) is the removal checklist.
- [How to customize the OpenAPI document with AddOperationTransformer and AddSchemaTransformer](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) is how security schemes get into the document in the first place.
- [Zstandard vs Brotli vs Gzip response compression in .NET 11](/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) explains why pre-compressed static assets bypass the compression middleware entirely.

## Sources

- [Use the generated OpenAPI documents (Microsoft Learn, ASP.NET Core 11)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-11.0)
- [Generate OpenAPI documents, default version 3.2 in .NET 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-11.0)
- [OpenApiSpecVersion enum, including OpenApi3_2 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.openapi.openapispecversion)
- [Swashbuckle.AspNetCore v10.2.0 release notes, MapSwaggerUI and MapReDoc](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.2.0)
- [Swashbuckle.AspNetCore.SwaggerUI 10.2.3 on NuGet](https://www.nuget.org/packages/Swashbuckle.AspNetCore.SwaggerUI/10.2.3)
- [swagger-ui v5.32.0 release, basic OpenAPI 3.2.0 support](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.0)
- [Scalar.AspNetCore 2.16.20 on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore/2.16.20)
- [Scalar .NET integration documentation](https://scalar.com/scalar/scalar-api-references/net-integration)
- [Scalar API reference configuration options](https://scalar.com/scalar/scalar-api-references/configuration)
- [OpenAPI 3.2 support tracking issue (scalar/scalar#6715)](https://github.com/scalar/scalar/issues/6715)
