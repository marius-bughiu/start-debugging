---
title: "Cómo recorrer dos colecciones en paralelo sin asignaciones en el heap en C#"
description: "Enumerable.Zip asigna entre 144 y 208 bytes por llamada y es unas 10 veces más lento que un bucle simple. Para arrays y listas, un bucle for sobre dos spans recortados a la misma longitud no asigna nada y es la opción más rápida; si quieres la sintaxis de foreach, un pequeño enumerador zip ref struct queda a menos del 25% de distancia. Medido en .NET 10.0.10 y .NET 11 RC 3."
pubDate: 2026-10-27
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "linq"
  - "memory"
lang: "es"
translationOf: "2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Respuesta corta:** si ambas fuentes son arrays, listas o cualquier cosa de la que puedas obtener un `ReadOnlySpan<T>`, toma la longitud más corta, recorta ambos spans a ella y ejecuta un solo bucle `for` con un único índice. Eso no asigna nada y es la forma más rápida que conoce el JIT. Si quieres la sintaxis `foreach (var (x, y) in ...)` sin pagar el costo, escribe un enumerador zip `ref struct` de 20 líneas que compruebe ambas longitudes en `MoveNext`. Si las fuentes no son indexables (un `HashSet<T>`, un `Dictionary<TKey, TValue>`), maneja sus enumeradores struct a mano con dos llamadas a `GetEnumerator()` sobre los tipos concretos. Evita `Enumerable.Zip` en rutas críticas: en .NET 10.0.10 y .NET 11 RC 3 asigna de 144 a 208 bytes por llamada y, en el benchmark de abajo, fue unas 10 veces más lento que el bucle simple.

Todo lo de este artículo se midió con C# 14 sobre .NET 10.0.10 (SDK 10.0.302) y .NET 11.0.0-rc.3.26522.148 en un Apple M4. Las cifras de asignación fueron idénticas en ambos runtimes.

## De dónde salen los bytes de Enumerable.Zip

`Enumerable.Zip` es la respuesta obvia a "recorrer dos secuencias juntas", y desde .NET Core 3.0 tiene una sobrecarga que devuelve tuplas, así que el código se lee bien:

```csharp
// .NET 10, C# 14
long sum = 0;
foreach (var (x, y) in first.Zip(second))
    sum += (long)x * y;
```

El problema es que cada pieza de esa canalización es un tipo por referencia detrás de una interfaz. `Zip` recibe dos parámetros `IEnumerable<T>`, así que llama a `GetEnumerator()` a través de la interfaz en cada fuente. Para un `List<T>` eso hace boxing de su struct `List<T>.Enumerator`; para un array asigna un objeto enumerador de array. Después, `Zip` devuelve a su vez un objeto iterador que contiene ambos. Tu `foreach` habla con ese iterador a través de `IEnumerator<(T1, T2)>`, así que cada `MoveNext` y cada `Current` es una llamada de interfaz que el JIT normalmente no puede insertar en línea.

Medí las asignaciones en estado estable con `GC.GetAllocatedBytesForCurrentThread()` después de dejar que cada método subiera a Tier 1 con PGO dinámico, usando dos fuentes `int` de 1 000 elementos:

| Enfoque | Asignado por llamada (.NET 10.0.10 y 11 RC 3) |
|---|---|
| Bucle `for` con un índice sobre arrays | 0 B |
| Bucle `for` sobre dos `ReadOnlySpan<int>` recortados | 0 B |
| `CollectionsMarshal.AsSpan` sobre dos `List<int>` | 0 B |
| Enumerador zip `ref struct` con `foreach` | 0 B |
| Dos `List<int>.Enumerator` manejados a mano | 0 B |
| Dos `IEnumerator<int>`, fuentes tipadas como `IEnumerable<int>` sobre arrays | 64 B |
| Dos `IEnumerator<int>`, fuentes tipadas como `IEnumerable<int>` sobre listas | 80 B |
| Sobrecarga de tuplas de `Enumerable.Zip`, arrays | 144 B |
| `Enumerable.Zip` con un selector de resultado estático, arrays | 160 B |
| Sobrecarga de tuplas de `Enumerable.Zip`, listas | 160 B |
| `Enumerable.Zip` con tres fuentes, arrays | 208 B |

El costo es por llamada, no por elemento, así que no importa en un bucle que ejecutas una vez al arrancar. Importa cuando el bucle en paralelo está dentro de un manejador de solicitudes, un tick de un juego, un parser o cualquier otra cosa que se ejecute millones de veces. Unos cientos de bytes por llamada, multiplicados por la tasa de llamadas, son exactamente la rotación de Gen0 que aparece en una traza.

