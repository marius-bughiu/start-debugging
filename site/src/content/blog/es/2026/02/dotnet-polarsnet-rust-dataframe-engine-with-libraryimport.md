---
title: "Polars.NET: un motor de DataFrame en Rust para .NET 10 que se apoya en LibraryImport"
description: "Un nuevo proyecto Polars.NET es tendencia después de un post de la comunidad del 6 de febrero de 2026. El titular es simple: una API DataFrame amigable con .NET respaldada por Rust Polars, con un ABI C estable e interop basada en LibraryImport para mantener el overhead bajo."
pubDate: 2026-02-08
tags:
  - "dotnet"
  - "csharp"
  - "performance"
  - "interop"
lang: "es"
translationOf: "2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport"
translatedBy: "claude"
translationDate: 2026-04-25
---

Un post de la comunidad del 6 de febrero de 2026 puso **Polars.NET** en mi radar: un motor de DataFrame para .NET respaldado por el core de **Polars** en Rust, exponiendo APIs en C# y F#. La propuesta no es "tenemos un DataFrame". Es "tenemos un DataFrame que es honesto sobre de dónde viene el rendimiento".

Si estás construyendo sobre **.NET 10** y **C# 14**, los detalles son la historia completa: ABI C estable, binarios nativos pre-construidos a través de plataformas, e interop moderna vía `LibraryImport`.

## Por qué `LibraryImport` importa para interop de alto volumen

`DllImport` funciona, pero es fácil pagar accidentalmente por marshaling y asignaciones en rutas calientes. `LibraryImport` (interop generada por fuente) es la dirección hacia donde va .NET: puede generar código pegamento que evita la sobrecarga de marshaling en runtime cuando te apegas a firmas blittable y spans explícitos.

Este es el patrón que Polars.NET afirma usar. Un ejemplo mínimo se ve así:

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

La parte importante no es `pl_version`. Es la forma: mantén la frontera delgada, mantenla explícita, y no pretendas que la interop es gratis.

## Los binarios nativos pre-construidos son el acelerador de adopción

Las bibliotecas basadas en interop mueren cuando le pides a cada usuario compilar dependencias nativas. Polars.NET menciona explícitamente binarios nativos pre-construidos para Windows, Linux, y macOS.

Cuando lo evalúes, busca un layout de NuGet como:

- `runtimes/win-x64/native/polars.dll`
- `runtimes/linux-x64/native/libpolars.so`
- `runtimes/osx-arm64/native/libpolars.dylib`

Esa es la diferencia entre "repo cool" y "dependencia usable en CI y en máquinas de dev".

## La pregunta real: ¿puedes mantener el modelo de memoria predecible?

Los DataFrames son una historia de memoria. Para un core Rust + superficie .NET, busco:

- **Reglas de propiedad claras**: ¿quién libera los buffers, y cuándo?
- **Rutas zero-copy**: el intercambio Arrow es una buena señal, pero verifica dónde es real.
- **Fronteras de excepción**: ¿un error nativo se vuelve una excepción .NET estructurada?

Si esos son sólidos, Polars.NET se vuelve una forma práctica de traer ejecución vectorizada de grado Rust a cargas de trabajo .NET sin reescribir todo.

Fuentes:

- [Repositorio de Polars.NET](https://github.com/ErrorLSC/Polars.NET)
- [Hilo de Reddit](https://www.reddit.com/r/dotnet/comments/1qxpna7/polarsnet_a_dataframe_engine_for_net/)
