---
title: "El JIT de .NET 11 desvirtualiza los métodos virtuales genéricos, y la asignación de memoria desaparece con ellos"
description: "El artículo Performance Improvements in .NET 11 de Stephen Toub muestra llamadas a métodos virtuales genéricos que bajan de 6.7 ns y 24 bytes a 1.8 ns y cero asignaciones. Tres pull requests de RyuJIT desbloquearon el inlining en el despacho que solía ser el más opaco de .NET."
pubDate: 2026-09-16
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "es"
translationOf: "2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods"
translatedBy: "claude"
translationDate: 2026-09-16
---

Stephen Toub publicó ["Performance Improvements in .NET 11"](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) el 2026-09-15, y enterrado en la sección de desabstracción hay un cambio que estuvo bloqueado durante años: RyuJIT ya puede desvirtualizar métodos virtuales genéricos.

Los GVM han sido la forma de despacho más lenta de .NET durante mucho tiempo, y por una razón estructural. Un método virtual normal tiene una ranura en la vtable, así que el compilador sabe dónde buscar. `int SizeOf<T>(T value)` declarado en una interfaz no tiene una sola ranura, porque cada instanciación es un cuerpo de método distinto identificado por los argumentos de tipo. Resolver uno implica una búsqueda en tiempo de ejecución, y para el JIT el resultado es un puntero a función opaco. Opaco significa que no hay inlining, y sin inlining el análisis de escape nunca llega a ver a través de la llamada.

## El benchmark del artículo

```csharp
[Benchmark]
public int NonShared() => ((IProcessor)new Processor()).SizeOf(42);

[Benchmark]
public int Shared() => ((IProcessor)new Processor()).SizeOf("hello");

private interface IProcessor
{
    int SizeOf<T>(T value);
}

private sealed class Processor : IProcessor
{
    public int SizeOf<T>(T value) => Unsafe.SizeOf<T>();
}
```

`NonShared` se instancia sobre `int`, así que el runtime compila un cuerpo dedicado. `Shared` se instancia sobre `string`, que usa el cuerpo compartido para tipos de referencia y por lo tanto necesita que se propague un argumento de contexto genérico a través de la llamada. Ambas eran lentas:

| Método | Runtime | Media | Ratio | Asignado |
| --- | --- | --- | --- | --- |
| NonShared | .NET 10.0 | 6.678 ns | 1.00 | 24 B |
| NonShared | .NET 11.0 | 1.764 ns | 0.26 | 0 B |
| Shared | .NET 10.0 | 7.166 ns | 1.00 | 24 B |
| Shared | .NET 11.0 | 1.764 ns | 0.25 | 0 B |

## Tres pull requests, en orden

[dotnet/runtime#120866](https://github.com/dotnet/runtime/pull/120866) llegó primero, en noviembre de 2025, y es el que desbloquea todo lo demás. El JIT solía volcar el destino de la llamada `ldvirtftn` a un temporal antes de preparar los argumentos, y eso bastaba para mantener el despacho opaco durante el resto del pipeline. Quitar ese volcado permitió que la evaluación del destino se adelantara a la de los argumentos cuando es legal hacerlo.

[dotnet/runtime#122023](https://github.com/dotnet/runtime/pull/122023) luego le enseñó al JIT a desvirtualizar GVM no compartidos, llevando consigo el contexto genérico que la llamada necesita para que el despacho indirecto se convierta en una llamada directa y susceptible de inlining. [dotnet/runtime#128702](https://github.com/dotnet/runtime/pull/128702) extendió eso a los GVM compartidos y a las implementaciones de interfaz por defecto que requieren stubs de instanciación, que es la razón por la que la fila `Shared` cae en los mismos 1.764 ns que `NonShared`.

## Por qué desaparecen los 24 bytes

La asignación nunca fue el objetivo de la llamada. `new Processor()` existe solo para que la conversión a la interfaz tenga un receptor. En .NET 10, la llamada opaca obligaba al JIT a asumir que el receptor escapaba, así que `Processor` iba al heap: 24 bytes por invocación.

Una vez que la llamada se hace inline, el análisis de escape puede demostrar que el objeto nunca sale del marco. La instancia se asigna en la pila, nadie la lee, y se elimina por completo. `Unsafe.SizeOf<T>()` se convierte en una constante en la misma pasada. La mejora de 3.8x es real, pero el cero en la columna de memoria asignada es la parte que se nota en un servicio con mucha presión de GC.

Una advertencia: esto necesita que el JIT conozca el tipo exacto del receptor en el sitio de la llamada, como ocurre aquí con un tipo `sealed` construido localmente. Para un sitio de llamada realmente polimórfico sigues dependiendo de la desvirtualización guiada de [PGO dinámico](/es/2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in/), que te da una comprobación de tipo más una ruta rápida en línea en vez de una llamada directa.

Si escribes interfaces de visitante, ganchos de serializadores genéricos, o cualquier abstracción donde el parámetro de tipo lo lleva el método y no el tipo, este es el cambio de .NET 11 que vale la pena medir en tu propio código. El [artículo completo](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) tiene el desensamblado.
