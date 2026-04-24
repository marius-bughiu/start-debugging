---
title: "Addons Node.js em C#: .NET Native AOT substitui C++ e node-gyp"
description: "O time do C# Dev Kit trocou seu addon Node.js C++ por uma biblioteca .NET 10 Native AOT, usando N-API, UnmanagedCallersOnly e LibraryImport para produzir um único arquivo .node sem Python nem node-gyp."
pubDate: 2026-04-21
tags:
  - ".NET 10"
  - "Native AOT"
  - "C#"
  - "Node.js"
  - "Interop"
lang: "pt-br"
translationOf: "2026/04/nodejs-addons-dotnet-native-aot"
translatedBy: "claude"
translationDate: 2026-04-24
---

Drew Noakes do time do C# Dev Kit [anunciou em 20 de abril de 2026](https://devblogs.microsoft.com/dotnet/writing-nodejs-addons-with-dotnet-native-aot/) que o addon nativo Node.js da extensão agora é inteiramente escrito em C# e compilado com .NET 10 Native AOT. Isso significa que o acesso ao Windows Registry de que a extensão depende é entregue como um arquivo `.node` simples produzido pelo `dotnet publish`, sem C++, sem Python, e sem node-gyp na cadeia de build.

## Por que isso é um grande deal para o tooling Node

Addons Node.js têm historicamente sido projetos C ou C++ colados por node-gyp, que por sua vez precisa de Python, uma toolchain C++, e um MSBuild compatível no Windows. Qualquer um que já tenha mantido uma extensão Electron cross-platform sabe como essa corrente fica frágil no CI. Native AOT colapsa todo o pipeline num único `dotnet publish`, produzindo uma biblioteca compartilhada específica da plataforma (`.dll`, `.so`, ou `.dylib`) que o Node carrega diretamente assim que você renomeia para `.node`. O C# Dev Kit usa exatamente esse fluxo para ler o Windows Registry, removendo Python do setup dos contribuidores.

## Exportando napi_register_module_v1 do C#

O truque é que N-API (Node-API) tem ABI estável, então qualquer linguagem que possa produzir um export nativo com convenções de chamada C consegue implementar um addon Node. No .NET 10, `[UnmanagedCallersOnly]` faz esse trabalho: fixa um nome de export e convenção de chamada na imagem AOT. O entry point que o Node procura é `napi_register_module_v1`.

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

O literal `"hello"u8` é uma string de bytes UTF-8, que é o que N-API quer, e `&SayHello` é um ponteiro de função que sobrevive ao AOT porque `UnmanagedCallersOnly` proíbe features só-managed como generics e async naquela assinatura.

## Resolvendo N-API contra o host process

A segunda metade do quebra-cabeça é chamar de volta para N-API. Não há `node.dll` para linkar, porque em muitas plataformas o binário do Node é o próprio executável. O post usa `[LibraryImport("node")]` junto com um `NativeLibrary.SetDllImportResolver` customizado que retorna o handle do processo atual, então toda chamada N-API resolve contra o executável Node rodando em load time.

```csharp
[LibraryImport("node", EntryPoint = "napi_create_string_utf8")]
private static partial int CreateStringUtf8(
    nint env, byte[] str, nuint length, out nint result);

NativeLibrary.SetDllImportResolver(typeof(HelloAddon).Assembly,
    (name, _, _) => name == "node"
        ? NativeLibrary.GetMainProgramHandle()
        : 0);
```

## O arquivo de projeto

Habilitar AOT é uma mudança de duas linhas. `AllowUnsafeBlocks` é necessário porque o interop N-API depende de ponteiros de função e spans sobre memória nativa.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PublishAot>true</PublishAot>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

Depois de `dotnet publish -c Release`, renomeie a biblioteca de saída para `HelloAddon.node` e faça `require()` dela do JavaScript como qualquer outro módulo nativo.

Para cenários mais ricos, o post também aponta para [microsoft/node-api-dotnet](https://github.com/microsoft/node-api-dotnet), que envolve N-API em abstrações de mais alto nível e suporta interop completo entre tipos JS e CLR. Mas para o caso de "entregar um addon nativo pequeno e rápido sem uma toolchain C++", a rota de N-API cru mais Native AOT agora está provada em produção dentro das próprias extensões VS Code da Microsoft.
