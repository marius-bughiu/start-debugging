---
title: "Cómo usar el nuevo tipo System.Threading.Lock en .NET 11"
description: "System.Threading.Lock llegó en .NET 9 y es la primitiva de sincronización por defecto en .NET 11 y C# 14. Esta guía muestra cómo migrar desde lock(object), cómo funciona EnterScope y los problemas alrededor de await, dynamic y los targets antiguos."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "es"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

La respuesta corta: reemplaza `private readonly object _gate = new();` por `private readonly Lock _gate = new();`, deja cada sentencia `lock (_gate) { ... }` exactamente como está y deja que el compilador de C# 14 enlace la palabra clave `lock` a `Lock.EnterScope()` en lugar de `Monitor.Enter`. En .NET 11 el resultado es un objeto más pequeño, sin inflado del bloque de sincronización y una mejora medible de throughput en rutas rápidas con contención. Los únicos lugares en los que tienes que pensar más son cuando un bloque necesita hacer `await`, cuando el campo se expone vía `dynamic`, cuando tienes un `using static` para `System.Threading`, y cuando el mismo código tiene que compilar contra `netstandard2.0`.

Esta guía apunta a .NET 11 (preview 4) y C# 14. `System.Threading.Lock` en sí es un tipo de .NET 9, así que todo lo de aquí funciona en .NET 9, .NET 10 y .NET 11. El reconocimiento de patrón a nivel de compilador que hace que `lock` se enlace a `Lock.EnterScope()` llegó con C# 13 en .NET 9 y no cambia en C# 14.

## Por qué `lock(object)` siempre fue una solución provisional

Durante diecinueve años, el patrón canónico en C# para "haz esta sección segura entre hilos" fue un campo `object` privado más una sentencia `lock`. El compilador lo reducía a llamadas a [`Monitor.Enter`](https://learn.microsoft.com/dotnet/api/system.threading.monitor.enter) y `Monitor.Exit` contra la identidad del objeto. El mecanismo funcionaba, pero tenía tres costes estructurales.

Primero, cada región bloqueada paga por una palabra de cabecera de objeto. Los tipos por referencia en el heap administrado del CLR llevan un `ObjHeader` más un `MethodTable*`, sumando 16 bytes en x64 solo por existir. El `object` que asignas para bloquear no tiene otro propósito que la identidad. No aporta nada a tu modelo de dominio y el GC sigue teniendo que rastrearlo.

Segundo, en cuanto dos hilos compiten por el lock, el runtime infla la cabecera en un [SyncBlock](https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/sync-block-table.md). La tabla SyncBlock es una tabla a nivel de proceso de entradas `SyncBlock`, cada una asignada bajo demanda y nunca liberada hasta que el proceso termina. Un servicio de larga duración que hace lock sobre millones de objetos distintos termina con una tabla SyncBlock que crece de forma monótona. Era raro pero real, y solo era diagnosticable con `dotnet-dump` y `!syncblk`.

Tercero, `Monitor.Enter` es recursivo (el mismo hilo puede entrar dos veces y solo libera cuando coinciden los conteos de salida) y soporta `Monitor.Wait` / `Pulse` / `PulseAll`. La mayoría del código no necesita nada de eso. Solo necesita exclusión mutua. Estabas pagando por funciones que nunca usabas.

`System.Threading.Lock` es el tipo que Microsoft habría enviado en 2002 si `Monitor` no hubiera estado haciendo también de implementación detrás de `lock`. La propuesta que lo introdujo ([dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), aceptada en 2024) lo describe como "un lock más rápido con una huella menor y semántica más clara". Es un tipo por referencia sellado que solo expone lo que la exclusión mutua necesita: entrar, intentar entrar, salir y comprobar si el hilo actual tiene el lock. Sin `Wait`. Sin `Pulse`. Sin magia de cabecera de objeto.

## La migración mecánica

Toma una caché legacy típica:

```csharp
// .NET Framework 4.x / .NET 8, C# 12 -- the old shape
public class LegacyCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Migra a .NET 11 cambiando exactamente una línea:

```csharp
// .NET 11, C# 14 -- the new shape, single-line diff
public class ModernCache
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

El cuerpo de cada sentencia `lock` no cambia. El compilador ve que `_gate` es un `Lock` y reduce `lock (_gate) { body }` a:

```csharp
// What the compiler emits, simplified
using (_gate.EnterScope())
{
    // body
}
```

`EnterScope()` devuelve una struct `Lock.Scope` cuyo `Dispose()` libera el lock. Como `Scope` es una `ref struct`, no se puede boxear, capturar por un iterador, capturar por un método async ni almacenar en un campo. Esa última restricción es lo que hace barato al nuevo lock: sin asignación, sin despacho virtual, solo un handle local en pila.

