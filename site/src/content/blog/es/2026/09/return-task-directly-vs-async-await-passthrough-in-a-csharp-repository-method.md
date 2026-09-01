---
title: "Devolver un Task directamente vs pasarlo con async/await en un método de repositorio de C#: ¿cuál deberías usar?"
description: "Omitir async/await en un método de paso de repositorio ahorra unos 6 ns y 72 bytes, y te cuesta un marco de pila, la semántica de try/catch y la liberación segura de recursos. Mantén return await salvo que el método sea un paso puro en una ruta caliente medida."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "performance"
lang: "es"
translationOf: "2026/09/return-task-directly-vs-async-await-passthrough-in-a-csharp-repository-method"
translatedBy: "claude"
translationDate: 2026-09-01
---

Tienes un método de repositorio que no hace nada más que reenviar a EF Core, Dapper o un `HttpClient`. Puedes escribirlo como `public Task<Order> GetAsync(int id) => _db.Orders.FindAsync(id).AsTask();` y saltarte la máquina de estados, o como `public async Task<Order> GetAsync(int id) => await _db.Orders.FindAsync(id);` y conservarla. **Conserva el `await`.** Omitirlo compra aproximadamente 6 nanosegundos y 72 bytes por llamada en .NET 10, algo invisible junto a cualquier viaje de ida y vuelta a la base de datos, y te cuesta un marco en cada traza de pila más tres comportamientos que cambian en silencio si el método alguna vez incorpora un `using`, un `try` o un `lock`. Omítelo solo cuando el método sea un verdadero paso de una sola línea en una ruta que hayas perfilado. Todas las mediciones de abajo son sobre .NET 10.0.10 con C# 14; la historia de .NET 11 (Preview 7, versión final el 2026-11-10) está al final y debilita el argumento a favor de omitirlo, no lo refuerza.

## Las dos formas de un vistazo

| Comportamiento                                       | `return await inner()` (async) | `return inner()` (omitido) |
| ---------------------------------------------------- | ------------------------------ | -------------------------- |
| Se genera máquina de estados                         | sí                             | no                         |
| Aparece en la traza de pila de la excepción          | sí                             | **no**                     |
| Costo, la llamada interna completa sincrónicamente   | 8.5 ns / 144 B                 | 2.6 ns / 72 B              |
| Costo, la llamada interna realmente se suspende      | 1111 ns / 286 B                | 1010 ns / 191 B            |
| Seguro dentro de `using` / `await using`             | sí                             | **no**                     |
| El `try`/`catch` alrededor de la llamada funciona    | sí                             | **no**                     |
| Las excepciones de validación de argumentos aparecen | en el `await`                  | en el sitio de la llamada  |
| El tipo de retorno puede diferir del interno         | sí (covarianza, `ValueTask`)   | no (CS0029)                |
| Puedes aplicar `ConfigureAwait(false)`               | sí                             | n/a (hereda el interno)    |
| Dispara CS1998 si quitas el último await             | sí                             | n/a                        |

Dos filas de esa tabla son hechos de tiempo de compilación y el resto es comportamiento en tiempo de ejecución que solo descubrirás en producción. Esa asimetría es todo el argumento a favor del valor por defecto.

## Qué emite realmente el compilador

`async` no es una convención de llamada, es una reescritura. Cuando marcas un método como `async`, Roslyn lo convierte en un struct que implementa `IAsyncStateMachine`, eleva cada variable local a un campo de ese struct y reemplaza el cuerpo por un switch dentro de `MoveNext()`. El método en sí se convierte en un stub que crea un `AsyncTaskMethodBuilder<T>`, arranca la máquina y devuelve `builder.Task`. Ese `Task<T>` devuelto es una tarea **nueva**, distinta de la que produjo la llamada interna, y el builder es responsable de completarla cuando la tarea interna termine.

Omite el `async` y nada de eso ocurre. El método compila a una simple llamada más un return, y quien llama recibe la *misma* instancia de `Task<T>` que creó el método interno. No hay builder, ni máquina de estados en el heap, ni registro de continuación, ni una segunda tarea.

```csharp
// .NET 10, C# 14
public sealed class OrderRepository(AppDbContext db)
{
    // elided: the caller gets the exact Task instance EF Core created
    public Task<List<Order>> GetOpenAsync(CancellationToken ct) =>
        db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);

    // await passthrough: EF Core's task is awaited, and a second task is handed out
    public async Task<List<Order>> GetOpenAwaitedAsync(CancellationToken ct) =>
        await db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);
}
```

Ambos compilan. Ambos son correctos *para este cuerpo exacto*. Las diferencias empiezan en el momento en que el cuerpo deja de ser exactamente este.

