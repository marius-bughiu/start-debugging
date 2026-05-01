---
title: "Производительность .NET 8: UnsafeAccessor против рефлексии"
description: "Бенчмарк UnsafeAccessor против рефлексии в .NET 8. Посмотрите, как UnsafeAccessor добивается производительности без накладных расходов по сравнению с классической рефлексией."
pubDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
В предыдущей статье мы рассмотрели, [как обращаться к приватным членам с помощью `UnsafeAccessor`](/2023/10/unsafe-accessor/). На этот раз мы хотим взглянуть на его производительность по сравнению с рефлексией и понять, действительно ли это решение без накладных расходов.

Мы проведём четыре бенчмарка.

1.  **Reflection**: измеряем получение приватного метода из типа и его вызов.
2.  **Reflection с кешем:** похоже на предыдущий вариант, но вместо того чтобы получать метод каждый раз, используем закешированную ссылку на `MethodInfo`.
3.  **Unsafe accessor:** вызов того же приватного метода с помощью `UnsafeAccessor` вместо рефлексии.
4.  **Прямой доступ**: непосредственный вызов публичного метода. Это будет ориентиром, по которому мы поймём, действительно ли `UnsafeAccessor` обеспечивает производительность без накладных расходов.

Если вы хотите запустить бенчмарки сами, ниже приведён код:

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

## Результаты бенчмарка

```plaintext
| Method              | Mean       | Error     | StdDev    |
|-------------------- |-----------:|----------:|----------:|
| Reflection          | 35.9979 ns | 0.1670 ns | 0.1562 ns |
| ReflectionWithCache | 21.2821 ns | 0.2283 ns | 0.2135 ns |
| UnsafeAccessor      |  0.0035 ns | 0.0022 ns | 0.0018 ns |
| DirectAccess        |  0.0028 ns | 0.0024 ns | 0.0023 ns |
```

Результаты весьма впечатляют. Если сравнивать прямой доступ и unsafe accessor, разницы буквально нет. Те несколько наносекунд разницы между ними можно отбросить как шум: на самом деле, если запустить бенчмарки несколько раз, иногда unsafe accessors даже оказываются быстрее. Это совершенно нормально и по сути говорит нам, что оба варианта эквивалентны, то есть без накладных расходов.

Сравнивать `UnsafeAccessor` с рефлексией почти не имеет смысла. По производительности накладных расходов нет, и в качестве бонуса вы получаете весь синтаксический сахар, связанный с настоящей сигнатурой метода.

Это не значит, что рефлексия мертва. `UnsafeAccessor` покрывает только сценарии, в которых тип и член, к которому нужно обратиться, известны на этапе компиляции. Если эта информация доступна только во время выполнения, рефлексия по-прежнему остаётся правильным выбором.

Код бенчмарков также [доступен на GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor.Benchmarks/Benchmarks.cs).
