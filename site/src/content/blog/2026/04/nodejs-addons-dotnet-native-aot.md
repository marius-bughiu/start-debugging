---
title: "Node.js Addons in C#: .NET Native AOT Replaces C++ and node-gyp"
description: "The C# Dev Kit team swapped its C++ Node.js addon for a .NET 10 Native AOT library, using N-API, UnmanagedCallersOnly, and LibraryImport to produce a single .node file without Python or node-gyp."
pubDate: 2026-04-21
tags:
  - "dotnet-10"
  - "native-aot"
  - "csharp"
  - "nodejs"
  - "interop"
---

Drew Noakes from the C# Dev Kit team [announced on April 20, 2026](https://devblogs.microsoft.com/dotnet/writing-nodejs-addons-with-dotnet-native-aot/) that the extension's native Node.js addon is now written entirely in C# and compiled with .NET 10 Native AOT. That means the Windows Registry access the extension depends on ships as a plain `.node` file produced by `dotnet publish`, with no C++, no Python, and no node-gyp in the build chain.

## Why This Is a Big Deal for Node Tooling

Node.js addons have historically been C or C++ projects glued together by node-gyp, which in turn needs Python, a C++ toolchain, and a compatible MSBuild on Windows. Anyone who has maintained a cross-platform Electron extension knows how brittle that chain gets on CI. Native AOT collapses the whole pipeline into a single `dotnet publish`, producing a platform-specific shared library (`.dll`, `.so`, or `.dylib`) that Node loads directly once you rename it to `.node`. The C# Dev Kit uses exactly this flow to read the Windows Registry, removing Python from its contributor setup.

## Exporting napi_register_module_v1 from C#

The trick is that N-API (Node-API) has a stable ABI, so any language that can produce a native export with C calling conventions can implement a Node addon. In .NET 10, `[UnmanagedCallersOnly]` does that job: it pins an export name and calling convention into the AOT image. The entry point Node looks for is `napi_register_module_v1`.

```csharp
public static unsafe partial class HelloAddon
{
    [UnmanagedCallersOnly(
        EntryPoint = "napi_register_module_v1",
        CallConvs = [typeof(CallConvCdecl)])]
    public static nint Init(nint env, nint exports)
    {
        RegisterFunction(env, exports, "hello"u8, &SayHello);
        return exports;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static nint SayHello(nint env, nint info)
    {
        return CreateString(env, "Hello from .NET!");
    }
}
```

The `"hello"u8` literal is a UTF-8 byte string, which is what N-API wants, and `&SayHello` is a function pointer that survives AOT because `UnmanagedCallersOnly` forbids managed-only features like generics and async on that signature.

## Resolving N-API Against the Host Process

The second half of the puzzle is calling back into N-API. There is no `node.dll` to link against, because on many platforms the Node binary is the executable itself. The post uses `[LibraryImport("node")]` together with a custom `NativeLibrary.SetDllImportResolver` that returns the current process handle, so every N-API call resolves against the running Node executable at load time.

```csharp
[LibraryImport("node", EntryPoint = "napi_create_string_utf8")]
private static partial int CreateStringUtf8(
    nint env, byte[] str, nuint length, out nint result);

NativeLibrary.SetDllImportResolver(typeof(HelloAddon).Assembly,
    (name, _, _) => name == "node"
        ? NativeLibrary.GetMainProgramHandle()
        : 0);
```

## The Project File

Enabling AOT is a two-line change. `AllowUnsafeBlocks` is required because N-API interop leans on function pointers and spans over native memory.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PublishAot>true</PublishAot>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

After `dotnet publish -c Release`, rename the output library to `HelloAddon.node` and `require()` it from JavaScript like any other native module.

For richer scenarios, the post also points at [microsoft/node-api-dotnet](https://github.com/microsoft/node-api-dotnet), which wraps N-API in higher-level abstractions and supports full interop between JS and CLR types. But for the "ship a small, fast native addon without a C++ toolchain" case, the raw N-API plus Native AOT route is now production-proven inside Microsoft's own VS Code extensions.
