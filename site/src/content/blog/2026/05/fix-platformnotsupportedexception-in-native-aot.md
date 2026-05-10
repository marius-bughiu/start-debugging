---
title: "Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT"
description: "Native AOT strips the JIT and the interpreter, so reflection emit, expression-tree compilation, and unseen MakeGenericType throw at runtime. Find the call via IL3050 and replace it with a source generator or a pre-baked path."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "native-aot"
  - "trimming"
---

The fix: Native AOT publishes a single static binary with no JIT and no interpreter, so any code path that emits IL at runtime, compiles an `Expression<T>` tree, or asks the runtime to bake a generic instantiation it has never seen will throw `PlatformNotSupportedException`. The first move is always the same: rebuild with `dotnet publish -r <rid> -c Release` and read the `IL3050` warning that names the offending member, then replace it with an AOT-compatible alternative (a source generator, a pre-instantiated generic, or a feature switch).

```text
System.PlatformNotSupportedException: Operation is not supported on this platform.
   at System.Reflection.Emit.DynamicMethod..ctor(String name, Type returnType, Type[] parameterTypes)
   at SomeLibrary.Internal.ExpressionCompiler.Compile(LambdaExpression expr)
   at SomeLibrary.PublicEntryPoint.DoTheThing()
   at Program.<Main>$(String[] args) in /src/Program.cs:line 12
```

```text
System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
   at System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(...)
   at System.Linq.Expressions.Compiler.LambdaCompiler.CompileLambda(LambdaExpression lambda, Boolean hasClosureArgument)
   at System.Linq.Expressions.Expression`1[[T]].Compile()
```

This guide is written against the .NET 11 SDK (preview 4), `Microsoft.NET.Sdk` 11.0.0-preview.4, and C# 14. The exception text and the underlying restriction have been stable since Native AOT shipped as a supported deployment in .NET 8, so everything below applies unchanged on .NET 8, 10, and 11. The .NET 9 release added the `RequiresDynamicCodeAttribute` analyzer story that backs IL3050, and .NET 11 tightens it further by promoting more BCL paths to AOT-safe variants.

Two distinct messages share the same exception type. `Operation is not supported on this platform` comes from the JIT-emit fast path tripping over `RuntimeFeature.IsDynamicCodeSupported == false`. `Dynamic code generation is not supported on this platform` comes from `Reflection.Emit` itself when something tries to build a `DynamicAssembly` or a `DynamicMethod`. Both have the same root cause and the same fix surface, so do not waste time treating them as separate bugs.

## Why a single-file Native AOT binary cannot emit IL

`dotnet publish /p:PublishAot=true` produces a fully ahead-of-time-compiled native image. The JIT is not statically linked. The Mono interpreter is not statically linked. The CoreCLR `Reflection.Emit` writer is compiled out. At runtime, `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` returns `false`, and any API that depends on writing fresh IL or assembling a fresh delegate from raw machine code returns either an `IsSupported`-style guard failure or this exception.

The four shapes that hit this restriction in real code:

1. **Direct `Reflection.Emit` use.** `DynamicMethod`, `AssemblyBuilder.DefineDynamicAssembly`, `TypeBuilder`, `ILGenerator.Emit`. These throw immediately.
2. **`Expression<T>.Compile()` over a non-trivial tree.** The expression compiler internally lowers to `DynamicMethod`. `Compile(preferInterpretation: true)` falls back to the interpreter on .NET 8 and 10, but the interpreter is also stripped out of Native AOT, so even the `true` overload throws unless the BCL has a tree-walking fallback.
3. **`Type.MakeGenericType` / `MethodInfo.MakeGenericMethod` with type arguments the compiler did not see.** `List<int>` works because the AOT compiler instantiated it. `MakeGenericType(someTypeFromReflection)` over a value type the compiler never reached throws.
4. **Transitively, anything built on the above.** AutoMapper's expression-compiled mappers, FastMember, MediatR's open generics, Newtonsoft.Json's converter cache, EF Core's compiled query path on POCO graphs the model builder did not cover, gRPC.Core's older codegen, and the Dataverse / Service Fabric / WCF clients that lean on dynamic proxies.

In a JIT build, the runtime simply tier-0 codegen's the new method and moves on. In Native AOT it has nowhere to put the new code, so it throws at the first moment the API is called.

## Minimal repro

```csharp
// .NET 11 SDK preview 4, C# 14, <PublishAot>true</PublishAot>
using System.Linq.Expressions;

Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();   // throws on Native AOT
Console.WriteLine(compiled(41));
```

`.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

