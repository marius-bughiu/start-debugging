---
title: "Cómo probar código dependiente del tiempo con TimeProvider y FakeTimeProvider en .NET 11"
description: "Reemplaza DateTime.UtcNow, Stopwatch y Task.Delay por System.TimeProvider para que las pruebas controlen el reloj: registro en la inyección de dependencias, FakeTimeProvider.Advance y SetUtcNow, pruebas de timeouts y de un BackgroundService basado en PeriodicTimer, más los problemas con Advance y las continuaciones y con xUnit v2."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "async"
  - "timeprovider"
lang: "es"
translationOf: "2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Para probar código dependiente del tiempo en .NET 11, deja de llamar directamente a `DateTime.UtcNow`, `Stopwatch` y `Task.Delay(...)` y recibe un `System.TimeProvider` por el constructor. En producción registras `TimeProvider.System` como singleton; en las pruebas pasas un `FakeTimeProvider` del paquete `Microsoft.Extensions.TimeProvider.Testing` y manejas el reloj tú mismo con `Advance(TimeSpan)` y `SetUtcNow(DateTimeOffset)`. Una verificación de expiración de prueba gratuita que antes exigía esperar 14 días se convierte en una prueba de dos líneas. Este artículo cubre el patrón completo en .NET 11 (Preview 6 al momento de escribir, versión final en noviembre de 2026) con C# 14 y `Microsoft.Extensions.TimeProvider.Testing` 10.8.0, incluidas las partes que duelen: avanzar varios periodos de temporizador de una sola vez, continuaciones que no se ejecutan después de `Advance` y el bloqueo por el contexto de sincronización de xUnit v2.

`TimeProvider` llegó incluido en .NET 8 (`System.Runtime.dll`), así que todo lo de aquí también funciona sin cambios en .NET 8, 9 y 10. Para .NET Framework 4.6.2+, .NET 5-7 y netstandard2.0 existe el paquete `Microsoft.Bcl.TimeProvider`, con una diferencia de API que se cubre al final.

## Por qué un reloj estático vuelve imposible de ejecutar una prueba

Este es el código que toda base de código tiene en alguna parte:

```csharp
// .NET 11, C# 14 -- untestable
public sealed class TrialService
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        DateTimeOffset.UtcNow - user.SignedUpAt >= TrialLength;
}
```

`DateTimeOffset.UtcNow` es una propiedad estática respaldada por el reloj del sistema operativo. No hay ningún punto de extensión. Para ejercitar la rama de expiración tienes tres malas opciones: esperar dos semanas, retroceder `user.SignedUpAt` (lo cual prueba la resta pero nunca el momento de la transición), o recurrir a un framework de mocking que parchee estáticos, que arrastra un interceptor basado en profiler y ralentiza toda la suite.

El límite es donde viven los errores. ¿El día 14 está expirado o todavía activo? ¿Qué pasa exactamente en `SignedUpAt + 14 days`? ¿Y en la transición de horario de verano en la zona local del usuario? Ninguna de esas preguntas tiene respuesta mientras el reloj pertenezca a la máquina.

## Qué abstrae realmente TimeProvider

`TimeProvider` es una clase abstracta con cinco capacidades, y vale la pena conocerlas todas porque la mayoría de la gente solo adopta la primera:

- `GetUtcNow()` y `GetLocalNow()` devuelven un `DateTimeOffset`. Esto reemplaza a `DateTimeOffset.UtcNow` y `DateTime.Now`.
- `GetTimestamp()` devuelve un contador de ticks de alta frecuencia, y `GetElapsedTime(long)` / `GetElapsedTime(long, long)` convierten dos de esos valores en un `TimeSpan`. Esto reemplaza a `Stopwatch`.
- `CreateTimer(TimerCallback, object?, TimeSpan, TimeSpan)` devuelve un `ITimer`. Esto reemplaza a `System.Threading.Timer`.
- `LocalTimeZone` devuelve un `TimeZoneInfo`. Esto reemplaza a `TimeZoneInfo.Local`.
- `TimestampFrequency` informa la frecuencia de ticks detrás de `GetTimestamp()`.

