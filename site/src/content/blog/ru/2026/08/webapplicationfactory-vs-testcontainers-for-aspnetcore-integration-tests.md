---
title: "WebApplicationFactory против Testcontainers для интеграционных тестов в ASP.NET Core"
description: "Выбирайте среду интеграционных тестов ASP.NET Core по проверяемому поведению: маршрутизация HTTP, производственная СУБД или опубликованный образ приложения."
pubDate: 2026-08-07
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "ru"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

`WebApplicationFactory<TEntryPoint>` запускает тестируемое приложение. Testcontainers запускает зависимости, например PostgreSQL или SQL Server. Их можно использовать вместе. Выбирайте конфигурацию по поведению, которое должна проверить ассерция.

**Исправление, 2 ноября 2026 года.** Несовпадение с ограничением маршрута `:int` обычно даёт 404. Ранее был указан 400 и утверждалось, что реальный сокет возможен только в контейнере приложения. Пример HTTP проверен на ASP.NET Core 10.0.10 и SDK 10.0.302. Удалены замеры фикстур без опубликованного бенчмарка.

## Выбор границ проверки

| Что должен доказать тест | Конфигурация | Что проверить |
| --- | --- | --- |
| Маршрутизация, авторизация и сериализация | Factory с обычным `TestServer` и тестовыми сервисами | Статус, заголовки и тело ответа |
| Поведение производственной СУБД | Factory и тот же движок через Testcontainers | Ограничения, миграции, трансляция запросов и конкуренция |
| Опубликованный образ запускается | Сборка и запуск образа приложения с сервисами | Dockerfile, точка входа, параметры и сеть |

По умолчанию factory использует HTTP-сервер внутри процесса. С .NET 10 вызов `UseKestrel()` до инициализации factory позволяет использовать Kestrel и настоящий порт. Для TLS и HTTP/2 нужна соответствующая настройка сервера и клиента. Если тестируется сам образ, запускайте контейнер приложения.

## Проверка HTTP без базы данных

```csharp
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id:int}", (int id) => TypedResults.Ok(id));
app.MapGet("/bound/{id}", (int id) => TypedResults.Ok(id));
app.Run();
```

`GET /orders/7` возвращает 200. `GET /orders/abc` не проходит ограничение, и ни один маршрут не совпадает, поэтому результат — 404. `GET /bound/abc` совпадает с маршрутом, но привязка к целочисленному параметру завершается ответом 400. Это проверено по loopback на Kestrel. Настройка factory, подмена сервисов и тесты аутентификации описаны в [руководстве по WebApplicationFactory](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

## Проверка базы требует подходящего провайдера

SQLite проверяет, например, уникальность, но `VARCHAR(16)` сам по себе не ограничивает длину 16 символами. PostgreSQL отклоняет значение с лишними непробельными символами за пределом `varchar(16)`. Успешный тест SQLite не подтверждает эту особенность PostgreSQL. То же относится к SQL провайдера, миграциям и [конкуренции с rowversion](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

Для конечной точки с SQL Server запустите контейнер SQL Server, примените миграции, укажите factory его строку подключения и проверьте результат. Настройка разобрана в [руководстве Testcontainers для SQL Server](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/). Чистые HTTP-тесты могут обходиться без Docker.

## Воспроизводимые фикстуры

Делите контейнер между тестами только при изоляции данных. Отдельная схема или база на группу либо явный сброс предотвращают влияние прежних записей. Измеряйте загрузку образа, запуск, создание схемы и запросы отдельно. Локальный кэш и новый CI-воркер имеют разные затраты.

## Источники

- [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests?view=aspnetcore-10.0)
- [Route constraints](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0#route-constraints)
- [WebApplicationFactory.UseKestrel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel?view=aspnetcore-10.0)
- [Testcontainers for .NET](https://dotnet.testcontainers.org/)
- [SQLite VARCHAR limits](https://sqlite.org/faq.html#q9) · [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html)
