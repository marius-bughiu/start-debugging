---
title: "Solución: Attempting to reconnect to the server tras desconectarse un circuito de Blazor Server"
description: "El modal de reconexión significa que el circuito de SignalR se cayó, no que tu aplicación falló. Averigua si el reintento terminó en failed o en rejected y arregla la afinidad de sesión, la ventana de retención de 3 minutos, el límite de 32 KB o persiste el estado con [PersistentState]."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
lang: "es"
translationOf: "2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects"
translatedBy: "claude"
translationDate: 2026-08-06
---

El modal no es un error, es Blazor avisándote de que el circuito de SignalR se cayó y el cliente está reintentando. Lo que importa es cómo termina el reintento. Si termina en `failed` ("Reconnection failed", "Failed to rejoin"), el navegador nunca llegó al servidor: revisa la ruta del WebSocket a través de tu proxy, los tiempos de keep-alive y el límite de 32 KB de `MaximumReceiveMessageSize`. Si termina en `rejected` ("Could not reconnect to the server", "Failed to resume the session"), sí se llegó al servidor y este rechazó la conexión: el circuito ya no existe porque la aplicación se reinició, porque el balanceador te mandó a otra instancia sin afinidad de sesión, o porque venció el `DisconnectedCircuitRetentionPeriod` de 3 minutos. En .NET 10 y .NET 11, la respuesta duradera para ese último grupo es dejar de preocuparte por la identidad del circuito y marcar tu estado con `[PersistentState]`.

```text
Attempting to reconnect to the server: 3 of 8
Reconnection failed. Try reloading the page if you're unable to reconnect.
Could not reconnect to the server. Reload the page to restore functionality.
```

Esos son los textos de .NET 8 y anteriores, y son los que la mayoría pega en el buscador. En .NET 9 y posteriores los mismos estados tienen otra redacción, y por eso los resultados de búsqueda parecen hablar de otro problema:

```text
Rejoining the server...
Rejoin failed... trying again in 5 seconds.
Failed to rejoin. Please retry or reload the page.
The session has been paused by the server.
Failed to resume the session. Please retry or reload the page.
```

Todo lo que sigue está verificado contra .NET 11 Preview 6 (SDK `11.0.100-preview.6.26359.118`) con la plantilla Blazor Web App en renderizado Interactive Server, y señala dónde se comportan distinto .NET 8, 9 y 10. Blazor WebAssembly no tiene circuito, así que si ves este modal tus componentes se están renderizando con `InteractiveServer` o con `InteractiveAuto` resuelto por ahora al servidor.

## Por qué un WebSocket caído produce un modal y no una excepción

Una aplicación Blazor de servidor mantiene el árbol de componentes, cada campo de cada instancia de componente y cada servicio de DI con ámbito de circuito en la memoria del servidor. Ese conjunto es el circuito. El navegador solo guarda un DOM renderizado y una conexión SignalR; cada clic es una llamada remota al servidor y cada render es un diff que vuelve. Si se rompe la conexión, el navegador no tiene con qué renderizar, así que el framework cubre la página e intenta volver a engancharse al mismo circuito por su ID.

Nadie tiene que escribir esa interfaz. Si tu aplicación define un elemento con `id="components-reconnect-modal"`, Blazor le aplica y le quita clases CSS. Si no existe, Blazor inyecta su propio modal integrado, y de ahí sale el texto clásico. Esa es la parte importante para depurar: el mensaje que ves se genera por completo en el cliente, a partir de estado del cliente. No te dice nada sobre lo que el servidor cree que pasó. La versión del servidor está en tus registros.

## Los tres estados finales, y cuál tienes en realidad

Desde .NET 10 el framework lanza un evento `components-reconnect-state-changed` sobre el elemento del modal y aplica la clase CSS correspondiente, así que puedes leer el resultado en vez de adivinarlo:

| Clase CSS | `detail.state` del evento | Significado |
| --- | --- | --- |
| `components-reconnect-show` | `show` | Conexión perdida, reintentando. |
| `components-reconnect-retrying` | `retrying` | Hay un intento de reconexión en curso. |
| `components-reconnect-paused` | `paused` | El circuito se pausó (por el cliente o por el servidor). |
| `components-reconnect-hide` | `hide` | Reconectado. No se perdió nada. |
| `components-reconnect-failed` | `failed` | Nunca se llegó al servidor. Llama a `Blazor.reconnect()`. |
| `components-reconnect-rejected` | `rejected` | Se llegó al servidor y rechazó la conexión. Llama a `location.reload()`. |

En .NET 9 y anteriores solo tienes las clases CSS, sin evento. En cualquier caso, `failed` y `rejected` son la bifurcación del diagnóstico, y casi no comparten causas. Registra cuál te toca antes de cambiar cualquier configuración:

