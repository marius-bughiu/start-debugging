---
title: "Как создать и запустить первое приложение Aspire из шаблона"
description: "Создайте Aspire-приложение на C# с API и фронтендом Blazor, откройте панель мониторинга и сравните результат с проектом и снимками предварительной версии для .NET 8."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Сначала подготовьте [Aspire CLI и инструменты для C#](/ru/2023/11/how-to-install-net-aspire/). Для **нового** решения шаблон `aspire-starter` создаёт службу API, фронтенд Blazor и AppHost, который связывает их. Если решение уже существует, воспользуйтесь [руководством по добавлению AppHost к существующим проектам в Aspire 13.4](/ru/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Создание приложения и запуск панели мониторинга

В каталоге, где должно появиться новое решение, выполните команды:

```sh
aspire new aspire-starter -n HelloAspire -o HelloAspire
cd HelloAspire
aspire run
```

Ответьте на вопросы шаблона, если они появятся. Первая команда создаёт решение в `HelloAspire`, последняя запускает AppHost. Откройте адрес панели мониторинга из терминала, затем адрес веб-фронтенда в списке ресурсов. Перейдите на страницу погоды, чтобы отправить запрос от фронтенда к API. На панели изучите журналы служб и трассировку запроса. Для остановки приложения нажмите `Ctrl+C` в терминале.

В созданном проекте `ApiService` предоставляет данные, `Web` их получает, а `ServiceDefaults` содержит общую конфигурацию. AppHost регистрирует проекты и связывает фронтенд с его зависимостями. Структура шаблона описана в [руководстве по началу работы на C#](https://aspire.dev/get-started/first-app/?lang=csharp), а механизм ссылок на ресурсы — в [обзоре Aspire](/ru/2023/11/what-is-net-aspire/).

## Архив: предварительная версия для .NET 8 в ноябре 2023 года

**Исправление — 2 ноября 2026 г.:** приведённые выше шаги используют Aspire CLI 13.x. Снимки экрана, параметр Redis и API `AddRedisContainer` ниже относятся к [предварительной версии 2023 года](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). Её AppHost был нацелен на `net8.0` и ссылался на [Aspire.Hosting 8.0.0-preview.1.23557.2](https://www.nuget.org/packages/Aspire.Hosting/8.0.0-preview.1.23557.2).

В Visual Studio 2022 Preview в первоначальном руководстве выбирали **.NET Aspire Starter Application** и включали **Use Redis for caching**. В CLI этому соответствовала команда:

```sh
dotnet new aspire-starter --use-redis-cache --output Foo
```

[![Диалог создания нового проекта Visual Studio с отфильтрованным списком шаблонов проектов .NET Aspire.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

[![Диалог дополнительной информации для шаблона проекта .NET Aspire Starter Application с опциональной настройкой Use Redis for caching (требуется Docker).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

AppHost ссылался на `ApiService` и `Web`. Оба проекта использовали `ServiceDefaults`, что видно на исходной схеме зависимостей:

[![Граф зависимостей проектов для .NET Aspire Starter Application: AppHost наверху, зависит от ApiService и Web, оба зависят от ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

В предварительной версии AppHost регистрировал Redis под именем `cache`, а API под именем `apiservice`. Фронтенд ссылался на оба ресурса. Так выглядел API того времени:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var cache = builder.AddRedisContainer("cache");
var api = builder.AddProject<Projects.Foo_ApiService>("apiservice");
builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(api);
builder.Build().Run();
```

Первоначальная панель мониторинга показывала проекты и контейнер вместе. Трассировка запроса на странице погоды показывала отдельные вызовы служб:

[![Панель .NET Aspire, выполняющая шаблон проекта .NET Aspire Starter Application.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

[![Трассировка запроса внутри панели .NET Aspire, показывающая запрос на этапах его прохождения через различные компоненты приложения.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)
