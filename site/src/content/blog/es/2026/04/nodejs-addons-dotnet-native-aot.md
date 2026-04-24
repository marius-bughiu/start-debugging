---
title: "Addons de Node.js en C#: .NET Native AOT reemplaza a C++ y node-gyp"
description: "El equipo de C# Dev Kit cambió su addon C++ de Node.js por una librería .NET 10 Native AOT, usando N-API, UnmanagedCallersOnly y LibraryImport para producir un único archivo .node sin Python ni node-gyp."
pubDate: 2026-04-21
tags:
  - ".NET 10"
  - "Native AOT"
  - "C#"
  - "Node.js"
  - "Interop"
lang: "es"
translationOf: "2026/04/nodejs-addons-dotnet-native-aot"
translatedBy: "claude"
translationDate: 2026-04-24
---

Drew Noakes del equipo de C# Dev Kit [anunció el 20 de abril de 2026](https://devblogs.microsoft.com/dotnet/writing-nodejs-addons-with-dotnet-native-aot/) que el addon nativo de Node.js de la extensión ahora está escrito enteramente en C# y compilado con .NET 10 Native AOT. Eso significa que el acceso al Windows Registry del que depende la extensión se entrega como un archivo `.node` plano producido por `dotnet publish`, sin C++, sin Python, y sin node-gyp en la cadena de build.

## Por qué esto es un gran deal para el tooling de Node

Los addons de Node.js han sido históricamente proyectos C o C++ pegados por node-gyp, que a su vez necesita Python, una toolchain C++, y un MSBuild compatible en Windows. Cualquiera que haya mantenido una extensión cross-platform de Electron sabe lo frágil que se pone esa cadena en CI. Native AOT colapsa todo el pipeline en un solo `dotnet publish`, produciendo una librería compartida específica de plataforma (`.dll`, `.so`, o `.dylib`) que Node carga directamente una vez que la renombras a `.node`. El C# Dev Kit usa exactamente ese flujo para leer el Windows Registry, removiendo Python de su setup de contribución.

## Exportar napi_register_module_v1 desde C#

El truco es que N-API (Node-API) tiene una ABI estable, así que cualquier lenguaje que pueda producir un export nativo con convenciones de llamada C puede implementar un addon de Node. En .NET 10, `[UnmanagedCallersOnly]` hace ese trabajo: fija un nombre de export y convención de llamada dentro de la imagen AOT. El entry point que Node busca es `napi_register_module_v1`.

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

El literal `"hello"u8` es un byte string UTF-8, que es lo que N-API quiere, y `&SayHello` es un puntero a función que sobrevive a AOT porque `UnmanagedCallersOnly` prohíbe features managed-only como generics y async en esa firma.

## Resolver N-API contra el host process

La segunda mitad del rompecabezas es volver a llamar a N-API. No hay un `node.dll` contra el cual linkear, porque en muchas plataformas el binario de Node es el ejecutable mismo. El post usa `[LibraryImport("node")]` junto con un `NativeLibrary.SetDllImportResolver` custom que devuelve el handle del proceso actual, así que cada llamada N-API se resuelve contra el ejecutable Node corriendo en load time.

```csharp
[LibraryImport("node", EntryPoint = "napi_create_string_utf8")]
private static partial int CreateStringUtf8(
    nint env, byte[] str, nuint length, out nint result);

NativeLibrary.SetDllImportResolver(typeof(HelloAddon).Assembly,
    (name, _, _) => name == "node"
        ? NativeLibrary.GetMainProgramHandle()
        : 0);
```

## El archivo de proyecto

Habilitar AOT es un cambio de dos líneas. `AllowUnsafeBlocks` es requerido porque el interop N-API se apoya en punteros a función y spans sobre memoria nativa.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PublishAot>true</PublishAot>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

Después de `dotnet publish -c Release`, renombra la librería de salida a `HelloAddon.node` y haz `require()` desde JavaScript como cualquier otro módulo nativo.

Para escenarios más ricos, el post también apunta a [microsoft/node-api-dotnet](https://github.com/microsoft/node-api-dotnet), que envuelve N-API en abstracciones de más alto nivel y soporta interop completo entre tipos JS y CLR. Pero para el caso de "entregar un addon nativo pequeño y rápido sin una toolchain C++", la ruta de N-API crudo más Native AOT ahora está probada en producción dentro de las propias extensiones VS Code de Microsoft.