La implementación por defecto es la propiedad estática `TimeProvider.System`: el UTC viene de `DateTimeOffset.UtcNow`, la zona de `TimeZoneInfo.Local`, las marcas de tiempo de `Stopwatch` y los temporizadores de `System.Threading.Timer`. Usarla no cuesta nada frente a las APIs directas, porque es una capa delgada de reenvío sobre exactamente esas llamadas.

La razón por la que `CreateTimer` importa es que la BCL también conectó `TimeProvider` a las primitivas asíncronas. Estas sobrecargas reciben un `TimeProvider` y enrutan su temporizador interno a través de él:

- `Task.Delay(TimeSpan, TimeProvider)` y `Task.Delay(TimeSpan, TimeProvider, CancellationToken)`
- `Task.WaitAsync(TimeSpan, TimeProvider)` y su sobrecarga con `CancellationToken`
- `new CancellationTokenSource(TimeSpan, TimeProvider)`
- `new PeriodicTimer(TimeSpan, TimeProvider)`

Así que un bucle de reintentos con backoff, un plazo de solicitud y un servicio en segundo plano que hace polling son todos controlables desde una prueba sin un solo `Thread.Sleep`.

## Pasos para volver comprobable una clase dependiente del tiempo

1. Agrega un parámetro `TimeProvider` al constructor de la clase que lee el reloj. No le pongas un valor por defecto de `TimeProvider.System`, o el camino no comprobable seguirá siendo alcanzable por accidente.
2. Reemplaza dentro de esa clase cada `DateTime.UtcNow`, `DateTimeOffset.Now`, `Stopwatch.StartNew()`, `new Timer(...)` y `Task.Delay(...)` pelado por el equivalente de `TimeProvider`.
3. Registra el reloj real en la raíz de composición: `builder.Services.AddSingleton(TimeProvider.System);`.
4. Agrega `Microsoft.Extensions.TimeProvider.Testing` al proyecto de pruebas.
5. En cada prueba, construye un `FakeTimeProvider`, fija el instante inicial y mueve el reloj con `Advance` o `SetUtcNow` entre aserciones.

El resto del artículo expande cada uno de esos pasos en código funcional.

## Reescribir el servicio para que reciba un reloj

```csharp
// .NET 11, C# 14
public sealed class TrialService(TimeProvider timeProvider)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        timeProvider.GetUtcNow() - user.SignedUpAt >= TrialLength;
}
```

Ese es todo el cambio en producción. El constructor primario captura el proveedor, y la única diferencia en el punto de uso es `timeProvider.GetUtcNow()` en lugar de `DateTimeOffset.UtcNow`.

El registro es una línea, porque `TimeProvider.System` es un singleton que se puede compartir con seguridad en toda la aplicación:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<TrialService>();

var app = builder.Build();
```

Los propios componentes de ASP.NET Core ya buscan ese registro. Desde .NET 8, `ISystemClock` está obsoleto en toda la pila de autenticación e Identity, y las clases de opciones exponen en su lugar una propiedad `TimeProvider` asignable, que se resuelve desde el contenedor cuando has registrado una. Registrar `TimeProvider.System` por lo tanto también vuelve comprobables la validación de vigencia de tokens y la expiración de cookies.

## La primera prueba con FakeTimeProvider

```
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

La versión 10.8.0 es la actual a julio de 2026. Apunta a .NET 8.0 y posteriores más .NET Framework 4.6.2 y posteriores, y no arrastra dependencias en .NET moderno.

```csharp
// .NET 11, C# 14, xUnit v3, Microsoft.Extensions.TimeProvider.Testing 10.8.0
using Microsoft.Extensions.Time.Testing;

public class TrialServiceTests
{
    [Fact]
    public void Trial_is_active_on_day_13_and_expired_on_day_14()
    {
        var time = new FakeTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 0, 0, TimeSpan.Zero));

        var user = new User(SignedUpAt: time.GetUtcNow());
        var sut = new TrialService(time);

        time.Advance(TimeSpan.FromDays(13));
        Assert.False(sut.IsTrialExpired(user));

        time.Advance(TimeSpan.FromDays(1));
        Assert.True(sut.IsTrialExpired(user));
    }
}
```

