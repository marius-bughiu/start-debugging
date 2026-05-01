---
title: ".NET 10: Alocação em pilha de arrays de tipos por valor"
description: "No .NET 10, o JIT consegue alocar em pilha arrays pequenos de tamanho fixo de tipos por valor, eliminando alocações no heap e entregando desempenho até 60% melhor em comparação com o .NET 9."
pubDate: 2025-04-12
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/net-10-stack-allocation-of-arrays-of-value-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 9, o compilador JIT ficou mais esperto em relação a como aloca memória para objetos. Se ele conseguir determinar que um objeto não será usado depois que o método em que foi criado terminar, pode colocá-lo na pilha em vez de no heap. Isso é uma grande vitória em desempenho, porque o coletor de lixo não precisa acompanhá-lo. Além disso, a alocação em pilha ajuda o JIT a aplicar otimizações ainda mais agressivas, como substituir o objeto inteiro por apenas seus campos ou valores individuais. Isso torna o uso de tipos de referência bem mais barato em termos de desempenho.

No .NET 10, esse recurso foi ampliado para incluir arrays pequenos e de tamanho fixo de tipos por valor. O JIT alocará esses arrays na pilha quando souber que eles só vivem enquanto o método em que estão também viver.

Veja este exemplo:

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

Aqui, o array `numbers` tem apenas três inteiros e é usado somente dentro do método `Sum`. Como o JIT conhece seu tamanho e escopo em tempo de compilação, pode colocar o array na pilha com segurança. Isso significa nenhuma alocação no heap e melhor desempenho.

## Benchmarks

Comparando .NET 9 com .NET 10, vemos claramente que para o cenário acima **nada mais é alocado no heap**. Isso também resulta em uma melhora bastante significativa de desempenho, com **o .NET 10 sendo 60% mais rápido** no cenário avaliado.

```clean
| Method        | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|-------------- |---------- |---------:|------:|-------:|----------:|------------:|
| AllocateArray | .NET 10.0 | 3.041 ns |  0.40 |      - |         - |        0.00 |
| AllocateArray | .NET 9.0  | 7.675 ns |  1.00 | 0.0067 |      56 B |        1.00 |
```

Caso você queira executar o benchmark por conta própria, o código está abaixo:

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
