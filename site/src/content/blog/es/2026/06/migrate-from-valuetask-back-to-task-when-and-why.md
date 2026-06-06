---
title: "Migrar de ValueTask<T> de vuelta a Task<T>: cuándo y por qué (.NET 11, C# 14)"
description: "Una lista de verificación práctica para revertir los tipos de retorno ValueTask y ValueTask<T> a Task y Task<T>, qué se rompe en los puntos de llamada, cómo verificar cada cambio y cómo saber si el cambio valió la pena."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "es"
translationOf: "2026/06/migrate-from-valuetask-back-to-task-when-and-why"
translatedBy: "claude"
translationDate: 2026-06-06
---

Revertir una API de `ValueTask<T>` de vuelta a `Task<T>` suele ser un trabajo de medio día y casi siempre es seguro, porque `Task<T>` es el tipo más indulgente: todo lo que compilaba contra `ValueTask<T>` seguirá compilando, y varios errores latentes en tus llamadores desaparecen en el momento en que haces el cambio. El trabajo que lleva tiempo no es el cambio del tipo de retorno en sí, sino auditar los puntos de llamada que dependían de la semántica de `ValueTask`: un método esperado dos veces, un resultado almacenado en caché en un campo, un `.GetAwaiter().GetResult()` en una ruta crítica. Esta guía cubre cuándo la reversión es la decisión correcta, las ediciones exactas en la declaración y en cada llamador, cómo verificar cada paso y cómo confirmar después que no provocaste una regresión en el perfil de asignaciones que originalmente adoptaste `ValueTask` para corregir.

Esto apunta a .NET 11 y C# 14, vigentes a junio de 2026, pero nada de esto es específico de una versión: el contrato de `ValueTask` ha sido estable desde que se lanzó en .NET Core 2.1. El consejo sigue la guía canónica de Stephen Toub en [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), cuya conclusión es contundente: "la opción predeterminada sigue siendo `Task` / `Task<TResult>`." Si adoptaste `ValueTask` sin que un profiler te lo indicara, esta es la publicación que te hace retroceder.

## Por qué revertir

`ValueTask<T>` existe para evitar una asignación específica: el objeto `Task<T>` que un método asíncrono asigna en el heap incluso cuando se completa de forma síncrona. Ese es un costo real en rutas críticas que casi siempre terminan sin esperar (un acierto de caché, una lectura en búfer, un cálculo memoizado). Pero el tipo paga esa ganancia con un contrato que es fácil de violar, y la mayoría de las bases de código que lo adoptan nunca tuvieron el problema de asignación en primer lugar. Razones concretas para volver atrás:

- **Los puntos de llamada siguen activando CA2012.** Si tu equipo espera repetidamente el mismo `ValueTask` dos veces, lo almacena en un campo o se bloquea sobre él, el tipo te está costando activamente la corrección. `Task<T>` hace que todas esas operaciones sean legales.
- **Nunca mediste una ganancia.** `ValueTask` es una optimización guiada por el profiler. Si lo adoptaste por reflejo y un benchmark no muestra diferencia de asignación, la cautela añadida es puro sobrecosto.
- **El método ahora suele completarse de forma asíncrona.** `ValueTask` solo rinde cuando la finalización síncrona es el caso común. Si el método empezó a esperar E/S real en la mayoría de las llamadas, de todas formas estás asignando un objeto de respaldo y además cargas con las restricciones de la struct para nada.
- **Quieres la ergonomía de `WhenAll` / `WhenAny`.** Los combinadores toman `Task`, así que una API que retorna `ValueTask` obliga a cada llamador a escribir `.AsTask()` antes de paralelizar. Revertir elimina esa fricción.

Si estás sopesando la dirección inversa, o aún decides si `ValueTask` pertenece a tu código en absoluto, las reglas a continuación sirven también como ayuda para decidir.

## Qué se rompe (spoiler: muy poco)

