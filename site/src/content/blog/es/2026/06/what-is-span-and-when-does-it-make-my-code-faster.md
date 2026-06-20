---
title: "¿Qué es Span<T> en C# y cuándo hace realmente más rápido tu código?"
description: "Span<T> es un ref struct que solo vive en la pila y apunta a memoria que ya posees, así que no tiene asignación de respaldo. Acelera el código en exactamente tres situaciones: reemplazar un búfer en el heap con stackalloc, segmentar sin copiar y bucles ajustados donde el JIT elimina las comprobaciones de límites. En cualquier otro caso no cambia nada, y cruzando un await no compila."
pubDate: 2026-06-20
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

`Span<T>` es un `ref struct` que solo vive en la pila y representa una región contigua de memoria que ya posees: un array, una porción de uno, un búfer de `stackalloc`, un fragmento de una cadena o memoria no administrada. Es una referencia administrada más una longitud, nada más. No asigna, no copia y no puede crecer. Ese es todo el tipo. La razón por la que la gente recurre a él es el rendimiento, pero solo hace el código más rápido en tres situaciones concretas: cuando te permite reemplazar una asignación en el heap por `stackalloc`, cuando te permite segmentar un búfer sin copiar, y cuando convierte un bucle en una forma de la que el JIT puede eliminar las comprobaciones de límites. Fuera de esos casos, un span es una herramienta de claridad, no de rendimiento, y forzarlo en código que no hace ninguna de las tres cosas no te aporta nada. Este artículo apunta a .NET 11 y C# 14, aunque `Span<T>` lleva en la BCL desde .NET Core 2.1 y en el lenguaje desde C# 7.2.

La trampa es que "usa `Span<T>`, es más rápido" se repite sin la segunda mitad de la frase. Así que te doy la segunda mitad: qué es realmente el tipo, los mecanismos exactos por los que ahorra ciclos, y la lista igualmente importante de casos donde meter un span cambia el código generado aproximadamente en cero.

## Una vista sobre la memoria, no un contenedor

El modelo mental que arregla la mayor parte de la confusión: `Span<T>` no es una colección. Es una ventana. Una `List<T>` o un `T[]` poseen su almacenamiento, viven en el heap, y el recolector de basura los rastrea. Un `Span<T>` no posee nada. Mantiene una referencia al inicio de cierta memoria y un conteo de cuántos elementos son válidos. Crea uno y no ocurre ninguna asignación, porque no hay nada que asignar: los bytes ya existen en algún lugar, y el span simplemente nombra un tramo de ellos.

```csharp
// .NET 11, C# 14
int[] numbers = { 10, 20, 30, 40, 50 };

Span<int> all = numbers;          // a view over the whole array, no copy
Span<int> middle = all.Slice(1, 3); // {20, 30, 40}, still the same backing memory

middle[0] = 99;                   // writes THROUGH to numbers[1]
Console.WriteLine(numbers[1]);    // 99
```

`middle` no copió tres enteros. Es una referencia a `numbers[1]` más la longitud `3`. Escribir a través de él escribe en el array original, porque solo hay un array. Ese aliasing es justamente el objetivo: un span es un manejador barato, tipado y con comprobación de límites a memoria que vive en otro lugar.

Como el runtime garantiza que un `ref struct` solo puede vivir en la pila, un span es seguro para apuntar a memoria de la pila (un búfer de `stackalloc`) sin los riesgos de tiempo de vida que crearía una referencia del heap a la pila. Esa misma garantía es el origen de todas las restricciones que tiene el tipo, a lo que llegaremos. Primero, la parte por la que viniste.

## De dónde viene realmente la velocidad

Un span hace el código más rápido mediante tres mecanismos distintos. Son independientes: una pieza de código dada podría tocar uno, dos o ninguno. Si no toca ninguno, el span no está haciendo nada por tu tiempo de ejecución.

### Mecanismo 1: te permite no asignar en absoluto

