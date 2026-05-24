---
title: "lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock en C#"
description: "Cuatro formas de proteger una sección crítica en C#, y una matriz de decisión para elegir una. Usa System.Threading.Lock para exclusión mutua síncrona en .NET 9+, SemaphoreSlim cuando la sección cruza un await, y Monitor solo cuando necesitas Wait/Pulse."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "es"
translationOf: "2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-24
---

Para exclusión mutua síncrona en código nuevo en .NET 9 o posterior, usa `System.Threading.Lock` y escríbelo con la palabra clave `lock`. Si la sección crítica tiene que esperar (`await`) algo, ninguno de los primitivos síncronos es legal, así que recurre a `SemaphoreSlim(1, 1)` y `await WaitAsync()`. Reserva `Monitor` puro para el único caso que los demás no pueden hacer en absoluto: las variables de condición (`Monitor.Wait` / `Pulse` / `PulseAll`). El idioma clásico `lock (object)` no está mal, simplemente compila a una ruta de `Monitor` algo más pesada que la de `Lock`, así que en .NET 9+ no hay razón para iniciar un nuevo candado con un `object` simple.

Este artículo apunta a .NET 11 (preview 4), C# 14 y la BCL tal como está `System.Threading` en net11.0. `System.Threading.Lock` es un tipo de .NET 9, por lo que la recomendación aplica por igual a .NET 9, .NET 10 y .NET 11. `Monitor` y la palabra clave `lock` se remontan a .NET 1.1 y C# 1.0; `SemaphoreSlim` llegó en .NET Framework 4.0.

## Los cuatro contendientes no son realmente pares

La razón por la que esta comparación confunde a la gente es que los cuatro nombres se sitúan en capas diferentes.

`lock` es una instrucción del lenguaje C#. No implementa nada por sí misma. El compilador reduce `lock (x) { body }` a una de dos formas según el tipo estático de `x`. Si `x` es un `System.Threading.Lock`, se convierte en `using (x.EnterScope()) { body }`. Para cualquier otro tipo de referencia se convierte en un par `Monitor.Enter` / `Monitor.Exit` envuelto en un `try` / `finally`. Así que "¿debería usar `lock` o `Monitor`?" es en su mayoría una falsa disyuntiva: `lock (someObject)` *es* `Monitor`, escrito de forma más segura.

`Monitor` es la API estática detrás del idioma clásico. Hace exclusión mutua, pero también acarrea dos características de las que los demás carecen: recursión (el mismo hilo puede entrar dos veces) y variables de condición mediante `Wait`, `Pulse` y `PulseAll`. Esos métodos de variables de condición son la única capacidad en toda esta comparación que no tiene sustituto entre los otros tres.

`System.Threading.Lock` es el tipo dedicado a la exclusión mutua introducido en .NET 9. Es lo que `Monitor` habría sido si no hubiera estado haciendo también de implementación de respaldo para `lock (object)`. Expone exactamente lo que un mutex necesita y nada más. El análisis en profundidad de [cómo funciona System.Threading.Lock y cómo migrar a él](/es/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) cubre sus mecanismos en detalle.

`SemaphoreSlim` es un semáforo de conteo, no un mutex, pero se convierte en un mutex cuando lo construyes con un conteo de uno. Lo que lo distingue de los otros tres es `WaitAsync`: es el único primitivo aquí que puedes mantener legalmente a través de un `await`.

## La matriz de decisión

Cada fila de esta tabla corresponde al comportamiento de .NET 9+ / C# 13+ salvo que se indique lo contrario.

| Capacidad                               | `lock (object)`        | `Monitor`              | `SemaphoreSlim`             | `System.Threading.Lock`   |
| --------------------------------------- | ---------------------- | ---------------------- | --------------------------- | ------------------------- |
| Exclusión mutua (un solo poseedor)      | sí                     | sí                     | sí, con `new(1, 1)`         | sí                        |
| Limitar a N > 1 poseedores concurrentes | no                     | no                     | sí, `new(N, N)`             | no                        |
| Legal usar `await` dentro de la región  | no (CS1996)            | no (CS1996)            | sí, vía `WaitAsync`         | no (CS1996)               |
| Variables de condición (`Wait`/`Pulse`) | no                     | sí                     | no                          | no                        |
| Reentrante en el mismo hilo             | sí                     | sí                     | no (interbloqueo)           | sí                        |
| Impone identidad de hilo / poseedor     | sí                     | sí                     | no                          | sí                        |
| Se reduce a                             | `Monitor.Enter`/`Exit` | (sí mismo)             | `Wait`/`Release`            | `Lock.EnterScope()`       |
| Inflado del sync block bajo contención  | sí                     | sí                     | no                          | no                        |
| Intento de adquisición con timeout      | `Monitor.TryEnter`     | `TryEnter(TimeSpan)`   | `Wait(TimeSpan)`            | `TryEnter(TimeSpan)`      |
| Adquisición cancelable                  | no                     | no                     | sí (`CancellationToken`)    | no                        |
| Entre procesos                          | no                     | no                     | no (usa `Semaphore`)        | no                        |
| `IDisposable`                           | no                     | no                     | sí                          | no                        |
| Primera versión                         | C# 1.0                 | .NET 1.1               | .NET Framework 4.0          | .NET 9                    |

