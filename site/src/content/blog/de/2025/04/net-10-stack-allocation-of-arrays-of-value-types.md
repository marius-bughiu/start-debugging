---
title: ".NET 10: Stack-Allokation von Arrays von Werttypen"
description: "In .NET 10 kann der JIT kleine Arrays fester Größe von Werttypen auf dem Stack allokieren, wodurch Heap-Allokationen entfallen und bis zu 60% mehr Leistung im Vergleich zu .NET 9 erzielt wird."
pubDate: 2025-04-12
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/net-10-stack-allocation-of-arrays-of-value-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 9 wurde der JIT-Compiler intelligenter darin, wie er Speicher für Objekte allokiert. Wenn er erkennt, dass ein Objekt nach dem Ende der Methode, in der es erstellt wurde, nicht mehr verwendet wird, kann er es auf dem Stack statt auf dem Heap ablegen. Das bringt einen großen Leistungsgewinn, denn die Garbage Collection muss es dann nicht weiter verfolgen. Darüber hinaus ermöglicht die Stack-Allokation dem JIT noch weitere Optimierungen, etwa das gesamte Objekt durch seine einzelnen Felder oder Werte zu ersetzen. Dadurch wird der Einsatz von Referenztypen leistungstechnisch deutlich günstiger.

In .NET 10 wurde diese Funktion auf kleine Arrays fester Größe von Werttypen erweitert. Der JIT allokiert solche Arrays auf dem Stack, wenn er weiß, dass sie nur so lange leben wie die Methode, in der sie verwendet werden.

Sehen Sie sich dieses Beispiel an:

```cs
static void Sum()
{
    int[] numbers = {1, 2, 3};
    int sum = 0;

    for (int i = 0; i < numbers.Length; i++)
    {
        sum += numbers[i];
    }

    Console.WriteLine(sum);
}
```

Das Array `numbers` enthält nur drei Ganzzahlen und wird ausschließlich innerhalb der Methode `Sum` verwendet. Da der JIT Größe und Gültigkeitsbereich zur Kompilierzeit kennt, kann er das Array sicher auf dem Stack ablegen. Das bedeutet keine Heap-Allokation und bessere Leistung.

## Benchmarks

Im Vergleich zwischen .NET 9 und .NET 10 sieht man deutlich, dass im obigen Szenario **nichts mehr auf dem Heap allokiert wird**. Daraus ergibt sich auch eine deutliche Leistungssteigerung: **.NET 10 ist im gemessenen Szenario 60% schneller**.

```clean
| Method        | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|-------------- |---------- |---------:|------:|-------:|----------:|------------:|
| AllocateArray | .NET 10.0 | 3.041 ns |  0.40 |      - |         - |        0.00 |
| AllocateArray | .NET 9.0  | 7.675 ns |  1.00 | 0.0067 |      56 B |        1.00 |
```

Falls Sie den Benchmark selbst ausführen möchten, finden Sie den Code unten:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90, baseline: true)]
[SimpleJob(RuntimeMoniker.Net10_0)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class ArrayAllocationBenchmarks
{
    [Benchmark]
    public int AllocateArray()
    {
        int total = 0;

        int[] numbers = { 1, 2, 3, 4, 5, 6, 7 };
        for (int i = 0; i < numbers.Length; i++)
        {
            total += numbers[i];
        }

        return total;
    }
}

internal class Program
{
    static void Main(string[] args)
    {
        BenchmarkRunner.Run<ArrayAllocationBenchmarks>();
    }
}
```
