---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> en C#: cuándo usar cada uno"
description: "List<T> es una colección de montículo que crece; Span<T> y ReadOnlySpan<T> son vistas solo en la pila sobre memoria que ya posees. Usa List<T> para todo lo que almacenes, devuelvas desde async o crezca; Span<T> para una vista mutable sin asignaciones en un método síncrono; ReadOnlySpan<T> para análisis de solo lectura sobre cadenas, literales u8 y segmentos."
pubDate: 2026-05-25
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

Usa `List<T>` cuando tengas una colección que crece, se guarda en un campo, se devuelve desde un método o se pasa a través de un `await`. Usa `Span<T>` cuando quieras una vista mutable y sin asignaciones sobre un búfer contiguo que ya tienes (un arreglo, un bloque `stackalloc`, un segmento) dentro de un único método síncrono. Usa `ReadOnlySpan<T>` para la misma vista cuando solo lees: segmentado de cadenas, literales `u8`, análisis, búsqueda. La decisión que se impone al gusto: los dos spans son tipos `ref struct`, por lo que no pueden vivir en el montículo, no pueden ser un campo de una clase y no pueden cruzar un `await` o un `yield`. Si necesitas cualquiera de esas cosas, estás con `List<T>` (o un arreglo), punto.

Este artículo apunta a .NET 11 y C# 14. `Span<T>` y `ReadOnlySpan<T>` están en la BCL desde .NET Core 2.1 y en el lenguaje desde C# 7.2, pero dos cambios recientes importan aquí: C# 13 (.NET 9) agregó la anti-restricción `allows ref struct` y `params ReadOnlySpan<T>`, y C# 14 (.NET 11) agregó conversiones implícitas de primera clase entre arreglos y spans. Ambos reducen la fricción de moverse entre estos tipos. `List<T>` se remonta a .NET Framework 2.0.

## Estos no son tres sabores de la misma cosa

La comparación confunde a la gente porque los tres nombres parecen pares y no lo son. Dos de ellos son colecciones solo de nombre.

`List<T>` es una clase. Es una envoltura que crece alrededor de un `T[]` privado que duplica su capacidad cuando se llena. Vive en el montículo administrado, el GC lo rastrea, puedes guardarlo en un campo, devolverlo, capturarlo en una lambda y entregarlo a un método `async`. Posee su almacenamiento y puede crecer. Esta es la colección de uso diario que tomas sin pensar, y la mayoría de las veces ese instinto es correcto.

`Span<T>` es un `ref struct`. No posee ninguna memoria. Es un valor diminuto (una referencia administrada más una longitud) que apunta a una región contigua que asignó otra persona: un arreglo, un segmento de un arreglo, un búfer `stackalloc` o memoria no administrada. No puede crecer, porque no posee el almacenamiento subyacente. Es mutable: escribir a través de un `Span<T>` escribe en el búfer subyacente. Como es un `ref struct`, el runtime garantiza que solo puede vivir en la pila, que es exactamente lo que lo hace seguro para apuntar a memoria de la pila, pero también lo que le prohíbe ser un campo, ser convertido a objeto (boxing) o sobrevivir a un `await`.

`ReadOnlySpan<T>` es la misma vista `ref struct`, menos la capacidad de escribir. Es lo que devuelve el segmentado de cadenas (`"hello".AsSpan(1, 3)`), lo que produce un literal UTF-8 (`"GET"u8` es un `ReadOnlySpan<byte>`) y el tipo de parámetro que deberías aceptar cuando solo lees un búfer. Todo lo dicho sobre las restricciones de solo pila de `Span<T>` aplica de forma idéntica.

Así que la verdadera pregunta rara vez es "qué colección". Es "¿poseo y hago crecer un búfer (`List<T>`), o veo uno que ya tengo, de forma mutable (`Span<T>`) o de solo lectura (`ReadOnlySpan<T>`)?".

## La matriz de decisión

El comportamiento de abajo es para .NET 9+ / C# 13+ salvo que se indique.