Dos filas deciden casi todos los casos reales: "legal usar `await` dentro" y "variables de condición". Si necesitas la primera, estás en `SemaphoreSlim`. Si necesitas la segunda, estás en `Monitor`. Todo lo demás apunta a `System.Threading.Lock`.

## Cuándo elegir System.Threading.Lock

Esta es la opción por defecto para código síncrono nuevo en .NET 9+.

- Estás protegiendo una sección crítica corta y limitada por CPU: la actualización de una caché en memoria, un contador, una mutación de `Dictionary`, un campo de inicialización diferida. El cuerpo no espera (`await`) nada. Esto es el 90% del bloqueo en un servicio típico.
- Estás migrando un candado `lock (object)` existente y el cuerpo es síncrono. El cambio es de una línea: `private readonly object _gate = new();` se convierte en `private readonly Lock _gate = new();`. Cada instrucción `lock (_gate) { ... }` se mantiene byte por byte igual, y el compilador la reasocia de `Monitor.Enter` a `Lock.EnterScope()`.
- Quieres una huella menor. Un `Lock` nunca infla un sync block a nivel de proceso bajo contención, así que un servicio que mantiene miles de candados (uno por entrada de caché, por ejemplo) no hace crecer la tabla de sync blocks como lo hace `Monitor`.

```csharp
// .NET 11, C# 14 -- the default gate for synchronous critical sections
public sealed class Counter
{
    private readonly Lock _gate = new();
    private long _value;

    public void Increment()
    {
        lock (_gate) // lowers to using (_gate.EnterScope())
        {
            _value++;
        }
    }

    public long Read()
    {
        lock (_gate)
        {
            return _value;
        }
    }
}
```

Si todavía no puedes pasarte a .NET 9, el respaldo es el clásico `lock (object)`. Tiene la misma semántica, algo más pesada. No recurras a `Monitor` explícitamente solo para bloquear; la palabra clave `lock` ya envuelve `Monitor.Enter` / `Exit` en el `try` / `finally` correcto, de modo que el candado se libera incluso si el cuerpo lanza una excepción. Un `Monitor.Enter` escrito a mano sin un `finally` es una fuente clásica de candados huérfanos.

## Cuándo elegir SemaphoreSlim

`SemaphoreSlim` es la respuesta a exactamente una pregunta que los primitivos síncronos no pueden responder: ¿cómo serializo una sección que contiene un `await`?

- La sección crítica cruza un `await`. Estás llamando a una API asíncrona (una solicitud de `HttpClient`, una consulta de EF Core, una escritura de archivo) y necesitas solo un llamador dentro de la región a la vez. `lock`, `Monitor` y `Lock` prohíben todos `await` en la región mantenida. `SemaphoreSlim` no.
- Quieres limitar la concurrencia a N mayor que uno. Un acelerador que permite tres llamadas salientes concurrentes es `new SemaphoreSlim(3, 3)`. Ningún mutex puede expresar esto.
- Necesitas una adquisición cancelable o con tiempo límite en una ruta asíncrona. `WaitAsync(CancellationToken)` y `WaitAsync(TimeSpan)` se integran con el resto de tu historia de cancelación.

```csharp
// .NET 11, C# 14 -- async-safe mutual exclusion across an await
public sealed class AsyncCache : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1); // count 1 == mutex
    private readonly Dictionary<string, byte[]> _store = new();

    public async Task<byte[]> GetOrAddAsync(string key, Func<string, Task<byte[]>> factory)
    {
        await _gate.WaitAsync();
        try
        {
            if (_store.TryGetValue(key, out var existing))
                return existing;

            var fresh = await factory(key); // legal: we are holding a semaphore, not a lock
            _store[key] = fresh;
            return fresh;
        }
        finally
        {
            _gate.Release(); // ALWAYS in finally
        }
    }

    public void Dispose() => _gate.Dispose();
}
```

Tres trampas vienen con `SemaphoreSlim`, y las tres se remontan a la misma raíz: no rastrea quién lo mantiene. Según la [documentación de SemaphoreSlim](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim), la clase "no impone identidad de hilo o tarea en las llamadas a los métodos Wait, WaitAsync y Release".

