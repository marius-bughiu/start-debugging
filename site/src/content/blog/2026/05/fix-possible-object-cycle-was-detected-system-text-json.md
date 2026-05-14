---
title: "Fix: A possible object cycle was detected"
description: "System.Text.Json refuses to serialize graphs with back-references. Set ReferenceHandler.IgnoreCycles, project to a DTO, or mark the back-pointer with [JsonIgnore]. Preserve is a last resort."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
  - "ef-core"
---

The fix: `System.Text.Json` refuses to serialize any object graph that walks back into itself. In an EF Core entity with a `Parent` property and a `Children` collection that both reference each other, the writer loops forever, hits the depth guard, and throws. Set `JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles` for a one-line fix, mark the back-pointer with `[JsonIgnore]` for a permanent one, or project the entity to a DTO that simply does not have the back-pointer. `ReferenceHandler.Preserve` works but changes the wire format to `$id`/`$ref`, which is rarely what an API consumer wants.

```text
System.Text.Json.JsonException: A possible object cycle was detected. This can either be due to a cycle or if the object depth is larger than the maximum allowed depth of 32. Consider using ReferenceHandler.Preserve on JsonSerializerOptions to support cycles. Path: $.Children.Parent.Children.Parent.Children.Parent...
   at System.Text.Json.ThrowHelper.ThrowJsonException_SerializerCycleDetected(Int32 maxDepth)
   at System.Text.Json.Serialization.JsonConverter`1.TryWrite(Utf8JsonWriter writer, T& value, JsonSerializerOptions options, WriteStack& state)
   at System.Text.Json.Serialization.Metadata.JsonTypeInfo`1.SerializeAsObject(Utf8JsonWriter writer, Object rootValue)
   at System.Text.Json.JsonSerializer.WriteString[TValue](TValue value, JsonTypeInfo jsonTypeInfo)
```

This guide is written against .NET 11 preview 4 and `System.Text.Json` 11.0.0-preview.4. The exception message has not changed since `System.Text.Json` first added cycle detection in .NET 5, and `ReferenceHandler.IgnoreCycles` has been available since .NET 6. The `Path` segment in the exception is the JSON path the writer was at when it gave up. If the path is a repeating pattern like `$.Children.Parent.Children.Parent`, you have a true cycle. If the path is a straight descent like `$.Order.Customer.Address.Country.Region.Continent...`, you do not have a cycle, you have a graph that is genuinely deeper than 32 levels and need `MaxDepth`, which is a different fix.

## Why the writer refuses to follow the loop

`System.Text.Json` serializes graphs as trees. A JSON document is a tree by definition, there is no syntax for "this node is the same as that node over there". So the writer walks the object graph depth-first and emits each reference as a fresh nested object. The moment a property points back to an ancestor, the walk does not terminate.

To stop the process from running until it exhausts the stack, the writer tracks the current depth and throws a `JsonException` when it exceeds `JsonSerializerOptions.MaxDepth`, which defaults to 64. The default error message conflates two cases (a real cycle and an honest deep tree) because the writer cannot tell them apart from the inside, it just sees that it is too deep. The `Consider using ReferenceHandler.Preserve` hint at the end of the message is the runtime's best guess. It is correct that `Preserve` would let the call succeed, but it is rarely the right fix for an API. Projecting to a DTO or breaking the back-reference is.

The default in ASP.NET Core was changed in .NET 6 so that the framework's `JsonOptions` (used by minimal APIs and controller actions) do not switch to `IgnoreCycles` for you. You opt in explicitly. The reasoning was that silent cycle dropping hides bugs in the response model, the canonical answer is to fix the model.

## A minimal repro

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4, System.Text.Json 11.0.0-preview.4
public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Book> Books { get; set; } = new();
}

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var author = new Author { Id = 1, Name = "Carla" };
var book = new Book { Id = 1, Title = "Refactoring", Author = author };
author.Books.Add(book);

var json = JsonSerializer.Serialize(author); // throws
```

`author.Books[0].Author` is the same instance as `author`. The writer descends into `Books`, descends into the first `Book`, then descends into its `Author`, finds `Books` again, and loops. The 64-level depth guard fires before the process dies.

The same shape appears the moment you `Include` a navigation property in EF Core and return the tracked entity from a controller without projecting it. EF Core fixes up the navigation properties so the parent points at its children and the children point back at the parent. That is the right behaviour for change tracking. It is the wrong shape for JSON.

## Fix, in detail

### 1. Project to a DTO

The canonical answer is to never serialize EF Core entities directly. Return a DTO that flattens or omits the back-reference:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public record AuthorDto(int Id, string Name, IReadOnlyList<BookDto> Books);
public record BookDto(int Id, string Title);

var dto = await db.Authors
    .Where(a => a.Id == 1)
    .Select(a => new AuthorDto(
        a.Id,
        a.Name,
        a.Books.Select(b => new BookDto(b.Id, b.Title)).ToList()))
    .FirstAsync();

var json = JsonSerializer.Serialize(dto); // works
```

