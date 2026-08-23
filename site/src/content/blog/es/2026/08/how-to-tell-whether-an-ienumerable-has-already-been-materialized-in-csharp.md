---
title: "Cómo saber si un IEnumerable<T> ya fue materializado en C#"
description: "No existe una bandera HasBeenEnumerated en IEnumerable<T>. Esto es lo que TryGetNonEnumeratedCount comprueba en realidad, por qué Enumerable.Range pasa una prueba de ICollection<T> y la guarda que evita un ToList() desperdiciado."
pubDate: 2026-08-23
tags:
  - "csharp"
  - "linq"
  - "dotnet"
  - "performance"
lang: "es"
translationOf: "2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-23
---

No existe ninguna API en .NET que responda "¿esta secuencia `IEnumerable<T>` ya fue enumerada?", y tampoco existe una que responda "¿esta secuencia está respaldada por memoria?". La interfaz tiene exactamente un miembro, `GetEnumerator()`, y nada en el contrato obliga a una implementación a recordar que la llamaste. Lo que sí obtienes es `Enumerable.TryGetNonEnumeratedCount` (.NET 6 y posteriores), que te dice si el *conteo* es barato, más un conjunto de pruebas de tipo que puedes ejecutar tú mismo. Esas dos señales se solapan con "ya materializado", pero no son lo mismo, y en esas diferencias viven los errores. Todo lo que sigue se midió en .NET 10.0.201 con C# 14.

## Por qué la pregunta no tiene respuesta directa

`IEnumerable<T>` es una fábrica de enumeradores, no un contenedor. Llamar a `GetEnumerator()` dos veces es legal, y cada llamada tiene derecho a producir un recorrido fresco e independiente sobre los datos. Un `List<int>` te entrega un enumerador struct sobre un arreglo existente. Un método con `yield return` construye una máquina de estados que ejecuta el cuerpo de tu método desde el principio. Un `DbSet<T>` abre una conexión y emite SQL. Los tres satisfacen la misma interfaz, y solo el primero mantiene los elementos en memoria.

Así que "¿ya fue materializado?" se divide en tres preguntas distintas que la gente confunde:

1. ¿Los elementos ya están en memoria, de modo que una segunda pasada sea gratis?
2. ¿El conteo está disponible sin recorrer la secuencia?
3. ¿*Este objeto de secuencia en particular* ya fue recorrido una vez?

La BCL da una respuesta parcial a (1), una buena respuesta a (2) y ninguna respuesta a (3).

## Lo que el runtime sí rastrea: la máquina de estados del iterador

Los iteradores generados por el compilador sí llevan un campo de estado, y puedes mirarlo. Es una ayuda de depuración, no una API, pero vale la pena verlo una vez porque explica el comportamiento que observas:

```csharp
// .NET 10.0.201, C# 14
static IEnumerable<int> Lazy()
{
    yield return 1;
    yield return 2;
}

static string ReadState(object o)
{
    var f = o.GetType().GetField("<>1__state",
        BindingFlags.Instance | BindingFlags.NonPublic);
    return f is null ? "no state field" : $"{f.GetValue(o)}";
}

var seq = Lazy();
Console.WriteLine(ReadState(seq));      // -2  : constructed, never enumerated
var e = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, e)); // True : the first call returns "this"
e.MoveNext();
Console.WriteLine(ReadState(seq));      // 1   : mid-enumeration
```

El centinela `-2` es la ruta rápida del compilador: la primera llamada a `GetEnumerator()` en el hilo creador cambia el estado a `0` y devuelve el mismo objeto en lugar de asignar un clon. Cada llamada posterior devuelve un clon con su propio estado. Por eso el segundo enumerador reinicia desde el principio mientras el primero conserva su posición, y por eso no hay un bit compartido de "ya enumerado" que puedas leer. Reflexionar sobre `<>1__state` te habla de un objeto, en una ruta de código, para un compilador; no lo lleves a producción.

## TryGetNonEnumeratedCount, y exactamente qué comprueba

Agregado en .NET 6 y con la misma forma en .NET 11, `Enumerable.TryGetNonEnumeratedCount` es la única primitiva soportada de "puedo mirar sin tocar". La [implementación del runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs) son tres pruebas de tipo en orden:

