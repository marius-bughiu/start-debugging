---
title: "Solución: CS4014 \"Because this call is not awaited, execution of the current method continues\" en C#"
description: "CS4014 significa que llamaste a un método que devuelve Task sin esperarlo. Agrega await, o descártalo con _ = si el fire-and-forget es intencional, y maneja las excepciones."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "es"
translationOf: "2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-21
---

`CS4014` se dispara cuando llamas a un método que devuelve `Task` o `Task<T>` desde dentro de un método `async` pero no lo esperas con `await`. El compilador advierte que el método actual sigue ejecutándose antes de que la llamada termine. Soluciónalo agregando `await` a la llamada, que es lo que quieres la gran mayoría de las veces. Si el comportamiento fire-and-forget es realmente intencional, hazlo explícito asignando el resultado a un descarte (`_ = SomeAsyncCall();`), y asegúrate de que algo maneje las excepciones que la tarea pueda lanzar. Esto está verificado contra C# 14 en .NET 11; el diagnóstico se comporta así desde que `async`/`await` llegó en C# 5, así que la guía aplica a toda versión moderna de .NET.

## El error en contexto

El compilador emite esto como una advertencia, no como un error:

```
warning CS4014: Because this call is not awaited, execution of the current method continues before the call is completed. Consider applying the 'await' operator to the result of the call.
```

Fíjate en la palabra *warning*. `CS4014` no detiene la compilación por defecto, y precisamente por eso es peligrosa: es fácil de ignorar, y el error al que apunta (una tarea ejecutándose sin ser observada, con sus excepciones silenciosamente tragadas) no aparece hasta que estás en producción. Muchos equipos la elevan a error con `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` o el más específico `<WarningsAsErrors>CS4014</WarningsAsErrors>` en el `.csproj`, justamente para que un `await` olvidado por accidente no pueda pasar la revisión de código.

La advertencia solo aparece dentro de un método `async`. El compilador razona que si te tomaste la molestia de marcar el método contenedor como `async`, una llamada a tarea sin esperar es casi con certeza un descuido. Llama al mismo método desde un método no `async` y no obtienes ningún `CS4014`, lo cual es una trampa relacionada que veremos más abajo.

## Por qué ocurre

Un método `async` que devuelve `Task` empieza ejecutándose de forma síncrona y devuelve un objeto tarea en el momento en que llega a su primer `await` incompleto. La tarea representa la operación que aún está en curso. Cuando escribes `DoWorkAsync();` como una instrucción suelta, tiras ese objeto tarea. De ahí se siguen dos cosas, y ambas son malas.

Primero, la ejecución no espera. La línea después de tu llamada se ejecuta de inmediato, antes de que `DoWorkAsync` haya terminado. Cualquier código que dependa de que la operación se complete, una escritura en la base de datos, un vaciado de archivo, una actualización de caché, ahora compite contra ella. Esta es la mitad de "execution of the current method continues" del mensaje.

Segundo, y peor, las excepciones desaparecen. Cuando esperas una tarea con `await`, cualquier excepción que haya capturado se relanza dentro de tu método para que tu `try`/`catch` pueda verla. Descarta la tarea y no queda nada que relanzar dentro. La excepción queda sobre el objeto tarea descartado, sin observar, hasta que el recolector de basura eventualmente lo finalice. En .NET Framework 4.0 eso hacía caer el proceso; desde 4.5 y en todo el .NET moderno lo predeterminado es tragarla por completo. Así que una tarea sin esperar que falla se ve exactamente como un éxito desde el punto de vista del llamador. Ese fallo silencioso es la verdadera razón por la que existe `CS4014`, y por la que "simplemente suprimir la advertencia" casi nunca es lo correcto.

