---
title: "Rendimiento de .NET 8: UnsafeAccessor vs. Reflection"
description: "Benchmark de UnsafeAccessor frente a Reflection en .NET 8. Mira cómo UnsafeAccessor logra rendimiento sin sobrecarga comparado con la reflexión tradicional."
pubDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
En un artículo anterior vimos [cómo acceder a miembros privados usando `UnsafeAccessor`](/2023/10/unsafe-accessor/). Esta vez queremos comparar su rendimiento frente a Reflection, para ver si realmente es de coste cero o no.

Vamos a hacer cuatro benchmarks.

1.  **Reflection**: medimos cuánto cuesta obtener un método privado de un tipo e invocarlo.
2.  **Reflection con caché:** parecido al anterior, pero en vez de obtener el método cada vez, usamos una referencia cacheada al `MethodInfo`.
3.  **Unsafe accessor:** llamando al mismo método privado usando `UnsafeAccessor` en lugar de reflexión.
4.  **Acceso directo**: llamando directamente a un método público. Esto sirve de referencia para ver si `UnsafeAccessor` ofrece de verdad rendimiento sin sobrecarga.

Si quieres ejecutar los benchmarks tú mismo, aquí tienes el código:

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

## Resultados del benchmark

```plaintext
| Method              | Mean       | Error     | StdDev    |
|-------------------- |-----------:|----------:|----------:|
| Reflection          | 35.9979 ns | 0.1670 ns | 0.1562 ns |
| ReflectionWithCache | 21.2821 ns | 0.2283 ns | 0.2135 ns |
| UnsafeAccessor      |  0.0035 ns | 0.0022 ns | 0.0018 ns |
| DirectAccess        |  0.0028 ns | 0.0024 ns | 0.0023 ns |
```

Los resultados son bastante impresionantes. Comparando el acceso directo con el unsafe accessor, literalmente no hay diferencia. Los pocos nanosegundos de diferencia entre ambos pueden descartarse como ruido; de hecho, si ejecutas los benchmarks varias veces, hasta puedes encontrar ocasiones en las que los unsafe accessors sean más rápidos. Eso es perfectamente normal y básicamente nos dice que los dos son equivalentes, es decir, sin sobrecarga.

Casi no tiene sentido comparar `UnsafeAccessor` con la reflexión. En cuanto a rendimiento no hay sobrecarga y, como bonus, te llevas todo el azúcar sintáctico que conlleva tener una firma de método real.

Eso no quiere decir que la reflexión esté muerta. `UnsafeAccessor` solo cubre escenarios en los que conoces el tipo y el miembro al que necesitas acceder en tiempo de compilación. Si esa información solo está disponible en tiempo de ejecución, la reflexión sigue siendo el camino.

El código de los benchmarks también está [disponible en GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor.Benchmarks/Benchmarks.cs).
