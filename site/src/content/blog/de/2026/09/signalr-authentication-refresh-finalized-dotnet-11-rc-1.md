---
title: "SignalR in .NET 11 RC 1 tauscht ein ablaufendes Token aus, ohne die Verbindung zu trennen"
description: "Die SignalR-APIs zur Authentifizierungsaktualisierung sind in .NET 11 RC 1 finalisiert, mit umbenannten Callbacks an HubConnection, einem TypeScript-Client und Blazor-Server-Circuits, die den aktualisierten ClaimsPrincipal automatisch übernehmen."
pubDate: 2026-09-10
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "signalr"
  - "blazor"
lang: "de"
translationOf: "2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1"
translatedBy: "claude"
translationDate: 2026-09-10
---

Der ASP.NET-Core-Abschnitt von [.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) beginnt mit der Arbeit an der Authentifizierungsaktualisierung, die seit Preview 6 läuft: Eine SignalR-Verbindung kann ein ablaufendes Access Token nun an Ort und Stelle ersetzen, und RC 1 legt die API-Formen für Server und .NET-Client fest ([dotnet/aspnetcore#68702](https://github.com/dotnet/aspnetcore/pull/68702)). Es ist dasselbe Release, das [POSIX-Signale auf System.Diagnostics.Process gebracht hat](/de/2026/09/dotnet-11-rc-1-process-signal-exit-status/), und es erscheint unter einer Go-Live-Lizenz.

## Warum beide bisherigen Optionen schlecht waren

Bisher gab es für einen Hub mit Bearer Tokens zwei Möglichkeiten, und keine davon war gut. Blieb `CloseOnAuthenticationExpiration` auf dem Standardwert, lief die Verbindung unter einem bereits abgelaufenen `ClaimsPrincipal` weiter, Autorisierungsentscheidungen fielen also auf Basis veralteter Claims. Auf `true` gesetzt schloss SignalR die Verbindung genau dann, wenn das Token ablief, was eine vollständige Neuverbindung bedeutete: `OnConnectedAsync` läuft erneut, Gruppenmitgliedschaften müssen neu aufgebaut werden, und alles, was der Client gerade gestreamt hat, bricht ab.

Für ein Dashboard mit einem 15-Minuten-Token ist das alle 15 Minuten ein sichtbarer Aussetzer, aus keinem anderen Grund als Token-Hygiene.

## Aktivierung auf Serverseite

Die Aktualisierung ist pro Hub opt-in, und der Server erhält einen Hook, um zu entscheiden, ob das neue Token die bestehende Verbindung übernehmen darf:

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

Dort `false` zurückzugeben ist der entscheidende Punkt. Ohne diese Prüfung könnte ein Client Ihnen ein gültiges Token für einen völlig anderen Benutzer übergeben und die Verbindung samt ihrer Gruppenmitgliedschaften aus der ersten Identität behalten.

## Die Clientseite, und was umbenannt wurde

Der .NET-Client plant eine Aktualisierung vor dem Ablauf und stellt das Ergebnis als Ereignisse an `HubConnection` bereit:

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

Wer bereits auf Preview 7 war, findet drei Dinge an anderer Stelle. `OnAuthenticationRefreshed` und `OnAuthenticationRefreshFailed` sind keine Callbacks an `AuthenticationRefreshOptions` mehr, sondern die oben gezeigten Ereignisse `HubConnection.AuthenticationRefreshed` und `HubConnection.AuthenticationRefreshFailed`. `AuthenticationRefreshContext` ist von `Microsoft.AspNetCore.Http.Connections` nach `Microsoft.AspNetCore.Connections.Features` umgezogen. Und eigene Transports benötigen `IConnectionAuthenticationRefreshFeature` statt `IConnectionUserRefreshFeature`.

Der TypeScript-Client bekommt dieselbe Form über `withAuthenticationRefresh({ enableAutoRefresh: true, refreshBeforeExpirationInMilliseconds: 120_000 })` ([dotnet/aspnetcore#67964](https://github.com/dotnet/aspnetcore/pull/67964)).

## Blazor Server bekommt es geschenkt

Interactive-Server-Komponenten benötigen überhaupt keine Konfiguration ([dotnet/aspnetcore#68221](https://github.com/dotnet/aspnetcore/pull/68221)). Der Komponenten-Hub aktiviert die Aktualisierung selbst, und wenn ein Token ersetzt wird, aktualisiert Blazor den Authentifizierungszustand und löst `AuthenticationStateChanged` aus. `AuthorizeView` und alles andere, was `AuthenticationStateProvider` konsumiert, rendert damit gegen die neuen Claims neu. Das macht "die Rolle des Benutzers hat sich mitten in der Sitzung geändert" endlich zu etwas, das sich ohne Abriss des Circuits abbilden lässt.

Alle Details stehen in den [ASP.NET-Core-Release-Notes zu RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md).
