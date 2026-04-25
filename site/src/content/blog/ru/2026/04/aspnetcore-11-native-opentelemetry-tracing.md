---
title: "ASP.NET Core 11 поставляет нативную трассировку OpenTelemetry: уберите дополнительный NuGet-пакет"
description: "ASP.NET Core в .NET 11 Preview 2 добавляет семантические атрибуты OpenTelemetry прямо в активность HTTP-сервера, устраняя необходимость в OpenTelemetry.Instrumentation.AspNetCore."
pubDate: 2026-04-12
tags:
  - "aspnet-core"
  - "dotnet-11"
  - "opentelemetry"
  - "observability"
lang: "ru"
translationOf: "2026/04/aspnetcore-11-native-opentelemetry-tracing"
translatedBy: "claude"
translationDate: 2026-04-25
---

В каждом проекте ASP.NET Core, экспортирующем трассировки, есть одна и та же строка в `.csproj`: ссылка на `OpenTelemetry.Instrumentation.AspNetCore`. Этот пакет подписывается на источник `Activity` фреймворка и помечает каждый span семантическими атрибутами, которые ожидают экспортёры: `http.request.method`, `url.path`, `http.response.status_code`, `server.address` и так далее.

Начиная с [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/), фреймворк выполняет эту работу сам. ASP.NET Core теперь заполняет стандартные атрибуты семантических соглашений OpenTelemetry прямо в активности HTTP-сервера, поэтому отдельная библиотека инструментирования больше не требуется для сбора базовых данных трассировки.

## Что фреймворк теперь предоставляет

Когда запрос попадает в Kestrel в .NET 11 Preview 2, встроенный middleware пишет те же атрибуты, которые добавлял пакет инструментирования:

- `http.request.method`
- `url.path` и `url.scheme`
- `http.response.status_code`
- `server.address` и `server.port`
- `network.protocol.version`

Это [семантические соглашения HTTP-сервера](https://opentelemetry.io/docs/specs/semconv/http/http-spans/), на которые опирается любой OTLP-совместимый бэкенд для дашбордов и оповещений.

## До и после

Типичная настройка .NET 10 для получения HTTP-трассировок выглядела так:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddAspNetCoreInstrumentation()   // requires the NuGet package
            .AddOtlpExporter();
    });
```

В .NET 11 вы вместо этого подписываетесь на встроенный activity source:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddSource("Microsoft.AspNetCore")  // no extra package needed
            .AddOtlpExporter();
    });
```

Пакет `OpenTelemetry.Instrumentation.AspNetCore` не исчез; он всё ещё существует для команд, которым нужны его callback-и обогащения или продвинутая фильтрация. Но базовые атрибуты, которые нужны 90 % проектов, теперь запечены во фреймворк.

## Почему это важно

Меньше пакетов означает меньший граф зависимостей, более быстрые restore-времена и одну вещь меньше, которую нужно держать в синхронизации при крупных обновлениях версий. Это также означает, что приложения ASP.NET Core, опубликованные с NativeAOT, получают стандартные трассировки, не подтягивая код инструментирования, тяжёлый на reflection.

Если вы уже используете пакет инструментирования, ничего не сломается. Атрибуты фреймворка и атрибуты пакета чисто сливаются на одной и той же `Activity`. Вы можете удалить ссылку на пакет, когда будете готовы, протестировать свои дашборды и двигаться дальше.

[Полные заметки о выпуске ASP.NET Core .NET 11 Preview 2](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/aspnetcore.md) покрывают остальные изменения, включая поддержку TempData в Blazor SSR и новый шаблон проекта Web Worker.
