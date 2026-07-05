---
title: "ASP.NET Core 11 cheat sheet"
description: "ASP.NET Core 11 in one place: minimal APIs, OpenAPI, authentication, rate limiting, OpenTelemetry, Native AOT, and the Kestrel/HTTP-3 wins."
tagline: "The ASP.NET Core 11 bits worth bookmarking."
pubDate: 2026-05-03
updatedDate: 2026-07-05
indexTags:
  - "aspnetcore"
  - "aspnet-core"
  - "aspnet"
---

This pillar collects everything I've written about **ASP.NET Core 11** - minimal APIs, OpenAPI and Swagger UI flows, authentication and Identity, rate limiting, observability with OpenTelemetry, Native AOT, the Kestrel/HTTP-3 work, and the Blazor server-side rendering changes that landed in the .NET 11 cycle.

## What to read first

Before the feature surface, settle the architectural forks: [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) is the decision to make first, and if you're building UI, [Blazor Server vs WebAssembly vs United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) settles the hosting model. To secure an API, [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) is the first call, then [validating a JWT's issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) covers the config most people get wrong. For day-one feature surface, [per-endpoint rate limiting](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) and [OpenAPI authentication flows in Swagger UI](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) are the changes you're most likely to wire up first. For perf-sensitive paths, [Native AOT with minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) and [Kestrel's early HTTP/3 request processing](/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/) are the headline runtime wins.

For background jobs, [BackgroundService vs IHostedService vs Hangfire in .NET 11](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) settles the hosting choice. For observability, [OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) and [structured logging with Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) are the practical starting points.

## What's on this page

The list below auto-collects posts tagged with any of: `aspnetcore`, `aspnet-core`, `aspnet`. Newest first.

The companion [`.NET 11 tracker`](/pillars/dotnet-11-tracker/) pillar collects the broader release; many ASP.NET Core posts overlap with it.
