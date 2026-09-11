---
title: "C# Unions in ASP.NET Core 11: Bodies, SignalR, and OpenAPI Work, Query Strings Do Not"
description: "The ASP.NET Core team mapped out where C# 15 union types flow through .NET 11: minimal API and MVC bodies, SignalR's JsonHubProtocol, Blazor, and OpenAPI anyOf schemas. Route, query, header, and form binding are not supported yet."
pubDate: 2026-09-11
tags:
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "signalr"
---

On September 10, a day after .NET 11 RC 1 shipped, the ASP.NET Core team published [Use C# unions and closed hierarchies in ASP.NET Core](https://devblogs.microsoft.com/dotnet/unions-and-closed-hierarchies-in-aspnetcore/). It is the first complete map of where C# 15 `union` types actually work across the web stack, and the answer is simple: anything that goes through System.Text.Json works, and everything else does not.

## Unions as request bodies and return types

Since unions serialize as their active case with no wrapper or discriminator (the behavior that landed in [System.Text.Json in .NET 11 Preview 6](/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/)), a minimal API can accept and return them directly:

```csharp
public record Cat(string Name, string Coat);
public record Dog(string Name, string Breed);

[JsonUnion(TypeClassifier = typeof(JsonUnionTypeStructuralClassifier))]
public union UnionPet(Cat, Dog);

public union UnionIntString(int, string);

app.MapPost("/pet", ([FromBody] UnionPet pet) => TypedResults.Ok(pet));
app.MapGet("/value", () => new UnionIntString(42));
```

`UnionPet` needs the structural classifier because both cases are JSON objects: STJ has to look at property names (`coat` vs `breed`) to pick a case before deserializing. That scan costs extra work per request, and renaming a property can silently change which case wins, so treat those property names as part of your contract.

MVC controllers get the same behavior through the STJ input and output formatters, so a `[FromBody] UnionBoolString` action parameter or a union return type works without extra setup.

## OpenAPI emits anyOf

The built-in OpenAPI generator in .NET 11 describes a union as `anyOf` with one entry per case:

```json
"UnionIntString": {
  "anyOf": [
    { "type": "integer", "format": "int32" },
    { "type": "string" }
  ]
}
```

That is the shape client generators need for contracts like Kubernetes' `maxUnavailable`, which accepts either `2` or `"25%"`. Before unions, you modeled this with a custom `JsonConverter` and a hand-written schema transformer.

## SignalR and Blazor

SignalR's `JsonHubProtocol` supports unions as hub method parameters, return values, and `IAsyncEnumerable<T>` stream items. The MessagePack and Newtonsoft.Json hub protocols do not. Blazor handles unions in component parameters (in-process, no serialization), JS interop, and persisted component state through `PersistAsJson` / `TryTakeFromJson`.

## Where binding stops

Route values, query strings, headers, and form fields do not go through STJ, so unions are not supported there. The blog's reasoning is that a plain string token gives no reliable way to pick a case. Blazor's `[SupplyParameterFromQuery]` is excluded for the same reason. The design discussion is open in [dotnet/aspnetcore#66648](https://github.com/dotnet/aspnetcore/issues/66648).

Until that lands, bind the raw string and build the union yourself:

```csharp
app.MapGet("/rollout", (string maxUnavailable) =>
    int.TryParse(maxUnavailable, out var count)
        ? new UnionIntString(count)
        : new UnionIntString(maxUnavailable));
```

One more trap sits on the body side. `JsonSerializerOptions.Web` allows numbers to be read from strings, so when `UnionIntString` is a request body, the JSON token `"42"` matches both `int` and `string`. Returning that union is fine, but accepting it as input needs a custom classifier. SignalR does not have this problem because `JsonHubProtocol` does not treat a string token as a possible number.

## Unions or closed hierarchies

The post also covers `closed` class hierarchies with `[JsonPolymorphic(InferClosedTypePolymorphism = true)]`, which produce a `$type` discriminator without listing every `[JsonDerivedType]`. The guidance is useful: pick a union when the JSON contract must stay discriminator-free or the cases are primitives and types you do not own, and pick a closed hierarchy when you are designing a new API whose cases share a base type. If you are on .NET 11 RC 1 today, both are ready to try in bodies and responses. Keep them out of your route templates for now.