| Capacidad                                    | `List<T>`              | `Span<T>`                  | `ReadOnlySpan<T>`          |
| -------------------------------------------- | ---------------------- | -------------------------- | -------------------------- |
| Tipo                                         | clase (montículo)      | `ref struct` (pila)        | `ref struct` (pila)        |
| Posee su almacenamiento                      | sí                     | no (una vista)             | no (una vista)             |
| Puede crecer / `Add`                         | sí                     | no                         | no                         |
| Mutar elementos                              | sí                     | sí                         | no                         |
| Asignación al crear                          | montículo (el `T[]` subyacente) | ninguna           | ninguna                    |
| Guardar en un campo de una clase             | sí                     | no                         | no                         |
| Devolver desde un método `async`             | sí                     | no                         | no                         |
| Usar a través de `await` / `yield`           | sí                     | no                         | no                         |
| Capturar en una lambda / clausura            | sí                     | no                         | no                         |
| Boxing / asignar a `object` o una interfaz   | sí                     | no                         | no                         |
| Usar como argumento de tipo genérico         | sí                     | solo con `allows ref struct` | solo con `allows ref struct` |
| Segmentar sin copiar                         | no (`GetRange` copia)  | sí (`Slice`, sin copia)    | sí (`Slice`, sin copia)    |
| Originar desde un `string`                   | no                     | no                         | sí (`AsSpan`)              |
| Originar desde `stackalloc`                  | no                     | sí                         | sí                         |
| Primera aparición                            | .NET Framework 2.0     | .NET Core 2.1              | .NET Core 2.1              |

Las filas desde "Guardar en un campo" hasta "Boxing" son las que deciden la mayoría de los casos reales. Si cualquiera de ellas es un sí para tu escenario, los spans quedan fuera y mantienes un `List<T>` o un arreglo. Todo lo demás es una cuestión de rendimiento y ergonomía.

## Cuándo elegir List<T>

`List<T>` es la opción por defecto. Recurre a ella siempre que la colección tenga un tiempo de vida más largo que un método síncrono, o cuando no conozcas el tamaño final de antemano.

- **Construyes una colección de forma incremental.** Estás leyendo filas, agregando resultados, acumulando eventos. `Add` es O(1) amortizado y la lista se redimensiona sola. Un span no puede crecer, así que ni siquiera hay competencia.
- **La colección es un campo o un valor de retorno.** Una caché, un registro, un `List<Order>` que devuelves desde un repositorio. Un `ref struct` no puede ser un campo ni devolverse a través de un límite asíncrono, así que cualquier cosa que sobreviva al marco de pila vive en un `List<T>`.
- **Cruzas un `await`.** En el momento en que un método espera (await), cada variable local que sobrevive al await se eleva a una máquina de estados asignada en el montículo. Un `ref struct` no se puede elevar, así que una variable local `Span<T>` no puede sobrevivir al await. Un `List<T>` sí.

```csharp
// .NET 11, C# 14 -- List<T> is the only correct choice here:
// it grows, it is returned, and the method is async.
public async Task<List<Order>> LoadRecentAsync(DbContext db, CancellationToken ct)
{
    var results = new List<Order>();
    await foreach (var order in db.Orders.AsAsyncEnumerable().WithCancellation(ct))
    {
        if (order.Total > 100m)
            results.Add(order);   // grows on demand
    }
    return results;               // escapes the stack frame
}
```

Si quieres una pista de que tomaste la decisión correcta, pregúntate si la colección necesita existir después de que el método retorne. Si la respuesta es sí, es un `List<T>` o un arreglo, nunca un span.

## Cuándo elegir Span<T>

`Span<T>` es para una vista mutable y sin asignaciones sobre memoria que ya controlas, usada y descartada dentro de un único método síncrono. La ventaja clásica es evitar una asignación intermedia.

- **Un búfer temporal pequeño vía `stackalloc`.** Formatear un número, construir una clave pequeña, calcular el hash de unos pocos bytes. `stackalloc` pone el búfer en la pila, y un `Span<T>` es el manejador seguro hacia él. Sin `T[]` en el montículo, sin presión sobre el GC.
- **Segmentar un búfer en el lugar.** Analizar una trama de red: tomar el encabezado, luego la carga útil, sin copiar ninguno. `Span<T>.Slice` devuelve otra vista sobre la misma memoria.
- **Mutar una región de un arreglo sin un revoltijo de parámetros de offset/longitud.** Pasar `buffer.AsSpan(start, length)` es más limpio que enhebrar `(buffer, start, length)` por cada llamada, y los límites se verifican una vez en el segmento.

```csharp
// .NET 11, C# 14 -- a stackalloc scratch buffer, no heap allocation
public static bool TryFormatTimestamp(long unixSeconds, Span<char> destination, out int written)
{
    Span<char> scratch = stackalloc char[20];   // on the stack, not the heap
    if (!unixSeconds.TryFormat(scratch, out int n))
    {
        written = 0;
        return false;
    }
    return scratch.Slice(0, n).TryCopyTo(destination)
        ? (written = n) >= 0
        : Fail(out written);

    static bool Fail(out int w) { w = 0; return false; }
}
```

Hay una razón de rendimiento real más allá de la asignación. El JIT a menudo puede eliminar las comprobaciones de límites cuando itera un `Span<T>` directamente, porque la longitud del span está justo ahí y la forma del bucle es reconocible. Iterar un `List<T>` a través de su enumerador ejecuta una comprobación de versión y una comprobación de límites en cada `MoveNext`. Lo medimos más abajo.

