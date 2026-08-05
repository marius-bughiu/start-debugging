---
title: "Solución: CS1998 \"This async method lacks 'await' operators and will run synchronously\" en C#"
description: "CS1998 significa que un método async no tiene await, así que se ejecuta de forma síncrona. Quita el modificador async y devuelve Task.FromResult, o agrega el await que olvidaste."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "async"
lang: "es"
translationOf: "2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously"
translatedBy: "claude"
translationDate: 2026-08-05
---

`CS1998` aparece cuando un método lleva el modificador `async` pero su cuerpo no contiene ninguna expresión `await`, de modo que el método entero se ejecuta de forma síncrona y pagas por la maquinaria asíncrona sin recibir asincronía a cambio. La solución casi siempre consiste en quitar `async` y devolver una tarea ya completada: `Task.CompletedTask`, `Task.FromResult(value)` o `ValueTask.FromResult(value)`. Si el método debía esperar algo, agrega el `await` que falta. No lo silencies con `await Task.CompletedTask`, porque eso conserva todos los costos de los que se queja la advertencia. Hay algo que cambió y que la mayoría de los resultados de búsqueda todavía no reflejan: a partir del SDK de .NET 10, el compilador de C# ya no emite `CS1998` en absoluto. Todo lo que sigue está verificado contra el SDK 10.0.201 (Roslyn 5.3.0) y .NET 10.0.5.

## La advertencia en contexto

```
warning CS1998: This async method lacks 'await' operators and will run synchronously. Consider using the 'await' operator to await non-blocking API calls, or 'await Task.Run(...)' to do CPU-bound work on a background thread.
```

Es una advertencia, no un error, así que la compilación tiene éxito salvo que tengas `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` en el `.csproj`. Microsoft la documenta como `WRN_AsyncLacksAwaits` en la [referencia de mensajes del compilador sobre async y await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors), donde la guía oficial es "agregue al menos una expresión `await` al cuerpo del método, o quite el modificador `async` y devuelva la tarea directamente".

## Por qué el compilador la señala

Un método `async` sin `await` nunca se suspende. El cuerpo se ejecuta de principio a fin en el hilo que llama, exactamente igual que un método síncrono, y luego la máquina de estados generada por el compilador entrega al llamador una tarea que ya está en estado `RanToCompletion`. Nada se movió a un hilo en segundo plano, nada se solapó con nada. La palabra clave `async` no hizo asíncrono al método; solo cambió la forma en que se empaquetan su resultado y sus excepciones.

Ese empaquetado no es gratis. Esto es lo que cuesta, medido en .NET 10.0.5, x64, Release, con un simple bucle de `Stopwatch` sobre dos millones de llamadas y `GC.GetAllocatedBytesForCurrentThread` para las asignaciones. No son números de BenchmarkDotNet, así que tómalos como órdenes de magnitud y no como cifras exactas:

| Forma | Bytes por llamada | ns por llamada |
| --- | --- | --- |
| `async Task` sin `await` | 0 | 12.1 |
| `Task.CompletedTask` | 0 | 2.3 |
| `async Task<string>` sin `await` | 72 | 27.9 |
| `Task.FromResult("ok")` | 72 | 16.0 |
| `async ValueTask<int>` sin `await` | 0 | 15.6 |
| `ValueTask.FromResult(42)` | 0 | 3.0 |

Dos cosas destacan. La columna de asignaciones es idéntica en cada par, porque un método asíncrono que se completa de forma síncrona nunca hace boxing de su máquina de estados (la struct se queda en la pila cuando no hay suspensión) y el `AsyncTaskMethodBuilder` no genérico devuelve una tarea completada que está en caché. Así que el folclore de "async asigna memoria" no aplica aquí. Lo que realmente pagas son unos 10 a 15 nanosegundos de fontanería del builder por llamada. Eso es insignificante en un método que consulta una base de datos y relevante en un bucle caliente, que es justo la razón por la que esto era una advertencia y no un error.

## Reproducción mínima

El código más pequeño que produce la advertencia en cualquier SDK hasta .NET 9 incluido:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
public class UserService
{
    private readonly Dictionary<int, User> _cache = new();

