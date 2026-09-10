---
title: "SignalR в .NET 11 RC 1 меняет истекающий токен, не разрывая соединение"
description: "API обновления аутентификации SignalR финализированы в .NET 11 RC 1: переименованные обратные вызовы у HubConnection, клиент на TypeScript и цепи Blazor Server, которые автоматически подхватывают обновлённый ClaimsPrincipal."
pubDate: 2026-09-10
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "signalr"
  - "blazor"
lang: "ru"
translationOf: "2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1"
translatedBy: "claude"
translationDate: 2026-09-10
---

Раздел ASP.NET Core в [.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) открывается работой над обновлением аутентификации, которая ведётся начиная с Preview 6: соединение SignalR теперь может заменить истекающий access token на месте, а RC 1 фиксирует форму API сервера и клиента .NET ([dotnet/aspnetcore#68702](https://github.com/dotnet/aspnetcore/pull/68702)). Это тот же релиз, в котором [сигналы POSIX появились у System.Diagnostics.Process](/ru/2026/09/dotnet-11-rc-1-process-signal-exit-status/), и он выходит с лицензией go-live.

## Почему оба прежних варианта были плохими

Раньше хаб с токенами bearer оставлял два пути, и ни один не был хорошим. Если оставить `CloseOnAuthenticationExpiration` в значении по умолчанию, соединение продолжало работать под уже истёкшим `ClaimsPrincipal`, то есть решения авторизации принимались по устаревшим claims. Если выставить `true`, SignalR закрывал соединение ровно в момент истечения токена, а это полное переподключение: `OnConnectedAsync` выполняется заново, членство в группах приходится восстанавливать, и всё, что клиент получал потоком, обрывается.

Для дашборда с 15-минутным токеном это заметный рывок каждые 15 минут без всякой причины, кроме гигиены токенов.

## Включение на стороне сервера

Обновление включается отдельно для каждого хаба, и сервер получает хук, чтобы решить, разрешено ли новому токену занять существующее соединение:

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

Возврат `false` здесь и есть самое важное. Без этой проверки клиент мог бы передать вам действительный токен совершенно другого пользователя и сохранить соединение вместе с его членством в группах от первой личности.

## Сторона клиента и что переименовали

Клиент .NET планирует обновление заранее, до истечения срока, и отдаёт результат как события у `HubConnection`:

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

Если вы уже были на Preview 7, три вещи переехали. `OnAuthenticationRefreshed` и `OnAuthenticationRefreshFailed` больше не обратные вызовы у `AuthenticationRefreshOptions`, это события `HubConnection.AuthenticationRefreshed` и `HubConnection.AuthenticationRefreshFailed` из примера выше. `AuthenticationRefreshContext` переехал из `Microsoft.AspNetCore.Http.Connections` в `Microsoft.AspNetCore.Connections.Features`. А своим транспортам нужен `IConnectionAuthenticationRefreshFeature` вместо `IConnectionUserRefreshFeature`.

Клиент на TypeScript получает ту же форму через `withAuthenticationRefresh({ enableAutoRefresh: true, refreshBeforeExpirationInMilliseconds: 120_000 })` ([dotnet/aspnetcore#67964](https://github.com/dotnet/aspnetcore/pull/67964)).

## Blazor Server получает это бесплатно

Компонентам Interactive Server не нужна никакая настройка ([dotnet/aspnetcore#68221](https://github.com/dotnet/aspnetcore/pull/68221)). Хаб компонентов включает обновление сам, и когда токен заменяется, Blazor обновляет состояние аутентификации и вызывает `AuthenticationStateChanged`, так что `AuthorizeView` и всё остальное, что использует `AuthenticationStateProvider`, перерисовывается уже по новым claims. Это наконец превращает "роль пользователя изменилась посреди сессии" в то, что можно отразить, не разрушая цепь.

Полные подробности есть в [заметках о выпуске ASP.NET Core для RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md).
