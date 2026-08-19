---
title: "Semantic Kernel 1.80.0 запрещает плагинам OpenAPI следовать за редиректами"
description: "В Semantic Kernel .NET 1.80.0 появилось ломающее изменение: HttpClient по умолчанию у плагина OpenAPI больше не следует за редиректами, что закрывает обход SSRF-защиты. Что именно поменялось и почему собственный HttpClient снова открывает дыру."
pubDate: 2026-08-19
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "ru"
translationOf: "2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects"
translatedBy: "claude"
translationDate: 2026-08-19
---

Semantic Kernel .NET 1.80.0 вышел 2026-08-18, и самая важная строка в списке изменений оказалась самой короткой: [".NET: [Breaking] Update OpenAPI HTTP client defaults"](https://github.com/microsoft/semantic-kernel/pull/14293). Она закрывает дыру, которую Semantic Kernel с мая описывал в собственных XML-комментариях как известное ограничение.

## Проверка работала, а редирект был запасным выходом

С тех пор как в мае 2026 года был влит [PR #14029](https://github.com/microsoft/semantic-kernel/pull/14029), `RestApiOperationServerUrlValidationOptions` по умолчанию применяется к каждому плагину OpenAPI. Если оставить `ServerUrlValidationOptions` равным null, всё равно будет создан экземпляр с настройками по умолчанию: он требует https для всего, что не входит в список разрешённых адресов, и отклоняет хосты, которые разрешаются в loopback, link-local (включая облачный адрес метаданных `169.254.169.254`), RFC1918, `fc00::/7`, carrier-grade NAT, multicast и зарезервированные диапазоны.

Проблема была в порядке действий. Проверка выполняется по URL до того, как запрос уходит. `HttpClient` по умолчанию следовал за редиректами, поэтому разрешённый вами публичный хост мог ответить кодом `302` с указанием на `http://169.254.169.254/latest/meta-data/`, и обработчик шёл по этой ссылке, уже пройдя проверку. Semantic Kernel писал об этом в примечаниях к самому типу и советовал самостоятельно выставлять `AllowAutoRedirect = false`.

## Что на самом деле изменилось в 1.80.0

Фабрика плагинов больше не получает клиент по умолчанию через `HttpClientProvider.GetHttpClient()`. Теперь она вызывает новый метод `GetNonRedirectingHttpClient()`, за которым стоит отдельный неудаляемый синглтон обработчика с отключёнными редиректами:

```csharp
public static HttpClient GetNonRedirectingHttpClient()
    => new(NonDisposableHttpClientHandler.NonRedirectingInstance, disposeHandler: false);
```

Через него проходят все точки входа: `ImportPluginFromOpenApiAsync`, `CreatePluginFromOpenApiAsync`, `OpenApiKernelPluginFactory.CreateFromOpenApiAsync`, а также расширения для API Manifest и Copilot Agent Plugin. Редирект теперь проявляется как `HttpOperationException` с кодом `3xx` вместо того, чтобы молча отрабатываться.

## Ваш HttpClient по-прежнему ваша забота

Именно это стоит проверить перед обновлением `Microsoft.SemanticKernel.Plugins.OpenApi` до 1.80.0. Новое поведение по умолчанию действует только тогда, когда клиент создаёт сам Semantic Kernel. Если передать свой, он будет использован как есть:

```csharp
var handler = new HttpClientHandler { AllowAutoRedirect = false };
using var http = new HttpClient(handler);

await kernel.ImportPluginFromOpenApiAsync(
    pluginName: "partner",
    uri: new Uri("https://partner.example.com/openapi.json"),
    executionParameters: new OpenApiFunctionExecutionParameters
    {
        HttpClient = http,
    });
```

Тонкий случай связан с внедрением зависимостей. Расширения kernel обращаются к `kernel.Services.GetService<HttpClient>()` раньше, чем доходят до значения по умолчанию, поэтому обычная регистрация `AddHttpClient()` побеждает и возвращает `AllowAutoRedirect = true`. Если вы собираете плагины внутри хоста, как в статье о [запуске плагина Semantic Kernel из BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/), настраивайте основной обработчик явно.

Ломающая часть вполне реальна: внутренний API, который отвечает `301` при несовпадении завершающего слеша, раньше работал, а теперь выбрасывает исключение. Исправьте `servers[].url` в документе, вместо того чтобы отдавать плагину клиент, следующий за редиректами.
