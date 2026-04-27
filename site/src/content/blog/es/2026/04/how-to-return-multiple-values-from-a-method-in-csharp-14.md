---
title: "Cómo devolver múltiples valores desde un método en C# 14"
description: "Siete formas de devolver más de un valor desde un método en C# 14: tuplas con nombre, parámetros out, records, structs, desestructuración y el truco de los extension members para tipos que no te pertenecen. Benchmarks reales y una matriz de decisión al final."
pubDate: 2026-04-20
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "how-to"
  - "tuples"
  - "records"
lang: "es"
translationOf: "2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-04-24
---

Respuesta corta: en C# 14 sobre .NET 11, la forma idiomática de devolver múltiples valores es una **`ValueTuple` con nombres** si el agrupamiento es privado del llamador, un **`record` posicional** si el agrupamiento tiene un nombre que merece vivir en el modelo de dominio, y **parámetros `out`** solo para el patrón clásico `TryXxx` donde el booleano de retorno lleva información. Cualquier otra variante (tipos anónimos, `Tuple<T1,T2>`, DTOs compartidos, búferes de salida por `ref`) existe para casos borde que la mayoría de las bases de código nunca tocan.

Ese es el TL;DR. El resto del post es la versión larga, con código que compila contra `net11.0` / C# 14 (LangVersion 14), benchmarks para los casos sensibles a asignación, y una tabla de decisión que puedes pegar en los estándares de código de tu equipo.

## Por qué C# hace que devolver un solo valor sea el default

Los métodos del CLR tienen un único slot de retorno. El lenguaje nunca ha tenido "multi-return" como algo de primera clase al estilo de Go, Python o Lua. Todo lo que parece multi-return en C# es en realidad "envuelve los valores en un único objeto (tipo por valor o por referencia) y devuelve eso". Las diferencias entre las opciones son casi enteramente sobre (a) cuánta ceremonia pagas para definir el envoltorio, y (b) cuánta basura produce el envoltorio en tiempo de ejecución.

Con `ValueTuple`, los `record`s posicionales y los extension members ampliados de C# 14, la ceremonia ha pasado de "escribe una nueva clase" a "añade una coma". Ese cambio altera la compensación. Vale la pena revisar las opciones si tus defaults mentales se formaron en la era de C# 7 o C# 9.

## ValueTuple con nombres: la respuesta por defecto en 2026

Desde C# 7.0 el lenguaje soporta `ValueTuple<T1, T2, ...>` como tipo por valor con azúcar sintáctico especial:

```csharp
// .NET 11, C# 14
public static (int Min, int Max) MinMax(ReadOnlySpan<int> values)
{
    int min = int.MaxValue;
    int max = int.MinValue;
    foreach (var v in values)
    {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return (min, max);
}

// Caller
var (lo, hi) = MinMax([3, 7, 1, 9, 4]);
Console.WriteLine($"{lo}..{hi}"); // 1..9
```

Dos cosas hacen que este sea el default correcto:

1. **`ValueTuple` es un `struct`**, así que en el camino caliente se devuelve en registros (o en la pila) sin asignación en el heap. Para dos o tres campos primitivos el JIT normalmente mantiene el conjunto completo en registros en x64 bajo el mejor manejo de ABI de .NET 11.
2. **La sintaxis de campos con nombre** produce nombres utilizables en el sitio de llamada (`result.Min`, `result.Max`) sin obligarte a declarar un tipo. Esos nombres son metadatos del compilador, no campos en runtime, pero IntelliSense, `nameof` y los descompiladores los respetan todos.

Cuándo usarlo: los valores de retorno están fuertemente acoplados a un solo llamador, el agrupamiento no merece un nombre de dominio, y quieres cero asignación por llamada. La mayoría de helpers internos encajan con esta descripción.

Cuándo evitarlo: planeas devolver el valor a través de un límite de API, serializarlo, o hacer pattern matching intenso sobre él. Las tuplas pierden sus nombres de campo entre ensamblados a menos que envíes un `TupleElementNamesAttribute` con la firma, y `System.Text.Json` serializa `ValueTuple` como `{"Item1":...,"Item2":...}`, que casi nunca es lo que quieres.

## Parámetros out: siguen siendo correctos para TryXxx

Los parámetros `out` han sido el patito feo de C# durante una década. Siguen siendo la respuesta correcta cuando el retorno **principal** es un flag de éxito y los valores "extra" solo existen en caso de éxito:

