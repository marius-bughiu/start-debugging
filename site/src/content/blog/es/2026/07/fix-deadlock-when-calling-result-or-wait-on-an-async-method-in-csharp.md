---
title: "Solución: interbloqueo al llamar a .Result o .Wait() sobre un método async en C#"
description: "Bloquear una Task async con .Result o .Wait() provoca un interbloqueo cuando hay un SynchronizationContext presente. Aquí explico por qué se cuelga y cómo solucionarlo en .NET 11 y C# 14."
pubDate: 2026-07-20
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "deadlock"
lang: "es"
translationOf: "2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-20
---

Si una llamada a `task.Result`, `task.Wait()` o `task.GetAwaiter().GetResult()` se cuelga para siempre y nunca lanza una excepción, tienes un interbloqueo de tipo sync-sobre-async. Ocurre cuando bloqueas un hilo que posee un `SynchronizationContext` de un solo hilo (un hilo de UI de WPF o WinForms, un hilo de solicitud de ASP.NET clásico) mientras el método async que estás bloqueando intenta reanudar su continuación en ese mismo hilo. El hilo está atascado esperando a la tarea; la tarea está atascada esperando al hilo. La solución es dejar de bloquear: hacer que toda la cadena de llamadas sea asíncrona de principio a fin, de modo que uses `await` en lugar de `.Result`. Este artículo explica el mecanismo en .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) y recorre cada solución en orden de preferencia, incluyendo las que parecen correctas pero no funcionan.

## Por qué el hilo se espera a sí mismo

Un `await` hace dos cosas que la gente olvida. Antes de suspenderse, captura el `SynchronizationContext` actual (mediante `SynchronizationContext.Current`). Cuando la tarea esperada se completa, no se reanuda simplemente en cualquier hilo: por defecto publica la continuación, el código que sigue al `await`, de vuelta en ese contexto capturado. En un hilo de trabajo genérico del grupo de subprocesos no hay contexto, así que la continuación se ejecuta en cualquier hilo libre del grupo y no pasa nada especial. Pero en un hilo de UI o en una solicitud de ASP.NET clásico, el contexto es de un solo hilo. Tiene exactamente un hilo autorizado para ejecutar su trabajo en cola.

Ahora pon esos dos hechos junto a una llamada bloqueante:

1. Tu hilo de UI llama a `GetDataAsync().Result`. Eso bloquea el hilo de UI y lo retiene.
2. Dentro de `GetDataAsync`, un `await SomeIoAsync()` capturó el `SynchronizationContext` de la UI antes de suspenderse.
3. `SomeIoAsync` termina. El runtime intenta publicar la continuación de `GetDataAsync` de vuelta en el contexto de la UI para poder ejecutar el resto del método y completar la tarea.
4. El contexto de la UI tiene un hilo. Ese hilo está bloqueado en el paso 1, esperando a que la tarea se complete. Nunca recogerá la continuación.
5. La tarea no puede completarse hasta que se ejecute la continuación. La continuación no puede ejecutarse hasta que el hilo se libere. El hilo no se liberará hasta que la tarea se complete. Interbloqueo.

Stephen Cleary nombró este patrón hace años en [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html), y el mecanismo no ha cambiado. El runtime no tiene un error. Bloquear sobre una tarea cuya continuación necesita el hilo que estás bloqueando es una espera circular genuina.

## La reproducción mínima que se cuelga

Necesitas dos cosas: un `SynchronizationContext` de un solo hilo y una llamada bloqueante sobre un `await` que lo capture. Un manejador de botón de WinForms es la reproducción clásica, pero no necesitas un proyecto de UI. Puedes instalar un contexto de un solo hilo a mano y verlo colgarse.

```csharp
// .NET 11, C# 14 -- this deadlocks
using System.Threading;

var context = new SingleThreadedSyncContext();
SynchronizationContext.SetSynchronizationContext(context);

// Block on an async method from the context-owning thread:
string result = GetGreetingAsync().Result;   // hangs forever
Console.WriteLine(result);

static async Task<string> GetGreetingAsync()
{
    // Captures the current (single-threaded) context here:
    await Task.Delay(100);
    // The runtime tries to post THIS line back to the captured context,
    // but that thread is blocked on .Result above.
    return "hello";
}
```

En una aplicación WPF o WinForms real no escribes `SetSynchronizationContext` tú mismo. El framework instala un `DispatcherSynchronizationContext` (WPF) o un `WindowsFormsSynchronizationContext` (WinForms) en el hilo de UI antes de que se ejecuten tus manejadores de eventos, así que cualquier manejador que haga `SomethingAsync().Result` reproduce esto al instante. ASP.NET clásico (System.Web, no ASP.NET Core) instala `AspNetSynchronizationContext` en el hilo de solicitud con el mismo comportamiento de un solo hilo.

