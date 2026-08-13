---
title: "Los circuitos de Blazor Server ahora se pausan solos cuando la pestaña queda inactiva"
description: ".NET 11 Preview 7 agrega un paquete opcional que pausa los circuitos interactivos de Server cuando la pestaña del navegador está oculta, liberando memoria y conexiones SignalR que retienen usuarios que en realidad no están ahí."
pubDate: 2026-08-13
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "signalr"
lang: "es"
translationOf: "2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-13
---

.NET 11 Preview 7 se publicó el 2026-08-11 y, escondida en la sección de ASP.NET Core, viene la solución a uno de los problemas de capacidad más antiguos de Blazor Server: un circuito que nadie está mirando cuesta exactamente lo mismo que un circuito que alguien está usando. Las [notas de la versión de ASP.NET Core Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/aspnetcore.md) presentan la pausa automática, impulsada por [dotnet/aspnetcore#64886](https://github.com/dotnet/aspnetcore/issues/64886).

## Una pestaña oculta no es una pestaña desconectada

Blazor Server mantiene el estado de cada usuario en un circuito en el servidor, y ese circuito vive tanto como la conexión SignalR. Cuando un usuario cambia a otra pestaña y se olvida de la tuya, el WebSocket no se cierra. Los navegadores de escritorio lo mantienen abierto durante horas sin problema. El circuito conserva su árbol de componentes, su ámbito de inyección de dependencias, su cola de renderizado y su lugar en tu presupuesto de concurrencia, todo para un usuario que se fue a la hora del almuerzo.

La pausa automática se engancha en su lugar a la señal de visibilidad del navegador. Cuando la pestaña lleva oculta un tiempo configurable, el cliente le pide al servidor que pause el circuito, lo que lo libera. Cuando el usuario vuelve, el circuito se reanuda.

## Cómo activarla

Es opcional y vive en su propio paquete:

```xml
<PackageReference Include="Microsoft.AspNetCore.Components.Server.AutoPause" />
```

La configuración cuelga del registro del modo de renderizado:

```csharp
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .WithBrowserOptions(options =>
    {
        options.AddAutoPause(pause =>
        {
            pause.Enabled = true; // default
            pause.HiddenDelay = TimeSpan.FromSeconds(30); // default is 2 minutes
        });
    });
```

`HiddenDelay` tiene un valor predeterminado de dos minutos. Bajarlo a 30 segundos recupera memoria más rápido, a costa de más viajes de reanudación por parte de usuarios que van y vienen entre pestañas.

## Los casos en los que se niega a pausar

La ingeniería interesante está en lo que la pausa automática decide no hacer. Aplaza la pausa cuando un campo de texto o un elemento `contenteditable` tiene el foco, cuando hay audio o video sin silenciar reproduciéndose, cuando hay una ventana de Picture-in-Picture abierta, cuando se mantiene un Web Lock y mientras siga habiendo actividad del circuito en vuelo, como una llamada a `IJSRuntime` o una transferencia de flujo. Dicho de otro modo, una pestaña oculta que todavía está haciendo algo en nombre del usuario no se le quita de debajo de los pies.

Puedes agregar tu propia lógica de aplazamiento desde un inicializador de JavaScript:

```javascript
// wwwroot/{ASSEMBLY NAME}.lib.module.js
export function beforeWebStart(options) {
  options.circuit ??= {};
  options.circuit.circuitHandlers ??= [];

  options.circuit.circuitHandlers.push({
    onCircuitPausing: async (signal) => {
      await savePendingWork(signal);
    },
  });
}
```

El `signal` se aborta si la pausa se cancela, por ejemplo porque la pestaña volvió a ser visible mientras tu manejador seguía guardando. Del lado del servidor, `Circuit.RequestCircuitPauseAsync` ahora devuelve `Task<bool>` y acepta un token de cancelación opcional, así que el trabajo de aplazamiento se puede cancelar cuando la conexión se cae.

## Qué revisar antes de habilitarla

La pausa automática se apoya en la maquinaria de pausa y reanudación introducida en .NET 10, lo que significa que la reanudación reconstruye el circuito a partir del estado persistido de los componentes. Todo lo que un componente guarde en un campo común, y nunca declare como persistente, desaparece después de una pausa. Audita tus componentes con estado antes de activar esto en producción, y vigila tu telemetría de reconexión: el modo de falla aquí se parece mucho a [un circuito que se desconectó por su cuenta](/es/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/).

Preview 7 es una versión cargada. La parte de C# recibió [break y continue con etiqueta](/es/2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7/) en la misma entrega.