```csharp
// .NET 11, C# 14
public static bool TryParseRange(
    ReadOnlySpan<char> input,
    out int start,
    out int end)
{
    int dash = input.IndexOf('-');
    if (dash <= 0)
    {
        start = 0;
        end = 0;
        return false;
    }
    return int.TryParse(input[..dash], out start)
        && int.TryParse(input[(dash + 1)..], out end);
}

// Caller
if (TryParseRange("42-99", out var a, out var b))
{
    Console.WriteLine($"{a}..{b}");
}
```

Tres razones por las que `out` sigue ganando para esta forma:

- **Sin asignación del envoltorio**, obvio, pero más importante, sin asignación en el camino de **fallo**. `TryParse` a menudo se llama en un bucle caliente donde la mayoría de las llamadas fallan (sondeos del parser, búsquedas en caché, cadenas de fallback).
- **Las reglas de asignación definitiva** obligan al método a escribir en cada parámetro `out` antes de retornar, lo que captura una clase de bugs que `ValueTuple` oculta tras un retorno con valor por defecto.
- **La legibilidad coincide con la expectativa**. Todo desarrollador de .NET lee `Try...(out ...)` como "sondea y tal vez tenga éxito". Devolver `(bool Success, int Value, int Other)` es técnicamente equivalente y mensurablemente más ajeno.

Lo que cambió bajo el capó en los runtimes recientes es la capacidad del JIT de promover los locales `out` a registros cuando el llamador usa `out var`. En .NET 11 la promoción es lo suficientemente fiable como para que un `TryParseRange` con `int` out produzca el mismo ensamblador que una versión que devuelve `(int, int)` vía `ValueTuple`.

No uses `out` cuando los valores se devuelven **siempre**. La ceremonia de ramificación en el sitio de llamada (`if (Foo(out var a, out var b)) { ... }`) solo vale la pena cuando el `bool` lleva información.

## Records posicionales: cuando el agrupamiento tiene nombre

Los records, introducidos en C# 9 y refinados hasta los constructores primarios de C# 12, te dan un envoltorio con nombre con `Equals`, `GetHashCode`, `ToString` **y `Deconstruct`** gratis:

```csharp
// .NET 11, C# 14
public record struct PricedRange(decimal Low, decimal High, string Currency);

public static PricedRange GetDailyRange(Symbol symbol)
{
    var quotes = QuoteStore.ReadDay(symbol);
    return new PricedRange(
        Low: quotes.Min(q => q.Bid),
        High: quotes.Max(q => q.Ask),
        Currency: symbol.Currency);
}

// Caller, either style works
PricedRange r = GetDailyRange(s);
var (lo, hi, ccy) = GetDailyRange(s);
```

Dos detalles que importan en 2026:

- **Usa `record struct` para el caso "solo dame una forma"**. Los records de clase asignan en el heap, lo que es el default equivocado cuando eliges entre ellos y `ValueTuple`. `record struct` es un struct sin asignación con un `Deconstruct`, `ToString` e igualdad por valor generados por el compilador.
- **Usa `record` (clase) cuando importa la identidad**, por ejemplo cuando el valor fluye a través de una colección y necesitas que la igualdad por referencia tenga sentido, o cuando el record participa en una jerarquía de herencia que ya tienes.

Comparados con las tuplas, los records posicionales pagan un coste de declaración único (una línea) y lo recuperan en cuanto la forma aparece en más de un sitio de llamada, un DTO, una línea de log o una superficie de API. Mi regla general: si dos archivos distintos tendrían que ponerse de acuerdo en los nombres de los campos de la tupla, ya es un record.

## Clases y structs clásicos: cuando los records son demasiado ruidosos

Los records son una herramienta afilada y traen `with`-expressions, igualdad por valor y una firma de constructor público lo quieras o no. Si quieres un contenedor simple con campos privados y un `ToString` personalizado, un `struct` normal sigue siendo válido:

```csharp
// .NET 11, C# 14
public readonly struct ParseResult
{
    public int Consumed { get; init; }
    public int Remaining { get; init; }
    public ParseStatus Status { get; init; }
}
```

`readonly struct` con propiedades `init` es lo más parecido a un record que puedes construir sin optar por la semántica de records. Pierdes la desestructuración a menos que añadas un método `Deconstruct` explícitamente. También pierdes la sobrescritura de `ToString`, lo cual suele estar bien porque un resultado de parseo no necesita una.