Sin dormir, sin retroceder fechas, y el límite del día 14 queda afirmado explícitamente. Vale la pena interiorizar ya tres detalles de `FakeTimeProvider`:

**El constructor sin parámetros arranca a medianoche del 1 de enero de 2000 UTC.** Eso es deliberado: un instante fijo y obviamente sintético que nunca coincide por accidente con "hoy". Pasa un `DateTimeOffset` al constructor cuando la fecha en sí forme parte del comportamiento bajo prueba, por ejemplo un 29 de febrero o un cambio de fin de mes.

**`LocalTimeZone` toma por defecto `TimeZoneInfo.Utc`, no la zona de la máquina.** Así que `GetLocalNow()` es igual a `GetUtcNow()` hasta que llames a `SetLocalTimeZone(...)`. Esto es lo que vuelve deterministas las pruebas sensibles a la zona horaria en un agente de compilación ubicado en otra región que tu computadora:

```csharp
// .NET 11, C# 14 -- pin the zone so a CI agent in UTC behaves like a user in Bucharest
var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 3, 30, 0, TimeSpan.Zero));
time.SetLocalTimeZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Bucharest"));

Assert.Equal(new TimeSpan(2, 0, 0), time.GetLocalNow().Offset); // after the DST fall-back
```

**`SetUtcNow` solo avanza hacia adelante.** Pasar un valor anterior al tiempo actual lanza `ArgumentOutOfRangeException` con el mensaje "Cannot go back in time.". Si de verdad necesitas simular a un operador o a un demonio NTP moviendo el reloj hacia atrás, usa `AdjustTime(DateTimeOffset)`. `AdjustTime` desplaza el tiempo actual sin disparar ningún temporizador pendiente, y desplaza el punto de activación de cada temporizador pendiente por el mismo delta, que es lo que hace un cambio real del reloj del sistema.

## Probar un timeout en lugar de esperarlo

Los casos interesantes no son las marcas de tiempo, son las esperas. Una política de reintentos con backoff exponencial normalmente tarda segundos de tiempo real en probarse. Enruta su espera a través del proveedor y tarda microsegundos:

```csharp
// .NET 11, C# 14
public sealed class RetryingFetcher(HttpClient http, TimeProvider timeProvider)
{
    public async Task<string> FetchAsync(string url, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await http.GetStringAsync(url, ct);
            }
            catch (HttpRequestException) when (attempt < 3)
            {
                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt));
                await Task.Delay(backoff, timeProvider, ct);
            }
        }
    }
}
```

Los plazos funcionan igual. `new CancellationTokenSource(TimeSpan, TimeProvider)` te da una fuente de tokens cuyo temporizador interno lo maneja el reloj falso, así que todo el patrón de `CancelAfter` para imponer un plazo asíncrono se vuelve verificable:

```csharp
// .NET 11, C# 14
[Fact]
public async Task Deadline_fires_after_five_seconds()
{
    var time = new FakeTimeProvider();
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);

    Assert.False(cts.IsCancellationRequested);

    time.Advance(TimeSpan.FromSeconds(5));

    Assert.True(cts.IsCancellationRequested);
}
```

## Probar un BackgroundService que hace polling con un temporizador

Un worker de polling construido sobre `PeriodicTimer` es el componente clásico del "esto no lo probamos con pruebas unitarias". Con la sobrecarga de `TimeProvider` es código ordinario:

```csharp
// .NET 11, C# 14
public sealed class ExpiryWorker(IExpiryStore store, TimeProvider timeProvider)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await store.PurgeExpiredAsync(timeProvider.GetUtcNow(), stoppingToken);
        }
    }
}
```

La prueba tiene una sutileza: el worker tiene que llegar a `WaitForNextTickAsync` y registrar su temporizador antes de que avances, o de lo contrario avanzas más allá de un tick que nunca fue programado. No resuelvas esto con `Thread.Sleep`. Cede primero, después avanza, y después espera una señal de que el trabajo realmente ocurrió:

