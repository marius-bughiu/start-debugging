---
title: "iterador con yield return vs devolver una List<T>: lo que realmente cuesta un método IEnumerable en C#"
description: "Un método con yield return cuesta un objeto de máquina de estados de 40 bytes por llamada, sin importar cuántos elementos produzca; una List<T> cuesta todo el arreglo interno por adelantado. Medido en .NET 10.0.10: el iterador gana en memoria y en salida anticipada, List<T> gana cuando el llamador enumera más de una vez, necesita Count o llama a ToList()."
pubDate: 2026-10-31
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "linq"
  - "performance"
lang: "es"
translationOf: "2026/10/yield-return-iterator-vs-returning-a-list-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-31
---

**Respuesta corta:** un método con `yield return` asigna exactamente un objeto pequeño por llamada (40 bytes para un bucle simple de `IEnumerable<int>` en .NET 10.0.10), ya produzca 10 elementos o un millón. Un método que construye y devuelve una `List<T>` asigna la lista más un arreglo interno dimensionado según el resultado, que son 4 056 bytes para 1 000 enteros con una lista de tamaño predefinido y 8 424 bytes sin él. Elige el iterador cuando el llamador enumera una sola vez (un único `foreach` sobre él fue aproximadamente 2x más rápido que llenar y leer una lista con 1 000 elementos), puede detenerse antes, o la secuencia es grande o ilimitada. Elige `List<T>` (e indícalo en el tipo de retorno, `List<T>` o `IReadOnlyList<T>`) cuando el llamador necesita `Count`, indexación, o enumerará más de una vez, porque cada pasada adicional sobre un iterador vuelve a ejecutar el cuerpo de tu método.

Todo lo que sigue se midió con C# 14 en .NET 10.0.10 (SDK 10.0.302) sobre un Apple M4, usando BenchmarkDotNet 0.15.8 para los tiempos y `GC.GetAllocatedBytesForCurrentThread()` para los conteos de asignación por llamada.

## La comparación de un vistazo

| | iterador con `yield return` | `List<T>` devuelta como `IEnumerable<T>` |
| --- | --- | --- |
| Asignación por llamada (.NET 10.0.10, `int`) | 40 B, constante (a veces 0 B cuando el JIT lo integra en línea) | 32 B + arreglo interno (4 056 B para 1 000 enteros) |
| Trabajo realizado al momento de la llamada | ninguno, ni siquiera las validaciones de argumentos | todo |
| Trabajo realizado si el llamador se detiene tras 1 elemento | 1 elemento | todos los elementos |
| Segundo `foreach` | vuelve a ejecutar el cuerpo del método | lee los elementos almacenados |
| `Count()` | recorre toda la secuencia | O(1) mediante `ICollection<T>` |
| `TryGetNonEnumeratedCount` | `false` | `true` |
| `ToList()` / `ToArray()` | crece duplicando / copia de tamaño exacto | una copia de tamaño exacto |
| Excepciones lanzadas | en el primer `MoveNext()` | al momento de la llamada |
| Seguridad entre hilos del resultado | una máquina de estados nueva por enumeración | seguro para leer desde muchos hilos |

## En qué convierte el compilador a `yield return`

Este es el iterador que se usa a lo largo del artículo:

```csharp
// .NET 10.0.10, C# 14
public static IEnumerable<int> Iterator(int n)
{
    for (int i = 0; i < n; i++)
        yield return i * 2;
}
```

Roslyn reescribe el método en una clase oculta, aquí llamada `<Iterator>d__0`, y el cuerpo del método pasa a ser "asignar esa clase, guardar los argumentos, devolverla". La reflexión sobre el tipo generado muestra exactamente qué contiene:

```text
Src+<Iterator>d__0
  field Int32 <>1__state
  field Int32 <>2__current
  field Int32 <>l__initialThreadId
  field Int32 n
  field Int32 <>3__n
  field Int32 <i>5__2
  implements IEnumerable`1, IEnumerable, IEnumerator`1, IDisposable, IEnumerator
```