Si inviertes el orden (`Lock _gate` pero alguna herramienta hace `Monitor.Enter(_gate)` en otro lugar), el compilador de C# emite CS9216 a partir de C# 13: "A value of type `System.Threading.Lock` converted to a different type will use likely unintended monitor-based locking in `lock` statement". La conversión está permitida (un `Lock` sigue siendo un `object`), pero el compilador te avisa porque acabas de tirar todos los beneficios del nuevo tipo.

## Qué devuelve realmente `EnterScope`

Puedes usar el nuevo tipo sin la palabra clave `lock` si lo necesitas:

```csharp
// .NET 11, C# 14
public byte[] GetOrCompute(string key, Func<string, byte[]> factory)
{
    using (_gate.EnterScope())
    {
        if (_store.TryGetValue(key, out var existing))
            return existing;

        var fresh = factory(key);
        _store[key] = fresh;
        return fresh;
    }
}
```

`EnterScope()` se bloquea hasta que adquiere el lock. También existe `TryEnter()` (devuelve un `bool`, sin `Scope`) y `TryEnter(TimeSpan)` para adquisición con tiempo límite. Si llamas a `TryEnter` y devuelve `true`, debes llamar a `Exit()` tú mismo, exactamente una vez, en el mismo hilo. Si te saltas `Exit` has filtrado el lock; el siguiente que intente adquirirlo se bloqueará para siempre.

```csharp
// .NET 11, C# 14 -- TryEnter idiom for non-blocking back-pressure
if (_gate.TryEnter())
{
    try
    {
        DoWork();
    }
    finally
    {
        _gate.Exit();
    }
}
else
{
    // back off, reschedule, drop the message, etc.
}
```

`Lock.IsHeldByCurrentThread` es una propiedad `bool` que devuelve `true` solo cuando el hilo que llama tiene el lock en ese momento. Está pensada para llamadas `Debug.Assert` en invariantes; no la uses como mecanismo de control de flujo. Es `O(1)` pero tiene semántica acquire-release, así que llamarla en un bucle caliente te costará caro.

## La trampa de await, ahora peor

Nunca pudiste hacer `await` dentro de una sentencia `lock` con `Monitor`. El compilador lo rechazaba directamente con [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996): "Cannot await in the body of a lock statement". La razón es que `Monitor` rastrea la propiedad por id de hilo administrado, así que reanudar un `await` en otro hilo liberaría el lock desde el dueño equivocado.

`Lock` tiene la misma restricción y el compilador la aplica de la misma manera. Prueba esto:

```csharp
// .NET 11, C# 14 -- DOES NOT COMPILE
public async Task DoIt()
{
    lock (_gate)
    {
        await Task.Delay(100); // CS1996
    }
}
```

Sale `CS1996` otra vez. Bien. La trampa más grande es `using (_gate.EnterScope())` porque el compilador no sabe que el `Scope` viene de un `Lock`. A día de hoy con .NET 11 SDK 11.0.100-preview.4, este código compila:

```csharp
// .NET 11, C# 14 -- COMPILES, but is broken at runtime
public async Task Broken()
{
    using (_gate.EnterScope())
    {
        await Task.Delay(100);
        // Resumes on a thread-pool thread, which does NOT hold _gate.
        // Disposing the Scope here calls Lock.Exit on a thread that
        // never entered, throwing SynchronizationLockException.
    }
}
```

El arreglo es el mismo de siempre: sube el lock para que envuelva solo la sección crítica síncrona y usa `SemaphoreSlim` (que sí entiende async) cuando realmente necesites exclusión mutua a través de un `await`. `Lock` es una primitiva síncrona rápida. No es, ni intenta ser, un lock async.

## Rendimiento: qué cambió de verdad

Las notas de la versión .NET 9 afirman que la adquisición con contención es aproximadamente 2-3x más rápida que la ruta equivalente con `Monitor.Enter`, y que la adquisición sin contención está dominada por un único compare-exchange interlocked. La entrada [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) de Stephen Toub incluye microbenchmarks que muestran exactamente esto, y se reproducen en .NET 11.

El ahorro que puedes medir en tu propio servicio es menor que el que sugieren los números sintéticos, porque los servicios reales rara vez pasan la mayor parte del tiempo dentro de un `lock`. Los lugares donde verás diferencia:

- **Working set**: cada gate pasa de "un `object` más su sync block bajo contención" a "un `Lock`, que es aproximadamente del tamaño de un `object` más 8 bytes de estado". Si tienes miles de gates (uno por entrada de caché, por ejemplo), la tabla de sync block ya no crece bajo contención.
- **Recorrido de GC2**: el `Lock` sigue siendo un tipo por referencia, pero nunca infla una tabla externa que el GC tenga que recorrer aparte.
- **Ruta rápida con contención**: la nueva ruta rápida es un único `CMPXCHG` más una barrera de memoria. La antigua pasaba por `Monitor`, que hace varias ramas condicionales antes de la barrera.

