---
title: ".NET 10: Leistungsverbesserungen bei der Array-Enumeration (JIT Array De-Abstraction)"
description: "In .NET 10 reduziert der JIT-Compiler den Overhead beim Iterieren von Arrays über Schnittstellen. Sehen Sie sich Benchmarks an, die .NET 9 und .NET 10 mit foreach, IEnumerable und Conditional Escape Analysis vergleichen."
pubDate: 2025-04-06
tags:
  - "dotnet"
  - "dotnet-10"
  - "performance"
lang: "de"
translationOf: "2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction"
translatedBy: "claude"
translationDate: 2026-05-01
---
In .NET 10 Preview 1 wurde der JIT-Compiler besser darin, die Verwendung von Arrays mit Schnittstellen zu optimieren, insbesondere beim Durchlaufen mit `foreach`. Das war der erste Schritt, die zusätzlichen Kosten zu reduzieren, die beim Durchlaufen von Arrays mittels Enumeratoren entstehen. Preview 2 baut auf dieser Arbeit mit weiteren Verbesserungen auf.

Sehen Sie sich das folgende Beispiel an:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90)]
public class ArrayDeAbstraction
{
    static readonly int[] array = new int[512];

    [Benchmark(Baseline = true)]
    public int Enumeration()
    {
        int sum = 0;
        foreach (int i in array) sum += i;
        return sum;
    }

    [Benchmark]
    public int EnumerationViaInterface()
    {
        IEnumerable<int> o = array;
        int sum = 0;
        foreach (int i in o) sum += i;
        return sum;
    }
}
```

In der ersten Methode ist der Array-Typ zur Kompilierzeit bekannt, sodass der JIT schnellen Code erzeugen kann. In der zweiten Methode wird das Array als `IEnumerable<int>` behandelt, wodurch der tatsächliche Typ verborgen bleibt. Das verursacht zusätzlichen Aufwand, etwa das Erzeugen eines Objekts und virtuelle Methodenaufrufe. In .NET 9 hatte das einen erheblichen Einfluss auf die Performance:

```clean
| Method                   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------:|------:|-------:|----------:|------------:|
| Enumeration             | 303.6 ns |  1.00 |      - |         - |        0.00 |
| EnumerationViaInterface | 616.1 ns |  2.03 | 0.0153 |      32 B |        1.00 |
```

Dank weiterer Verbesserungen in .NET 10, wie besserem Inlining, klügerer Speichernutzung und verbesserter Schleifenbehandlung, ist diese zusätzliche Allokation jetzt verschwunden und die Performance deutlich besser:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 216.2 ns |  0.35 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 615.8 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

Das Ziel ist, die Lücke vollständig zu schließen, auch in komplexeren Fällen. Hier ein anspruchsvolleres Beispiel:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90, baseline: true)]
[SimpleJob(RuntimeMoniker.Net10_0)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class ArrayDeAbstraction
{
    static readonly int[] array = new int[512];

    [MethodImpl(MethodImplOptions.NoInlining)]
    IEnumerable<int> GetOpaqueArray() => array;

    [Benchmark]
    public int EnumerationViaInterface()
    {
        IEnumerable<int> o = GetOpaqueArray();
        int sum = 0;
        foreach (int i in o) sum += i;
        return sum;
    }
}
```

In diesem Fall gibt die Methode ein `IEnumerable<int>` zurück, ohne offenzulegen, dass es eigentlich ein Array ist. Der JIT kennt den tatsächlichen Typ nicht und kann daher nicht so gut optimieren. Mit PGO (Profile-Guided Optimization) kann der JIT jedoch den wahrscheinlichen Typ erraten und einen schnelleren Pfad erzeugen, wenn die Vermutung stimmt.

In .NET 9 konnte der JIT den Enumerator nicht auf dem Stack platzieren. Das liegt an der sogenannten "Escape Analysis", die prüft, ob ein Objekt außerhalb der aktuellen Methode verwendet werden könnte. Falls ja, geht der JIT auf Nummer sicher und legt es auf dem Heap an. In .NET 10 gibt es jedoch eine neue Funktion namens **Conditional Escape Analysis**. Sie ist klüger darin, _wann_ etwas entkommt. Erkennt der JIT, dass das Objekt nur auf bestimmten Pfaden entkommt (etwa wenn der Typ nicht der erwartete ist), kann er einen separaten Schnellpfad erzeugen, auf dem das Objekt auf dem Stack bleibt.

Dadurch erhalten wir in .NET 10 deutlich bessere Ergebnisse als in .NET 9:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 162.5 ns |  0.26 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 617.5 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

Wie Sie sehen, geht .NET klüger mit der Array-Iteration um, selbst wenn diese hinter Schnittstellen verpackt ist. Das führt zu besserer Performance und geringerem Speicherverbrauch, vor allem in echtem Code, in dem solche Muster häufig vorkommen.