El único caso en el que el compilador no puede ayudarte: `async void`. Si `DoWorkAsync` devuelve `void` en lugar de `Task`, no hay tarea que esperar y no hay `CS4014`, pero aplican todos los mismos problemas más uno adicional: una excepción de un método `async void` se lanza sobre el contexto de sincronización y normalmente derriba el proceso. Ese es un diagnóstico aparte, tratado en [async void vs async Task en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Reproducción mínima

El código más pequeño que dispara `CS4014`:

```csharp
// .NET 11, C# 14
public class OrderService
{
    public async Task PlaceOrderAsync(Order order)
    {
        SaveAsync(order);          // CS4014: not awaited
        Console.WriteLine("Order placed");   // runs before SaveAsync finishes
    }

    private async Task SaveAsync(Order order)
    {
        await Task.Delay(100);     // stand-in for a real DB write
        throw new InvalidOperationException("DB down");
    }
}
```

Dos errores en cuatro líneas. `"Order placed"` se imprime antes de que la escritura se haya ejecutado, y la `InvalidOperationException` no la ve nadie: `PlaceOrderAsync` se completa con éxito hasta donde su llamador puede saber. La advertencia es la única señal que obtienes en tiempo de compilación de que el pedido nunca se guardó realmente.

Una variante común oculta la llamada dentro de un `Task.Run` o de un manejador de eventos, donde es más fácil pasarla por alto:

```csharp
// .NET 11, C# 14
button.Clicked += async (s, e) =>
{
    RefreshAsync();   // CS4014: fire-and-forget by accident
};
```

## Solución, en detalle

Recorre estas en orden. La primera es correcta para casi toda aparición real; el resto son para las excepciones genuinas.

### 1. Agregar await (la solución que quieres el 95% de las veces)

Si estás dentro de un método `async`, la intención casi siempre es esperar la llamada. Agrega `await`:

```csharp
// .NET 11, C# 14
public async Task PlaceOrderAsync(Order order)
{
    await SaveAsync(order);        // waits, and re-throws any exception
    Console.WriteLine("Order placed");
}
```

Ahora `"Order placed"` se imprime solo después de que la escritura se completa, y si `SaveAsync` lanza, la excepción se propaga fuera de `PlaceOrderAsync` para que un `try`/`catch` del llamador (o el pipeline de ASP.NET Core) pueda manejarla. Este único cambio soluciona a la vez el error de orden y el de la excepción tragada. Recurre a las otras opciones solo cuando puedas articular por qué esperar está mal.

### 2. Esperar varias llamadas juntas con Task.WhenAll

Si la razón por la que no esperaste con `await` era que querías que varias operaciones corrieran de forma concurrente, no descartes las tareas: recógelas y espéralas juntas:

```csharp
// .NET 11, C# 14
public async Task NotifyAllAsync(IEnumerable<User> users)
{
    var tasks = users.Select(u => SendEmailAsync(u));
    await Task.WhenAll(tasks);     // all run concurrently, all awaited
}
```

`Task.WhenAll` te da la concurrencia sin renunciar a la observación: inicia cada tarea, luego se completa cuando la última termina, y relanza si alguna de ellas falló. Este es el patrón correcto para el trabajo de fan-out y elimina `CS4014` porque las tareas se esperan. Para las compensaciones entre este y otros enfoques paralelos, consulta [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/es/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

### 3. Devolver la tarea en lugar de esperarla

Si tu método es un simple pasamanos que no hace nada después de la llamada, a menudo no necesitas `async`/`await` en absoluto. Elimina ambos y devuelve la tarea:

```csharp
// .NET 11, C# 14
public Task PlaceOrderAsync(Order order)
{
    return SaveAsync(order);       // caller awaits; no state machine here
}
```

Esto elimina el modificador `async`, así que `CS4014` ya no aplica (la advertencia solo se genera dentro de métodos `async`), y evita el costo de generar una máquina de estados para un método que no la necesita. El llamador sigue recibiendo una tarea para esperar con `await`. La única salvedad: sin `await`, las excepciones afloran cuando el llamador espera la tarea devuelta en lugar de en el punto de la llamada, y un bloque `using` liberaría su recurso antes de que la tarea devuelta se complete. Usa esto solo para pasamanos genuinos.

### 4. Descartar de forma explícita, solo cuando el fire-and-forget es realmente intencional

A veces sí quieres iniciar trabajo y no esperar: registrar una métrica, precalentar una caché, disparar una notificación de mejor esfuerzo. En ese caso, deja la intención inequívoca con un descarte, y maneja tú mismo las excepciones para que no se pierdan:

```csharp
// .NET 11, C# 14
public void OnUserLoggedIn(User user)
{
    _ = LogAnalyticsAsync(user);   // intentional fire-and-forget, warning cleared
}

private async Task LogAnalyticsAsync(User user)
{
    try
    {
        await _analytics.RecordAsync(user.Id);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Analytics failed for {UserId}", user.Id);
    }
}
```

El descarte `_ =` le dice tanto al compilador como al siguiente lector "sí, quise no esperar esto". Fundamental: el descarte elimina la advertencia pero *no* soluciona el problema de la excepción tragada, así que el `try`/`catch` dentro de `LogAnalyticsAsync` es el que hace el trabajo real. Una tarea fire-and-forget sin manejo interno de excepciones es una caída o un error silencioso de pérdida de datos esperando a ocurrir.

Incluso con un descarte, el fire-and-forget crudo en una aplicación web es frágil: la solicitud puede completarse y el host puede empezar a apagarse mientras tu tarea está a medio camino, cancelándola o matándola. Para cualquier cosa que deba terminar de verdad, no hagas fire-and-forget desde una solicitud en absoluto; entrega el trabajo a una cola en segundo plano. Ese patrón se cubre en [cómo ejecutar trabajo fire-and-forget de forma segura en ASP.NET Core con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Trampas y variantes

Algunas situaciones producen `CS4014`, o lo ocultan, por razones que el mensaje no detalla:

- **Sin advertencia fuera de un método `async`.** La misma llamada sin esperar en un método corriente (no `async`) no produce ningún `CS4014`. El compilador asume que un método no async podría estar iniciando trabajo en segundo plano de forma legítima. Por eso se cuelan errores cuando alguien elimina un `await` y el modificador `async` contenedor al mismo tiempo: la advertencia que lo habría detectado desaparece con el modificador. Si dependes de la advertencia como red de seguridad, mantén `<WarningsAsErrors>CS4014</WarningsAsErrors>` activo y desconfía de cualquier llamada suelta que devuelva Task.

- **El descarte silencia la advertencia pero no el error.** `_ = DoAsync();` elimina `CS4014`, pero si `DoAsync` lanza y nada dentro lo atrapa, la excepción sigue perdiéndose. El descarte es una declaración de intención, no una solución para las excepciones no observadas. Acompaña siempre el fire-and-forget con un `try`/`catch` interno.

- **Bloquear con `.Result` o `.Wait()` no es la solución.** Reemplazar el `await` faltante con `SaveAsync(order).Result` hace que la advertencia desaparezca y bloquea hasta que la tarea termina, pero en un contexto de sincronización de UI o de ASP.NET clásico produce un interbloqueo, y en cualquier otro lugar desperdicia un hilo. Si te tienta bloquear porque no puedes hacer al llamador `async`, lee primero [el interbloqueo que obtienes al llamar a .Result o .Wait() sobre un método async](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **`Task.Run(() => FooAsync())` traga la tarea interna.** Pasar una lambda `async` a `Task.Run` donde el delegado devuelve `void` (una lambda `async void`) te da una `Task` que se completa cuando la lambda *inicia* su primer await, no cuando el trabajo interno termina. Prefiere `Task.Run(FooAsync)` o `Task.Run(async () => await FooAsync())` para que la tarea devuelta rastree el trabajo real, y luego espera esa tarea con `await`.

- **Un `CancellationToken` que nunca propagas.** Una causa frecuente de una tarea fire-and-forget persistente es que el método no tiene forma de cancelarse, así que sigue corriendo después de que el llamador ha seguido adelante. Si tu llamada sin esperar es trabajo en segundo plano, pásale un token para que pueda detenerse limpiamente; consulta [cómo propagar un CancellationToken a través de métodos async](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **Solapamiento del analizador con CA2012 y VSTHRD110.** Más allá del `CS4014` del compilador, los analizadores de .NET (`CA2012` para `ValueTask`) y los analizadores de subprocesos de Visual Studio (`VSTHRD110`, "observe the awaitable result") marcan la misma clase de descuido en más lugares, incluyendo algunos métodos no `async` donde `CS4014` permanece en silencio. Si quieres la comprobación de tarea sin esperar en todas partes, no solo dentro de métodos `async`, activar esos analizadores cierra la brecha que deja la advertencia del compilador.

El modelo mental que conviene retener: `CS4014` es el compilador diciéndote que una tarea está a punto de ejecutarse sin ser observada. Decide cuál es realmente el caso, y luego actúa en consecuencia. Querías esperar (agrega `await`), querías correr varias cosas de forma concurrente (`Task.WhenAll`), el método es un pasamanos (devuelve la tarea), o realmente quieres fire-and-forget (descarta con `_ =` y maneja las excepciones dentro). Suprimir la advertencia con un descarte mientras dejas las excepciones sin manejar solo convierte un empujón en tiempo de compilación en un fallo silencioso en tiempo de ejecución, que es exactamente el error que la advertencia existe para prevenir.

## Relacionados

- [async void vs async Task en C#: cuándo cada uno es correcto](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) para saber por qué la versión que devuelve `void` de esta llamada es aún más peligrosa y no produce advertencia.
- [Solución: interbloqueo al llamar a .Result o .Wait() sobre un método async en C#](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) para entender por qué bloquear no es una forma válida de silenciar CS4014.
- [Cómo ejecutar trabajo fire-and-forget de forma segura en ASP.NET Core con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) para la forma correcta de iniciar trabajo que debe sobrevivir a una solicitud.
- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/es/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) para elegir cómo ejecutar muchas operaciones asíncronas de forma concurrente.
- [Cómo propagar un CancellationToken a través de métodos async en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) para hacer que el trabajo en segundo plano sea cancelable en lugar de quedar huérfano.

## Fuentes

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs4014) (texto exacto de `CS4014` y la guía de esperar con await o descartar de forma explícita con `_ =`).
- Microsoft Learn, [Asynchronous programming with async and await](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/) (cómo se ejecuta un método async que devuelve Task y dónde se capturan las excepciones).
- Microsoft Learn, [Task.WhenAll method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (completarse cuando todas las tareas esperadas terminan y relanzar los fallos agregados).
- Microsoft Learn, [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012) (el analizador que atrapa los awaitables no observados que la advertencia del compilador deja pasar).
