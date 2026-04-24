---
title: "Node.js-Addons in C#: .NET Native AOT ersetzt C++ und node-gyp"
description: "Das C# Dev Kit Team hat sein C++-Node.js-Addon gegen eine .NET 10 Native AOT Library getauscht, mit N-API, UnmanagedCallersOnly und LibraryImport, um eine einzelne .node-Datei ohne Python oder node-gyp zu produzieren."
pubDate: 2026-04-21
tags:
  - ".NET 10"
  - "Native AOT"
  - "C#"
  - "Node.js"
  - "Interop"
lang: "de"
translationOf: "2026/04/nodejs-addons-dotnet-native-aot"
translatedBy: "claude"
translationDate: 2026-04-24
---

Drew Noakes vom C# Dev Kit Team [kündigte am 20. April 2026 an](https://devblogs.microsoft.com/dotnet/writing-nodejs-addons-with-dotnet-native-aot/), dass das native Node.js-Addon der Extension jetzt vollständig in C# geschrieben und mit .NET 10 Native AOT kompiliert ist. Das heißt, der Windows-Registry-Zugriff, auf den die Extension angewiesen ist, wird als einfache `.node`-Datei ausgeliefert, die `dotnet publish` produziert, ohne C++, ohne Python und ohne node-gyp in der Build-Kette.

## Warum das ein großes Deal für Node-Tooling ist

Node.js-Addons waren historisch C- oder C++-Projekte, die von node-gyp zusammengeklebt wurden, was wiederum Python, eine C++-Toolchain und ein kompatibles MSBuild auf Windows braucht. Wer eine cross-plattform Electron-Extension gepflegt hat, weiß, wie spröde diese Kette im CI wird. Native AOT kollabiert die ganze Pipeline in ein einziges `dotnet publish`, was eine plattformspezifische Shared Library (`.dll`, `.so` oder `.dylib`) produziert, die Node direkt lädt, sobald Sie sie in `.node` umbenennen. Das C# Dev Kit nutzt genau diesen Flow, um die Windows Registry zu lesen, und entfernt Python aus dem Contributor-Setup.

## napi_register_module_v1 aus C# exportieren

Der Trick: N-API (Node-API) hat eine stabile ABI, also kann jede Sprache, die einen nativen Export mit C-Aufrufkonventionen produzieren kann, ein Node-Addon implementieren. In .NET 10 erledigt `[UnmanagedCallersOnly]` diesen Job: Es fixiert einen Export-Namen und eine Aufrufkonvention in das AOT-Image. Der Einsprungpunkt, den Node sucht, ist `napi_register_module_v1`.

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

Das `"hello"u8`-Literal ist ein UTF-8-Byte-String, was N-API will, und `&SayHello` ist ein Function Pointer, der AOT übersteht, weil `UnmanagedCallersOnly` Managed-Only-Features wie Generics und Async auf dieser Signatur verbietet.

## N-API gegen den Host-Prozess auflösen

Die zweite Hälfte des Rätsels ist das Zurückrufen in N-API. Es gibt keine `node.dll`, gegen die man linken könnte, denn auf vielen Plattformen ist das Node-Binary die Executable selbst. Der Post nutzt `[LibraryImport("node")]` zusammen mit einem custom `NativeLibrary.SetDllImportResolver`, der das Handle des aktuellen Prozesses zurückgibt, sodass jeder N-API-Aufruf zur Ladezeit gegen die laufende Node-Executable auflöst.

```csharp
[LibraryImport("node", EntryPoint = "napi_create_string_utf8")]
private static partial int CreateStringUtf8(
    nint env, byte[] str, nuint length, out nint result);

NativeLibrary.SetDllImportResolver(typeof(HelloAddon).Assembly,
    (name, _, _) => name == "node"
        ? NativeLibrary.GetMainProgramHandle()
        : 0);
```

## Die Projektdatei

AOT zu aktivieren ist eine Zwei-Zeilen-Änderung. `AllowUnsafeBlocks` ist erforderlich, weil N-API-Interop auf Function Pointers und Spans über nativem Speicher setzt.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PublishAot>true</PublishAot>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

Nach `dotnet publish -c Release` benennen Sie die Output-Library in `HelloAddon.node` um und `require()` sie aus JavaScript wie jedes andere native Modul.

Für reichere Szenarien zeigt der Post auch auf [microsoft/node-api-dotnet](https://github.com/microsoft/node-api-dotnet), das N-API in höherwertige Abstraktionen wickelt und vollen Interop zwischen JS- und CLR-Typen unterstützt. Aber für den Fall "ein kleines, schnelles natives Addon ohne C++-Toolchain ausliefern" ist die Route mit rohem N-API plus Native AOT jetzt in Microsofts eigenen VS Code Extensions in Produktion bewährt.
