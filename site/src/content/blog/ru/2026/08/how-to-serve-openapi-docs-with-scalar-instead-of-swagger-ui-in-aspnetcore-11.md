---
title: "Как отдавать документацию OpenAPI через Scalar вместо Swagger UI в ASP.NET Core 11"
description: "Замените UseSwaggerUI на MapScalarApiReference в ASP.NET Core 11: маршрутизация, несколько документов, предзаполненная аутентификация, защита в продакшене, ресурсы без CDN и расширения OpenAPI, доступные только в Scalar."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "ru"
translationOf: "2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Чтобы заменить Swagger UI на Scalar в API на ASP.NET Core 11, установите `Scalar.AspNetCore`, удалите вызов `app.UseSwaggerUI(...)` и добавьте `app.MapScalarApiReference()` рядом с уже существующим `app.MapOpenApi()`. Интерфейс окажется по адресу `/scalar` и будет читать документ из `/openapi/v1.json`, то есть именно оттуда, куда его уже отдаёт `MapOpenApi`. Это девяносто процентов случаев. Оставшиеся десять процентов описаны ниже: документ не по маршруту по умолчанию, больше одного документа, кнопка Authorize, которая действительно прикладывает токен, и способ не выпустить всё это на продакшен-хост.

Всё описанное нацелено на .NET 11 (проверено на Preview 6, SDK `11.0.100-preview.6.26359.118`) с `Microsoft.NET.Sdk.Web` и C# 14, используется `Scalar.AspNetCore` 2.16.18, опубликованный 2026-08-07. Приведённая ниже поверхность API идентична на .NET 8, 9 и 10, поскольку пакет нацелен на `net8.0` и выше.

## Шесть шагов от начала до конца

1. Установите `Scalar.AspNetCore` командой `dotnet add package Scalar.AspNetCore` и добавьте `using Scalar.AspNetCore;` в `Program.cs`.
2. Удалите вызов middleware `app.UseSwaggerUI(...)`, а также ссылку на пакет `Swashbuckle.AspNetCore.SwaggerUI`, если он больше нигде не используется.
3. Вызовите `app.MapScalarApiReference()` внутри той же проверки среды, которая уже оборачивает `app.MapOpenApi()`.
4. Направьте Scalar на нужный документ через `WithOpenApiRoutePattern` или `AddDocument`, если ваш JSON OpenAPI лежит не по адресу `/openapi/{documentName}.json`.
5. Предзаполните учётные данные через `AddPreferredSecuritySchemes` и `AddHttpAuthentication`, чтобы кнопка Authorize отправляла настоящий токен в разработке.
6. Определитесь со сценарием для продакшена: либо вообще не подключайте endpoint в продакшене, либо подключите его и добавьте в цепочку `RequireAuthorization()` к возвращённому построителю endpoint.

## Что на самом деле меняется, когда Swagger UI уходит

Самое важное отличие не визуальное. `UseSwaggerUI` регистрирует middleware. `MapScalarApiReference` регистрирует endpoint. Это единственное изменение переносит интерфейс из конвейера в таблицу маршрутизации, и всё остальное следует уже из него.

Middleware выполняется в порядке регистрации и завершает запрос до того, как маршрутизация endpoint получит слово. Именно поэтому Swagger UI исторически игнорировал ваши политики авторизации, если вы не оборачивали его собственным middleware. Endpoint участвует в маршрутизации наравне с прочими, а значит несёт метаданные, попадает в `EndpointDataSource`, и знакомые вам соглашения применяются к нему напрямую.