```javascript
// .NET 10 or .NET 11, wwwroot or a collocated ReconnectModal.razor.js
const modal = document.getElementById("components-reconnect-modal");
modal.addEventListener("components-reconnect-state-changed", e => {
  console.log("[circuit]", e.detail.state, new Date().toISOString());
});
```

## La reproducción mínima

No necesitas una aplicación rota para verlo. Basta con cualquier componente Interactive Server y un proceso terminado:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();
app.Run();
```

Ejecútala, abre la página del contador, haz unos clics y detén el proceso con Ctrl+C. El modal aparece en algo así como medio segundo. Vuelve a iniciar el proceso y observa qué pasa: la conexión se establece, pero el ID del circuito es desconocido para el proceso nuevo, así que obtienes `rejected` y no `hide`, y tu contador vuelve a cero. Compáralo con desconectar la red (DevTools, Network, Offline): los reintentos no llegan a ninguna parte, obtienes `failed`, y al restaurar la red un reintento aterriza en el circuito original con el contador intacto, siempre que estés dentro de la ventana de retención.

Esa diferencia es todo el diagnóstico en miniatura. `failed` es un problema de transporte. `rejected` es un problema de tiempo de vida.

## Arreglo 1: afinidad de sesión, si tienes más de una instancia

Esta es la causa número uno en producción y produce `rejected` en prácticamente cada reconexión. El circuito vive en la memoria de un proceso. Una reconexión que aterriza en otra instancia no encuentra el ID del circuito y la rechaza. Dos servidores detrás de un balanceador round-robin significa que alrededor de la mitad de las reconexiones fallan de forma permanente, y parece intermitente, que es justo por lo que sobrevive a las pruebas.

Activa la afinidad de sesión (sticky sessions) en el balanceador: afinidad ARR en Azure App Service, `sessionAffinity` en tu ingress, `ip_hash` o una cookie sticky en nginx. El síntoma asociado que puedes buscar en tus registros es `Invocation canceled due to the underlying connection being closed`. Si no puedes usar afinidad, tampoco puedes mantener circuitos en memoria entre instancias, y lo que quieres es la persistencia distribuida del Arreglo 5.

## Arreglo 2: alinea el calendario de reintentos con la ventana de retención

El servidor conserva un circuito desconectado durante `DisconnectedCircuitRetentionPeriod`, 3 minutos por defecto, y guarda como mucho `DisconnectedCircuitMaxRetained` de ellos, 100 por defecto. Pasado eso el circuito se libera y cualquier reconexión posterior es `rejected` por definición.

El calendario del cliente cambió en .NET 9 y ahora sobrevive habitualmente a esa ventana:

- **.NET 8 y anteriores**: `maxRetries: 8`, `retryIntervalMilliseconds: 20000`. Intervalo fijo de 20 segundos, así que el cliente se rinde a los 160 segundos aproximadamente, justo dentro de los 3 minutos del servidor.
- **.NET 9, .NET 10, .NET 11**: `maxRetries: 30` con un backoff calculado. Los primeros 10 intentos se disparan tan rápido como permita el handshake, los intentos 11 a 20 van separados 5 segundos, y todo lo posterior va cada 30 segundos. Eso son unos 350 segundos reintentando contra un circuito que el servidor eliminó a los 180.

Así que en .NET 9 y posteriores, quien se ausenta 4 minutos recibe un modal que sigue con la cuenta atrás y después rechaza. Es el comportamiento previsto, pero es una mala experiencia, y vale la pena hacer que los dos números concuerden. O amplías el servidor:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        options.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(6);
        options.DisconnectedCircuitMaxRetained = 100;
        options.JSInteropDefaultCallTimeout = TimeSpan.FromSeconds(30);
    });
```

o acortas el cliente para que falle rápido y recargue en vez de disimular:

```html
<!-- .NET 10 or .NET 11, App.razor. Requires autostart="false" on the Blazor script. -->
<script src="_framework/blazor.web.js" autostart="false"></script>
<script>
  Blazor.start({
    circuit: {
      reconnectionOptions: {
        maxRetries: 8,
        retryIntervalMilliseconds:
          Array.prototype.at.bind([0, 0, 1000, 2000, 5000, 10000, 15000, 30000])
      }
    }
  });
</script>
```

Devolver `null` o `undefined` desde `retryIntervalMilliseconds` detiene los reintentos, que es lo que hace `Array.prototype.at` en cuanto te sales del final del arreglo. Ten en cuenta el costo de memoria antes de subir el número del servidor: cada circuito retenido es un árbol de componentes vivo más sus servicios con ámbito, y 100 de ellos es una cifra real en una aplicación con carga.

## Arreglo 3: el límite de 32 KB, cuando el modal se repite sin fin

