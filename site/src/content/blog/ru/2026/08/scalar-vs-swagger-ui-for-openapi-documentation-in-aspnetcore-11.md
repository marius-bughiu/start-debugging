---
title: "Scalar против Swagger UI для документации OpenAPI в ASP.NET Core 11"
description: "Scalar отдаёт 1.02 МиБ сжатого gzip JavaScript и заметно более удобный конструктор запросов. Swagger UI отдаёт 514 КиБ и рендерит OpenAPI 3.2, который .NET 11 теперь генерирует по умолчанию. Измеренные объёмы, разрыв по 3.2, маршрутизация через конечные точки с обеих сторон и детали аутентификации, которые решают выбор."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "ru"
translationOf: "2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Выбирайте **Scalar** (`Scalar.AspNetCore` 2.16.20) для нового API на .NET 11, если вашу документацию читают снаружи компании, потому что конструктор запросов, примеры кода на разных языках и поиск здесь действительно лучше всего, что делает Swagger UI. Выбирайте **Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI` 10.2.3, внутри которого swagger-ui 5.32.7), если вам нужен меньший объём загрузки, если вы полагаетесь на уже настроенный редирект-поток OAuth2 или если вам сегодня нужен уверенный рендеринг OpenAPI 3.2, потому что .NET 11 по умолчанию генерирует 3.2, а работа над 3.2 в Scalar остаётся открытой задачей. Оба проекта лицензированы под MIT, оба являются чистыми рендерерами и никак не влияют на ваш документ OpenAPI, и рекомендация Microsoft состоит в том, что ни один из них не должен быть доступен в продакшене.

Все измерения ниже выполнены на .NET SDK 10.0.201 с указанными версиями пакетов, 2026-08-15. Поверхность API одинакова с .NET 8 по .NET 11, потому что оба пакета поставляют сборки `net8.0`, `net9.0` и `net10.0` и берут ссылку на фреймворк `Microsoft.AspNetCore.App` вместо привязки к конкретной среде выполнения.

## Сравнение, которое вам кажется главным, на самом деле не главное

