---
title: "Aspire 13.5.4 больше не теряет Kafka producer при каждой проверке health check"
description: "До Aspire 13.5.4 каждый health check AppHost для ресурса AddKafka создавал новый producer Confluent, который никто не освобождал, поэтому потоки опроса накапливались, а AppHost нагружал CPU. Исправление и ловушка HealthCheckRegistration.Factory, стоящая за ним, касаются и ваших собственных health checks."
pubDate: 2026-09-21
tags:
  - "aspire"
  - "kafka"
  - "dotnet"
  - "health-checks"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/09/aspire-13-5-4-fixes-kafka-health-check-thread-leak"
translatedBy: "claude"
translationDate: 2026-09-21
---

[Aspire 13.5.4](https://github.com/microsoft/aspire/releases/tag/v13.5.4) вышел 2026-09-15, и этот патч стоит установить, если ваш AppHost вызывает `AddKafka`. Вплоть до 13.5.3 health check Kafka, который регистрирует `Aspire.Hosting.Kafka`, при каждом выполнении создавал совершенно новый producer Confluent.Kafka и никогда его не освобождал. Каждый producer запускает собственный поток опроса, поэтому долго работающий AppHost постепенно заполнялся потоками, застрявшими в `SafeKafkaHandle.Poll`. В отчёте в [issue #20091](https://github.com/microsoft/aspire/issues/20091) описан AppHost на macOS с загрузкой CPU 350-400%, а трассировка с выборкой потоков показала, что 1901 из 1934 потоков в выборке находились внутри цикла опроса Kafka.

Если вы когда-нибудь оставляли `dotnet run` для AppHost открытым на полдня и удивлялись шуму вентиляторов, это вероятная причина.

## Откуда брались producer'ы

Интеграция хостинга создавала свой check внутри фабрики `HealthCheckRegistration`:

```csharp
var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp =>
    {
        var options = new KafkaHealthCheckOptions();
        options.Configuration = new ProducerConfig();
        options.Configuration.BootstrapServers = connectionString
            ?? throw new InvalidOperationException("Connection string is unavailable");
        return new KafkaHealthCheck(options);
    },
    failureStatus: default,
    tags: default);
builder.Services.AddHealthChecks().Add(healthCheckRegistration);
```

`HealthCheckService` вызывает эту фабрику при каждом запуске check. `KafkaHealthCheck` лениво создаёт producer и освобождает его в `Dispose()`, но объект, возвращаемый фабрикой, создавался через `new`, а не извлекался из контейнера. Runner health checks действительно открывает и освобождает DI scope на каждый запуск, однако scope освобождает только те экземпляры, которые создал сам. Никто никогда не вызывал `Dispose()` у check, поэтому каждая проверка оставляла после себя ещё один producer и ещё один поток опроса.

Код намеренно избегал `AddKafka(...)` из пакета health checks от Xabaril: этот хелпер регистрирует singleton, и при двух ресурсах Kafka фабрика читала бы строку подключения последнего ресурса ([Xabaril #2298](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/issues/2298)). Обходное решение устранило ошибку конфигурации и внесло ошибку времени жизни.

## Исправление: check принадлежит DI

[PR #20092](https://github.com/microsoft/aspire/pull/20092), перенесённый в 13.5.4 как #20094, регистрирует по одному keyed singleton на каждый ресурс Kafka, а фабрика теперь его извлекает:

```csharp
builder.Services.AddKeyedSingleton<KafkaHealthCheck>(healthCheckKey, (sp, _) =>
{
    var options = new KafkaHealthCheckOptions();
    options.Configuration = new ProducerConfig();
    options.Configuration.BootstrapServers = connectionString
        ?? throw new InvalidOperationException("Connection string is unavailable");
    return new KafkaHealthCheck(options);
});

var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp => sp.GetRequiredKeyedService<KafkaHealthCheck>(healthCheckKey),
    failureStatus: default,
    tags: default);
```

Ключ `"{name}_check"` разделяет bootstrap servers каждого ресурса, producer переиспользуется между проверками, а корневой контейнер освобождает его при остановке AppHost. Измерение из PR на двух реальных брокерах Kafka 8.2.0: 84 выполнения health check дали 84 экземпляра check и 84 потока опроса на 13.5.3, против 2 экземпляров и 2 потоков с исправлением, и 0 потоков после освобождения.

## Обновление

Обновите пакеты Aspire в проекте AppHost:

```xml
<PackageReference Include="Aspire.Hosting.Kafka" Version="13.5.4" />
```

Менять код AppHost не нужно, публичный API не изменился. В этом же выпуске исправлены сбои DevTunnel при автоматическом выборе региона (регрессия из 13.3), скрыт неиспользуемый ресурс `azure-environment` в AppHost, где есть только эмуляторы, а `IAwsRadiusProviderBuilder` и `IAzureRadiusProviderBuilder` помечены экспериментальной диагностикой `ASPIRERADIUS003`, которая может проявиться как новый warning-as-error, если вы ссылаетесь на эти интерфейсы напрямую.

## Проверьте свои health checks на тот же шаблон

Ошибка не специфична для Kafka. Любая фабрика `HealthCheckRegistration`, возвращающая `new SomethingDisposable(...)`, теряет по одному экземпляру на проверку, и при стандартном периоде публикатора health checks в 30 секунд это 2880 потерянных объектов в сутки на один check. Либо регистрируйте check в DI и извлекайте его в фабрике, как теперь делает Aspire, либо держите дорогой клиент (producer, подключение, `HttpClient`) в singleton, а сам check оставьте дешёвым объектом без состояния. Если вы всё ещё на линейке 13.5, [предыдущий пост о `WithTerminal()`](/ru/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/) описывает остальные изменения дашборда в 13.5.