Si el modal aparece una y otra vez durante el uso normal, sobre todo justo después de subir un archivo, enviar un formulario grande o pasar una carga útil grande por interoperabilidad con JS, casi seguro estás chocando con `HubOptions.MaximumReceiveMessageSize`, que por defecto son 32 KB. Superarlo cierra el circuito con error, el cliente reconecta, el usuario repite la acción y vuelve a cerrarse.

La consola del navegador muestra un cierre genérico:

```text
Error: Connection disconnected with error 'Error: Server returned an error on close: Connection closed with an error.'
```

El mensaje real solo aparece con el registro de `Microsoft.AspNetCore.SignalR` en Debug o Trace:

```text
System.IO.InvalidDataException: The maximum message size of 32768B was exceeded.
```

Subir el tope funciona y te cuesta margen frente a ataques de denegación de servicio:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 64 * 1024;
    });
```

El mejor arreglo para cualquier cosa realmente grande es la interoperabilidad con JS por streaming, que trocea por debajo del límite en vez de subirlo. Deja `MaximumParallelInvocationsPerClient` en su valor por defecto de `1`: Blazor depende de ello y subirlo rompe las subidas con `InputFile`.

Hay una segunda variante del mismo problema que ocurre en la primera carga y no al interactuar. Si el estado prerenderizado enviado por `PersistentComponentState` supera el límite, el circuito nunca arranca y el registro dice `Circuit host not initialized`. Persiste menos, o sube el tope.

## Arreglo 4: tiempos de espera y proxies que matan WebSockets inactivos

Un `failed` que solo ocurre tras un rato de inactividad, en móvil o detrás de un proxy inverso es un tiempo de espera de transporte. Tres números tienen que concordar:

```csharp
// .NET 11 preview 6. Program.cs. These are the framework defaults, stated explicitly.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    });
```

La regla es que el tiempo de espera del servidor debe ser al menos el doble del intervalo de keep-alive. Si subes uno, sube el otro. Después asegúrate de que tu infraestructura tolere una conexión inactiva entre keep-alives: `proxy_read_timeout` en nginx, el tiempo de espera de WebSocket inactivo en Application Gateway, y `webSocket enabled="true"` más un `pingInterval` razonable en IIS. Un proxy que cierra a los 20 segundos producirá un modal de reconexión cada 20 segundos para siempre, y ninguna configuración de Blazor lo va a arreglar.

Los navegadores móviles y las pestañas en segundo plano son la otra mitad de esto. Una pestaña estrangulada deja de ejecutar temporizadores, el keep-alive se detiene y el servidor descarta el circuito. .NET 9 y posteriores reconectan de inmediato cuando la pestaña vuelve a ser visible en vez de esperar al siguiente reintento programado, y el `ReconnectModal.razor.js` de la plantilla de .NET 10 también reintenta en `visibilitychange` tras un fallo, así que actualizar es un arreglo de verdad para el reporte de "volví a mi pestaña y todo había desaparecido".

## Arreglo 5: en .NET 10 y 11, persiste el estado y deja de pelear con el circuito

Todo lo anterior intenta mantener vivo un circuito. .NET 10 añadió la opción de renunciar a eso y conservar el estado en su lugar. Marca propiedades de componentes o de servicios con ámbito usando `[PersistentState]`, y Blazor las serializa cuando el circuito se desaloja y luego las rehidrata en el circuito nuevo cuando la misma pestaña se reconecta:

```razor
@* .NET 10 or .NET 11, Counter.razor *@
@page "/counter"
@rendermode InteractiveServer

<p role="status">Current count: @CurrentCount</p>
<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int CurrentCount { get; set; }

    private void IncrementCount() => CurrentCount++;
}
```

Esto está activado por defecto cuando se llama a `AddInteractiveServerComponents`. El proveedor en memoria guarda hasta 1 000 circuitos persistidos durante dos horas, ambos configurables:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.Configure<CircuitOptions>(options =>
{
    options.PersistedCircuitInMemoryMaxRetained = 2_000;
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(3);
});
```