Un puente común: si ya tienes un `List<T>` y quieres el rendimiento de un span para una lectura caliente o una mutación en el lugar, no lo copies. Llama a `CollectionsMarshal.AsSpan(list)` para obtener un `Span<T>` directamente sobre el arreglo subyacente de la lista. Esa vista solo es válida hasta la siguiente operación que redimensione la lista, así que úsala y deséchala.

## Cuándo elegir ReadOnlySpan<T>

`ReadOnlySpan<T>` es el tipo de parámetro correcto para cualquier método síncrono que lee un búfer y no necesita mutarlo. Según las [pautas de uso de Memory y Span](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines) de Microsoft, la regla uno es "para una API síncrona, prefiere `Span<T>` sobre `Memory<T>`", y la regla dos es "usa `ReadOnlySpan<T>` si el búfer debe ser de solo lectura". La mayor parte del análisis y la búsqueda es de solo lectura.

- **Segmentar cadenas sin asignar subcadenas.** `"2026-05-25".AsSpan(0, 4)` te da el año como un `ReadOnlySpan<char>` sin un nuevo `string`. `int.Parse` y similares tienen sobrecargas de span, así que puedes analizar directamente desde el segmento.
- **Literales UTF-8.** `"GET"u8` es un `ReadOnlySpan<byte>` incrustado en el ensamblado. Comparar un búfer de bytes entrante contra él es sin asignaciones.
- **Aceptar cualquier forma de búfer.** Un método que toma `ReadOnlySpan<byte>` puede llamarse con un `byte[]`, un `ArraySegment<byte>`, un búfer `stackalloc` o un segmento, sin sobrecargas. En C# 14 la conversión de arreglo a span es implícita, así que quienes llaman ni siquiera escriben `.AsSpan()`.

```csharp
// .NET 11, C# 14 -- read-only parsing with zero substring allocations
public static (int year, int month, int day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

// All three callers work; none allocate a substring.
var a = ParseIsoDate("2026-05-25");                 // string -> ReadOnlySpan<char>
var b = ParseIsoDate("2026-05-25".AsSpan());         // explicit
Span<char> buf = stackalloc char[10];
"2026-05-25".CopyTo(buf);
var c = ParseIsoDate(buf);                            // Span<char> -> ReadOnlySpan<char>
```

Nota que un `Span<T>` se convierte implícitamente a un `ReadOnlySpan<T>`, nunca al revés. Toma el tipo más restrictivo que tu método realmente necesita: si solo lees, pide `ReadOnlySpan<T>` para que todos los que llaman, mutables o no, puedan alcanzarte. Esto combina de forma natural con [SearchValues<T> para búsqueda rápida de múltiples agujas](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/), que está construido enteramente alrededor de entradas `ReadOnlySpan<T>`.

## El benchmark: sumar 10 000 enteros

