---
title: "Qué es ValueTask<T> y cuándo vale la pena"
description: "ValueTask y ValueTask<T> son structs que permiten a un método asíncrono devolver un resultado sin asignar un Task en el heap cuando se completa de forma síncrona. La ganancia es una asignación menos en rutas calientes que normalmente terminan sin esperar. El costo es un contrato estricto de esperar-una-sola-vez. Esto es lo que el tipo realmente es, cómo funciona, y el conjunto reducido de casos donde se gana su lugar."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/what-is-valuetask-and-when-is-it-worth-it"
translatedBy: "claude"
translationDate: 2026-06-20
---

`ValueTask` y `ValueTask<T>` son awaitables de tipo valor (struct) que un método asíncrono puede devolver en lugar de `Task` o `Task<T>`. Su único propósito es evitar la asignación en el heap en la que incurre `Task<T>` cuando un método asíncrono se completa de forma síncrona, que es el caso común para un acierto de caché, una lectura con búfer o un cálculo memoizado. Cuando el método termina sin esperar nunca, un `ValueTask<T>` lleva el resultado en línea en la pila y no asigna nada; solo cuando tiene que esperar trabajo asíncrono real recurre a envolver un `Task`. La trampa es que este ahorro viene con un contrato: puedes esperar un `ValueTask` exactamente una vez, y no debes bloquearte en él, esperarlo dos veces, ni guardarlo en un campo para esperarlo después. Por ese contrato, el tipo de retorno predeterminado para un método asíncrono sigue siendo `Task` / `Task<T>`. `ValueTask` es una optimización guiada por el profiler para una ruta caliente, no un `Task` mejor.

Todo lo aquí descrito apunta a .NET 11 (SDK `11.0.100`) y C# 14, vigente a junio de 2026, pero el contrato de `ValueTask` ha sido estable desde que llegó en .NET Core 2.1, así que la mecánica aplica a toda versión desde la 2.1 en adelante.

## La asignación que ValueTask existe para eliminar

Empieza por lo que cuesta `Task<T>`. Cuando escribes un método `async` que devuelve `Task<T>`, el compilador de C# construye una máquina de estados y, en el momento en que el método realmente se suspende o necesita devolver una operación pendiente, asigna un objeto `Task<T>` en el heap (24 bytes en 64 bits para el encabezado del objeto más campos, antes de cualquier estado de continuación). El runtime cachea un puñado de resultados comunes: `Task.FromResult(true)`, `Task.FromResult(false)`, y enteros pequeños empaquetados reutilizan tareas singleton. Pero para un tipo de referencia arbitrario como tu `User`, cada llamada que devuelve un `Task<User>` es una asignación nueva, incluso cuando el método tenía la respuesta esperando en un diccionario y nunca esperó nada.

Para un método llamado unos pocos miles de veces por segundo, esa asignación es invisible. Para uno en una ruta genuinamente caliente que casi siempre se completa de forma síncrona, esos objetos `Task<T>` se convierten en presión sobre el recolector de basura que aparece como churn de gen-0 en un profiler. `ValueTask<T>` fue diseñado exactamente para esa forma: un método que *normalmente* devuelve un valor que ya tiene, y solo *ocasionalmente* tiene que volverse asíncrono.

Aquí está el ejemplo motivador canónico, una caché con un fallback lento:

```csharp
// .NET 11, C# 14
// Returns Task<User>: allocates a Task<User> even on the cache-hit fast path.
public Task<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return Task.FromResult(user);   // heap allocation on every cache hit

    return LoadFromDbAsync(id);          // genuinely async, allocates anyway
}
```

La línea `Task.FromResult(user)` asigna un `Task<User>` en cada acierto de caché. Si tu tasa de aciertos es del 99 por ciento y el método se ejecuta millones de veces, estás asignando millones de objetos de tarea de corta vida para envolver un valor que ya tenías en la pila.

## Qué es realmente ValueTask<T>

`ValueTask<T>` es un `readonly struct` que contiene una de tres cosas internamente: un `TResult` directo, un `Task<TResult>`, o un `IValueTaskSource<TResult>` (más sobre esto abajo). Cuando el método se completa de forma síncrona, el struct lleva el resultado directamente y nunca se crea un `Task`. Cuando el método tiene que esperar trabajo real, el struct envuelve el `Task<T>` que produjo la maquinaria asíncrona. El mismo ejemplo, reescrito:

```csharp
// .NET 11, C# 14
// Returns ValueTask<User>: zero allocation on the cache-hit fast path.
public ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return new ValueTask<User>(user);     // no allocation, result is inline

    return new ValueTask<User>(LoadFromDbAsync(id)); // wraps the real Task
}
```

