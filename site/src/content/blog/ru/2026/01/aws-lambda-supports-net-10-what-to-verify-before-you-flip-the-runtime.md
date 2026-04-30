---
title: "AWS Lambda поддерживает .NET 10: что проверить перед переключением среды выполнения"
description: "AWS Lambda теперь поддерживает .NET 10, но обновление среды выполнения это не самая сложная часть. Вот практический чек-лист, охватывающий cold starts, trimming, native AOT и форму развёртывания."
pubDate: 2026-01-08
tags:
  - "aws"
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime"
translatedBy: "claude"
translationDate: 2026-04-30
---
Поддержка **.NET 10** в AWS Lambda начинает появляться сегодня в каналах сообщества, и это тот тип изменения, который выглядит "готовым", пока вы не сталкиваетесь с cold starts, trimming или нативной зависимостью в продакшене.

Исходное обсуждение: [r/dotnet thread](https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/)

## Поддержка среды выполнения это лёгкая часть; форма вашего развёртывания это сложная часть

Перенос Lambda с .NET 8/9 на **.NET 10** это не просто бамп target framework. Выбираемая среда выполнения управляет:

-   **Поведением cold start**: JIT, ReadyToRun, native AOT и сколько кода вы поставляете, всё меняет профиль запуска.
-   **Упаковкой**: образ контейнера vs ZIP, плюс как вы обращаетесь с нативными библиотеками.
-   **Тяжёлыми по reflection фреймворками**: trimming и AOT могут превратить "работает локально" в "падает в runtime".

Если вы хотите .NET 10 в первую очередь ради производительности, не предполагайте, что обновление среды выполнения Lambda это победа. Измеряйте cold starts с вашим реальным handler, реальными зависимостями, реальными переменными окружения и реальными настройками памяти.

## Минимальный handler Lambda на .NET 10, который можно бенчмаркнуть

Вот маленький handler, который легко бенчмаркнуть и легко сломать с trimming. Он также показывает шаблон, который мне нравится: держите handler крошечным, выталкивайте всё остальное за DI или явные пути кода.

```cs
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

public sealed class Function
{
    // Use a static instance to avoid per-invocation allocations.
    private static readonly HttpClient Http = new();

    public async Task<Response> FunctionHandler(Request request, ILambdaContext context)
    {
        // Touch something typical: logging + a small outbound call.
        context.Logger.LogLine($"RequestId={context.AwsRequestId} Name={request.Name}");

        var status = await Http.GetStringAsync("https://example.com/health");
        return new Response($"Hello {request.Name}. Upstream says: {status.Length} chars");
    }
}

public sealed record Request(string Name);
public sealed record Response(string Message);
```

Теперь публикуйте таким способом, который соответствует вашему намеченному продакшен-пути. Если тестируете trimming, сделайте это явным:

```bash
dotnet publish -c Release -f net10.0 -p:PublishTrimmed=true
```

Если вы планируете идти дальше в native AOT на .NET 10, публикуйте и так, и проверьте, что ваши зависимости действительно совместимы с AOT (сериализация, reflection, нативные библиотеки).

## Практический чек-лист для первого выката .NET 10

-   **Измеряйте cold start и steady-state отдельно**: p50 и p99 для обоих.
-   **Включайте trimming только если можете тестировать его**: сбои trimming обычно это сбои в runtime.
-   **Подтвердите настройку памяти вашей Lambda**: она меняет распределение CPU и может перевернуть ваши результаты.
-   **Закрепляйте зависимости, чувствительные к TFMs**: `Amazon.Lambda.*`, сериализаторы и всё, что использует reflection.

Если хотите безопасный первый шаг, обновите среду выполнения до **.NET 10** и сохраните стратегию развёртывания прежней. Когда стабилизируется, экспериментируйте с trimming или AOT в ветке, и выкатывайте только когда мониторинг скажет, что это скучно.
