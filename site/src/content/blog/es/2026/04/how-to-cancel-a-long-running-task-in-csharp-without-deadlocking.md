---
title: "Cómo cancelar una Task de larga duración en C# sin interbloquear"
description: "Cancelación cooperativa con CancellationToken, CancelAsync, Task.WaitAsync y tokens enlazados en .NET 11. Más los patrones de bloqueo que convierten una cancelación limpia en un interbloqueo."
pubDate: 2026-04-23
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "es"
translationOf: "2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking"
translatedBy: "claude"
translationDate: 2026-04-24
---

Tienes una `Task` que se ejecuta durante mucho tiempo, un usuario hace clic en Cancelar, y la app se cuelga o la tarea sigue ejecutándose hasta terminar por sí sola. Ambos resultados apuntan al mismo malentendido: en .NET, la cancelación es cooperativa, y las piezas que la hacen funcionar son `CancellationTokenSource`, `CancellationToken` y tu voluntad de comprobar el token. Este post recorre cómo configurar eso de forma limpia en .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), y cómo evitar los patrones de bloqueo que convierten una cancelación limpia en un interbloqueo por `Wait`. Cada ejemplo compila contra .NET 11.

## Cancelación cooperativa, el modelo mental en un párrafo

.NET no tiene `Task.Kill()`. El CLR no sacará un hilo de en medio de tu código. Cuando quieres cancelar trabajo, creas un `CancellationTokenSource`, le pasas su `Token` a cada función de la cadena de llamadas, y esas funciones comprueban `token.IsCancellationRequested`, llaman a `token.ThrowIfCancellationRequested()`, o pasan el token a una API asíncrona que lo respeta. Cuando `cts.Cancel()` (o `await cts.CancelAsync()`) se dispara, el token cambia y cada sitio de comprobación reacciona. No se cancela nada a lo que no se le haya pedido comprobar.

Por esto `Task.Run(() => LongLoop())` sin un token no puede cancelarse. El compilador no inyecta cancelación por ti.

## El patrón mínimo correcto

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();

Task work = DoWorkAsync(cts.Token);

// Later, from a Cancel button, a timeout, whatever:
await cts.CancelAsync();

try
{
    await work;
}
catch (OperationCanceledException)
{
    // Expected when cts triggers. Not an error.
}