This is the answer the .NET team recommends and it is the right answer for any public API. The DTO is what the consumer actually wants, the entity is an internal type that happens to have the same field names. Projecting in the EF Core query also makes the SQL smaller, the database only returns the columns the DTO needs. For background on the EF Core side of this pattern, the [warm up EF Core's model before the first query](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) post covers the projection mechanics in more depth.

### 2. Set ReferenceHandler.IgnoreCycles globally

If you must serialize an entity directly (a quick internal endpoint, an admin tool, a debug dump), set the option once on the host:

```csharp
// .NET 11, C# 14, ASP.NET Core 11
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

For controllers (System.Text.Json):

```csharp
// .NET 11, C# 14, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

`IgnoreCycles` writes `null` whenever the writer detects it is about to revisit an instance already on the current branch. The cycle is broken, the call succeeds, and the consumer gets a tree. The cost is that `book.Author` will serialize as `null` even though it was clearly populated, which can be confusing if the consumer expects round-trip fidelity.

`IgnoreCycles` was added in .NET 6 specifically because `Preserve` was too disruptive a default and `[JsonIgnore]` only solves it case by case. Reach for it as the global serializer setting for read-only response paths and leave the model alone.

### 3. Mark the back-reference with [JsonIgnore]

If the back-pointer is never useful in JSON (the consumer always knows the parent because it just asked for it), mark it directly:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }

    [JsonIgnore]
    public Author Author { get; set; } = null!;
}
```

`[JsonIgnore]` removes the property from both the serializer and the deserializer for that type. The cycle disappears at compile time, no runtime option needed. This is the right fix for a navigation property that exists only for change tracking and that no JSON consumer ever needs.

The trade-off is that `Author` is now invisible to the JSON layer everywhere. If you have a different endpoint that does want to return a `Book` with its `Author` nested, `[JsonIgnore]` is too blunt and you should project to a DTO instead.

### 4. ReferenceHandler.Preserve, when you actually need round-trip

If your scenario is internal-to-internal (an actor system, a server-to-server protocol, a snapshot you read back into another .NET process), `Preserve` is the option that keeps the graph intact:

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.Preserve
};

var json = JsonSerializer.Serialize(author, options);
```

The output gets `$id` and `$ref` properties:

```json
{
  "$id": "1",
  "Id": 1,
  "Name": "Carla",
  "Books": {
    "$id": "2",
    "$values": [
      {
        "$id": "3",
        "Id": 1,
        "Title": "Refactoring",
        "Author": { "$ref": "1" }
      }
    ]
  }
}
```

`Preserve` is **never** the right answer for a public REST API. JavaScript clients, mobile clients, Postman, every code generator, every Swagger validator expects plain JSON. `$id` and `$ref` are System.Text.Json's own convention (originally Newtonsoft's), they are not standard. Browsers will not unpack them. If you are not deserializing on the other side with `System.Text.Json` set to the same `Preserve` option, do not emit them.

The legitimate use is server-to-server where both ends are .NET, you control the contract, and you genuinely need the graph round-tripped without duplication.

### 5. Increase MaxDepth, but only for honest deep trees

