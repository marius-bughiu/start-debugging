---
title: "SignalR no .NET 11 RC 1 troca um token prestes a expirar sem derrubar a conexão"
description: "As APIs de atualização de autenticação do SignalR estão finalizadas no .NET 11 RC 1, com callbacks renomeados em HubConnection, um cliente TypeScript e circuitos do Blazor Server que assumem o ClaimsPrincipal atualizado automaticamente."
pubDate: 2026-09-10
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "signalr"
  - "blazor"
lang: "pt-br"
translationOf: "2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1"
translatedBy: "claude"
translationDate: 2026-09-10
---

A seção de ASP.NET Core do [.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) abre com o trabalho de atualização de autenticação que está em andamento desde o Preview 6: uma conexão do SignalR agora consegue substituir um token de acesso prestes a expirar no lugar, e o RC 1 fixa os formatos das APIs do servidor e do cliente .NET ([dotnet/aspnetcore#68702](https://github.com/dotnet/aspnetcore/pull/68702)). É a mesma versão que [colocou sinais POSIX no System.Diagnostics.Process](/pt-br/2026/09/dotnet-11-rc-1-process-signal-exit-status/), e ela sai com licença go-live.

## Por que as duas opções antigas eram ruins

Antes disso, um hub com tokens bearer te dava duas escolhas, e nenhuma era boa. Deixar `CloseOnAuthenticationExpiration` no valor padrão fazia a conexão continuar rodando sob um `ClaimsPrincipal` que já tinha expirado, então as decisões de autorização eram tomadas com base em claims obsoletos. Colocar em `true` fazia o SignalR fechar a conexão no momento em que o token expirava, o que significava uma reconexão completa: `OnConnectedAsync` roda de novo, as participações em grupos precisam ser reconstruídas e tudo que o cliente estivesse recebendo em streaming para.

Para um dashboard com token de 15 minutos, isso é uma travada visível a cada 15 minutos por nenhum outro motivo além de higiene de token.

## Ligando do lado do servidor

A atualização é opt-in por hub, e o servidor ganha um hook para decidir se o novo token pode assumir a conexão existente:

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

Retornar `false` ali é a parte importante. Sem essa verificação, um cliente poderia te entregar um token válido de um usuário completamente diferente e manter a conexão, junto com as participações em grupos, da primeira identidade.

## O lado do cliente, e o que foi renomeado

O cliente .NET agenda uma atualização antes da expiração e expõe o resultado como eventos em `HubConnection`:

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

Se você já estava no Preview 7, três coisas mudaram de lugar. `OnAuthenticationRefreshed` e `OnAuthenticationRefreshFailed` não são mais callbacks em `AuthenticationRefreshOptions`, são os eventos `HubConnection.AuthenticationRefreshed` e `HubConnection.AuthenticationRefreshFailed` acima. `AuthenticationRefreshContext` saiu de `Microsoft.AspNetCore.Http.Connections` para `Microsoft.AspNetCore.Connections.Features`. E transportes personalizados precisam de `IConnectionAuthenticationRefreshFeature` no lugar de `IConnectionUserRefreshFeature`.

O cliente TypeScript recebe o mesmo formato via `withAuthenticationRefresh({ enableAutoRefresh: true, refreshBeforeExpirationInMilliseconds: 120_000 })` ([dotnet/aspnetcore#67964](https://github.com/dotnet/aspnetcore/pull/67964)).

## O Blazor Server ganha isso de graça

Componentes Interactive Server não precisam de configuração nenhuma ([dotnet/aspnetcore#68221](https://github.com/dotnet/aspnetcore/pull/68221)). O hub de componentes habilita a atualização sozinho, e quando um token é substituído o Blazor atualiza o estado de autenticação e dispara `AuthenticationStateChanged`, então `AuthorizeView` e qualquer outra coisa que consuma `AuthenticationStateProvider` renderiza de novo com os claims novos. Isso finalmente transforma "a função do usuário mudou no meio da sessão" em algo que você consegue refletir sem derrubar o circuito.

Os detalhes completos estão nas [notas de versão do ASP.NET Core no RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md).