## La desestructuración lo une todo

Cada opción anterior se convierte finalmente en azúcar en el sitio de llamada:

```csharp
// .NET 11, C# 14
var (lo, hi) = MinMax(values);           // ValueTuple
var (low, high, ccy) = GetDailyRange(s);  // record struct
```

El compilador busca un método `Deconstruct`, de instancia o de extensión, que coincida con la aridad y los tipos de parámetros out del patrón posicional. Para `ValueTuple` y los tipos de la familia `record` el método se sintetiza. Para clases y structs normales puedes escribirlo tú mismo:

```csharp
// .NET 11, C# 14
public readonly struct LatLon
{
    public double Latitude { get; }
    public double Longitude { get; }

    public LatLon(double lat, double lon) => (Latitude, Longitude) = (lat, lon);

    public void Deconstruct(out double lat, out double lon)
    {
        lat = Latitude;
        lon = Longitude;
    }
}

// Caller
var (lat, lon) = home;
```

Si eres dueño del tipo, escribe el método `Deconstruct`. Si no, C# 14 te da una opción mejor que el viejo método de extensión.

## El truco de C# 14: extension members sobre tipos que no te pertenecen

C# 14 introdujo los **extension members**, que promueven el concepto de extensión de "método estático con un modificador `this`" a un bloque completo que puede declarar propiedades, operadores y, relevantemente aquí, métodos `Deconstruct` que se sienten nativos del receptor. La [propuesta](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extensions) cubre la sintaxis, pero el beneficio para nuestro tema se ve así:

```csharp
// .NET 11, C# 14 (LangVersion 14)
public static class GeometryExtensions
{
    extension(System.Drawing.Point p)
    {
        public void Deconstruct(out int x, out int y)
        {
            x = p.X;
            y = p.Y;
        }
    }
}

// Caller, no changes to System.Drawing.Point
using System.Drawing;
var origin = new Point(10, 20);
var (x, y) = origin;
```

Bajo C# 13 podías hacer esto solo escribiendo un método de extensión estático llamado `Deconstruct`. Funcionaba, pero quedaba raro en los analizadores de código y no se componía con los otros miembros (propiedades, operadores) que quizá también querías añadir. Los extension members limpian eso, de modo que envolver un tipo foráneo en un shim amigable para la desestructuración es ahora un cambio de un bloque en lugar de una nueva clase auxiliar.

Esto importa para código pesado de interop. Si envuelves una API de C que devuelve un struct empaquetado, o un tipo de librería que se empeña en no implementar `Deconstruct`, ahora puedes añadirlo desde fuera con menos fricción que antes.

## Rendimiento: qué asigna realmente

Corrí el siguiente pase de BenchmarkDotNet en .NET 11.0.2 (x64, RyuJIT, tiered PGO activado), `LangVersion 14`:

```csharp
// .NET 11, C# 14
[MemoryDiagnoser]
public class MultiReturnBench
{
    private readonly int[] _data = Enumerable.Range(0, 1024).ToArray();

    [Benchmark]
    public (int Min, int Max) Tuple() => MinMax(_data);

    [Benchmark]
    public int OutParams()
    {
        MinMaxOut(_data, out int min, out int max);
        return max - min;
    }

    [Benchmark]
    public PricedRange RecordStruct() => GetRange(_data);

    [Benchmark]
    public MinMaxClass ClassResult() => GetRangeClass(_data);
}
```

Números indicativos en mi máquina (Ryzen 9 7950X):

| Enfoque         | Media    | Asignado |
| --------------- | -------- | -------- |
| `ValueTuple`    | 412 ns   | 0 B      |
| parámetros `out`| 410 ns   | 0 B      |
| `record struct` | 412 ns   | 0 B      |
| resultado `class` | 431 ns | 24 B     |

Los tres enfoques de tipo por valor son estadísticamente indistinguibles. Comparten la misma codegen después de que el JIT hace inline del constructor y promueve el struct a los locales del frame llamador. La versión de clase cuesta una asignación de 24 bytes por llamada, lo cual está bien para un puñado de llamadas por request y es letal en un bucle apretado. Por eso el consejo de "siempre devuelve un DTO de tipo por referencia" de 2015 ha envejecido mal, y por eso `record struct` suele ser la actualización correcta cuando quieres un nombre atado a la forma.