1. **Sin reentrancia.** Si un método que mantiene el semáforo llama a otro método que también espera en el mismo semáforo, se produce un interbloqueo. `Monitor` y `Lock` permitirían al mismo hilo reentrar; `SemaphoreSlim` no puede, porque no tiene concepto de un hilo poseedor con el que comparar.
2. **Release no está protegido.** Nada te impide llamar a `Release` más veces de las que llamaste a `Wait`, lo que silenciosamente empuja `CurrentCount` por encima del conteo inicial y rompe la invariante. Empareja siempre `Wait` / `WaitAsync` con `Release` en un `finally`.
3. **Es `IDisposable`.** A diferencia de los otros tres, un `SemaphoreSlim` posee un `WaitHandle` asignado de forma diferida y debe liberarse. Un semáforo a nivel de campo significa que tu clase ahora también es `IDisposable`.

La sobrecarga por adquisición es mayor que la de un `Lock`. Ese es el precio del soporte asíncrono. No uses `SemaphoreSlim` para una ruta rápida puramente síncrona solo porque ya tienes uno en el ámbito.

## Cuándo elegir Monitor explícitamente

Casi nunca, con una excepción real: necesitas una variable de condición.

`Monitor.Wait`, `Monitor.Pulse` y `Monitor.PulseAll` permiten que un hilo libere el candado, duerma hasta que otro hilo señale un cambio de estado y vuelva a adquirir al despertar. Este es el primitivo clásico de coordinación de búfer acotado / productor-consumidor. Ningún otro tipo en esta comparación lo expone. `System.Threading.Lock` lo descartó deliberadamente; `SemaphoreSlim` nunca lo tuvo.

```csharp
// .NET 11, C# 14 -- the one job only Monitor can do: condition variables
public sealed class BoundedBuffer<T>
{
    private readonly object _gate = new();
    private readonly Queue<T> _items = new();
    private readonly int _capacity;

    public BoundedBuffer(int capacity) => _capacity = capacity;

    public void Add(T item)
    {
        lock (_gate)
        {
            while (_items.Count == _capacity)
                Monitor.Wait(_gate);     // release + sleep until pulsed

            _items.Enqueue(item);
            Monitor.PulseAll(_gate);     // wake any waiting consumers
        }
    }

    public T Take()
    {
        lock (_gate)
        {
            while (_items.Count == 0)
                Monitor.Wait(_gate);

            var item = _items.Dequeue();
            Monitor.PulseAll(_gate);
            return item;
        }
    }
}
```

Observa que el candado aquí es un `object` simple, no un `Lock`: `Monitor.Wait`/`Pulse` operan sobre el sync block de un objeto y no están disponibles en `System.Threading.Lock`. Ese es el intercambio. Si te encuentras escribiendo este patrón desde cero en 2026, detente y comprueba si un [`Channel<T>` reemplazaría todo el asunto](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). `System.Threading.Channels` te da una cola productor/consumidor acotada y compatible con asíncrono, con contrapresión incorporada, y nunca vuelves a tocar `Monitor.Wait`. El búfer acotado hecho a mano es hoy en su mayoría de interés histórico y educativo.

El otro lugar donde podrías llamar a `Monitor` directamente es `Monitor.TryEnter` para un intento no bloqueante, pero `System.Threading.Lock` también tiene `TryEnter`, así que en .NET 9+ esa razón se evapora.

## El benchmark: lo que Lock realmente ahorra frente a Monitor

La afirmación de rendimiento es específicamente que `System.Threading.Lock` es más rápido que el `lock (object)` respaldado por `Monitor` tanto para la ruta rápida sin contención como para la ruta con contención. El artículo de Stephen Toub [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) lo mide con BenchmarkDotNet. La adquisición sin contención se reduce a un único intercambio-comparación interbloqueado más una barrera; la adquisición con contención es aproximadamente 2-3x más rápida que la ruta de `Monitor.Enter` porque `Monitor` ejecuta varias ramas condicionales antes de su barrera.

Lo que los números sintéticos no te dicen es lo poco que esto importa en un servicio real, porque los servicios reales pasan casi nada de su tiempo de reloj dentro de `lock`. Las ganancias medibles en producción son estructurales, no de rendimiento de procesamiento:

- **Working set.** Cada candado pasa de "un `object` más un sync block bajo contención" a "un `Lock`, aproximadamente del tamaño de un objeto más unos pocos bytes de estado". Con miles de candados, la tabla de sync blocks deja de crecer bajo carga.
- **Recorrido del GC.** El `Lock` sigue siendo un tipo de referencia que el GC rastrea, pero nunca infla una tabla separada a nivel de proceso que el GC tenga que recorrer.