Начиная с .NET 9 команда `dotnet new webapi` не включает Swashbuckle. Документ генерирует `Microsoft.AspNetCore.OpenApi`, и он совместим с обрезкой и Native AOT. То есть выбор перед вами не "Swashbuckle или Scalar", а "какой бандл JavaScript отрендерит документ, который ваш фреймворк уже производит". Если генерацией у вас по-прежнему занимается `SwaggerGen` из Swashbuckle, это отдельное решение, описанное в статье [как отдавать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

У этого разделения есть практическое следствие. Метапакет `Swashbuckle.AspNetCore` тянет за собой `Swashbuckle.AspNetCore.Swagger`, `SwaggerGen` и `Microsoft.Extensions.ApiDescription.Server` вместе с интерфейсом. Если вам нужен только интерфейс, ссылайтесь напрямую на `Swashbuckle.AspNetCore.SwaggerUI`, и вместе с ним не придёт ничего лишнего.

```xml
<!-- .NET 11, C# 14: the UI only, no second document generator -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.2.3" />
</ItemGroup>
```

```xml
<!-- .NET 11, C# 14: the Scalar equivalent, one package, zero NuGet dependencies -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Scalar.AspNetCore" Version="2.16.20" />
</ItemGroup>
```

## Матрица

| | Scalar 2.16.20 | Swagger UI 5.32.7 (Swashbuckle 10.2.3) |
| --- | --- | --- |
| Байт по сети при первой загрузке (gzip) | 1 071 277 | 526 322 |
| JavaScript после распаковки | 3 711 КБ | 1 794 КБ |
| Регистрация | `app.MapScalarApiReference()` | `app.UseSwaggerUI(...)` или `app.MapSwaggerUI(...)` |
| Маршрутизация через конечные точки | Да, начиная с 1.x | Да, начиная с 10.2.0 (май 2026) |
| OpenAPI 3.2 | Парсер справляется, полная поддержка в открытой задаче | Базовая поддержка начиная с swagger-ui 5.32.0 |
| Примеры кода | Более 20 целей (curl, fetch, axios, Python, Go, Java, PHP, Ruby и другие) | curl для запроса, который вы только что отправили |
| Кеширование ресурсов | `Cache-Control: no-cache` плюс ETag, зашито в коде | ETag по умолчанию, `max-age` если задать `CacheLifetime` |
| Сохранение учётных данных | `persistAuth` пишет в local storage | `PersistAuthorization` в объекте конфигурации |
| Try It между источниками | Опциональный `proxyUrl` | Прямой fetch из браузера, CORS ваша забота |
| Темы | 12 встроенных тем, `customCss`, плагины | `InjectStylesheet`, `InjectJavascript`, система плагинов swagger-ui |
| Лицензия | MIT | MIT |

## Сколько каждый вариант стоит браузеру, с измерениями

Оба пакета встраивают свои ресурсы в сборку как потоки gzip и отдают эти байты напрямую клиенту, который объявляет `Accept-Encoding: gzip`. Интеграция Scalar с ASP.NET Core проверяет `IsGzipAccepted()` и выставляет `Content-Encoding` плюс `Vary: Accept-Encoding` из сохранённого ресурса. Middleware интерфейса Swashbuckle несёт ту же механику (`IsGZipAccepted`, `GZipStream` в режиме распаковки для редкого клиента, который откажется). Значит, размеры сохранённых ресурсов и есть размеры передачи, и прочитать их из пакетов можно, ничего не запуская:

```csharp
// .NET SDK 10.0.201, run as a file-based app: dotnet run res.cs <dll>
using System.Reflection;

var asm = Assembly.LoadFrom(args[0]);
foreach (var name in asm.GetManifestResourceNames())
{
    using var s = asm.GetManifestResourceStream(name);
    Console.WriteLine($"{s?.Length,10}  {name}");
}
```

Scalar отдаёт три ресурса, и только два из них код:

```text
   1070166  ScalarStaticAssets.scalar.js
      1111  ScalarStaticAssets.scalar.aspnetcore.js
       533  ScalarStaticAssets.favicon.svg
```

`index.html` из Swashbuckle подтягивает бандл, standalone-пресет, таблицу стилей и собственный инициализатор:

```text
    421507  swagger-ui-bundle.js
     77731  swagger-ui-standalone-preset.js
     26499  swagger-ui.css
       433  index.js
       152  index.css
       739  index.html
```

Это 1 071 277 байт у Scalar против 526 322 байт у Swagger UI, разница в 2.0 раза по сети. В распакованном виде `scalar.js` это 3 708 228 байт JavaScript, которые браузер обязан разобрать, против 1 793 552 байт у бандла и пресета Swagger UI. Более современный на вид вариант оказывается тяжёлым, что противоположно тому, о чём пишет большинство обзоров.

Две оговорки, прежде чем придавать этому слишком большой вес. Во-первых, это инструмент разработки: байты приходят на вашу машину через loopback один раз за холодную загрузку. Во-вторых, файл `swagger-ui.js` из Swashbuckle (92 466 байт) лежит в пакете и страницей по умолчанию не используется, так что цифра выше это то, что реально загружается, а не то, что поставляется. Если вы отдаёте любой из интерфейсов по настоящей сети, [сравнение сжатия ответов](/ru/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) здесь не поможет: оба пакета уже сжали эти ресурсы самостоятельно, а повторно сжимать ответ с `Content-Encoding: gzip` middleware не станет.

Кеширование это та часть, которая мешает каждый день. Свойство `SwaggerUIOptions.CacheLifetime` документирует значение по умолчанию как "0 days (ETags are used to check if resources have been updated)", то есть из коробки оба интерфейса делают повторную проверку. Разница в том, что Swashbuckle позволяет включить настоящее кеширование, а Scalar нет: его обработчик статических ресурсов жёстко выставляет `Cache-Control: no-cache` и отвечает на совпавший `If-None-Match` кодом 304. Вы платите один круговой обход на ресурс на каждую загрузку страницы, всегда.

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.CacheLifetime = TimeSpan.FromDays(7); // 304s become cache hits
});
```

## Нюанс .NET 11: ваш документ теперь 3.2

Это тот факт, который должен определять решение в августе 2026 года, и его почти никто не записал. Microsoft Learn формулирует прямо: "Starting in .NET 11, the default OpenAPI version for generated documents is 3.2. In .NET 10, the default is 3.1." Обновите API с .NET 10 до .NET 11, больше ничего не меняя, и документ, который должен отрисовать ваш интерфейс, сменит версию спецификации.

Со стороны Swagger UI версия swagger-ui 5.32.0 (27 февраля 2026 года) принесла "basic OpenAPI 3.2.0 support", а Swashbuckle 10.2.3 поставляет 5.32.7, так что рендерер хотя бы понимает, на что смотрит. Со стороны Scalar пакет `@scalar/openapi-parser` понимает 3.2, но отслеживающая задача [scalar/scalar#6715](https://github.com/scalar/scalar/issues/6715) всё ещё открыта, и в ней пункты "set OpenAPI 3.2 as the default version" и рендеринг глубоко вложенных тегов в боковой панели значатся как незавершённые по состоянию на последнее обновление 30 июня 2026 года.

На практике документ, сгенерированный из конечных точек minimal API, между 3.1 и 3.2 меняется очень мало, поэтому большинство приложений не увидит никакой разницы. Если же боковая панель группирует неправильно или схема отрисовывается пустой, зафиксируйте версию вместо того, чтобы заводить баг на интерфейс:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    // .NET 11 defaults to OpenApi3_2; pin 3.1 while a renderer catches up
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
});
```