Este es el grande, y en realidad no es el span quien hace el trabajo. El span es el manejador seguro que hace usable a `stackalloc`. Un pequeño búfer temporal (formatear un número, construir una clave de búsqueda, calcular el hash de unos pocos bytes) tradicionalmente significaba un `new byte[n]` o `new char[n]` en el heap, que luego el GC tiene que recolectar. Con `stackalloc`, el búfer vive en el marco de la pila y desaparece gratis cuando el método retorna. El `Span<T>` es cómo lees y escribes esa memoria de la pila de forma segura.

```csharp
// .NET 11, C# 14 -- format an int to text with zero heap allocation
public static string ToHex(int value)
{
    Span<char> buffer = stackalloc char[8];   // on the stack, not the heap
    value.TryFormat(buffer, out int written, "X");
    return new string(buffer[..written]);     // the only allocation is the final string
}
```

La ganancia se mide en presión sobre el GC, no en velocidad bruta de bucle. Asigna un millón de búferes diminutos y desechables por segundo y generas un millón de objetos que el recolector de gen-0 tiene que recorrer. Muévelos a `stackalloc` y esa presión llega a cero. En una ruta caliente, eliminar asignaciones suele ser una ganancia de extremo a extremo mayor que recortar instrucciones de un bucle, porque las pausas del GC afectan a todo el proceso, no solo a tu método. Este es el mismo instinto detrás de [params ReadOnlySpan<T> eliminando las asignaciones de params](/es/2026/01/c-13-the-end-of-params-allocations/): la asignación más rápida es la que nunca ocurre.

### Mecanismo 2: te permite segmentar sin copiar

El segundo mecanismo es `Slice`. En una `string`, tomar una subcadena con `Substring` asigna una `string` totalmente nueva y copia los caracteres. En un array, `GetRange` o el `Skip`/`Take` de LINQ materializándose en una nueva colección también copian. El `Slice` de un span no hace ninguna de las dos cosas: devuelve otro span que apunta a la misma memoria, con el desplazamiento y la longitud ajustados. Cero copia, cero asignación.

```csharp
// .NET 11, C# 14 -- parse "2026-06-20" with no substring allocations
public static (int Year, int Month, int Day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));  // no new string
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

var parsed = ParseIsoDate("2026-06-20");      // string converts to ReadOnlySpan<char> implicitly
```

Cada `int.Parse` aquí lee directamente de una porción de la cadena original. La versión antigua con `date.Substring(0, 4)` asignaría tres cadenas de vida corta por llamada. En un parser que recorre millones de líneas, eso son millones de asignaciones evitadas. Las sobrecargas de span de `int.Parse`, `DateTime.Parse`, `Guid.Parse` y compañía existen precisamente para que puedas analizar a partir de porciones sin materializar nunca una subcadena. Esta es la columna vertebral del análisis rápido de CSV y logs, razón por la que [leer un CSV grande sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) se apoya en la segmentación con spans para recorrer cada línea en su sitio.

### Mecanismo 3: el JIT elimina las comprobaciones de límites en bucles ajustados

El tercer mecanismo es el más sutil y el que la gente más a menudo invoca sin entenderlo. Cuando iteras un span con un bucle `for` acotado por `span.Length`, el JIT puede demostrar que cada índice está dentro de rango y eliminar por completo la comprobación de límites por elemento. Reconoce el patrón `for (int i = 0; i < span.Length; i++)` y sabe que `span[i]` no puede estar fuera de rango, así que descarta la comparación y bifurcación que de otro modo protegería cada acceso. El equipo del JIT de Microsoft ha pasado años enseñando a RyuJIT a reconocer las comprobaciones de límites de un span igual que reconoce las de un array, y .NET 10 hizo que el análisis de aserciones subyacente dependiera menos del orden para que más formas de bucle califiquen, como documenta el artículo [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/).