Lo que *no* cambia entre `Monitor` y `Lock`: el rendimiento de la sección protegida en sí, la equidad (ambos son injustos con una ligera anti-inanición) y el comportamiento de recursión (ambos son reentrantes en el mismo hilo).

`SemaphoreSlim` está en una clase completamente diferente y la comparación no es de igual a igual: un `WaitAsync` que se completa síncronamente sigue siendo notablemente más costoso que un `Lock.EnterScope`, y uno que se completa asíncronamente asigna memoria y hace un recorrido de ida y vuelta por el pool de hilos. No eliges `SemaphoreSlim` por velocidad. Lo eliges porque es la única opción correcta a través de un `await`, y la corrección le gana al recuento de ciclos cada vez.

## La trampa que decide por ti

Tres restricciones anulan por completo la preferencia:

**Un `await` en la sección crítica obliga a `SemaphoreSlim`.** Esto no es una elección de estilo. `lock`, `Monitor` y `Lock` rastrean la propiedad por hilo administrado, y un `await` puede reanudarse en un hilo diferente, lo que liberaría el candado del poseedor equivocado. El compilador de C# rechaza `await` dentro de `lock` con [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996). La variante engañosa es `using (_gate.EnterScope())` alrededor de un `await`: eso puede compilar, pero lanza `SynchronizationLockException` en tiempo de ejecución cuando la continuación intenta liberar el scope en un hilo que nunca entró. Si el cuerpo espera, estás en `SemaphoreSlim`. Punto final. Este es el mismo razonamiento detrás de [por qué async void y async Task se comportan de forma tan diferente](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) bajo el capó.

**Las variables de condición obligan a `Monitor`.** Si tu coordinación necesita genuinamente la semántica de "dormir hasta ser señalado" y un `Channel<T>` no encaja, solo `Monitor.Wait` / `Pulse` lo harán.

**Un objetivo anterior a .NET 9 descarta `Lock`.** Si tu biblioteca apunta a múltiples objetivos incluyendo `netstandard2.0`, `System.Threading.Lock` no existe en ese lado. Protégelo con `#if NET9_0_OR_GREATER` y mantén un candado `object` en la ruta de versión inferior. No reenvíes el tipo `Lock` desde un polyfill; la semántica divergirá del tipo real.

## La recomendación, reformulada

Usa `System.Threading.Lock` por defecto para exclusión mutua síncrona en .NET 9+, y escríbelo mediante la palabra clave `lock` para que el compilador gestione el `try` / `finally` por ti. Baja a un candado `object` simple solo cuando debas apuntar a un runtime anterior a .NET 9, donde `lock (object)` te da semántica idéntica a un costo algo mayor. Cambia a `SemaphoreSlim(1, 1)` en el momento en que la región protegida contenga un `await`, y usa `SemaphoreSlim(N, N)` cuando quieras limitar la concurrencia por encima de uno. Toca `Monitor` directamente solo para variables de condición `Wait` / `Pulse`, y primero pregúntate si un `Channel<T>` hace desaparecer toda la coordinación hecha a mano. La decisión correcta más corta: síncrono y corto significa `Lock`; asíncrono significa `SemaphoreSlim`; señalización significa `Monitor`.

## Relacionado

- [Cómo usar el nuevo tipo System.Threading.Lock en .NET 11](/es/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) es el análisis en profundidad sobre migrar a y usar el nuevo tipo.
- [.NET 9: El fin de lock(object)](/es/2026/01/net-9-the-end-of-lockobject/) es la introducción original en formato de noticia a `System.Threading.Lock`.
- [Cómo usar Channels en lugar de BlockingCollection en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) muestra el patrón productor/consumidor que reemplaza la coordinación `Monitor.Wait` hecha a mano.
- [async void vs async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica el comportamiento de reanudación de hilos detrás de la regla de no usar await en un lock.
- [Cómo cancelar una Task de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) se empareja con las sobrecargas cancelables de `WaitAsync`.

## Enlaces de fuentes

- [Referencia de la API de `System.Threading.Lock`](https://learn.microsoft.com/dotnet/api/system.threading.lock) en Microsoft Learn.
- [Referencia de la clase `SemaphoreSlim`](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim) en Microsoft Learn, incluyendo la nota sobre identidad de hilo.
- [Referencia de la clase `Monitor`](https://learn.microsoft.com/dotnet/api/system.threading.monitor), que cubre `Wait`, `Pulse` y `PulseAll`.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) de Stephen Toub, con los microbenchmarks de `Lock` vs `Monitor`.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), la propuesta que introdujo `System.Threading.Lock`.
