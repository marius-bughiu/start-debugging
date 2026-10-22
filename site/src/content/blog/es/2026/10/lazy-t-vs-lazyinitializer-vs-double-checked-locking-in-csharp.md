---
title: "Lazy<T> vs LazyInitializer.EnsureInitialized vs double-checked locking en C#"
description: "Usa Lazy<T> por defecto: ejecuta la factory una sola vez, almacena en caché las excepciones y sus lecturas son demasiado baratas para medirlas tras la inicialización. Usa LazyInitializer.EnsureInitialized cuando inicializas de forma diferida muchos campos o posiciones de un arreglo y no puedes pagar un objeto extra por valor. El double-checked locking escrito a mano casi nunca vale la pena en .NET 10."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "es"
translationOf: "2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-22
---

Usa `Lazy<T>` por defecto. Con el modo por defecto del constructor (`ExecutionAndPublication`), garantiza que la factory se ejecute exactamente una vez incluso bajo contención, almacena en caché la excepción de la factory y, una vez que el valor existe, una lectura es una comprobación de null más la carga de un campo, demasiado barata para que BenchmarkDotNet la mida. Recurre a `LazyInitializer.EnsureInitialized` cuando tengas muchos valores creados de forma diferida (un campo por propiedad en un tipo muy usado, o posiciones de un arreglo) y el objeto `Lazy<T>` extra por valor sea el costo que intentas evitar. El double-checked locking escrito a mano no te da nada que `LazyInitializer.EnsureInitialized(ref field, ref syncLock, factory)` no te dé ya, así que escríbelo solo cuando necesites un comportamiento que ninguna de las dos APIs ofrece.

Todo lo que sigue se midió en .NET 10.0.10 (SDK 10.0.302), C# 14, BenchmarkDotNet 0.15.8, en un Apple M4 (arm64). La forma de las APIs no ha cambiado desde .NET Core 3.0, así que el consejo vale para .NET 8, 9, 10 y 11.

## La comparación de un vistazo

| | `Lazy<T>` (por defecto) | `LazyInitializer.EnsureInitialized(ref t, f)` | `EnsureInitialized(ref t, ref sync, f)` | Double-checked locking |
| --- | --- | --- | --- | --- |
| La factory se ejecuta como máximo una vez bajo contención | Sí | No, cada hilo en la carrera puede ejecutarla | Sí | Sí, si está bien escrito |
| Excepción de la factory | En caché, se relanza siempre | Sin caché, la siguiente llamada reintenta | Sin caché, la siguiente llamada reintenta | Lo que escribas |
| Asignación extra por valor diferido | Objeto `Lazy<T>` más un auxiliar de bloqueo | Ninguna | Un objeto de bloqueo, solo si hay contención o en la primera llamada | Un objeto de bloqueo (o compartido) |
| Lectura frecuente tras inicializar (medida) | menos de 1 ns, no medible | menos de 1 ns | menos de 1 ns | menos de 1 ns |
| Creación + inicialización única (medida) | 13.96 ns, 96 B | 6.19 ns, 48 B | 14.03 ns, 80 B | 8.96 ns, 72 B |
| Funciona con tipos de valor | Sí | No (`where T : class`) | No, usa la sobrecarga con `ref bool initialized` | Sí, con una bandera aparte |
| La factory puede devolver `null` | Sí | No, lanza `InvalidOperationException` | No, lanza `InvalidOperationException` | Sí, con una bandera aparte |
| Reentrada desde la factory | Lanza `InvalidOperationException` | Desbordamiento de pila | Desbordamiento de pila (`Monitor` es reentrante) | Depende del tipo de bloqueo |
| Líneas de código que te tocan mantener | 1 | 1 | 2 campos + 1 llamada | ~10 |

## Qué hace realmente cada opción

### `Lazy<T>`

