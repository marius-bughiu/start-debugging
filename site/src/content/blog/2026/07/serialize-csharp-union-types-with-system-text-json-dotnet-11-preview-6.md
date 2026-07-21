---
title: "System.Text.Json Learns to Serialize C# Union Types in .NET 11 Preview 6"
description: "How System.Text.Json in .NET 11 Preview 6 serializes the new C# union types by writing the active case, and the JsonUnionAttribute and type-classifier APIs that handle ambiguous cases."
pubDate: 2026-07-21
tags:
  - "csharp"
  - "dotnet-11"
  - "system-text-json"
  - "json"
---

C# unions have been the headline feature of the .NET 11 previews, but until now they stopped at the compiler boundary. As of [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) (July 9, 2026), `System.Text.Json` understands them natively: you can serialize and deserialize a union without writing a custom `JsonConverter`. Two other things also fell into place in Preview 6, so the whole thing finally works with zero boilerplate: the support types `System.Runtime.CompilerServices.UnionAttribute` and `IUnion` now ship in the framework, so a union compiles on a plain `net11.0` project.

## Writing the active case, not a wrapper

A union declares that a value is exactly one of a fixed set of case types. The shorthand generates a struct that holds whichever case is currently active:

```csharp
public union Pet(Cat, Dog, Bird);

public record Cat(string Name);
public record Dog(string Name);
public record Bird(string Name);
```

`System.Text.Json` recognizes this through a new contract kind, `JsonTypeInfoKind.Union`. When you serialize a union, the serializer reads the active case and writes *its* value directly, with no envelope around it:

```csharp
Pet pet = new Dog("Rex");
string json = JsonSerializer.Serialize(pet);
// {"Name":"Rex"}
```

For a union of primitives, that means a union of `int` and `string` round-trips cleanly, because the JSON tokens are structurally distinct:

```csharp
Pet-like union of (int, string):
"hello"   // the string case
42        // the int case
```

Both the reflection-based serializer and the source generator support this, so you are not forced off the AOT-friendly path to use it.

## The discriminator gap, and how to close it

Writing the raw value is elegant, but notice what happens with `Pet`: a `Dog("Rex")` and a `Cat("Rex")` both serialize to `{"Name":"Rex"}`. On the way back in, the serializer cannot tell which case that was. This is the classic tagged-union problem, and Preview 6 hands you the tools to solve it rather than guessing.

Three new APIs control how cases are discovered and named: `JsonUnionAttribute`, `JsonUnionCaseInfo`, and the type-classifier pair `JsonTypeClassifier` and `JsonSerializerOptions.TypeClassifiers`. Together they let you attach a type discriminator to the emitted JSON so ambiguous object-shaped cases deserialize back to the right case type. Structurally distinct cases (like `int` versus `string`) need none of this; the ceremony only kicks in when the payloads would otherwise collide.

If you have been reading the [union types coverage from Preview 2](/2026/04/csharp-15-union-types-dotnet-11-preview-2/), this is the piece that makes them usable across an HTTP boundary. Unions were always going to live or die on serialization support, and Preview 6 is where they stop being a compiler curiosity and start being something you can put on a wire.

Full details are in the [Preview 6 libraries release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/libraries.md).
