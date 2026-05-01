---
title: ".NET-Performance: ToList vs. ToArray"
description: ".NET 9 verbessert die ToArray-Performance deutlich durch InlineArray und macht es schneller und speicherschonender als ToList. Sehen Sie sich Benchmarks an, die .NET 8 mit .NET 9 vergleichen."
pubDate: 2025-01-06
updatedDate: 2025-04-04
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-9"
  - "performance"
lang: "de"
translationOf: "2025/01/net-performance-tolist-vs-toarray"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 9 bringt deutliche Verbesserungen für die LINQ-Methode `ToArray`, sowohl bei der Geschwindigkeit als auch beim Speicherverbrauch. Die neue Implementierung nutzt dafür neue Laufzeitfunktionen wie `InlineArray`, um Speicher-Allokationen erheblich zu reduzieren und die Performance zu verbessern, vor allem bei einem `IEnumerable<T>` mit unbekannter Länge. Wenn Sie sich für die Implementierung interessieren, [werfen Sie einen Blick auf den PR auf GitHub](https://github.com/dotnet/runtime/pull/96570).

## .NET 8 vs. .NET 9

Sehen wir uns zuerst die Performance-Verbesserung von `ToArray` zwischen .NET 8 und .NET 9 an:

```bash
| Method  | Runtime  | Count  | Mean          | Ratio | Allocated | Alloc Ratio |
|-------- |--------- |------- |--------------:|------:|----------:|------------:|
| ToArray | .NET 8.0 | 10     |     115.61 ns |  1.00 |     256 B |        1.00 |
| ToArray | .NET 9.0 | 10     |      71.91 ns |  0.62 |     104 B |        0.41 |
|         |          |        |               |       |           |             |
| ToArray | .NET 8.0 | 1000   |   3,209.52 ns |  1.00 |    8536 B |        1.00 |
| ToArray | .NET 9.0 | 1000   |   2,625.86 ns |  0.82 |    4064 B |        0.48 |
|         |          |        |               |       |           |             |
| ToArray | .NET 8.0 | 100000 | 545,642.89 ns |  1.00 |  925132 B |        1.00 |
| ToArray | .NET 9.0 | 100000 | 362,780.53 ns |  0.67 |  400148 B |        0.43 |

BenchmarkDotNet v0.14.0, Windows 11 (10.0.26100.2605)
AMD Zen 2, 1 CPU, 8 logical and 4 physical cores
  .NET 8.0 : .NET 8.0.11 (8.0.1124.51707), X64 RyuJIT AVX2
  .NET 9.0 : .NET 9.0.0 (9.0.24.52809), X64 RyuJIT AVX2
```

Die Ergebnisse variieren leicht mit der Anzahl der Elemente im Iterator, aber Sie erhalten dennoch bis zu 38% weniger CPU-Zeit und satte 57% weniger zugewiesenen Speicher. Das ist ziemlich gut!

## ToList vs. ToArray

Traditionell war `ToList` bei Sammlungen mit unbekannter Größe schneller, weil die letzte Array-Allokation entfiel, während `ToArray` beim Speicherverbrauch effizienter war. Ab .NET 9 ist das nicht mehr so, denn `ToArray` ist nun in beiden Punkten effizienter.

```bash
| Method  | Runtime  | Count  | Mean          | Ratio | Allocated | Alloc Ratio |
|-------- |--------- |------- |--------------:|------:|----------:|------------:|
| ToList  | .NET 9.0 | 10     |      81.44 ns |  1.00 |     256 B |        1.00 |
| ToArray | .NET 9.0 | 10     |      71.91 ns |  0.88 |     104 B |        0.40 |
|         |          |        |               |       |           |             |
| ToList  | .NET 9.0 | 1000   |   2,942.87 ns |  1.00 |    8464 B |        1.00 |
| ToArray | .NET 9.0 | 1000   |   2,625.86 ns |  0.89 |    4064 B |        0.48 |
|         |          |        |               |       |           |             |
| ToList  | .NET 9.0 | 100000 | 494,497.60 ns |  1.00 | 1049112 B |        1.00 |
| ToArray | .NET 9.0 | 100000 | 362,780.53 ns |  0.73 |  400148 B |        0.38 |

BenchmarkDotNet v0.14.0, Windows 11 (10.0.26100.2605)
AMD Zen 2, 1 CPU, 8 logical and 4 physical cores
  .NET 8.0 : .NET 8.0.11 (8.0.1124.51707), X64 RyuJIT AVX2
  .NET 9.0 : .NET 9.0.0 (9.0.24.52809), X64 RyuJIT AVX2
```

Insgesamt sehen wir je nach Elementanzahl einen Geschwindigkeitsunterschied von 10 bis 30% und etwa 60% weniger zugewiesenen Speicher.

## Den Benchmark ausführen

Wenn Sie möchten, können Sie diesen Benchmark mit `BenchmarkDotNet` selbst ausführen.

```cs
[SimpleJob(RuntimeMoniker.Net80, baseline: true)]
[SimpleJob(RuntimeMoniker.Net90)]
[MemoryDiagnoser(false)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class Benchmarks
{
    [Params(10, 1000, 100000)]
    public int Count;

    [Benchmark]
    public List<int> ToList() => GetItems(Count).ToList();

    [Benchmark]
    public int[] ToArray() => GetItems(Count).ToArray();

    private IEnumerable<int> GetItems(int count)
    {
        for (int i = 0; i < count; i++)
        {
            yield return 1;
        }
    }
}
```
```cs
BenchmarkRunner.Run<Benchmarks>();
```
