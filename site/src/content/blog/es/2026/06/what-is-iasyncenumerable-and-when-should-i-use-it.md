---
title: "¿Qué es IAsyncEnumerable<T> y cuándo deberías usarlo?"
description: "IAsyncEnumerable<T> es la interfaz para los flujos asíncronos: una secuencia cuyos elementos llegan a lo largo del tiempo y donde cada uno puede requerir un await. Esto es lo que realmente es, cómo await foreach y yield lo impulsan, y la regla para saber cuándo elegirlo en lugar de Task<List<T>>."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "iasyncenumerable"
lang: "es"
translationOf: "2026/06/what-is-iasyncenumerable-and-when-should-i-use-it"
translatedBy: "claude"
translationDate: 2026-06-19
---

`IAsyncEnumerable<T>` es la interfaz para un flujo asíncrono: una secuencia que recorres un elemento a la vez, donde producir cada elemento puede requerir esperar algo (una lectura de red, una fila de base de datos, un fragmento de archivo). Es el hermano asíncrono de `IEnumerable<T>`. Lo produces con un método iterador que combina `yield return` y `await`, y lo consumes con `await foreach`. Recurre a él cuando tengas muchos elementos que llegan a lo largo del tiempo y no quieras almacenarlos todos en memoria antes de procesar el primero. Si solo produces un único resultado, o si toda la colección ya está en memoria, no lo necesitas. Esta publicación (vigente a partir de .NET 11, C# 14) explica la mecánica, la razón por la que las alternativas obvias fallan, y la regla de decisión.

## El hueco que dejan abierto `Task<T>` e `IEnumerable<T>`

Alinea las cuatro formas y la celda que falta es evidente:

| | valor único | muchos valores |
| --- | --- | --- |
| **síncrono** | `T` | `IEnumerable<T>` |
| **asíncrono** | `Task<T>` | `IAsyncEnumerable<T>` |

`Task<T>` te da un valor, más tarde. `IEnumerable<T>` te da muchos valores, pero el acto de obtener cada uno es síncrono: `MoveNext()` devuelve un `bool`, no algo que puedas esperar. Durante años la celda inferior derecha no tuvo un tipo de primera clase, y la gente la simulaba con dos soluciones deficientes.

La primera es `Task<IEnumerable<T>>` (o `Task<List<T>>`). Esto espera una vez y luego te entrega la colección completa. Funciona, pero anula el propósito del streaming: nada es visible para tu código hasta que todo se ha obtenido. Una consulta que devuelve cinco millones de filas asigna una lista de cinco millones antes de que tu cuerpo de bucle se ejecute una sola vez.

La segunda es `IEnumerable<Task<T>>`. Esto es peor. Es una secuencia síncrona de tareas, lo que significa que el iterador decide el conjunto completo de trabajo por adelantado, y no tienes una forma natural de aplicar contrapresión ni de dejar de producir tareas una vez que un consumidor pierde el interés. Tampoco puedes hacer `await` dentro del `MoveNext` que produce la siguiente tarea, así que cualquier latencia por elemento bloquea el hilo.

`IAsyncEnumerable<T>`, añadido en C# 8 y .NET Core 3.0, llena la celda correctamente. Cada paso de la iteración es en sí mismo esperable, así que el productor puede esperar entre elementos y el consumidor obtiene el siguiente elemento solo cuando está listo para él.

## Cómo es realmente la interfaz

Aquí no hay magia. El contrato es pequeño:

```csharp
// System.Collections.Generic
public interface IAsyncEnumerable<out T>
{
    IAsyncEnumerator<T> GetAsyncEnumerator(
        CancellationToken cancellationToken = default);
}

public interface IAsyncEnumerator<out T> : IAsyncDisposable
{
    T Current { get; }
    ValueTask<bool> MoveNextAsync();
    ValueTask DisposeAsync();
}
```

Dos detalles cargan con todo el diseño.

`MoveNextAsync` devuelve `ValueTask<bool>` en lugar de `Task<bool>`. Esa elección es deliberada. Llamas a `MoveNextAsync` una vez por elemento, así que un flujo de 100.000 elementos significa 100.000 llamadas. Si cada una asignara un objeto `Task` en el heap, los flujos asíncronos serían un desastre de asignaciones. `ValueTask<bool>` no asigna nada cuando el resultado ya está disponible de forma síncrona (una fila almacenada en búfer, por ejemplo), que es el caso común en un productor rápido. Solo pagas el coste del heap cuando un elemento realmente tiene que esperar.

`IAsyncEnumerator<T>` implementa `IAsyncDisposable`, no `IDisposable`. La limpieza es asíncrona porque cerrar el recurso subyacente (un socket, un `DbDataReader`) puede requerir por sí mismo E/S. Por eso el bucle consumidor necesita `await foreach` y no un `foreach` simple: la liberación al final de la iteración tiene que esperarse.

Casi nunca llamas a estos miembros a mano. El compilador lo hace por ti en ambos extremos.

## Producir un flujo: `yield return` se encuentra con `await`

Un método iterador asíncrono es uno que devuelve `IAsyncEnumerable<T>` y contiene tanto `await` como `yield return`. El compilador lo reescribe en una máquina de estados que sabe cómo suspenderse en cada `await` y reanudarse en el siguiente `MoveNextAsync`:

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var reader = new StreamReader(path);
    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Lee lo que eso te da. Cada línea se lee de forma asíncrona y luego se entrega de inmediato. El llamador puede procesar la línea uno mientras la línea dos todavía se está leyendo del disco. La memoria nunca retiene más de una sola línea más el búfer interno del lector, sin importar si el archivo tiene 10 líneas o 10 gigabytes. El `using` sobre el lector se respeta a través del `DisposeAsync` generado, así que el manejador de archivo se cierra cuando termina la iteración, incluso cuando el consumidor sale antes de tiempo o una excepción desenrolla el bucle.

El atributo `[EnumeratorCancellation]` sobre el parámetro del token es la parte que la gente olvida. Le dice al compilador que este parámetro debe recibir el token que un consumidor pasa mediante `WithCancellation`, encaminando la cancelación externa hacia el cuerpo del iterador. Sin él, el parámetro es solo un argumento ordinario que toma por defecto `CancellationToken.None` e ignora lo que sea que el consumidor haya suministrado. Más sobre esto abajo, porque es el error de corrección más común con los flujos asíncronos.

## Consumir un flujo: `await foreach`

El lado del consumidor es una palabra clave más largo que un bucle normal:

```csharp
// .NET 11, C# 14
await foreach (var line in ReadLinesAsync("huge.log", ct))
{
    if (line.Contains("ERROR"))
        await alertSink.WriteAsync(line, ct);
}
```

El compilador expande esto en llamadas a `GetAsyncEnumerator`, un bucle de `await MoveNextAsync()` que lee `Current` en cada vuelta, y un `await DisposeAsync()` en un bloque finally. El bucle es totalmente secuencial: el elemento N+1 no se solicita hasta que tu cuerpo termina con el elemento N. Esa forma secuencial, dirigida por la demanda, es la característica, no una limitación. Es lo que acota la memoria y te da contrapresión natural: un consumidor lento ralentiza automáticamente al productor, porque el siguiente `await` del productor no se reanuda hasta la siguiente llamada a `MoveNextAsync`.

Si el orden de iteración no importa y quieres concurrencia, `await foreach` es la herramienta equivocada. Usa [Parallel.ForEachAsync](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/), que puede consumir un `IAsyncEnumerable<T>` y ejecutar el cuerpo para varios elementos a la vez con un límite de grado de paralelismo. `await foreach` es para procesamiento ordenado, uno a la vez.

## Cancelación: el par `WithCancellation` más `[EnumeratorCancellation]`

Un `await foreach (var x in stream)` pelado no te da ningún sitio para pasar un token, porque la sintaxis del lenguaje no tiene ranura para ello. Las dos piezas que cierran el bucle son `WithCancellation` en el consumidor y `[EnumeratorCancellation]` en el productor:

```csharp
// Producer: token parameter is tagged
public static async IAsyncEnumerable<int> ProduceAsync(
    [EnumeratorCancellation] CancellationToken ct = default)
{
    for (var i = 0; ; i++)
    {
        await Task.Delay(100, ct);
        yield return i;
    }
}

// Consumer: token is forwarded into GetAsyncEnumerator
await foreach (var n in ProduceAsync().WithCancellation(ct))
{
    Console.WriteLine(n);
}
```

`WithCancellation` no envuelve la secuencia en otro iterador ni añade sobrecarga. Solo registra el token de modo que cuando el compilador llama a `GetAsyncEnumerator(token)`, el token fluye dentro, y `[EnumeratorCancellation]` lo encamina al parámetro del productor. Cancela el token y el `await Task.Delay` pendiente lanza `OperationCanceledException`, que se propaga hacia afuera a través de tu `await foreach`.

Omitir el token es como obtienes trabajos en segundo plano colgados y solicitudes atascadas en producción: un flujo sobre una red o una base de datos retiene una conexión durante todo el bucle, y sin un token no hay forma de abortarlo cuando el llamador desaparece. Trata `WithCancellation(ct)` como obligatorio en cualquier flujo respaldado por E/S.

## `ConfigureAwait` también funciona sobre el bucle

`await foreach` espera internamente, así que recoge la captura del contexto de sincronización de la misma forma que lo hace un `await` normal. En código de biblioteca que no debería volver a un contexto capturado, aplica `ConfigureAwait(false)` a todo el bucle con `ConfigureAwait`:

```csharp
await foreach (var item in stream.ConfigureAwait(false))
{
    Process(item);
}
```

Esto configura tanto los `await` de `MoveNextAsync` como el `await` final de `DisposeAsync`. En una aplicación moderna de ASP.NET Core no hay contexto de sincronización que capturar, así que ahí es una operación nula, pero todavía importa para código de biblioteca, hosts de consola y cualquier cosa que pudiera ejecutarse bajo un contexto de interfaz de usuario o heredado. Las concesiones son las mismas que en todas partes del código asíncrono, cubiertas en [si ConfigureAwait todavía importa en .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## LINQ sobre flujos asíncronos ahora viene incluido

Una aspereza de larga data era que `IAsyncEnumerable<T>` no tenía LINQ. Para escribir `stream.Where(...).Select(...)` traías el paquete NuGet comunitario `System.Linq.Async`. A partir de .NET 10 eso cambió: el runtime incluye `System.Linq.AsyncEnumerable` en la BCL, así que los operadores estándar funcionan sobre cualquier `IAsyncEnumerable<T>` sin referencia a paquete, y .NET 11 hereda esto.

```csharp
// .NET 11: Where/Select/Take resolve from the BCL, no NuGet package
var firstTenErrors = ReadLinesAsync("huge.log", ct)
    .Where(l => l.Contains("ERROR"))
    .Take(10);

await foreach (var line in firstTenErrors.WithCancellation(ct))
    Console.WriteLine(line);
```

Si estás migrando un proyecto más antiguo, elimina la referencia explícita a `System.Linq.Async` cuando pases a .NET 10 o posterior; dejarla causa errores de sobrecarga ambigua frente a los métodos ahora integrados. Un cambio de nombres a conocer: los antiguos operadores `SelectAwait`/`WhereAwait` que tomaban lambdas asíncronas desaparecieron, y pasas la delegación asíncrona al `Select`/`Where` regular en su lugar. El código que tiene como objetivo varios runtimes más antiguos debería referenciar el paquete `System.Linq.AsyncEnumerable` en lugar de `System.Linq.Async`.

## Cuándo deberías recurrir a él

Usa `IAsyncEnumerable<T>` cuando se cumplan estas tres condiciones:

1. Hay **muchos** elementos, o un número desconocido o no acotado.
2. Producir cada elemento implica **E/S asíncrona** (base de datos, red, archivo, cola de mensajes).
3. Quieres **empezar a procesar antes de que llegue el último elemento**, o no puedes permitirte retenerlos todos en memoria a la vez.

Casos concretos que encajan: transmitir filas desde una base de datos para una exportación, como se cubre en [usar IAsyncEnumerable con EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/); leer una API paginada página por página y entregar cada elemento a medida que llegan las páginas; seguir un log o un flujo de mensajes que nunca termina; canalizar datos hacia un [Channel](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) o un `PipeWriter`. En ASP.NET Core, devolver `IAsyncEnumerable<T>` desde una minimal API o una acción de controlador transmite el arreglo JSON al cliente elemento por elemento en lugar de almacenar en búfer toda la respuesta.

## Cuándo no deberías

Los flujos asíncronos no son gratis, y no siempre son la forma correcta:

- **Los datos ya están en memoria.** ¿Iterar una `List<T>` o un arreglo? Usa `foreach`. Envolver una colección en memoria en un flujo asíncrono añade sobrecarga de máquina de estados y no compra nada, porque ningún elemento realmente espera.
- **Hay exactamente un resultado.** Un método que devuelve un solo registro debería devolver `Task<T>`. Un flujo de uno es solo ceremonia.
- **El conjunto es pequeño y acotado y necesitas acceso aleatorio, `Count` o varias pasadas.** `Task<List<T>>` (mediante `ToListAsync`) es más simple y te permite indexar, contar y volver a enumerar. El streaming te da una secuencia de avance único, de una sola pasada; si necesitas más que eso, materialízala.
- **Necesitas verdadero paralelismo sobre los elementos.** Un único `await foreach` es secuencial por diseño. Para fan-out, usa `Parallel.ForEachAsync` o recolecta tareas y `Task.WhenAll`.

Una regla práctica útil: si te encuentras llamando a `ToListAsync()` sobre el flujo de inmediato, no querías un flujo, querías la lista. Y si te sientes tentado a envolver una lista en memoria como `IAsyncEnumerable<T>` solo para satisfacer una firma de método, reconsidera la firma.

## Una nota sobre liberación y salida temprana

Como el enumerador es `IAsyncDisposable`, el `await foreach` garantiza que `DisposeAsync` se ejecute cuando el bucle termina por cualquier razón: finalización normal, un `break`, o una excepción atravesando el cuerpo. Eso es lo que hace seguro el `using` dentro de un iterador asíncrono. La consecuencia sutil es que salir antes de tiempo no necesariamente detiene la fuente subyacente al instante. Una base de datos puede haber ya almacenado filas en el lado del servidor; un lector de red con búfer puede haber prefetchado el siguiente fragmento. La liberación envía la señal de cancelación, pero un poco de trabajo ya en vuelo todavía puede completarse. Esto casi nunca es un problema, pero explica el ocasional momento de "¿por qué sigue ejecutándose esta consulta después de que mi bucle salió?" en un profiler.

Los flujos asíncronos convirtieron la incómoda celda inferior derecha de la matriz valor/colección en una característica del lenguaje de primera clase. El modelo mental es todo el juego: es `IEnumerable<T>` donde cada paso puede hacer `await`, impulsado por `await foreach`, y vale la pena usarlo exactamente cuando los elementos llegan a lo largo del tiempo y preferirías procesarlos a medida que llegan en lugar de esperar a todos ellos.

## Relacionado

- [How to use IAsyncEnumerable<T> with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) aplica todo esto a transmitir filas de base de datos.
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) es la guía de decisión comparativa para las tres interfaces de secuencia.
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) es la contraparte de respuesta HTTP para producir un flujo.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) profundiza en los tokens de cancelación de los que dependen los flujos asíncronos.
- [Streaming tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) es la otra forma principal de consumir resultados a medida que se completan.

## Fuentes

- [IAsyncEnumerable<T> interface, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1?view=net-10.0).
- [Generate and consume async streams, C# docs](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream).
- [EnumeratorCancellationAttribute class, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute?view=net-10.0).
- [Breaking change: System.Linq.AsyncEnumerable in .NET 10, MS Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/asyncenumerable).
- [async-streams design doc, dotnet/roslyn on GitHub](https://github.com/dotnet/roslyn/blob/main/docs/features/async-streams.md).
