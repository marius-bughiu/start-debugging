---
title: "Cómo propagar un CancellationToken a través de métodos async en .NET 11"
description: "Pasa un CancellationToken de forma limpia por cada capa de una cadena de llamadas async en .NET 11: convención del último parámetro, valores por defecto, tokens enlazados, RequestAborted de ASP.NET Core y el analizador CA2016 que detecta los que olvidas."
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "es"
translationOf: "2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-01
---

La cancelación en .NET solo funciona si el token llega al código que hace el bloqueo. Un `CancellationToken` que creas en la cima de una solicitud pero nunca pasas a `HttpClient.GetAsync`, `DbContext.SaveChangesAsync` o una llamada a `Stream.ReadAsync` es peso muerto: la operación externa sigue ejecutándose hasta el final porque nada aguas abajo lo está escuchando. Propagar el token significa pasar ese único parámetro por cada método async que hay entre el lugar donde se solicita la cancelación y el lugar donde el trabajo realmente ocurre. Esta publicación cubre las reglas mecánicas en .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): dónde va el parámetro, cuál debería ser su valor por defecto, cómo combinar tokens, cómo ASP.NET Core te entrega uno gratis y cómo el analizador `CA2016` encuentra las llamadas que olvidaste reenviar. Todos los ejemplos compilan contra .NET 11.

## Por qué un token que no viaja es inútil

La cancelación en .NET es cooperativa. No existe `Task.Kill()`, y el runtime nunca interrumpe un hilo por su cuenta. Un `CancellationToken` es solo una señal que pasa de "no solicitada" a "solicitada" cuando alguien llama a `Cancel()` en el `CancellationTokenSource` propietario. El código reacciona a ese cambio solo si comprueba `token.IsCancellationRequested`, llama a `token.ThrowIfCancellationRequested()`, o entrega el token a una API del framework que hace esas comprobaciones internamente. Si el token nunca llega a la llamada bloqueante, la llamada bloqueante no puede saber que debería detenerse.

Esa es toda la razón por la que la propagación importa. Considera esta cadena:

```csharp
// .NET 11, C# 14 -- broken: the token stops at the top
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync();          // no token -- runs to completion
    var enriched = await EnrichAsync(rows);    // no token -- runs to completion
    return Assemble(enriched);
}
```

Puedes llamar a `Cancel()` todo el día. `LoadRowsAsync` y `EnrichAsync` nunca ven la señal, así que `BuildReportAsync` termina todo su trabajo antes de que el `catch (OperationCanceledException)` en el sitio de llamada tenga siquiera la oportunidad de dispararse. La solución no es código ingenioso, es disciplina: el token tiene que ser un parámetro en cada método del camino, y cada llamada tiene que reenviarlo.

```csharp
// .NET 11, C# 14 -- correct: the token reaches the leaves
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync(ct);
    var enriched = await EnrichAsync(rows, ct);
    return Assemble(enriched);
}
```

## El procedimiento de propagación de extremo a extremo

Esta es la secuencia para pasar un token desde un punto de entrada hasta una llamada de E/S. Cada paso es una regla que aplicas de forma mecánica.

1. **Acepta el token como último parámetro.** Da a cada método async de la cadena un parámetro `CancellationToken`, y ponlo al final para que se lea de forma consistente en todo tu código y coincida con las propias firmas del framework.
2. **Nómbralo de forma consistente.** Usa `cancellationToken` en las APIs públicas de biblioteca (es la convención de la BCL) o `ct` en el código interno de la aplicación. Elige uno y quédate con él para que el reenvío sea localizable con grep.
3. **Reenvíalo a cada llamada esperada que acepte uno.** Si un método que llamas tiene una sobrecarga o parámetro `CancellationToken`, pásale tu token. No pases `CancellationToken.None` "por si acaso": eso hace que la llamada renuncie silenciosamente a la cancelación.
4. **Dale un valor por defecto solo en verdaderos puntos de entrada.** Los métodos orientados a biblioteca usan `CancellationToken cancellationToken = default` para que quienes no lo necesiten puedan omitirlo. Los métodos internos que siempre tienen un token no deberían asignarle un valor por defecto, para que un argumento ausente sea un recordatorio en tiempo de compilación.
5. **Combina tokens cuando añadas tu propio plazo.** Si un método necesita su propio tiempo de espera además del token del llamador, enlázalos con `CancellationTokenSource.CreateLinkedTokenSource` en lugar de elegir uno y descartar el otro.
6. **Activa `CA2016`.** Deja que el analizador marque las llamadas que se te escaparon en los pasos 3 a 5.

