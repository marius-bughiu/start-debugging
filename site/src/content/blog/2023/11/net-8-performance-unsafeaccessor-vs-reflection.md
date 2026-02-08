---
title: ".NET 8 Performance: UnsafeAccessor vs. Reflection"
description: "In a previous article we covered how to access private members using UnsafeAccessor. This time around, we want to look at it’s performance compared to Reflection, and to see whether it’s truly zero-overhead or not. We’re going to do four benchmarks. If you want to run the benchmarks yourself, you have the code below: Benchmark…"
pubDate: 2023-11-01
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
In a previous article we covered [how to access private members using `UnsafeAccessor`](/2023/10/unsafe-accessor/). This time around, we want to look at it’s performance compared to Reflection, and to see whether it’s truly zero-overhead or not.

We’re going to do four benchmarks.

1.  **Reflection**: we benchmark retrieving a private method from a type and invoking it.
2.  **Reflection with cache:** similar to the one above, but instead of retrieving the method each time, we use a cached reference to the `MethodInfo`.
3.  **Unsafe accessor:** calling the same private method using `UnsafeAccessor` instead of reflection.
4.  **Direct access**: calling a public method directly. This should serve as a benchmark to see if `UnsafeAccessor` truly provides zero-overhead performance.

If you want to run the benchmarks yourself, you have the code below:

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

## Benchmark results

```javascript
| Method              | Mean       | Error     | StdDev    |
|-------------------- |-----------:|----------:|----------:|
| Reflection          | 35.9979 ns | 0.1670 ns | 0.1562 ns |
| ReflectionWithCache | 21.2821 ns | 0.2283 ns | 0.2135 ns |
| UnsafeAccessor      |  0.0035 ns | 0.0022 ns | 0.0018 ns |
| DirectAccess        |  0.0028 ns | 0.0024 ns | 0.0023 ns |
```

The results are quite impressive. Comparing direct access to unsafe accessor, there’s literally no difference. The few nanoseconds diference between the two can be discarded as noise – in fact, if you run the benchmarks a few times, you might even get instances where unsafe accessors are faster. That’s perfectly normal, and it’s basically telling us that the two are equivalent – thus zero-overhead.

There’s almost no point in comparing `UnsafeAccessor` to reflection. Performance-wise you have no overhead, and as a bonus you also get all the sugar that comes with having an actual method signature.

That’s not to say that reflection is dead. `UnsafeAccessor` only covers scenarios where you know the type and member that needs to be accessed at compile-time. If that information is only available to you at runtime, reflection is still the way to go.

Benchmarks code is also [available on GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor.Benchmarks/Benchmarks.cs).