Seis campos `int` más el encabezado de objeto de 16 bytes y el puntero a la tabla de métodos dan los 40 bytes. Cada variable local que sobrevive a un `yield return` se convierte en un campo (`<i>5__2` es la variable del bucle), y cada parámetro se almacena dos veces: `<>3__n` conserva el valor original para que la secuencia pueda enumerarse de nuevo, `n` es la copia de trabajo. Un método con un parámetro `string` y una variable local `DateTime` tiene campos más grandes, pero la forma nunca depende de cuántos elementos produzcas. Ese es todo el punto: la memoria es O(1) respecto a la cantidad de elementos.

El mismo objeto es a la vez el `IEnumerable<T>` y, en la primera llamada a `GetEnumerator()` desde el hilo que lo creó, el `IEnumerator<T>`. Así que un simple `foreach (var x in Iterator(n))` cuesta una asignación, no dos.

La versión con `List<T>` es el código que la mayoría escribe primero:

```csharp
// .NET 10.0.10, C# 14
public static List<int> ListCap(int n)
{
    var list = new List<int>(n);
    for (int i = 0; i < n; i++)
        list.Add(i * 2);
    return list;
}
```

Aquí el costo es el objeto `List<int>` de 32 bytes más un `int[]` de `n` elementos (24 bytes de encabezado y longitud, luego 4 bytes por elemento). Si quitas la `n` del constructor, la lista crece 4, 8, 16, ..., 1024, dejando cada arreglo intermedio para el GC.

## Asignaciones por llamada, medidas

Cada caso se ejecutó 200 000 veces para llegar a código de nivel 1 (tier-1), y luego se promedió sobre 1 000 llamadas:

| Elementos | Iterador, `foreach` | `List<T>(n)`, `foreach` | `List<T>()`, `foreach` | Iterador `.ToList()` | Iterador `.ToArray()` |
| --- | --- | --- | --- | --- | --- |
| 0 | 40 B | 32 B | 32 B | 72 B | 40 B |
| 1 | 40 B | 64 B | 72 B | 112 B | 72 B |
| 10 | 40 B | 96 B | 216 B | 256 B | 104 B |
| 1 000 | 40 B | 4 056 B | 8 424 B | 8 464 B | 4 064 B |

Tres cosas destacan.

Primero, con cero elementos la lista es en realidad más barata (32 B contra 40 B), y con un elemento la diferencia es mínima. Para resultados cortos y acotados, la memoria no es la razón para elegir una u otro.

Segundo, `Iterator(n).ToList()` es la peor columna. El iterador no implementa `ICollection<T>`, así que `ToList()` no puede dimensionar por adelantado y crece duplicando, exactamente como la lista sin capacidad, más la máquina de estados de 40 bytes. Si cada llamador invoca `ToList()` sobre tu iterador de inmediato, estás pagando por ambos diseños. Devuelve mejor una `List<T>` de tamaño predefinido.

Tercero, `ToArray()` sobre un iterador casi no desperdicia nada en .NET 10: 4 064 B para 1 000 enteros, solo 8 bytes más que el arreglo exacto más el iterador. Desde .NET 9, `ToArray()` almacena en búfer las secuencias de longitud desconocida en segmentos asignados en la pila y copia una sola vez a un arreglo de tamaño exacto; cubrí ese cambio en [ToList vs ToArray en .NET 9](/es/2025/01/net-performance-tolist-vs-toarray/). Si un llamador necesita materializar un iterador, `ToArray()` es la llamada más barata.

## Lo que el JIT de .NET 10 elimina por ti