| Área | Cambio | Severidad |
| --- | --- | --- |
| Declaración del método | `ValueTask<T>` pasa a `Task<T>`; `ValueTask` pasa a `Task` | bajo |
| Puntos de llamada con `await` directo | No se necesita cambio; ambos tipos son esperables | ninguno |
| Llamadas a `.AsTask()` | Ahora redundantes; elimínalas | bajo |
| Implementaciones de `IValueTaskSource<T>` | Deben reemplazarse por una fuente `Task` real o `TaskCompletionSource<T>` | alto |
| Retornos de ruta rápida síncrona | `return new ValueTask<T>(value)` pasa a `return Task.FromResult(value)` | medio |
| Firmas de interfaz / clase base | Cada implementador y override debe cambiar a la vez | medio |
| Superficie de API pública | Cambio que rompe la compatibilidad binaria para consumidores externos | alto |

Los únicos casos genuinamente difíciles son un `IValueTaskSource<T>` hecho a mano (raro, y si lo tienes adoptaste `ValueTask` deliberadamente, así que piénsalo dos veces) y una superficie pública de NuGet donde el cambio de tipo de retorno es una ruptura binaria. Todo lo demás es mecánico.

## Lista previa al vuelo

Antes de tocar una sola firma:

- Confirma que el analizador está activo. La regla de corrección de `ValueTask` **CA2012** está habilitada como sugerencia de forma predeterminada en .NET 10 y posteriores. Promuévela a advertencia para que el compilador te muestre exactamente qué puntos de llamada dependían de la semántica de `ValueTask`: añade `dotnet_diagnostic.CA2012.severity = warning` a tu `.editorconfig`.
- Captura una línea base. Si la asignación fue alguna vez la razón de `ValueTask`, ejecuta ahora una pasada de `BenchmarkDotNet` con `[MemoryDiagnoser]` sobre la ruta crítica, para poder comparar después.
- Identifica el límite del contrato. Si el método implementa una interfaz o sobrescribe un miembro base, cada declaración relacionada cambia en el mismo commit. Busca primero el nombre del método en toda la solución.
- Revisa la superficie pública. Si este tipo se distribuye en un paquete NuGet, un cambio de tipo de retorno rompe la compatibilidad binaria aunque sea compatible a nivel de código fuente. Planifica un incremento de versión mayor.

## Pasos de migración

Cada paso a continuación es un cambio discreto con una línea de verificación. Hazlos en orden; espera estados intermedios en los que la compilación está en rojo hasta que el contrato esté actualizado en todas partes.

1. **Convierte CA2012 en advertencia y compila.** Haz que el analizador sea ruidoso antes de cambiar nada, para que la compilación muestre cada patrón de consumo riesgoso mientras la firma de `ValueTask` aún está en su lugar.

   ```ini
   # .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
   [*.cs]
   dotnet_diagnostic.CA2012.severity = warning
   ```

   Ejecuta `dotnet build`. Cada advertencia CA2012 es un punto de llamada que esperó dos veces, almacenó o se bloqueó sobre el `ValueTask`, exactamente el código que se vuelve trivialmente correcto una vez que reviertes. Anota cada uno; eliminarás las soluciones temporales en el paso 4. **Verificar:** la compilación se completa y tienes una lista escrita de los aciertos de CA2012 (a menudo cero, lo cual ya es información útil).

2. **Cambia la declaración.** Cambia el tipo de retorno. El cuerpo del método normalmente necesita una edición por cada `return` de un valor materializado.

   ```csharp
   // Before: .NET 11, C# 14
   public ValueTask<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return new ValueTask<User>(user);          // synchronous fast path

       return new ValueTask<User>(LoadFromDbAsync(id)); // wraps a Task
   }

   // After: .NET 11, C# 14
   public Task<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return Task.FromResult(user);              // synchronous fast path

       return LoadFromDbAsync(id);                     // already a Task<User>
   }
   ```

   Para un método con la palabra clave `async`, el cambio es solo la firma; el compilador reescribe el resto:

   ```csharp
   // Before
   public async ValueTask<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }

   // After: only the return type changed
   public async Task<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }
   ```

   **Verificar:** el proyecto compila. La forma con la palabra clave `async` no necesita más ediciones; la forma manual necesita que cada `new ValueTask<T>(...)` se reescriba como `Task.FromResult(...)` o que retorne el `Task` interno directamente.