If you have inspected the path in the exception and it is not a repeating pattern but a long straight descent, your graph is genuinely deeper than 64 levels:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    MaxDepth = 128
};
```

This is rare. Most domains do not have 64-level deep trees, and if yours does you almost certainly want to chunk or paginate the response. But it is the right knob for things like recursive folder structures, organizational hierarchies, or expression trees where the depth is data, not a bug.

Do **not** raise `MaxDepth` to "work around" a cycle. The depth guard is the only thing standing between your process and a stack overflow.

## Common shapes that produce this

### EF Core navigation properties on a serialized entity

The textbook case. `Order` has `Customer`, `Customer` has `List<Order> Orders`, and an `Include` populates both sides. The fix is to project to a DTO or to `[JsonIgnore]` the back-pointer. Returning entities from a controller is the single most common source of this exception.

### Self-referencing trees

A `Category` with a `Parent` and `List<Category> Children`, populated by recursive `Include`s. The cycle is `category.Children[0].Parent == category`. `IgnoreCycles` handles this cleanly because the writer detects the loop at the back-pointer and emits `null` there.

### Anonymous types built from LINQ

A LINQ projection that anonymous-types its way into a graph is usually safe (anonymous types do not have back-pointers). But a projection like `Select(a => new { a, Books = a.Books })` re-introduces the entity and the cycle is back. Inspect what you actually wrote, not what you meant to write.

### A DTO that copied its source's navigation properties

A mapping configuration that ports `Author Author` from the entity to the DTO defeats the point of the DTO. Either drop the property from the DTO, or change its type to `AuthorDto` (a leaf-shaped record with no back-reference).

### A graph deeper than 32, with the old default message

Before .NET 8, the default `MaxDepth` was 64 only when not explicitly set; the source generator pathway and some legacy initialisers used 32. The exception message hard-codes "32" in some older versions, and "64" or your custom value in newer ones. Read the actual exception, not the docs, the runtime version determines the number.

## Variants that look like this but are not

### "The object or value could not be serialized. There was a recursive call detected."

Different error, same family. This is the message Newtonsoft.Json emits when its `ReferenceLoopHandling` is left at the default `Error`. The fix in Newtonsoft is `ReferenceLoopHandling.Ignore` (the analogue of `IgnoreCycles`) or `PreserveReferencesHandling.All` (the analogue of `Preserve`). If you are mid-migration, the [Newtonsoft to System.Text.Json migration trail](/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) is the closest thing to a canonical case study; both libraries land at the same shape of solution but spell the options differently.

### "JsonException: The JSON value could not be converted to ..."

Different exception, different stack. That one is about parsing input that does not match the target type. The cycle exception is a write-side problem; the conversion exception is a read-side problem. The [System.DateTime conversion guide](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) is the canonical write-up for the read-side family.

### "Self referencing loop detected for property ..."

This is the Newtonsoft message verbatim. If you see it in a 2026 codebase that you thought was using `System.Text.Json`, there is still a Newtonsoft serializer wired up somewhere, usually a leftover `AddNewtonsoftJson()` call on the MVC builder. Search the host startup; the framework picks whichever JSON formatter is registered last.

### "An item with the same key has already been added. Key: $id"

This is the `Preserve` deserialiser failing because the same `$id` appears twice in the input. Either the payload is malformed (two different objects given the same id) or it was serialized with `Preserve` and then re-serialized through a transformer that rewrote the ids. The fix is on the producer, not the consumer.

### "PossibleCycleDetected" from a Blazor render

Different layer entirely. Blazor's diffing engine has its own cycle guard for component parameters; the exception type and stack are different. Do not change `JsonSerializerOptions` to fix a Blazor render loop.

## Working with the source generator

When using `System.Text.Json` source generation, the same options apply. Set `ReferenceHandler` on the `JsonSerializerOptions` you pass to the generated context, or use the `[JsonSourceGenerationOptions]` attribute on the context type:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    ReferenceHandler = JsonKnownReferenceHandler.IgnoreCycles)]
[JsonSerializable(typeof(Author))]
public partial class ApiJsonContext : JsonSerializerContext { }
```

`JsonKnownReferenceHandler` is the attribute-friendly enum, it maps to the same handlers as `ReferenceHandler.IgnoreCycles` / `Preserve` at runtime. The source generator post on [interceptors and System.Text.Json source generation ergonomics](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) walks through the context registration shape that survives trimming and AOT publishing, the same shape applies here.

## Related

For the read-side counterpart to this exception, see the [JSON value could not be converted to System.DateTime fix](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/). The general scaffolding for writing your own converters that bypass the default reference handling lives in the [custom JsonConverter walkthrough](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). If the entity you are serializing comes from EF Core 11 and you want the database round-trip story, the [SQL Server 2025 JSON contains walkthrough](/2026/04/efcore-11-json-contains-sql-server-2025/) covers how the JSON column type handles graphs at the database layer. For the broader case of migrating an entire codebase away from Newtonsoft's `ReferenceLoopHandling`, the [vstest dropping Newtonsoft.Json in .NET 11 preview 4](/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) note has the .NET team's own playbook.

## Sources

- [Preserve references and handle circular references in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references), Microsoft Learn.
- [`JsonSerializerOptions.ReferenceHandler`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.referencehandler), Microsoft Learn.
- [`JsonSerializerOptions.MaxDepth`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.maxdepth), Microsoft Learn.
- [`JsonIgnoreAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignoreattribute), Microsoft Learn.
- [dotnet/runtime issue 30820: cycle detection in JSON serialization](https://github.com/dotnet/runtime/issues/30820), the original design discussion that landed `Preserve` and later `IgnoreCycles`.