Compáralo con iterar una `List<T>` a través de su enumerador. `List<T>.Enumerator.MoveNext` ejecuta una comprobación de versión en cada paso (el mecanismo que lanza `InvalidOperationException` si mutas la lista en mitad de la iteración) más una comprobación de límites. Esa comprobación de versión es una característica de corrección, no un desperdicio, pero cuesta ciclos que un span nunca paga.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x -- dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;

    [GlobalSetup]
    public void Setup() => _list = new List<int>(Enumerable.Range(0, 10_000));

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // version + bounds check per step
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // a view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }
}
```

Resultados representativos en un build de Ryzen 7 / Windows 11 / .NET 11, x64 RyuJIT:

| Method        | Mean   | Ratio | Allocated |
| ------------- | ------ | ----- | --------- |
| `ListForeach` | 6.1 us | 1.00  | 0 B       |
| `SpanForeach` | 2.4 us | 0.39  | 0 B       |

Aproximadamente 2,5 veces más rápido, sin asignación en ninguno de los dos (la lista ya existe; `CollectionsMarshal.AsSpan` te entrega un span sobre su array de respaldo sin copiar). La proporción exacta cambia con el tipo de elemento y la CPU, pero la dirección es estable. Fíjate en la unidad, eso sí: son microsegundos sobre 10 000 elementos. Ese número es la razón completa de la siguiente sección.

## Cuándo Span<T> no hace nada por ti

Aquí está la parte que la versión de culto cargo de este consejo omite. Un span solo ayuda cuando uno de esos tres mecanismos está en juego. Mételo en código que no active ninguno y habrás escrito código más restringido para un tiempo de ejecución idéntico. Peor aún, puede que lo hayas hecho más lento o que deje de compilar.

**Conviertes a un span e inmediatamente copias hacia fuera.** Si tu "optimización" es `array.AsSpan().ToArray()` o segmentar un span solo para hacer `.ToArray()` del resultado, asignaste de todos modos. La copia es el costo; el span delante de ella no aportó nada. La ganancia del mecanismo 2 existe solo mientras sigas leyendo a través de la vista.

**El bucle no es caliente.** El mecanismo 3 ahorró 3,7 microsegundos sobre 10 000 elementos. Si ese bucle se ejecuta una vez por petición web, o unos pocos cientos de veces en total, nunca medirás la diferencia frente a la latencia de red y base de datos que la empequeñecen en cinco órdenes de magnitud. Retorcer código legible para recortar microsegundos de una ruta fría es una pérdida neta: pagas en claridad y restricciones por una aceleración que nadie puede observar. Los spans se ganan su sitio en parsers, serializadores y bucles internos que se ejecutan millones de veces, no en el recorrido ocasional de una colección.

**Ya tenías un array y solo lo lees secuencialmente.** Un `foreach` simple sobre un `T[]` ya obtiene la eliminación de comprobaciones de límites del JIT; los arrays son el caso original para el que se construyó esa optimización. Envolver el array en un span primero no hace el bucle más rápido, porque el bucle del array ya era rápido. El span ayuda cuando la fuente es una `List<T>` (cuyo enumerador carga la comprobación de versión) o cuando necesitas segmentar, no cuando ya tienes un array y lo recorres de principio a fin.

**Fuerzas un `stackalloc` que es demasiado grande.** El mecanismo 1 solo gana con búferes pequeños. Un `stackalloc` de tamaño grande o controlado por el llamador arriesga un desbordamiento de pila, que es una caída, no una ruta lenta. La guía habitual es limitar `stackalloc` a una constante pequeña (comúnmente de unos pocos cientos de bytes a ~1 KB) y recurrir a un array agrupado o del heap por encima de eso. Un span sobre un `stackalloc` demasiado grande no es más rápido, es una `StackOverflowException` latente.

La prueba honesta antes de recurrir a un span: ¿cuál de los tres mecanismos estoy comprando? Si no puedes nombrar uno, estás recurriendo al tipo por costumbre. La [guía de decisión List vs Span vs ReadOnlySpan](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) recorre el eje completo de propiedad y tiempo de vida si estás eligiendo entre ellos para un campo o valor de retorno específico.

## Las restricciones, y por qué existen

Toda restricción sobre `Span<T>` se deriva de un hecho: es un `ref struct`, así que el runtime lo obliga a vivir solo en la pila. Eso es lo que lo hace seguro para apuntar a memoria de `stackalloc`, y es innegociable.

**No puede cruzar un `await` ni un `yield`.** Cuando un método espera con await, el compilador iza cada variable local que sobrevive al await a una máquina de estados asignada en el heap. Un tipo que solo vive en la pila no puede ser izado, así que el compilador rechaza una variable local `Span<T>` que abarque un `await`. Esta es la restricción con la que la gente choca primero. Si necesitas un búfer que cruce una frontera asíncrona, usa `Memory<T>` o `ReadOnlyMemory<T>`, los primos amigables con el heap; [convertir un array a ReadOnlyMemory<T>](/es/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) cubre los tipos de vista seguros frente a await.

**No puede ser un campo de una clase, estar en caja (boxed) ni ser capturado en una lambda.** No puedes escribir `class C { Span<int> _buf; }`, no puedes asignar un span a `object` ni cerrar sobre uno en una clausura. Cada una de esas cosas dejaría que el span escapara de su marco de pila, lo cual el tipo prohíbe. En cuanto tu diseño necesita que la vista sobreviva al método actual, la respuesta es una `List<T>`, un `T[]` o un manejador `Memory<T>`.

**El uso genérico necesita `allows ref struct`.** Antes de C# 13 no podías usar `Span<T>` como argumento de tipo genérico en absoluto. La antirrestricción `allows ref struct` de C# 13 levantó eso, pero solo para métodos y tipos genéricos que optan explícitamente con `where T : allows ref struct`. Una API genérica más antigua que no ha optado por ello todavía no puede tomar un span.

**Una vista de `CollectionsMarshal.AsSpan` es válida solo hasta que la lista cambia de tamaño.** Ese span apunta al array de respaldo actual de la lista. Haz `Add` suficientes como para disparar un redimensionamiento y la lista asigna un nuevo array, dejando tu span apuntando al viejo, ahora huérfano. Usa ese span de inmediato y deséchalo; nunca lo mantengas a través de una llamada que mute la lista.

Una comodidad más llegó en C# 14: los arrays ahora se convierten en spans de forma implícita, así que escribes `ReadOnlySpan<char> s = "GET"u8` y pasas `myArray` donde se espera un span sin un `.AsSpan()` visible. El artículo [conversiones implícitas de Span en C# 14](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cubre exactamente qué conversiones hace ahora el compilador por ti.

## La versión corta

`Span<T>` es una vista sin asignación y solo en la pila sobre memoria que ya posees. Hace el código más rápido de tres formas específicas: te permite reemplazar búferes del heap con `stackalloc`, te permite segmentar cadenas y arrays sin copiar, y le da al JIT una forma de bucle de la que puede eliminar comprobaciones de límites. Esas ganancias son reales y grandes en parsers, serializadores y bucles internos calientes que se ejecutan millones de veces. Son invisibles en rutas frías, y se evaporan por completo si copias hacia fuera del span, si tu fuente ya es un array que recorres secuencialmente, o si no hay ningún bucle caliente medido. Y como es un `ref struct`, se detiene en el primer `await`, campo o clausura de tu diseño. Recurre a él cuando puedas nombrar cuál de los tres mecanismos estás comprando. Si no puedes, estás añadiendo restricciones por una aceleración que no está ahí.

## Relacionados

- [List<T> vs Span<T> vs ReadOnlySpan<T> en C#: cuándo usar cada uno](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) es la guía de decisión cuando estás eligiendo entre los tres para un campo o retorno específico.
- [Cómo convertir T[] a ReadOnlyMemory<T> en C#](/es/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) es la ruta segura frente a await cuando un span no puede cruzar un `await`.
- [Cómo usar SearchValues<T> correctamente en .NET 11](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) se basa en `ReadOnlySpan<T>` para búsqueda multi-aguja acelerada con SIMD.
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) analiza cada línea en su sitio con segmentación de spans.
- [Conversiones implícitas de Span en C# 14](/es/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cubre las conversiones que permiten a los llamadores omitir `.AsSpan()`.

## Fuentes

- [Referencia del struct System.Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Guías de uso de Memory<T> y Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Performance Improvements in .NET 10 (.NET Blog)](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/)
- [Antirrestricción allows ref struct (MS Learn, C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [Referencia de CollectionsMarshal.AsSpan (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