Devolver `List<T>` tipada como `IEnumerable<T>` solía costar una asignación más: `foreach` sobre la interfaz llama a `IEnumerable<T>.GetEnumerator()`, que encapsula (boxing) la estructura `List<T>.Enumerator` (40 bytes en 64 bits). En .NET 10.0.10 el caso "List como `IEnumerable`" asigna los mismos 64 B que la lista concreta con un elemento. Al volver a ejecutar la prueba con `DOTNET_JitObjectStackAllocation=0` regresa el boxing (104 B), lo que muestra que la desvirtualización protegida del JIT junto con la asignación de objetos en la pila, parte del [trabajo de de-abstracción de enumeradores de .NET 10](https://github.com/dotnet/runtime/issues/108913), ahora coloca ese enumerador en la pila. Con cero elementos no hay boxing ni siquiera con el interruptor desactivado, porque `List<T>` entrega un enumerador vacío compartido cuando `Count == 0`.

Los 40 bytes del iterador no cambiaron en los casos con `foreach`, con o sin análisis de escape. La máquina de estados se devuelve fuera de tu método, así que escapa por definición, y el JIT solo puede asignarla en la pila cuando integra en línea el método iterador y todo lo que lo consume en un solo llamador. Eso sí ocurrió con algunas llamadas LINQ en el benchmark de abajo, pero no de forma confiable.

## Tiempos: dónde gana cada uno

BenchmarkDotNet 0.15.8, trabajo predeterminado, .NET 10.0.10 Arm64 RyuJIT, Apple M4. Cada método construye la secuencia y la consume dentro del benchmark, así que las filas de "List" incluyen el llenado de la lista. Tiempo medio, asignación entre paréntesis:

| Benchmark | N = 10 | N = 1 000 | N = 100 000 |
| --- | --- | --- | --- |
| Iterador, `foreach` | 10.7 ns (40 B) | 580 ns (40 B) | 56.9 us (40 B) |
| `List<T>(n)`, `foreach` | 12.7 ns (96 B) | 1 004 ns (4 056 B) | 116.3 us (400 140 B) |
| `List<T>()`, `foreach` | 30.1 ns (216 B) | 1 214 ns (8 424 B) | 145.8 us (1 049 168 B) |
| `List<T>(n)` como `IEnumerable<T>`, `foreach` | 13.2 ns (96 B) | 1 148 ns (4 056 B) | 114.6 us (400 140 B) |
| Iterador, `.First()` | 2.1 ns (0 B) | 2.1 ns (0 B) | 2.0 ns (0 B) |
| `List<T>(n)`, `.First()` | 11.4 ns (96 B) | 666 ns (4 056 B) | 77.3 us (400 140 B) |
| Iterador, `.ToList()` | 34.1 ns (216 B) | 1 452 ns (8 424 B) | 166.9 us (1 049 168 B) |
| Iterador, `.Count()` | 7.3 ns (0 B) | 541 ns (0 B) | 53.5 us (0 B) |

Para una sola pasada, el iterador es más rápido en todos los tamaños: cerca de 1.2x con 10 elementos y 2x con 1 000 y 100 000. Eso sorprende a quienes esperan que "una llamada de interfaz por elemento" pierda contra "una lista". La versión con lista hace el mismo bucle para llenarla, luego un segundo bucle para leerla, y paga por el arreglo; el iterador hace un solo bucle. Con 100 000 enteros, el arreglo de 400 140 bytes de la lista de tamaño predefinido supera el umbral de 85 000 bytes, así que cae en el Large Object Heap y cada llamada fuerza recolecciones Gen2 en la ejecución de BenchmarkDotNet.

La salida anticipada es donde la diferencia se vuelve absurda: `First()` sobre el iterador cuesta 2 ns sin importar el tamaño, porque calcula un solo elemento. La versión con lista calcula los 100 000 antes de que `First()` vea alguno.

Las dos filas donde el iterador pierde son las que de todos modos necesitan el resultado completo. `Iterator(n).ToList()` es la fila más lenta en todas las columnas, más lenta que construir la lista directamente sin capacidad, porque suma las llamadas de interfaz sobre el crecimiento por duplicación. Y aunque `Count()` sobre el iterador es rápido aquí, lo es porque consume la secuencia; si llamas a `Count()` y luego a `foreach`, ejecutas el método dos veces, y el `Count` O(1) de la lista gana.

Los 0 B en las filas `First()` y `Count()` del iterador son de nuevo el JIT de .NET 10: en esos benchmarks integró en línea el método iterador y la llamada LINQ y asignó la máquina de estados en la pila. Mi prueba de asignaciones vio lo mismo en algunos sitios de llamada y los 40 B normales en otros, y `DOTNET_JitObjectStackAllocation=0` restauró los 40 B en todos lados. Tómalo como un extra, no como algo alrededor de lo cual diseñar.

## El iterador se reutiliza a sí mismo, a veces

Un detalle explica un número sorprendente de la prueba: enumerar dos veces el mismo iterador asignó 40 bytes en total, no 80. El `GetEnumerator()` generado devuelve `this` cuando el campo de estado es `-2` (recién creado) y el llamador está en el hilo que lo creó. Al desensamblar el `Dispose()` generado en el SDK 10.0.302 se ve que es solo `this.<>1__state = -2`, así que una vez que un `foreach` termina, o hace `break`, y libera el enumerador, el objeto vuelve a su estado inicial y el siguiente `foreach` en el mismo hilo obtiene la misma instancia:

```csharp
// .NET 10.0.10, C# 14 (SDK 10.0.302)
var seq = Iterator(5);
foreach (var x in seq) { if (x == 2) break; }
var again = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, again)); // True: reused after Dispose

var fresh = Iterator(5);
var e1 = fresh.GetEnumerator();
e1.MoveNext();
var e2 = fresh.GetEnumerator();
Console.WriteLine(ReferenceEquals(fresh, e2));  // False: e1 still owns the instance
```

Un segundo enumerador tomado mientras el primero sigue vivo, o uno tomado desde otro hilo, recibe una instancia nueva inicializada a partir de las copias de parámetros `<>3__` almacenadas. Nunca necesitas razonar sobre esto para la corrección, pero significa que "iterador enumerado dos veces" es barato en bytes. No es barato en trabajo, que es el siguiente punto.

## Trampas que deciden por ti

### Cada enumeración vuelve a ejecutar tu método

El iterador no almacena elementos. Un segundo `foreach`, un `Count()` seguido de un `foreach`, o `Any()` seguido de `ToList()` ejecutan el cuerpo del método de nuevo, incluida cualquier llamada a base de datos, lectura de archivo o `Console.WriteLine` que contenga:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<string> ReadNames(string path)
{
    Console.WriteLine($"opening {path}");
    foreach (var line in File.ReadLines(path))
        yield return line.Trim();
}

var names = ReadNames("names.txt");
if (names.Any())                      // opening names.txt
    Console.WriteLine(names.Count()); // opening names.txt (again)
```

Los analizadores de .NET señalan esto como [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851), pero la regla está desactivada de forma predeterminada. Si tus llamadores necesitan dos pasadas con regularidad, devuelve una lista. Si heredaste un `IEnumerable<T>` y no sabes si es seguro recorrerlo dos veces, [las comprobaciones de este artículo sobre cómo detectar un IEnumerable ya materializado](/es/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/) son lo más cercano que ofrece la BCL.

### La validación de argumentos se difiere

Nada del cuerpo de un iterador se ejecuta hasta el primer `MoveNext()`, y eso incluye las cláusulas de guarda al inicio:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // runs on first MoveNext, not here
    foreach (var x in source)
    {
        if (count-- <= 0) yield break;
        yield return x;
    }
}

var q = Take(null!, 3);   // no exception
foreach (var x in q) { }  // ArgumentNullException thrown here
```

La traza de pila entonces apunta al `foreach`, posiblemente lejos de la llamada incorrecta. La solución estándar, y la razón por la que los propios operadores LINQ de la BCL lanzan al momento de la llamada, es dividir el método en dos: un método público que no es iterador y valida, y un iterador privado (una función local sirve) que produce los elementos:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // throws at call time
    ArgumentOutOfRangeException.ThrowIfNegative(count);
    return Core(source, count);

    static IEnumerable<int> Core(IEnumerable<int> source, int count)
    {
        foreach (var x in source)
        {
            if (count-- <= 0) yield break;
            yield return x;
        }
    }
}
```

Un método con `List<T>` no tiene esa trampa: se ejecuta por completo, o lanza, antes de devolver.

### `finally` solo se ejecuta si alguien libera el enumerador

Los bloques `try`/`finally` y `using` dentro de un iterador se ejecutan cuando la enumeración termina o cuando se libera el enumerador. `foreach` siempre libera, incluso con `break` y ante excepciones. El código que llama a `GetEnumerator()` y `MoveNext()` a mano y olvida `Dispose()` deja archivos y conexiones abiertos hasta que el GC finaliza lo que los poseía. Una lista no retiene recursos después de devolverse.

### Los iteradores recursivos son cuadráticos

`yield return` no puede reenviar una secuencia anidada, así que un recorrido recursivo de árbol escrito como `foreach (var child in Walk(node.Left)) yield return child;` asigna una máquina de estados por nodo y empuja cada elemento hacia arriba por todos los niveles: O(n x profundidad) llamadas a `MoveNext`. Para árboles profundos, usa un `Stack<T>` explícito dentro de un único iterador, o llena una sola `List<T>` que se pase hacia abajo en la recursión.

### El tipo de retorno es una promesa

Devolver `IEnumerable<T>` desde un método que en realidad construye una `List<T>` oculta que `Count` es gratis, e invita a los llamadores a invocar `ToList()` "por si acaso", copiando los datos por segunda vez (el caso `List.ToList()` de 8 112 B con 1 000 elementos en la [tabla de asignaciones de arriba](#asignaciones-por-llamada-medidas), contra 4 056 B de la lista misma). Si materializas, devuelve `List<T>`, `IReadOnlyList<T>` o un arreglo, para que los llamadores lo vean. Si haces streaming, devuelve `IEnumerable<T>` y documenta que es perezoso. Para datos que vienen de una base de datos o de la red, ninguno es adecuado; [IEnumerable vs IAsyncEnumerable vs IQueryable](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) cubre cuándo conviene hacer streaming asíncrono en su lugar, y [para qué sirve IAsyncEnumerable](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) profundiza en `await foreach`.

## Cuál devolver

Usa un iterador con `yield return` cuando:

- El llamador enumera una sola vez, de arriba abajo, que es el caso común de las canalizaciones con `foreach` y las cadenas LINQ.
- El llamador podría detenerse antes (`First`, `Any`, `Take`, un `break` al encontrar una coincidencia). El iterador hace solo el trabajo que se pidió.
- La secuencia es grande, ilimitada o producida desde un flujo (líneas de un archivo, páginas de una API). La memoria se queda en un objeto en lugar de todo el resultado.

Devuelve una `List<T>` (tipada como `List<T>` o `IReadOnlyList<T>`) cuando:

- El llamador necesita `Count`, indexación o más de una pasada.
- El resultado es pequeño y acotado, donde los 40 bytes del iterador y las llamadas de interfaz por elemento no aportan nada.
- Los llamadores llamarán a `ToList()` de todos modos. Dimensiónala por adelantado con `new List<T>(capacity)` cuando conozcas la cantidad.
- El método tiene efectos secundarios o validación que deben ocurrir exactamente una vez, al momento de la llamada.

Mi opción predeterminada para las API públicas es la segunda lista: materializada y tipada con honestidad. Recurro a `yield return` cuando la salida anticipada o la memoria son el requisito real, y entonces siempre separo la validación en un contenedor que no es iterador.

## Relacionado

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [How to tell whether an IEnumerable<T> has already been materialized in C#](/es/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [.NET Performance: ToList vs ToArray](/es/2025/01/net-performance-tolist-vs-toarray/)
- [What is IAsyncEnumerable and when should I use it?](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [How to iterate over two collections in lockstep without heap allocations in C#](/es/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/)

## Fuentes

- [yield statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/yield) (referencia del lenguaje C#)
- [Iterators](https://learn.microsoft.com/dotnet/csharp/iterators) (guía de C#)
- [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851) (Microsoft Learn)
- [Enumerable.TryGetNonEnumeratedCount](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) (Microsoft Learn)
- [Roslyn iterator rewriter source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/IteratorRewriter/IteratorMethodToStateMachineRewriter.cs.html) (source.dot.net)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime) (Microsoft Learn)
