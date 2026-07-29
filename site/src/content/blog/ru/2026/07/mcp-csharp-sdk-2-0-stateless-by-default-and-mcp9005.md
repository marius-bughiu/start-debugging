---
title: "Вышел MCP C# SDK 2.0: без состояния по умолчанию и MCP9005 на старом коде"
description: "ModelContextProtocol 2.0.0 вышел 2026-07-28 с включённым по умолчанию транспортом HTTP без состояния, с Multi Round-Trip Requests вместо инициируемой сервером elicitation и с предупреждением анализатора на ElicitAsync и SampleAsync."
pubDate: 2026-07-29
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "ru"
translationOf: "2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005"
translatedBy: "claude"
translationDate: 2026-07-29
---

2026-07-28 Джефф Хэндли анонсировал [v2.0 официального MCP C# SDK](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/), выпущенного в тот же день, когда ревизия протокола `2026-07-28` стала финальной. `ModelContextProtocol` 2.0.0 лежит в NuGet как стабильная версия и поддерживает `net8.0`, `net9.0`, `net10.0` и `netstandard2.0`. Если сервер построен на 1.x, это не то обновление версии, которое можно принять, не прочитав diff.

## Рукопожатия больше нет

Главное изменение архитектурное, и оно является вычитанием. В ревизии `2026-07-28` нет ни рукопожатия `initialize`, ни `Mcp-Session-Id`. Клиенты вызывают `server/discover`, а каждый последующий запрос несёт версию протокола, сведения о клиенте и возможности в поле `_meta` самого запроса. Именно поэтому [MCP-сервер GitHub смог удалить своё хранилище сессий в Redis](/ru/2026/07/github-mcp-server-goes-stateless-redis-session-store/).

В C# SDK это проявляется как смена значения по умолчанию. `HttpServerTransportOptions.Stateless` теперь равно `true`, поэтому сервер, созданный сегодня, масштабируется горизонтально без маршрутизации с привязкой к сессии. Вернуться к сессиям можно явно:

```csharp
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options => options.Stateless = false)
    .WithToolsFromAssembly();
```

## MCP9005 и есть список миграции

Запросы, инициируемые сервером, не переживают транспорт без состояния. `ElicitAsync`, `SampleAsync` и `RequestRootsAsync` теперь помечены как устаревшие и выдают диагностику `MCP9005`. Скомпилируйте проект против 2.0.0, и список предупреждений станет планом миграции: каждое место, где сервер посреди вызова инструмента обращался обратно к клиенту, придётся переписать.

Заменой служит Multi Round-Trip Requests. Вместо того чтобы сервер вызывал клиента, инструмент выбрасывает исключение с нужными ему входными данными, клиент разрешает их локально и затем повторяет вызов с приложенными ответами:

```csharp
throw new InputRequiredException(
    inputRequests: new Dictionary<string, InputRequest>
    {
        ["closeReason"] = InputRequest.ForElicitation(...)
    },
    requestState: ticketId.ToString());
```

`requestState` и есть тот приём, который позволяет обойтись без сессии: это ваш токен корреляции, который возвращает клиент, а не хранит память сервера.

Клиентам достаётся простая половина. `McpClient` разрешает MRTR прозрачно, если зарегистрирован обработчик:

```csharp
var client = await McpClient.CreateAsync(
    clientTransport,
    clientOptions: new()
    {
        Handlers = new McpClientHandlers
        {
            ElicitationHandler = (requestParams, ct) =>
                ValueTask.FromResult(
                    new ElicitResult { Action = "accept" })
        }
    });
```

## Что по-прежнему говорит со старыми узлами

Клиент 2.0.0 предпочитает `2026-07-28` и автоматически откатывается к устаревшему рукопожатию `initialize`, когда сервер не отвечает на `server/discover`. Сервер 2.0.0 продолжает принимать `initialize` от клиентов 1.x. Единственная неработающая комбинация - старый клиент против сервера без состояния, и это как раз тот случай, который нельзя перекрыть мостом, поскольку MRTR против клиента `2025-11-25` требует состояния сессии, чтобы транслироваться в устаревшую elicitation.

Второй острый угол: экспериментальная поддержка Tasks из 1.3.x и 1.4.x исчезла, её заменил переработанный пакет `ModelContextProtocol.Extensions.Tasks`, согласованный с SEP-2663. Apps и Tasks теперь подключаемые пакеты, а не часть ядра, и включаются через `.WithTasks(store)` и `.WithMcpApps()`.

По-настоящему приятное дополнение для тех, кто держит серверы за шлюзом: `[McpHeader]` поднимает параметр инструмента до HTTP-заголовка, так что прокси может маршрутизировать по нему, не разбирая тело JSON-RPC.

```csharp
public static async Task<string> GetOrderStatus(
    [McpHeader("Region")] string region,
    string orderId)
```

Начните с `dotnet add package ModelContextProtocol --version 2.0.0`, соберите проект и прочитайте список `MCP9005`, прежде чем трогать что-либо ещё. [Примечания к выпуску v2.0.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0) перечисляют все 10 несовместимых изменений, включая перенумерацию кодов ошибок JSON-RPC, которая переносит `UnsupportedProtocolVersion` на `-32022`.