`Lazy<T>` envuelve una factory y un espacio de almacenamiento. Su propiedad `Value` en .NET 10 es una sola línea:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Lazy.cs
public T Value => _state == null ? _value! : CreateValue();
```

`_state` es una referencia `LazyHelper` volátil que describe el modo y, para `ExecutionAndPublication`, hace también de objeto de bloqueo. La primera llamada entra en `CreateValue`, que toma `lock (executionAndPublication)`, vuelve a comprobar, ejecuta tu factory, guarda `_value` y luego pone `_state = null` con una escritura volátil. Cada llamada posterior ve `_state == null` y devuelve el campo. Eso es double-checked locking, escrito una sola vez, por gente que ha leído la especificación del modelo de memoria con más cuidado que la mayoría de nosotros.

El modo de seguridad entre hilos se elige con el constructor:

```csharp
// .NET 10, C# 14
var a = new Lazy<Config>(LoadConfig);                                          // ExecutionAndPublication
var b = new Lazy<Config>(LoadConfig, isThreadSafe: true);                      // ExecutionAndPublication
var c = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.PublicationOnly);    // threads race, first publish wins
var d = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.None);               // single-threaded only
```

### `LazyInitializer.EnsureInitialized`

`LazyInitializer` es una clase estática que opera sobre un campo tuyo, a través de un `ref`. No hay objeto envoltorio. La sobrecarga de dos argumentos es, completa:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Threading/LazyInitializer.cs
public static T EnsureInitialized<T>(ref T? target, Func<T> valueFactory) where T : class =>
    Volatile.Read(ref target!) ?? EnsureInitializedCore(ref target, valueFactory);

private static T EnsureInitializedCore<T>(ref T? target, Func<T> valueFactory) where T : class
{
    T value = valueFactory() ?? throw new InvalidOperationException(SR.Lazy_StaticInit_InvalidOperation);
    Interlocked.CompareExchange(ref target, value, null!);
    return target;
}
```

Sin bloqueo. Cada hilo que ve `null` ejecuta la factory, y `CompareExchange` decide qué resultado se guarda. Los objetos de los perdedores se descartan sin más (y la documentación señala que el método "will not dispose of the objects that were not stored"). Es la semántica de `PublicationOnly` sin el envoltorio.

La sobrecarga de tres argumentos, `EnsureInitialized(ref target, ref syncLock, valueFactory)`, añade un bloqueo. Crea de forma diferida un `object` simple en `syncLock` con `CompareExchange` y luego hace `lock (syncLock) { if (Volatile.Read(ref target) == null) Volatile.Write(ref target, valueFactory()); }`. Eso es double-checked locking de manual, y ejecuta la factory una sola vez.

Para tipos de valor, o cuando `null` es un resultado legítimo, hay sobrecargas con una bandera extra `ref bool initialized`. Siempre toman el camino con bloqueo.

### Double-checked locking escrito a mano

La versión moderna correcta en .NET 9 y posteriores, usando el tipo `System.Threading.Lock`:

```csharp
// .NET 10, C# 14
public sealed class ReportCache
{
    private volatile Report? _report;
    private readonly Lock _lock = new();

    public Report Report
    {
        get
        {
            var r = _report;               // one volatile read on the fast path
            if (r is not null) return r;
            lock (_lock)
            {
                return _report ??= BuildReport();
            }
        }
    }

    private static Report BuildReport() => new();
}

public sealed class Report;
```

El `volatile` hace un trabajo real. La especificación del modelo de memoria de .NET (`docs/design/specs/Memory-model.md` en dotnet/runtime) sí dice que guardar una referencia a un objeto en memoria compartida es un release y que las lecturas con dependencia de datos a través de ella quedan ordenadas, así que el clásico bug del "objeto a medio construir" no puede ocurrir en CoreCLR. Pero también advierte explícitamente que los efectos de ordenación de la asignación de referencias no deben usarse para ordenar en general, y un campo no volátil permite que el JIT eleve o fusione las lecturas de `_report`. Márcalo `volatile`, o léelo con `Volatile.Read`, y el patrón es correcto en todas las arquitecturas en las que corre .NET.

## Demostrar el comportamiento bajo contención

La documentación dice "may run more than once". Yo quería un número. Esta prueba inicia 16 hilos sobre un `Barrier`, hace que todos accedan al valor diferido a la vez, usa una factory que gira unas 20 000 iteraciones para ampliar la ventana de la carrera, y se repite 200 veces, registrando la peor ronda:

```csharp
// .NET 10.0.10, C# 14, Apple M4, 10 cores
static int Race(Func<Func<object>, Func<object>> makeAccessor)
{
    int maxCalls = 0;
    for (int r = 0; r < 200; r++)
    {
        int calls = 0;
        Func<object> factory = () =>
        {
            Interlocked.Increment(ref calls);
            Thread.SpinWait(20_000);
            return new object();
        };
        var access = makeAccessor(factory);
        using var barrier = new Barrier(16);
        var results = new object[16];
        var threads = Enumerable.Range(0, 16)
            .Select(i => new Thread(() => { barrier.SignalAndWait(); results[i] = access(); }))
            .ToArray();
        foreach (var t in threads) t.Start();
        foreach (var t in threads) t.Join();
        if (results.Distinct().Count() != 1) throw new Exception("different instances returned");
        maxCalls = Math.Max(maxCalls, calls);
    }
    return maxCalls;
}
```