La afirmación de rendimiento es específica: iterar un `Span<T>` o un `ReadOnlySpan<T>` es más rápido que iterar un `List<T>`, porque el JIT elimina las comprobaciones de límites por elemento en el span y el enumerador de la lista no. Aquí está la medición.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
// dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;
    private int[] _array = null!;

    [GlobalSetup]
    public void Setup()
    {
        _array = Enumerable.Range(0, 10_000).ToArray();
        _list = new List<int>(_array);
    }

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // List<T>.Enumerator: version + bounds check
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }

    [Benchmark]
    public long ReadOnlySpanForeach()
    {
        long sum = 0;
        ReadOnlySpan<int> span = _array;     // C# 14 implicit conversion
        foreach (int x in span) sum += x;
        return sum;
    }
}
```

Resultados representativos en un Ryzen 7 / Windows 11 / compilación .NET 11, x64 RyuJIT:

| Método                | Media     | Ratio | Asignado  |
| --------------------- | --------- | ----- | --------- |
| `ListForeach`         | 6,1 us    | 1,00  | 0 B       |
| `SpanForeach`         | 2,4 us    | 0,39  | 0 B       |
| `ReadOnlySpanForeach` | 2,4 us    | 0,39  | 0 B       |

Aproximadamente 2,5x más rápido para el bucle del span, con cero asignaciones en los tres (la lista ya existe; `CollectionsMarshal.AsSpan` no copia). El ratio exacto se mueve con el tipo de elemento y la CPU, pero la dirección es estable: el enumerador del span es un bucle delgado que recorre por `ref` y que el JIT optimiza con fuerza, mientras que `List<T>.Enumerator` carga la comprobación de versión que detecta la modificación concurrente. Esa comprobación de versión es una característica, no un desperdicio (es por lo que `List<T>` lanza `InvalidOperationException` si lo mutas durante la iteración), pero cuesta ciclos que el span nunca paga.

La advertencia honesta: para una suma de 10 000 elementos esto son microsegundos. Si tu bucle no es caliente, no contorsiones tu código para ahorrar 4 microsegundos. Los spans ganan su lugar en bucles internos calientes, analizadores y serializadores que se ejecutan millones de veces, no en el recorrido ocasional de una lista.

## Las trampas que deciden por ti

Tres restricciones se imponen al gusto por completo, y las tres provienen de que `Span<T>` y `ReadOnlySpan<T>` son tipos `ref struct`.

**Un `await` en el ámbito descarta los spans.** Una variable local `ref struct` no puede sobrevivir a un `await`, porque el compilador tendría que elevarla a una máquina de estados asignada en el montículo, lo cual un tipo solo de pila prohíbe. El compilador lo rechaza de plano. Si tu método espera (await) y necesita un búfer que abarque el await, usa `Memory<T>` / `ReadOnlyMemory<T>` (los primos amigables con el montículo) o un `List<T>` / arreglo. Consulta [cómo convertir T[] a ReadOnlyMemory<T>](/es/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) para los tipos de vista seguros a través de await.

**Un campo, un retorno a través de async o una clausura descarta los spans.** No puedes escribir `class C { Span<int> _buf; }`. No puedes capturar un span en una lambda. No puedes devolver uno desde un `async Task<Span<int>>`. En el momento en que tu diseño necesita que el búfer escape del marco de pila actual, la respuesta es `List<T>` o `T[]`, posiblemente con un manejador `Memory<T>` para async.

**Un contexto genérico anterior a C# 13 limita los spans.** Antes de C# 13 no podías usar `Span<T>` como argumento de tipo genérico en absoluto. Con la anti-restricción `allows ref struct` de C# 13 puedes, pero solo si el método o tipo genérico opta por ella con `where T : allows ref struct`. Una API genérica que no ha optado por ella todavía no puede tomar un span. `List<T>` no tiene tal restricción; es una clase ordinaria.

También hay una trampa sutil de tiempo de vida con `CollectionsMarshal.AsSpan`. El span que devuelve apunta al arreglo subyacente actual de la lista. Si luego haces `Add` lo suficiente como para disparar un redimensionamiento, la lista asigna un nuevo arreglo y tu span ahora apunta al antiguo, ya huérfano. Trata ese span como válido solo hasta la siguiente llamada que mute la lista.

## La recomendación, reformulada

Por defecto, `List<T>`. Es la colección que haces crecer, almacenas, devuelves, atraviesas con await y capturas, y en .NET 11 es de sobra rápida para todo lo que no sea una ruta caliente medida. Baja a `Span<T>` cuando quieras una vista mutable y sin asignaciones sobre un búfer que ya posees y que vas a usar y descartar dentro de un único método síncrono, especialmente con `stackalloc` o segmentado en el lugar. Usa `ReadOnlySpan<T>` como tipo de parámetro para cualquier lector síncrono, y como el retorno del segmentado de cadenas y los literales `u8`, para que analices y busques sin asignar subcadenas. Cuando un span sería ideal pero hay un `await`, un campo o una clausura en el camino, recurre a `Memory<T>` / `ReadOnlyMemory<T>` o quédate con `List<T>`. La versión correcta más corta: poseer y crecer significa `List<T>`; ver y mutar significa `Span<T>`; ver y leer significa `ReadOnlySpan<T>`.

## Relacionado

- [Conversiones implícitas de Span en C# 14: soporte de primera clase para Span y ReadOnlySpan](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cubre las conversiones que permiten a los llamadores omitir `.AsSpan()`.
- [Cómo convertir T[] a ReadOnlyMemory<T> en C#](/es/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) es la contraparte segura a través de await cuando un span no puede cruzar un `await`.
- [Cómo usar SearchValues<T> correctamente en .NET 11](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) se apoya en `ReadOnlySpan<T>` para una búsqueda rápida de múltiples caracteres.
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) se apoya en el segmentado de spans para analizar sin copiar.
- [C# 13: el fin de las asignaciones de params](/es/2026/01/c-13-the-end-of-params-allocations/) explica `params ReadOnlySpan<T>`, los `params` sin asignaciones que los spans hacen posibles.

## Fuentes

- [Pautas de uso de Memory<T> y Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Referencia de la estructura System.Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Referencia de la estructura System.ReadOnlySpan<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.readonlyspan-1)
- [Anti-restricción allows ref struct (MS Learn, propuesta de C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [Referencia de CollectionsMarshal.AsSpan (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
- [Referencia de la clase List<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.collections.generic.list-1)