static async Task DoWorkAsync(CancellationToken ct)
{
    for (int i = 0; i < 1_000_000; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(10, ct); // async APIs should take the token
    }
}
```

Tres reglas están haciendo el trabajo aquí:

1. El `CancellationTokenSource` se libera (`using var`) para que su timer interno y su wait handle se liberen.
2. Cada nivel de la cadena de llamadas acepta un `CancellationToken` y lo comprueba o lo reenvía.
3. El llamador hace `await` a la tarea y captura `OperationCanceledException`. La cancelación aflora como excepción para que la limpieza en bloques `finally` se siga ejecutando.

## Bucles con uso intensivo de CPU: ThrowIfCancellationRequested

Para trabajo con uso intensivo de CPU, reparte `ct.ThrowIfCancellationRequested()` a una tasa que haga la capacidad de respuesta aceptable sin convertir la comprobación en el camino caliente. La comprobación es barata (`Volatile.Read` sobre un `int`), pero dentro de un bucle interno apretado procesando decenas de millones de elementos sigue apareciendo en los profiles. Un buen default es una vez por iteración externa de cualquier bucle que haga "una unidad de trabajo".

```csharp
// .NET 11, C# 14
static long SumPrimes(int max, CancellationToken ct)
{
    long sum = 0;
    for (int n = 2; n <= max; n++)
    {
        if ((n & 0xFFFF) == 0) ct.ThrowIfCancellationRequested(); // every 65536 iterations
        if (IsPrime(n)) sum += n;
    }
    return sum;
}
```

Cuando el trabajo vive en un hilo de fondo iniciado con `Task.Run`, pasa el token también al propio `Task.Run`:

```csharp
var task = Task.Run(() => SumPrimes(10_000_000, cts.Token), cts.Token);
```

Pasar el token a `Task.Run` significa que si el token se cancela **antes** de que el delegate empiece a ejecutarse, la tarea transiciona directamente a `Canceled` sin ejecutarse. Sin él, el delegate corre hasta terminar y solo la comprobación interna lo detendría.

## Trabajo I/O: reenvía el token a cada API asíncrona

Cada API de I/O moderna en .NET acepta un `CancellationToken`. `HttpClient.GetAsync`, `Stream.ReadAsync`, `DbCommand.ExecuteReaderAsync`, `SqlConnection.OpenAsync`, `File.ReadAllTextAsync`, `Channel.Reader.ReadAsync`. Si no bajas el token, la cancelación se detiene en tu capa y la I/O subyacente continúa hasta que el SO o el otro lado se rinden.

```csharp
// .NET 11, C# 14
static async Task<string> FetchWithTimeoutAsync(string url, TimeSpan timeout, CancellationToken outer)
{
    using var http = new HttpClient();
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
    linked.CancelAfter(timeout);

    using HttpResponseMessage resp = await http.GetAsync(url, linked.Token);
    resp.EnsureSuccessStatusCode();
    return await resp.Content.ReadAsStringAsync(linked.Token);
}
```

Vale la pena destacar dos cosas en ese fragmento. `CreateLinkedTokenSource` combina "el llamador quiere cancelar" con "nos rendimos tras `timeout`" en un único token. Y `CancelAfter` es la forma correcta de expresar un timeout, no `Task.Delay` compitiendo contra el trabajo, porque usa una única entrada en la cola del timer en lugar de asignar una `Task` completa.

## Las trampas de interbloqueo, en orden de frecuencia

### Trampa 1: bloquear en un método async desde un contexto que captura

```csharp
// BAD on WinForms, WPF, or any SynchronizationContext that runs on one thread
string html = FetchAsync(url).Result;
```

`FetchAsync` hace `await` por dentro, lo que publica la continuación de vuelta al `SynchronizationContext` capturado. Ese contexto es el hilo de UI. El hilo de UI está bloqueado en `.Result`. La continuación no puede ejecutarse. Interbloqueo. La cancelación no ayuda aquí, porque la tarea nunca va a completarse.

El arreglo no es `ConfigureAwait(false)` en tu código. El arreglo es no bloquear en primer lugar. Haz el llamador asíncrono:

```csharp
string html = await FetchAsync(url);
```

Si absolutamente no puedes usar `await` (por ejemplo, un constructor), usa `Task.Run` para moverte fuera del contexto capturado primero. Eso es una rendición, no una solución.

### Trampa 2: ConfigureAwait(false) solo en el await exterior

Un autor de librería envuelve una llamada en `ConfigureAwait(false)`, ve que el interbloqueo desaparece en su prueba unitaria, y lo libera. Luego un llamador envuelve todo en `.Result` y el interbloqueo vuelve, porque un `await` interno en un callee sí capturó el contexto.

`ConfigureAwait(false)` es un ajuste por cada `await`. O cada `await` en cada método de librería lo usa, o ninguno. El mundo de las anotaciones `Nullable` lo tiene fácil; este no. En .NET 11 con C# 14, puedes activar el analizador `CA2007` para imponer `ConfigureAwait(false)` en librerías, y usar `ConfigureAwaitOptions.SuppressThrowing` cuando quieras esperar una tarea puramente por su finalización sin importar su excepción.

### Trampa 3: CancellationTokenSource.Cancel() llamado desde un callback registrado en el mismo token

`CancellationTokenSource.Cancel()` ejecuta los callbacks registrados **de forma síncrona** en el hilo llamador por defecto. Si uno de esos callbacks llama a `Cancel()` sobre la misma fuente, o bloquea en un lock que otro callback tiene, obtienes un interbloqueo recursivo o reentrante. En .NET 11, prefiere `await cts.CancelAsync()` cuando tengas cualquier lock, cuando estés en un `SynchronizationContext`, o cuando los callbacks no sean triviales. `CancelAsync` despacha los callbacks de forma asíncrona, así que `Cancel` te devuelve el control primero.

```csharp
// .NET 11, C# 14
lock (_state)
{
    _state.MarkStopping();
}
await _cts.CancelAsync(); // callbacks fire after we are out of the lock
```

### Trampa 4: una tarea que ignora su token

La causa más común de "cancelar no hace nada" no es un interbloqueo en absoluto, es una tarea que nunca comprueba. Arréglalo en la fuente:

```csharp
static async Task BadAsync(CancellationToken ct)
{
    await Task.Delay(5000); // no token, so unaffected by cancel
}

