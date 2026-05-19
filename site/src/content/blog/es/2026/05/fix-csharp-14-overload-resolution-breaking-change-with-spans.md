---
title: "Solución: Cambio incompatible de resolución de sobrecargas en C# 14 con Span y ReadOnlySpan"
description: "Tras actualizar a C# 14 / .NET 10, llamadas como array.Contains, x.Reverse() y MemoryMarshal.Cast empiezan a enlazar a sobrecargas distintas o dejan de compilar. Esto es lo que cambió y cómo fijar el comportamiento anterior donde importa."
pubDate: 2026-05-19
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet-10"
  - "spans"
  - "breaking-changes"
lang: "es"
translationOf: "2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans"
translatedBy: "claude"
translationDate: 2026-05-19
---

Actualizas un proyecto a C# 14 (incluido en .NET 10, Roslyn 4.13, Visual Studio 17.13) y ocurre una de estas tres cosas: una `Expression<Func<int[], int, bool>>` que antes compilaba y se ejecutaba ahora lanza una excepción en tiempo de ejecución, una llamada a `MemoryMarshal.Cast(array)` deja de compilar con un error de ambigüedad, o una aserción `Assert.Equal([2], myArray)` de xUnit pasa de "exitosa" a "coincidencia ambigua entre sobrecargas de Assert.Equal". Todas son el mismo cambio incompatible. Los tipos span de primera clase de C# 14 hacen que `T[]` sea implícitamente convertible a `Span<T>` y `ReadOnlySpan<T>` durante la resolución de sobrecargas, la inferencia de tipos y el enlace de métodos de extensión, y eso invierte qué sobrecarga gana en código que antes era inequívoco.

Esta publicación recorre los cuatro escenarios con los que me he topado en actualizaciones reales a .NET 10, muestra la reproducción mínima para cada uno y da la solución recomendada. Todos los ejemplos asumen `<LangVersion>14.0</LangVersion>` y `<TargetFramework>net10.0</TargetFramework>` salvo que se indique lo contrario.

## Por qué C# 14 elige ahora sobrecargas distintas

En C# 13 y versiones anteriores, las conversiones implícitas definidas por el usuario de `T[]` a `Span<T>` y `ReadOnlySpan<T>` (declaradas en el runtime mediante `op_Implicit`) se trataban como definidas por la biblioteca, no por el lenguaje. El compilador no las consideraba durante la resolución de sobrecargas, la inferencia de tipos ni el enlace de métodos de extensión. Por eso, antes de .NET 10, había que escribir `myArray.AsSpan().BinarySearch(...)` cuando se quería la sobrecarga de span de un método que también tenía una sobrecarga de `IEnumerable<T>`. El compilador elegía silenciosamente la sobrecarga no-span porque no veía la conversión.

La propuesta de [tipos span de primera clase](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md) de C# 14 promueve esas conversiones al lenguaje. Concretamente, tras la actualización el compilador considera estas conversiones durante la resolución de sobrecargas:

- `T[]` a `Span<T>`
- `T[]` a `ReadOnlySpan<T>`
- `T[]` a `ReadOnlySpan<U>` cuando `T` es convertible por referencia a `U`
- `Span<T>` a `ReadOnlySpan<T>`
- `string` a `ReadOnlySpan<char>`

También añade reglas de desempate: cuando tanto una sobrecarga de `Span<T>` como una de `ReadOnlySpan<T>` son aplicables para el mismo argumento, se prefiere `ReadOnlySpan<T>`. La razón de esa preferencia aparece más adelante (arreglos covariantes), así que tenla presente.

