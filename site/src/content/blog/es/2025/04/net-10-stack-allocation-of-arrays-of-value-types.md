---
title: ".NET 10: Asignación en pila de arreglos de tipos por valor"
description: "En .NET 10, el JIT puede asignar en pila arreglos pequeños de tamaño fijo de tipos por valor, eliminando asignaciones en el heap y ofreciendo hasta un 60% más de rendimiento frente a .NET 9."
pubDate: 2025-04-12
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/net-10-stack-allocation-of-arrays-of-value-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 9, el compilador JIT se volvió más inteligente respecto a cómo asigna memoria para los objetos. Si puede determinar que un objeto no se va a usar después de que termine el método donde se creó, puede colocarlo en la pila en lugar de en el heap. Esto es una gran ventaja de rendimiento, porque la recolección de basura no tiene que rastrearlo. Además, la asignación en pila permite al JIT aplicar aún más optimizaciones, como reemplazar el objeto completo por sus campos o valores individuales. Esto hace que usar tipos de referencia salga mucho más barato en términos de rendimiento.

En .NET 10, esta característica se amplió para incluir arreglos pequeños y de tamaño fijo de tipos por valor. El JIT asignará estos arreglos en la pila cuando sepa que solo viven mientras dure el método en el que están.

Mira este ejemplo:

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

Aquí, el arreglo `numbers` solo tiene tres enteros y solo se utiliza dentro del método `Sum`. Como el JIT conoce su tamaño y alcance en tiempo de compilación, puede colocar el arreglo en la pila con seguridad. Eso significa cero asignación en el heap y mejor rendimiento.

## Benchmarks

Comparando .NET 9 con .NET 10 podemos ver claramente que en el escenario anterior **ya no se asigna nada en el heap**. Esto también se traduce en una mejora bastante significativa de rendimiento, con **.NET 10 siendo un 60% más rápido** en el escenario evaluado.

```clean
| Method        | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|-------------- |---------- |---------:|------:|-------:|----------:|------------:|
| AllocateArray | .NET 10.0 | 3.041 ns |  0.40 |      - |         - |        0.00 |
| AllocateArray | .NET 9.0  | 7.675 ns |  1.00 | 0.0067 |      56 B |        1.00 |
```

Si quieres ejecutar el benchmark por tu cuenta, puedes encontrar el código a continuación:

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
