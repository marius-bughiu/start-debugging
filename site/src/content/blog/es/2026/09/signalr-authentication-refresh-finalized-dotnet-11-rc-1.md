---
title: "SignalR en .NET 11 RC 1 cambia un token por vencer sin cerrar la conexión"
description: "Las APIs de actualización de autenticación de SignalR quedan finalizadas en .NET 11 RC 1, con callbacks renombrados en HubConnection, un cliente TypeScript y circuitos de Blazor Server que toman el ClaimsPrincipal actualizado de forma automática."
pubDate: 2026-09-10
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "signalr"
  - "blazor"
lang: "es"
translationOf: "2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1"
translatedBy: "claude"
translationDate: 2026-09-10
---

La sección de ASP.NET Core de [.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) abre con el trabajo de actualización de autenticación que viene en curso desde la Preview 6: una conexión de SignalR ya puede reemplazar un token de acceso por vencer en el mismo lugar, y RC 1 fija las formas de las APIs del servidor y del cliente .NET ([dotnet/aspnetcore#68702](https://github.com/dotnet/aspnetcore/pull/68702)). Es la misma versión que [puso las señales POSIX en System.Diagnostics.Process](/es/2026/09/dotnet-11-rc-1-process-signal-exit-status/), y se publica bajo licencia go-live.

## Por qué las opciones anteriores eran malas las dos

Antes de esto, un hub con tokens bearer te dejaba dos caminos, y ninguno era bueno. Si dejabas `CloseOnAuthenticationExpiration` en su valor predeterminado, la conexión seguía corriendo bajo un `ClaimsPrincipal` que ya había vencido, así que las decisiones de autorización se tomaban contra claims obsoletos. Si lo ponías en `true`, SignalR cerraba la conexión en cuanto el token vencía, lo que significaba una reconexión completa: `OnConnectedAsync` se ejecuta de nuevo, hay que reconstruir las membresías de grupo y se detiene cualquier cosa que el cliente estuviera transmitiendo.

Para un dashboard con un token de 15 minutos, eso es un salto visible cada 15 minutos sin más motivo que la higiene del token.

## Activarlo del lado del servidor

La actualización es opt-in por hub, y el servidor recibe un hook para decidir si el nuevo token puede quedarse con la conexión existente:

```csharp
using System.Security.Claims;

app.MapHub<ClockHub>("/clock", options =>
{
    options.EnableAuthenticationRefresh = true;
    options.CloseOnAuthenticationExpiration = true;
    options.OnAuthenticationRefresh = context =>
    {
        var previousSubject = context.PreviousUser.FindFirstValue("sub")
            ?? context.PreviousUser.FindFirstValue(ClaimTypes.NameIdentifier);
        var newSubject = context.NewUser.FindFirstValue("sub")
            ?? context.NewUser.FindFirstValue(ClaimTypes.NameIdentifier);

        return Task.FromResult(
            previousSubject is not null &&
            string.Equals(previousSubject, newSubject, StringComparison.Ordinal));
    };
});
```

Devolver `false` ahí es la parte importante. Sin esa verificación, un cliente podría entregarte un token válido de un usuario completamente distinto y quedarse con la conexión, junto con sus membresías de grupo, de la primera identidad.

## El lado del cliente, y qué se renombró

El cliente .NET programa una actualización antes del vencimiento y expone el resultado como eventos en `HubConnection`:

```csharp
await using var connection = new HubConnectionBuilder()
    .WithUrl(serverUrl, options =>
        options.AccessTokenProvider = GetAccessTokenAsync)
    .WithAuthenticationRefresh(options =>
    {
        options.EnableAutoRefresh = true;
        options.RefreshBeforeExpiration = TimeSpan.FromMinutes(2);
    })
    .Build();

connection.AuthenticationRefreshed += context =>
{
    Console.WriteLine($"New token lifetime: {context.NewTokenLifetime}");
    return Task.CompletedTask;
};

await connection.StartAsync();

// Force a refresh right after acquiring a token with updated claims.
await connection.RefreshAuthenticationAsync();
```

Si ya venías de la Preview 7, se movieron tres cosas. `OnAuthenticationRefreshed` y `OnAuthenticationRefreshFailed` ya no son callbacks en `AuthenticationRefreshOptions`, son los eventos `HubConnection.AuthenticationRefreshed` y `HubConnection.AuthenticationRefreshFailed` de arriba. `AuthenticationRefreshContext` pasó de `Microsoft.AspNetCore.Http.Connections` a `Microsoft.AspNetCore.Connections.Features`. Y los transportes personalizados necesitan `IConnectionAuthenticationRefreshFeature` en lugar de `IConnectionUserRefreshFeature`.

El cliente TypeScript obtiene la misma forma a través de `withAuthenticationRefresh({ enableAutoRefresh: true, refreshBeforeExpirationInMilliseconds: 120_000 })` ([dotnet/aspnetcore#67964](https://github.com/dotnet/aspnetcore/pull/67964)).

## Blazor Server lo recibe gratis

Los componentes Interactive Server no necesitan ninguna configuración ([dotnet/aspnetcore#68221](https://github.com/dotnet/aspnetcore/pull/68221)). El hub de componentes habilita la actualización por su cuenta, y cuando se reemplaza un token Blazor actualiza el estado de autenticación y lanza `AuthenticationStateChanged`, así que `AuthorizeView` y cualquier otra cosa que consuma `AuthenticationStateProvider` se vuelve a renderizar contra los claims nuevos. Eso por fin convierte "el rol del usuario cambió a mitad de sesión" en algo que puedes reflejar sin derribar el circuito.

Los detalles completos están en las [notas de la versión RC 1 de ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md).