En el acierto de caché, `new ValueTask<User>(user)` construye un struct en la pila con el usuario dentro. Nada llega al heap. En el fallo, envuelve el `Task<User>` de `LoadFromDbAsync`, así que la ruta asíncrona cuesta exactamente lo que costaba antes. También puedes usar la palabra clave `async` directamente, y el compilador se encarga de la envoltura por ti:

```csharp
// .NET 11, C# 14
// The async keyword builds a state machine that returns a ValueTask<User>.
// Synchronous completion still avoids the Task<User> allocation via a pooled
// state machine box when possible.
public async ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return user;                     // completes synchronously

    return await LoadFromDbAsync(id);    // suspends, goes async
}
```

El `ValueTask` no genérico existe por la misma razón en métodos que no devuelven valor (`async ValueTask DoWorkAsync()`), y evita asignar el `Task` completado casi singleton en los casos donde incluso eso importa.

## El contrato: esperar una vez, nunca bloquear, nunca almacenar

Todo lo que hace que `ValueTask` sea más barato también lo hace más peligroso, y el peligro está enteramente en cómo el *llamador* lo consume. Un `Task<T>` es un objeto durable que puedes esperar tantas veces como quieras, desde tantos hilos como quieras, almacenar en un campo, y bloquearte en él con `.Result`. Un `ValueTask<T>` no garantiza nada de eso. Según la [documentación oficial de ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), las reglas son:

- **Espéralo a lo sumo una vez.** Un `ValueTask<T>` puede envolver un `IValueTaskSource<T>` agrupado que se recicla después de la primera espera. Esperar dos veces puede observar un resultado que ahora pertenece a una operación distinta.
- **No lo esperes de forma concurrente.** Que dos hilos esperen el mismo `ValueTask<T>` es comportamiento indefinido por la misma razón.
- **No accedas a `.Result` antes de que se complete.** En `Task<T>`, bloquearte en `.Result` es meramente un riesgo de interbloqueo; en `ValueTask<T>` es comportamiento indefinido a menos que ya se sepa que la value task está completa.
- **No lo almacenes para esperarlo después.** Asignar un `ValueTask<T>` a un campo y esperarlo después de que algún otro código se haya ejecutado es la forma más común en que los equipos corrompen resultados bajo carga.

Si necesitas hacer cualquiera de esas cosas, llama a `.AsTask()` una vez para materializar un `Task<T>` real, y luego úsalo:

```csharp
// .NET 11, C# 14
// Need to await twice or fan out? Convert exactly once, then treat as a Task.
ValueTask<User> vt = repo.GetUserAsync(id);
Task<User> task = vt.AsTask();   // materialize the Task once
var a = await task;
var b = await task;              // safe: Task<T> is awaitable repeatedly
```

Esa llamada a `.AsTask()` asigna precisamente el `Task<T>` que intentabas evitar, lo cual es el punto: si tu sitio de llamada necesita semántica de `Task`, nunca ibas a obtener el ahorro, y el `ValueTask` era riesgo puro. La misma fricción aparece con los combinadores. `Task.WhenAll` y `Task.WhenAny` reciben `Task`, así que una API que devuelve `ValueTask` obliga a cada llamador que se ramifica a escribir `.AsTask()` primero, asignando por elemento y borrando el beneficio.

## El analizador que atrapa las violaciones

No tienes que vigilar el contrato a ojo. El SDK de .NET incluye **CA2012 ("Use ValueTasks correctly")**, que marca esperas dobles, value tasks almacenadas, y acceso directo a `.Result`. Está habilitado como sugerencia de forma predeterminada en .NET 10 y posteriores. Promuévelo a advertencia para que la compilación falle ante un mal uso:

```ini
# .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
[*.cs]
dotnet_diagnostic.CA2012.severity = warning
```

Si adoptas `ValueTask` en cualquier lugar, convertir CA2012 en advertencia no es opcional. Es la barrera de protección que hace que el tipo sea seguro de usar en un equipo donde no todos han leído las reglas de Stephen Toub. Una base de código que devuelve `ValueTask` sin CA2012 promovido está a una espera doble descuidada de un heisenbug que solo aparece bajo concurrencia.

## IValueTaskSource<T>: la agrupación que lo hace rendir de verdad

La tercera cosa que un `ValueTask<T>` puede envolver es un `IValueTaskSource<T>`. Este es el caso avanzado y el que entrega la mayor ganancia: un único objeto de respaldo, que implementa `IValueTaskSource<T>`, puede reutilizarse a través de muchas operaciones, de modo que incluso la ruta asíncrona no asigna nada por llamada. El runtime usa esto internamente para `Socket`, `NetworkStream`, y la maquinaria de `System.IO.Pipelines`, donde una conexión realiza millones de lecturas y no te puedes permitir un `Task` por lectura.

Rara vez escribes uno a mano. Cuando lo haces, `ManualResetValueTaskSourceCore<T>` es el ayudante que implementa las partes difíciles (programación de continuaciones, versionado de tokens para imponer esperar-una-sola-vez):