```csharp
// System.Linq.Enumerable, .NET 10, abridged
public static bool TryGetNonEnumeratedCount<TSource>(
    this IEnumerable<TSource> source, out int count)
{
    if (source is ICollection<TSource> collectionoft) { count = collectionoft.Count; return true; }
    if (source is Iterator<TSource> iterator)
    {
        int c = iterator.GetCount(onlyIfCheap: true);
        if (c >= 0) { count = c; return true; }
    }
    if (source is ICollection collection) { count = collection.Count; return true; }
    count = 0;
    return false;
}
```

`Iterator<TSource>` es la clase base interna de los iteradores propios de LINQ, así que la rama del medio es la parte que no puedes replicar desde fuera de `System.Linq`. Las [observaciones documentadas](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) lo dicen sin rodeos: "una serie de pruebas de tipo que identifican subtipos comunes cuyo conteo puede determinarse sin enumerar".

Pasar todas las formas comunes de secuencia por ese método, más las pruebas de tipo que escribirías a mano, da esto en .NET 10.0.201:

| Secuencia | `TryGetNonEnumeratedCount` | `is ICollection<T>` | `is IReadOnlyCollection<T>` | `is IQueryable` |
| --- | --- | --- | --- | --- |
| `int[]` | true, 3 | true | true | false |
| `List<int>` | true, 3 | true | true | false |
| `HashSet<int>` | true, 3 | true | true | false |
| `Queue<int>` | true, 3 | **false** | true | false |
| `Stack<int>` | true, 3 | **false** | true | false |
| `ReadOnlyCollection<int>` | true, 3 | true | true | false |
| `ImmutableArray<int>` | true, 3 | true | true | false |
| `Enumerable.Empty<int>()` | true, 0 | true | true | false |
| `Enumerable.Range(0, 1_000_000_000)` | **true, 1000000000** | **true** | true | false |
| `Enumerable.Repeat(7, 500)` | true, 500 | true | true | false |
| `list.Select(x => x)` | **true, 3** | false | false | false |
| `list.Where(x => true)` | false | false | false | false |
| `list.Take(2)` | true, 2 | **true** | true | false |
| `list.Skip(1)` | true, 2 | **true** | true | false |
| `list.OrderBy(x => x)` | true, 3 | false | false | false |
| `list.Distinct()` | false | false | false | false |
| `list.Concat(list)` | true, 6 | false | false | false |
| `((IEnumerable)list).Cast<int>()` | true, 3 | true | true | false |
| `list.DefaultIfEmpty()` | true, 3 | false | false | false |
| `Enumerable.Reverse(list)` | true, 3 | false | false | false |
| `list.GroupBy(x => x).SelectMany(g => g)` | false | false | false | false |
| método iterador con `yield return` | false | false | false | false |
| `list.AsQueryable()` | false | false | false | **true** |
| `list.ToList()` / `.ToArray()` | true, 3 | true | true | false |

## Tres trampas escondidas en esa tabla

**Un conteo barato no es una secuencia materializada.** `Enumerable.Range(0, 1_000_000_000)` reporta un conteo de mil millones en tiempo constante y pasa `is ICollection<int>`, pero no se asignó nada. `RangeIterator` implementa `IList<T>` desde .NET 8; en .NET 6 y .NET 7 la misma expresión falla la prueba de `ICollection<T>` porque el iterador solo implementaba el interno `IPartition<int>`. Si tu código dice `if (source is ICollection<T>) { /* safe to keep the reference */ }`, también estás diciendo "es seguro conservar una secuencia de mil millones de elementos y enumerarla dos veces".

La misma trampa aparece con `Select`. `list.Select(x => x)` devuelve `true` desde `TryGetNonEnumeratedCount` con el conteo de la lista de origen, porque el conteo de una proyección es igual al de su origen. El selector no se ejecutó para ni un solo elemento. Obtener el conteo no te dijo nada sobre si el trabajo está hecho.

**`ICollection<T>` se pierde dos tipos muy comunes.** `Queue<T>` y `Stack<T>` implementan la `ICollection` no genérica y la genérica `IReadOnlyCollection<T>`, pero no `ICollection<T>`. Una guarda escrita como `source as ICollection<T>` cae en silencio a una copia defensiva en ambos casos. `IReadOnlyCollection<T>` es la mejor prueba si todo lo que necesitas es `Count` y enumeración repetida.

