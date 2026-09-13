---
title: "ASP.NET Core 11 cheat sheet"
description: "ASP.NET Core 11 in one place: minimal APIs, OpenAPI, authentication, rate limiting, OpenTelemetry, Native AOT, and the Kestrel/HTTP-3 wins."
tagline: "The ASP.NET Core 11 bits worth bookmarking."
pubDate: 2026-05-03
updatedDate: 2026-09-13
indexTags:
  - "aspnetcore"
  - "aspnet-core"
  - "aspnet"
---

This pillar collects everything I've written about **ASP.NET Core 11** - minimal APIs, OpenAPI, authentication, rate limiting, observability, Native AOT, and the Blazor rendering changes in the .NET 11 cycle.

## What to read first

Settle the forks first: [minimal APIs vs controllers](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) leads, [Blazor Server vs WebAssembly vs United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) settles the UI hosting model - with [what a render mode is and which one runs your component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) for the per-component rules - and [gRPC vs REST vs SignalR](/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/) picks the transport. To secure it, [JWT vs cookie authentication](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) leads, then [validating issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) is the config people get wrong, and [RC 1's SignalR token refresh](/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/) outlives token expiry. Day one, [per-endpoint rate limiting](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) and [OpenAPI auth flows](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) come first, and [Scalar vs Swagger UI](/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) picks the renderer; on Swashbuckle, [Swagger UI rejects .NET 11's OpenAPI 3.2 document](/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/) until you upgrade. C# 15 unions [bind in bodies, SignalR and OpenAPI](/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/), not query strings. On hot paths, [Native AOT with minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is the win.

In the pipeline, [endpoint filters vs middleware](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) settles that fork, and for caching, [output vs response caching](/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) is the call. For configuration, [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) picks the lifetime, and [WebApplicationFactory vs Testcontainers](/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) picks the test harness. For observability, [OpenTelemetry](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) and [Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) are the starting points.

## What's on this page

The list below auto-collects posts tagged with any of: `aspnetcore`, `aspnet-core`, `aspnet`. Newest first.

The companion [`.NET 11 tracker`](/pillars/dotnet-11-tracker/) collects the broader release; many posts overlap.
