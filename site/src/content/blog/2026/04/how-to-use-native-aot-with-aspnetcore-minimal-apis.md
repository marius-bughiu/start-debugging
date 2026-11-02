---
title: "How to use Native AOT with ASP.NET Core minimal APIs"
description: "Configure a Minimal API for Native AOT with generated JSON metadata. Understand builder choices, deployment toolchains, warnings and feature limitations."
pubDate: 2026-04-27
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
---

Native AOT compiles an application to native code at publish time. It can change startup time, deployment size and memory use, but those outcomes depend on the application and target. It is not a flag that makes every ASP.NET Core feature or dependency compatible.

**Correction — November 2, 2026:** the previous guide incorrectly made `CreateSlimBuilder` mandatory, excluded all SignalR servers, tied code generation to `Program.cs`, and overstated JSON and globalization restrictions. This replacement targets .NET 10; it does not claim execution under .NET 11.

## A small application with explicit JSON metadata

Create a project named `MyApi` with this project file:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Use this `Program.cs`:

```csharp
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));

var app = builder.Build();
app.MapGet("/todos", () => TypedResults.Ok(new[] { new Todo(1, "Write docs", false) }));
app.MapPost("/todos", (Todo todo) => TypedResults.Ok(todo));
app.Run();

public record Todo(int Id, string Title, bool IsComplete);

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

`PublishAot` enables the relevant AOT analysis and request-delegate generation in this Web SDK project. The JSON context supplies metadata for the root types used by these endpoints. Register additional roots and polymorphic types when your contracts require them; registering `object` does not cover every possible runtime type.

The request-delegate generator works across source files in the project. Moving a route extension method out of `Program.cs` is not itself an AOT problem. A separate library must be configured with the necessary ASP.NET Core references and generator support; a single property alone does not make arbitrary library code compatible.

## Publish for a concrete platform

```sh
# Use the RID and native toolchain for your deployment target.
# This command is for an Apple Silicon Mac:
dotnet publish -c Release -r osx-arm64 -o ./publish
./publish/MyApi --urls http://127.0.0.1:5080
# Replace MyApi with your project's executable name.
```

Install the native toolchain required by the target. Cross-OS Native AOT publishing is not generally supported; use a suitable build host or container for the destination. Self-contained means the managed runtime need not be installed separately. It does not mean the executable is fully statically linked or independent of operating-system libraries.

Run the published executable and test its endpoints, serialization, authentication and failure paths. A normal `dotnet run` exercises JIT execution and cannot replace this deployment test. Review all trim and AOT warnings; a warning does not automatically fail the publish unless you configure warnings as errors. `IL2026` concerns trimming requirements, while `IL3050` concerns dynamic code requirements. Attributes such as `RequiresDynamicCode` propagate requirements; they do not repair incompatible code.

## Builder, serialization and globalization choices

`CreateSlimBuilder` starts with fewer default features and is a useful baseline, not a mandatory Native AOT API. `CreateBuilder` can be used when the selected features and dependencies are compatible. The slim builder omits HTTPS and HTTP/3 setup by default; configure the required Kestrel support or terminate TLS at a trusted proxy. Endpoint configuration alone does not add omitted protocol support.

Adding a generated resolver does not, by itself, disable reflection in every execution mode. Native AOT requires suitable metadata; unknown JSON types can fail at runtime. `Results.Json(value)` and `ReadFromJsonAsync<T>()` can use configured serializer options and generated metadata. They are not inherently forbidden. Explicit `JsonTypeInfo<T>` overloads are useful when you want the contract at the call site.

`InvariantGlobalization` is an application behavior choice, not an AOT warning switch. If culture-aware behavior is needed, keep that support and provide the target's globalization dependencies. Do not enable invariant mode solely to silence a warning or assume it preserves all culture behavior.

## Check feature support by version

MVC controllers and Razor Pages are not a general Native AOT option in the documented ASP.NET Core support matrix. SignalR is different: .NET 9 introduced Native AOT support for client and server scenarios, with documented restrictions and JSON source-generation requirements. Do not carry an old blanket exclusion into a newer target.

Database access also needs provider-specific review. EF Core AOT work and limitations depend on its version and query pipeline; ordinary Dapper usage is not automatically safe merely because it is smaller. Publish and exercise the exact dependencies you intend to deploy.

For organizing compatible handlers, see [MapGroup resource modules](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Sources

- [ASP.NET Core Native AOT support](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [.NET Native AOT deployment and prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [.NET 9 SignalR Native AOT support and limitations](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-9.0?view=aspnetcore-9.0#signalr-supports-trimming-and-native-aot)
