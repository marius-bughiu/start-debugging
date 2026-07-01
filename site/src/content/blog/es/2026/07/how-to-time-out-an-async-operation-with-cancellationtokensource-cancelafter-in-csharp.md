---
title: "Cómo establecer un tiempo de espera en una operación asíncrona con CancellationTokenSource.CancelAfter en C#"
description: "Usa CancellationTokenSource.CancelAfter para aplicar un plazo límite en operaciones asíncronas en .NET 11: constructor vs CancelAfter, tokens vinculados, manejo de excepciones, Task.WaitAsync, TryReset y tiempos de espera testeables con TimeProvider."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "es"
translationOf: "2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Establecer un plazo límite en una operación asíncrona requiere tres cosas: un `CancellationTokenSource`, una llamada a `cts.CancelAfter(TimeSpan.FromSeconds(5))`, y pasar `cts.Token` a cada método asíncrono en la cadena. Cuando el plazo expira, el token se activa, cualquier `await` posterior lanza `OperationCanceledException`, y tú lo capturas. Este artículo cubre el patrón completo en .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): cuándo usar la sobrecarga del constructor en lugar de `CancelAfter`, cómo combinar un tiempo de espera con un `CancellationToken` externo, cómo distinguir un tiempo de espera de una cancelación del llamador, `Task.WaitAsync` para código que no puedes modificar, `TryReset` para pooling, y cómo hacer los tiempos de espera testeables con `TimeProvider`.

## La operación que cuelga para siempre

Una llamada de `HttpClient` sin un plazo explícito espera el tiempo que el servidor tarde. `HttpClient.Timeout` tiene un valor predeterminado de 100 segundos, lo que es suficiente para saturar una cola de solicitudes bajo carga. Además, `HttpClient.Timeout` no puede combinarse con el `CancellationToken` de un llamador, y cuando se activa lanza `TaskCanceledException` con un `InnerException` que es `TimeoutException` -- una forma diferente a una cancelación cooperativa. El patrón manual de `CancelAfter` te ofrece tanto la aplicación del plazo como la composición.

```csharp
// .NET 11, C# 14 -- peligroso: HttpClient.Timeout tiene un valor predeterminado de 100 segundos
using HttpClient http = new();
string json = await http.GetStringAsync("https://slow-api.example.com/data");
```

## CancelAfter en un solo paso

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(5));

try
{
    using HttpClient http = new();
    string json = await http.GetStringAsync(
        "https://slow-api.example.com/data", cts.Token);
    Console.WriteLine(json);
}
catch (OperationCanceledException) when (cts.IsCancellationRequested)
{
    Console.WriteLine("La solicitud expiró después de 5 segundos.");
}
```

`CancelAfter` programa un temporizador interno de un solo disparo. Cuando el temporizador se activa, llama a `Cancel()` en el CTS, lo que cambia el estado del token de "no solicitado" a "solicitado". Cualquier `await` dentro de `GetStringAsync` que compruebe el token lanza `OperationCanceledException`. La cláusula `when` garantiza que solo captures la excepción si fue tu propio CTS el que se activó -- no si llega alguna otra cancelación que el framework o un llamador inyecte.

## Sobrecarga del constructor vs CancelAfter

```csharp
// .NET 11, C# 14 -- equivalentes para un plazo fijo de un solo disparo:
using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

using var cts2 = new CancellationTokenSource();
cts2.CancelAfter(TimeSpan.FromSeconds(5));
```

Usa la sobrecarga del constructor cuando el plazo es fijo en el momento de creación del objeto y no cambiará. Prefiere `CancelAfter` cuando creas el CTS con anticipación y decides el plazo más tarde, o cuando necesitas restablecerlo durante la operación -- por ejemplo, un watchdog que renueva su ventana en cada latido exitoso:

```csharp
// .NET 11, C# 14 -- patrón de watchdog que reinicia el plazo en cada paquete
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));

await foreach (Packet packet in ReadPacketsAsync(cts.Token))
{
    Process(packet);
    cts.CancelAfter(TimeSpan.FromSeconds(10));  // reinicia la ventana de 10 segundos
}
```

Cada llamada a `CancelAfter` reemplaza el tiempo programado anteriormente usando `ITimer.Change` internamente -- sin nueva asignación de memoria. La nueva cuenta regresiva comienza desde el momento de la llamada.

## Combinar un tiempo de espera con un CancellationToken externo

En ASP.NET Core, `HttpContext.RequestAborted` se activa cuando el cliente se desconecta. En un `BackgroundService`, `stoppingToken` se activa al apagar. Tu tiempo de espera debería cancelar si el plazo se activa o el llamador cancela. Usa `CancellationTokenSource.CreateLinkedTokenSource`:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithDeadlineAsync(
    string url,
    CancellationToken callerToken = default)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
        callerToken, timeoutCts.Token);

    using HttpClient http = new();
    return await http.GetStringAsync(url, linked.Token);
}
```