    public async Task<User> GetUserAsync(int id)   // CS1998
    {
        return _cache[id];
    }
}
```

La forma más común en el mundo real es la que empezó siendo correcta y se degradó:

```csharp
// C# 14
public async Task<Report> BuildReportAsync(int id)
{
    // var rows = await _db.QueryAsync(id);   <- deleted during a refactor
    var rows = _cachedRows[id];
    return new Report(rows);                  // CS1998, and the method is now
}                                             // async for no reason at all
```

Nadie escribe la primera versión a propósito. La segunda aparece constantemente, y ese es todo el argumento a favor de la advertencia: es un detector de degradación, no una regla de estilo.

## Solución 1: quita async y devuelve una tarea completada

Esta es la solución correcta en la inmensa mayoría de los casos. Quita el modificador, conserva la firma que devuelve `Task` y envuelve el valor:

```csharp
// C# 14, .NET 10
public Task<User> GetUserAsync(int id)
{
    return Task.FromResult(_cache[id]);
}

public Task SaveAsync(User user)
{
    _cache[user.Id] = user;
    return Task.CompletedTask;          // the Task equivalent of FromResult
}

public ValueTask<int> CountAsync()
{
    return ValueTask.FromResult(_cache.Count);   // no Task allocation at all
}
```

La firma no cambia, así que no hay que tocar ningún llamador, y la máquina de estados desaparece. Si el método está en una ruta caliente y su resultado suele estar disponible de forma síncrona, `ValueTask<T>` elimina también la asignación de 72 bytes de `Task<T>`; las compensaciones se explican en [qué es ValueTask y cuándo vale la pena](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

Hay un cambio de comportamiento que debes tener en cuenta, y es la razón por la que esta solución no es puramente mecánica. En un método `async`, una excepción lanzada por el cuerpo se captura y se coloca en la tarea devuelta. Quita `async` y la excepción se lanza de forma síncrona, en el punto de la llamada, antes de que el llamador reciba siquiera una tarea que esperar. Es fácil de demostrar:

```csharp
// C# 14, .NET 10.0.5
static async Task ThrowsFromTaskAsync() => throw new InvalidOperationException("boom");
static Task ThrowsAtCallSiteAsync() => throw new InvalidOperationException("boom");

var t1 = ThrowsFromTaskAsync();   // returns a faulted task, no exception here
await t1;                          // InvalidOperationException surfaces here

var t2 = ThrowsAtCallSiteAsync();  // throws right here, before any await
```

Para la mayoría del código esa diferencia es invisible, porque el llamador espera la tarea de inmediato. Se vuelve visible cuando la llamada no se espera de inmediato: al juntar tareas en una lista y pasarlas a `Task.WhenAll`, al guardar una tarea en un campo, o al envolver la llamada en un `try`/`catch` que solo protege el `await`. Si tu método puede lanzar una excepción antes de producir un valor, mantén la excepción dentro de la tarea:

```csharp
// C# 14, .NET 10
public Task<Stream> OpenAsync(string path)
{
    try
    {
        return Task.FromResult<Stream>(new FileStream(path, FileMode.Open));
    }
    catch (Exception ex)
    {
        return Task.FromException<Stream>(ex);   // same shape as async would produce
    }
}
```

Este escenario exacto es el que planteó Stephen Toub en [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) al argumentar que una reescritura ingenua con `Task.FromResult` suele ser incorrecta.

## Solución 2: agrega el await que querías escribir

Si la advertencia apareció después de una refactorización, la solución honesta suele ser restaurar la llamada que debía esperarse:

```csharp
// C# 14, .NET 10
public async Task<Report> BuildReportAsync(int id, CancellationToken ct)
{
    var rows = await _db.QueryAsync(id, ct);
    return new Report(rows);
}
```

Busca un [CS4014 "because this call is not awaited"](/es/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) hermano en el mismo archivo. Las dos advertencias juntas, una diciendo que no tienes ningún await y otra diciendo que descartaste una tarea, son una señal casi segura de que se perdió un `await` y no de que el método nunca fue asíncrono.

## Solución 3: Task.Run, y por qué la propia sugerencia del mensaje suele estar mal

El texto de la advertencia sugiere `await Task.Run(...)` para trabajo intensivo de CPU. Ese consejo es correcto para un cliente de escritorio, donde el objetivo es sacar el trabajo del hilo de la interfaz:

```csharp
// C# 14, .NET 10, WPF or MAUI
private async void OnCalculateClicked(object sender, EventArgs e)
{
    var result = await Task.Run(() => CrunchNumbers(_input));   // UI stays responsive
    ResultLabel.Text = result.ToString();
}
```

Es un mal consejo dentro de ASP.NET Core. Ahí no hay hilo de interfaz que liberar, y la solicitud ya se ejecuta en un hilo del grupo de subprocesos; `Task.Run` solo pasa el trabajo a otro hilo del mismo grupo y agrega un cambio de contexto más una asignación de tarea, mientras reduce el grupo disponible para atender otras solicitudes. En una aplicación de servidor, un método síncrono debe seguir siendo síncrono, o volverse genuinamente asíncrono esperando E/S real.

## Solución 4: implementaciones de interfaz y sobrescrituras que no puedes cambiar

El caso que la advertencia manejaba peor es un miembro de interfaz o un método virtual que debe devolver `Task` aunque tu implementación concreta no tenga nada que esperar:

```csharp
// C# 14, .NET 10
public interface INotifier
{
    Task NotifyAsync(string message);
}