```csharp
// .NET 11, C# 14, xUnit v3
[Fact]
public async Task Worker_purges_once_per_five_minute_tick()
{
    var time = new FakeTimeProvider();
    var store = new RecordingExpiryStore(); // sets a TaskCompletionSource on each call
    var worker = new ExpiryWorker(store, time);

    await worker.StartAsync(CancellationToken.None);
    await Task.Yield(); // let ExecuteAsync reach WaitForNextTickAsync

    time.Advance(TimeSpan.FromMinutes(5));
    await store.NextPurge; // completes when PurgeExpiredAsync is entered

    Assert.Equal(1, store.PurgeCount);

    await worker.StopAsync(CancellationToken.None);
}
```

Esperar una señal que emite el código de producción, en lugar de esperar tiempo de reloj, es lo que impide que esta prueba sea inestable en un agente de CI cargado. La misma disciplina aplica cuando el worker bajo prueba usa [servicios con ámbito dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): resuelve el ámbito dentro del bucle y luego afirma sobre lo que ese ámbito produjo.

## Advance dispara los temporizadores periódicos una vez por periodo transcurrido

Este es el comportamiento que más sorprende. `FakeTimeProvider.Advance` recorre su lista de esperas, invoca cada callback cuyo punto de activación ya pasó, y para un temporizador periódico le suma el periodo al punto de activación y vuelve a comprobar. Una sola llamada dispara por lo tanto doce veces un temporizador de cinco minutos:

```csharp
// .NET 11, C# 14 -- twelve ticks, not one
time.Advance(TimeSpan.FromHours(1)); // PeriodicTimer period = 5 minutes
```

Para `PeriodicTimer` en concreto eso no significa doce iteraciones del bucle, porque `WaitForNextTickAsync` fusiona los ticks que llegan mientras nadie está esperando. Pero para un `ITimer` crudo creado con `CreateTimer` y con un periodo no infinito, obtendrás doce invocaciones del callback, de forma síncrona, en el hilo que llamó a `Advance`. Si quieres exactamente un tick, avanza exactamente un periodo.

La parte síncrona importa por una segunda razón: cualquier excepción lanzada dentro de un callback de temporizador se propaga fuera de tu llamada a `Advance`, no en algún hilo de fondo donde quedaría tragada. Eso normalmente es un regalo, pero significa que una línea de `Advance` puede lanzar un fallo de aserción originado en código varias capas más allá.

## Continuaciones que no se ejecutan después de Advance

