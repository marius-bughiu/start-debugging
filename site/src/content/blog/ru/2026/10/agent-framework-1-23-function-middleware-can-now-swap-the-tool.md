---
title: "Agent Framework 1.23: middleware функций наконец может подменить вызываемый инструмент"
description: "Microsoft Agent Framework .NET 1.23.0 учитывает присваивание FunctionInvocationContext.Function, поэтому middleware может перенаправить вызов инструмента на другую AIFunction. Новый хелпер WrapWithPendingMiddleware сохраняет участие остальной цепочки."
pubDate: 2026-10-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "ru"
translationOf: "2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool"
translatedBy: "claude"
translationDate: 2026-10-02
---

Microsoft Agent Framework [dotnet-1.23.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.23.0) вышел 1 октября 2026 года с длинным списком исправлений и пятью изменениями с пометкой BREAKING. Изменение, о котором я хочу рассказать, вообще не помечено, потому что мейнтейнеры считают его исправлением бага: [PR #8615](https://github.com/microsoft/agent-framework/pull/8615) позволяет middleware функций действительно заменить функцию, которую оно собирается вызвать.

## Сеттер, который ничего не делал

Middleware вызова функций, зарегистрированное через `AIAgentBuilder.Use(...)`, получает `FunctionInvocationContext`. У его свойства `Function` есть публичный сеттер, и ничто не мешало присвоить другую `AIFunction` перед вызовом `next`. До версии 1.22 такое присваивание молча игнорировалось. Изменения в `context.Arguments` учитывались, но продолжение всегда вызывало функцию, которую обертка захватила при построении списка инструментов.

Это блокировало целый класс сценариев: направить рискованный вызов в защищенную реализацию, подменить реализацию для конкретного тенанта во время выполнения или подставить заглушку в интеграционном тесте, не пересобирая агента. Обычный обходной путь состоял в том, чтобы не вызывать `next` и вызвать другую функцию самому, но тогда пропускалось все middleware, зарегистрированное после вашего.

## Перенаправление вызова в 1.23

`FunctionInvocationDelegatingAgent` теперь запоминает цель до запуска вашего callback и после него вызывает то, что лежит в `context.Function`. Если вы его не трогали, поведение такое же, как в 1.22. Если заменили, выполняется замена:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction sandboxedDelete = AIFunctionFactory.Create(
    (string customerId) => $"Queued deletion of {customerId} for human review.",
    "delete_customer",
    "Deletes a customer record.");

async ValueTask<object?> RouteDestructiveCalls(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    if (context.Function.Name == "delete_customer")
    {
#pragma warning disable MAAI001
        context.Function = context.WrapWithPendingMiddleware(sandboxedDelete);
#pragma warning restore MAAI001
    }

    return await next(context, cancellationToken);
}

AIAgent agent = baseAgent
    .AsBuilder()
        .Use(RouteDestructiveCalls)
        .Use(AuditMiddleware)
    .Build();
```

Модель запросила `delete_customer`, аргументы проходят без изменений, а результат инструмента возвращает версия из песочницы.

## Зачем нужен WrapWithPendingMiddleware

Замена вызывается напрямую. Без хелпера `AuditMiddleware` из примера выше никогда не увидел бы перенаправленный вызов. Новый `FunctionInvocationContextExtensions.WrapWithPendingMiddleware(context, function)` оборачивает вашу замену в callbacks, которые для этого вызова еще не выполнились, так что остальная цепочка по-прежнему его видит.

Три правила из исходного кода:

- Вызывайте его изнутри выполняющегося callback до вызова `next`. После того как продолжение отработало, ожидающих callbacks не остается, и хелпер выбрасывает `InvalidOperationException`.
- Если ожидающих callbacks нет, он возвращает вашу функцию без изменений.
- Он помечен `[Experimental]` с диагностикой `MAAI001`, отсюда и pragma.

Одно замена не меняет: подтверждение инструментов и телеметрия по-прежнему отражают функцию, которую изначально запросила модель, потому что вызов разрешается до запуска любого callback. Если `delete_customer` требует подтверждения, пользователь по-прежнему подтверждает `delete_customer`, даже если ваше middleware потом выполняет что-то другое. Для аудита это правильное поведение по умолчанию, но не рассчитывайте обойти подтверждение с помощью подмены.

## Остальное в 1.23 коротко

Перед обновлением поищите в коде и эти BREAKING-изменения: проверка имен инструментов и обработка ожидающих вызовов, когда список инструментов меняется между запусками ([#8754](https://github.com/microsoft/agent-framework/pull/8754)), более строгая привязка ответов на подтверждение ([#8641](https://github.com/microsoft/agent-framework/pull/8641)) и allow list для ключей конфигурации и окружения в декларативных workflow, где fallback на переменные окружения процесса выключен, пока вы не зададите `AllowProcessEnvironmentVariableFallback = true` ([#8200](https://github.com/microsoft/agent-framework/pull/8200)). Релиз также поднимает `Microsoft.Extensions.AI` до 10.10.1 и OpenAI до 2.14.0.

Переходите с 1.21 или более ранней версии? Начните с [того, что изменила 1.22 в AsIChatClient и инструментах для каждого запуска](/ru/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/), а затем переходите на `Microsoft.Agents.AI` 1.23.0.
