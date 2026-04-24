---
title: "Node.js Addons на C#: .NET Native AOT заменяет C++ и node-gyp"
description: "Команда C# Dev Kit сменила свой C++ Node.js addon на библиотеку .NET 10 Native AOT, используя N-API, UnmanagedCallersOnly и LibraryImport для производства единого файла .node без Python и node-gyp."
pubDate: 2026-04-21
tags:
  - ".NET 10"
  - "Native AOT"
  - "C#"
  - "Node.js"
  - "Interop"
lang: "ru"
translationOf: "2026/04/nodejs-addons-dotnet-native-aot"
translatedBy: "claude"
translationDate: 2026-04-24
---

Drew Noakes из команды C# Dev Kit [анонсировал 20 апреля 2026](https://devblogs.microsoft.com/dotnet/writing-nodejs-addons-with-dotnet-native-aot/), что нативный Node.js addon расширения теперь полностью написан на C# и скомпилирован .NET 10 Native AOT. Это значит, что доступ к Windows Registry, от которого зависит расширение, поставляется как обычный `.node` файл, произведённый `dotnet publish`, без C++, без Python, и без node-gyp в build-цепочке.

## Почему это большое событие для Node tooling

Node.js addons исторически были C или C++ проектами, склеенными node-gyp, который в свою очередь требует Python, C++ toolchain и совместимый MSBuild на Windows. Любой, кто поддерживал кроссплатформенное Electron-расширение, знает, насколько хрупкой становится эта цепочка в CI. Native AOT сжимает весь пайплайн в единственный `dotnet publish`, производя специфичную для платформы shared library (`.dll`, `.so`, или `.dylib`), которую Node грузит напрямую, как только вы переименуете её в `.node`. C# Dev Kit использует ровно этот поток, чтобы читать Windows Registry, убирая Python из contributor setup.

## Экспорт napi_register_module_v1 из C#

Трюк в том, что у N-API (Node-API) стабильный ABI, так что любой язык, который может произвести нативный export с C calling conventions, может реализовать Node addon. В .NET 10 `[UnmanagedCallersOnly]` делает эту работу: фиксирует имя export и calling convention в AOT-образ. Entry point, который ищет Node, это `napi_register_module_v1`.

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

Литерал `"hello"u8` - это UTF-8 byte string, именно то, что хочет N-API, а `&SayHello` - это function pointer, переживающий AOT, потому что `UnmanagedCallersOnly` запрещает managed-only фичи вроде generics и async на этой сигнатуре.

## Разрешение N-API против host process

Вторая половина головоломки - вызов обратно в N-API. Нет `node.dll`, против которой линковаться, потому что на многих платформах бинарник Node - это сам executable. Пост использует `[LibraryImport("node")]` вместе с кастомным `NativeLibrary.SetDllImportResolver`, возвращающим handle текущего процесса, так что каждый N-API вызов разрешается против запущенного Node executable во время загрузки.

```csharp
[LibraryImport("node", EntryPoint = "napi_create_string_utf8")]
private static partial int CreateStringUtf8(
    nint env, byte[] str, nuint length, out nint result);

NativeLibrary.SetDllImportResolver(typeof(HelloAddon).Assembly,
    (name, _, _) => name == "node"
        ? NativeLibrary.GetMainProgramHandle()
        : 0);
```

## Файл проекта

Включить AOT - изменение в две строки. `AllowUnsafeBlocks` требуется, потому что N-API interop опирается на function pointers и spans над нативной памятью.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PublishAot>true</PublishAot>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

После `dotnet publish -c Release` переименуйте выходную библиотеку в `HelloAddon.node` и `require()` её из JavaScript как любой другой нативный модуль.

Для более богатых сценариев пост также указывает на [microsoft/node-api-dotnet](https://github.com/microsoft/node-api-dotnet), оборачивающий N-API в абстракции более высокого уровня и поддерживающий полный interop между JS и CLR типами. Но для случая "поставить небольшой быстрый нативный addon без C++ toolchain", путь сырого N-API плюс Native AOT теперь production-проверен внутри собственных VS Code расширений Microsoft.
