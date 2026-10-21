---
title: "¿Qué pasa con una entrada expirada de MemoryCache y cuándo se elimina realmente de la memoria?"
description: "Una entrada expirada de MemoryCache no se elimina con un temporizador. Permanece en el diccionario hasta que una lectura la toca, se ejecuta un escaneo en segundo plano limitado por frecuencia, o entra en juego la compactación. Aquí está exactamente cuándo ocurre cada caso y cómo lograr una expulsión inmediata."
pubDate: 2026-10-21
tags:
  - "dotnet"
  - "dotnet-10"
  - "caching"
  - "memorycache"
  - "performance"
lang: "es"
translationOf: "2026/10/what-happens-to-an-expired-memorycache-entry-and-when-is-it-removed"
translatedBy: "claude"
translationDate: 2026-10-21
---

No pasa nada con una entrada expirada de `MemoryCache` en el momento en que expira. `Microsoft.Extensions.Caching.Memory` no tiene un temporizador por entrada ni un hilo en segundo plano vigilando el reloj, así que la entrada, su valor y todo lo que el valor referencia permanecen en el diccionario del caché hasta que ocurre una de tres cosas: una lectura de esa clave (`TryGetValue`, `Get`, `GetOrCreate`), un escaneo en segundo plano de elementos expirados que solo inicia alguna otra operación del caché y como máximo una vez por `ExpirationScanFrequency` (1 minuto por defecto), o una compactación (`Compact()` o la ruta de desbordamiento de `SizeLimit`). Solo después de que la entrada sale del diccionario puede el GC reclamar el valor. La única excepción es un token de expiración como `CancellationChangeToken`: cuando se dispara, la entrada se elimina de inmediato, sin necesidad de una lectura.

Todo lo que sigue se verificó con `Microsoft.Extensions.Caching.Memory` 10.0.13 y 11.0.0-rc.2.26504.105 en .NET 10.0.10 (SDK 10.0.302), con el código fuente leído de la rama `main` de `dotnet/runtime`. Ambos paquetes imprimieron una salida idéntica en cada escenario, y esta parte del diseño no ha cambiado en años.

## Por qué no hay un temporizador de expiración

`MemoryCache` almacena las entradas en un `ConcurrentDictionary`. Cada `CacheEntry` conoce su expiración absoluta, su expiración deslizante y sus tokens de expiración, pero no programa nada. La expiración es una comprobación diferida, `CacheEntry.CheckExpired(DateTime utcNow)`, que el caché invoca cada vez que le toca mirar una entrada:

```csharp
// dotnet/runtime main, CacheEntry.cs (abridged)
internal bool CheckExpired(DateTime utcNow)
    => EvictionReason != EvictionReason.None
        || CheckForExpiredTime(utcNow)
        || (_tokens != null && _tokens.CheckForExpiredTokens(this));
```

Es un compromiso deliberado. Un caché con un millón de entradas y un temporizador por entrada gastaría CPU y memoria reales en temporizadores. Un único temporizador periódico despertaría para siempre a un proceso que de otro modo estaría inactivo. El diseño diferido no cuesta nada cuando el caché está en reposo, a cambio de mantener datos obsoletos más tiempo del que podrías suponer.

Así que la pregunta real nunca es "cuándo expira" sino "cuándo vuelve a mirarla el caché". Hay cuatro respuestas.

## Ruta 1: una lectura de la misma clave la elimina de inmediato

`TryGetValue` (por el que pasan `Get`, `GetOrCreate` y `GetOrCreateAsync`) comprueba la entrada que encontró. Si está expirada, la entrada se elimina del diccionario en el acto y la llamada informa de un fallo (miss):

```csharp
// dotnet/runtime main, MemoryCache.PostProcessTryGetValue (abridged)
if (!entry.CheckExpired(utcNow) || entry.EvictionReason == EvictionReason.Replaced)
{
    entry.LastAccessed = utcNow;
    result = entry.Value;
    StartScanForExpiredItemsIfNeeded(utcNow);
    return true; // hit
}
else
{
    coherentState.RemoveEntry(entry, _options); // expired: removed right here
}
```

Nunca recibes un valor expirado de una lectura, así que la corrección no es el problema. El problema es todo lo que no leíste.

## Ruta 2: el escaneo limitado en segundo plano

Casi toda operación del caché (un acierto, un fallo, un `Set`, un `Remove`, una expiración disparada por un token) termina con una llamada a `StartScanForExpiredItemsIfNeeded`:

