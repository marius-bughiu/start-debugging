---
title: "How to serve OpenAPI documentation with Scalar instead of Swagger UI in ASP.NET Core 11"
description: "Replace UseSwaggerUI with MapScalarApiReference in ASP.NET Core 11: routing, multiple documents, pre-filled auth, production gating, offline assets, and the Scalar-only OpenAPI extensions that mark endpoints stable or hidden."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
---

To swap Swagger UI for Scalar in an ASP.NET Core 11 API, install `Scalar.AspNetCore`, delete the `app.UseSwaggerUI(...)` call, and add `app.MapScalarApiReference()` next to your existing `app.MapOpenApi()`. The UI then lives at `/scalar` and reads the document from `/openapi/v1.json`, which is exactly what `MapOpenApi` already serves. That is the ninety percent case. The other ten percent is everything below: a document at a non-default route, more than one document, an Authorize button that actually attaches a token, and keeping the whole thing off your production hostname.

Everything here targets .NET 11 (tested against Preview 6, SDK `11.0.100-preview.6.26359.118`) with `Microsoft.NET.Sdk.Web` and C# 14, using `Scalar.AspNetCore` 2.16.18, published 2026-08-07. The API surface below is identical on .NET 8, 9, and 10, because the package targets `net8.0` and up.

## The six steps, start to finish

1. Install `Scalar.AspNetCore` with `dotnet add package Scalar.AspNetCore` and add `using Scalar.AspNetCore;` to `Program.cs`.
2. Remove the `app.UseSwaggerUI(...)` middleware call, and remove the `Swashbuckle.AspNetCore.SwaggerUI` package reference if nothing else uses it.
3. Call `app.MapScalarApiReference()` inside the same environment guard that already wraps `app.MapOpenApi()`.
4. Point Scalar at the right document with `WithOpenApiRoutePattern` or `AddDocument` if your OpenAPI JSON is not at `/openapi/{documentName}.json`.
5. Pre-fill credentials with `AddPreferredSecuritySchemes` and `AddHttpAuthentication` so the Authorize button sends a real token in development.
6. Decide the production story: either leave the endpoint out of production entirely, or map it and chain `RequireAuthorization()` on the returned endpoint builder.

## What actually changes when Swagger UI goes away

The most consequential difference is not visual. `UseSwaggerUI` registers middleware. `MapScalarApiReference` registers an endpoint. That single change moves the UI from the pipeline into the routing table, and everything downstream follows from it.

Middleware runs in registration order and terminates the request before endpoint routing gets a say, which is why Swagger UI historically ignored your authorization policies unless you built a custom middleware wrapper around it. An endpoint participates in routing like any other, so it carries metadata, it shows up in `EndpointDataSource`, and the conventions you already know apply to it directly.

```csharp
// Program.cs -- .NET 11, C# 14
// Before: Swashbuckle's UI middleware over the built-in OpenAPI document
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "v1"));
}
```

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
// After: an endpoint, not middleware
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Note what is missing from the second block: there is no equivalent of `SwaggerEndpoint`. Scalar defaults its document route to `/openapi/{documentName}.json`, which is precisely the route `MapOpenApi` registers, so the two line up with no configuration. If you already replaced Swashbuckle's generator with the built-in one, this is the last Swashbuckle package you had left. The generator side of that swap is covered in [exposing OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

There is one behavioural wrinkle worth knowing before you file a bug. Browsing to `/scalar` issues a redirect to `/scalar/` so the client-side asset paths resolve correctly. If you have a strict redirect policy, a proxy that rewrites trailing slashes, or an integration test asserting a 200 on `/scalar`, that 301 is the thing you are seeing.

## Pointing Scalar at a document that is not at the default route

`MapOpenApi` takes a route pattern, and plenty of codebases changed it years ago to keep old client generators happy. If your document is at `/swagger/v1/swagger.json`, or if .NET 10 added a YAML variant you would rather serve, tell Scalar where to look:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapOpenApi("/swagger/{documentName}/swagger.json");

