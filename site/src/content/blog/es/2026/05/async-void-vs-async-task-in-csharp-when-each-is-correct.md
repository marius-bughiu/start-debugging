---
title: "async void vs async Task en C#: cuándo es correcto cada uno"
description: "async Task es el valor por defecto y async void es la excepción. Usa async void solo para manejadores de eventos, manejadores del bucle de mensajes y un puñado de callbacks del framework que exigen una firma void. En todo lo demás, async Task gana en excepciones, composición y testeabilidad."
pubDate: 2026-05-20
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-10"
lang: "es"
translationOf: "2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct"
translatedBy: "claude"
translationDate: 2026-05-20
---

Si estás eligiendo entre `async void` y `async Task` para un método que vas a escribir en C# 14 / .NET 10, la respuesta es `async Task`. Las únicas razones legítimas para declarar `async void` son los manejadores de eventos conectados a un evento con `+=`, los manejadores de nivel superior en un bucle de mensajes (un click de botón en WinForms, un manejador `Loaded` en WPF, un evento de página en MAUI) y un conjunto minúsculo de callbacks del framework cuya firma está fijada por un contrato externo (`ICommand.Execute`, ciertos fixtures de prueba, algunos runners de pruebas). Para cualquier cosa que llames tú mismo, `async Task` es correcto porque las excepciones se pueden capturar, el sitio de llamada puede hacer `await` de la finalización y el método se vuelve componible con `Task.WhenAll`, cancelación y pruebas unitarias.

Este artículo es la versión larga de esa respuesta. Todo lo de abajo usa `<TargetFramework>net10.0</TargetFramework>` y `<LangVersion>14.0</LangVersion>` salvo que se indique lo contrario, pero las reglas no han cambiado desde que se añadió async en C# 5.0.

## Matriz de características

| Característica                                  | `async void`                                                   | `async Task`                                |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| El llamador puede usar `await`                  | no                                                             | sí                                          |
| El llamador puede usar `catch` con las excepciones lanzadas | no, se propagan al `SynchronizationContext` / `AppDomain` | sí, capturadas en el `Task` devuelto    |
| Componible con `Task.WhenAll` / `.WhenAny`      | no                                                             | sí                                          |
| Testeable para finalización / resultado         | no, vuelve de inmediato                                        | sí, haz `await` del `Task` devuelto         |
| Activa `SynchronizationContext.OperationStarted/Completed` | sí                                                | no                                          |
| Sobrevive a una excepción no manejada           | bloquea el proceso por defecto desde .NET Framework 4.5        | no, la excepción permanece en el `Task` hasta ser observada |
| Firma compatible con eventos de C#              | sí (`EventHandler` devuelve `void`)                            | no                                          |
| Legal en interfaces / overrides virtuales donde el contrato dice `void` | sí                                  | solo si el contrato devuelve `Task`         |

La tabla es el artículo. Todo lo de abajo es el porqué.

## Por qué `async void` es hostil con los llamadores

El compilador de C# reescribe los métodos `async` en una máquina de estados que entrega su trabajo a un `AsyncMethodBuilder`. Para los métodos `async Task` el builder es [`AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder), que expone una propiedad `Task`. Cuando la máquina de estados termina, el builder llama a `SetResult` o `SetException` en esa tarea, y cualquier llamador que tenga la referencia observa el resultado.