```csharp
// Program.cs -- .NET 11, C# 14
// Before: Swashbuckle's UI middleware over the built-in OpenAPI document
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "v1"));
}
```

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
// After: an endpoint, not middleware
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Обратите внимание, чего нет во втором блоке: аналога `SwaggerEndpoint` не существует. Scalar по умолчанию использует маршрут документа `/openapi/{documentName}.json`, а это ровно тот маршрут, который регистрирует `MapOpenApi`, так что они совпадают без всякой настройки. Если вы уже заменили генератор Swashbuckle на встроенный, это последний оставшийся у вас пакет Swashbuckle. Сторона генератора при такой замене разобрана в статье [как отдавать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Есть одна поведенческая деталь, о которой стоит знать до того, как заводить баг. Переход на `/scalar` выдаёт перенаправление на `/scalar/`, чтобы пути клиентских ресурсов разрешались корректно. Если у вас строгая политика перенаправлений, прокси, переписывающий завершающие слеши, или интеграционный тест, ожидающий 200 на `/scalar`, вы видите именно этот 301.

## Направить Scalar на документ, лежащий не по маршруту по умолчанию

`MapOpenApi` принимает шаблон маршрута, и множество проектов поменяли его много лет назад ради совместимости со старыми генераторами клиентов. Если ваш документ лежит по адресу `/swagger/v1/swagger.json` или если .NET 10 добавил вариант в YAML, который вы предпочли бы отдавать, укажите Scalar, где искать:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapOpenApi("/swagger/{documentName}/swagger.json");

app.MapScalarApiReference(options =>
{
    options
        .WithTitle("Orders API")
        .WithOpenApiRoutePattern("/swagger/{documentName}/swagger.json");
});
```

`WithOpenApiRoutePattern` принимает и абсолютный URL: так вы направляете хост документации на спецификацию, сгенерированную другим сервисом. Маршрут точно так же может указывать на файл, созданный на этапе сборки пакетом `Microsoft.Extensions.ApiDescription.Server` и отдаваемый как статический файл, если вы вообще не хотите запускать генератор во время выполнения.

Маршрут самого интерфейса задаётся первым аргументом `MapScalarApiReference`. Существует шесть перегрузок: с префиксом маршрута и без него, с делегатом настроек и без него, и с `HttpContext` в этом делегате или без него.

```csharp
// Program.cs -- .NET 11, C# 14
// Mount the reference at /api-docs and vary options per request
app.MapScalarApiReference("/api-docs", (options, httpContext) =>
{
    options.WithTitle($"Orders API ({httpContext.Request.Host})");
});
```

Перегрузка с `HttpContext` важнее, чем кажется. Это поддерживаемый способ вычислять настройки из входящего запроса: выбрать тему из cookie, подобрать список серверов по заголовку host или скрыть документы, которые вызывающей стороне видеть не положено.

Если вы переходите с кодовой базы на Scalar 1.x, учтите, что `ScalarOptions.EndpointPathPrefix` объявлен устаревшим. Префикс маршрута переехал в тот самый первый параметр, а значение по умолчанию сменилось с `/scalar/{documentName}` на просто `/scalar`. Старые обходные приёмы для вложенных путей, где вы вручную переписывали `OpenApiRoutePattern` для приложений, размещённых под path base, больше не нужны и должны быть удалены, поскольку относительное разрешение путей теперь берёт на себя библиотека.

## Несколько документов и версий API в одной боковой панели

Swagger UI выражал это повторными вызовами `SwaggerEndpoint` и выпадающим списком. Scalar выражает это как зарегистрированные документы:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

// ...

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options
        .AddDocument("v1", "Orders API v1")
        .AddDocument("v2", "Orders API v2 (beta)", isDefault: true);
});
```

Каждая перегрузка `AddDocument` принимает имя, необязательный отображаемый заголовок и необязательный шаблон маршрута, так что документы, живущие по разным путям, уживаются в одной справке. `AddDocuments(["v1", "v2", "v3"])` служит краткой формой, когда имён достаточно. Если вы генерируете по документу на версию API с помощью `Asp.Versioning`, именно эти имена сюда и попадают; специфичная для версионирования обвязка описана в статье [версионирование API с OpenAPI в .NET](/ru/2026/04/api-versioning-openapi-dotnet-10/).

Имена документов передаются генератору ровно в том виде, в каком вы их написали, включая регистр. Документ, зарегистрированный как `V1` и запрошенный как `v1`, даёт пустую справку, а не ошибку, потому что запрос документа просто возвращает 404, и интерфейсу нечего отрисовывать. Держите все имена документов в нижнем регистре, и эта проблема не возникнет никогда.

## Заставить кнопку Authorize отправлять настоящий токен

Это место вызывает больше всего путаницы, а правило простое: Scalar предзаполняет только те схемы безопасности, которые уже объявлены в вашем документе OpenAPI. Он не читает ваш middleware аутентификации и не может выдумать схему, которой документ не описывает. Если в документе нет записи `securitySchemes`, никакая клиентская настройка не приложит заголовок `Authorization`. Именно этот сбой я подробно разобрал в статье [почему ваш токен Bearer игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/), и диагноз с тех пор не поменялся.

Предположим, документ объявляет схему HTTP bearer с именем `BearerAuth`. Тогда следующий код выберет её заранее и подставит токен для разработки:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("BearerAuth")
        .AddHttpAuthentication("BearerAuth", auth =>
        {
            auth.Token = builder.Configuration["Scalar:DevToken"]!;
        });
});
```

Для потоков OAuth2 предусмотрены полноценные вспомогательные методы вместо плоской конфигурации вида "ключ-значение", которой пользовался Swagger UI. `AddAuthorizationCodeFlow`, `AddClientCredentialsFlow`, `AddPasswordFlow` и `AddImplicitFlow` принимают делегат настройки, а PKCE задаётся свойством, а не галочкой, соблюдение которой интерфейсом остаётся только надеяться:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("OAuth2")
        .AddAuthorizationCodeFlow("OAuth2", flow =>
        {
            flow.ClientId = builder.Configuration["Scalar:ClientId"]!;
            flow.Pkce = Pkce.Sha256;
            flow.SelectedScopes = ["orders.read", "orders.write"];
        });
});
```