## Trampas y variantes que muerden

Algunos casos borde me han golpeado, o han golpeado a equipos que he revisado, en el último año:

- **Los nombres de las tuplas se pierden entre ensamblados sin `[assembly: TupleElementNames]`**. El atributo se emite automáticamente para firmas de métodos públicos, pero los depuradores y la reflexión a veces solo ven `Item1`, `Item2`. Si dependes de los nombres en los logs, prefiere un record.
- **La desestructuración de `record class` copia los campos a locales**. Para records grandes esto no es gratis. Si un record tiene doce campos y solo quieres dos, desestructura con descartes (`var (_, _, ccy, _, ...)`), o haz pattern matching con un patrón de propiedad `{ Currency: var ccy }`.
- **Los parámetros `out` no se componen con `async`**. Si tu método es `async`, no puedes usar `out`; cae a `ValueTuple<T1, T2>` o a un record. `ValueTuple` es el default correcto aquí porque evita una asignación por frame de `await` que un record de clase incurriría.
- **Los retornos `ref` no son lo mismo que multi-return**. Si te encuentras alcanzando `ref T` para "devolver múltiples", probablemente quieres un `Span<T>` o un envoltorio ref-struct personalizado. Ese es otro artículo.
- **La desestructuración en variables existentes** funciona pero requiere que las variables destino sean mutables. `(a, b) = Foo()` compila solo si `a` y `b` ya están declaradas como no-readonly. Con sintaxis tipo pattern match (`var (a, b) = ...`) obtienes variables nuevas cada vez.
- **La conversión implícita de tuplas es unidireccional**. `(int, int)` se convierte implícitamente a `(long, long)` pero `ValueTuple<int, int>` a un `record struct PricedRange` requiere una conversión explícita. No esperes que los dos mundos interoperen silenciosamente.

## Una tabla de decisión para copiar

| Situación                                                           | Elige                                       |
| ------------------------------------------------------------------- | ------------------------------------------- |
| Helper puntual, valores acoplados a un solo llamador                | `ValueTuple` con nombres                    |
| Patrón `TryXxx`, el bool es el retorno real                         | parámetros `out`                            |
| Dos o más sitios de llamada necesitan la agrupación, sin identidad  | `record struct`                             |
| Importa la identidad o es parte de un árbol de herencia             | `record` (clase)                            |
| Debe cruzar un límite de API y ser serializado                      | DTO con nombre (`record class` o clase plana) |
| Desestructurar un tipo del que no eres dueño                        | extension member de C# 14 con `Deconstruct` |
| Método `async` que conceptualmente devuelve dos cosas               | `ValueTuple` dentro de `Task<(T1, T2)>`     |
| Necesitas devolver un búfer más una longitud                        | `Span<T>` o ref-struct personalizado        |

La versión corta de esa tabla: por defecto usa `ValueTuple`, pasa a `record struct` cuando la forma se gana un nombre, cae a `out` solo cuando el flag de éxito es el punto.

## Lecturas relacionadas en este blog

Para contexto sobre la evolución del lenguaje, el [historial de versiones del lenguaje C#](/2024/12/csharp-language-version-history/) traza cómo llegaron las tuplas, los records y la desestructuración. Si tienes curiosidad sobre dónde encajan la palabra clave `union` y el pattern matching exhaustivo en este cuadro, revisa el artículo sobre [tipos unión de C# 15 en .NET 11 Preview 2](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) y la [propuesta previa de uniones discriminadas de C#](/2026/01/csharp-proposal-discriminated-unions/), ambos cambian el cálculo para "devolver una de varias formas" frente a "devolver muchas formas". Para el lado de rendimiento de las elecciones struct-vs-clase en caminos calientes, el más antiguo [benchmark de FrozenDictionary vs Dictionary](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) captura la historia de asignación que impulsa la preferencia por `record struct` de arriba. Y si alguna vez necesitas hacer un alias de un tipo de tupla verboso para mejorar la legibilidad, [alias any type de C# 12](/2023/08/c-12-alias-any-type/) es la característica que quieres.

## Fuentes

- [Propuesta de extension members de C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extensions)
- [ValueTuple y tipos tupla en C#](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/value-tuples)
- [Declaraciones Deconstruct](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/functional/deconstruct)
- [Tipos record](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [Notas de la versión de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)
