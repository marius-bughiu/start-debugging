---
title: "MCP C# SDK 2.3: McpClient.ServerInfo теперь допускает null, и ваша сборка это заметит"
description: "ModelContextProtocol 2.3.0, выпущенный 20 октября 2026 года, меняет тип McpClient.ServerInfo с Implementation на Implementation?, потому что серверы 2026-07-28 могут не указывать свою идентичность в server/discover. Почему так, что ломается при warnings-as-errors и как это исправить одной строкой."
pubDate: 2026-10-21
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "ru"
translationOf: "2026/10/mcp-csharp-sdk-2-3-serverinfo-is-nullable"
translatedBy: "claude"
translationDate: 2026-10-21
---

[MCP C# SDK 2.3.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.3.0) вышел 20 октября 2026 года и содержит изменение, которого в минорной версии обычно не ждут: `McpClient.ServerInfo` теперь аннотирован как `Implementation?` вместо `Implementation`. Сигнатура в CLR остаётся прежней, поэтому во время выполнения и для уже скомпилированного кода ничего не ломается. Ломается любой проект с `<Nullable>enable</Nullable>` и `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`, который обращается к этому свойству напрямую.

## Почему у подключённого сервера может не быть идентичности

В ревизии протокола `2026-07-28` рукопожатие выполняется через `server/discover`, а не через прежний `initialize`. При обнаружении метаданные `io.modelcontextprotocol/serverInfo` необязательны. Сервер может ответить на discovery, объявить свои инструменты и обслуживать вызовы, ни разу не сообщив, кто он.

До версии 2.3.0 SDK этого не учитывал. Подключение к такому серверу проходило успешно, но последующее чтение `ServerInfo` выбрасывало `InvalidOperationException`, то же исключение, что и при отсутствии подключения вообще. Совершенно корректный сервер выглядел как сломанное соединение. [PR #1903](https://github.com/modelcontextprotocol/csharp-sdk/pull/1903) исправил это, возвращая `null`:

```csharp
public override Implementation? ServerInfo => _serverCapabilities is null
    ? throw new InvalidOperationException("The client is not connected.")
    : _serverInfo;
```

Из этого следуют три правила:

- Подключения ещё нет: по-прежнему выбрасывается `InvalidOperationException`.
- Подключение по `2026-07-28`, и сервер не указал свою идентичность: `null`.
- Подключение по прежнему `initialize`: никогда не `null`, потому что на этом пути `serverInfo` по-прежнему обязателен.

Некорректные метаданные по-прежнему обрывают подключение с `JsonException`, так что `null` действительно означает "не предоставлено", а не "мусор".

## Исправление в клиентском коде

Код вроде этого теперь вызывает CS8602 на обращении `.Name`:

```csharp
await using var client = await McpClient.CreateAsync(transport);

logger.LogInformation("Connected to {Server} {Version}",
    client.ServerInfo.Name, client.ServerInfo.Version);
```

Обработайте случай null явно:

```csharp
await using var client = await McpClient.CreateAsync(transport);

var name = client.ServerInfo?.Name ?? "Unknown server";
var version = client.ServerInfo?.Version ?? "n/a";

logger.LogInformation("Connected to {Server} {Version}", name, version);
```

Не поддавайтесь соблазну оператора `!`. Он заглушает предупреждение, но возвращает `NullReferenceException` в тот момент, когда кто-нибудь впервые направит ваш клиент на сервер, поддерживающий только discovery. В заметках к релизу также прямо сказано, что эту самостоятельно заявленную идентичность нельзя использовать для решений о безопасности ("must not be used for security decisions"). Если ваш код ограничивает доступ к инструментам по `ServerInfo.Name`, это уже было ошибкой, и `null` здесь хороший повод заменить это конфигурацией, которую контролируете вы.

## Остальное в 2.3.0

Релиз в основном посвящён совместимости и надёжности, и это всё равно стоит подтянуть:

- `McpClientOptions.TimeProvider` позволяет в тестах управлять тайм-аутами клиента через `FakeTimeProvider` вместо реального ожидания. OAuth теперь исключён из короткого бюджета `DiscoverProbeTimeout`, но по-прежнему ограничен `InitializationTimeout`.
- Инструменты, промпты и ресурсы перечисляются в порядке регистрации (#1924), поэтому вывод `tools/list` стабилен от запуска к запуску.
- Современные ответы Streamable HTTP ждут первого сообщения протокола перед отправкой заголовков. Обработчику, который долго молчит, теперь могут потребоваться уведомления о прогрессе или более длинный HTTP-тайм-аут.
- Stdio-клиенты закрывают stdin сервера перед ожиданием штатного завершения, а ответы на POST в прежнем SSE освобождаются детерминированно.
- Ответы Streamable HTTP 400 содержат ошибку разбора JSON, что заметно ускоряет отладку некорректных клиентских запросов.

Обновление сводится к повышению версии пакета:

```bash
dotnet add package ModelContextProtocol --version 2.3.0
```

Если вы всё ещё на 1.x, сначала выполните [миграцию с 1.x на 2.x](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/), затем соберите проект с предупреждениями как ошибками и позвольте компилятору показать каждое обращение к `ServerInfo`.