Para varias instancias, asigna un `HybridCache` y el estado persistido pasa a ser distribuido, con su propio `PersistedCircuitDistributedRetentionPeriod` de ocho horas por defecto. Esa es la salida de emergencia cuando no hay afinidad de sesión disponible:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddHybridCache()
    .AddRedis("{CONNECTION STRING}");

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
```

Restricciones que conviene conocer antes de confiar en esto: solo funciona con renderizado Interactive Server, el estado debe ser serializable a JSON (las entidades de EF Core con ciclos no van a sobrevivir), una recarga completa de página lo descarta, y no hay garantía de recuperación, así que la aplicación vuelve a la experiencia normal de desconexión si la persistencia falla. Usa `@key` cuando renderices componentes persistidos en un bucle.

La misma maquinaria alimenta la pausa. `Blazor.pauseCircuit()` y `Blazor.resumeCircuit()` te permiten soltar el circuito de una pestaña oculta y reconstruirlo al volver, y .NET 11 añade el lado del servidor con `Circuit.RequestCircuitPauseAsync(CancellationToken)`, de modo que una implementación puede pedir a los clientes conectados que pausen y persistan antes de que el proceso se detenga, en lugar de entregarle a cada usuario una reconexión rechazada. Los clientes pueden aplazarlo con el callback `onPauseRequested` en `Blazor.start`.

## Trampas que llevan al arreglo equivocado

- **El modal de reconexión no es `blazor-error-ui`.** La barra amarilla que dice "An unhandled error has occurred" es una excepción de un componente, que también derriba el circuito. Si ves ambas, arregla primero la excepción: toda excepción no controlada en un componente termina el circuito, y la reconexión que sigue siempre es `rejected`.
- **Solo el primer elemento coincidente recibe las clases.** Si un layout y una página renderizan cada uno un elemento con `id="components-reconnect-modal"`, Blazor solo alterna el primero que encuentra, y el segundo parece roto.
- **El retraso de 500 ms es deliberado.** Blazor espera alrededor de medio segundo antes de mostrar el modal para que un corte transitorio no haga parpadear la interfaz. Alárgalo con CSS, `transition: visibility 0s linear 1000ms`, y no con JavaScript.
- **`Reconnection failed` y `Could not reconnect` son estados distintos.** El primero debe llamar a `Blazor.reconnect()`, el segundo tiene que llamar a `location.reload()`. Conectar ambos al mismo controlador produce o un bucle infinito de reintentos o una recarga que tira estado recuperable.
- **Que `_blazor` devuelva 404 o 400 no es este problema.** Eso es el endpoint del hub sin mapear o un proxy quitando las cabeceras de upgrade, y ninguna reconexión funcionará jamás.
- **El caso de la pestaña aparcada ahora sí se puede resolver actualizando.** Reconectar una pestaña de dos horas nunca fue posible solo con circuitos en memoria. En .NET 10 y posteriores sí lo es, con `[PersistentState]`.

## Relacionado

- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cubre el compromiso de modelo de hospedaje que te pone sobre circuitos en primer lugar.
- [Cómo persistir estado a través de la frontera de renderizado estático a interactivo de Blazor en .NET 11](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) es el tratamiento completo de `[PersistentState]` y `PersistentComponentState`.
- [Cómo usar HybridCache en ASP.NET Core 11 con Redis como caché L2](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) monta la caché distribuida que respalda la persistencia de circuitos entre instancias.
- [Solución: JavaScript interop calls cannot be issued at this time (prerenderizado de Blazor)](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) es el otro error de Blazor que nace de malinterpretar en qué pasada de renderizado estás.
- [Migrar una aplicación Blazor Server a Blazor United (Blazor Web App) en .NET 11](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) es el camino hacia la plantilla que trae el componente `ReconnectModal` personalizable.

## Fuentes

- Microsoft Learn, [ASP.NET Core Blazor SignalR guidance](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/signalr?view=aspnetcore-11.0) (clases CSS de reconexión, la tabla del evento `components-reconnect-state-changed`, `MaximumReceiveMessageSize`, tiempos de espera del hub, afinidad de sesión).
- Microsoft Learn, [ASP.NET Core Blazor server-side state management](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/server?view=aspnetcore-11.0) (valores por defecto de la persistencia de estado de circuito, `PersistedCircuitInMemoryRetentionPeriod`, pausa y reanudación, `Circuit.RequestCircuitPauseAsync`).
- Microsoft Learn, [CircuitOptions.DisconnectedCircuitRetentionPeriod](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.server.circuitoptions.disconnectedcircuitretentionperiod) (el valor por defecto de 3 minutos).
- dotnet/aspnetcore, [`CircuitStartOptions.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/CircuitStartOptions.ts) (el `maxRetries` de 30 y los tramos de 0 ms / 5 s / 30 s de `computeDefaultRetryInterval`; la rama de .NET 8 tiene `maxRetries: 8` y `retryIntervalMilliseconds: 20000`).
- dotnet/aspnetcore, [`DefaultReconnectDisplay.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/DefaultReconnectDisplay.ts) (los textos exactos del modal en cada estado, tanto en la rama de .NET 8 como en la actual).
- dotnet/aspnetcore, [`ReconnectModal.razor.js` en la plantilla Blazor Web App](https://github.com/dotnet/aspnetcore/blob/main/src/ProjectTemplates/Web.ProjectTemplates/content/BlazorWeb-CSharp/BlazorWebCSharp.1/Components/Layout/ReconnectModal.razor.js) (la secuencia `Blazor.reconnect()`, luego `Blazor.resumeCircuit()`, luego `location.reload()`, y el reintento en `visibilitychange`).