## Cuánto cuesta realmente el await extra

Medí las dos formas con BenchmarkDotNet 0.15.8 en un Apple M4 (10 núcleos), macOS 26.6.2, .NET SDK 10.0.302, runtime anfitrión .NET 10.0.10, Arm64 RyuJIT, con `MemoryDiagnoser` activado y GC de estación de trabajo. Dos escenarios: un método interno que completa sincrónicamente (`Task.FromResult`, el caso de acierto en la caché de primer nivel de EF Core) y otro que realmente se suspende (`await Task.Yield()`, el caso de E/S real).

| Método              | Media      | Ratio | Asignado  | Ratio asig. |
| ------------------- | ---------- | ----- | --------- | ----------- |
| `Elided_Completed`  | 2.63 ns    | 1.00  | 72 B      | 1.00        |
| `Awaited_Completed` | 8.47 ns    | 3.22  | 144 B     | 2.00        |
| `Elided_Suspends`   | 1009.95 ns | 383.5 | 191 B     | 2.65        |
| `Awaited_Suspends`  | 1110.81 ns | 421.8 | 286 B     | 3.97        |

Lee los ratios y omitir parece una victoria de 3x. Lee los números absolutos y son 5.8 nanosegundos y 72 bytes en la ruta síncrona, 101 nanosegundos y 95 bytes en la ruta que se suspende. Los 72 bytes de la ruta rápida son la segunda `Task<int>` que asigna el builder; los 95 bytes de la ruta lenta son la máquina de estados en el heap más esa tarea.

Ahora pon eso junto a lo que hace de verdad un método de repositorio. Un viaje de ida y vuelta a un PostgreSQL local son de 200 a 500 microsegundos. Uno entre zonas de disponibilidad son unos pocos milisegundos. 101 nanosegundos está entre el 0.002% y el 0.05% de una sola consulta. Necesitarías del orden de diez mil pasos omitidos para recuperar el tiempo de una consulta. El caso de finalización síncrona es el único donde el ratio no queda completamente absorbido, y ese caso importa exactamente donde cabría esperar: un bucle apretado sobre un valor ya cacheado, una ruta rápida de `ValueTask`, un bucle caliente de serialización. No `GetOrderByIdAsync`.

## Dónde omitirlo cambia el comportamiento en silencio

### El marco de pila desaparece

Este es el costo que pagas a diario y solo notas a las 3 de la madrugada. Un método que devuelve una tarea sin esperarla termina en el instante en que retorna; para cuando se lanza la excepción, su marco desapareció hace mucho. Las trazas de pila en código asíncrono son un registro de continuaciones pendientes, no de quién llamó a quién.

```csharp
// .NET 10, C# 14
static Task ElidedPassthroughAsync() => ThrowAsync();
static async Task AwaitedPassthroughAsync() => await ThrowAsync();

static async Task ThrowAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}
```

Capturar arriba e imprimir `ex.StackTrace` da dos fotos distintas:

```text
=== ELIDED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<Main>$(String[] args) in Program.cs:line 4

=== AWAITED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<<Main>$>g__AwaitedPassthroughAsync|0_1() in Program.cs:line 11
   at Program.<Main>$(String[] args) in Program.cs:line 7
```

`ElidedPassthroughAsync` no aparece en la traza en absoluto. En un ejemplo de dos métodos eso es una curiosidad. En un servicio real donde el equivalente de `ThrowAsync` (una `SqlException` saliendo de `ToListAsync`) se alcanza desde once métodos de repositorio distintos, los marcos omitidos son justamente los que te habrían dicho qué funcionalidad se rompió. Si ya leíste sobre cómo [Runtime Async en .NET 11 limpia las trazas de pila asíncronas](/es/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), ten en cuenta que hace mucho más legibles los marcos que *sí* tienes, pero no puede resucitar un marco que nunca registró una continuación.

### `using` libera antes de que el trabajo termine

Esto es el error, no un compromiso. `using var` compila a un `try`/`finally` alrededor del resto del ámbito, y el `finally` se ejecuta cuando el método retorna. Un método que omite el await retorna en cuanto la llamada interna devuelve una tarea incompleta.

```csharp
// .NET 10, C# 14 -- broken: the resource is disposed while the task is still running
static Task<int> BadAsync()
{
    using var res = new Resource();
    return res.UseAsync();
}

// correct: the finally runs after the awaited work completes
static async Task<int> GoodAsync()
{
    using var res = new Resource();
    return await res.UseAsync();
}
```