```csharp
// dotnet/runtime main, MemoryCache.cs
private void StartScanForExpiredItemsIfNeeded(DateTime utcNow)
{
    if (_options.ExpirationScanFrequency < utcNow - _lastExpirationScan)
    {
        _lastExpirationScan = utcNow;
        Task.Factory.StartNew(state => ((MemoryCache)state!).ScanForExpiredItems(), this,
            CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
    }
}
```

`ScanForExpiredItems` recorre todas las entradas en un hilo del grupo de hilos y elimina las expiradas. De este código se desprenden directamente dos consecuencias:

1. **El escaneo se dispara, no se programa.** Si nada llama al caché, nunca se inicia un escaneo. Un caché inactivo lleno de entradas expiradas las conserva todas indefinidamente.
2. **El escaneo está limitado por frecuencia.** Incluso en un caché ocupado, un barrido completo se inicia como máximo una vez por `ExpirationScanFrequency`, que por defecto es `TimeSpan.FromMinutes(1)`. Una entrada que expira justo después de un escaneo puede sobrevivir hasta un minuto de tráfico continuo, y un tiempo arbitrariamente largo sin tráfico.

## Ruta 3: compactación

Cuando configuras `SizeLimit` y una inserción llevaría el `Size` total por encima de él, el caché pone en cola en el grupo de hilos una compactación por exceso de capacidad. También puedes llamar tú mismo a `Compact(double percentage)`. Ambas pasan por el mismo método privado `Compact`, cuyo primer paso es reunir todas las entradas expiradas para eliminarlas antes de empezar a expulsar entradas vivas por prioridad (`Low`, luego `Normal`, luego `High`, cada grupo ordenado por `LastAccessed`; `NeverRemove` nunca se toca). Por lo tanto, `Compact(0)` elimina todas las entradas expiradas y nada más, lo que es un práctico barrido manual.

## Ruta 4: los tokens de expiración son la única ruta inmediata

Si una entrada tiene un `IChangeToken` con `ActiveChangeCallbacks == true` (un `CancellationChangeToken`, un token de un proveedor de archivos, un token de recarga de configuración), el caché registra un callback en él. Cuando el token se dispara, el callback pone en cola un trabajo que marca la entrada como `EvictionReason.TokenExpired` y la elimina del diccionario, sin necesidad de una lectura:

```csharp
// dotnet/runtime main, CacheEntry.cs
private static void ExpirationTokensExpired(object obj)
{
    // start a new thread to avoid issues with callbacks called from RegisterChangeCallback
    Task.Factory.StartNew(state =>
    {
        var entry = (CacheEntry)state!;
        entry.SetExpired(EvictionReason.TokenExpired);
        entry._cache.EntryExpired(entry);
    }, obj, CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
}
```

La expiración basada en tiempo (`AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow`, `SlidingExpiration`) nunca toma esta ruta.

## Una sonda que muestra las cuatro rutas

La forma más fácil de ver esto sin esperar minutos es darle al caché un reloj manual. `MemoryCacheOptions.Clock` recibe un `ISystemClock` (no un `TimeProvider`), y `MemoryCache.Count` devuelve el conteo bruto del diccionario, incluidas las entradas expiradas. Guarda esto como `probe.cs` y ejecútalo con `dotnet run probe.cs`:

