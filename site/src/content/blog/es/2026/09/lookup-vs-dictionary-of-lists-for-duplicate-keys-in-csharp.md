---
title: "Lookup<TKey, TElement> vs Dictionary<TKey, List<TValue>> para claves duplicadas en C#"
description: "Usa ToLookup cuando agrupas una sola vez y solo lees: es inmutable, devuelve una secuencia vacía para claves inexistentes, acepta claves null y conserva el orden de primera aparición. Usa Dictionary<TKey, List<TValue>> cuando los grupos cambian después de la construcción o cruzan una frontera JSON."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "collections"
  - "performance"
lang: "es"
translationOf: "2026/09/lookup-vs-dictionary-of-lists-for-duplicate-keys-in-csharp"
translatedBy: "claude"
translationDate: 2026-09-12
---

Cuando una clave tiene que mapearse a muchos valores en C#, las dos respuestas integradas son `ILookup<TKey, TElement>` (lo que devuelve `Enumerable.ToLookup`) y un `Dictionary<TKey, List<TValue>>` escrito a mano. **Elige `ToLookup` cuando construyes la agrupación una sola vez a partir de una secuencia existente y después solo la lees**: es una línea, es inmutable, devuelve una secuencia vacía en lugar de lanzar una excepción para una clave inexistente, acepta una clave `null` y enumera los grupos en orden de primera aparición. **Elige `Dictionary<TKey, List<TValue>>` cuando los grupos cambian después de la construcción, cuando necesitas `TryGetValue` o cuando el resultado tiene que ir y volver a través de JSON.** El rendimiento se inclina hacia el diccionario, pero no lo suficiente para decidir la mayoría de los casos: en .NET 11 RC 1 un diccionario escrito a mano se construye alrededor de un 30% más rápido que `ToLookup` y lee entre un 3 y un 13% más rápido, lo que para 100,000 elementos es menos de 2 ms. Todo lo que sigue se ejecutó en .NET 11 RC 1 (runtime `11.0.0-rc.1.26425.128`, C# 15), y el comportamiento descrito se ha mantenido estable desde que `ToLookup` llegó en .NET Framework 3.5.

## Las dos formas lado a lado

| Comportamiento (.NET 11 RC 1)               | `ILookup<TKey, TElement>` vía `ToLookup` | `Dictionary<TKey, List<TValue>>`        |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Agregar o quitar después de la construcción | no, inmutable                            | sí                                      |
| Indexador con una clave inexistente         | secuencia vacía                          | `KeyNotFoundException`                  |
| Clave `null`                                | permitida                                | `ArgumentNullException`                 |
| Orden de enumeración de los grupos          | orden de primera aparición de la clave, por construcción | orden de inserción en la práctica, no garantizado |
| Orden de los elementos dentro de un grupo   | orden de la fuente                       | el orden en que hagas `Add`             |
| `TryGetValue`                               | no (`Contains` + indexador)              | sí                                      |
| Constructor público                         | no                                       | sí                                      |
| Serialización con `System.Text.Json`        | arreglo de arreglos, se pierden las claves | objeto indexado por `TKey`            |
| Deserialización con `System.Text.Json`      | `NotSupportedException`                  | sí                                      |
| Construir 100k elementos, 100 claves        | 660 us, 1.91 MB                          | 477 us, 1.91 MB                         |
| Leer 1,000 sondeos, 10,000 claves           | 66.1 us, 29,344 B                        | 61.0 us, 0 B                            |

Las filas que deciden la mayoría de los casos reales son las dos primeras y las de JSON. El resto son detalles que te muerden más tarde si elegiste por el eje equivocado.

## Lo que ToLookup construye realmente

`Lookup<TKey, TElement>` no tiene constructor público. `Enumerable.ToLookup` es la única forma de obtener uno, y el código fuente en [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) muestra exactamente lo que recibes:

