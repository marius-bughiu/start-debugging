---
title: ".NET 10: melhorias de desempenho na enumeração de arrays (de-abstração de arrays no JIT)"
description: "No .NET 10, o compilador JIT reduz a sobrecarga de iterar arrays por meio de interfaces. Veja benchmarks comparando .NET 9 vs .NET 10 com foreach, IEnumerable e análise condicional de escape."
pubDate: 2025-04-06
tags:
  - "dotnet"
  - "dotnet-10"
  - "performance"
lang: "pt-br"
translationOf: "2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction"
translatedBy: "claude"
translationDate: 2026-05-01
---
No .NET 10 Preview 1, o compilador JIT melhorou a forma de otimizar como arrays são usados com interfaces, especialmente ao percorrê-los com `foreach`. Esse foi o primeiro passo para reduzir o custo extra que vem com o uso de enumeradores para iterar arrays. O Preview 2 amplia esse trabalho com ainda mais melhorias.

Veja o seguinte exemplo:

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

No primeiro método, o tipo do array é conhecido em tempo de compilação, então o JIT pode gerar código rápido. No segundo método, o array é tratado como um `IEnumerable<int>`, o que esconde o tipo real. Isso adiciona algum trabalho extra, como criar um objeto e usar chamadas de métodos virtuais. No .NET 9, isso tinha um grande impacto no desempenho:

```clean
| Method                   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------:|------:|-------:|----------:|------------:|
| Enumeration             | 303.6 ns |  1.00 |      - |         - |        0.00 |
| EnumerationViaInterface | 616.1 ns |  2.03 | 0.0153 |      32 B |        1.00 |
```

Graças a melhorias adicionais no .NET 10, como inlining melhor, uso de memória mais inteligente e tratamento de loops aprimorado, essa alocação extra desapareceu e o desempenho está muito melhor:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 216.2 ns |  0.35 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 615.8 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

O objetivo é fechar totalmente a diferença, mesmo em casos mais complexos. Aqui está um exemplo mais difícil:

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

Nesse caso, o método retorna um `IEnumerable<int>` sem revelar que é, na verdade, um array. O JIT não conhece o tipo real, então não consegue otimizar tão bem. No entanto, usando PGO (Profile-Guided Optimization), o JIT pode adivinhar o tipo provável e criar um caminho mais rápido quando o palpite estiver correto.

No .NET 9, o JIT não conseguia colocar o enumerador na pilha. Isso se deve a algo chamado "escape analysis", que verifica se um objeto pode ser usado fora do método atual. Se puder, o JIT joga seguro e o coloca no heap. Mas no .NET 10 há um novo recurso chamado **análise condicional de escape**. Ele é mais inteligente para descobrir _quando_ algo escapa. Se o JIT vê que o objeto só escapa em determinados caminhos (como quando o tipo não é o esperado), ele pode criar um caminho rápido separado em que o objeto fica na pilha.

Graças a isso, obtemos resultados muito melhores no .NET 10 em comparação com o .NET 9:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 162.5 ns |  0.26 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 617.5 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

Como você pode ver, o .NET está ficando mais inteligente no tratamento da iteração de arrays, mesmo quando estão envolvidos por interfaces. Isso leva a melhor desempenho e menor uso de memória, especialmente em código do mundo real onde esses padrões são comuns.