Para `async void` el builder es [`AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder). No tiene `Task` que devolver. De ahí se derivan tres consecuencias concretas.

Primero, el sitio de llamada no tiene un handle para esperar. Si escribes `DoStuffAsync();` y `DoStuffAsync` devuelve `void`, la línea termina cuando el primer `await` dentro del método se suspende, no cuando el trabajo del método finaliza. La siguiente sentencia se ejecuta inmediatamente, incluso si el método aún no ha hecho su trabajo. Esta es la causa del bug clásico "los datos ya no están cuando los leo".

Segundo, las excepciones lanzadas dentro de un método `async void` no se guardan en ninguna parte. `AsyncVoidMethodBuilder.SetException` las publica en el `SynchronizationContext` que estaba activo cuando arrancó el método. En un proceso WinForms o WPF eso significa el bucle de mensajes del hilo de UI, que dispara `Application.ThreadException` (WinForms) o `Application.DispatcherUnhandledException` (WPF). En una aplicación de consola o en un contexto en segundo plano de ASP.NET Core el contexto de sincronización es nulo, así que la excepción se encola en el grupo de hilos, que la expone en `AppDomain.CurrentDomain.UnhandledException` y, desde .NET Framework 4.5 y todas las versiones de .NET 5+, termina el proceso. No hay `try/catch` en el sitio de llamada que pueda salvarte, porque la excepción nunca viaja a través del sitio de llamada.

Tercero, el método llama a [`SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted) cuando arranca y `OperationCompleted` cuando termina. La mayoría de los contextos ignoran estas llamadas. Las excepciones son contextos al estilo `AsyncOperationManager` usados por `xUnit` y unos pocos frameworks de testing: cuentan el trabajo asíncrono pendiente para que el runner sepa cuándo considerar terminada una prueba. Para un método `async void`, el runner esperará. Para los llamadores ordinarios, este trabajo se desperdicia.

## Reproducción mínima: un crash que no puedes capturar

```csharp
// .NET 10, C# 14, console app
using System;
using System.Threading.Tasks;

try
{
    Boom();
    await Task.Delay(100);
}
catch (Exception ex)
{
    Console.WriteLine($"caught: {ex.Message}");
}

static async void Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async void");
}
```

Ejecútalo. La salida no es "caught: from async void". Es una traza de excepción no manejada y el proceso termina con un código distinto de cero. El bloque `catch` de arriba nunca ve la excepción porque la excepción se lanza en el worker del grupo de hilos que reanudó la máquina de estados tras `Task.Yield`, no en la pila del llamador original.

Cambia una palabra clave:

```csharp
// .NET 10, C# 14
static async Task Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async Task");
}
```

Ahora `await Boom();` en el sitio de llamada captura la excepción, e incluso `Boom();` sin `await` no bloqueará el proceso: la excepción permanece en el `Task` no observado hasta que alguien la observa o el `Task` se finaliza (lo cual, por defecto, tampoco bloquea ya el proceso desde que la opción `<ThrowUnobservedTaskExceptions>` cambió a `false` por defecto en .NET 4.5).

## Cuándo es correcto `async void`

Hay exactamente tres categorías en las que `async void` es apropiado. Sé estricto al quedarte dentro de ellas.

**Manejadores de eventos conectados a un evento de CLR.** El delegado `EventHandler` devuelve `void`. No puedes hacer que el método devuelva `Task` y suscribirte con `+=` a la vez. Si escribes un manejador `Button.Click`, un manejador `Window.Loaded`, un manejador `Page.Appearing` de MAUI o cualquier firma de la forma `void (object?, EventArgs)`, debe ser `async void`. El framework (WinForms, WPF, MAUI, Avalonia, Uno) dispara el evento en el hilo de UI, y el contexto de sincronización publica las excepciones no manejadas en el evento de excepción no manejada del dispatcher del hilo de UI, que la mayoría de las aplicaciones ya registra. Mantén el manejador delgado y delega a un método `async Task` tan pronto como hayas hecho el moldeado de argumentos:

```csharp
// .NET 10, MAUI, C# 14
private async void OnSaveClicked(object? sender, EventArgs e)
{
    try
    {
        await SaveAsync(_viewModel.Form);
    }
    catch (Exception ex)
    {
        await DisplayAlert("Save failed", ex.Message, "OK");
    }
}

private async Task SaveAsync(FormData form)
{
    using var http = _httpFactory.CreateClient("api");
    var response = await http.PostAsJsonAsync("/forms", form);
    response.EnsureSuccessStatusCode();
}
```