app.MapScalarApiReference(options =>
{
    options
        .WithTitle("Orders API")
        .WithOpenApiRoutePattern("/swagger/{documentName}/swagger.json");
});
```

`WithOpenApiRoutePattern` also accepts an absolute URL, which is how you point a documentation host at a spec generated by a different service. The route can equally be a path to a file produced at build time by `Microsoft.Extensions.ApiDescription.Server` and served as a static file, if you would rather not run the runtime generator at all.

The UI route itself is the first argument to `MapScalarApiReference`. There are six overloads: with or without a route prefix, with or without an options delegate, and with or without an `HttpContext` in that delegate.

```csharp
// Program.cs -- .NET 11, C# 14
// Mount the reference at /api-docs and vary options per request
app.MapScalarApiReference("/api-docs", (options, httpContext) =>
{
    options.WithTitle($"Orders API ({httpContext.Request.Host})");
});
```

The `HttpContext` overload matters more than it looks. It is the supported way to compute options from the incoming request: pick a theme from a cookie, choose a server list based on the host header, or hide documents the caller is not entitled to see.

If you are coming from a Scalar 1.x codebase, note that `ScalarOptions.EndpointPathPrefix` is obsolete. The route prefix moved to that first parameter, and the default changed from `/scalar/{documentName}` to plain `/scalar`. The old sub-path workarounds where you manually rewrote `OpenApiRoutePattern` for apps hosted under a path base are no longer needed and should be deleted, because relative resolution is handled for you now.

## Multiple documents and API versions in one sidebar

Swagger UI expressed this as repeated `SwaggerEndpoint` calls and a dropdown. Scalar expresses it as registered documents:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

// ...

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options
        .AddDocument("v1", "Orders API v1")
        .AddDocument("v2", "Orders API v2 (beta)", isDefault: true);
});
```

Each `AddDocument` overload accepts a name, an optional display title, and an optional route pattern, so documents that live at different paths coexist in one reference. `AddDocuments(["v1", "v2", "v3"])` is the terse form when the names are enough. If you generate one document per API version with `Asp.Versioning`, this is where those names land; the versioning-specific plumbing is in [API versioning with OpenAPI in .NET](/2026/04/api-versioning-openapi-dotnet-10/).

Document names are forwarded to the generator exactly as you type them, case included. A document registered as `V1` and requested as `v1` produces an empty reference rather than an error, because the fetch for the document simply 404s and the UI has nothing to render. Keep every document name lowercase and this never comes up.

## Making the Authorize button send a real token

This is the part that generates the most confusion, and the rule is simple: Scalar pre-fills only the security schemes your OpenAPI document already declares. It does not read your authentication middleware, and it cannot invent a scheme that the document does not describe. If the document has no `securitySchemes` entry, no amount of client configuration will attach an `Authorization` header. I wrote up that exact failure at length in [why your Bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/), and the diagnosis has not changed.

Assuming the document declares an HTTP bearer scheme named `BearerAuth`, this pre-selects it and pre-fills a development token:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("BearerAuth")
        .AddHttpAuthentication("BearerAuth", auth =>
        {
            auth.Token = builder.Configuration["Scalar:DevToken"]!;
        });
});
```

OAuth2 flows get first-class helpers rather than the flat key-value configuration Swagger UI used. `AddAuthorizationCodeFlow`, `AddClientCredentialsFlow`, `AddPasswordFlow`, and `AddImplicitFlow` each take a configuration delegate, and PKCE is a property rather than a checkbox you hope the UI honours:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("OAuth2")
        .AddAuthorizationCodeFlow("OAuth2", flow =>
        {
            flow.ClientId = builder.Configuration["Scalar:ClientId"]!;
            flow.Pkce = Pkce.Sha256;
            flow.SelectedScopes = ["orders.read", "orders.write"];
        });
});
```

Two things to hold onto. First, anything you pass here is serialized into the page the browser downloads, so a client secret configured this way is public. Scalar's own documentation says pre-filled authentication details should never be used in production, and that is not boilerplate caution: treat these values as if you had pasted them into a public HTML file, because you have. Second, `EnablePersistentAuthentication()` stores what the user types in browser storage across reloads, which is genuinely convenient on a laptop and genuinely wrong on a shared machine.

If you are setting up the server side of this at the same time, [JWT bearer authentication in a minimal API](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) covers the token validation half, and the scheme declaration itself is a document transformer, described in [customizing OpenAPI with operation and schema transformers](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Keeping the reference off production without losing it

Microsoft's guidance is explicit that OpenAPI user interfaces, Scalar included, belong in development environments only. The default template guard handles that:

```csharp
// Program.cs -- .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Teams that want the reference on an internal staging host have a better option than an environment check, and it exists precisely because Scalar is an endpoint. `MapScalarApiReference` returns an `IEndpointConventionBuilder`, so every routing convention applies:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference()
   .RequireAuthorization("InternalOnly")
   .ExcludeFromDescription();

app.MapOpenApi()
   .RequireAuthorization("InternalOnly");
```

Gate both. Protecting the UI while leaving `/openapi/v1.json` anonymous protects nothing: the document is the information disclosure, and the UI is just a renderer for it. `ExcludeFromDescription()` keeps the documentation endpoint from appearing inside the documentation, which is tidy rather than important.

## Assets, offline hosting, and the fonts that phone home

Scalar bundles its JavaScript and CSS inside the NuGet package and serves them from your own origin, so an air-gapped or offline environment works with no configuration. This was not true of very early 1.x releases, which is where the persistent belief that Scalar requires a CDN comes from.

The remaining external request is the default web font. Kill it with one call:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options.DisableDefaultFonts();
});
```

`WithBundleUrl("https://cdn.jsdelivr.net/npm/@scalar/api-reference")` goes the other direction, pulling the bundle from a CDN if you would rather track the newest UI without a package bump. If you run a strict Content Security Policy, `DisableDefaultFonts` plus the bundled assets means the reference needs nothing beyond `'self'` and the inline configuration script.

Options can also be bound from configuration instead of code, which is the cleanest way to keep environment-specific settings out of `Program.cs`:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOptions<ScalarOptions>().BindConfiguration("Scalar");
```