## La única solución real: asíncrono de principio a fin

El interbloqueo existe porque bloqueaste. Quita el bloqueo y desaparece. Propaga `async`/`await` hacia arriba en la cadena de llamadas hasta que el llamador más externo pueda usar `await` en lugar de leer `.Result`.

```csharp
// .NET 11, C# 14 -- no block, no deadlock
private async void OnLoadClick(object sender, EventArgs e)
{
    string greeting = await GetGreetingAsync();   // await, not .Result
    label.Text = greeting;
}
```

Aquí `await` sigue capturando el contexto de la UI, pero nada bloquea el hilo de UI. El manejador se suspende, el hilo de UI vuelve al bucle de mensajes y permanece libre, y cuando `GetGreetingAsync` se completa su continuación se publica de vuelta y se ejecuta limpiamente en el hilo de UI ahora inactivo. Eso es exactamente para lo que sirve un `SynchronizationContext` de UI. La continuación aterriza de vuelta en el hilo de UI, así que puedes tocar `label.Text` sin marshalling.

Los manejadores de eventos son el único lugar sancionado para `async void` precisamente porque están en la cima de la pila de llamadas y no tienen un llamador que los espere. Todo lo que esté debajo de ellos debería ser `async Task`. Si no estás seguro de dónde `async void` es legítimo y dónde es un error, la distinción se cubre en [cuándo async void es correcto y cuándo es una trampa](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

La misma regla se aplica en el servidor. Una acción de ASP.NET MVC clásico, un manejador de Razor Page, un método de hub de SignalR: hazlos `async Task` y usa `await` sobre el trabajo en lugar de bloquear. Aquí no hay crédito parcial. Un solo `.Result` en cualquier punto de la ruta síncrona puede reintroducir el interbloqueo aunque cada otra capa sea asíncrona.

## La solución de biblioteca: ConfigureAwait(false)

A veces no puedes hacer async toda la cadena, porque la llamada bloqueante vive en código que no posees. Si tú eres el autor de la biblioteca async sobre la que se bloquea, puedes desactivar el interbloqueo desde tu lado indicando a cada `await` que no capture el contexto:

```csharp
// .NET 11, C# 14 -- library code that stays deadlock-safe under a blocking caller
public async Task<string> GetGreetingAsync()
{
    await Task.Delay(100).ConfigureAwait(false);
    // No captured context, so this continuation runs on a thread pool
    // thread, not the caller's blocked UI/request thread.
    return "hello";
}
```

`ConfigureAwait(false)` dice "no necesito reanudarme en el contexto capturado." La continuación se ejecuta en su lugar en un hilo del grupo de subprocesos, que no es el bloqueado, así que la espera circular nunca se forma y la tarea puede completarse. Por eso la recomendación para bibliotecas compartidas es poner `.ConfigureAwait(false)` en cada await, como detalla Microsoft en la [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/).

Dos advertencias impiden que esto sea una cura general. Primero, solo ayuda si se aplica en cada `await` en toda la clausura transitiva de la llamada bloqueada. Omite un solo await en lo profundo de una dependencia y el interbloqueo vuelve, que es exactamente por qué es una disciplina de biblioteca y no una solución que espolvoreas en el sitio de la llamada. Segundo, en tu propio código de aplicación no deberías estar bloqueando en primer lugar, así que `ConfigureAwait(false)` en el código de aplicación es tratar un síntoma. El matiz de cuándo todavía importa, y cuándo los analizadores del compilador te empujan hacia él, está en [ConfigureAwait(false) frente al comportamiento por defecto en .NET 11](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Soluciones que parecen correctas pero no funcionan

**Cambiar `.Result` por `.GetAwaiter().GetResult()`.** La gente recurre a esto porque desenvuelve la excepción en lugar de envolverla en `AggregateException`. No cambia nada sobre el interbloqueo. `GetAwaiter().GetResult()` sigue bloqueando el hilo llamante hasta que la tarea se completa, y la tarea sigue sin poder completarse porque su continuación está en cola detrás del bloqueo. Mejores excepciones, cuelgue idéntico.

**Añadir un tiempo de espera con `Wait(TimeSpan)`.** `task.Wait(5000)` devolverá `false` tras cinco segundos en lugar de colgarse para siempre, pero eso no es una solución, es un fallo más lento. La operación siguió sin completarse, y ahora has tapado un problema de diseño con un número mágico. La continuación subyacente sigue atascada.

**Envolver el método async en `Task.Run` y bloquear sobre eso.** Este de hecho rompe el interbloqueo, y por eso es peligroso. `Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult()` inicia el método async en un hilo del grupo de subprocesos, que no tiene un contexto de un solo hilo, así que sus continuaciones ya no apuntan a tu hilo de UI bloqueado. El cuelgue desaparece.

```csharp
// .NET 11, C# 14 -- avoids the deadlock, but it is a smell, not a solution
string greeting = Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult();
```

Funciona, pero ahora estás quemando un hilo del grupo de subprocesos para bloquear otro hilo, has perdido el contexto de la UI para cualquier continuación que legítimamente lo necesitara, y has ocultado el hecho de que la llamada debería haber sido asíncrona. Microsoft documenta este patrón de descarga bajo [envoltorios síncronos para métodos asincrónicos](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) con la misma advertencia: trátalo como un último recurso para un punto de entrada genuinamente solo-síncrono, no como una forma de seguir escribiendo código bloqueante.

## Por qué ASP.NET Core no se interbloquea aquí (y cómo muerde de otra forma)

Si pasaste de ASP.NET clásico a ASP.NET Core y tus antiguos interbloqueos desaparecieron, esta es la razón: ASP.NET Core no tiene `SynchronizationContext`. `SynchronizationContext.Current` es `null` dentro de una solicitud, así que `await` nunca captura un contexto de un solo hilo, las continuaciones siempre se ejecutan en hilos del grupo de subprocesos, y la espera circular específica descrita arriba no puede formarse. Por eso también `ConfigureAwait(false)` no tiene efecto en un manejador de solicitud de ASP.NET Core: no hay contexto del que optar por salir.

Esto no hace que bloquear sea seguro en ASP.NET Core. Cambia un interbloqueo determinista por uno probabilístico llamado inanición del grupo de subprocesos. Cada solicitud que se bloquea sobre `.Result` estaciona un hilo del grupo de subprocesos sin hacer nada más que esperar. Bajo carga, el grupo reparte hilos más rápido de lo que la tasa de inyección (por defecto, gradual) puede reponer los estacionados, así que las nuevas solicitudes se encolan sin ningún hilo en el que ejecutarse. La aplicación no se cuelga en la solicitud uno; se derrumba en una concurrencia que no puedes reproducir en tu portátil. La cura es idéntica: no bloquees, ve asíncrono de principio a fin. Si tu bloqueo estaba ahí para acotar una operación larga, hazlo con cancelación en su lugar, como en [cancelar una Task de larga duración sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), y asegúrate de que el token realmente llegue a la llamada hoja [propagando el CancellationToken por la cadena](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

## Una lista de verificación para cazar el bloqueo que se cuelga

Cuando algo se cuelga y sospechas de esto, busca el bloqueo, no el método async:

1. **Busca en la ruta síncrona `.Result`, `.Wait(` y `.GetAwaiter().GetResult()`.** Uno de ellos está en un hilo que posee un contexto. Ese es tu culpable, no el inocente `await` que está bloqueando.
2. **Confirma que hay un contexto de un solo hilo en juego.** Hilo de UI, solicitud de ASP.NET clásico o un contexto personalizado. Si estás en ASP.NET Core o en una aplicación de consola sencilla sin contexto instalado, el síntoma es inanición o una respuesta lenta, no un cuelgue duro.
3. **Reemplaza el bloqueo por `await` y haz que el método contenedor sea `async Task`.** Repite hacia arriba en la pila hasta que llegues a un punto de entrada que pueda ser asíncrono (un manejador de eventos, un `Main`, una acción de controlador).
4. **Si una capa genuinamente no puede ser async**, y posees la biblioteca async, añade `ConfigureAwait(false)` en toda esa biblioteca. Si no la posees, la descarga con `Task.Run` es el último recurso, con los costes anteriores.
5. **Nunca lo "soluciones" con un tiempo de espera.** Un `Wait(timeout)` que devuelve false es un interbloqueo que se rinde, no un diseño que funciona.

El hilo conductor es simple: el código async quiere seguir siendo async. En el momento en que lo bloqueas desde un hilo que su continuación necesita, has construido una espera circular a mano. Deja de bloquear y el interbloqueo no puede existir. Todo lo demás en esta página es control de daños para los casos en que aún no puedes dejar de bloquear.

## Related

- [Cuándo async void es correcto y cuándo es una trampa en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) frente al comportamiento por defecto en .NET 11: ¿todavía importa?](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Cómo cancelar una Task de larga duración en C# sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Cómo propagar un CancellationToken a través de métodos async en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)

## Sources

- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) -- .NET Blog
- [ASP.NET Core SynchronizationContext](https://blog.stephencleary.com/2017/03/aspnetcore-synchronization-context.html) -- Stephen Cleary
- [Synchronous wrappers for asynchronous methods](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) -- Microsoft Learn
- [CA2007: Do not directly await a Task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) -- Microsoft Learn