**Diferido no significa incontable, y contable no significa barato de recorrer.** `Where` y `Distinct` devuelven `false` incluso cuando el origen es un `List<int>`, porque el predicado decide el conteo. `OrderBy` devuelve `true` con el conteo del origen, pero enumerarlo todavía realiza una ordenación completa. No trates un resultado `true` como permiso para enumerar libremente.

## Un ICollection<T> perezoso derrota toda comprobación

Toda técnica aquí es una prueba de tipo, y una prueba de tipo puede ser satisfecha por una implementación que hace trabajo costoso en cada `GetEnumerator()`. Esto no es hipotético: una navegación de colección de EF Core bajo proxies de carga diferida es un `ICollection<T>` cuya enumeración puede golpear la base de datos.

```csharp
// .NET 10.0.201, C# 14
sealed class LazyCollection : ICollection<int>
{
    public static int WorkDone;
    public int Count => 3;              // cheap, known up front
    public bool IsReadOnly => true;
    public IEnumerator<int> GetEnumerator()
    {
        WorkDone++;                     // expensive, runs on every pass
        return Enumerable.Range(0, 3).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    // mutating members omitted
}
```

Ese tipo reporta `is ICollection<int> == true` y `TryGetNonEnumeratedCount == true` con un conteo de 3, sin haber hecho trabajo alguno. Un `foreach` después, `WorkDone` vale 1, y sube en cada pasada posterior. Ninguna API puede distinguir esto de un `List<int>`. Si controlas el límite, la solución es dejar de pasar `IEnumerable<T>` y empezar a pasar `IReadOnlyList<T>` o un tipo concreto, lo que convierte una suposición en tiempo de ejecución en una garantía en tiempo de compilación. Ese es el mismo argumento para [elegir el tipo de retorno correcto entre IEnumerable, IAsyncEnumerable e IQueryable](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/).

## La guarda que vale la pena escribir

En la práctica nadie quiere una bandera `HasBeenEnumerated`. Quieren saber si un `ToList()` defensivo va a desperdiciarse. Responde esa pregunta directamente:

```csharp
// .NET 10.0.201, C# 14
public static IReadOnlyCollection<T> Materialize<T>(this IEnumerable<T> source)
{
    ArgumentNullException.ThrowIfNull(source);

    return source switch
    {
        // Deferred against a remote store: always pull it in, once.
        IQueryable<T> q => q.ToList(),

        // Known in-memory BCL types: reuse the reference, no copy.
        T[] a => a,
        List<T> l => l,
        IReadOnlyCollection<T> c when c.GetType().Assembly == typeof(List<T>).Assembly => c,

        _ => source.ToList(),
    };
}
```

La rama `IQueryable<T>` va primero porque un queryable es el único caso donde una segunda enumeración es inequívocamente un segundo viaje de ida y vuelta, y donde las pruebas de tipo de LINQ devuelven `false` de todos modos. La comprobación de ensamblado en la tercera rama es deliberadamente conservadora: acepta `Queue<T>`, `Stack<T>`, `ReadOnlyCollection<T>` y compañía mientras rechaza el `LazyCollection` de arriba y cualquier tipo de navegación de un ORM. Si tu código base no tiene colecciones respaldadas de forma perezosa, reduce esa rama a un simple `IReadOnlyCollection<T> c => c` y quédate con la versión de una línea.

Fíjate en lo que *no* está en la guarda: `TryGetNonEnumeratedCount`. Responde a otra pregunta. Úsalo cuando de verdad quieras un conteo y estés dispuesto a recurrir a un plan B, que es el patrón para el que fue diseñado:

```csharp
// .NET 10.0.201, C# 14
int capacity = source.TryGetNonEnumeratedCount(out int known) ? known : 16;
var buffer = new List<T>(capacity);
```

## Lo que ahorra la guarda

Medido con `Stopwatch` y `GC.GetAllocatedBytesForCurrentThread`, 100 iteraciones, sobre un `List<int>` de 1 000 000 de elementos pasado como `IEnumerable<int>`, .NET 10.0.201 en Release:

| Enfoque | Tiempo | Asignado |
| --- | --- | --- |
| `input.ToList()` | 793.93 us/op | 4 000 056 bytes/op |
| `input as IReadOnlyCollection<int> ?? input.ToList()` | 1.09 us/op | 0 bytes/op |

