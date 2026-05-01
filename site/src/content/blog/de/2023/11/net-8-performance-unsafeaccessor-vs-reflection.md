---
title: ".NET 8 Performance: UnsafeAccessor vs. Reflection"
description: "Benchmark von UnsafeAccessor gegen Reflection in .NET 8. So erreicht UnsafeAccessor Performance ohne Overhead im Vergleich zur klassischen Reflection."
pubDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
In einem früheren Artikel haben wir gezeigt, [wie man mit `UnsafeAccessor` auf private Member zugreift](/2023/10/unsafe-accessor/). Diesmal werfen wir einen Blick auf die Performance im Vergleich zu Reflection, um zu sehen, ob das Ganze tatsächlich ohne Overhead ist oder nicht.

Wir führen vier Benchmarks durch.

1.  **Reflection**: Wir messen das Abrufen einer privaten Methode aus einem Typ und deren Aufruf.
2.  **Reflection mit Cache:** ähnlich wie oben, aber statt die Methode jedes Mal neu zu holen, verwenden wir eine zwischengespeicherte Referenz auf das `MethodInfo`.
3.  **Unsafe Accessor:** Aufruf derselben privaten Methode über `UnsafeAccessor` statt über Reflection.
4.  **Direkter Zugriff**: Aufruf einer öffentlichen Methode direkt. Das dient als Referenz, um zu prüfen, ob `UnsafeAccessor` wirklich Performance ohne Overhead liefert.

Wenn Sie die Benchmarks selbst ausführen möchten, finden Sie den Code unten:

```cs
[SimpleJob(RuntimeMoniker.Net80)]
public class Benchmarks
{
    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "PrivateMethod")]
    extern static int PrivateMethod(Foo @this, int value);

    static readonly Foo _instance = new();

    static readonly MethodInfo _privateMethod = typeof(Foo)
        .GetMethod("PrivateMethod", BindingFlags.Instance | BindingFlags.NonPublic);

    [Benchmark]
    public int Reflection() => (int)typeof(Foo)
        .GetMethod("PrivateMethod", BindingFlags.Instance | BindingFlags.NonPublic)
        .Invoke(_instance, [42]);

    [Benchmark]
    public int ReflectionWithCache() => (int)_privateMethod.Invoke(_instance, [42]);

    [Benchmark]
    public int UnsafeAccessor() => PrivateMethod(_instance, 42);

    [Benchmark]
    public int DirectAccess() => _instance.PublicMethod(42);
}
```

## Benchmark-Ergebnisse

```plaintext
| Method              | Mean       | Error     | StdDev    |
|-------------------- |-----------:|----------:|----------:|
| Reflection          | 35.9979 ns | 0.1670 ns | 0.1562 ns |
| ReflectionWithCache | 21.2821 ns | 0.2283 ns | 0.2135 ns |
| UnsafeAccessor      |  0.0035 ns | 0.0022 ns | 0.0018 ns |
| DirectAccess        |  0.0028 ns | 0.0024 ns | 0.0023 ns |
```

Die Ergebnisse sind ziemlich beeindruckend. Im Vergleich zwischen Direktzugriff und Unsafe Accessor gibt es buchstäblich keinen Unterschied. Die paar Nanosekunden Differenz lassen sich als Rauschen abtun. Tatsächlich kann es sogar passieren, dass Unsafe Accessors bei mehreren Durchläufen schneller sind. Das ist völlig normal und sagt uns im Grunde, dass beide gleichwertig sind, also ohne Overhead.

Es macht kaum Sinn, `UnsafeAccessor` mit Reflection zu vergleichen. Performancetechnisch entsteht kein Overhead, und als Bonus bekommen Sie den ganzen syntaktischen Komfort einer echten Methodensignatur.

Das heißt nicht, dass Reflection tot ist. `UnsafeAccessor` deckt nur Szenarien ab, in denen Typ und Member, auf die zugegriffen werden soll, zur Compile-Zeit bekannt sind. Wenn diese Informationen erst zur Laufzeit verfügbar sind, ist Reflection nach wie vor das Mittel der Wahl.

Der Benchmark-Code ist auch [auf GitHub verfügbar](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor.Benchmarks/Benchmarks.cs).