Тот же рычаг есть для генерации во время сборки через свойство MSBuild `OpenApiGenerateDocumentsOptions` со значением `--openapi-version OpenApi3_1`. Фиксация сегодня ничего не стоит: ничто в документе, сгенерированном ASP.NET Core, пока не зависит от возможностей 3.2.

## Middleware или конечная точка, теперь с обеих сторон

Самым сильным архитектурным аргументом за Scalar раньше было то, что `MapScalarApiReference` регистрирует конечную точку, а `UseSwaggerUI` регистрирует middleware, и middleware завершает запрос до того, как маршрутизация конечных точек получит слово. Этот аргумент устарел в мае 2026 года. Swashbuckle 10.2.0 добавил `MapSwaggerUI` и `MapReDoc` "to support endpoint routing". Оба интерфейса теперь могут нести метаданные конечной точки, попадать в `EndpointDataSource` и принимать соглашения маршрутизации напрямую:

```csharp
// Program.cs -- .NET 11, C# 14
// Scalar: MapScalarApiReference returns an IEndpointConventionBuilder
app.MapScalarApiReference()
   .RequireAuthorization("ApiDocsPolicy");

// Swashbuckle 10.2.0+: same shape
app.MapSwaggerUI()
   .RequireAuthorization("ApiDocsPolicy");
```

Если вы за обратным прокси, учтите: HTML-эндпоинт Scalar перенаправляет запрос на `/scalar` на адрес `/scalar/` кодом 301, чтобы относительные пути к ресурсам разрешались, а middleware Swashbuckle перенаправляет запрос на голый префикс маршрута на `index.html` тем же кодом 301. Интеграционный тест, ожидающий 200 на голом пути, упадёт на любом из двух.

## Authorize и то, что происходит после нажатия

