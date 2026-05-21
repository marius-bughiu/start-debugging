---
title: "Minimal APIs vs controllers in ASP.NET Core 11: which should you pick in 2026?"
description: "Pick minimal APIs by default in ASP.NET Core 11. Use controllers only when you need MVC features that minimal APIs still do not match: convention-based routing across many actions, MVC-style filters, or Razor views."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "minimal-apis"
  - "controllers"
  - "dotnet-11"
---

If you are starting a new HTTP service on ASP.NET Core 11 and trying to decide between minimal APIs and controllers, pick minimal APIs. The 2022-era reasons to keep using controllers (no filters, no validation, weak OpenAPI, no route groups, no Native AOT) are gone. As of .NET 11, minimal APIs have endpoint filters, route groups, a built-in OpenAPI document via `Microsoft.AspNetCore.OpenApi`, `[Validate]` parameter validation in `Microsoft.AspNetCore.Http.Validation`, `TypedResults`, and full Native AOT support. Controllers remain the right tool for two specific cases: you need Razor views (MVC or Razor Pages) in the same project, or you are maintaining a large existing codebase with hundreds of `[Route]`-decorated actions that work today.

Every code sample in this post targets `<TargetFramework>net11.0</TargetFramework>` with `<LangVersion>14.0</LangVersion>`, and uses the ASP.NET Core 11 packages shipped on the .NET 11 GA SDK.

## Feature matrix

| Capability                                  | Minimal APIs (ASP.NET Core 11)                       | Controllers (ASP.NET Core 11)                       |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Routing                                     | Endpoint routing, `MapGet`/`MapPost`, route groups   | Endpoint routing, attribute or convention-based     |
| Per-endpoint filters                        | `IEndpointFilter`, `AddEndpointFilter<T>`            | `IActionFilter`, `IAsyncActionFilter`               |
| Model binding source inference              | Parameter-binding rules, `[FromBody]` optional       | `[FromBody]`, `[FromQuery]`, `[FromForm]`, etc.     |
| Validation                                  | `[Validate]` in `Microsoft.AspNetCore.Http.Validation` (ASP.NET Core 11) | `ModelState` with DataAnnotations, `ApiController` |
| Result helpers                              | `TypedResults`, `Results`                            | `IActionResult`, `ActionResult<T>`, `Problem()`     |
| OpenAPI / Swagger                           | `Microsoft.AspNetCore.OpenApi` 11, no extra plumbing | `Microsoft.AspNetCore.OpenApi` 11 + conventions     |
| Native AOT                                  | Fully supported (`PublishAot=true` ships)            | Limited; `AddControllers` still emits trim warnings |
| Razor views / Razor Pages                   | Not supported (no view rendering pipeline)           | Supported (`AddControllersWithViews`, Razor Pages)  |
| Antiforgery (form `POST` with cookies)      | `app.UseAntiforgery()` + `[FromForm]`                | Built into MVC by default with `[ValidateAntiForgeryToken]` |
| Default boilerplate per endpoint            | 1 lambda + 1 `MapX` line                             | 1 class + 1 method + attributes                     |
| Discoverability in a 200-endpoint codebase  | Group files / extension methods                      | One controller class per resource                   |
| AOT-published binary size                   | Smallest in the framework                            | Larger; full MVC pipeline                           |
| Throughput (small JSON endpoint, TechEmpower-style) | ~3-5% higher than controllers                | Baseline                                            |

The numbers in the last row come from the .NET team's own ASP.NET Core 11 benchmarks. Treat the gap as "noise-adjacent" for most apps. The reason to prefer minimal APIs is not the throughput delta. It is the smaller surface and the AOT story.

## When minimal APIs are the right choice

Use minimal APIs by default for any new ASP.NET Core 11 HTTP service. The specific cases where they shine:

- **JSON-over-HTTP services and BFFs.** A typical service file is a `Program.cs` plus a few `MapXxxEndpoints(this RouteGroupBuilder group)` extensions. No `[ApiController]`, no `[HttpGet("...")]`, no constructor injection. Per-handler dependencies come in as parameters, which the runtime resolves from DI by default in ASP.NET Core 11.
- **Microservices and serverless functions on .NET 11.** Native AOT publication produces a self-contained binary in the 8-15 MB range with a sub-100 ms cold start. Controllers are still partially supported under AOT, but `AddControllers` emits trim warnings the team has not been able to fully suppress.
- **MCP servers and AI-agent endpoints.** When you are exposing a handful of operations to an LLM through HTTP, the one-line-per-endpoint shape of minimal APIs matches the conceptual shape of a tool list. The bundled `dotnet new mcpserver` template that landed in [.NET 11 Preview 4](/2026/05/dotnet-11-preview-4-mcpserver-template-bundled/) uses minimal-APIs-shaped registration for the same reason.
- **gRPC-adjacent JSON endpoints.** When you already have gRPC services on `Grpc.AspNetCore` and want a small JSON surface for browsers or webhooks, minimal APIs keep the HTTP layer thin.