```csharp
// .NET 11, C# 14
// A reusable async signal: one backing source serves many awaits over its
// lifetime, allocation-free per operation. ManualResetValueTaskSourceCore
// handles version tokens so a stale await throws instead of silently aliasing.
public sealed class Signaller : IValueTaskSource<int>
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> WaitAsync() => new(this, _core.Version);

    public void Complete(int value) => _core.SetResult(value);

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> cont, object? state, short token,
        ValueTaskSourceOnCompletedFlags flags)
        => _core.OnCompleted(cont, state, token, flags);
}
```

Este es el único contexto donde `ValueTask` supera de forma fiable a `Task` también en la ruta *asíncrona*, no solo en la ruta rápida síncrona. Si no estás agrupando una fuente como esta, la rama asíncrona de tu método asigna un `Task` de todos modos y lo único que `ValueTask` te ahorró fue la asignación de la finalización síncrona.

## Cuándo vale la pena, concretamente

Recurre a `ValueTask<T>` solo cuando todo esto se cumpla:

1. **Un profiler muestra que la asignación de `Task<T>` es un costo real en esta ruta.** No "podría ser", sino una línea de gen-0 en una traza de memoria. `ValueTask` es una optimización que aplicas después de medir, exactamente como no recurrirías a `Span<T>` ni a [Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) sin una razón.
2. **La finalización síncrona es el caso común.** Aciertos de caché, lecturas con búfer, resultados memoizados. Si el método normalmente espera I/O real, asignas un `Task` de respaldo en la mayoría de las llamadas de todos modos y no ganas nada.
3. **Los sitios de llamada son esperas simples.** Un solo `await` en cada consumidor, sin ramificación, sin cachear el awaitable, sin bloqueo. En el momento en que un llamador necesita `.AsTask()`, el ahorro se va.
4. **Has promovido CA2012 a advertencia.** Para que un futuro contribuidor no pueda romper el contrato en silencio.

La maquinaria de async-streams es el único lugar donde `ValueTask` es correcto por defecto en lugar de por medición: `IAsyncEnumerator<T>.MoveNextAsync` devuelve `ValueTask<bool>` y `DisposeAsync` devuelve `ValueTask`, precisamente porque un enumerador reutiliza una fuente de respaldo a través de cada iteración. Si trabajas con streams en absoluto, [usar IAsyncEnumerable<T> con EF Core 11](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) muestra el patrón en contexto, y nunca deberías "revertir" esas firmas a `Task`.

## Cuándo quedarse en Task<T>

Para la abrumadora mayoría de los métodos asíncronos, devuelve `Task` / `Task<T>`. El canónico [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) de Stephen Toub lo pone sin rodeos: "the default choice is still `Task` / `Task<TResult>`." Señales concretas de que estás recurriendo a `ValueTask` por reflejo en lugar de por evidencia:

- El método hace I/O real en la mayoría de las llamadas. Estás asignando un `Task` en la ruta común de todos modos, así que el struct no compra nada y cuesta cautela.
- Los llamadores necesitan esperar dos veces, cachear el resultado, o ramificarse con `Task.WhenAll`. Cada `.AsTask()` reintroduce la asignación y añade una línea de código.
- Nunca ejecutaste una pasada de `BenchmarkDotNet` `[MemoryDiagnoser]` para confirmar que había una asignación que eliminar. Si los números están planos, el tipo es puro sobrecosto.
- El método es API pública en un paquete NuGet. Cambiar `ValueTask` de vuelta a `Task` después es un cambio que rompe el binario, así que no te comprometas con él sin datos.

Si ya tienes `ValueTask` en una base de código y los datos no lo justifican, lo inverso es una edición segura y mecánica: [migrar ValueTask<T> de vuelta a Task<T>](/es/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) recorre la lista de verificación completa, incluyendo qué hacer con cualquier `IValueTaskSource<T>` hecho a mano. Y sea cual sea el tipo que devuelvas, las reglas para no bloquear el thread pool son las mismas: ve [cómo cancelar un Task de larga duración sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) y la todavía relevante cuestión de si [ConfigureAwait(false) importa en .NET 11](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## La decisión en una línea

`ValueTask<T>` elimina una asignación de `Task<T>` en la ruta de finalización síncrona, al precio de un contrato de esperar-una-sola-vez que todo tu equipo tiene que respetar. Úsalo cuando un profiler pruebe que esa asignación importa y la finalización síncrona es el caso común, apóyate en `IValueTaskSource<T>` si puedes agrupar una fuente de respaldo, convierte CA2012 en advertencia, y mantenlo en los async streams donde es correcto por diseño. En todo lo demás, devuelve `Task<T>` y gasta tu presupuesto de cautela en algo que de verdad mueva un número.

## Fuentes

- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ManualResetValueTaskSourceCore&lt;TResult&gt; -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
