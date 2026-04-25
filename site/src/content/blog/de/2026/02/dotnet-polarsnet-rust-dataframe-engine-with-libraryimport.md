---
title: "Polars.NET: eine Rust-DataFrame-Engine für .NET 10, die auf LibraryImport setzt"
description: "Ein neues Polars.NET-Projekt liegt nach einem Community-Post vom 6. Februar 2026 im Trend. Die Schlagzeile ist einfach: eine .NET-freundliche DataFrame-API, gestützt von Rust Polars, mit einem stabilen C ABI und LibraryImport-basierter Interop, um den Overhead niedrig zu halten."
pubDate: 2026-02-08
tags:
  - "dotnet"
  - "csharp"
  - "performance"
  - "interop"
lang: "de"
translationOf: "2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport"
translatedBy: "claude"
translationDate: 2026-04-25
---

Ein Community-Post vom 6. Februar 2026 hat **Polars.NET** auf meinen Radar gebracht: eine DataFrame-Engine für .NET, gestützt vom Rust-**Polars**-Kern, die sowohl C#- als auch F#-APIs bereitstellt. Das Versprechen ist nicht "wir haben einen DataFrame". Es ist "wir haben einen DataFrame, der ehrlich darüber ist, woher die Performance kommt".

Wenn Sie auf **.NET 10** und **C# 14** bauen, sind die Details die ganze Geschichte: stabiles C ABI, vorgefertigte native Binaries über Plattformen hinweg, und moderne Interop über `LibraryImport`.

## Warum `LibraryImport` für Hochvolumen-Interop wichtig ist

`DllImport` funktioniert, aber es ist leicht, versehentlich für Marshaling und Allokationen auf heißen Pfaden zu zahlen. `LibraryImport` (source-generated Interop) ist die Reiserichtung von .NET: es kann Glue-Code erzeugen, der Laufzeit-Marshaling-Overhead vermeidet, wenn Sie bei blittable Signaturen und expliziten Spans bleiben.

Das ist das Muster, das Polars.NET zu verwenden behauptet. Ein minimales Beispiel sieht so aus:

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

Der wichtige Teil ist nicht `pl_version`. Es ist die Form: halten Sie die Grenze dünn, halten Sie sie explizit, und tun Sie nicht so, als wäre Interop kostenlos.

## Vorgefertigte native Binaries sind der Adoptionsbeschleuniger

Interop-basierte Bibliotheken sterben, wenn Sie jeden Benutzer auffordern, native Abhängigkeiten zu kompilieren. Polars.NET ruft explizit vorgefertigte native Binaries für Windows, Linux und macOS aus.

Wenn Sie es bewerten, achten Sie auf ein NuGet-Layout wie:

- `runtimes/win-x64/native/polars.dll`
- `runtimes/linux-x64/native/libpolars.so`
- `runtimes/osx-arm64/native/libpolars.dylib`

Das ist der Unterschied zwischen "cooles Repo" und "brauchbare Abhängigkeit in CI und auf Dev-Maschinen".

## Die wirkliche Frage: können Sie das Speichermodell vorhersagbar halten?

DataFrames sind eine Speicher-Geschichte. Für einen Rust-Kern + .NET-Oberfläche suche ich nach:

- **Klare Eigentumsregeln**: wer gibt Buffer frei, und wann?
- **Zero-Copy-Pfade**: Arrow-Austausch ist ein gutes Zeichen, aber prüfen Sie, wo er real ist.
- **Exception-Grenzen**: wird ein nativer Fehler zu einer strukturierten .NET-Exception?

Falls die solide sind, wird Polars.NET zu einem praktischen Weg, vektorisierte Ausführung in Rust-Qualität zu .NET-Workloads zu bringen, ohne alles neu zu schreiben.

Quellen:

- [Polars.NET-Repository](https://github.com/ErrorLSC/Polars.NET)
- [Reddit-Thread](https://www.reddit.com/r/dotnet/comments/1qxpna7/polarsnet_a_dataframe_engine_for_net/)