Fíjate en que la lambda estática de la sobrecarga con selector no ayudó: el delegado se almacena en caché, pero el iterador y los dos enumeradores se siguen asignando.

## La versión más rápida: un índice, dos spans recortados

Cuando ambas fuentes son memoria contigua, no necesitas enumeradores en absoluto. Un solo índice recorre las dos:

```csharp
// .NET 10, C# 14
static long DotProduct(ReadOnlySpan<int> a, ReadOnlySpan<int> b)
{
    int n = Math.Min(a.Length, b.Length);
    a = a[..n];
    b = b[..n];

    long sum = 0;
    for (int i = 0; i < a.Length; i++)
        sum += (long)a[i] * b[i];
    return sum;
}

int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];
long total = DotProduct(prices, quantities); // 100
```

El recorte no es decoración. La condición del bucle es `i < a.Length`, lo que permite al JIT eliminar la comprobación de límites en `a[i]`. Después de `b = b[..n]` con el mismo `n`, el JIT también sabe que `b.Length == a.Length`, así que puede eliminar la comprobación en `b[i]` también. Sin el recorte, `b[i]` conserva una comprobación de límites en cada iteración, porque nada en el bucle demuestra que `b` sea al menos tan largo como `a`. Es la misma regla de "haz que la longitud sea el límite del bucle" que expliqué en [qué es Span<T> y cuándo hace realmente más rápido el código](/es/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

Los arrays se convierten implícitamente en `ReadOnlySpan<T>`, así que los puntos de llamada quedan limpios. Para `List<T>`, toma el span sobre su array subyacente con `CollectionsMarshal.AsSpan`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

List<int> prices = [10, 20, 30];
List<int> quantities = [3, 2, 1];

long total = DotProduct(
    CollectionsMarshal.AsSpan(prices),
    CollectionsMarshal.AsSpan(quantities));
```

`CollectionsMarshal.AsSpan` es gratis: devuelve un span sobre el array interno de la lista, limitado a `Count`. La trampa es que el span ya no sabe nada de la lista. Si haces `Add` a la lista mientras tienes el span y la lista crece, el span sigue apuntando al array antiguo y leerás datos obsoletos sin ninguna excepción. No cambies el tamaño de la lista mientras el span esté vivo. La comparación [List<T> vs Span<T> vs ReadOnlySpan<T>](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) entra en el resto de ese compromiso.

Para escribir en una de las secuencias mientras lees la otra, haz que el destino sea un `Span<T>` en lugar de un `ReadOnlySpan<T>`. El patrón no cambia.

## Mantener la sintaxis de foreach con un enumerador zip ref struct

El bucle con índice es rápido pero no es bonito, y cuando el cuerpo tiene más de una línea, `a[i]` y `b[i]` se vuelven ruidosos. El `foreach` de C# se basa en patrones: no requiere `IEnumerable<T>`, solo un método `GetEnumerator()` que devuelva algo con `MoveNext()` y `Current`. Ese algo puede ser un `ref struct`, lo que significa que puede contener spans y que nunca puede sufrir boxing:

```csharp
// .NET 10, C# 14
public ref struct SpanZip<T1, T2>
{
    private readonly ReadOnlySpan<T1> _first;
    private readonly ReadOnlySpan<T2> _second;
    private int _index;

    public SpanZip(ReadOnlySpan<T1> first, ReadOnlySpan<T2> second)
    {
        _first = first;
        _second = second;
        _index = -1;
    }

    public SpanZip<T1, T2> GetEnumerator() => this;

    public bool MoveNext()
    {
        int i = _index + 1;
        if ((uint)i < (uint)_first.Length && (uint)i < (uint)_second.Length)
        {
            _index = i;
            return true;
        }
        return false;
    }

    public (T1 First, T2 Second) Current => (_first[_index], _second[_index]);
}

public static class SpanZipExtensions
{
    public static SpanZip<T1, T2> ZipSpan<T1, T2>(
        this ReadOnlySpan<T1> first, ReadOnlySpan<T2> second) => new(first, second);
}
```

El uso se lee como LINQ:

```csharp
// .NET 10, C# 14
int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];

long total = 0;
foreach (var (price, quantity) in prices.ZipSpan(quantities))
    total += (long)price * quantity;