```csharp
#:package Microsoft.Extensions.Caching.Memory@10.0.13
#:property PublishAot=false
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Internal;
using Microsoft.Extensions.Primitives;

var clock = new ManualClock();
var cache = new MemoryCache(new MemoryCacheOptions
{
    Clock = clock,
    ExpirationScanFrequency = TimeSpan.FromMinutes(1),
});

// 1. Expired entries stay until something touches them
cache.Set("a", "A", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[1] after expiry, Count = {cache.Count}");
Console.WriteLine($"[1] TryGetValue = {cache.TryGetValue("a", out _)}, Count = {cache.Count}");

// 2. Idle cache: nobody reads, nothing is removed
for (int i = 0; i < 1000; i++)
    cache.Set($"k{i}", new byte[1024], TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromMinutes(10));
Thread.Sleep(500);
Console.WriteLine($"[2] 10 min later, nobody touched the cache, Count = {cache.Count}");
cache.TryGetValue("unrelated", out _); // any operation; >1 min since last scan
Thread.Sleep(200);
Console.WriteLine($"[2] after one unrelated TryGetValue, Count = {cache.Count}");

// 3. Scan throttling: a second expiry within ExpirationScanFrequency is not scanned
cache.Set("b", "B", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 30 s later (< scan frequency), Count = {cache.Count}");
clock.Advance(TimeSpan.FromSeconds(31));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 61 s since last scan, Count = {cache.Count}");

// 4. Post-eviction callback runs later, on a thread-pool thread
var done = new ManualResetEventSlim();
int callerThread = Environment.CurrentManagedThreadId;
cache.Set("c", "C", new MemoryCacheEntryOptions()
    .SetAbsoluteExpiration(TimeSpan.FromSeconds(10))
    .RegisterPostEvictionCallback((k, v, reason, _) =>
    {
        Console.WriteLine($"[4] callback key={k} reason={reason} thread={Environment.CurrentManagedThreadId} (caller {callerThread}) pool={Thread.CurrentThread.IsThreadPoolThread}");
        done.Set();
    }));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[4] TryGetValue = {cache.TryGetValue("c", out _)} returned before callback ran: {!done.IsSet}");
done.Wait(2000);

// 5. Expiration token: removed eagerly, no read required
var cts = new CancellationTokenSource();
var tokenDone = new ManualResetEventSlim();
cache.Set("d", "D", new MemoryCacheEntryOptions()
    .AddExpirationToken(new CancellationChangeToken(cts.Token))
    .RegisterPostEvictionCallback((k, _, reason, _) => { Console.WriteLine($"[5] callback key={k} reason={reason}"); tokenDone.Set(); }));
int before = cache.Count;
cts.Cancel();
tokenDone.Wait(2000);
Console.WriteLine($"[5] Count before cancel = {before}, after cancel (no reads) = {cache.Count}");

// 6. Memory: the value is reachable until the entry leaves the dictionary
var weak = Store(cache, clock);
clock.Advance(TimeSpan.FromSeconds(30));
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] expired but not removed, value alive after GC = {weak.IsAlive}");
cache.TryGetValue("big", out _);
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] removed by read, value alive after GC = {weak.IsAlive}");

// 7. Sliding expiration is measured from the last read
cache.Set("s", "S", new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromSeconds(20) });
for (int i = 0; i < 5; i++) { clock.Advance(TimeSpan.FromSeconds(15)); cache.TryGetValue("s", out _); }
Console.WriteLine($"[7] read every 15 s for 75 s with 20 s sliding: still there = {cache.TryGetValue("s", out _)}");
clock.Advance(TimeSpan.FromSeconds(21));
Console.WriteLine($"[7] after 21 s idle: still there = {cache.TryGetValue("s", out _)}");

// 8. Compact(0) removes expired entries only
cache.Set("e1", 1, TimeSpan.FromSeconds(5));
cache.Set("e2", 2, TimeSpan.FromSeconds(5));
cache.Set("live", 3, TimeSpan.FromHours(1));
clock.Advance(TimeSpan.FromSeconds(10));
Console.WriteLine($"[8] before Compact(0): Count = {cache.Count}");
cache.Compact(0);
Console.WriteLine($"[8] after Compact(0): Count = {cache.Count}");

[MethodImpl(MethodImplOptions.NoInlining)]
static WeakReference Store(MemoryCache cache, ManualClock clock)
{
    var value = new byte[10_000_000];
    cache.Set("big", value, TimeSpan.FromSeconds(10));
    return new WeakReference(value);
}

sealed class ManualClock : ISystemClock
{
    private DateTimeOffset _now = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    public DateTimeOffset UtcNow => _now;
    public void Advance(TimeSpan by) => _now += by;
}
```

Salida, idéntica con el paquete 10.0.13 y 11.0.0-rc.2.26504.105:

```text
[1] after expiry, Count = 1
[1] TryGetValue = False, Count = 0
[2] 10 min later, nobody touched the cache, Count = 1000
[2] after one unrelated TryGetValue, Count = 0
[3] 30 s later (< scan frequency), Count = 1
[3] 61 s since last scan, Count = 0
[4] TryGetValue = False returned before callback ran: True
[4] callback key=c reason=Expired thread=4 (caller 1) pool=True
[5] callback key=d reason=TokenExpired
[5] Count before cancel = 1, after cancel (no reads) = 0
[6] expired but not removed, value alive after GC = True
[6] removed by read, value alive after GC = False
[7] read every 15 s for 75 s with 20 s sliding: still there = True
[7] after 21 s idle: still there = False
[8] before Compact(0): Count = 3
[8] after Compact(0): Count = 1
```