3. **Actualiza las declaraciones de interfaz y clase base a la vez.** Si el método vino de un contrato, cambia el contrato y cada implementador en la misma pasada, o la compilación se rompe a medias.

   ```csharp
   // Before
   public interface IUserRepository
   {
       ValueTask<User> GetUserAsync(int id);
   }

   // After
   public interface IUserRepository
   {
       Task<User> GetUserAsync(int id);
   }
   ```

   **Verificar:** `dotnet build` en toda la solución, no solo en el proyecto. Un implementador omitido aparece como `CS0535` (no implementa el miembro de la interfaz) o `CS0508` (no coincide el tipo de retorno en el override).

4. **Elimina las soluciones temporales `.AsTask()` y las correcciones de doble await.** Aquí es donde rinde la reversión. En cualquier lugar donde un llamador se defendía contra la regla de un solo await de `ValueTask`, la defensa es ahora código muerto.

   ```csharp
   // Before: caller had to convert because it awaited twice / fanned out
   ValueTask<User> vt = repo.GetUserAsync(id);
   Task<User> safe = vt.AsTask();        // required for ValueTask
   var a = await safe;
   var b = await safe;

   // After: Task is awaitable repeatedly; no conversion needed
   Task<User> t = repo.GetUserAsync(id);
   var a = await t;
   var b = await t;
   ```

   `Task.WhenAll` y `Task.WhenAny` ahora toman los resultados directamente:

   ```csharp
   // Before: each ValueTask needed .AsTask() before combining
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id).AsTask()));

   // After
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id)));
   ```

   **Verificar:** cada advertencia CA2012 del paso 1 ha desaparecido, y eliminaste al menos tantas llamadas a `.AsTask()` como advertencias tenías.

5. **Reemplaza cualquier plumbing de `IValueTaskSource<T>`.** Si un método retornaba un `ValueTask<T>` agrupado respaldado por un `IValueTaskSource<T>` personalizado (el patrón que habilita `ManualResetValueTaskSourceCore<T>`), no hay un reemplazo directo. Estás renunciando al pooling, así que usa un `TaskCompletionSource<T>` en su lugar y acepta la asignación que estás eligiendo reintroducir.

   ```csharp
   // After: a Task source replaces the pooled IValueTaskSource<T>
   private readonly TaskCompletionSource<int> _tcs =
       new(TaskCreationOptions.RunContinuationsAsynchronously);

   public Task<int> WaitForValueAsync() => _tcs.Task;

   public void Complete(int value) => _tcs.TrySetResult(value);
   ```

   La bandera `RunContinuationsAsynchronously` importa: sin ella, `TrySetResult` ejecuta la continuación en línea en el hilo que completa, lo que puede provocar un interbloqueo o privar al thread pool de la misma manera que un bloqueo síncrono. Este es el único paso en el que revertir realmente te cuesta algo, así que hazlo solo si el pooling nunca estuvo justificado por un benchmark. **Verificar:** el tipo ya no implementa `IValueTaskSource<T>`, y una prueba de estrés que complete la operación miles de veces sigue pasando sin problemas de reentrada.

## Verificación después del cambio

Ejecuta esta lista de verificación de principio a fin antes de dar la migración por terminada:

- `dotnet build` está limpio con CA2012 en `warning` y cero aciertos.
- `dotnet test` pasa sin fallos nuevos, especialmente alrededor de cualquier código que antes almacenaba en caché el esperable.
- La pasada de `BenchmarkDotNet` con `[MemoryDiagnoser]` del prevuelo muestra el delta de asignación que esperabas. Si una ruta crítica de finalización síncrona ahora asigna un `Task<T>` por llamada (24 bytes en 64 bits) y esa ruta se ejecuta millones de veces por segundo, tienes tu evidencia de que `ValueTask` se ganaba su lugar y la reversión fue un error. Si los números están planos, la reversión fue corrección gratis.
- Busca en el diff cualquier `new ValueTask`, `.AsTask()` o `ValueTask<` sobrante que se te haya pasado.