Resultados, la peor ronda de 200:

| Opción | Máximo de llamadas a la factory en una ronda |
| --- | --- |
| `Lazy<T>` por defecto (`ExecutionAndPublication`) | 1 |
| `Lazy<T>` `PublicationOnly` | 11 |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 12 |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 1 |

Todas las opciones devolvieron la misma instancia a los 16 hilos en cada ronda, así que ninguna es "insegura". La diferencia es trabajo desperdiciado. Si tu factory abre un socket, lee un archivo de 40 MB o llama a una API de pago, 12 ejecuciones en paralelo son un bug real aunque el valor publicado sea correcto.

## La trampa del almacenamiento en caché de excepciones

Esta es la diferencia de comportamiento que muerde en producción. La misma factory, falla en la primera llamada y funciona en la segunda:

```csharp
// .NET 10.0.10, C# 14
int attempts = 0;
Func<string> flaky = () => ++attempts == 1 ? throw new InvalidOperationException("transient") : "ok";

var lazy = new Lazy<string>(flaky);
// lazy.Value -> InvalidOperationException: transient
// lazy.Value -> InvalidOperationException: transient   (factory not called again)

string? field = null;
// LazyInitializer.EnsureInitialized(ref field, flaky) -> InvalidOperationException: transient
// LazyInitializer.EnsureInitialized(ref field, flaky) -> "ok"
```

La prueba lo confirmó: el `Lazy<T>` por defecto llamó a la factory una vez y lanzó la misma excepción en cada acceso posterior. `PublicationOnly` y `LazyInitializer` la llamaron dos veces y se recuperaron.

La tabla de excepciones de MS Learn expone la regla: cualquier constructor de `Lazy<T>` que reciba un `valueFactory` almacena las excepciones en caché, salvo que el modo sea `PublicationOnly`. El constructor sin parámetros (que usa `Activator.CreateInstance`) no las almacena. Así, un `Lazy<HttpClient>` cuya factory lee un valor de configuración que falta al arrancar lanzará durante toda la vida del proceso, incluso después de que la configuración aparezca. Si el fallo puede ser transitorio, usa `PublicationOnly`, usa `LazyInitializer` o reemplaza la instancia de `Lazy<T>` en un `catch`.

La misma trampa es el doble de traicionera con `Lazy<Task<T>>`: la factory no lanza, devuelve un `Task` en estado de fallo, y esa tarea fallida se almacena en caché como un valor exitoso en todos los modos. Si almacenas trabajo asíncrono en caché, comprueba `IsFaulted` y cambia la instancia, o usa una caché de verdad.

## El benchmark

Dos preguntas: cuánto cuesta una lectura una vez que el valor existe, y cuánto cuesta cada opción por instancia cuando creas el propietario y tocas el valor una vez. Metodología: BenchmarkDotNet 0.15.8, job por defecto, `[MemoryDiagnoser]`, .NET 10.0.10 arm64 RyuJIT, Apple M4, macOS. Cada clase contenedora expone una propiedad `Value`; `Expensive` es una clase diminuta para que lo medido sea la maquinaria diferida y no la factory. El código completo son las clases `HotPath` y `ColdPath` de abajo.

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8
public sealed class LazyHolder
{
    private readonly Lazy<Expensive> _value = new(() => new Expensive());
    public Expensive Value => _value.Value;
}

public sealed class LazyInitHolder
{
    private Expensive? _value;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, static () => new Expensive());
}

public sealed class LazyInitLockHolder
{
    private Expensive? _value;
    private object? _sync;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, ref _sync, static () => new Expensive());
}