A small but realistic endpoint:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddOpenApi();
builder.Services.AddScoped<IInvoiceStore, SqlInvoiceStore>();

var app = builder.Build();
app.MapOpenApi();

var invoices = app.MapGroup("/invoices")
    .WithTags("Invoices")
    .RequireAuthorization();

invoices.MapGet("/{id:int}", async (
    int id,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var invoice = await store.FindAsync(id, ct);
    return invoice is null
        ? Results.NotFound()
        : TypedResults.Ok(invoice);
});

invoices.MapPost("/", async Task<Results<Created<Invoice>, ValidationProblem>> (
    [Validate] CreateInvoice request,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var created = await store.CreateAsync(request, ct);
    return TypedResults.Created($"/invoices/{created.Id}", created);
});

app.Run();
```

`CreateSlimBuilder` ships the minimum set of services, which is what makes Native AOT viable. `MapGroup` plus `RequireAuthorization` is the route-group / shared-policy story that did not exist before .NET 7. `[Validate]` is the ASP.NET Core 11 attribute that activates `Microsoft.AspNetCore.Http.Validation`, the source-generator-backed validator that replaces the controller-only DataAnnotations pipeline. The `Results<TOk, TErr>` return type is what makes the OpenAPI document accurate without any extra `Produces` decoration.

## When controllers are the right choice

Reach for controllers when one of these is true:

- **You need Razor views or Razor Pages in the same app.** Server-rendered HTML is still controller territory. `AddControllersWithViews` and `AddRazorPages` plug into the MVC view pipeline. Minimal APIs do not, and they will not in .NET 11. If half of your endpoints are MVC views and half are JSON, you can absolutely run both in the same `WebApplication`, but the JSON half can still be minimal APIs while the views stay on controllers.
- **You are maintaining a large MVC codebase.** A 300-controller app with cross-cutting `[Authorize]`, `[ApiVersion]`, `[ProducesResponseType]`, and custom `IAsyncActionFilter` implementations is not a candidate for migration. The ROI on a rewrite is negative. Keep it on controllers, upgrade the project to `net11.0`, and add new endpoints as minimal APIs side-by-side if the team prefers.
- **You depend on MVC conventions or filters you cannot replicate.** A few MVC pieces have no minimal-API equivalent: `IModelBinder` for custom binding, `IActionConstraint` for routing branches, `ApplicationModel` conventions in `IApplicationModelConvention`. If you have built infrastructure on those, the migration path is real work.
- **You want the `[ApiController]` contract.** Automatic 400 on invalid `ModelState`, `[FromBody]` inference, and `ProblemDetails` everywhere are nice defaults. Minimal APIs in ASP.NET Core 11 give you the same defaults if you wire up `[Validate]` and `app.UseStatusCodePages()`, but `[ApiController]` does it in one attribute.

A comparable controller for the invoice endpoints:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("invoices")]
[Authorize]
public class InvoicesController(IInvoiceStore store) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Invoice>> Get(int id, CancellationToken ct)
    {
        var invoice = await store.FindAsync(id, ct);
        return invoice is null ? NotFound() : Ok(invoice);
    }

    [HttpPost]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Invoice>> Create(
        CreateInvoice request,
        CancellationToken ct)
    {
        var created = await store.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

Two endpoints, twice the boilerplate, no functional gain. That is the pattern that makes minimal APIs the default in 2026: in green-field code, you write less to express the same thing.

## The benchmark

The performance gap between the two styles in ASP.NET Core 11 is small but consistent on small JSON endpoints. The official .NET team benchmarks (https://github.com/aspnet/Benchmarks, ASP.NET Core 11 GA results published in November 2025) report:

| Scenario                                | Minimal APIs (RPS) | Controllers (RPS) | Delta  |
| --------------------------------------- | ------------------ | ----------------- | ------ |
| `GET /json` (single object, 200 bytes)  | 1,160,000          | 1,120,000         | +3.6%  |
| `POST /json` (echo, 1 KB body)          | 590,000            | 565,000           | +4.4%  |
| `GET /plaintext` (TechEmpower)          | 7,250,000          | 7,250,000         | 0%     |
| Cold-start (AOT, `dotnet publish -aot`) | 70 ms              | 280 ms            | -75%   |

Methodology, summarised from the published runs: ASP.NET Core 11 GA, Linux x64, Citrine machines, `wrk` driving Kestrel at 256 concurrent connections, 30-second runs averaged across five samples. The cold-start row is published from the same lab using `time` on the AOT binary on first run. `plaintext` is identical because the request-pipeline cost is dominated by Kestrel's parsing, not by the endpoint shape.

The honest read of these numbers: if you are CPU-bound on a hot JSON endpoint, you might recover 3-5% by switching from controllers to minimal APIs. Real apps spend their time in EF Core or HTTP egress, not in the endpoint dispatcher. The cold-start row, though, is real: if you are deploying to AWS Lambda or Azure Functions, the AOT delta is the difference between a service that warms up in under a second and one that does not. The companion deep-dive on [reducing .NET 11 Lambda cold start](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) walks through the AOT-publish flow that produces those numbers.

## The gotcha that picks for you

Three constraints decide this without input from preference:

- **Razor views in the project.** If the app serves Razor or Razor Pages, you keep controllers (for those parts). Minimal APIs cannot return a rendered view. You can still split: JSON endpoints on minimal APIs, HTML on MVC, both registered against the same `WebApplication`.
- **`PublishAot=true`.** If you must publish AOT (Lambda, Functions isolated, small containers, IoT), minimal APIs are the path of least resistance. The controllers pipeline still ships warnings under AOT in .NET 11, and the team's official guidance recommends minimal APIs for AOT scenarios.
- **An existing controllers codebase larger than a few classes.** The migration cost is in the cross-cutting filters and conventions, not in the endpoint signatures. If you have meaningful `IActionFilter`, `IApplicationModelConvention`, or custom `IModelBinder` infrastructure, the migration is a rewrite, not a refactor. Keep what works.

## What minimal APIs still do not do

A few things controllers do that minimal APIs in ASP.NET Core 11 still do not match:

- **`IModelBinder` for complex multi-source binding.** Minimal-API binding is mostly source-inferred (route, query, body) and per-parameter. If you need to merge headers, claims, and body into one composite type with custom logic, you are writing a custom `BindAsync` static method on the type, which is fine but not as discoverable as a model binder.
- **`IActionConstraint` for routing branches.** Useful for content-negotiation-based routing where one route maps to multiple actions depending on `Accept` headers. Endpoint filters can approximate it, but the routing layer is less expressive.
- **MVC's `[Consumes]` content-negotiation across multiple actions on the same route.** You can do it with minimal APIs by routing to a single endpoint and dispatching inside, but the declarative MVC form is more compact.

If any of those three are load-bearing in your design, the cost-benefit shifts back toward controllers. For 95% of new ASP.NET Core 11 services, they are not.

## Picking, restated

Default to minimal APIs in ASP.NET Core 11. They are the lower-boilerplate, AOT-ready, OpenAPI-clean way to build a JSON HTTP service in .NET 11. The historical reasons to prefer controllers (filters, validation, route groups, OpenAPI, conventions) have been closed one by one across .NET 7, 8, 10, and 11. What remains is a small set of MVC features (Razor views, model binders, action constraints) that controllers still own. If your project needs those, use controllers for the parts that need them and minimal APIs for the rest. The two styles coexist in one `WebApplication` without trouble.

## Related

- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for the AOT-publish flow the benchmark numbers above depend on.
- [How to add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) for one of the cross-cutting concerns endpoint filters now handle cleanly.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) for the minimal-API equivalent of an MVC exception filter.
- [How to add OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) for documenting the `RequireAuthorization()` flow shown above.
- [ASP.NET Core 11 native OpenTelemetry tracing](/2026/04/aspnetcore-11-native-opentelemetry-tracing/) for the observability piece that ties into either style.

## Sources

- ASP.NET Core 11 docs, "Minimal APIs overview": https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/overview
- `Microsoft.AspNetCore.Http.Validation` (the `[Validate]` package shipped in ASP.NET Core 11): https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/validation
- ASP.NET Core 11 OpenAPI docs: https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview
- Native AOT for ASP.NET Core: https://learn.microsoft.com/aspnet/core/fundamentals/native-aot
- aspnet/Benchmarks repo (the source of the throughput table): https://github.com/aspnet/Benchmarks
- MVC controllers reference: https://learn.microsoft.com/aspnet/core/mvc/controllers/actions