static async Task GoodAsync(CancellationToken ct)
{
    await Task.Delay(5000, ct); // throws OperationCanceledException on cancel
}
```

Si no puedes modificar el callee (código de terceros sin parámetro de token), `Task.WaitAsync(CancellationToken)` de .NET 6+ te da una salida: la espera se vuelve cancelable aunque el trabajo subyacente no lo sea.

```csharp
// .NET 11, C# 14
Task<string> hardcoded = LegacyFetchThatIgnoresTokensAsync();
string result = await hardcoded.WaitAsync(ct); // returns immediately on cancel; the underlying work keeps running
```

Sé honesto sobre lo que hace esto: te desbloquea, no detiene el trabajo. En .NET 11 el `HttpClient`, el handle de archivo o lo que sea que el código legacy esté haciendo continúa hasta terminar, y su resultado se descarta. Para un bucle de larga duración que retiene recursos exclusivos, esto es una fuga, no una cancelación.

## Tokens enlazados: cancelación del llamador + timeout + shutdown

Un endpoint de servidor realista quiere cancelar por tres razones: el llamador se desconectó, el timeout por request expiró, o el host está cerrándose. `CreateLinkedTokenSource` los compone.

```csharp
// .NET 11, C# 14 - ASP.NET Core 11 minimal API
app.MapGet("/report", async (HttpContext ctx, IHostApplicationLifetime life, CancellationToken requestCt) =>
{
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestCt, life.ApplicationStopping);
    linked.CancelAfter(TimeSpan.FromSeconds(30));

    string report = await BuildReportAsync(linked.Token);
    return Results.Text(report);
});
```

ASP.NET Core ya te da `HttpContext.RequestAborted` (expuesto como el parámetro `CancellationToken` cuando lo aceptas). Enlázalo con `IHostApplicationLifetime.ApplicationStopping` para que un shutdown elegante también cancele el trabajo en vuelo, y añade un timeout por endpoint encima. Si cualquiera de los tres se dispara, `linked.Token` cambia.

## OperationCanceledException vs TaskCanceledException

Ambas existen. `TaskCanceledException` hereda de `OperationCanceledException`. Captura `OperationCanceledException` salvo que específicamente necesites distinguir "la tarea fue cancelada" de "el llamador canceló una operación diferente". En la práctica, captura siempre la clase base.

Un punto sutil: cuando haces `await` a una tarea que fue cancelada, la excepción que recibes puede no llevar el token original. Si necesitas saber qué token se disparó, comprueba `ex.CancellationToken == ct` en vez de inspeccionar qué token pasaste a qué API.

## Libera tu CancellationTokenSource, sobre todo cuando uses CancelAfter

`CancellationTokenSource.CancelAfter` programa trabajo en el timer interno. Olvidar liberar el CTS mantiene esa entrada del timer viva hasta que el GC la alcance, lo que en un servidor ocupado es una fuga de memoria y timer que no hace crashear pero aparece como crecimiento lento en `dotnet-counters`. Usa `using var cts = ...;` o `using (var cts = ...) { ... }` siempre.

Si quieres pasar el CTS a un dueño en background, asegúrate de que exactamente un sitio es responsable de liberarlo, y libéralo solo después de que todos los que tengan su token lo hayan soltado.

## Servicios en background: stoppingToken es tu amigo

En un `BackgroundService`, `ExecuteAsync` recibe un `CancellationToken stoppingToken` que cambia cuando el host empieza a cerrarse. Úsalo como raíz de cada cadena de cancelación dentro del servicio. No crees instancias de CTS nuevas desconectadas del shutdown, o un `Ctrl+C` elegante hará timeout y el host tirará del proceso por las malas.

```csharp
// .NET 11, C# 14
public sealed class Crawler(IHttpClientFactory http, ILogger<Crawler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var perItem = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                perItem.CancelAfter(TimeSpan.FromSeconds(10));

                await CrawlNextAsync(http.CreateClient(), perItem.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // host is stopping; exit cleanly
            }
            catch (OperationCanceledException)
            {
                log.LogWarning("Per-item timeout elapsed, continuing.");
            }
        }
    }
}
```

El `catch` con un filtro `when` distingue "estamos cerrando" de "hicimos timeout en una sola unidad de trabajo". Shutdown rompe el bucle exterior. Un timeout por elemento registra y sigue.

## ¿Qué pasa con Thread.Abort, Task.Dispose o un kill duro?

`Thread.Abort` no está soportado en .NET Core y lanza `PlatformNotSupportedException` en .NET 11. `Task.Dispose` existe pero no es lo que crees que es, solo libera un `WaitHandle`, no cancela la tarea. No hay una API "mata esta tarea" por diseño. La válvula de escape más cercana es ejecutar trabajo realmente incancelable en un proceso separado (`Process.Start` + `Process.Kill`) y convivir con el overhead inter-proceso. Para todo lo demás, la cancelación cooperativa es la API.

## Juntándolo todo

Un botón de cancelar que funcione es nueve de cada diez veces resultado de tres pequeños hábitos: cada método asíncrono toma un `CancellationToken` y lo reenvía, cada bucle largo llama a `ThrowIfCancellationRequested` a una cadencia sensata, y nada en ningún punto de la cadena bloquea en `.Result` o `.Wait()`. Añade `using` sobre tu CTS, `CancelAfter` para timeouts, `await CancelAsync()` dentro de locks, y `WaitAsync` como salida para código que no puedes cambiar.

## Lecturas relacionadas

- [Haciendo streaming de filas de la base de datos con IAsyncEnumerable](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), que se apoya mucho en la misma fontanería de tokens.
- [Stack traces de async más limpios en el runtime de .NET 11](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), útil cuando una `OperationCanceledException` aflora en lo profundo de un pipeline.
- [Cómo devolver múltiples valores desde un método en C# 14](/es/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) combina bien con métodos asíncronos que quieren devolver "resultado o razón de cancelación".
- [El final de `lock (object)` en .NET 9](/2026/01/net-9-the-end-of-lockobject/) para el contexto de threading más amplio dentro del cual se ejecuta tu código de cancelación.

## Enlaces de origen

- [Task Cancellation](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-cancellation), MS Learn.
- [Cancellation in Managed Threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads), MS Learn.
- [Coalesce cancellation tokens from timeouts](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/coalesce-cancellation-tokens-from-timeouts), MS Learn.
- [`CancellationTokenSource.CancelAsync`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelasync), referencia de API.
- [`Task.WaitAsync(CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync), referencia de API.