Lo que no cambia: el throughput de la propia sección protegida, la fairness (el nuevo `Lock` también es injusto, con una pequeña capa de prevención de inanición) y la recursión (`Lock` es recursivo en el mismo hilo, idéntico a `Monitor`).

## Trampas que te van a morder

**`using static System.Threading;`** -- si algún archivo en tu proyecto hace esto, el nombre `Lock` sin calificar se vuelve ambiguo con cualquier clase `Lock` que hayas escrito tú. El arreglo es eliminar el `using static` o calificar el tipo explícitamente: `System.Threading.Lock`. El compilador te avisa con [CS0104](https://learn.microsoft.com/dotnet/csharp/misc/cs0104) pero el sitio del error es donde usaste `Lock`, no donde se introdujo el conflicto.

**`dynamic`** -- una sentencia `lock` sobre una expresión de tipo `dynamic` no puede resolverse a `Lock.EnterScope()` porque el binding ocurre en runtime. El compilador emite CS9216 y cae a `Monitor`. Si tienes uno de esos raros codebases con `dynamic`, haz cast a `Lock` antes del `lock`:

```csharp
// .NET 11, C# 14
dynamic d = GetGate();
lock ((Lock)d) { /* ... */ } // cast is required
```

**Boxing a `object`** -- como `Lock` deriva de `object`, puedes pasarlo a cualquier API que tome `object`, incluyendo `Monitor.Enter`. Eso anula la nueva ruta. CS9216 es tu amigo; conviértelo en error en `Directory.Build.props`:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);CS9216</WarningsAsErrors>
</PropertyGroup>
```

**Bibliotecas `netstandard2.0`** -- si tu biblioteca multi-targetea `netstandard2.0` y `net11.0`, `Lock` no existe en el lado de `netstandard2.0`. Tienes dos opciones. La limpia es mantener un campo `object` en `netstandard2.0` y un campo `Lock` en `net11.0`, protegidos por `#if NET9_0_OR_GREATER`:

```csharp
// .NET 11, C# 14 -- multi-target gate
#if NET9_0_OR_GREATER
private readonly System.Threading.Lock _gate = new();
#else
private readonly object _gate = new();
#endif
```

La sucia es hacer type-forwarding de `Lock` desde un paquete de polyfill; no lo hagas, termina mal cuando el polyfill diverge de la semántica del tipo real.

**`Dispatcher` de WPF y WinForms** -- la cola interna del dispatcher sigue usando `Monitor`. No puedes reemplazar su lock. Los locks de tu aplicación pueden moverse; los del framework no.

**Source generators que emiten `lock(object)`** -- regeneralos. CommunityToolkit.Mvvm 9 y varios otros pasaron a `Lock` a finales de 2024. Revisa el archivo generado buscando `private readonly object`; si sigue ahí, actualiza el paquete.

## Cuándo no usar `Lock`

No uses `Lock` (ni ningún mutex de corta duración) cuando la respuesta sea "ningún lock". `ConcurrentDictionary<TKey, TValue>` no necesita un gate externo. `ImmutableArray.Builder` tampoco. `Channel<T>` tampoco. La sincronización más rápida es la sincronización que no escribes.

No uses `Lock` cuando la sección protegida cruza un `await`. Usa `SemaphoreSlim(1, 1)` y `await semaphore.WaitAsync()`. La sobrecarga por adquisición es más alta pero es la única opción correcta.

No uses `Lock` para coordinación entre procesos o entre máquinas. Es solo intra-proceso. Usa [`Mutex`](https://learn.microsoft.com/dotnet/api/system.threading.mutex) (con nombre, soportado por el kernel), un row lock de base de datos o un `SETNX` de Redis para eso.

## Relacionado

- [Cómo usar Channels en lugar de BlockingCollection en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) cubre el patrón productor/consumidor que muchas veces sustituye los locks por completo.
- [Cómo cancelar una Task de larga duración en C# sin deadlocks](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) es el compañero sobre cancelación de este post.
- [.NET 9: el final de lock(object)](/2026/01/net-9-the-end-of-lockobject/) es la introducción tipo noticia al tipo, escrita cuando salió .NET 9.
- [Cómo escribir un source generator para INotifyPropertyChanged](/es/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) muestra el tipo de generador que puede que tengas que actualizar para soportar `Lock`.

## Fuentes

- [Referencia de la API `System.Threading.Lock`](https://learn.microsoft.com/dotnet/api/system.threading.lock) en Microsoft Learn.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812) -- la propuesta y la discusión de diseño.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) de Stephen Toub.
- [Novedades en C# 13](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13) cubre el reconocimiento de patrón a nivel de compilador.
