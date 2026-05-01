---
title: ".NET 10: mejoras de rendimiento en la enumeración de arreglos (desabstracción de arreglos en el JIT)"
description: "En .NET 10, el compilador JIT reduce la sobrecarga de iterar arreglos a través de interfaces. Mira los benchmarks que comparan .NET 9 vs .NET 10 con foreach, IEnumerable y análisis condicional de escape."
pubDate: 2025-04-06
tags:
  - "dotnet"
  - "dotnet-10"
  - "performance"
lang: "es"
translationOf: "2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction"
translatedBy: "claude"
translationDate: 2026-05-01
---
En .NET 10 Preview 1, el compilador JIT mejoró la forma en que optimiza el uso de arreglos con interfaces, especialmente al recorrerlos con `foreach`. Este fue el primer paso para reducir el costo adicional que conlleva usar enumeradores para recorrer arreglos. Preview 2 amplía este trabajo con todavía más mejoras.

Echa un vistazo al siguiente ejemplo:

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

En el primer método, el tipo del arreglo se conoce en tiempo de compilación, por lo que el JIT puede generar código rápido. En el segundo método, el arreglo se trata como un `IEnumerable<int>`, lo que oculta el tipo real. Esto añade trabajo extra, como crear un objeto y usar llamadas a métodos virtuales. En .NET 9, esto tenía un gran impacto en el rendimiento:

```clean
| Method                   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------:|------:|-------:|----------:|------------:|
| Enumeration             | 303.6 ns |  1.00 |      - |         - |        0.00 |
| EnumerationViaInterface | 616.1 ns |  2.03 | 0.0153 |      32 B |        1.00 |
```

Gracias a más mejoras en .NET 10, como mejor inlining, un uso más inteligente de la memoria y un mejor manejo de bucles, esa asignación extra ya no existe y el rendimiento es mucho mejor:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 216.2 ns |  0.35 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 615.8 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

El objetivo es cerrar la brecha por completo, incluso en casos más complejos. Aquí tienes un ejemplo más exigente:

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

En este caso, el método devuelve un `IEnumerable<int>` sin revelar que en realidad es un arreglo. El JIT no conoce el tipo real, por lo que no puede optimizar tan bien. Sin embargo, usando PGO (Profile-Guided Optimization), el JIT puede adivinar el tipo probable y crear una ruta más rápida cuando la conjetura es correcta.

En .NET 9, el JIT no podía colocar el enumerador en la pila. Esto se debe a algo llamado "escape analysis", que comprueba si un objeto podría usarse fuera del método actual. Si es posible, el JIT actúa de forma segura y lo coloca en el heap. Pero en .NET 10 hay una nueva característica llamada **análisis condicional de escape**. Es más inteligente al determinar _cuándo_ algo escapa. Si el JIT ve que el objeto solo escapa en ciertas rutas (como cuando el tipo no es el esperado), puede crear una ruta rápida separada en la que el objeto se mantiene en la pila.

Gracias a esto, obtenemos resultados mucho mejores en .NET 10 frente a .NET 9:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 162.5 ns |  0.26 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 617.5 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

Como puedes ver, .NET se está volviendo más inteligente al manejar la iteración de arreglos, incluso cuando están envueltos detrás de interfaces. Esto se traduce en mejor rendimiento y menor uso de memoria, sobre todo en código real donde estos patrones son comunes.