Publish on Linux x64:

```bash
dotnet publish -r linux-x64 -c Release
```

The publish step prints:

```text
warning IL3050: Using member 'System.Linq.Expressions.Expression`1<TDelegate>.Compile()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. Compiling a lambda requires dynamic code.
```

Run the binary:

```text
Unhandled exception. System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
```

This is the canonical version of the error. The same shape applies whether the offender is your own code, a NuGet package, or a transitively pulled-in framework piece.

## Fix, in detail

The fixes below are ordered from cheapest to most invasive. Take the first one that compiles.

### 1. Replace the API with an AOT-compatible alternative (preferred)

Almost every problematic API now has an AOT-friendly replacement that the .NET team shipped specifically because of this exception class.

| AOT-hostile | AOT-friendly replacement |
|---|---|
| `Newtonsoft.Json` | `System.Text.Json` with a `[JsonSerializable]` source generator context |
| `AutoMapper` (expression-compiled) | Source-generated mappers (Mapster's source-generator mode, Riok.Mapperly, `MapTo`) |
| `MediatR` (open-generic registration) | Hand-rolled handler interfaces, or `Mediator` (the source-generator one) |
| `Microsoft.AspNetCore.Mvc.Controllers` | `WebApplication.CreateSlimBuilder` + minimal APIs with `JsonSerializerContext` |
| `EF Core` runtime-built model | `OptimizeQuery` / `dotnet ef dbcontext optimize` to pre-generate the model |
| `Castle.DynamicProxy` interceptors | Source-generated decorators (e.g. via Roslyn or PolySharp) |
| `Expression<T>.Compile()` | `delegate*<...>`, `Func<...>` literal, or a hand-written `IL` replacement compiled at build time |

Concrete example, replacing the lambda-compile call:

```csharp
// .NET 11, C# 14
// Before: AOT-hostile
Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();

// After: pure delegate, no expression tree, no Compile()
Func<int, int> compiled = x => x + 1;
```

If you genuinely need the expression-tree shape (because you are inspecting the body), keep the tree, but stop calling `Compile()` and switch the consumer to a `delegate` you authored by hand.

### 2. Use `RuntimeFeature.IsDynamicCodeSupported` as a feature switch

If the dynamic path is optional, gate it behind the runtime feature flag and ship a slow but AOT-safe fallback:

```csharp
// .NET 11, C# 14
using System.Runtime.CompilerServices;

public static T Materialize<T>(IDataReader reader)
{
    if (RuntimeFeature.IsDynamicCodeSupported)
    {
        return EmitMaterializer<T>.Compile()(reader);   // existing fast path
    }

    return ReflectionMaterializer<T>.Materialize(reader); // slower but no IL emit
}
```

The AOT compiler statically evaluates `IsDynamicCodeSupported` to `false` for the published binary and trims the entire dynamic branch out, including `EmitMaterializer<T>`. No more IL3050, no more runtime throw. Important: the analyzer only trims when the test is the literal property read; do not assign it to a local first or wrap it in a method, or the trimmer will keep the dead branch.

### 3. Pre-instantiate generics the compiler cannot see

If the message names `MakeGenericType` or `MakeGenericMethod`, the AOT compiler does not know which `T` to bake. Two ways out:

```csharp
// .NET 11, C# 14
// Tell the AOT compiler exactly which generic instantiations to keep.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]
public class Repository<T> { /* ... */ }

// And in your DI bootstrap, use closed generics:
services.AddScoped<Repository<User>>();
services.AddScoped<Repository<Order>>();
// not: services.AddScoped(typeof(Repository<>));
```

Or, for a purely reflective call, switch to the source-generated equivalent. ASP.NET Core 11 ships AOT-safe overloads for the common DI shapes; the runtime team also added `Activator.CreateInstance<T>()` AOT-friendly intrinsics for parameterless constructors.

### 4. Mark the method as `RequiresDynamicCode` and stop calling it from AOT paths

If you are writing a library and a method genuinely needs dynamic codegen, propagate the requirement to your callers so the analyzer can warn at their level:

```csharp
// .NET 11, C# 14
[RequiresDynamicCode("Builds a per-type accessor with Reflection.Emit. " +
                     "Not supported in Native AOT. Use SourceGenAccessor<T> instead.")]
