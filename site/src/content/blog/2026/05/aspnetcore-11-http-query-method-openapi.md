---
title: "ASP.NET Core in .NET 11 Preview 4 Teaches OpenAPI About the HTTP QUERY Method"
description: ".NET 11 Preview 4 makes ASP.NET Core OpenAPI generation recognize HTTP QUERY as a first-class operation in OpenAPI 3.2, with a graceful fallback for 3.0 and 3.1 documents."
pubDate: 2026-05-24
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "http"
  - "minimal-apis"
---

[.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), released May 12, 2026, slipped in a small but forward-looking change to ASP.NET Core: OpenAPI document generation now recognizes `QUERY` as a known HTTP operation type. If you have never heard of the QUERY method, that is the point of this post. It is a proposed standard method that fixes a real tension that has nagged at search endpoints for years.

## Why a new verb for searching

A search request wants two things that the existing verbs cannot give you together. It wants to be safe and idempotent, like `GET`, so caches and proxies can treat it sensibly and a retry never mutates anything. And it wants to carry a structured request body, like `POST`, because a serious filter (nested boolean clauses, geo bounds, a vector plus metadata predicates) does not fit cleanly in a query string and bumps into URL length limits.

Teams have papered over this for a decade by sending `POST /search` with a JSON body and quietly pretending it is idempotent. That works, but it lies to every cache and intermediary in the path. The IETF `QUERY` method is the honest version: `GET` semantics (safe, idempotent, cacheable) plus a request body. Preview 4 does not invent the method, it teaches the OpenAPI pipeline to describe it correctly.

## Mapping a QUERY endpoint

Routing already supported arbitrary verbs, so there is no new attribute to learn. You map a QUERY endpoint with the existing `MapMethods` overload:

```csharp
app.MapMethods("/search", ["QUERY"], (SearchRequest request) =>
    SearchService.Run(request));
```

The new part is what comes out of the OpenAPI document generator. QUERY only became a first-class concept in OpenAPI 3.2, so you have to opt into that spec version:

```csharp
builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_2;
});
```

With 3.2 selected, the endpoint above is emitted as a proper `query` operation on the path item. If you are still pinned to OpenAPI 3.0 or 3.1, which predate the method, the generator does not silently drop the endpoint. It falls back to an `x-oai-additionalOperations` extension so tooling that understands the extension can still see the operation, and tooling that does not at least will not choke.

## Worth knowing before you ship it

QUERY is still a proposed method, so support across browsers, HTTP clients, CDNs, and corporate proxies is uneven. This change is about accurately documenting an endpoint, not a promise that every intermediary will route it. For internal service-to-service search APIs where you control both ends, it is a clean fit today. For public APIs, treat it as future-proofing and keep a `POST` path until the ecosystem catches up.

The work landed in [dotnet/aspnetcore #65714](https://github.com/dotnet/aspnetcore/pull/65714). It is a quiet line in a quiet preview, but it is the kind of plumbing that decides whether QUERY actually arrives or stays a draft forever.
