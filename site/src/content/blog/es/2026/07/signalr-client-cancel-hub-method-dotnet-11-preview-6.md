---
title: "Los clientes de SignalR por fin pueden cancelar un método de hub en ejecución en .NET 11 Preview 6"
description: "Cancelar el CancellationToken que pasas a InvokeAsync ahora llega al servidor y cancela el método de hub. Esto cierra una solicitud de SignalR abierta desde 2019."
pubDate: 2026-07-24
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
  - "csharp"
lang: "es"
translationOf: "2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-24
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) se lanzó el 2026-07-15, y cierra una de las solicitudes de característica más antiguas de SignalR. El [issue #11542](https://github.com/dotnet/aspnetcore/issues/11542), "Possibility to cancel long running hub method from client," estaba abierto desde 2019. El [PR #64098](https://github.com/dotnet/aspnetcore/pull/64098) por fin lo conectó todo: el `CancellationToken` que pasas a `InvokeAsync` en el cliente .NET ahora realmente llega al servidor y cancela el método de hub.

## El token que antes te mentía

Antes de Preview 6, el cliente .NET de SignalR ya aceptaba un `CancellationToken` en `InvokeAsync`. Solo que no hacía lo que la mayoría suponía. Cancelarlo detenía que el *cliente* esperara un resultado, pero el método de hub en el servidor seguía ejecutándose hasta completarse. No había forma de decirle al servidor "detente, quien llamó se fue." Las invocaciones de streaming sí enviaban un mensaje `CancelInvocation`, pero las invocaciones de solicitud-respuesta normales no.

Ese vacío ya desapareció. Cuando cancelas el token pasado a `InvokeAsync`, el cliente envía un `CancelInvocationMessage` al servidor, que encuentra la invocación correspondiente y la cancela.

## Cómo conectarlo

En el servidor, declara un parámetro `CancellationToken` en el método de hub. SignalR lo rellena como un argumento sintético, así que el cliente nunca lo envía:

```csharp
public class ReportHub : Hub
{
    public async Task<string> BuildReport(int rows, CancellationToken cancellationToken)
    {
        for (var i = 0; i < rows; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(50, cancellationToken); // real work here
        }

        return "done";
    }
}
```

Hasta Preview 6, un parámetro `CancellationToken` en un método de hub que no fuera de streaming se ignoraba: el framework solo sintetizaba uno para los métodos de streaming. Ahora `HubMethodDescriptor` lo permite en todas partes.

En el cliente, pasa un token y cancélalo cuando ya no necesites el resultado:

```csharp
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(2));

try
{
    var result = await connection.InvokeAsync<string>(
        "BuildReport", 100_000, cts.Token);
}
catch (OperationCanceledException)
{
    // The server's token fired too, so the hub method stopped.
}
```

## Qué ocurre por dentro

`DefaultHubDispatcher` registra el `CancellationTokenSource` de cada invocación en `ActiveRequestCancellationSources`, indexado por id de invocación. Cuando llega el `CancelInvocationMessage`, busca esa fuente y llama a `Cancel()`, lo que dispara el token que tu método de hub está observando. Este es el mismo registro que ya usaban las invocaciones de streaming, ahora compartido con las normales.

Dos cosas a tener en cuenta. La cancelación es cooperativa: si tu método de hub nunca revisa el token ni lo reenvía a las llamadas asíncronas que hace, nada se detiene. Y esto es una versión preliminar, así que el comportamiento aún puede cambiar antes de que .NET 11 se lance en noviembre de 2026.

El mismo Preview 6 también [activó la protección CSRF automática](/es/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/), así que es una buena versión para probar. Todos los detalles están en las [notas de la versión de ASP.NET Core Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Si alguna vez construiste un botón de "cancelar" que solo le mentía al usuario, esta es la versión que lo vuelve honesto.
