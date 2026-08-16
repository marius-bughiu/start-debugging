---
title: "ASP.NET Core 11 cheat sheet"
description: "ASP.NET Core 11 in one place: minimal APIs, OpenAPI, authentication, rate limiting, OpenTelemetry, Native AOT, and the Kestrel/HTTP-3 wins."
tagline: "The ASP.NET Core 11 bits worth bookmarking."
pubDate: 2026-05-03
updatedDate: 2026-08-16
indexTags:
  - "aspnetcore"
  - "aspnet-core"
  - "aspnet"
---

This pillar collects everything I've written about **ASP.NET Core 11** - minimal APIs, OpenAPI, authentication, rate limiting, OpenTelemetry, Native AOT, the Kestrel/HTTP-3 work, and the Blazor rendering changes that landed in the .NET 11 cycle.

## What to read first

Settle the architectural forks first: [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) comes first, [Blazor Server vs WebAssembly vs United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) settles the UI hosting model, and [gRPC vs REST vs SignalR](/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/) picks the transport for service-to-service calls. To secure an API, [JWT vs cookie authentication](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) leads, then [validating its issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) covers the config people get wrong. For day-one surface, [per-endpoint rate limiting](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) and [OpenAPI auth flows](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) are what you'll wire up first, and [Scalar vs Swagger UI](/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) picks the docs renderer. On perf-sensitive paths, [Native AOT with minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) and [Kestrel's early HTTP/3 processing](/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/) are the runtime wins.

For the request pipeline, [endpoint filters vs middleware](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) settles that fork; for caching, [output caching vs response caching](/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) is the call, and [Zstandard vs Brotli vs Gzip](/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) sets the compression default. For configuration, [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) decides which lifetime you inject, and [WebApplicationFactory vs Testcontainers](/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) picks the integration-test harness. For background jobs, [BackgroundService vs IHostedService vs Hangfire](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) settles it. For observability, start with [OpenTelemetry](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) and [Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## What's on this page

The list below auto-collects posts tagged with any of: `aspnetcore`, `aspnet-core`, `aspnet`. Newest first.

The companion [`.NET 11 tracker`](/pillars/dotnet-11-tracker/) pillar collects the broader release; many posts overlap.
