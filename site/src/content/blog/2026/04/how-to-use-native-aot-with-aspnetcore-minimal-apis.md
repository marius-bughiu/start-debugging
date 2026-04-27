---
title: "How to use Native AOT with ASP.NET Core minimal APIs"
description: "A complete .NET 11 walkthrough for shipping an ASP.NET Core minimal API with Native AOT: PublishAot, CreateSlimBuilder, source-generated JSON, the AddControllers limitation, IL2026 / IL3050 warnings, and EnableRequestDelegateGenerator for library projects."
pubDate: 2026-04-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
---

To ship an ASP.NET Core minimal API with Native AOT on .NET 11, set `<PublishAot>true</PublishAot>` in the `.csproj`, build the host with `WebApplication.CreateSlimBuilder` instead of `CreateBuilder`, and register a `JsonSerializerContext` source generator through `ConfigureHttpJsonOptions` so every request and response type is reachable without reflection. Anything that is not minimal APIs or gRPC, including `AddControllers`, Razor, SignalR hubs, and EF Core query trees over POCO graphs, will produce IL2026 or IL3050 warnings at publish and behave unpredictably at runtime. This guide walks the full path on `Microsoft.NET.Sdk.Web` with .NET 11 SDK and C# 14, including the parts the new-project template hides from you, and ends with a checklist for verifying that the published binary actually does not need the JIT.

## The two project flags that change everything

A Native AOT minimal API is a regular ASP.NET Core project with two MSBuild properties added. The first switches the publish path from CoreCLR to ILC, the AOT compiler. The second tells the analyzer to fail your build the moment you reach for an API that requires runtime code generation.

```xml
<!-- .NET 11, C# 14 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>

    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

`PublishAot` does the heavy lifting. It enables Native AOT compilation during `dotnet publish` and, importantly, also turns on dynamic code analysis during build and editing, so IL2026 (`RequiresUnreferencedCode`) and IL3050 (`RequiresDynamicCode`) warnings light up in the IDE before you ever reach a publish. Microsoft documents this on the [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).

`InvariantGlobalization` is not strictly required, but I leave it on for new projects. Native AOT does not bundle the ICU data file by default on Linux, and a culture-aware string comparison over a request payload will throw `CultureNotFoundException` in production if you forget. Ship globalization explicitly when you actually need it.

The new-project template (`dotnet new webapiaot`) also adds `<StripSymbols>true</StripSymbols>` and `<TrimMode>full</TrimMode>` for you. `TrimMode=full` is implied by `PublishAot=true`, so it is redundant but harmless to keep.

## CreateSlimBuilder is not CreateBuilder with a smaller name

The biggest behavioural change between a regular minimal API and an AOT one is the host builder. `WebApplication.CreateBuilder` wires up every common ASP.NET Core feature: HTTPS, HTTP/3, hosting filters, ETW, environment-variable based configuration providers, and a default JSON serializer that does reflection-based fallback. A lot of that machinery is not Native AOT compatible, so the AOT template uses `CreateSlimBuilder`, which is documented in the [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0) reference and unchanged in .NET 11.

```csharp
// .NET 11, C# 14
// PackageReference: Microsoft.AspNetCore.OpenApi 11.0.0
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

var app = builder.Build();

var todos = app.MapGroup("/todos");
todos.MapGet("/", () => Todo.Sample);
todos.MapGet("/{id:int}", (int id) =>
    Todo.Sample.FirstOrDefault(t => t.Id == id) is { } t
        ? Results.Ok(t)
        : Results.NotFound());

app.Run();

public record Todo(int Id, string Title, bool Done)
{
    public static readonly Todo[] Sample =
    [
        new(1, "Try Native AOT", true),
        new(2, "Profile cold start", false),
    ];
}

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Three things in that sample matter and are easy to miss:

1. `CreateSlimBuilder` does not register HTTPS or HTTP/3 by default. The slim builder includes JSON file configuration for `appsettings`, user secrets, console logging, and logging configuration, but it intentionally drops protocols typically handled by a TLS termination proxy. If you run this thing without an Nginx, Caddy, or YARP in front, add `Kestrel.Endpoints` configuration explicitly.
2. `MapGroup("/todos")` is fine in the same file as `Program.cs`. Move it to another file in the same project and you will start seeing IL3050 unless you also turn on the request delegate generator. We get to that in a moment.
3. The JSON context inserts at index `0` in the resolver chain, so it takes precedence over the default reflection-based resolver. Without `Insert(0, ...)`, ASP.NET Core's response writer can still fall back to reflection for types you did not register, which produces a `NotSupportedException` at runtime in AOT mode.

