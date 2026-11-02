---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> en C#: cuándo usar cada uno"
description: "Elige List<T> para colecciones ampliables, Span<T> para vistas modificables y ReadOnlySpan<T> para lectura. Límites de vida útil y async."
pubDate: 2026-05-25
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "es"
translationOf: "2026/05/list-vs-span-vs-readonlyspan-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-25
---

`List<T>` administra una colección ampliable. `Span<T>` es una vista de longitud fija sobre memoria contigua; `ReadOnlySpan<T>` impide escribir a través de esa vista. Una vista no sustituye la propiedad ni la gestión de vida útil del búfer.

**Corrección — 2 de noviembre de 2026:** se eliminaron cifras de benchmark de .NET 11 sin verificar y se corrigieron las afirmaciones sobre retornos, campos y versiones. Los ejemplos se comprobaron con SDK 10.0.302 y C# 14. No se afirma una mejora universal de velocidad.

## Elegir por propiedad y duración

| Necesidad | Punto de partida |
| --- | --- |
| Agregar elementos a una colección | `List<T>` |
| Leer o modificar una región contigua de forma síncrona | `Span<T>` |
| Leer sin escribir a través de la vista | `ReadOnlySpan<T>` |
| Conservar una vista en una clase o a través de `await` | `Memory<T>` / `ReadOnlyMemory<T>` |

Un span no es propietario del búfer. Puede devolverse un span respaldado por un array si la vida útil del almacenamiento es válida; no puede devolverse uno sobre un `stackalloc` local. Un span puede ser campo de otro `ref struct`, pero no de una clase o struct ordinarios. No admite boxing ni captura en lambdas.

Desde C# 13 se permiten variables ref-struct locales en métodos async si no siguen activas a través de un `await`. Usa Memory para ese límite. Una vista de solo lectura no vuelve inmutable el búfer: otro alias puede modificarlo.

## Modificar sin copiar

```csharp
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

var values = new List<int> { 3, 9, 4 };
Span<int> view = CollectionsMarshal.AsSpan(values);
view[1] = 20;
Console.WriteLine(values[1]); // 20

int[] array = { 10, 20, 30 };
Span<int> tail = Tail(array);
tail[0] = 99;
Console.WriteLine(array[1]); // 99

static Span<int> Tail(int[] source) => source.AsSpan(1);
```

Ambas vistas comparten el almacenamiento original. `Tail` devuelve un span válido sobre un array, no un búfer local de pila. Mientras uses la vista de `CollectionsMarshal.AsSpan`, no agregues ni elimines elementos de la lista, aunque no cambie la capacidad del array interno. Prefiere la API normal de la lista salvo que una necesidad medida justifique este acceso.

## Entrada de solo lectura

```csharp
using System;

ReadOnlySpan<char> text = "2026-05-25".AsSpan(0, 4);
ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(int.Parse(text)); // 2026
Console.WriteLine(method.Length);   // 3
```

Los strings proporcionan `ReadOnlySpan<char>`; los literales UTF-8, `ReadOnlySpan<byte>`. Un span modificable se convierte en uno de solo lectura, pero no al revés. Usa el parámetro de solo lectura cuando no necesites modificar elementos.

C# 14 llegó con .NET 10. Las conversiones implícitas básicas de arrays a spans ya existían; C# 14 amplía su integración en inferencia genérica y receptores de métodos de extensión. `allows ref struct`, de C# 13, solo permite esos argumentos genéricos cuando la API los admite expresamente. No hace válido `List<Span<int>>`.

## Medir el trabajo concreto

Los segmentos de spans pueden evitar copias o asignaciones de substrings. No garantizan que todos los bucles superen a una lista: influyen JIT, runtime, tamaño y operación. Crear un string, array o lista todavía puede asignar memoria. Publica tiempos únicamente con el código, configuración y resultados completos del benchmark.

Para búferes async, consulta [convertir un array a ReadOnlyMemory](/es/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/). Para procesamiento y búferes temporales, [cuándo puede mejorar el rendimiento un span](/es/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

## Fuentes

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