La línea `[2]` es la que sorprende a la gente: mil entradas expiradas, diez minutos después de su expiración, siguen en el caché hasta que una consulta de una clave completamente ajena dispara el escaneo. La línea `[6]` es la consecuencia en memoria: un arreglo de 10 MB que expiró sigue siendo alcanzable, y un GC completo y bloqueante no puede recolectarlo, porque el diccionario del caché aún lo referencia.

## Qué significa realmente "eliminado de la memoria"

Eliminar del caché y ser reclamado por el GC son dos eventos separados:

1. La entrada se elimina del `ConcurrentDictionary` por una de las cuatro rutas anteriores. A partir de este punto el caché ya no mantiene al valor como raíz.
2. Si la entrada tiene callbacks posteriores a la expulsión, el caché los pone en cola en el grupo de hilos con `Task.Factory.StartNew`. El `CacheEntry` (y por tanto su `Value`) permanece alcanzable desde ese elemento de trabajo en cola hasta que se hayan ejecutado todos los callbacks, y por supuesto mientras algún callback guarde el valor en algún lugar.
3. El GC reclama el valor en su siguiente recolección de la generación en la que viva el valor. Un valor de caché de larga vida suele haberse promovido a la generación 2, o está en el Large Object Heap si pesa 85 000 bytes o más, así que la "siguiente recolección" puede tardar en un servidor que rara vez hace GC completos.

Si un volcado del heap muestra que tu tipo en caché domina la memoria mucho después de cuando esperabas que expirara, revisa las raíces: una ruta a través de `MemoryCache` y `CoherentState` significa que la entrada simplemente sigue en el diccionario, lo cual es un problema de escaneo, no una fuga. El [recorrido por dotnet-gcdump y dotnet-dump](/es/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) muestra cómo leer esas rutas de raíces.

## Los callbacks posteriores a la expulsión llegan tarde y en otro hilo

`RegisterPostEvictionCallback` es la forma habitual en que la gente intenta observar la expiración, y hereda toda la pereza descrita arriba. Un callback de una entrada expirada por tiempo no se dispara en el momento de la expiración. Se dispara cuando la entrada realmente se elimina, es decir, durante una lectura, un escaneo o una compactación, e incluso entonces se ejecuta más tarde en un hilo del grupo de hilos (línea `[4]`: la lectura devolvió un fallo antes de que el callback se hubiera ejecutado). El callback recibe el `EvictionReason`: `Expired` para la expiración por tiempo, `TokenExpired` para los tokens, `Capacity` para la compactación por tamaño, `Removed` para un `Remove` explícito y `Replaced` cuando haces `Set` de la misma clave otra vez.

Las excepciones lanzadas desde un callback se capturan y se registran como `EvictionCallback invoked failed` a través del `ILogger` del caché, así que nunca tumban el proceso, pero tampoco aparecen a menos que mires los registros.

No construyas un "refrescar al expirar" sobre estos callbacks con expiración basada en tiempo. En un servidor tranquilo, el refresco no ocurriría hasta que alguna solicitud observe primero el fallo, lo que anula el propósito.

## Lograr una expulsión inmediata y puntual