Pasa `linked.Token` a todas las llamadas posteriores. El token vinculado se cancela si cualquiera de las fuentes se activa. `CreateLinkedTokenSource` acepta cualquier número de tokens; el CTS devuelto se cancela tan pronto como cualquiera de ellos es cancelado.

Siempre haz `Dispose` tanto del CTS de tiempo de espera como del CTS vinculado. Las instancias de CTS no descartadas con temporizadores pendientes no son recolectadas por el recolector de basura hasta que el temporizador se active.

## Distinguir un tiempo de espera de una cancelación del llamador

Ambas rutas lanzan `OperationCanceledException`. Para dar información de error significativa a los llamadores, convierte un verdadero tiempo de espera en un `TimeoutException`:

```csharp
// .NET 11, C# 14
catch (OperationCanceledException ex)
{
    if (timeoutCts.IsCancellationRequested)
        throw new TimeoutException(
            "La operación expiró después de 5 segundos.", ex);

    // El llamador canceló -- relanza sin envolver para que el token del llamador
    // se propague sin cambios
    throw;
}
```

Esto importa cuando el código llamador no conoce el `CancellationTokenSource` interno. Un llamador que captura `TimeoutException` no necesita inspeccionar tokens que nunca creó.

Al usar un CTS vinculado, comprueba `timeoutCts.IsCancellationRequested` directamente. No compares `ex.CancellationToken` con el token vinculado -- `ex.CancellationToken` contiene el token constituyente que se activó primero (llamador, tiempo de espera o vinculado), lo que varía según la condición de carrera.

## Task.WaitAsync para código que no acepta un token

No todas las APIs aceptan un `CancellationToken`. .NET 6 añadió `Task.WaitAsync` para ese caso:

```csharp
// .NET 11, C# 14 -- envolviendo una API heredada sin token
Task<string> slowWork = LegacyApiAsync();

try
{
    string result = await slowWork.WaitAsync(TimeSpan.FromSeconds(5));
}
catch (TimeoutException)
{
    // El plazo pasó. slowWork SIGUE EJECUTÁNDOSE en segundo plano.
    Console.WriteLine("Dejamos de esperar después de 5 segundos.");
}
```

`WaitAsync(TimeSpan)` lanza `TimeoutException` (no `OperationCanceledException`) y no cancela el `Task` subyacente. El trabajo sigue ejecutándose hasta que se complete por sí solo. Usa `WaitAsync` solo cuando no puedas pasar un token al código llamado; el consumo de recursos continúa de todas formas.

Una sobrecarga combinada acepta tanto un plazo como un `CancellationToken`:

```csharp
// .NET 11, C# 14 -- cancelable Y con límite de tiempo
await slowWork.WaitAsync(TimeSpan.FromSeconds(5), callerToken);
```

Esta sobrecarga lanza `TimeoutException` si el plazo se activa primero, o `TaskCanceledException` (subclase de `OperationCanceledException`) si el token se activa primero.

## Restablecer y deshabilitar un tiempo de espera existente

`CancelAfter` puede llamarse varias veces. Cada llamada reemplaza el plazo programado anteriormente:

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));   // plazo inicial: 10s

// Extender: reinicia el temporizador con una ventana de 5 segundos desde ahora
cts.CancelAfter(TimeSpan.FromSeconds(5));

// Deshabilitar el tiempo de espera sin cancelar el CTS:
cts.CancelAfter(Timeout.InfiniteTimeSpan);   // ya no se activa
```

`Timeout.InfiniteTimeSpan` equivale a `-1` milisegundos, lo que deshabilita el temporizador interno sin poner el CTS en estado cancelado.

Una vez que un CTS ha sido cancelado, llamar a `CancelAfter` no tiene efecto. Comprueba `IsCancellationRequested` primero si la cancelación puede ya haberse producido.

## TryReset para pooling

En código de alto rendimiento que emite muchas operaciones cortas, crear un nuevo `CancellationTokenSource` por solicitud genera asignaciones de memoria. .NET 6 añadió `TryReset` para la reutilización:

```csharp
// .NET 11, C# 14 -- patrón de CTS en pool
private CancellationTokenSource _cts = new();