El resto de esta publicación amplía las partes de esa lista que tienen matices reales.

## Dónde va el parámetro y cómo llamarlo

La convención en toda la BCL es: `CancellationToken` es el **último** parámetro, y se llama `cancellationToken`. Mira cualquier API async moderna y verás la forma:

```csharp
// From the BCL, for reference
Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken);
Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
Task<HttpResponseMessage> GetAsync(string requestUri, CancellationToken cancellationToken);
```

Replica eso en tu propio código. Dos razones por las que esto no es solo cosmético:

- **El analizador `CA2016` se basa en la posición del último parámetro.** Observa un método que toma un `CancellationToken` como último parámetro y luego comprueba si las llamadas internas lo reenvían. Pon el token en el medio y debilitas las herramientas que se supone que detectan tus errores.
- **Los parámetros opcionales deben ir al final de todos modos.** Cuando asignas un valor por defecto al token (`= default`), C# lo obliga a situarse después de todos los parámetros no opcionales, así que la regla del último parámetro surge gratis de las reglas del lenguaje.

Para el nombre, la división es: `cancellationToken` para todo lo público o con forma de biblioteca (gana la consistencia con la BCL); `ct` es aceptable y común en el código interno de la aplicación, donde la brevedad ayuda a la legibilidad de cadenas de llamadas largas. Lo importante es que sea un solo nombre, para que quien lea un método vea al instante si el token se está reenviando o descartando.

## `default`, `CancellationToken.None` y cuándo asignar un valor por defecto

`default(CancellationToken)` y `CancellationToken.None` son el mismo valor: un token que nunca puede cancelarse. `IsCancellationRequested` siempre es `false` y `CanBeCanceled` es `false`. Difieren solo en la señal de intención, y el lenguaje te da `= default` como la forma idiomática de parámetro opcional:

```csharp
// .NET 11, C# 14
public async Task<User> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    return await _db.Users.FindAsync([id], cancellationToken)
        ?? throw new KeyNotFoundException();
}
```

La decisión que hace tropezar a la gente es **si asignar o no un valor por defecto al parámetro**. La regla que te mantiene honesto:

- **Métodos públicos / de biblioteca: asígnale un valor por defecto.** Los llamadores que genuinamente no tienen un token (un `Main` de consola de nivel superior, un camino de dispara-y-olvida) pueden omitirlo, y el método sigue compilando. Por eso cada método async de la BCL asigna un valor por defecto al token.
- **Métodos internos que siempre se ejecutan bajo un token: no le asignes un valor por defecto.** Si `BuildReportAsync` solo se llama desde un manejador de solicitudes que tiene un token, dejar el parámetro sin valor por defecto significa que el compilador protesta en el momento en que alguien lo llama sin reenviar un token. Ese error de compilación es una característica. Asignarle un valor por defecto ahí dejaría pasar un token descartado como un silencioso `CancellationToken.None`.

El antipatrón a evitar es recurrir a `CancellationToken.None` dentro de un método que ya tiene un token real en su alcance. Eso no es "seguro", es una fuga de cancelación disfrazada de precaución.

```csharp
// .NET 11, C# 14 -- wrong: leaks cancellation on purpose
public async Task ProcessAsync(CancellationToken ct)
{
    // ct is right there, and we throw it away
    await _client.PostAsync(url, content, CancellationToken.None);
}
```

El único uso legítimo de `CancellationToken.None` es una llamada que deliberadamente quieres que se ejecute hasta el final incluso si la operación externa se cancela, por ejemplo, escribir un registro de auditoría final o liberar un recurso. Haz esa intención obvia con un comentario, porque de lo contrario un revisor lo leerá como un error.

## Combinar el token del llamador con tu propio tiempo de espera