Si necesitas que una entrada salga del caché cerca de su hora de expiración, sin depender del tráfico, adjunta un token que se dispare con un temporizador. Un `CancellationTokenSource` con retraso es el más simple:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
public static void SetWithEagerExpiry<T>(IMemoryCache cache, object key, T value, TimeSpan ttl)
{
    var cts = new CancellationTokenSource(ttl);
    var options = new MemoryCacheEntryOptions()
        .SetAbsoluteExpiration(ttl) // still enforced lazily on reads
        .AddExpirationToken(new CancellationChangeToken(cts.Token))
        .RegisterPostEvictionCallback(static (_, _, _, state) => ((CancellationTokenSource)state!).Dispose(), cts);

    cache.Set(key, value, options);
}
```

Cuando transcurre el retraso, el token se dispara, el caché elimina la entrada y el callback posterior a la expulsión libera el `CancellationTokenSource` (también se ejecuta si la entrada se reemplaza o se elimina antes, de modo que el temporizador no se fuga). El costo es un temporizador por entrada, así que úsalo para las pocas entradas grandes o sensibles que deben salir a tiempo, no para un caché con un millón de elementos pequeños.

Para todo lo demás, suelen bastar dos ajustes:

- **Reduce `ExpirationScanFrequency`.** En ASP.NET Core, `services.AddMemoryCache(o => o.ExpirationScanFrequency = TimeSpan.FromSeconds(10));`. Cada escaneo recorre todo el diccionario, así que en un caché muy grande esto cambia CPU por prontitud. Aun así necesita que alguna operación dispare el escaneo.
- **Barre con tu propio calendario.** Un `BackgroundService` o un `PeriodicTimer` que llame a `cache.Compact(0)` cada N segundos elimina todas las entradas expiradas incluso cuando el caché está inactivo. `Compact` está definido en la clase concreta `MemoryCache`, no en `IMemoryCache`, así que haz un cast o inyecta `MemoryCache`.

## Detalles que conviene conocer

**`Count` incluye las entradas expiradas.** `MemoryCache.Count`, `MemoryCache.Keys` (añadido en .NET 9) y `GetCurrentStatistics().CurrentEntryCount` reportan el diccionario bruto, así que un panel puede mostrar miles de entradas "vivas" que ya pasaron su expiración. El medidor de OpenTelemetry integrado descrito en [el artículo sobre las métricas de MemoryCache en .NET 11](/es/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) lee las mismas estadísticas, con la misma salvedad.

**La expiración deslizante se reinicia con las lecturas, no con los escaneos.** Cada acierto actualiza `LastAccessed`, que es contra lo que mide la expiración deslizante (línea `[7]`). Un escaneo no cuenta como acceso, pero sí elimina la entrada una vez que la ventana deslizante ha pasado.

**Hacer `Set` de una entrada ya expirada no la agrega.** Si las opciones que pasas a `Set` ya están expiradas al momento de la inserción (por ejemplo, una expiración absoluta en el pasado), la entrada nunca entra al diccionario y sus callbacks se disparan de inmediato con `EvictionReason.Expired`.

**La compactación por `SizeLimit` también es asíncrona.** La inserción que cruza el límite se rechaza (sus callbacks se disparan con `EvictionReason.Capacity`), y la compactación se pone en cola en el grupo de hilos. Hasta que se ejecute, las inserciones siguientes que no quepan también se rechazan. Las entradas expiradas se eliminan primero, así que un caché lleno de entradas obsoletas se recupera antes de expulsar cualquier entrada viva.

**Probar la expiración con `FakeTimeProvider` no se conecta directamente.** `MemoryCacheOptions.Clock` es un `ISystemClock` (de `Microsoft.Extensions.Internal`), no un `TimeProvider`. Un adaptador de cinco líneas como `ManualClock` más arriba, o uno que envuelva `FakeTimeProvider.GetUtcNow()`, es el puente; [probar código dependiente del tiempo con TimeProvider y FakeTimeProvider](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) cubre el resto de esa caja de herramientas. Recuerda que el escaneo y los callbacks siguen ejecutándose en el grupo de hilos real, así que las pruebas necesitan una espera corta o una señal, como hace la sonda.

**HybridCache no cambia nada de esto para L1.** El nivel en proceso por defecto de `HybridCache` está construido sobre `IMemoryCache`, así que las entradas expiradas de L1 siguen exactamente el mismo ciclo de vida. Si estás eligiendo entre las APIs, la [comparación entre HybridCache, IMemoryCache e IDistributedCache](/es/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) explica qué controles de expulsión expone cada una.

## Artículos relacionados

- [HybridCache vs IMemoryCache vs IDistributedCache en .NET 11](/es/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [.NET 11 agrega métricas de OpenTelemetry a MemoryCache](/es/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [Cómo usar HybridCache en ASP.NET Core 11 con Redis como caché L2](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [Cómo diagnosticar una fuga de memoria administrada con dotnet-gcdump y dotnet-dump](/es/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [Cómo probar código dependiente del tiempo con TimeProvider y FakeTimeProvider en .NET 11](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)

## Fuentes

- [`MemoryCache.cs` en dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/MemoryCache.cs) (`PostProcessTryGetValue`, `StartScanForExpiredItemsIfNeeded`, `ScanForExpiredItems`, `Compact`)
- [`CacheEntry.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.cs) y [`CacheEntry.CacheEntryTokens.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.CacheEntryTokens.cs) (`CheckExpired`, callbacks de tokens, despacho de callbacks posteriores a la expulsión)
- [`MemoryCacheOptions.ExpirationScanFrequency`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.memory.memorycacheoptions.expirationscanfrequency) en MS Learn
- [Caching in .NET](https://learn.microsoft.com/dotnet/core/extensions/caching) en MS Learn
- [Microsoft.Extensions.Caching.Memory en NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Caching.Memory)