El problema más reportado de `FakeTimeProvider` es una prueba que se cuelga o afirma demasiado pronto tras `Advance`, registrado como [dotnet/extensions#5326](https://github.com/dotnet/extensions/issues/5326). La forma es esta:

```csharp
// .NET 11, C# 14 -- flaky: the continuation may not have run yet
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
Assert.True(delayTask.IsCompleted); // not guaranteed
```

`Advance` completa la tarea subyacente, pero la continuación que adjuntó un `await` en otro lugar queda programada, no ejecutada en línea. El arreglo es esperar aquello que te importa en vez de consultar una bandera:

```csharp
// .NET 11, C# 14 -- deterministic
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
await delayTask; // returns immediately, and orders the continuation
```

Verás `await Task.Delay(1)` después de `Advance` en mucho código de ejemplo. Funciona porque le da un turno real al planificador, pero reintroduce una dependencia del tiempo real en una prueba cuyo objetivo entero era eliminar una. Espera la operación en su lugar, o espera un `TaskCompletionSource` que complete el código de producción.

La trampa relacionada es `AutoAdvanceAmount`. Asignarlo hace que el reloj avance en cada *lectura* de `GetUtcNow()` o `GetTimestamp()`, lo cual es cómodo para código que mide el tiempo transcurrido entre dos lecturas:

```csharp
// .NET 11, C# 14 -- every clock read advances by 100ms
var time = new FakeTimeProvider { AutoAdvanceAmount = TimeSpan.FromMilliseconds(100) };

long start = time.GetTimestamp();
long end = time.GetTimestamp();

Assert.Equal(TimeSpan.FromMilliseconds(100), time.GetElapsedTime(start, end));
```

Pero el avance automático no maneja temporizadores, porque nada lee el reloj en nombre de un temporizador. Un `Task.Delay(TimeSpan, TimeProvider)` nunca se completará solo con avance automático; sigues necesitando un `Advance` explícito. Vale la pena recordar esa distinción antes de gastar una tarde en ella.

## El bloqueo por el contexto de sincronización de xUnit v2

Si tu proyecto de pruebas sigue en xUnit v2 y el código bajo prueba usa `ConfigureAwait(false)`, una prueba con `FakeTimeProvider` puede quedar en interbloqueo. xUnit v2 instala un `AsyncTestSyncContext` durante cada prueba, y la interacción entre ese contexto y los callbacks de temporizador ejecutados en línea deja la prueba detenida para siempre. El README del paquete documenta la solución alterna:

```csharp
// .NET 11, C# 14 -- xUnit v2 only
SynchronizationContext.SetSynchronizationContext(null);
```

Pon eso al inicio de la prueba afectada, o en el constructor del fixture. xUnit v3 eliminó `AsyncTestSyncContext` por completo, así que el problema no existe allí. Si estás eligiendo framework de pruebas para un proyecto nuevo, este es un pequeño argumento más a favor de v3.

## Qué no conviene convertir

`TimeProvider` es un punto de extensión, no una religión. Dos reglas evitan que se extienda de más:

Inyéctalo en la clase que toma una *decisión* basada en el tiempo, no en cada clase que casualmente pasa una marca de tiempo. Un DTO que carga un `CreatedAt` no necesita un reloj; la fábrica que lo estampa sí.

No leas el reloj dos veces en un mismo método esperando el mismo valor. `timeProvider.GetUtcNow()` es una llamada a método, no una propiedad cacheada, y con `AutoAdvanceAmount` asignado devuelve deliberadamente algo distinto cada vez. Lee una vez en una variable local y usa la local, que es una buena práctica también con `DateTime.UtcNow` y aquí se vuelve un requisito de corrección.

Por último, en .NET Framework y netstandard2.0 a través de `Microsoft.Bcl.TimeProvider`, las sobrecargas asíncronas no existen como métodos de instancia. Usa en su lugar los métodos de extensión de `System.Threading.Tasks.TimeProviderTaskExtensions`: `timeProvider.Delay(...)`, `timeProvider.CreateCancellationTokenSource(...)` y `task.WaitAsync(timeout, timeProvider, ct)`. El comportamiento es el mismo; solo cambia la forma de la llamada, así que una biblioteca con varios targets necesita un pequeño `#if` o un helper compartido.

## Relacionado

- La mecánica de timeouts que este artículo vuelve comprobable está cubierta a fondo en la guía para [imponer un plazo asíncrono con CancellationTokenSource.CancelAfter](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).
- Cada una de estas pruebas depende de que un token llegue a la operación, que es el tema de [propagar un CancellationToken a través de métodos asíncronos](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Cuando el código bajo prueba necesita una base de datos real en lugar de un reloj falso, mira [pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Elegir dónde vive el bucle de polling en primer lugar se cubre en [BackgroundService vs IHostedService vs Hangfire](/es/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).
- Bloquear sobre una llamada asíncrona es la forma más rápida de colgar una prueba con `FakeTimeProvider` por razones que nada tienen que ver con el reloj: mira [el interbloqueo por llamar a .Result o .Wait()](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

## Fuentes

- [TimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider) en Microsoft Learn
- [What is the TimeProvider class](https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview) en la documentación de fundamentos de .NET
- [Referencia de la API de FakeTimeProvider](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.time.testing.faketimeprovider)
- [README de Microsoft.Extensions.TimeProvider.Testing](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/README.md) en dotnet/extensions
- [Código fuente de FakeTimeProvider.cs](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/FakeTimeProvider.cs)
- [dotnet/extensions#5326: las continuaciones de Task.Delay no se ejecutan al llamar a Advance](https://github.com/dotnet/extensions/issues/5326)
- [Cambio importante: ISystemClock está obsoleto](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/8.0/isystemclock-obsolete)