```

La tupla devuelta es un `ValueTuple`, un struct, así que deconstruirla no cuesta nada en el heap. Llamar a un método de extensión de `ReadOnlySpan<T>` directamente sobre un `int[]`, con los argumentos de tipo inferidos, depende de las conversiones de span de primera clase de C# 14; en C# 13 escribirías primero `prices.AsSpan()`. Con un `List<T>`, llámalo sobre `CollectionsMarshal.AsSpan(list)`.

La forma de `MoveNext` importa más de lo que parece. Mi primera versión recortaba ambos spans a la longitud común en el constructor y solo comparaba `_index` con `_first.Length` en `MoveNext`. Era correcto, pero costaba casi exactamente 2 veces lo que el bucle simple. Comprobar ambas longitudes en `MoveNext` lo bajó a 1.23 veces. Mi interpretación del resultado es que, una vez que `MoveNext` y `Current` se insertan en línea, el JIT ve ambas comparaciones justo antes de las dos llamadas al indexador y puede usarlas para eliminar comprobaciones de límites; un recorte hecho en otro método no le da ese dato. Sea como sea, la diferencia medida es grande, así que mantén ambas comprobaciones.

`ref struct` trae dos restricciones: no puedes usar `SpanZip` a través de un `await` o un `yield return`, y no puedes guardarlo en un campo de una clase normal. Si el compilador se queja del tiempo de vida, las reglas son las descritas en [cómo decide C# el ref-safe-context](/es/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/).

## Cuando las fuentes no son indexables

`HashSet<T>`, `Dictionary<TKey, TValue>`, `Queue<T>`, `LinkedList<T>` y compañía no pueden darte un span, pero todos exponen un enumerador struct público cuando llamas a `GetEnumerator()` sobre el tipo concreto. Maneja dos de ellos tú mismo:

```csharp
// .NET 10, C# 14
static long SumProducts(List<int> a, List<int> b)
{
    long sum = 0;
    using var ea = a.GetEnumerator();   // List<int>.Enumerator, a struct
    using var eb = b.GetEnumerator();
    while (ea.MoveNext() && eb.MoveNext())
        sum += (long)ea.Current * eb.Current;
    return sum;
}
```

Esto midió 0 B por llamada. El detalle importante es el tipo estático de los parámetros. Cambia `List<int>` por `IEnumerable<int>` y exactamente el mismo cuerpo asigna 80 B por llamada (dos instancias de `List<int>.Enumerator` con boxing), o 64 B cuando los objetos en tiempo de ejecución son arrays. El `var` lo oculta: `ea` es `List<int>.Enumerator` en una versión e `IEnumerator<int>` en la otra.

Los enumeradores struct también conservan las comprobaciones de seguridad propias de la colección. `List<T>.Enumerator` lanza `InvalidOperationException` si la lista se modifica durante la enumeración, algo que las versiones basadas en spans no pueden hacer.

El orden es la otra trampa aquí. Un recorrido en paralelo sobre dos instancias de `HashSet<T>` o `Dictionary<TKey, TValue>` empareja los elementos según el orden interno de los buckets, que no es el orden de inserción y no es estable entre instancias distintas con el mismo contenido. Haz zip solo de colecciones ordenadas. Si lo que de verdad intentas es emparejar elementos por clave, eso es un join o una búsqueda en un diccionario, no un zip.

## Qué arregla y qué no la asignación en la pila de .NET 10

.NET 10 enseñó al JIT a desvirtualizar los métodos de interfaz de los arrays y, mediante el análisis de escape condicional, a asignar enumeradores en la pila "en ciertos escenarios", como lo dice la página [What's new in .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime#array-enumeration-de-abstraction). Es razonable esperar que eso haga gratuitas las versiones con interfaces. En mis ejecuciones no fue así:

- Las variantes de `Enumerable.Zip` asignaron los mismos bytes en .NET 10.0.10 y .NET 11 RC 3. Los enumeradores se crean dentro del iterador de `Zip`, que escapa hacia quien llama, así que el análisis de escape no tiene nada con qué trabajar.
- Dos `IEnumerator<int>` sobre arrays asignaron 64 B en mi medición en estado estable y 32 B con BenchmarkDotNet. Eso sugiere que el JIT asignó en la pila uno de los dos enumeradores en algunas compilaciones y ninguno en otras. Es una optimización en la que no puedes confiar, y nunca llega a cero.

El trabajo de desabstracción es real y sí ayuda al `foreach` de una sola secuencia sobre un array tipado como `IEnumerable<T>`. Si quieres el contexto, [la asignación en la pila de arrays pequeños en .NET 10](/es/2025/04/net-10-stack-allocation-of-arrays-of-value-types/) cubre el trabajo relacionado con arrays. Simplemente todavía no cubre el caso de dos fuentes.

## Las cifras

BenchmarkDotNet 0.15.8, `[MemoryDiagnoser]`, toolchain en proceso, .NET 10.0.10 Arm64 RyuJIT, Apple M4, dos arrays (o listas) de 1 000 valores `int`, calculando una suma de productos:

| Método | Media | Ratio | Asignado |
|---|---:|---:|---:|
| `for` con un índice sobre arrays | 247.9 ns | 1.00 | 0 B |
| `for` sobre dos `ReadOnlySpan<int>` recortados | 249.7 ns | 1.01 | 0 B |
| `CollectionsMarshal.AsSpan` sobre dos listas | 250.9 ns | 1.01 | 0 B |
| `SpanZip` con ambas longitudes comprobadas en `MoveNext` | 310.0 ns | 1.23 | 0 B |
| `SpanZip` recortado en el constructor (primer borrador) | 489.6 ns | 1.97 | 0 B |
| Dos `List<int>.Enumerator` manejados a mano | 652.5 ns | 2.63 | 0 B |
| Dos `IEnumerator<int>` sobre arrays | 1 621.2 ns | 6.54 | 32 B |
| `Enumerable.Zip` con un selector estático | 2 535.9 ns | 10.23 | 160 B |
| Sobrecarga de tuplas de `Enumerable.Zip` | 2 613.6 ns | 10.54 | 144 B |

La fila de `SpanZip` con ambas comprobaciones viene de una segunda ejecución de la misma clase de benchmark, en la que la línea base `for` midió 251.4 ns, así que el ratio es respecto a la línea base de esa ejecución. El toolchain en proceso fue necesario porque BenchmarkDotNet no puede generar su habitual proyecto separado para una aplicación basada en archivo `dotnet run bench.cs`.

Dos lecturas de la tabla. Primero, todo lo que tiene forma de span cae dentro del ruido del bucle escrito a mano; `CollectionsMarshal.AsSpan` no añade nada medible. Segundo, "sin asignaciones" y "rápido" son propiedades distintas: los enumeradores struct manuales no asignan nada pero aun así cuestan 2.6 veces, porque `List<T>.Enumerator.MoveNext` lleva una comprobación de versión y una comprobación de límites por elemento. Si lo que te preocupa es la presión sobre el GC, cualquier fila sin asignaciones lo resuelve. Si lo que te preocupa es el throughput, usa spans.

## Cómo elegir entre ellas

- Ambas fuentes son arrays, listas, `ImmutableArray<T>`, `Memory<T>` o búferes en la pila: usa el bucle `for` con spans recortados, o `SpanZip` si prefieres `foreach` y puedes permitirte un 20% aproximado en un bucle numérico ajustado. En un cuerpo de bucle que hace trabajo real, esos 60 ns por cada mil elementos desaparecen.
- Las fuentes son otras colecciones de la BCL: mantenlas con su tipo concreto y maneja los enumeradores struct. Nunca dejes que pasen antes por un parámetro `IEnumerable<T>`.
- Las longitudes pueden diferir y eso es un bug: comprueba `a.Length != b.Length` y lanza una excepción antes del bucle. `Enumerable.Zip`, el bucle con spans de arriba y `SpanZip` se detienen silenciosamente en la secuencia más corta, y la BCL no tiene un zip estricto; revisé los ensamblados de referencia de .NET 11 RC 3 y `Enumerable.Zip` sigue siendo el único zip incluido.
- Tres o más fuentes: el bucle con spans se extiende de forma trivial (recorta las tres a la longitud mínima). La sobrecarga de tres fuentes de `Enumerable.Zip`, añadida en .NET 6, cuesta 208 B por llamada.
- Código frío, entradas pequeñas o una canalización LINQ que ya asigna: quédate con `Enumerable.Zip`. Es la versión más clara y ahí los bytes no importan.

Si estás migrando mucho LINQ a spans, recuerda que C# 14 cambió cómo los argumentos de array se enlazan con las sobrecargas de span; [las conversiones implícitas de span en C# 14](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) explican por qué una llamada que antes elegía una sobrecarga `IEnumerable<T>` puede ahora elegir una de span.

### Lecturas recomendadas

- [¿Qué es Span<T> en C# y cuándo hace realmente más rápido tu código?](/es/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)
- [List<T> vs Span<T> vs ReadOnlySpan<T> en C#](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [¿Qué es ref-safe-context en C# y cómo lo decide el compilador para las variables locales ref?](/es/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/)
- [.NET 10: asignación en la pila de arrays de tipos de valor](/es/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)

### Fuentes

- [Método Enumerable.Zip](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.zip) (Microsoft Learn)
- [Método CollectionsMarshal.AsSpan](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan) (Microsoft Learn)
- [La instrucción foreach y la enumeración basada en patrones](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/iteration-statements#the-foreach-statement) (referencia del lenguaje C#)
- [Tipos ref struct](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/ref-struct) (referencia del lenguaje C#)
- [What's new in .NET 10 runtime: array enumeration de-abstraction and stack allocation](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime)
- [Planes de desabstracción de .NET 10, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