El equipo de Roslyn documentó esto como un [cambio incompatible de comportamiento](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution) y otra entrada en la lista de [cambios incompatibles del compilador desde C# 13](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010). No hay un único código de error del compilador que se dispare con "esta resolución cambió". Algunos escenarios siguen compilando silenciosamente pero enlazan de forma distinta, otros ahora producen `CS0121` "la llamada es ambigua" y otros lanzan en tiempo de ejecución. Las soluciones dependen del caso.

## Caso 1: las expresiones lambda llaman ahora a `MemoryExtensions` en lugar de `Enumerable`

Este es el más desagradable porque compila bien y solo falla en tiempo de ejecución cuando el árbol de expresiones se interpreta en lugar de compilarse a IL.

```csharp
// C# 14, .NET 10
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;

Expression<Func<int[], int, bool>> e = (array, num) => array.Contains(num);
var fn = e.Compile(preferInterpretation: true);
fn(new[] { 1, 2, 3 }, 2); // throws at runtime
```

En C# 13, `array.Contains(num)` dentro del árbol de expresiones se enlazaba a `System.Linq.Enumerable.Contains<T>(IEnumerable<T>, T)`. En C# 14, el compilador ahora ve que `int[]` se convierte implícitamente a `ReadOnlySpan<int>`, por lo que la mejor sobrecarga es `System.MemoryExtensions.Contains<T>(ReadOnlySpan<T>, T)`. El árbol de expresiones se construye alrededor de `MemoryExtensions.Contains`. Cuando pides interpretación (`preferInterpretation: true`), el intérprete de expresiones LINQ no puede manejar parámetros `ReadOnlySpan<T>` en llamadas a métodos arbitrarios y lanza una `NotSupportedException` o, en algunos proveedores antiguos de EF Core que traducen el árbol, una `System.InvalidOperationException` sobre un método no soportado.

La solución es enlazar la sobrecarga no-span explícitamente dentro de la lambda. Hay tres modismos que funcionan:

```csharp
// .NET 10, C# 14
M((array, num) => ((IEnumerable<int>)array).Contains(num)); // cast forces Enumerable.Contains
M((array, num) => array.AsEnumerable().Contains(num));      // ditto, slightly less ugly
M((array, num) => Enumerable.Contains(array, num));         // explicit static call, no extension lookup

void M(Expression<Func<int[], int, bool>> e) => e.Compile(preferInterpretation: true);
```

Los tres fuerzan al compilador a enlazar `Enumerable.Contains` en lugar de `MemoryExtensions.Contains`. La versión con cast es la más barata en tiempo de ejecución (el árbol de expresiones solo contiene un nodo de cast) y es la que yo uso primero.

Si mantienes una biblioteca que construye árboles de expresiones por encargo, audita cualquier ruta de `IQueryable.Provider.Execute` y cualquier código que use `Compile(preferInterpretation: true)`. EF Core 9 y posteriores compilan a IL, así que la mayoría de consultas de EF Core no se ven afectadas, pero cualquier intérprete de expresiones de terceros sí lo está.

## Caso 2: Assert.Equal de xUnit se vuelve ambiguo

Si alguna vez has escrito esto en una prueba de xUnit, tienes una trampa esperando:

```csharp
// .NET 10, C# 14, xUnit 2.9+
var x = new long[] { 1 };
Assert.Equal([2], x);
// CS0121: The call is ambiguous between the following methods or properties:
// 'Assert.Equal<T>(T[], T[])' and 'Assert.Equal<T>(ReadOnlySpan<T>, Span<T>)'
```

Ambas sobrecargas son aplicables. La expresión de colección `[2]` puede tipar destino a `long[]` o a `Span<long>`. La variable `x` es `long[]`, que se convierte implícitamente tanto a `T[]` como a `Span<T>`. No existe una única mejor sobrecarga, así que obtienes `CS0121`.

La solución recomendada es desambiguar uno de los argumentos:

```csharp
// .NET 10, C# 14
var x = new long[] { 1 };
Assert.Equal([2], x.AsSpan());   // binds to (ReadOnlySpan<T>, Span<T>)
// or
Assert.Equal<long>([2], x);      // generic argument disambiguates to (T[], T[]) when no Span overload matches T
```

Una variante más sutil aparece cuando mezclas `T[]` y `ArraySegment<T>`:

```csharp
// .NET 10, C# 14
var y = new int[] { 1, 2 };
var s = new ArraySegment<int>(y, 1, 1);
Assert.Equal(y, s); // previously bound to Assert.Equal<T>(T, T), now ambiguous with Assert.Equal<T>(Span<T>, Span<T>)
Assert.Equal(y.AsSpan(), s); // workaround
```

`ArraySegment<int>` tiene una conversión implícita tanto a `Span<int>` como a `ReadOnlySpan<int>`, y ahora `int[]` también, por lo que la sobrecarga de span se vuelve aplicable y compite con la genérica `T, T`.

Si controlas la superficie de la API (escribiste `Assert.Equal`), la solución correcta es aplicar [`OverloadResolutionPriorityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute) a una de las sobrecargas para sesgar la resolución. xUnit lo incorporó en 2.9.x exactamente por este motivo. Si no puedes recompilar la API, tienes que desambiguar en el sitio de la llamada.

## Caso 3: los arreglos covariantes lanzan `ArrayTypeMismatchException`

Este es el bug que de verdad borra datos y la razón por la que el comité de lenguaje hizo que `ReadOnlySpan<T>` gane sobre `Span<T>` en los empates de C# 14.

```csharp
// .NET 10, C# 14
using System;
using System.Collections.Generic;
using System.Linq;

string[] s = new[] { "a" };
object[] o = s; // array variance: legal since C# 1

C.R(o);             // C# 13: prints 1 (IEnumerable overload). C# 14: ArrayTypeMismatchException
C.R(o.AsEnumerable()); // workaround

static class C
{
    public static void R<T>(IEnumerable<T> e) => Console.Write(1);
    public static void R<T>(Span<T> s)        => Console.Write(2);
}
```

Lo que pasa: `object[] o` es realmente un `string[]` por debajo. En C# 13, la única sobrecarga aplicable era `R<T>(IEnumerable<T>)`, así que imprimía `1`. En C# 14, `R<T>(Span<T>)` también es aplicable porque `T[]` ahora se convierte implícitamente a `Span<T>`. El compilador elige la sobrecarga de span (es "más específica"), inserta una llamada al constructor `Span<object>(o)` y el constructor lanza `System.ArrayTypeMismatchException` en tiempo de ejecución porque no se puede escribir un `object` en un `string[]` subyacente.

Por eso las reglas de desempate de C# 14 prefieren `ReadOnlySpan<T>` sobre `Span<T>`: un `ReadOnlySpan<T>` no puede escribir en el arreglo subyacente, así que es seguro con arreglos covariantes. La solución recomendada cuando controlas la API es añadir una sobrecarga de `ReadOnlySpan<T>`:

```csharp
// .NET 10, C# 14
static class C
{
    public static void R<T>(IEnumerable<T> e)    => Console.Write(1);
    public static void R<T>(Span<T> s)           => Console.Write(2);
    public static void R<T>(ReadOnlySpan<T> s)   => Console.Write(3); // wins over Span<T> in C# 14
}
```

Ahora `C.R(o)` imprime `3` (sin excepción). Cuando no puedes añadir una sobrecarga, la solución en el sitio de la llamada es `o.AsEnumerable()` o `((IEnumerable<object>)o)`.

## Caso 4: `MemoryMarshal.Cast` y el desempate de ReadOnlySpan

La preferencia por `ReadOnlySpan<T>` también rompe algunos patrones de biblioteca donde el autor pretendía que tú optaras por una sobrecarga pasando un `Span<T>`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

double[] x = new double[0];
Span<ulong> y = MemoryMarshal.Cast<double, ulong>(x);
// CS0029: Cannot implicitly convert type 'ReadOnlySpan<ulong>' to 'Span<ulong>'
Span<ulong> z = MemoryMarshal.Cast<double, ulong>(x.AsSpan()); // workaround
```

`MemoryMarshal.Cast` tiene tanto `Cast<TFrom, TTo>(Span<TFrom>)` como `Cast<TFrom, TTo>(ReadOnlySpan<TFrom>)`. En C# 13, pasar un `double[]` se resolvía mediante la conversión definida por el usuario a `Span<TFrom>` porque no había desempate y `Span<T>` era el objetivo "directo". En C# 14, ambas sobrecargas son aplicables a través de las nuevas conversiones integradas, la sobrecarga de `ReadOnlySpan<T>` gana el desempate y el resultado ya no es asignable a un local `Span<ulong>`. O llamas a `.AsSpan()` explícitamente para saltarte la conversión de arreglo a span (produce un `Span<double>` directamente, que solo coincide con la sobrecarga de `Span`) o cambias el tipo del local a `ReadOnlySpan<ulong>` si no necesitas mutabilidad.

## El caso raro de `Enumerable.Reverse` para destinos antiguos

Hay una trampa adicional que solo afecta a una configuración no soportada pero merece la pena señalar porque aparece en proyectos de migración legacy. Si pones `<LangVersion>14.0</LangVersion>` pero apuntas a un TFM antiguo como `net8.0` con una referencia a `System.Memory`, ocurre esto:

```csharp
// LangVersion 14, TargetFramework net8.0 (unsupported)
int[] x = new[] { 1, 2, 3 };
var y = x.Reverse(); // C# 13: Enumerable.Reverse, returns IEnumerable<int>
                     // C# 14: MemoryExtensions.Reverse, void in-place reverse
```

`MemoryExtensions.Reverse(Span<T>)` invierte en sitio y devuelve `void`, mientras que `Enumerable.Reverse(IEnumerable<T>)` devuelve la secuencia invertida. La semántica se invierte y `y` ya no es iterable. En `net10.0` esto está parcheado por una nueva sobrecarga `Enumerable.Reverse(this T[])` que toma precedencia, así que la ruptura solo aparece cuando mezclas compilador nuevo con BCL antiguo. La solución correcta es actualizar el TFM, pero si no puedes, llama a `Enumerable.Reverse(x)` explícitamente o define tu propia extensión `Reverse(this T[])` en tu namespace.

## Detectarlo antes del runtime

Algunas mitigaciones prácticas para una actualización en curso:

- Pon `<LangVersion>13.0</LangVersion>` en proyectos individuales mientras haces triage. Las características de C# 14 no relacionadas con spans (modificadores de parámetros de lambda, constructores parciales, palabra clave `field`) quedarán deshabilitadas, pero la resolución permanece predecible.
- Activa el analizador de Roslyn [CA1872](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1872) y la inspección de ReSharper/Rider ["C# 14 breaking change in overload resolution with span parameters"](https://www.jetbrains.com/help/resharper/CSharp14OverloadResolutionWithSpanBreakingChange.html). La inspección de Rider resalta específicamente los sitios de llamada donde las nuevas conversiones cambian qué sobrecarga se selecciona.
- Audita `Compile(preferInterpretation: true)` y cualquier consumidor externo de árboles de expresiones (por ejemplo, proveedores antiguos de EF6, Marten 6.x, Linq2DB previo a 5.x). Son los puntos de mayor riesgo porque el cambio es silencioso en tiempo de compilación.
- Busca `Assert.Equal(`, `Assert.Contains(` y aserciones similares de tipo colección en tu suite de pruebas. Actualiza xUnit a una versión con anotaciones de `OverloadResolutionPriorityAttribute` (xUnit 2.9.x o superior).

Si eres autor de una API, la solución más limpia a largo plazo es añadir sobrecargas de `ReadOnlySpan<T>` junto a cualquier sobrecarga de `Span<T>` existente y aplicar `[OverloadResolutionPriority(1)]` a la que quieres que enlacen los llamadores. El atributo lo respetan los compiladores de C# 13 y C# 14 (se ignora en configuraciones de `LangVersion` anteriores, esa es la única arruga), así que cubre la mayoría de escenarios de migración.

## Relacionado

Si quieres el contexto de por qué existen estas conversiones, el análisis profundo sobre [conversiones implícitas de Span en C# 14 y soporte de primera clase para Span y ReadOnlySpan](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cubre la tabla completa de conversiones y la motivación. La publicación más amplia [novedades de C# 14](/es/2024/12/csharp-14/) lista los demás cambios incompatibles que cabe esperar en la misma actualización, incluidos el modificador de parámetros de lambda `scoped` y la palabra clave contextual `field`. Para un avance del próximo lenguaje, [argumentos de expresión de colección en C# 15](/es/2026/04/csharp-15-collection-expression-arguments/) se construye sobre estas reglas de span y vale la pena leerlo una vez te sientas cómodo con cómo el compilador elige entre destinos span y no-span.

## Fuentes

- [Breaking change: C# 14 overload resolution with span parameters (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [C# compiler breaking changes since C# 13 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010)
- [First-class span types proposal (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [Issue dotnet/docs#43952: covariant array overload selection](https://github.com/dotnet/docs/issues/43952)
- [OverloadResolutionPriorityAttribute (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [Rider inspection: C# 14 overload resolution with span parameters (JetBrains)](https://www.jetbrains.com/help/rider/CSharp14OverloadResolutionWithSpanBreakingChange.html)