Оба интерфейса читают схемы безопасности из документа и ни одна из них их не придумывает. Документация самого Scalar высказывается прямо: ваш документ OpenAPI уже должен содержать схемы, чтобы Scalar мог с ними работать. Если вы их туда не положили, нужный механизм описан в статье о [трансформерах операций и схем](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

Отличается эргономика после этого. Scalar предзаполняет учётные данные из серверной конфигурации и умеет сохранять их между перезагрузками:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.20
app.MapScalarApiReference(options =>
{
    options.AddPreferredSecuritySchemes("Bearer")
           .AddHttpAuthentication("Bearer", auth => auth.WithToken(devToken));
    options.PersistentAuthentication = true;
});
```

Эквивалент в Swagger UI живёт в объекте конфигурации, а для OAuth2 в странице `oauth2-redirect.html`, которую Swashbuckle встраивает за вас (664 байта скрипта редиректа, который используется уже десятилетие):

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.OAuthClientId("dev-client");
    options.OAuthUsePkce();
    options.EnablePersistAuthorization();
});
```

Единственная возможность, которая есть у Scalar и которой нет у Swagger UI, это `proxyUrl`. Try It в Swagger UI выполняет `fetch` из источника документации, поэтому API на другом источнике без разрешающего CORS выдаёт ошибку браузера, похожую на отказ сервера. Scalar может пропустить запрос через прокси. Если ваша документация размещена отдельно от API, эта единственная опция и решает выбор.

## Примеры кода это настоящая продуктовая разница

Swagger UI показывает команду curl для запроса, который вы только что выполнили. Scalar отрисовывает запрос во всех известных ему клиентах ещё до отправки: shell (curl, httpie), JavaScript (fetch, axios, jquery), Node, Python, Go, Java, Ruby, PHP и другие, что управляется через `hiddenClients` и `defaultHttpClient`. Для внутреннего API, который читают те же люди, что его написали, это украшение. Для публичного API, где читатель решает, легко ли интегрировать ваш продукт, это вся страница целиком.

Scalar также даёт `searchHotKey` (по умолчанию CMD/CTRL+K), двенадцать встроенных тем, `customCss` и хук `/scalar/config.js` для произвольной клиентской конфигурации. Настройка Swagger UI идёт через `InjectStylesheet`, `InjectJavascript` и систему плагинов swagger-ui, которая мощнее и гораздо менее приятна, и это честное резюме всего сравнения.

## Когда выбирать каждый вариант

Выбирайте Scalar, когда документация это часть продукта, когда читатели вне вашей команды, когда вам нужны конструктор запросов и примеры кода, или когда документация размещена на другом источнике, чем API, и вам нужен прокси.

Выбирайте Swagger UI, когда вам нужен наименьший объём загрузки и настоящее кеширование по `max-age`, когда у вас есть работающая настройка OAuth2, когда кто-то в команде зависит от плагина swagger-ui, или когда вам нужен рендерер с явной поддержкой 3.2, пока .NET 11 по умолчанию генерирует 3.2.

Не выбирайте ни один и возьмите `Swashbuckle.AspNetCore.ReDoc` или расширение редактора, когда документ потребляют сгенерированные клиенты, а не люди. Нет правила, по которому API обязан иметь отрисованный справочник.

Что бы вы ни выбрали, Microsoft Learn излагает позицию по безопасности недвусмысленно: пользовательские интерфейсы OpenAPI следует включать только в средах разработки. Оба пакета сводят это к однострочной проверке окружения, а пошаговая версия такой настройки, включая закрытие в продакшене и офлайн-ресурсы, описана в [руководстве по Scalar](/ru/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/).

## Детали, которые решают за вас

- **Метапакет.** `Swashbuckle.AspNetCore` 10.2.3 тянет `SwaggerGen` и `Microsoft.Extensions.ApiDescription.Server`. Если вы перешли на встроенный генератор, у вас теперь два генератора, и один из них устаревший. Ссылайтесь на `Swashbuckle.AspNetCore.SwaggerUI` отдельно. Полный путь удаления описан в статье [переход с Swashbuckle на встроенный генератор OpenAPI](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).
- **Ни один пакет не таргетирует `net11.0`.** Оба поставляют сборки `net8.0`, `net9.0` и `net10.0` со ссылкой на фреймворк. Ресурс `net10.0` работает на .NET 11 благодаря roll-forward, это нормально, но означает, что исправления специально под `net11.0` ждать не стоит ни от одного проекта.
- **Ресурсы Scalar никогда не кешируются.** `Cache-Control: no-cache` не настраивается через опции. На медленном канале к общему окружению разработки вы платите повторной проверкой за каждый ресурс при каждой загрузке.
- **Завершающий слеш.** Оба интерфейса отвечают кодом 301 на голом пути. Строгие прокси и интеграционные тесты это замечают.
- **Заголовок версии Swagger UI.** Swashbuckle добавляет `x-swagger-ui-version` к ответам с ресурсами, что удобно для проверки того, что реально поставлено, и что часть сканеров отметит как раскрытие информации. Ещё один довод за проверку окружения.

Между двумя рендерерами одного и того же документа под лицензией MIT это обратимое решение: одна строка в `Program.cs` и одна ссылка на пакет переносят вас в любую сторону минут за пять. Выбирайте по читателю, а не по фреймворку.

## Похожие статьи

- [Как отдавать документацию OpenAPI через Scalar вместо Swagger UI в ASP.NET Core 11](/ru/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) это полная настройка: маршрутизация, несколько документов, аутентификация и закрытие в продакшене.
- [Как отдавать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) покрывает генераторную половину этого разделения.
- [Переход с Swashbuckle на встроенную генерацию документов OpenAPI в .NET 11](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) это чек-лист удаления.
- [Как настроить документ OpenAPI через AddOperationTransformer и AddSchemaTransformer](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) показывает, как схемы безопасности вообще попадают в документ.
- [Zstandard против Brotli и Gzip при сжатии ответов в .NET 11](/ru/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) объясняет, почему предварительно сжатые статические ресурсы полностью обходят middleware сжатия.

## Источники

- [Use the generated OpenAPI documents (Microsoft Learn, ASP.NET Core 11)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-11.0)
- [Generate OpenAPI documents, default version 3.2 in .NET 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-11.0)
- [OpenApiSpecVersion enum, including OpenApi3_2 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.openapi.openapispecversion)
- [Swashbuckle.AspNetCore v10.2.0 release notes, MapSwaggerUI and MapReDoc](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.2.0)
- [Swashbuckle.AspNetCore.SwaggerUI 10.2.3 on NuGet](https://www.nuget.org/packages/Swashbuckle.AspNetCore.SwaggerUI/10.2.3)
- [swagger-ui v5.32.0 release, basic OpenAPI 3.2.0 support](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.0)
- [Scalar.AspNetCore 2.16.20 on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore/2.16.20)
- [Scalar .NET integration documentation](https://scalar.com/scalar/scalar-api-references/net-integration)
- [Scalar API reference configuration options](https://scalar.com/scalar/scalar-api-references/configuration)
- [OpenAPI 3.2 support tracking issue (scalar/scalar#6715)](https://github.com/scalar/scalar/issues/6715)