public sealed class NullNotifier : INotifier
{
    public Task NotifyAsync(string message) => Task.CompletedTask;   // no async, no warning
}
```

Quitar `async` sigue siendo la respuesta. Cuando eso es realmente imposible, suprime de forma acotada en lugar de global:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
#pragma warning disable CS1998 // required by INotifier, nothing to await here
public async Task NotifyAsync(string message) { _log.Info(message); }
#pragma warning restore CS1998
```

Prefiere `#pragma` con un comentario que explique el motivo antes que `<NoWarn>$(NoWarn);CS1998</NoWarn>` en el archivo de proyecto. La supresión a nivel de proyecto oculta todas las apariciones futuras, incluido el caso de degradación por refactorización que la advertencia detecta muy bien.

## Adónde fue la advertencia en .NET 10

Si estás leyendo esto porque la advertencia dejó de aparecer, y no porque apareció, esta es la respuesta: la eliminaron del compilador. [dotnet/roslyn#80144](https://github.com/dotnet/roslyn/pull/80144), integrado el 2025-09-19 para el hito 18.0 P2, quitó `WRN_AsyncLacksAwaits` por completo, junto con los proveedores de corrección de código de C# "Remove async modifier" y "Make method synchronous". El razonamiento, tomado de [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001), es que la advertencia empujaba a la gente hacia peor código: obligados a satisfacer un contrato que devuelve `Task`, muchos escribían `await Task.FromResult(result)` para silenciarla, lo que conserva la máquina de estados, agrega un await y hace el método estrictamente más caro sin hacerlo más seguro. La decisión de cierre en ese hilo fue tajante: el equipo dijo que, después de discutirlo y especialmente con runtime async, eliminarían esta advertencia por completo.

Puedes verificar la eliminación con una sola compilación. Este proyecto compila sin advertencias en el SDK 10.0.201:

```csharp
// C# 14, .NET SDK 10.0.201 -> 0 warnings
public class C
{
    public async Task Empty() { }
    public async Task<int> Value() { return 42; }
    public async void VoidMethod() { }
    public async IAsyncEnumerable<int> Stream() { yield return 1; }
}
```

Ninguno de esos produce un diagnóstico, y ni `-warnaserror:CS1998` ni `dotnet_diagnostic.CS1998.severity = error` en `.editorconfig` lo devuelven, porque ya no queda diagnóstico que elevar. `CS4014` sigue apareciendo desde el mismo compilador, así que esto es específico de `CS1998` y no una pérdida general de advertencias sobre async.

La capacidad volvió como analizadores del IDE de suscripción voluntaria en [dotnet/roslyn#81835](https://github.com/dotnet/roslyn/pull/81835), integrado el 2026-01-07 para el hito 18.4, divididos deliberadamente en dos identificadores de diagnóstico para poder ajustar por separado el caso de las implementaciones de interfaz:

- `IDE0390` (`RemoveUnnecessaryAsyncModifier`): métodos normales y expresiones lambda.
- `IDE0391` (`RemoveUnnecessaryAsyncModifierInterfaceImplementationOrOverride`): métodos que implementan un miembro de interfaz o sobrescriben un método base.

Ambos aparecen como "Make method synchronous" con el mensaje "Method can be made synchronous", y ninguno está habilitado de forma predeterminada. Para recuperar el comportamiento anterior donde lo quieras:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0390.severity = warning
dotnet_diagnostic.IDE0391.severity = suggestion
```

```xml
<!-- .csproj: required to see IDE rules in dotnet build, not just in the IDE -->
<PropertyGroup>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

Una advertencia a partir de probarlo: en el SDK 10.0.201 los dos analizadores todavía no están presentes. La configuración anterior no produce nada, mientras que una regla de control como `IDE0161` configurada igual sí informa con normalidad, así que la fontanería funciona y las reglas simplemente no se han distribuido en esa banda del SDK. Apuntan al hito 18.4, así que hace falta un SDK más nuevo o una actualización de Visual Studio 2026.

## Trampas y variantes

- **La CI falla, la compilación local pasa.** Un `global.json` que fija el SDK 9 en el agente de compilación sigue emitiendo `CS1998`, y con `TreatWarningsAsErrors` eso es una compilación en rojo para código que compila limpio en una máquina de desarrollo con el SDK 10. Alinea la banda del SDK antes de buscar algo más exótico.

- **ReSharper y Rider la siguen reportando.** El análisis de JetBrains es independiente del de Roslyn, así que la inspección puede persistir en el editor después de que el compilador dejó de emitirla. Desactívala en la configuración de inspecciones de ReSharper en lugar de esperar que un interruptor del compilador la afecte.

- **`await Task.CompletedTask` es el peor silenciador posible.** Elimina la advertencia agregando un `await` real, lo que significa que conservas la máquina de estados, conservas el costo del builder y agregas encima un viaje de ida y vuelta del awaiter. Es estrictamente más caro que el código que disparó la advertencia. Lo mismo vale para `await Task.FromResult(value)`.

- **`async void` sin awaits.** Quitar `async` de `async void SomeHandler()` es ganancia pura: si no hay nada que esperar, nada se beneficia de la máquina de estados, y te libras del [comportamiento de excepciones de async void](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), donde un fallo se relanza en el contexto de sincronización y puede derribar el proceso.

- **Nunca significó "este método bloquea".** `CS1998` dice que no hay `await`, no que el cuerpo bloquee. Un método que llama a `.Result` o `.Wait()` dentro de un cuerpo `async` silencia la advertencia solo si existe algún otro `await`, y es un problema mucho peor: consulta [el interbloqueo que provoca llamar a .Result o .Wait()](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **Iteradores asíncronos.** Un método `async IAsyncEnumerable<T>` con `yield return` y sin `await` sigue siendo un flujo asíncrono legítimo, y la eliminación de la advertencia por parte del compilador es un alivio ahí. Si consumes uno, ten en cuenta que un `await foreach` sobre un flujo que nunca espera de verdad no te da concurrencia, solo una interfaz.

El modelo mental que sobrevive a la eliminación de la advertencia: `async` es una estrategia de compilación, no un contrato de API. El contrato es la firma que devuelve `Task`. Cuando no hay nada que esperar, conserva el contrato y descarta la estrategia, cuidando de que todo lo que pueda lanzar excepciones siga fallando la tarea en lugar de lanzarlas en el punto de la llamada. Esa era la respuesta correcta cuando `CS1998` te gritaba, y sigue siendo la respuesta correcta ahora que se ha quedado callada.

## Relacionado

- [Solución: CS4014 "Because this call is not awaited, execution of the current method continues" en C#](/es/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) para la advertencia que suele aparecer junto a un `await` que falta.
- [async void vs async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) para saber por qué conviene arreglar primero un método `async void` sin awaits.
- [Qué es ValueTask y cuándo vale la pena](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/) para el caso de finalización síncrona donde `ValueTask.FromResult` gana a `Task.FromResult`.
- [Solución: interbloqueo al llamar a .Result o .Wait() en un método async en C#](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) para la variante realmente peligrosa de "este método async no es asíncrono de verdad".
- [.NET 11 runtime async deja atrás el flag EnablePreviewFeatures](/es/2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures/) para el cambio a nivel de runtime que dejó tranquilo al equipo del compilador para descartar esta advertencia.

## Fuentes

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) (texto exacto de `CS1998` y la guía oficial de agregar await o quitar async).
- dotnet/roslyn, [PR #80144: Remove CS1998 warning entirely and remove dependent C# code fix providers](https://github.com/dotnet/roslyn/pull/80144) (integrado el 2025-09-19, hito 18.0 P2).
- dotnet/roslyn, [Issue #77001: Consider not emitting CS1998 for interface implementations / method overrides](https://github.com/dotnet/roslyn/issues/77001) (el antipatrón `await Task.FromResult` y la decisión de eliminar la advertencia).
- dotnet/roslyn, [PR #81835: Add back async fixers](https://github.com/dotnet/roslyn/pull/81835) (los analizadores opcionales `IDE0390` e `IDE0391`, integrados el 2026-01-07, hito 18.4).
- dotnet/roslyn, [Issue #82692: Warnings (at least CS1998) are not showing with SDK 10 compared to SDK 9](https://github.com/dotnet/roslyn/issues/82692) (confirmación de que el cambio de comportamiento llega con el SDK y no con el target framework).
- Microsoft Learn, [Task.FromException method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.fromexception) (cómo producir una tarea fallida sin un método `async`).