- El tipo en tiempo de ejecución es un `CollectionLookup<TKey, TElement>` interno, una subclase del `Lookup<TKey, TElement>` público que además implementa `ICollection<IGrouping<TKey, TElement>>` con cada miembro mutador lanzando `NotSupportedException`.
- Es su propia pequeña tabla hash: un arreglo de buckets `Grouping<TKey, TElement>`, con un tamaño que es un número primo y que se redimensiona con `HashHelpers.ExpandPrime`, con encadenamiento a través de un campo `_hashNext`. No envuelve un `Dictionary`.
- Cada grupo es también un nodo de una lista enlazada circular, que se añade a medida que aparece cada clave nueva. La enumeración recorre esa lista, por eso los grupos vuelven en orden de primera aparición. Es una propiedad estructural del tipo, no un accidente de la disposición del hash.
- Cada `Grouping` guarda sus elementos en un `TElement[]` que empieza con longitud 1 y se duplica, igual que `List<T>`, e implementa `IList<TElement>` de solo lectura.
- Una clave `null` produce el hash `0` en lugar de llamar al comparador, así que `null` es una clave válida.
- Si la fuente es un arreglo vacío, obtienes un singleton compartido `EmptyLookup<TKey, TElement>.Instance` y no se asigna nada.

De esto se desprenden dos cosas. Primero, `ToLookup` es **inmediato**: recorre toda la fuente en el acto, a diferencia de `GroupBy`, que es diferido y construye el mismo `Lookup` interno cada vez que lo enumeras. Segundo, `lookup[key].Count()` es O(1), porque `Enumerable.Count` detecta la implementación de `ICollection<T>` en `Grouping` y lee el conteo directamente.

## Los comportamientos que realmente difieren

Aquí tienes un pequeño programa que ejercita cada fila de la tabla. Ejecútalo como aplicación de consola en .NET 11:

```csharp
// .NET 11 RC 1 (11.0.0-rc.1.26425.128), C# 15
var orders = new List<Order>
{
    new("alice", 1), new("bob", 2), new("alice", 3), new(null, 4), new("carol", 5),
};

var lookup = orders.ToLookup(o => o.Customer);
Console.WriteLine(lookup.GetType());                     // System.Linq.CollectionLookup`2[...]
Console.WriteLine(lookup.Count);                         // 4 (keys, not orders)
Console.WriteLine(lookup["dave"].Count());               // 0, no exception
Console.WriteLine(string.Join(",", lookup[null].Select(o => o.Id)));            // 4
Console.WriteLine(string.Join(",", lookup.Select(g => g.Key ?? "<null>")));     // alice,bob,<null>,carol

try { ((IList<Order>)lookup["alice"]).Add(new("alice", 99)); }
catch (NotSupportedException) { Console.WriteLine("groups are read-only"); }

// Eager vs deferred
var source = new List<Order> { new("x", 1) };
var eager = source.ToLookup(o => o.Customer);
var deferred = source.GroupBy(o => o.Customer);
source.Add(new("x", 2));
Console.WriteLine(eager["x"].Count());       // 1, snapshot taken at ToLookup
Console.WriteLine(deferred.First().Count()); // 2, re-evaluated on enumeration

var map = new Dictionary<string, List<Order>>();
// map["dave"]      -> KeyNotFoundException
// map.Add(null!, []) -> ArgumentNullException

record Order(string? Customer, int Id);
```

La línea de inmediato frente a diferido es la que causa bugs reales. Si guardas un resultado de `GroupBy` en un campo y lo enumeras dos veces, pagas la agrupación dos veces y ves lo que contenga la fuente en ese momento. `ToLookup` toma una instantánea. Si no estás seguro de si una secuencia que recibiste ya fue materializada, [compruébalo antes de agruparla](/es/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/).

`Count` es la otra trampa: en un lookup es el número de **claves**, no el número de elementos. Para obtener el total de elementos necesitas `lookup.Sum(g => g.Count())`.

## Construir un Dictionary de listas sin la doble búsqueda

Si tomas el camino del diccionario, el patrón clásico calcula el hash de la clave dos veces por cada clave nueva (`TryGetValue` y luego `Add`):

```csharp
// .NET 11 RC 1, C# 15
var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    if (!map.TryGetValue(o.CustomerId, out var list))
    {
        list = new List<Order>();
        map.Add(o.CustomerId, list);
    }
    list.Add(o);
}
```

Desde .NET 6 puedes hacerlo con un solo sondeo del hash por elemento usando [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), que devuelve un `ref` a la ranura del valor e inserta una entrada por defecto cuando falta la clave:

```csharp
// .NET 11 RC 1, C# 15
using System.Runtime.InteropServices;