Una situación real común: un método recibe el `CancellationToken` del llamador, pero también necesita su propio tiempo de espera ("ríndete con esta llamada aguas abajo después de 5 segundos"). No elijas uno e ignores el otro. Enlázalos para que la cancelación desde **cualquiera** de las fuentes detenga el trabajo. `CancellationTokenSource.CreateLinkedTokenSource` produce una fuente cuyo token se dispara cuando se dispara cualquiera de sus tokens padre:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithTimeoutAsync(
    string url,
    CancellationToken cancellationToken)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        cancellationToken, timeoutCts.Token);

    try
    {
        return await _client.GetStringAsync(url, linkedCts.Token);
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested
                                             && !cancellationToken.IsCancellationRequested)
    {
        // Distinguish "we timed out" from "the caller cancelled us"
        throw new TimeoutException($"GET {url} exceeded 5s");
    }
}
```

Dos detalles hacen que esto sea correcto:

- **Libera la fuente enlazada.** `CreateLinkedTokenSource` registra callbacks en sus padres; no liberarla filtra esos registros durante toda la vida del token padre más longevo. El `using` se encarga de ello.
- **El filtro `when` separa las dos causas de cancelación.** Cuando el token se dispara obtienes una `OperationCanceledException` de cualquier forma. Comprobar `timeoutCts.IsCancellationRequested` contra `cancellationToken.IsCancellationRequested` te dice cuál fuente se disparó, de modo que una cancelación iniciada por el llamador se propaga tal cual, mientras que un tiempo de espera aflora como una `TimeoutException`. Esta es la misma disciplina que necesitas al [cancelar una Task de larga duración sin provocar interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Si solo necesitas un tiempo de espera y no hay token entrante, `CancelAfter` en una sola fuente es más simple que una enlazada. Recurre al enlace específicamente cuando un token del llamador y un plazo local tengan ambos que imponerse.

## ASP.NET Core te entrega un token: úsalo

En una aplicación web rara vez creas tú mismo el token de la cima de la cadena. ASP.NET Core expone `HttpContext.RequestAborted`, un `CancellationToken` que se dispara cuando el cliente se desconecta o el servidor aborta la solicitud. Tanto las minimal APIs como los controladores MVC lo enlazan automáticamente: declara un parámetro `CancellationToken` y el framework lo rellena desde `RequestAborted`.

```csharp
// .NET 11, C# 14 -- minimal API
app.MapGet("/reports/{id}", async (
    int id,
    ReportService reports,
    CancellationToken cancellationToken) =>
{
    var report = await reports.BuildAsync(id, cancellationToken);
    return Results.Ok(report);
});
```

```csharp
// .NET 11, C# 14 -- MVC controller
[HttpGet("reports/{id}")]
public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
{
    var report = await _reports.BuildAsync(id, cancellationToken);
    return Ok(report);
}
```

Ese token inyectado es el punto de entrada para toda la cadena de propagación. Reenvíalo a `BuildAsync`, que lo reenvía a sus consultas de EF Core y sus llamadas de `HttpClient`, y un cliente que cierra la pestaña del navegador ahora detiene todo ese trabajo aguas abajo en lugar de pagar por una consulta que nadie leerá. El comportamiento a esperar: cuando `RequestAborted` se dispara a mitad de la solicitud, tus awaits lanzan `OperationCanceledException` (o su subclase `TaskCanceledException`), que el framework trata como una solicitud cancelada en lugar de un 500. Si ves esa excepción en los registros de `HttpClient`, a menudo es exactamente esto funcionando como se pretende; consulta [por qué una TaskCanceledException aflora desde HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para la distinción entre tiempo de espera y cancelación.

Una advertencia específica del trabajo en segundo plano: `RequestAborted` está limitado a la solicitud. Si un manejador de solicitudes lanza trabajo que debería sobrevivir a la respuesta, no le des `RequestAborted`: se cancelará en el instante en que la respuesta se complete. Ese trabajo pertenece a un servicio alojado con su propio ciclo de vida, que es el patrón detrás de [ejecutar trabajo dispara-y-olvida de forma segura con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Propagar a través de streaming e `IAsyncEnumerable<T>`

Los flujos async necesitan que el token se conecte a través del iterador, y el mecanismo es ligeramente distinto porque es el consumidor, no el productor, quien suministra el token en el momento de la enumeración. El productor marca el parámetro con `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
public async IAsyncEnumerable<Row> ReadRowsAsync(
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    await using var reader = await _source.OpenAsync(cancellationToken);
    while (await reader.ReadAsync(cancellationToken))
    {
        yield return reader.Current;
    }
}
```

El consumidor adjunta un token con `WithCancellation`, y el compilador lo enruta hacia el parámetro `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
await foreach (var row in ReadRowsAsync().WithCancellation(cancellationToken))
{
    Process(row);
}
```

Sin `[EnumeratorCancellation]`, el token de `WithCancellation` se ignora silenciosamente y la enumeración no puede cancelarse: una ruptura sutil de la propagación que el analizador `CA2016` no siempre detecta. Si eres nuevo con los flujos async, el resumen de [cuándo recurrir a IAsyncEnumerable](/es/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) cubre el panorama más amplio.

## Deja que `CA2016` detecte los que descartas

Pasar un token a mano por una cadena de llamadas profunda es exactamente el tipo de tarea en la que te saltarás una llamada. El analizador `CA2016` ("Reenvía el parámetro CancellationToken a los métodos que toman uno") está hecho para esto: inspecciona un método que tiene un `CancellationToken` como último parámetro, luego marca cualquier llamada interna que podría aceptar el token, directamente o mediante una sobrecarga, pero no lo hace. Conviértelo en un error de compilación para que un token descartado falle en la CI en vez de enviarse:

```xml
<!-- .editorconfig -- .NET 11 -->
[*.cs]
dotnet_diagnostic.CA2016.severity = error
```

`CA2016` viene con los analizadores del SDK de .NET, que están activados por defecto para los proyectos que apuntan a .NET 11, así que solo necesitas elevar la severidad. Viene con una corrección de código, así que en Visual Studio o con `dotnet format analyzers` puedes reenviar automáticamente el token en todo un archivo. Lo que no hará es inventar un token donde el método contenedor no tiene ninguno: ese es el caso para hacer el parámetro no opcional en los métodos internos, de modo que el compilador te obligue a añadirlo.

Una nota sobre los puntos ciegos de `CA2016`: se basa en la convención del último parámetro y en la presencia de una sobrecarga coincidente. No marcará una llamada que toma el token en una posición que no sea la última, y no razona sobre el enrutamiento de `[EnumeratorCancellation]`. Trátalo como una red fuerte para el caso común, no como una prueba de que cada camino está cubierto.

## Los errores de propagación que impiden que los tokens funcionen

Algunos patrones rompen la propagación incluso cuando el token está técnicamente presente:

- **Fuente nueva por llamada.** Crear `new CancellationTokenSource()` dentro de un método y pasar *su* token ignora por completo el token del llamador. Enlaza, no reemplaces.
- **`async void`.** Un token no puede propagarse fuera de un método `async void` porque no hay `Task` que un llamador pueda esperar u observar la `OperationCanceledException`. Mantén los caminos de cancelación en `async Task`: las razones se solapan mucho con [por qué async void casi siempre es incorrecto](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).
- **Tragarse la `OperationCanceledException`.** Capturarla y devolver un valor por defecto oculta la cancelación a los llamadores, de modo que un `Task.WhenAll` externo o un await nunca se entera de que la operación se detuvo. Deja que suba a menos que tengas una razón específica para traducirla (como el caso del tiempo de espera de arriba).
- **Olvidar la hoja síncrona.** Un bucle apretado de CPU en el fondo de una cadena async no tiene ninguna API esperada a la que entregar el token. Añade un explícito `cancellationToken.ThrowIfCancellationRequested()` dentro del bucle para que el token siga teniendo un punto de control.

La propagación no es una característica que activas; es una propiedad que mantienes. Cada nuevo método async es un eslabón más que o reenvía el token o corta silenciosamente la cadena. Añade el parámetro, reenvíalo en cada llamada, deja que `CA2016` proteja las llamadas que olvidas, y reserva `CancellationToken.None` para la rara operación que de verdad quieres que termine pase lo que pase.

## Fuentes

- [CA2016: Forward the CancellationToken parameter to methods that take one](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016) -- Microsoft Learn
- [HttpContext.RequestAborted Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpcontext.requestaborted) -- Microsoft Learn
- [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) -- Microsoft Learn
- [CancellationTokenSource.CreateLinkedTokenSource](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.createlinkedtokensource) -- Microsoft Learn
- [EnumeratorCancellationAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute) -- Microsoft Learn
</content>
</invoke>
