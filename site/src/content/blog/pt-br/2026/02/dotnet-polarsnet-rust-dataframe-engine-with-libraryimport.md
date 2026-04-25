---
title: "Polars.NET: um motor de DataFrame em Rust para .NET 10 que se apoia em LibraryImport"
description: "Um novo projeto Polars.NET está em alta depois de um post da comunidade em 6 de fevereiro de 2026. A manchete é simples: uma API DataFrame amigável ao .NET apoiada pelo Polars em Rust, com um ABI C estável e interop baseada em LibraryImport para manter o overhead baixo."
pubDate: 2026-02-08
tags:
  - "dotnet"
  - "csharp"
  - "performance"
  - "interop"
lang: "pt-br"
translationOf: "2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport"
translatedBy: "claude"
translationDate: 2026-04-25
---

Um post da comunidade em 6 de fevereiro de 2026 colocou o **Polars.NET** no meu radar: um motor de DataFrame para .NET apoiado pelo core do **Polars** em Rust, expondo APIs em C# e F#. A proposta não é "temos um DataFrame". É "temos um DataFrame que é honesto sobre de onde vem o desempenho".

Se você está construindo em **.NET 10** e **C# 14**, os detalhes são a história inteira: ABI C estável, binários nativos pré-construídos em todas as plataformas, e interop moderna via `LibraryImport`.

## Por que `LibraryImport` importa para interop de alto volume

`DllImport` funciona, mas é fácil acidentalmente pagar por marshaling e alocações em caminhos quentes. `LibraryImport` (interop gerada por fonte) é a direção em que o .NET está indo: pode gerar código de cola que evita o overhead de marshaling em runtime quando você se atém a assinaturas blittable e spans explícitos.

Esse é o padrão que Polars.NET afirma usar. Um exemplo mínimo se parece com isso:

```csharp
using System;
using System.Runtime.InteropServices;

internal static partial class NativePolars
{
    // Name depends on platform: polars.dll, libpolars.so, libpolars.dylib.
    [LibraryImport("polars", EntryPoint = "pl_version")]
    internal static partial IntPtr Version();
}

static string GetNativeVersion()
{
    var ptr = NativePolars.Version();
    return Marshal.PtrToStringUTF8(ptr) ?? "<unknown>";
}
```

A parte importante não é `pl_version`. É a forma: mantenha a fronteira fina, mantenha-a explícita, e não finja que interop é grátis.

## Binários nativos pré-construídos são o acelerador de adoção

Bibliotecas baseadas em interop morrem quando você pede para cada usuário compilar dependências nativas. Polars.NET explicitamente menciona binários nativos pré-construídos para Windows, Linux, e macOS.

Quando você avaliar, procure um layout de NuGet como:

- `runtimes/win-x64/native/polars.dll`
- `runtimes/linux-x64/native/libpolars.so`
- `runtimes/osx-arm64/native/libpolars.dylib`

Essa é a diferença entre "repo legal" e "dependência usável em CI e máquinas de dev".

## A pergunta real: você consegue manter o modelo de memória previsível?

DataFrames são uma história de memória. Para um core Rust + superfície .NET, eu procuro:

- **Regras de propriedade claras**: quem libera os buffers, e quando?
- **Caminhos zero-copy**: o intercâmbio Arrow é um bom sinal, mas verifique onde é real.
- **Fronteiras de exceção**: um erro nativo se torna uma exceção .NET estruturada?

Se esses estiverem sólidos, Polars.NET se torna uma maneira prática de trazer execução vetorizada de grau Rust para cargas de trabalho .NET sem reescrever tudo.

Fontes:

- [Repositório do Polars.NET](https://github.com/ErrorLSC/Polars.NET)
- [Thread no Reddit](https://www.reddit.com/r/dotnet/comments/1qxpna7/polarsnet_a_dataframe_engine_for_net/)
