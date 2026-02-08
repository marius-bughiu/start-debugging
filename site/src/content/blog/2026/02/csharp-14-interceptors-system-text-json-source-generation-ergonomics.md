---
title: "C# 14 idea: interceptors could make System.Text.Json source generation feel automatic"
description: "A community discussion proposed using C# 14 interceptors to rewrite JsonSerializer calls so they automatically use a generated JsonSerializerContext, keeping AOT-friendly source generation with cleaner call sites."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
  - "system-text-json"
  - "aot"
---

One of the more interesting .NET discussions in the last 24 to 48 hours was a simple question: why does `System.Text.Json` source generation still feel "manual" at the call site?

The trigger was a Feb 7, 2026 thread proposing an approach that is very C# 14 in spirit: **interceptors** that rewrite `JsonSerializer.Serialize` and `JsonSerializer.Deserialize` calls to use a generated `JsonSerializerContext` automatically.

## The ergonomic gap: context works, but it spreads through your code

If you want trimming safety and predictable performance in **.NET 10**, source generation is a strong option. The friction is that you end up threading context everywhere:

```csharp
using System.Text.Json;

var foo = JsonSerializer.Deserialize<Foo>(json, FooJsonContext.Default.Foo);
var payload = JsonSerializer.Serialize(foo, FooJsonContext.Default.Foo);
```

It is explicit and correct, but it is noisy. That noise tends to leak into app layers that should not care about serialization plumbing.

## What an interceptor-based rewrite could look like

The idea is: keep the clean call sites:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json);
```

Then have an interceptor (at compile time) rewrite it into the context-based call you would have written by hand:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json, GlobalJsonContext.Default.Foo);
```

If you have multiple option profiles, the interceptor needs a deterministic mapping to the right context instance. That is where the "this is hard" part starts.

## The constraints that make or break it (AOT is the judge)

For this to be more than a nice idea, it has to survive the environments where source generation matters most:

- **NativeAOT and trimming**: the rewrite must not accidentally reintroduce reflection-based fallbacks.
- **Options identity**: you need a stable way to pick a context for a given `JsonSerializerOptions`. Runtime-mutated options are not a good fit.
- **Partial compilation**: interceptors must behave consistently across projects, test assemblies, and incremental builds.

If those constraints are met, you get a rare win: **keep the AOT-friendly pipeline**, but remove the "context plumbing" from most of your code.

The practical takeaway today: even if interceptors do not land in the exact form discussed, this is a strong signal that .NET developers want better ergonomics around source generation. I would expect future tooling, analyzers, or framework patterns to move in that direction.

Sources:

- [Reddit thread](https://www.reddit.com/r/csharp/comments/1qyaviv/interceptors_for_systemtextjson_source_generation/)
- [System.Text.Json source generation docs](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation)
