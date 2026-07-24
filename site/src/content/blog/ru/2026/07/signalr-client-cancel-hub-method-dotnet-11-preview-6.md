---
title: "Клиенты SignalR наконец могут отменить выполняющийся метод хаба в .NET 11 Preview 6"
description: "Отмена CancellationToken, передаваемого в InvokeAsync, теперь доходит до сервера и отменяет метод хаба. Это закрывает запрос SignalR, открытый с 2019 года."
pubDate: 2026-07-24
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
  - "csharp"
lang: "ru"
translationOf: "2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-24
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) вышел 2026-07-15 и закрывает один из старейших запросов на функциональность в SignalR. [Issue #11542](https://github.com/dotnet/aspnetcore/issues/11542), "Possibility to cancel long running hub method from client," был открыт с 2019 года. [PR #64098](https://github.com/dotnet/aspnetcore/pull/64098) наконец всё связал: `CancellationToken`, который вы передаёте в `InvokeAsync` на клиенте .NET, теперь действительно доходит до сервера и отменяет метод хаба.

## Токен, который раньше вам лгал

До Preview 6 клиент .NET для SignalR уже принимал `CancellationToken` в `InvokeAsync`. Просто он делал не то, что большинство предполагало. Его отмена прекращала ожидание результата на *клиенте*, но метод хаба на сервере продолжал выполняться до конца. Не было способа сказать серверу "остановись, вызывающая сторона ушла." Потоковые вызовы отправляли сообщение `CancelInvocation`, но обычные вызовы «запрос-ответ» этого не делали.

Теперь этот пробел устранён. Когда вы отменяете токен, переданный в `InvokeAsync`, клиент отправляет `CancelInvocationMessage` на сервер, который находит соответствующий вызов и отменяет его.

## Как это подключить

На сервере объявите параметр `CancellationToken` в методе хаба. SignalR заполняет его как синтетический аргумент, так что клиент его никогда не отправляет:

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

До Preview 6 параметр `CancellationToken` в непотоковом методе хаба игнорировался: фреймворк синтезировал его только для потоковых методов. Теперь `HubMethodDescriptor` разрешает его везде.

На клиенте передайте токен и отмените его, когда результат больше не нужен:

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

## Что происходит внутри

`DefaultHubDispatcher` регистрирует `CancellationTokenSource` каждого вызова в `ActiveRequestCancellationSources`, индексируя по id вызова. Когда приходит `CancelInvocationMessage`, он находит этот источник и вызывает `Cancel()`, что срабатывает на токене, за которым следит ваш метод хаба. Это тот же реестр, который уже использовали потоковые вызовы, теперь общий с обычными.

Два момента, о которых стоит помнить. Отмена кооперативная: если ваш метод хаба никогда не проверяет токен и не передаёт его дальше в асинхронные вызовы, которые он делает, ничего не остановится. И это предварительная версия, поэтому поведение ещё может измениться до выпуска .NET 11 в ноябре 2026 года.

Тот же Preview 6 также [включил автоматическую защиту от CSRF](/ru/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/), так что это хороший релиз для проверки. Все подробности в [примечаниях к выпуску ASP.NET Core Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Если вы когда-нибудь делали кнопку «отмена», которая лишь лгала пользователю, это тот релиз, который делает её честной.
