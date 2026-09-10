---
title: "SignalR in .NET 11 RC 1 Swaps an Expiring Token Without Dropping the Connection"
description: "The SignalR authentication refresh APIs are finalized in .NET 11 RC 1, with renamed callbacks on HubConnection, a TypeScript client, and Blazor Server circuits that pick up the refreshed ClaimsPrincipal automatically."
pubDate: 2026-09-10
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "signalr"
  - "blazor"
---

The ASP.NET Core section of [.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) leads with the authentication refresh work that has been in flight since Preview 6: a SignalR connection can now replace an expiring access token in place, and RC 1 locks the server and .NET client API shapes ([dotnet/aspnetcore#68702](https://github.com/dotnet/aspnetcore/pull/68702)). This is the same release that [put POSIX signals on System.Diagnostics.Process](/2026/09/dotnet-11-rc-1-process-signal-exit-status/), and it ships under a go-live license.

## Why the old options were both bad

Before this, a hub with bearer tokens gave you two choices, and neither was good. Leave `CloseOnAuthenticationExpiration` at its default and the connection kept running under a `ClaimsPrincipal` that had already expired, so authorization decisions were made against stale claims. Set it to `true` and SignalR closed the connection the moment the token aged out, which meant a full reconnect: `OnConnectedAsync` runs again, group memberships have to be rebuilt, and anything the client was streaming stops.

For a dashboard on a 15 minute token, that is a visible stutter every 15 minutes for no reason other than token hygiene.

## Turning it on server side

Refresh is opt-in per hub, and the server gets a hook to decide whether the new token is allowed to take over the existing connection:

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

Returning `false` there is the important part. Without that check, a client could hand you a valid token for a completely different user and keep the connection, along with its group memberships, from the first identity.

## The client side, and what got renamed

The .NET client schedules a refresh ahead of expiration and exposes the result as events on `HubConnection`:

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

If you were already on Preview 7, three things moved. `OnAuthenticationRefreshed` and `OnAuthenticationRefreshFailed` are no longer callbacks on `AuthenticationRefreshOptions`, they are the `HubConnection.AuthenticationRefreshed` and `HubConnection.AuthenticationRefreshFailed` events above. `AuthenticationRefreshContext` moved from `Microsoft.AspNetCore.Http.Connections` to `Microsoft.AspNetCore.Connections.Features`. And custom transports need `IConnectionAuthenticationRefreshFeature` instead of `IConnectionUserRefreshFeature`.

The TypeScript client gets the same shape through `withAuthenticationRefresh({ enableAutoRefresh: true, refreshBeforeExpirationInMilliseconds: 120_000 })` ([dotnet/aspnetcore#67964](https://github.com/dotnet/aspnetcore/pull/67964)).

## Blazor Server gets it for free

Interactive Server components need no configuration at all ([dotnet/aspnetcore#68221](https://github.com/dotnet/aspnetcore/pull/68221)). The component hub enables refresh itself, and when a token is replaced Blazor updates the authentication state and raises `AuthenticationStateChanged`, so `AuthorizeView` and anything else consuming `AuthenticationStateProvider` re-renders against the new claims. That finally makes "user's role changed mid-session" something you can reflect without tearing down the circuit.

Full details are in the [RC 1 ASP.NET Core release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md).