El `try/catch` es obligatorio en el manejador. El manejador es el único sitio donde tienes una oportunidad de observar una excepción antes de que el runtime la convierta en un crash, así que no lo dejes vacío.

**Callbacks de nivel superior del bucle de mensajes.** Algunos frameworks exponen puntos de enganche que parecen eventos pero son en realidad delegados con firma `void`: un manejador `Executed` de un comando enrutado, un override de `ICommand.Execute(object)` (la interfaz devuelve `void`), un manejador `BackgroundWorker.DoWork`, un manejador `Timer.Elapsed` con la firma estilo `System.Timers.Timer`, etc. La regla es la misma que para los eventos: mantenlos delgados y envuélvelos en `try/catch`.

**Callbacks del framework cuyo contrato está fijado.** xUnit 2 llama a `IAsyncLifetime.InitializeAsync` y `DisposeAsync` como `Task`, pero algunos hooks de estilo atributo en runners de pruebas todavía esperan un método `void`, y algunos hooks de contenedores de IoC (`IHostedService` de `Microsoft.Extensions.Hosting` devuelve `Task`, pero el callback más antiguo `IApplicationLifetime.ApplicationStarted` devuelve `void`). Si la firma de la biblioteca de terceros dice `void`, no tienes elección. Documéntalo en un comentario para que un lector futuro no lo "arregle".

Todo lo demás es `async Task`.

## Qué pierdes cuando recurres a `async void`

Si un método necesita fallar a viva voz cuando algo va mal, no devuelve nada significativo, y recurres a `async void` para saltarte la ceremonia del `await`, te has apuntado a:

- **Trazas de pila perdidas.** La excepción que aparece en el contexto de sincronización pierde la pila original del sitio de llamada. Ves el frame relanzado, no "esto fue llamado desde `OnSaveClicked`".
- **Sin cancelación.** No puedes pasar la cancelación a través, porque el llamador no tiene un `Task` que esperar. Un argumento `CancellationToken` sigue funcionando dentro del método, pero el llamador no puede reaccionar a un `OperationCanceledException` ya que nunca se propaga de vuelta.
- **Sin timeout vía `Task.WhenAny`.** Un patrón común es `await Task.WhenAny(work, Task.Delay(timeout, ct))`. Necesitas un `Task` para eso. `async void` no tiene ninguno.
- **Sin pruebas para la finalización.** xUnit, NUnit y MSTest pueden hacer `await` de un método de prueba `async Task` y observar su resultado. No pueden hacer `await` de una prueba `async void`. Algunos frameworks tratan especialmente los métodos de prueba `async void` (NUnit más antiguo, MSTest v2 con peculiaridades del adaptador); ninguno lo recomienda. Mira el patrón con más detalle en [cómo hacer pruebas unitarias de código que usa HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), donde cada prueba es `async Task`.
- **Fire-and-forget que también es fire-and-crash.** Muchos patrones "fire-and-forget" se convierten silenciosamente en llamadas `async void` cuando los desarrolladores se olvidan del `await`. La solución no es `async void`; la solución es un descarte explícito `_ = SomeAsync();` y aceptar que el `Task` resultante no se observa, o mejor, entregar la tarea a un lugar conocido que la observe (un logger, una cola en segundo plano).

## El benchmark: ¿`async void` ahorra algo?

A veces el argumento para `async void` es "es más barato porque no hay asignación de `Task`". Vamos a medirlo.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
// dotnet add package BenchmarkDotNet
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<AsyncShapes>();

[MemoryDiagnoser]
public class AsyncShapes
{
    [Benchmark(Baseline = true)]
    public async Task ReturnsTask()
    {
        await Task.Yield();
    }