Запомните две вещи. Во-первых, всё, что вы сюда передаёте, сериализуется в страницу, которую скачивает браузер, так что client secret, настроенный таким образом, является публичным. Собственная документация Scalar говорит, что предзаполненные данные аутентификации никогда не следует использовать в продакшене, и это не дежурная осторожность: относитесь к этим значениям так, как если бы вы вставили их в общедоступный HTML-файл, потому что вы это и сделали. Во-вторых, `EnablePersistentAuthentication()` сохраняет введённое пользователем в хранилище браузера между перезагрузками, что по-настоящему удобно на личном ноутбуке и по-настоящему неверно на общей машине.

Если вы одновременно настраиваете серверную сторону, статья [настройка аутентификации JWT bearer в minimal API](/ru/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) закрывает половину с проверкой токена, а само объявление схемы представляет собой трансформер документа, описанный в статье [настройка OpenAPI с помощью трансформеров операций и схем](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Держать справку вне продакшена, не теряя её совсем

Рекомендация Microsoft сформулирована прямо: пользовательские интерфейсы OpenAPI, включая Scalar, относятся только к средам разработки. Стандартная проверка из шаблона это обеспечивает:

```csharp
// Program.cs -- .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

У команд, которым нужна справка на внутреннем staging-хосте, есть вариант лучше проверки среды, и он существует именно потому, что Scalar является endpoint. `MapScalarApiReference` возвращает `IEndpointConventionBuilder`, поэтому применимы все соглашения маршрутизации:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference()
   .RequireAuthorization("InternalOnly")
   .ExcludeFromDescription();

app.MapOpenApi()
   .RequireAuthorization("InternalOnly");
```

Закрывайте оба. Защитить интерфейс, оставив `/openapi/v1.json` анонимным, не защищает ничего: раскрытием информации является документ, а интерфейс служит лишь средством его отрисовки. `ExcludeFromDescription()` не даёт endpoint документации попасть внутрь самой документации, что скорее аккуратно, чем важно.

## Ресурсы, офлайн-хостинг и шрифты, которые звонят домой

Scalar упаковывает свои JavaScript и CSS внутрь пакета NuGet и отдаёт их с вашего собственного источника, поэтому изолированная или офлайн-среда работает вообще без настройки. В самых ранних версиях 1.x это было не так, отсюда и живучее убеждение, будто Scalar требует CDN.

Единственным оставшимся внешним запросом остаётся веб-шрифт по умолчанию. Уберите его одним вызовом:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options.DisableDefaultFonts();
});
```

`WithBundleUrl("https://cdn.jsdelivr.net/npm/@scalar/api-reference")` работает в обратную сторону, подтягивая бандл с CDN, если вы предпочитаете следить за самой свежей версией интерфейса без обновления пакета. При строгой Content Security Policy `DisableDefaultFonts` вместе с упакованными ресурсами означает, что справке не нужно ничего, кроме `'self'` и встроенного скрипта конфигурации.

Настройки можно также привязывать из конфигурации, а не задавать в коде: это самый чистый способ держать значения, зависящие от среды, вне `Program.cs`:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOptions<ScalarOptions>().BindConfiguration("Scalar");
```

Всё, что задано в делегате `MapScalarApiReference`, перекрывает привязанные значения.

## Метаданные, специфичные для Scalar: стабильность, скрытые endpoint и примеры кода