## Plan de reversión

Esta migración es totalmente reversible a nivel de código fuente y de bajo riesgo para deshacer: cambiar `Task<T>` de vuelta a `ValueTask<T>` es la misma edición mecánica en sentido inverso. La única salvedad es el caso de API pública. Si distribuiste la versión `Task<T>` en un paquete NuGet lanzado, volver a `ValueTask<T>` es otro cambio que rompe la compatibilidad binaria, así que los consumidores externos recompilan dos veces. El código interno no tiene esa restricción; mantén la migración en una rama y revierte el commit si el benchmark dice que provocaste una regresión.

## Problemas que encontramos

**`Task.FromResult` no es gratis para tipos de referencia que de todas formas asignas.** `Task.FromResult(value)` aún asigna un `Task<T>` para un valor arbitrario. El runtime almacena en caché las tareas para `Task.FromResult(true)`, `false` y enteros pequeños, pero no para tu `User`. Si reviertes precisamente porque el método ahora rara vez se completa de forma síncrona, esto no importa; si todavía se completa de forma síncrona la mayoría de las veces, esa asignación es justo lo que `ValueTask` evitaba. Mide antes de asumir que la reversión es inofensiva.

**`async` sobre un cuerpo síncrono reintroduce la máquina de estados.** Reescribir `return new ValueTask<T>(cachedValue)` como un método `async` que retorna `cachedValue` añade una asignación de máquina de estados encima del `Task<T>`. Mantén la ruta rápida sin `async`: retorna `Task.FromResult(...)` desde un método simple, exactamente como en el paso 2. El mismo razonamiento que hace que [ConfigureAwait siga importando en .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/) aplica aquí: la ruta asíncrona más barata es la que nunca construye una máquina de estados.

**La semántica de cancelación no cambia, pero verifícala de todos modos.** Tanto `Task<T>` como `ValueTask<T>` exponen la cancelación como un esperable fallido/cancelado; la reversión no cambia cómo fluye un `CancellationToken`. Aun así, vuelve a probar tus rutas de cancelación, porque la reescritura toca cada sentencia de retorno. Si tu manejo de cancelación ya era frágil, consulta [cómo cancelar una Task de larga duración sin provocar un interbloqueo](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**`IAsyncEnumerable<T>` es el único lugar donde conviene mantener `ValueTask`.** `IAsyncEnumerator<T>.MoveNextAsync` retorna `ValueTask<bool>` por diseño, y `DisposeAsync` retorna `ValueTask`. No "reviertas" estos; la maquinaria de async streams está construida para reutilizar la fuente de respaldo entre iteraciones, que es el caso de manual donde `ValueTask` rinde. Si trabajas con streams, [usar IAsyncEnumerable<T> con EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) muestra el patrón en contexto.

**Fire-and-forget ocultaba un doble consumo.** Un patrón que encontramos al revertir: un `ValueTask` se asignaba a un campo y se observaba más tarde, lo cual es ilegal y corrompía silenciosamente los resultados bajo carga. Cambiar a `Task<T>` lo hizo legal, pero la corrección correcta era dejar de hacer fire-and-forget del todo. Si ves esto, lee [cómo ejecutar trabajo fire-and-forget de forma segura](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) antes de taparlo con un cambio de tipo, y vigila la [ObjectDisposedException sobre un contexto liberado](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) que el mismo patrón fire-and-forget tiende a producir.

El resumen honesto: revertir `ValueTask<T>` a `Task<T>` es el valor predeterminado correcto para código que adoptó la struct sin un profiler en mano. Cambias una microoptimización que probablemente no estabas obteniendo por un tipo que todo tu equipo puede usar sin leer una lista de reglas. Mantén `ValueTask` exactamente donde los datos dicen que se gana su lugar (rutas críticas de finalización síncrona y async streams) y deja que `Task<T>` cargue con todo lo demás.

## Fuentes

- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