## JSON: the only serializer is the one you generate

`System.Text.Json` has two modes. Reflection mode walks every property at runtime, which is incompatible with both trimming and AOT. Source generation mode emits compile-time metadata for each registered type, which is fully AOT-safe. Native AOT requires source generation for every type you put in or pull out of an HTTP request body. This is the single biggest source of "compiles fine, throws at runtime" bugs.

The minimum viable `JsonSerializerContext`:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
[JsonSerializable(typeof(List<Todo>))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Every type that flows over the wire must be on this class, including the `T[]` and `List<T>` shapes you actually return from minimal API endpoints. ASP.NET Core's response writer does not unwrap `IEnumerable<T>` for you in AOT mode. If you return `Enumerable.Range(...).Select(...)`, register `IEnumerable<Todo>` as well or materialize it to an array first.

Three traps that bite even careful authors:

- **`Results.Json(value)` versus `return value`**: returning a value directly works because the framework knows the static return type. Wrapping in `Results.Json(value)` without passing a `JsonTypeInfo<T>` falls back to the default serializer and may throw at runtime in AOT. Use the `Results.Json` overload that takes `JsonTypeInfo<T>` from your generated context, or just return the value.
- **Polymorphism**: `[JsonDerivedType(typeof(Cat))]` works under AOT, but the base type and every derived type must be on the context. Plain `object` returns require a `JsonSerializable(typeof(object))` registration, which then forces every shape it can see, so prefer concrete types.
- **`IFormFile` and `HttpContext.Request.ReadFromJsonAsync`**: form parameter binding for primitives works in AOT, but `ReadFromJsonAsync<T>()` without a context will throw. Always pass `AppJsonContext.Default.T` as the second argument.

Andrew Lock's [tour of the minimal-API source generator](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/) and Martin Costello's walkthrough on [using JSON source generators with minimal APIs](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/) cover the original .NET 8 design that .NET 11 inherits unchanged.

## Library projects need EnableRequestDelegateGenerator

The minimal API source generator turns each `MapGet(...)`, `MapPost(...)`, and so on into a strongly typed `RequestDelegate` at compile time. When `PublishAot=true`, the SDK enables this generator automatically for the web project. It does **not** enable it for library projects you reference, even if those libraries call `MapGet` themselves through extension methods.

The symptom is IL3050 warnings at publish that point at your library, complaining about `MapGet` doing reflection on a delegate. The fix is one MSBuild property in the library:

```xml
<!-- Library project that defines endpoint extension methods -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <IsAotCompatible>true</IsAotCompatible>
    <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
  </PropertyGroup>
</Project>
```

`IsAotCompatible=true` turns on all four trim and AOT analyzers, and `EnableRequestDelegateGenerator=true` switches the library's `Map*` calls to the generated path. Without the latter, the library can be marked AOT compatible and still emit IL3050 because of how the analyzer sees `Delegate.DynamicInvoke` style call sites in `RouteHandlerBuilder`. The dotnet/aspnetcore team tracks the rough edges in [issue #58678](https://github.com/dotnet/aspnetcore/issues/58678).

If the library is supposed to be reusable on both AOT and non-AOT projects, leave the property in. The generator gracefully falls back to the runtime path on regular CoreCLR builds.

## What you have to give up

Native AOT is not a switch you flip on a finished MVC monolith. The list of unsupported subsystems is short but load-bearing.

- **MVC controllers**: `AddControllers()` is the canonical example. The API is not trim-safe and is not supported by Native AOT. The dotnet/aspnetcore team tracks long-term support in [issue #53667](https://github.com/dotnet/aspnetcore/issues/53667), but as of .NET 11 there is no AOT path for `[ApiController]`-decorated classes. You either rewrite the endpoints as minimal APIs or you do not ship AOT. Models and filters lean too heavily on reflection and runtime model binding for ILC to safely trim.
- **Razor Pages and MVC Views**: same reason. Both depend on runtime view compilation. They will compile under `PublishAot=true` if you do not use them, but registering `AddRazorPages()` lights up IL2026.
- **SignalR server-side hubs**: not supported under AOT in .NET 11. The client packages have AOT-friendly modes, the hub host does not.
- **EF Core**: the runtime works, but query translation that depends on reflection over POCO property graphs may produce IL2026 unless you opt into compiled queries and source-generated configuration. For most AOT services the right move is Dapper plus a hand-written `SqlClient` setup, or EF Core only for simple `DbSet<T>.Find()` style access.
- **Reflection-heavy DI patterns**: anything that resolves `IEnumerable<IPlugin>` from a scanned assembly is fragile under trimming. Register concrete types explicitly, or use a source-generated DI container.
- **`AddOpenApi()`**: the .NET 9 OpenAPI integration is AOT-compatible, but versions of `Swashbuckle.AspNetCore` before the AOT-aware refactor still emit IL2026. If you need OpenAPI in an AOT minimal API, use the built-in [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi) package and skip Swashbuckle.

The Thinktecture team published a [readable overview of supported and unsupported scenarios](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/) that I refer to when onboarding a team to Native AOT.

## Reading IL2026 and IL3050 like a pro

The two warnings you will fight are easy to confuse:

- **IL2026** means the call requires unreferenced code. The implementation reads members through reflection that the trimmer would otherwise remove. Common cause: passing a runtime `Type` to a serializer overload, calling `GetProperties()`, or using `Activator.CreateInstance(Type)`.
- **IL3050** means the call requires dynamic code generation. Even with all members preserved, the implementation needs `Reflection.Emit` or a similar JIT-time codegen step, which does not exist in AOT. Common cause: `JsonSerializer.Serialize(object)` overloads, `MakeGenericType` on a not-yet-instantiated generic, expression-tree compile.

Both are surfaced by the `IsAotCompatible` analyzer, but only IL2026 is shown by the trimming analyzer alone. I always run a one-shot publish to `bin\publish` from the command line during development to surface them all at once:

```bash
dotnet publish -c Release -r linux-x64 -o ./publish
```

A second gotcha: dotnet/sdk [discussion #51966](https://github.com/dotnet/sdk/discussions/51966) tracks a recurring issue where Visual Studio 2026 and `dotnet build` swallow IL2026 / IL3050 in some configurations, but `dotnet format` shows them. If your team uses Visual Studio, add a CI step that runs `dotnet publish` against the AOT runtime so a missed warning fails the pipeline.

When you cannot avoid a reflection-using API, you can suppress the warning at the call site with `[RequiresUnreferencedCode]` and `[RequiresDynamicCode]` attributes on the wrapping method, which propagates the requirement upwards. Do this only when you know the consuming code paths are not on the AOT publish surface. Suppressing inside an endpoint handler is almost always wrong.

## Verifying the binary actually works

A clean publish does not prove the app starts under AOT. Three checks I run before declaring victory:

```bash
# 1. The output is a single static binary, not a CoreCLR loader.
ls -lh ./publish
file ./publish/MyApi
# Expected on Linux: "ELF 64-bit LSB pie executable ... statically linked"

# 2. The runtime never loads the JIT.
LD_DEBUG=libs ./publish/MyApi 2>&1 | grep -E "libcoreclr|libclrjit"
# Expected: empty output. If libclrjit.so loads, you accidentally shipped a runtime fallback.

# 3. A real request round-trips with the source generator.
./publish/MyApi &
curl -s http://localhost:5000/todos | head -c 200
```

The third check is the important one. The classic failure mode is "compiles, publishes, starts, returns 500 on first request" because a return type is missing from the JSON context. Hit every endpoint at least once with a representative payload before you ship.

For container deployments, build with `--self-contained true` is implicit under `PublishAot=true`. The output `./publish/MyApi` plus its `.dbg` file is the entire deploy unit. A typical .NET 11 minimal API lands at 8-12 MB stripped, compared to the 80-90 MB of a self-contained CoreCLR publish.

## Related guides on Start Debugging

- The Native AOT lever sits inside a broader cold-start story: [the .NET 11 AWS Lambda cold-start playbook](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) walks the AOT-on-`provided.al2023` path with the same source generator setup.
- For OpenAPI on top of an AOT minimal API, the [OpenAPI client generation guide](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) covers the round trip from minimal API metadata to a typed `HttpClient`.
- AOT projects ban reflection-based JSON, so [writing a custom `JsonConverter` in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) is the right primer when a built-in conversion is not enough.
- A clean exception story matters more under AOT, where reflection-based diagnostics are unavailable: [adding a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) shows the `IExceptionHandler` path, which is fully AOT compatible.

## Sources

- [ASP.NET Core support for Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [Native AOT deployment overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [Source generation in System.Text.Json (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [aspnetcore#58678 - Map* AOT warnings outside Program.cs](https://github.com/dotnet/aspnetcore/issues/58678)
- [aspnetcore#53667 - Native AOT support for MVC](https://github.com/dotnet/aspnetcore/issues/53667)
- [Andrew Lock - Exploring the new minimal API source generator](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)
- [Martin Costello - Using JSON source generators with minimal APIs](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)
- [Thinktecture - Native AOT with ASP.NET Core, an overview](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)
