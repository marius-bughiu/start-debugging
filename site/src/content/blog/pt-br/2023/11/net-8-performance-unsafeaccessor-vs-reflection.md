---
title: "Desempenho do .NET 8: UnsafeAccessor vs. Reflection"
description: "Benchmark de UnsafeAccessor contra Reflection no .NET 8. Veja como UnsafeAccessor entrega desempenho sem overhead em comparação com a reflexão tradicional."
pubDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
Em um artigo anterior vimos [como acessar membros privados usando `UnsafeAccessor`](/2023/10/unsafe-accessor/). Desta vez, queremos olhar para o desempenho dele em comparação com Reflection e ver se realmente é zero-overhead ou não.

Vamos rodar quatro benchmarks.

1.  **Reflection**: medimos o custo de obter um método privado de um tipo e invocá-lo.
2.  **Reflection com cache:** parecido com o anterior, mas em vez de buscar o método toda vez, usamos uma referência cacheada para o `MethodInfo`.
3.  **Unsafe accessor:** chamando o mesmo método privado usando `UnsafeAccessor` em vez de reflexão.
4.  **Acesso direto**: chamando diretamente um método público. Isso serve como base para ver se `UnsafeAccessor` realmente entrega desempenho sem overhead.

Se você quiser rodar os benchmarks por conta própria, o código está aqui embaixo:

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

## Resultados do benchmark

```plaintext
| Method              | Mean       | Error     | StdDev    |
|-------------------- |-----------:|----------:|----------:|
| Reflection          | 35.9979 ns | 0.1670 ns | 0.1562 ns |
| ReflectionWithCache | 21.2821 ns | 0.2283 ns | 0.2135 ns |
| UnsafeAccessor      |  0.0035 ns | 0.0022 ns | 0.0018 ns |
| DirectAccess        |  0.0028 ns | 0.0024 ns | 0.0023 ns |
```

Os resultados são bem impressionantes. Comparando acesso direto com unsafe accessor, literalmente não há diferença. Os poucos nanosegundos de diferença entre os dois podem ser descartados como ruído. Na verdade, se você rodar os benchmarks algumas vezes, é até possível pegar casos em que unsafe accessors são mais rápidos. Isso é perfeitamente normal e basicamente nos diz que os dois são equivalentes, ou seja, sem overhead.

Praticamente não há motivo para comparar `UnsafeAccessor` com reflexão. Em termos de desempenho você não tem overhead e, de bônus, ainda ganha todo o açúcar de ter uma assinatura de método de verdade.

Isso não quer dizer que reflexão esteja morta. `UnsafeAccessor` cobre apenas cenários em que você conhece o tipo e o membro a ser acessado em tempo de compilação. Se essa informação só está disponível em tempo de execução, reflexão continua sendo o caminho.

O código dos benchmarks também está [disponível no GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor.Benchmarks/Benchmarks.cs).