var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    ref var list = ref CollectionsMarshal.GetValueRefOrAddDefault(map, o.CustomerId, out _);
    (list ??= []).Add(o);
}
```

La documentación incluye una regla que debes respetar: no agregues ni quites entradas del diccionario mientras sostienes ese `ref`. En el bucle anterior el `ref` muere antes de la siguiente iteración, así que es seguro.

Si prefieres una sola línea de LINQ, `GroupBy(...).ToDictionary(g => g.Key, g => g.ToList())` funciona, pero asigna las agrupaciones intermedias y luego copia cada elemento a una lista nueva. Y si recurres al `AggregateBy` de .NET 9, usa la sobrecarga con `seedSelector`. La sobrecarga con `seed` entrega la **misma** instancia a cada clave:

```csharp
// .NET 11 RC 1, C# 15
var orders = new[] { new Order("alice", 1), new Order("bob", 2), new Order("alice", 3) };

var broken = orders.AggregateBy(o => o.Customer, seed: new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,2,3   bob: 1,2,3   <- one shared List

var correct = orders.AggregateBy(o => o.Customer, seedSelector: _ => new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,3     bob: 2
```

`AggregateBy` y su hermano `CountBy` son excelentes cuando quieres un único agregado por clave; cubrí el caso del conteo en [conteo de frecuencias con LINQ CountBy](/es/2026/01/optimizing-frequency-counting-with-linq-countby/). Para "todos los valores por clave", son la herramienta equivocada.

## El benchmark

BenchmarkDotNet 0.15.8 todavía no puede resolver el moniker `net11.0` (lanza `NotImplementedException` desde `GetRuntimeVersion`), así que estas pruebas se ejecutaron con `--inProcess` en .NET 11 RC 1, Arm64 RyuJIT, en un Apple M4 (10 núcleos, 16 GB) con macOS 26.6. La fuente son 100,000 registros `Order` con clave `int` `CustomerId`, con 100 o 10,000 claves distintas. El benchmark de lectura sondea 1,000 claves aleatorias, de las cuales el 10% no existen, y suma un campo `decimal` en cada grupo.

Construir la agrupación a partir de 100,000 pedidos:

| Método (.NET 11 RC 1)                          | Claves | Media    | Ratio | Asignado  |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `ToLookup`                                     | 100    | 660.1 us | 1.00  | 1.91 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 100    | 883.0 us | 1.34  | 2.69 MB   |
| Bucle `TryGetValue` + `Add`                    | 100    | 476.7 us | 0.72  | 1.91 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 100    | 485.8 us | 0.74  | 1.91 MB   |
| `ToLookup`                                     | 10,000 | 5,934 us | 1.00  | 3.86 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 10,000 | 7,537 us | 1.27  | 6.06 MB   |
| Bucle `TryGetValue` + `Add`                    | 10,000 | 4,070 us | 0.69  | 3.59 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 10,000 | 4,384 us | 0.74  | 3.59 MB   |

Leer 1,000 claves aleatorias y sumar cada grupo:

| Método (.NET 11 RC 1)                          | Claves | Media    | Ratio | Asignado  |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `foreach (var o in lookup[k])`                 | 100    | 3,736 us | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` sobre `List<T>`      | 100    | 3,617 us | 0.97  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 100    | 3,299 us | 0.88  | 0 B       |
| `foreach (var o in lookup[k])`                 | 10,000 | 66.1 us  | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` sobre `List<T>`      | 10,000 | 61.0 us  | 0.92  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 10,000 | 57.8 us  | 0.87  | 0 B       |

Destacan algunas cosas.

**El lookup es alrededor de 1.4x más lento de construir que un bucle simple, con asignaciones idénticas.** Ambos terminan con 1.91 MB con 100 claves, así que la diferencia es trabajo por elemento, no memoria. `ToLookup` invoca el delegado `keySelector` y llama a `IEqualityComparer<TKey>.GetHashCode` y `Equals` a través de la interfaz para cada elemento. `Dictionary<TKey, TValue>` trata de forma especial las claves de tipo valor sin comparador personalizado y llama directamente a `EqualityComparer<TKey>.Default`, que el JIT desvirtualiza e inserta en línea. Con claves `string` esa ventaja se reduce, porque el diccionario también pasa por un objeto comparador.

**`GroupBy(...).ToDictionary(...)` es lo peor de ambos mundos.** Construye el mismo lookup interno que construye `ToLookup` y luego copia cada grupo a un `List<T>` nuevo: entre un 27 y un 34% más lento que `ToLookup` y hasta un 57% más de memoria. Si quieres un diccionario, escribe el bucle.

**`CollectionsMarshal` no le ganó a `TryGetValue` aquí.** El doble hash solo ocurre cuando una clave aparece por primera vez, lo que pasa 100 o 10,000 veces de 100,000 elementos. La versión de un solo sondeo compensa cuando la mayoría de los elementos introducen una clave nueva, y nunca es más lenta de una forma que importe, así que sigue siendo mi opción por defecto para el bucle.

**Cada lectura del lookup asigna memoria.** El indexador devuelve `IEnumerable<TElement>`, y `Grouping.GetEnumerator` entrega un `PartialArrayEnumerator<TElement>` asignado en el heap: 29,344 bytes para aproximadamente 917 aciertos, 32 bytes cada uno. `List<T>` tiene un enumerador struct que `foreach` usa sin boxing, y `CollectionsMarshal.AsSpan` elimina el enumerador por completo para ganar otro 5-9%. Con 100 claves la lectura está dominada por sumar unos 1,000 valores `decimal` por grupo, por eso los ratios convergen.

La conclusión honesta es que ninguno de estos números debería elegir el tipo por ti. Si una agrupación está en una ruta lo bastante crítica como para que importen una diferencia del 10% en lectura y 32 bytes por sondeo, probablemente te sirva más un [`FrozenDictionary`](/es/2024/04/net-8-performance-dictionary-vs-frozendictionary/) construido una vez sobre arreglos, o iterar spans en lugar de `IEnumerable<T>`, que es el mismo compromiso que analicé en [List vs Span vs ReadOnlySpan](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Trampas que deciden por ti

**No puedes exponer un `Dictionary<TKey, List<TValue>>` como multimapa de solo lectura sin costo.** `IReadOnlyDictionary<TKey, TValue>` es invariante en `TValue`, así que esto no compila:

```csharp
// .NET 11 RC 1, C# 15
Dictionary<string, List<int>> map = new() { ["a"] = [1] };
IReadOnlyDictionary<string, IReadOnlyList<int>> ro = map;
// error CS0266: Cannot implicitly convert type 'Dictionary<string, List<int>>'
// to 'IReadOnlyDictionary<string, IReadOnlyList<int>>'
```

La conversión explícita que sugiere el compilador lanza `InvalidCastException` en tiempo de ejecución. Tus opciones son declarar el diccionario como `Dictionary<string, IReadOnlyList<int>>` desde el principio (y perder `Add` en los valores sin una conversión), copiarlo o devolver un `ILookup`, que es de solo lectura por construcción. Si "los llamadores no deben mutar esto" es un requisito, eso por sí solo es una buena razón para elegir el lookup.

**`ILookup` no sobrevive a JSON.** `System.Text.Json` lo serializa como un `IEnumerable<IGrouping<...>>`, así que obtienes `[[{...},{...}],[{...}]]` sin las claves, y deserializar en `ILookup<TKey, TElement>` lanza `NotSupportedException` porque la interfaz no se puede instanciar. Un `Dictionary<string, List<T>>` se serializa como `{"alice":[...],"bob":[...]}` y hace el viaje de ida y vuelta. Para respuestas de API y payloads en caché, convierte con `lookup.ToDictionary(g => g.Key, g => g.ToList())` en la frontera, o construye el diccionario desde el principio.

**No existe `TryGetValue` en `ILookup`.** `if (lookup.Contains(k)) use(lookup[k]);` calcula el hash de la clave dos veces. Como una clave inexistente ya devuelve una secuencia vacía, simplemente llama al indexador y deja que el caso vacío pase de largo. Usa `Contains` solo cuando "sin valores" y "clave ausente" deban tratarse de forma distinta, cosa que con un lookup nunca ocurre (una clave no puede existir con cero elementos).

**El comparador se fija en la construcción.** Ambos tipos aceptan un `IEqualityComparer<TKey>`. Para claves string, pasa `StringComparer.OrdinalIgnoreCase` a `ToLookup` o al constructor del diccionario; no puedes cambiarlo después en ninguno de los dos tipos.

**El orden de enumeración de Dictionary es un detalle de implementación.** Un `Dictionary` que solo ha tenido inserciones resulta enumerarse en orden de inserción, pero la documentación dice que el orden no está definido y un solo `Remove` seguido de un `Add` reutiliza la ranura liberada: en .NET 11 RC 1, las claves `a, b, c` seguidas de `Remove("a")` y `Add("d")` se enumeran como `d, b, c`. Si muestras los grupos en el orden en que aparecieron por primera vez, el lookup te da esa garantía de forma estructural.

**Ninguno de los dos tipos es thread-safe para escritores.** Los lookups son inmutables, así que las lecturas concurrentes no dan problema. Un diccionario de listas necesita un lock alrededor tanto del diccionario como de cada lista, y `ConcurrentDictionary<TKey, List<T>>` no lo resuelve, porque las listas internas siguen siendo `List<T>` simples. Si necesitas agregar elementos de forma concurrente, usa `ConcurrentDictionary<TKey, ConcurrentQueue<T>>` o una colección inmutable reemplazada de forma atómica.

**No hay un `MultiValueDictionary` incluido de serie.** Microsoft creó un prototipo en `Microsoft.Experimental.Collections` en 2014, pero nunca pasó al runtime y el repositorio corefxlab ahora está archivado. Para un multimapa mutable, el diccionario de listas sigue siendo la respuesta estándar.

## Cuál elegir

Usa `ToLookup` por defecto siempre que la agrupación sea un índice de solo lectura sobre datos que ya tienes: unir dos conjuntos en memoria, repartir filas en grupos para un reporte, precalcular hijos por padre para un árbol. Es más corto, no puede mutarse a tus espaldas, y el comportamiento con claves inexistentes y claves null elimina toda una categoría de código defensivo. Cambia a `Dictionary<TKey, List<TValue>>`, construido con `CollectionsMarshal.GetValueRefOrAddDefault`, cuando los grupos cambian durante la vida del objeto, cuando serializas el resultado o cuando escribes ese único bucle crítico en el que mediste que la diferencia en lectura importa. Si dudas entre exponer `IEnumerable<T>` o algo más rico desde el método que devuelve estos grupos, aplica el mismo razonamiento que en [IEnumerable vs IAsyncEnumerable vs IQueryable](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/): devuelve el tipo más estrecho que mantenga honestos a los llamadores, que para una agrupación terminada es `ILookup`.

### Relacionado

- [Cómo saber si un IEnumerable ya fue materializado en C#](/es/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [Optimizar el conteo de frecuencias con LINQ CountBy](/es/2026/01/optimizing-frequency-counting-with-linq-countby/)
- [Dictionary vs FrozenDictionary en .NET 8](/es/2024/04/net-8-performance-dictionary-vs-frozendictionary/)
- [List vs Span vs ReadOnlySpan en C#](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable en C#](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

### Fuentes

- [Clase `Lookup<TKey, TElement>`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.lookup-2), MS Learn
- [`Enumerable.ToLookup`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.tolookup), MS Learn
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), MS Learn
- [`Enumerable.AggregateBy`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.aggregateby), MS Learn
- [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) y [`Grouping.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Grouping.cs) en la etiqueta `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [MultiDictionary becomes MultiValueDictionary](https://devblogs.microsoft.com/dotnet/multidictionary-becomes-multivaluedictionary/), .NET Blog
- [Release the Microsoft.Experimental.Collections.MultiValueDictionary](https://github.com/dotnet/runtime/issues/14406), dotnet/runtime issue