[MemoryDiagnoser]
public class ColdPath
{
    [Benchmark(Baseline = true)] public int Plain() => new PlainHolder().Value.Id;
    [Benchmark] public int Lazy_ExecutionAndPublication() => new LazyHolder().Value.Id;
    [Benchmark] public int LazyInitializer_Factory() => new LazyInitHolder().Value.Id;
    [Benchmark] public int LazyInitializer_SyncLock() => new LazyInitLockHolder().Value.Id;
    [Benchmark] public int DoubleChecked_Lock() => new DoubleCheckedHolder().Value.Id;
    [Benchmark] public int Lazy_NeverTouched() => new LazyHolder() is null ? 0 : 1;
}
```

Camino frecuente (el valor ya está creado, una lectura):

| Método (.NET 10.0.10, arm64) | Media | Asignado |
| --- | --- | --- |
| Campo simple (`??=`, no seguro entre hilos) | 0.000 ns | 0 B |
| `Lazy<T>` `ExecutionAndPublication` | 0.000 ns | 0 B |
| `Lazy<T>` `PublicationOnly` | 0.000 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 0.495 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 0.289 ns | 0 B |
| Double-checked locking (`volatile` + `Lock`) | 0.314 ns | 0 B |

Camino frío (asignar el propietario, leer el valor una vez):

| Método (.NET 10.0.10, arm64) | Media | Ratio | Asignado |
| --- | --- | --- | --- |
| Campo simple (`??=`, no seguro entre hilos) | 1.53 ns | 1.00 | 24 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 6.19 ns | 4.04 | 48 B |
| Double-checked locking (`volatile` + `Lock`) | 8.96 ns | 5.85 | 72 B |
| `Lazy<T>` `PublicationOnly` | 9.68 ns | 6.32 | 64 B |
| `Lazy<T>` `ExecutionAndPublication` | 13.96 ns | 9.12 | 96 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 14.03 ns | 9.16 | 80 B |
| `Lazy<T>` creado, `Value` nunca leído | 6.17 ns | 4.03 | 72 B |

El camino frecuente es un empate. Todas las opciones quedan por debajo de la resolución de BenchmarkDotNet una vez que el valor existe: el JIT de nivel 1 incorpora `Lazy<T>.Value` hasta dejarlo en una comprobación de null sobre `_state` y la carga de un campo, y BenchmarkDotNet lo reporta como indistinguible de un método vacío. Los números por debajo del nanosegundo de las demás filas están dentro del ruido. Si alguien te dice que reemplaces `Lazy<T>` por código a mano "por rendimiento de lectura", la medición dice que no hay nada que ganar.

El camino frío es donde las opciones difieren, y es sobre todo asignación de memoria. Las filas de `Lazy<T>` cuentan la historia: un `Lazy<T>` cuesta 72 bytes antes de que nadie lo lea (el propio objeto `Lazy<T>` más el `LazyHelper` que `ExecutionAndPublication` asigna en el constructor para bloquear sobre él), y unos 14 ns para crearlo e inicializarlo una vez. `PublicationOnly` se salta el auxiliar, así que es 8 bytes y 4 ns más barato. La sobrecarga de `LazyInitializer` sin bloqueo es la opción segura entre hilos más barata, con 6.2 ns, porque no asigna nada aparte del valor. La sobrecarga con `ref syncLock` paga el objeto de bloqueo que crea en la primera llamada, así que su costo único queda al lado del de `Lazy<T>`.

Una salvedad sobre la columna `Allocated`: el análisis de escape de .NET 10 asigna en la pila los objetos contenedores que demostrablemente no escapan, y por eso la línea base simple muestra solo 24 bytes. Lee la columna en relación con la línea base, no como tamaños absolutos de objetos.

En términos absolutos, 8 ns y 48 bytes por valor diferido solo importan cuando creas millones de propietarios. Un servicio con un campo `Lazy<T>` que se construye una vez al arrancar nunca lo notará.

## Cuándo elegir `Lazy<T>`

- **Una dependencia tipo singleton dentro de una clase**: una configuración ya analizada, un `Regex` compilado, un cliente construido a partir de opciones. Un campo `Lazy<T>`, una línea, la factory se ejecuta una vez.
- **Factories costosas o con efectos secundarios**: cualquier cosa que abra una conexión o llame a una API. El modo por defecto es la única opción sin esfuerzo que garantiza una sola ejecución.
- **Tipos de valor o resultados `null`**: `Lazy<int>` y `Lazy<string?>` simplemente funcionan. La prueba confirmó que `new Lazy<string?>(() => null).Value` devuelve `null` con `IsValueCreated == true`.
- **Quieres un error claro en la recursión**: una factory que toca su propio `Value` recibe `InvalidOperationException: ValueFactory attempted to access the Value property of this instance.` en lugar de un desbordamiento de pila.

## Cuándo elegir `LazyInitializer.EnsureInitialized`

- **Muchos campos diferidos en un tipo con muchas instancias**: el envoltorio `Lazy<T>` es un objeto por valor, y se crea aunque nadie lo lea nunca (72 bytes en la fila "nunca leído" de la tabla del camino frío). Ese es el caso que la guía de MS Learn señala para `LazyInitializer`: inicialización diferida "without the overhead of a class".
- **Arreglos de entradas construidas de forma diferida**: `LazyInitializer.EnsureInitialized(ref _slots[i], () => Build(i))` funciona sobre elementos de arreglo porque se pueden pasar por `ref`. No existe un equivalente `Lazy<T>[]` que no asigne un envoltorio por posición de antemano.
- **Factories baratas y puras**: si ejecutar la factory dos veces bajo una carrera no cuesta nada, la sobrecarga de dos argumentos sin bloqueo es la opción correcta más barata.
- **Quieres reintentar tras un fallo**: ninguna sobrecarga almacena excepciones en caché.

Usa la sobrecarga con `ref syncLock` cuando la factory deba ejecutarse una sola vez. Pasa un campo de tipo `object?` que empiece en `null`: solo se asigna en la primera llamada que llegue al camino lento.

## Cuándo sigue estando justificado el double-checked locking escrito a mano

Rara vez. Dos casos que sí he necesitado:

- **Necesitas reiniciar o intercambiar el valor**. Ni `Lazy<T>` ni `LazyInitializer` te permiten invalidar un valor. Una caché que se reconstruye ante una señal necesita su propio bloqueo y un campo volátil.
- **El camino lento necesita más que una factory**: inicializar dos campos de forma atómica, o llamar a una API asíncrona bajo un `SemaphoreSlim`. En ese punto ya no es realmente inicialización diferida, es una pequeña máquina de estados, y deberías escribirla de forma explícita.

Si lo escribes, usa `System.Threading.Lock` en .NET 9+, mantén el campo `volatile`, léelo una sola vez en una variable local en el camino rápido y nunca bloquees sobre `this`.

## La salvedad que decide por ti

Para valores diferidos **estáticos**, probablemente no necesites ninguna de las tres. Un campo `static readonly` inicializado por el inicializador de tipo es diferido (el runtime lo ejecuta antes del primer acceso al campo), seguro entre hilos y gratis en el camino frecuente, porque el JIT de nivel 1 trata los campos `static readonly` de una clase ya inicializada como constantes:

```csharp
// .NET 10, C# 14
public static class Pricing
{
    public static readonly FrozenDictionary<string, decimal> Table = LoadTable();
    private static FrozenDictionary<string, decimal> LoadTable() => /* ... */ FrozenDictionary<string, decimal>.Empty;
}
```

El problema: si `LoadTable` lanza una excepción, el tipo queda roto durante toda la vida del proceso y cada acceso lanza `TypeInitializationException`. Es el mismo comportamiento de caché que `Lazy<T>`, solo que más difícil de recuperar. Usa un `Lazy<T>` estático cuando necesites la semántica de reintento de `PublicationOnly` o cuando el tipo tenga otros miembros estáticos que quieras que sigan siendo utilizables aunque la carga falle.

## La recomendación, otra vez

Empieza con `Lazy<T>` y el modo por defecto. Ejecuta la factory una vez, es una sola comprobación de null en el camino frecuente y su única desventaja real (las excepciones en caché) se puede evitar con `PublicationOnly`. Cambia a `LazyInitializer.EnsureInitialized` cuando el perfilado muestre que las asignaciones de los envoltorios importan, lo que en la práctica significa muchas instancias con varios campos diferidos cada una. Usa la sobrecarga con `ref syncLock` si la factory debe ejecutarse una sola vez. Escribe el double-checked locking tú mismo solo cuando necesites reiniciar el valor o inicializar más de una cosa de forma atómica.

## Relacionado

- Si estás escribiendo tú mismo el camino lento con bloqueo, [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) explica qué primitiva elegir.
- El [recorrido por el tipo System.Threading.Lock](/es/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) explica por qué `lock` sobre un campo `Lock` es más rápido que bloquear sobre un `object`.
- Para ver qué emiten realmente `volatile` y `Volatile.Read` en arm64, consulta [Volatile.Read vs Volatile.ReadBarrier en .NET 10](/es/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/).
- Cuando el valor diferido en realidad es una entrada de caché que debería expirar o ser asíncrona, [HybridCache vs IMemoryCache vs IDistributedCache](/es/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) es la mejor herramienta.
- Un `Lazy<T>` dentro de un singleton que captura un servicio con ámbito es el mismo bug de dependencia cautiva descrito en [cómo corregir "Cannot consume scoped service from singleton"](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

## Fuentes

- [Lazy initialization](https://learn.microsoft.com/en-us/dotnet/framework/performance/lazy-initialization) en MS Learn, incluida la tabla de almacenamiento en caché de excepciones.
- Referencia de la API [`LazyInitializer.EnsureInitialized`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized).
- Referencia de la API [`LazyThreadSafetyMode`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazythreadsafetymode).
- [`Lazy.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Lazy.cs) y [`LazyInitializer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Threading/LazyInitializer.cs) en dotnet/runtime `release/10.0`.
- [Especificación del modelo de memoria de .NET](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md), secciones "Object assignment" y "Data-dependent reads are ordered".
