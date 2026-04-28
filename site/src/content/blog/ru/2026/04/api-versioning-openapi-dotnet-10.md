---
title: "Asp.Versioning 10.0 наконец-то дружит со встроенным OpenAPI в .NET 10"
description: "Asp.Versioning 10.0 — это первый релиз, нацеленный на .NET 10 и новый пайплайн Microsoft.AspNetCore.OpenApi. Руководство Сандера тен Бринке от 23 апреля показывает, как зарегистрировать отдельный документ OpenAPI на каждую версию API с помощью WithDocumentPerVersion()."
pubDate: 2026-04-28
tags:
  - "dotnet-10"
  - "aspnetcore"
  - "openapi"
  - "api-versioning"
lang: "ru"
translationOf: "2026/04/api-versioning-openapi-dotnet-10"
translatedBy: "claude"
translationDate: 2026-04-28
---

Когда ASP.NET Core 9 заменил Swashbuckle на встроенный генератор [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/overview?view=aspnetcore-10.0), не хватило одной склеивающей детали: не было чистого способа подключить новый пайплайн к `Asp.Versioning` и выдавать отдельный документ для каждой версии. Исправление приехало на прошлой неделе. [Пост Сандера тен Бринке от 23 апреля в .NET Blog](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) — это официальное руководство "делайте вот так", и он идёт в паре с первыми пакетами `Asp.Versioning`, нацеленными на .NET 10.

## Какие пакеты изменились

Для minimal API вы теперь подключаете три пакета, все актуальные на апрель 2026:

- `Asp.Versioning.Http` 10.0.0
- `Asp.Versioning.Mvc.ApiExplorer` 10.0.0
- `Asp.Versioning.OpenApi` 10.0.0-rc.1

Для контроллеров замените `Asp.Versioning.Http` на `Asp.Versioning.Mvc` 10.0.0. Пакет `OpenApi` делает всю настоящую работу: он соединяет модель API explorer, которую библиотека версионирования и так производит, с пайплайном трансформеров документа, которого ожидает `Microsoft.AspNetCore.OpenApi`. До этого релиза приходилось вручную писать трансформер, который читает `IApiVersionDescriptionProvider` и фильтрует операции по документу. Теперь этот код в коробке.

## Один документ на версию, в три строки

Регистрация сервисов не меняется по сравнению с историей версионирования до OpenAPI, добавляется только один вызов `.AddOpenApi()`:

```csharp
builder.Services.AddApiVersioning()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
    })
    .AddOpenApi();
```

На стороне endpoint появляется новое расширение:

```csharp
app.MapOpenApi().WithDocumentPerVersion();
```

`WithDocumentPerVersion()` перечисляет всё, что возвращает `DescribeApiVersions()`, и регистрирует по одному документу на каждую версию. Вы открываете `/openapi/v1.json` и `/openapi/v2.json` и получаете ровно те операции, которые относятся к каждой версии, без общих ID операций и без дублированных схем, протекающих между документами. И Scalar (`app.MapScalarApiReference()`), и Swagger UI (`app.UseSwaggerUI()`) автоматически обнаруживают документы через того же провайдера описаний версий API, так что переключатель в браузере подключается бесплатно.

## Версионированные группы маршрутов

Для minimal API сторона маршрутов остаётся компактной. Вы один раз объявляете версионированный API и навешиваете на него группы для каждой версии:

```csharp
var usersApi = app.NewVersionedApi("Users");

var usersV1 = usersApi.MapGroup("api/users").HasApiVersion("1.0");
var usersV2 = usersApi.MapGroup("api/users").HasApiVersion("2.0");

usersV1.MapGet("", () => Results.Ok(new { shape = "v1" }));
usersV2.MapGet("", () => Results.Ok(new { shape = "v2" }));
```

Имя `Users` становится группой API; `HasApiVersion` — это то, что API explorer читает, чтобы решить, к какому документу OpenAPI принадлежит каждый endpoint.

## Почему это важно прямо сейчас

Если вы начали новое приложение на ASP.NET Core 9 или 10 и принципиально пропустили Swashbuckle, единственное, что тянуло вас обратно, — это версионирование. С `Asp.Versioning.OpenApi` 10.0.0-rc.1 этот аварийный люк закрывается. Суффикс RC — единственная причина подождать: поверхность API именно та, что выйдет в релизе, и команда целится в GA вместе с поездом обслуживания .NET 10. Полный пример живёт в [репозитории Сандера, на который ссылается пост](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/), и его стоит клонировать перед следующим разом, когда вы потянетесь к самописному трансформеру.