    [Benchmark]
    public void ReturnsVoid()
    {
        DoVoid();

        static async void DoVoid() => await Task.Yield();
    }
}
```

Metodología: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X, harness de benchmark síncrono de un solo hilo. Ambos métodos hacen un `Task.Yield`, lo que fuerza una continuación en el grupo de hilos.

| Método      | Media     | Asignado  |
| ----------- | --------- | --------- |
| ReturnsTask | 1.34 us   | 152 B     |
| ReturnsVoid | 1.29 us   | 136 B     |

La versión `async void` ahorra 16 bytes (una instancia de `Task`) y es aproximadamente un 4% más rápida, lo cual no significa nada al lado del salto al grupo de hilos. Los runtimes modernos hacen pooling de `AsyncTaskMethodBuilder.Task` para tareas completadas no genéricas, así que la diferencia de asignación en estado estable es incluso más pequeña de lo que muestra el microbenchmark. El argumento de rendimiento para `async void` no es real.

## El detalle que decide por ti

Si te tienta `async void` para un método que no es de evento, dos cosas deberían hacerte cambiar de opinión al instante.

La primera son las tareas fire-and-forget que abarcan la vida útil de una solicitud. ASP.NET Core no te da un `SynchronizationContext` por defecto, así que una excepción en un `async void` sube a `ThreadPool.UnobservedExceptionEvent` y, dependiendo de tus ajustes de `<ServerGarbageCollection>`, puede tumbar el proceso worker con ella. En el momento en que decidas "arrancar algo de trabajo en segundo plano desde un controller", cambia a `IHostedService` o, para algo de una sola vez, devuelve el `Task` al framework a través de algo que lo observe (`BackgroundService`, una cola consciente de `IHostApplicationLifetime`, [Channels](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)).

La segunda son las interfaces. Si alguna vez quieres que un método sea mockeable o parte de un contrato, tiene que devolver algo. `Task` es el tipo de retorno estándar para una operación asíncrona que no produce un valor. `void` no puede ser esperado con `await` por un mock o un fake, y no podrás coordinar la configuración de prueba a su alrededor. El patrón de mocking en [cómo simular DbContext sin romper el seguimiento de cambios](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) se apoya en miembros que devuelven `Task` por la misma razón.

## La recomendación con opinión, de nuevo

Por defecto, usa `async Task`. Usa `async void` para las tres categorías exactas de arriba: manejadores de eventos de CLR, callbacks estilo bucle de mensajes o de comando cuya firma está fijada por el framework, y hooks de terceros que exigen `void`. Envuelve cada `async void` en `try/catch` y delega a un helper `async Task` tan pronto como hayas moldeado los argumentos de la llamada. Si ves `async void` en un método que escribiste tú mismo por cualquier otra razón, trátalo como un crash de proceso latente y cámbialo.

Dos corolarios que vale la pena fijar en la memoria muscular:

- Un `async void` que hace `I/O` y se olvida del `try/catch` es un crash a la espera del `await`. La máquina de estados no tiene dónde poner una excepción lanzada salvo el contexto de sincronización, y la mayoría de los contextos en .NET moderno tratan eso como fatal.
- Un `async Task` que nunca esperas con `await` no es lo mismo que `async void`. El `Task` sigue capturando la excepción; simplemente permanece ahí hasta la observación o la finalización. Usa `_ = SomeAsync();` solo cuando estés seguro del ciclo de vida, y prefiere entregar el `Task` a una infraestructura de cola en segundo plano que sea su dueña.

## Relacionado

- [Cómo cancelar una Task de larga duración en C# sin generar interbloqueo](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Cómo usar Channels en lugar de BlockingCollection en C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException: A task was canceled en HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Fix: InvalidOperationException: Synchronous operations are disallowed en ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)

## Fuentes

- [Tipos de retorno async -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-return-types)
- [Stephen Cleary, "Async/Await -- Best Practices in Asynchronous Programming"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [Stephen Cleary, "Async OOP 5: Events"](https://blog.stephencleary.com/2013/02/async-oop-5-events.html)
- [Referencia de `AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder)
- [Referencia de `AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder)
- [Referencia de `SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted)