`BadAsync` lanza `ObjectDisposedException: Cannot access a disposed object. Object name: 'Resource'` cada vez; `GoodAsync` completa. Lo mismo aplica a `await using` sobre un `IAsyncDisposable`, a un `SemaphoreSlim` liberado en un `finally` y a cualquier ámbito de transacción. Si tu repositorio abre una conexión, inicia una transacción o alquila de un pool, omitir no es una optimización, es un uso después de liberar. Las reglas de orden de liberación se detallan en [implementar y consumir IAsyncDisposable con await using](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

### `try`/`catch` deja de capturar

Mismo mecanismo, síntoma distinto. Un bloque `catch` solo captura excepciones lanzadas mientras el marco está en la pila. Una excepción lanzada después de que el método interno se suspende se entrega en la tarea devuelta, mucho después de que tu bloque `try` haya salido.

```csharp
// .NET 10, C# 14
static Task<string> ElidedTryAsync()
{
    try { return ThrowAsync(); }                              // catch never runs
    catch (InvalidOperationException) { return Task.FromResult("caught"); }
}

static async Task<string> AwaitedTryAsync()
{
    try { return await ThrowAsync(); }                        // catch runs
    catch (InvalidOperationException) { return "caught"; }
}
```

La versión omitida deja escapar `InvalidOperationException` hacia quien llama; la versión con await devuelve `"caught"`. Esta es la variante del error que sobrevive a la revisión de código, porque el `try`/`catch` está *ahí mismo* y parece estar haciendo algo.

### Las excepciones de validación se mueven al sitio de la llamada

Un método `async` nunca lanza sincrónicamente. Toda excepción, incluida una de la primera línea, se captura y se coloca en la tarea devuelta. Un método que omite el await no tiene builder donde capturarla, así que una cláusula de guarda lanza de inmediato, en la expresión de llamada, antes de que quien llama tenga una tarea que esperar.

```csharp
// .NET 10, C# 14
static Task<int> ElidedValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws at the call site
    return Task.FromResult(id.Length);
}

static async Task<int> AsyncValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws when the task is awaited
    await Task.Yield();
    return id.Length;
}
```

Quienes hacen `var t = repo.GetAsync(null); /* ... */ await t;`, o pasan el método a `Task.WhenAll` dentro de un `Select`, se comportan distinto entre las dos formas. Con la forma omitida, `Select(x => repo.GetAsync(x)).ToList()` puede lanzar *durante la materialización*, antes de llegar siquiera a `WhenAll`, y ninguna de las tareas ya iniciadas queda observada. Ninguno de los dos comportamientos es incorrecto en aislamiento, pero alternar entre ellos añadiendo o quitando un `await` no es una refactorización que los lectores esperen.

## Los casos donde omitirlo ni siquiera compila

`Task<T>` es una clase, así que es invariante. `Task<Dog>` no es un `Task<Animal>`, y el compilador te lo dirá:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.Task<Dog>'
              to 'System.Threading.Tasks.Task<Animal>'
```

El mismo muro aparece cuando el método interno devuelve `ValueTask<int>` y tu contrato es `Task<int>`, algo habitual en cuanto tocas `FindAsync` o cualquier puente con `IAsyncEnumerable`:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.ValueTask<int>'
              to 'System.Threading.Tasks.Task<int>'
```

`await` hace la conversión gratis. Sin él necesitas `.AsTask()` (una asignación, que borra el ahorro) o una conversión explícita que no existe. Dado que una interfaz de repositorio casi siempre expone la abstracción (`Task<IReadOnlyList<Order>>`) en lugar del tipo de retorno concreto del proveedor (`Task<List<Order>>`), esto no es un caso límite, es la mayor parte de la interfaz. Y si estabas pensando en empujar `ValueTask` hacia arriba entre capas, lee antes [cuándo vale la pena ValueTask](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/): las restricciones cuestan más que la asignación.

Omitirlo también elimina la costura donde pondrías `ConfigureAwait(false)`. En una biblioteca que aún apunta a un anfitrión con `SynchronizationContext`, un paso omitido hereda lo que sea que haya configurado el método interno, que puede ser nada. Es un lugar menos que anotar, pero también un lugar menos que arreglar. Si esa costura sigue valiendo la pena en 2026 se trata en [ConfigureAwait(false) frente al valor por defecto en .NET 11](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Qué le hace al balance el runtime async de .NET 11

Runtime async, que ya no necesita `<EnablePreviewFeatures>` en proyectos `net11.0`, saca la suspensión de las máquinas de estados generadas por el compilador y la lleva al CLR. Preview 7 añadió dos cosas que golpean directamente esta comparación. Los métodos asíncronos ahora pasan por la compilación por niveles en lugar de ejecutar permanentemente el código de tier0, y el JIT ganó una **optimización de tail-await**: cuando el último acto de un método asíncrono es esperar una llamada cuya tarea devuelta coincide con el tipo de retorno del propio método, el runtime puede emitir una llamada de cola implícita, "reduciendo significativamente el tamaño del código y el número de instrucciones". Esa optimización describe exactamente `async Task<T> M() => await Inner();`. Es la omisión, aplicada por el runtime, sin que tu código fuente renuncie a la semántica del marco.

Las mismas notas de versión reportan que el trabajo de tail-await en tier0 bajó la tasa máxima de asignación durante el calentamiento de TechEmpower `platform-json` de 110 580 952 B/s a 8 030 616 B/s. La dirección es inequívoca: el runtime está cerrando la brecha que estarías optimizando a mano. Escribir `return inner()` hoy para ahorrar 72 bytes es descartar una optimización del compilador que llega en noviembre, mientras conservas de forma permanente todos los riesgos de comportamiento.

## Los analizadores que te empujarán en la dirección equivocada

Dos analizadores populares marcan `return await` como redundante. **RCS1174 "Remove redundant async/await"** de Roslynator es el primero que encontrarás, y existe una solicitud de larga data para desactivarlo por defecto precisamente porque Stephen Cleary y el equipo de .NET consideran que la transformación no es segura como regla general. **AsyncFixer01 "Unnecessary async/await usage"** hace la misma sugerencia. Ninguno de los dos puede ver si tu método incorporará un `using` el próximo sprint, y ninguno sabe que dependes de ese marco en las trazas de producción.

Lo práctico es dejar ambos desactivados, o ponerlos en `suggestion` y nunca aplicar la corrección automática en toda la solución. Un "aplicar RCS1174 a todos los documentos" masivo es una de las pocas refactorizaciones que puede introducir `ObjectDisposedException` en una base de código que funcionaba. Nota que esta es la dirección opuesta a CS1998: esa advertencia se dispara cuando un método `async` *no tiene* ningún `await`, y ahí la corrección correcta sí es quitar el modificador, como se describe en [cómo arreglar CS1998 sin romper el método](/es/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/).

## La regla que uso en el código de repositorio

- **Por defecto, `return await`.** Los 6 nanosegundos no son reales; el marco de pila ausente y el riesgo de liberación sí.
- **Omítelo solo cuando se cumplan las cuatro condiciones**: el cuerpo del método es exactamente una sentencia `return`, no hay `using`, `try`, `lock` ni `finally` en ninguna parte, el tipo de retorno es idéntico al de la llamada interna, y tienes un perfilado que muestra ese paso en una ruta caliente. Tres se comprueban leyendo; la cuarta es la que se salta la gente.
- **Nunca apliques RCS1174 ni AsyncFixer01 en masa.** Suprímelos a nivel de proyecto en lugar de corregir método por método.
- **En .NET 11, deja de omitirlo del todo.** La optimización de tail-await te da la generación de código gratis, y la forma omitida renuncia a marcos que el runtime habría conservado.

La parte incómoda de esta comparación es que la forma omitida no es más lenta, ni más fea, ni incorrecta. Es genuinamente más rápida, en una cantidad que ningún repositorio notará jamás, a cambio de un método cuya semántica cambia si alguien lo edita. Ese es un mal trato a cualquier tipo de cambio, y .NET 11 está a punto de dejar el numerador en cero.

## Relacionado

- [Runtime Async de .NET 11 reemplaza las máquinas de estados y limpia las trazas de pila](/es/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)
- [Cómo arreglar CS1998 "This async method lacks 'await' operators and will run synchronously"](/es/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)
- [ConfigureAwait(false) frente al valor por defecto en .NET 11: ¿sigue importando?](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [¿Qué es ValueTask y cuándo vale la pena?](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [Cómo implementar y consumir IAsyncDisposable con await using en C#](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await en C#](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

## Fuentes

- [Eliding Async and Await](https://blog.stephencleary.com/2016/12/eliding-async-await.html) -- Stephen Cleary
- [Notas de versión del runtime de .NET 11 Preview 7: runtime-async tiering and tail-await optimizations](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/runtime.md) -- dotnet/core
- [.NET 11 Preview 7 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) -- .NET Blog
- [RCS1174: Remove redundant async/await](https://josefpihrt.github.io/docs/roslynator/analyzers/RCS1174/) -- Roslynator
- [Disable by default RCS1174 (issue #429)](https://github.com/JosefPihrt/Roslynator/issues/429) -- dotnet/roslynator
- [AsyncFixer: async/await analyzers and code fixes](https://github.com/semihokur/AsyncFixer) -- semihokur
- [Referencia de mensajes del compilador sobre async y await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) -- Microsoft Learn
