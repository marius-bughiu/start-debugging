---
title: "¿Qué es Span<T> en C# y cuándo hace realmente más rápido tu código?"
description: "Span<T> puede evitar copias y asignaciones temporales al analizar o formatear memoria contigua. Conoce sus límites de vida útil y qué medir."
pubDate: 2026-06-20
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "es"
translationOf: "2026/06/what-is-span-and-when-does-it-make-my-code-faster"
translatedBy: "claude"
translationDate: 2026-06-20
---

`Span<T>` es una vista de longitud fija sobre memoria contigua: arrays, memoria de pila o memoria no administrada cuya duración se gestione correctamente. `ReadOnlySpan<T>` permite solo lectura mediante la vista. Los strings ofrecen `ReadOnlySpan<char>`, no un `Span<char>` modificable.

Crear la vista no crea ni transfiere la propiedad del almacenamiento. Eso no vuelve toda la operación libre de asignaciones ni garantiza que sea más rápida.

**Corrección — 2 de noviembre de 2026:** se retiraron tiempos sin verificar y una promesa universal de aceleración. Se corrigieron el tipo del literal UTF-8, los límites del retorno y las asignaciones. Los ejemplos se comprobaron con SDK 10.0.302 y C# 14, sin benchmark de rendimiento.

## Evitar substrings temporales

Los parsers que aceptan spans pueden evitar strings intermedios. Este ejemplo analiza un formato exacto sin crear substrings para año, mes y día:

```csharp
using System;
using System.Globalization;

string input = "2026-06-01";
DateOnly date = ParseIsoDate(input.AsSpan());
Console.WriteLine(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

static DateOnly ParseIsoDate(ReadOnlySpan<char> input) =>
    DateOnly.ParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture);
```

`ParseExact` valida la fecha y lanza una excepción ante datos inválidos. Usa `TryParseExact` si ese caso es esperado. Llamadas aisladas a `int.Parse(input.Slice(...))` no validan por sí solas separadores ni fechas del calendario.

## Usar un búfer temporal acotado

```csharp
using System;
using System.Globalization;

Span<char> scratch = stackalloc char[32];
if (12345.TryFormat(scratch, out int written, provider: CultureInfo.InvariantCulture))
{
    ReadOnlySpan<char> formatted = scratch[..written];
    Console.Out.WriteLine(formatted); // 12345
    string owned = new string(formatted); // Allocates the resulting string.
    Console.WriteLine(owned);
}

ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(method.SequenceEqual(new byte[] { 71, 69, 84 })); // True
```

El búfer evita un array temporal de caracteres. Crear el `string` final sigue asignando memoria. El array de bytes de la comparación también asigna memoria: muestra los valores, no un benchmark. `"GET"u8` tiene tipo `ReadOnlySpan<byte>`.

Mantén `stackalloc` pequeño y acotado. Asignaciones grandes o repetidas dentro de bucles pueden agotar la pila. No uses un tamaño sin comprobar procedente de una petición; para datos mayores usa arrays o búferes de pool con gestión correcta.

## Almacenamiento compartido y duración

Crear un segmento no copia elementos. Puede devolverse un span sobre un array si su almacenamiento sigue siendo válido; uno sobre un búfer local de pila no puede escapar del método. Se permiten campos Span en otro `ref struct`, no en clases o structs ordinarios. Desde C# 13 pueden existir variables ref-struct en métodos async mientras no crucen un `await`; para cruzarlo usa `Memory<T>`.

`ReadOnlySpan<T>` no congela el búfer. Mientras uses `CollectionsMarshal.AsSpan(list)`, no agregues ni elimines elementos, aunque quede capacidad disponible.

## Medir una mejora concreta

Busca una copia o asignación eliminable: substrings, segmentos copiados o arrays de formateo temporales. Un bucle normal sobre arrays o listas puede estar bien optimizado. La eliminación de comprobaciones y el rendimiento dependen del runtime y la carga; no existe un multiplicador fijo fiable.

Mide trabajo equivalente en Release con el runtime desplegado y datos representativos. Excluye la preparación, incluye asignaciones y conserva código y salida del benchmark. Este artículo no presenta nuevos tiempos medidos.

Las conversiones implícitas básicas de arrays a spans son anteriores a C# 14. C# 14 llegó con .NET 10 y amplió su integración en el lenguaje. `allows ref struct`, de C# 13, solo habilita APIs genéricas preparadas expresamente.

Para elegir el modelo de propiedad, consulta [List, Span y ReadOnlySpan](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). Para almacenamiento async, [ReadOnlyMemory desde un array](/es/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/).

## Fuentes

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