Son tiempos gruesos de bucle, no números de BenchmarkDotNet, pero la columna de asignaciones es exacta y es lo importante: la copia a ciegas asigna un segundo arreglo de respaldo de cuatro megabytes en el montón de objetos grandes en cada llamada, y la guarda no asigna nada. En una ruta caliente que recibe una lista ya materializada, la copia defensiva es el costo completo del método. El mismo razonamiento aplica siempre que intentas [leer un archivo grande sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

## Deja que el analizador encuentre los puntos de llamada

No tienes que auditar esto a mano. CA1851, "Possible multiple enumerations of 'IEnumerable' collection", se introdujo en .NET 7 y sigue **sin estar habilitado por defecto en .NET 10**. Actívalo:

```ini
# .editorconfig
[*.{cs,vb}]
dotnet_diagnostic.CA1851.severity = warning
```

Con `EnableNETAnalyzers` y `AnalysisLevel` puestos en `latest`, este código produce dos diagnósticos en .NET 10.0.201:

```csharp
public static void Twice(IEnumerable<int> input)
{
    var count = input.Count();              // CA1851
    foreach (var i in input) { _ = i; }     // CA1851
}
```

```text
warning CA1851: Possible multiple enumerations of 'IEnumerable' collection.
Consider using an implementation that avoids multiple enumerations.
```

Reescribir el cuerpo para enlazar primero a través de una guarda elimina ambas advertencias:

```csharp
public static void Guarded(IEnumerable<int> input)
{
    var list = input as IReadOnlyCollection<int> ?? input.ToList();
    var count = list.Count;
    foreach (var i in list) { _ = i; }
}
```

Dos perillas de configuración importan en código base real. `enumeration_methods` te deja registrar tus propios métodos que consumen un argumento `IEnumerable`, y `assume_method_enumerates_parameters` invierte la suposición por defecto, que actualmente es que un método propio *no* enumera lo que le pasas. Ese valor por defecto es la razón por la que CA1851 se queda callado cuando pasas la misma secuencia a dos de tus propios ayudantes.

## IQueryable e IAsyncEnumerable necesitan reglas aparte

Para `IQueryable<T>`, nada de esto aplica: toda prueba de tipo devuelve `false`, y cada enumeración es una nueva traducción del proveedor y un nuevo viaje de ida y vuelta. La señal que quieres es el tipo estático, y la solución es llamar a `ToListAsync()` una vez en el límite. La enumeración repetida de un queryable dentro de un bucle es una de las formas detrás de [los problemas de consultas N+1 en EF Core](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), y una consulta que no puede traducirse en absoluto produce [el error "The LINQ expression could not be translated"](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) en lugar de un doble viaje silencioso.

Para `IAsyncEnumerable<T>` no hay `TryGetNonEnumeratedCount` en absoluto, ni equivalente de `ICollection<T>`, ni conteo barato. La única forma de saber cuántos elementos contiene una secuencia asíncrona es esperarlos todos, que es exactamente lo que [IAsyncEnumerable está diseñado para evitarte](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/). Materializa una vez con `await source.ToListAsync()` y pasa la lista, o reestructura para que una sola pasada sea suficiente.

El resumen honesto es que "¿esto ya fue materializado?" no tiene respuesta y "¿será barata una segunda pasada?" sí la tiene la mayoría de las veces. Comprueba `IQueryable<T>` primero, luego `IReadOnlyCollection<T>` en vez de `ICollection<T>`, trata `TryGetNonEnumeratedCount` como una pista de capacidad y no como una comprobación de materialización, y deja que CA1851 te diga dónde te olvidaste.

## Relacionados

- [IEnumerable vs IAsyncEnumerable vs IQueryable en C#: ¿cuál debe devolver el método?](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [¿Qué es IAsyncEnumerable&lt;T&gt; y cuándo debo usarlo?](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Solución: "The LINQ expression could not be translated" en EF Core 11](/es/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Fuentes

- [Enumerable.TryGetNonEnumeratedCount&lt;TSource&gt; Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) en MS Learn
- [Count.cs en dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs), la implementación de las pruebas de tipo
- [Range.SpeedOpt.cs en dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Range.SpeedOpt.cs), donde `RangeIterator` declara `IList<T>`
- [CA1851: Possible multiple enumerations of 'IEnumerable' collection](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1851) en MS Learn
- [Ejecución diferida y evaluación perezosa en LINQ](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation) en MS Learn