public static Func<object, object> BuildGetter(PropertyInfo prop) => /* emit */;
```

The attribute does not fix the runtime exception, but it converts the silent crash into a build-time IL3050, which is the contract Native AOT consumers expect.

### 5. Remove the dependency

The last resort. If a library you depend on hard-codes `Reflection.Emit` and offers no AOT mode, the only honest options are to (a) replace the library, (b) keep that subsystem on a non-AOT process boundary (a JIT-published worker behind an HTTP or named-pipe boundary), or (c) wait for the upstream maintainer to ship an AOT path. Do not paper over the exception with a `try/catch`; the program is then in an undefined state because the consumer almost certainly depends on the failed operation.

## Common variants and lookalikes

- **`PlatformNotSupportedException: System.Reflection.Emit.DynamicMethod` from `System.Linq.Expressions`.** Same root cause as Compile(), often surfaces inside `Queryable` providers and JSON converters. Search the publish log for the IL3050 line that names the originating method. If you are arriving here from a JSON serializer, see [our walkthrough on writing AOT-safe System.Text.Json converters](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- **`PlatformNotSupportedException: Operation is not supported on this platform` from `Assembly.Load(byte[])`.** Native AOT does not allow loading additional managed assemblies at runtime. There is no fallback. Move the plugin loading to a non-AOT host.
- **`PlatformNotSupportedException: Cannot emit a dynamic assembly.` from `Castle.DynamicProxy`.** Castle has no AOT path as of 5.x; replace the interception with source-generated decorators or move the proxied service out of the AOT binary.
- **`NotSupportedException: BinaryFormatter serialization and deserialization are disabled.`** Different exception type, but the same general "removed from the AOT binary" theme. Do not switch to a `try/catch` around it; rewrite the serialization to System.Text.Json.
- **`PlatformNotSupportedException: ... requires the JIT.`** This is the message you see on Mono interpreter targets (iOS, watchOS, MAUI Catalyst) when the interpreter is also off. The fix surface is the same as Native AOT: pre-bake the generic, switch to a source generator, or feature-switch the path.
- **The error appears only on a single platform.** Some packages ship a NuGet runtime asset per RID. The `linux-x64` build may compile with `Reflection.Emit` stubbed out, while `win-x64` works. Always test publish on every RID you ship.

## Verifying you actually fixed it

Three checks before declaring victory:

1. `dotnet publish -r <rid> -c Release` produces no `IL3050` warning. Promote them to errors with `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` and `<IsAotCompatible>true</IsAotCompatible>`.
2. The published binary executes the previously failing path under `DOTNET_TieredCompilation=0` and `DOTNET_ReadyToRun=0`. Native AOT does not honor these, but the env vars are a quick way to confirm you are not accidentally testing a self-contained JIT build.
3. The published binary's import table contains no reference to the JIT (`clrjit.dll` / `libclrjit.so`). On Linux, `nm --dynamic` on the binary should show no `clrjit` symbols.

If all three pass, you have an AOT-clean binary and the exception will not return through the same path.

## Related

- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) walks the full publish path and the IL3050 warning surface for a typical web service.
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) is the reason most teams reach for Native AOT in the first place.
- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) is the AOT-safe replacement when you were tempted to hand a `JsonSerializer` reflective metadata.
- [How to write a source generator for INotifyPropertyChanged](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) is the pattern you use whenever an existing library wants to do `Reflection.Emit` for you.
- [Rider 2026.1 ships an ASM viewer that decodes JIT and Native AOT output](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) is useful when you want to confirm that the trimmer actually removed the dynamic branch.

## Sources

- [Native AOT deployment overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [IL3050: Avoid calling members annotated with RequiresDynamicCodeAttribute when publishing as Native AOT, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/warnings/il3050)
- [Introduction to AOT warnings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/fixing-warnings)
- [Intrinsic APIs marked RequiresDynamicCode, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/intrinsic-requiresdynamiccode-apis)
- [How to make libraries compatible with Native AOT, .NET Blog](https://devblogs.microsoft.com/dotnet/creating-aot-compatible-libraries/)
- [AOT with Reflection, dotnet/runtime discussion #95244](https://github.com/dotnet/runtime/discussions/95244)
- [RuntimeFeature.IsDynamicCodeSupported, .NET API browser](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimefeature.isdynamiccodesupported)