Возможности, у которых нет аналога в Swagger UI, живут в сопутствующем пакете `Scalar.AspNetCore.Microsoft` (2.16.18, нацелен на `net9.0` и `net10.0`, зависит от `Microsoft.AspNetCore.OpenApi` и `Microsoft.OpenApi` 2.7.5 или выше). Он регистрирует трансформеры документа, которые записывают вендорные расширения Scalar в сгенерированный документ. Если вы всё ещё на генераторе Swashbuckle, ту же работу через фильтры выполняет `Scalar.AspNetCore.Swashbuckle`.

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore.Microsoft 2.16.18
builder.Services.AddOpenApi(options => options.AddScalarTransformers());

// ...

app.MapGet("/orders", GetOrders).Stable();
app.MapGet("/orders/forecast", GetForecast).Experimental();
app.MapGet("/internal/metrics", GetMetrics).ExcludeFromApiReference();
```

`ExcludeFromApiReference()` заслуживает отдельного упоминания. Он скрывает операцию в отрисованной справке, но оставляет её в документе OpenAPI и полностью доступной для маршрутизации, что отличается от `ExcludeFromDescription()`, который убирает её из документа целиком. Выбирайте исходя из того, нужно ли вашим генераторам клиентов по-прежнему видеть этот endpoint. `CodeSample()` прикрепляет написанный вручную фрагмент для заданного `ScalarTarget`, а `WithBadge()` ставит цветную метку рядом с операцией; оба доступны и как атрибуты на действиях контроллера, если вы не используете minimal API.

## Ловушки, которые стоят половины дня

**У пакета нет целевой платформы `net11.0`.** По состоянию на 2.16.18 список TFM заканчивается на `net10.0`, а проект `net11.0` использует ресурсы `net10.0` по обычным правилам совместимости. Это нормально и ожидаемо в период предварительных версий, но если ваша сборка падает из-за внутренней политики, требующей точного совпадения TFM, причина именно в этом.

**Пустая справка почти всегда означает отсутствующий документ, а не сломанный интерфейс.** Откройте `/openapi/v1.json` напрямую. Если он отдаёт 404, значит `MapOpenApi` не подключён, находится за другой проверкой среды, нежели интерфейс, или лежит по маршруту, о котором Scalar никто не сообщил. Во всех этих случаях справка отрисует пустую оболочку, а не ошибку.

**Генерация документа на этапе сборки не питает интерфейс.** Установка `OpenApiGenerateDocuments` в вашем `.csproj` пишет JSON-файл при сборке; во время выполнения она ничего не отдаёт. Если вы убрали `MapOpenApi`, потому что теперь генерируете на этапе сборки, отдавайте полученный файл как статический и направьте на него `WithOpenApiRoutePattern`.

**В `launchUrl` по-прежнему написано `swagger`.** После удаления middleware Swagger UI файл `Properties/launchSettings.json` будет открывать 404 при каждом `dotnet run`, пока вы не смените `"launchUrl": "swagger"` на `"launchUrl": "scalar"`.

**Native AOT здесь ничего не меняет.** Встроенный генератор совместим с AOT, а Scalar отдаёт статические ресурсы, так что эта пара переживает `PublishAot` без потерь. Под AOT обычно ломается написанный вами трансформер на рефлексии, а не интерфейс справки.

Swagger UI не устарел, и `Swashbuckle.AspNetCore.SwaggerUI` по-прежнему прекрасно работает поверх документа, созданного `Microsoft.AspNetCore.OpenApi`. Причина перейти в том, что Scalar является endpoint, а не middleware, поставляет свои ресурсы внутри пакета и предзаполняет аутентификацию через типизированный API вместо мешка строк. Если ничто из этого для вас не важно, остаться на месте будет вполне защитимым ответом.

## Похожие статьи

- [Как отдавать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Scalar в ASP.NET Core: почему ваш токен Bearer игнорируется](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Переход с Swashbuckle на встроенный генератор OpenAPI в .NET 11](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Как настроить документ OpenAPI трансформерами операций и схем](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Как добавить потоки аутентификации OpenAPI в Swagger UI в .NET 11](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)

## Источники

- [Использование сгенерированных документов OpenAPI](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0) на Microsoft Learn
- [Документация по интеграции Scalar с ASP.NET Core](https://scalar.com/products/api-references/integrations/aspnetcore/integration)
- [Расширения OpenAPI от Scalar для .NET](https://scalar.com/products/api-references/integrations/aspnetcore/openapi-extensions)
- [Руководство по миграции на Scalar.AspNetCore 2.0.0](https://github.com/scalar/scalar/issues/4362)
- [Scalar.AspNetCore на NuGet](https://www.nuget.org/packages/Scalar.AspNetCore)