Anything set in the `MapScalarApiReference` delegate overrides the bound values.

## Scalar-only metadata: stability, hidden endpoints, code samples

The features with no Swagger UI equivalent live in a companion package, `Scalar.AspNetCore.Microsoft` (2.16.18, targeting `net9.0` and `net10.0`, depending on `Microsoft.AspNetCore.OpenApi` and `Microsoft.OpenApi` 2.7.5 or later). It registers document transformers that write Scalar's vendor extensions into the generated document. If you are still on Swashbuckle's generator, `Scalar.AspNetCore.Swashbuckle` does the same job through filters.

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore.Microsoft 2.16.18
builder.Services.AddOpenApi(options => options.AddScalarTransformers());

// ...

app.MapGet("/orders", GetOrders).Stable();
app.MapGet("/orders/forecast", GetForecast).Experimental();
app.MapGet("/internal/metrics", GetMetrics).ExcludeFromApiReference();
```

`ExcludeFromApiReference()` is the one worth calling out. It hides the operation in the rendered reference while leaving it in the OpenAPI document and fully routable, which is different from `ExcludeFromDescription()`, which removes it from the document altogether. Pick based on whether your client generators still need to see the endpoint. `CodeSample()` attaches a hand-written snippet for a given `ScalarTarget`, and `WithBadge()` puts a coloured label next to an operation, both of which are attributes on controller actions if you are not using minimal APIs.

## Gotchas that cost people an afternoon

**The package has no `net11.0` target framework.** As of 2.16.18 the TFM list stops at `net10.0`, and a `net11.0` project consumes the `net10.0` assets through normal compatibility rules. This is fine and expected during the preview window, but if your build fails an internal policy that demands an exact TFM match, that is the reason.

**A blank reference almost always means a missing document, not a broken UI.** Open `/openapi/v1.json` directly. If it 404s, `MapOpenApi` is not mapped, is behind a different environment guard than the UI, or is at a route Scalar was never told about. The reference renders an empty shell rather than an error in every one of those cases.

**Build-time document generation does not feed the UI.** Setting `OpenApiGenerateDocuments` in your `.csproj` writes a JSON file at build; it does not serve one at runtime. If you drop `MapOpenApi` because you now generate at build time, serve the generated file as a static file and point `WithOpenApiRoutePattern` at it.

**`launchUrl` still says `swagger`.** After deleting the Swagger UI middleware, `Properties/launchSettings.json` will keep opening a 404 on every `dotnet run` until you change `"launchUrl": "swagger"` to `"launchUrl": "scalar"`.

**Native AOT changes nothing here.** The built-in generator is AOT-compatible and Scalar serves static assets, so the pair survives `PublishAot` intact. What breaks under AOT is usually a reflection-based transformer you wrote, not the reference UI.

Swagger UI is not deprecated and `Swashbuckle.AspNetCore.SwaggerUI` still works perfectly well over a document produced by `Microsoft.AspNetCore.OpenApi`. The reason to move is that Scalar is an endpoint rather than middleware, ships its assets in the package, and pre-fills auth through a typed API instead of a bag of strings. If none of those matter to you, staying put is a defensible answer.

## Related

- [How to expose OpenAPI without Swashbuckle in ASP.NET Core 11](/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Scalar in ASP.NET Core: why your Bearer token is ignored](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Migrate from Swashbuckle to the built-in OpenAPI generator in .NET 11](/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [How to customize the OpenAPI document with operation and schema transformers](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [How to add OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)

## Sources

- [Use the generated OpenAPI documents](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0) on Microsoft Learn
- [Scalar ASP.NET Core integration documentation](https://scalar.com/products/api-references/integrations/aspnetcore/integration)
- [Scalar OpenAPI extensions for .NET](https://scalar.com/products/api-references/integrations/aspnetcore/openapi-extensions)
- [Migration guide for Scalar.AspNetCore 2.0.0](https://github.com/scalar/scalar/issues/4362)
- [Scalar.AspNetCore on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore)