public async Task ProcessRequestAsync()
{
    if (!_cts.TryReset())
        _cts = new CancellationTokenSource();

    _cts.CancelAfter(TimeSpan.FromSeconds(5));

    await DoWorkAsync(_cts.Token);
}
```

`TryReset` devuelve `true` si el CTS no ha sido cancelado y es seguro reutilizarlo; `false` si fue cancelado y se requiere una nueva instancia. No es seguro para hilos con solicitudes de cancelación concurrentes -- llámalo solo después de que la operación anterior haya completado, desde un único propietario. ASP.NET Core usa este patrón internamente en Kestrel.

## Tiempos de espera testeables con TimeProvider

Esperar 5 segundos reales en una prueba unitaria es lento y poco confiable. `TimeProvider`, introducido en .NET 8 y estable en .NET 11, hace el temporizador interno inyectable:

```csharp
// .NET 11, C# 14
public async Task<string> FetchAsync(
    string url,
    TimeProvider? clock = null)
{
    clock ??= TimeProvider.System;
    using var cts = clock.CreateCancellationTokenSource(TimeSpan.FromSeconds(5));

    using HttpClient http = new();
    return await http.GetStringAsync(url, cts.Token);
}
```

En las pruebas, inyecta `FakeTimeProvider` del paquete NuGet `Microsoft.Extensions.TimeProvider.Testing`:

```csharp
// xUnit, .NET 11, C# 14
[Fact]
public async Task FetchAsync_ThrowsOnTimeout()
{
    var clock = new FakeTimeProvider();
    Task<string> fetch = FetchAsync("https://slow.example.com", clock);

    clock.Advance(TimeSpan.FromSeconds(10));  // avanza 10 segundos al instante

    await Assert.ThrowsAsync<OperationCanceledException>(() => fetch);
}
```

La cancelación se activa sincrónicamente cuando avanzas el reloj. Sin `Task.Delay`. Sin tiempos de prueba inestables.

## Descarta el CTS

`CancellationTokenSource` implementa `IDisposable`, no `IAsyncDisposable`. No existe un `DisposeAsync`. Cuando llamas a `CancelAfter`, se registra un temporizador en la cola de temporizadores del grupo de hilos. Ese temporizador mantiene una referencia al CTS, impidiendo la recolección de basura hasta que se active.

Siempre descarta:

```csharp
// Correcto: limpieza garantizada aunque se lance una excepción
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await DoWorkAsync(cts.Token);
// cts.Dispose() se llama aquí; el temporizador se cancela y se libera
```

El descarte cancela el temporizador pendiente, libera los handles de espera y elimina el CTS de cualquier cadena de `CreateLinkedTokenSource` a la que pertenezca. En un servidor que maneja miles de solicitudes concurrentes, las instancias de CTS perdidas causan acumulación de temporizadores.

## Problemas comunes

**HttpClient.Timeout compite con tu token.** `HttpClient.Timeout` tiene un valor predeterminado de 100 segundos. Si también pasas un token con `CancelAfter`, ambos temporizadores están ejecutándose. Cuando `HttpClient.Timeout` se activa lanza `TaskCanceledException` donde `ex.InnerException is TimeoutException`; cuando tu token se activa lanza `OperationCanceledException` donde `ex.CancellationToken == cts.Token`. Desactiva uno de los dos: establece `HttpClient.Timeout` a `Timeout.InfiniteTimeSpan` y gestiona el plazo tú mismo, o confía en `HttpClient.Timeout` y omite el CTS manual. Consulta [Fix: TaskCanceledException en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para la desambiguación completa.

**CancelAfter después de Cancel no tiene efecto.** Una vez que un CTS está en estado cancelado, llamar a `CancelAfter` no hace nada. La cancelación es una transición unidireccional.

**Marshaling del hilo de la interfaz de usuario.** En WinForms, WPF o MAUI, la continuación después de un `await` cancelado se ejecuta en el hilo del grupo de hilos que recoge la finalización -- no en el hilo de la UI. Si actualizas elementos de la UI en el bloque catch, regresa explícitamente al hilo correcto. En ASP.NET Core no hay `SynchronizationContext`, por lo que [ConfigureAwait(false) no tiene efecto](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/).

**No compartas un token entre ramas paralelas a menos que sea intencional.** Si distribuyes trabajo con `Task.WhenAll` y pasas el mismo `cts.Token` a todas las ramas, la primera cancelación cancela todas las demás. Eso generalmente es lo que quieres para un plazo compartido, pero sé deliberado al respecto.

## Relacionados

- Propagar un único `CancellationToken` a través de cada capa asíncrona: [Cómo propagar un CancellationToken a través de métodos asíncronos en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- Cancelación manual sin plazo: [Cómo cancelar una tarea de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- Tres razones por las que HttpClient lanza TaskCanceledException: [Fix: TaskCanceledException en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- ConfigureAwait(false) en código de biblioteca: [ConfigureAwait(false) vs predeterminado en .NET 11](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- async void vs async Task -- cuál puede propagar excepciones: [async void vs async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)

## Fuentes

- [CancellationTokenSource.CancelAfter -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelafter)
- [CancellationTokenSource.TryReset -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.tryreset)
- [Task.WaitAsync -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [TimeProvider.CreateCancellationTokenSource -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider.createcancellationtokensource)
- [Microsoft.Extensions.TimeProvider.Testing en NuGet](https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing)
