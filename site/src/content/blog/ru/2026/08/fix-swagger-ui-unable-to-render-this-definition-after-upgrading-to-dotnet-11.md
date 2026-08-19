---
title: "Исправление: Swagger UI показывает Unable to render this definition после обновления до .NET 11"
description: "ASP.NET Core 11 по умолчанию выдаёт openapi 3.2.0, а Swagger UI ниже 10.1.5 его отвергает. Обновите Swashbuckle.AspNetCore.SwaggerUI или зафиксируйте OpenApiVersion на OpenApi3_1."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "openapi"
  - "swagger"
  - "swashbuckle"
  - "aspnetcore"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-19
---

Приложение по-прежнему запускается, `/openapi/v1.json` по-прежнему возвращает 200, но страница Swagger UI показывает серый блок с сообщением о том, что определение не задаёт корректное поле версии. Причина в изменившемся значении по умолчанию в .NET 11: `AddOpenApi` теперь пишет `"openapi": "3.2.0"` вместо `"openapi": "3.1.1"`, а сборка Swagger UI, поставляемая в `Swashbuckle.AspNetCore.SwaggerUI` 10.1.4 и ниже, принимает только `3.0.x` и `3.1.x`. Обновите этот пакет до 10.1.5 или новее либо задайте `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1`. Ни конечные точки, ни трансформеры, ни схемы при этом не сломаны.

Всё изложенное ниже измерено на .NET SDK `11.0.100-preview.7.26381.103` с `Microsoft.AspNetCore.OpenApi` `11.0.0-preview.7.26381.103` (который разрешается в `Microsoft.OpenApi` 3.9.0) в сравнении с .NET SDK 10.0.201 и `Microsoft.AspNetCore.OpenApi` 10.0.10.

## Ошибка в контексте

Swagger UI заменяет весь список операций такой панелью:

```text
Unable to render this definition

The provided definition does not specify a valid version field.

Please indicate a valid Swagger or OpenAPI version field. Supported version
fields are swagger: "2.0" and those that match openapi: 3.x.y (for example,
openapi: 3.1.0).
```

Формулировка вводит в заблуждение дважды. Поле версии в документе есть, и `3.2.0` действительно соответствует форме `3.x.y`, которую описывает сообщение. На деле сборка сравнивает мажорную и минорную части со фиксированным белым списком, и в старых сборках `3.2` в него не входит.

Никакого серверного исключения искать не нужно. Конечная точка документа работает нормально:

```bash
curl -s http://localhost:5331/openapi/v1.json | head -3
```

```json
{
  "openapi": "3.2.0",
  "info": {
```

Эта первая строка и есть вся проблема. Если вы видите там `3.2.0` и серый блок в браузере, вы попали на нужную страницу.

## Почему .NET 11 выдаёт openapi 3.2.0

`OpenApiOptions.OpenApiVersion` в .NET 11 Preview 6 сменил значение по умолчанию с `OpenApiSpecVersion.OpenApi3_1` на `OpenApiSpecVersion.OpenApi3_2`. Microsoft описывает это как намеренное изменение поведения, чтобы приложения переходили на новейшую спецификацию без дополнительной настройки ([OpenApiVersion по умолчанию равен OpenApi3_2](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0)).

Это значение стало достижимым благодаря второму изменению, сделанному одной preview раньше: в .NET 11 Preview 3 пакет `Microsoft.AspNetCore.OpenApi` перешёл с `Microsoft.OpenApi` 2.x на 3.x, и именно линейка 3.x добавила сериализаторы для OpenAPI 3.2.0 ([Microsoft.OpenApi обновлён до 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)). Фиксация зависимости видна в самом пакете: `Microsoft.AspNetCore.OpenApi` 11.0.0-preview.7 объявляет `Microsoft.OpenApi` `[3.9.0, 4.0.0)`, тогда как 10.0.10 объявлял `2.0.0`.

Важное следствие в том, что строка версии изменилась, а сам документ нет. Подробнее об этом ниже.

## Минимальное воспроизведение

Достаточно трёх строк API и одной регистрации Swagger UI.

```xml
<!-- net11.0, .NET SDK 11.0.100-preview.7.26381.103 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0-preview.7.26381.103" />
    <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.OpenApi 11.0.0-preview.7.26381.103
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));

app.MapGet("/todos/{id:int}", (int id) => new Todo(id, "write post", Status.Open, null));
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.Run();

internal enum Status { Open, Done }
internal record Todo(int Id, string Title, Status Status, DateTimeOffset? DueAt);
```

Откройте `/swagger`, и вы получите серый блок. Ничего в консоли, ничего в логах, HTTP 200 и на странице, и на документе.

Обратите внимание, что `Swashbuckle.AspNetCore.SwaggerUI` это отдельный пакет. Генератор Swashbuckle для этой ошибки не нужен: документ здесь создаёт встроенный генератор, а от Swashbuckle приходят только ресурсы интерфейса. Если вы следовали руководству по [публикации OpenAPI без Swashbuckle](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/), но оставили привычную страницу `/swagger`, у вас именно эта конфигурация.

## Какая версия Swagger UI первой отображает документ 3.2.0

Я перебрал версии пакета на одном и том же документе 3.2.0. Граница проходит по `Swashbuckle.AspNetCore.SwaggerUI` 10.1.5:

| Пакет SwaggerUI | Встроенный swagger-ui | Отображает `openapi: 3.2.0` |
| --- | --- | --- |
| 9.0.6 | 5.29.1 | Нет |
| 10.0.0 | 5.30.2 | Нет |
| 10.1.0 | 5.31.0 | Нет |
| 10.1.4 | 5.31.1 | Нет |
| 10.1.5 | 5.32.0 | Да |
| 10.1.7 | 5.32.1 | Да |
| 10.2.3 | 5.32.7 | Да |

Начиная с 10.1.5 бейдж в заголовке показывает `OAS 3.2`, а все операции и схемы отображаются нормально. Поэтому первое исправление это однострочное обновление пакета:

```xml
<!-- first version whose bundled swagger-ui accepts 3.2.0 -->
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.1.5" />
```

Предпочтите именно его. Он оставляет документ на новейшей спецификации и ничего не стоит, потому что `Swashbuckle.AspNetCore.SwaggerUI` поставляет только статические ресурсы и одно расширение middleware. Если же вы ссылаетесь на полный метапакет `Swashbuckle.AspNetCore`, обновление до 10.2.x принесёт те же ресурсы интерфейса, но потянет за собой и генератор; прежде чем переходить эту границу, прочитайте заметки о [фиксации строки версии OpenAPI, которую выдаёт Swashbuckle](/ru/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/).

## Как вернуть документ на OpenAPI 3.1

Если пакет интерфейса подвинуть нельзя или что-то ещё ниже по цепочке тоже отвергает 3.2, задайте версию генератору явно:

```csharp
// .NET 11, C# 14. Microsoft.OpenApi 3.9.0 supplies OpenApiSpecVersion.
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
});
```

Директива `using Microsoft.OpenApi;` здесь существенна: `OpenApiSpecVersion` живёт в плоском корневом пространстве имён, а не в `Microsoft.OpenApi.Models`, которое убрали ещё в линейке 2.x, поставлявшейся с .NET 10.

С этой опцией .NET 11 пишет `"openapi": "3.1.2"`, и `Swashbuckle.AspNetCore.SwaggerUI` 9.0.6 отображает его с бейджем `OAS 3.1`. Обратите внимание на patch-часть: .NET 10 писал `3.1.1`, а .NET 11 с тем же значением перечисления пишет `3.1.2`. Потребители, которые сравнивают строку версии целиком, а не мажор и минор, всё равно споткнутся. `OpenApiSpecVersion.OpenApi3_0` тоже по-прежнему принимается и даёт `3.0.4`.

Можно зарегистрировать несколько именованных документов, если разным потребителям нужны разные версии:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("v1");                                   // 3.2.0
builder.Services.AddOpenApi("v1-31", o =>
    o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);               // 3.1.2
```

Это даёт `/openapi/v1.json` и `/openapi/v1-31.json` из одних и тех же метаданных конечных точек, так что устаревший генератор клиентов может и дальше потреблять 3.1, пока интерфейс и новые клиенты читают 3.2.

## Что на самом деле лежит внутри документа 3.2.0

Это стоит усвоить до того, как вы потратите вечер на аудит трансформеров: для обычного minimal API документ 3.2.0 и документ 3.1.2 идентичны, если не считать строки версии.

Я сгенерировал все три версии из одного приложения (record с int, string, enum, обнуляемым `DateTimeOffset` и загрузкой через `IFormFile`) и сравнил их. Разница между 3.1 и 3.2 составила две строки: поле `openapi` и заголовок документа. Ни одна схема, ни один параметр, ответ или компонент не изменились.

А вот разница между 3.0 и 3.1 реальна, потому что именно там произошло согласование с JSON Schema:

```json
// OpenAPI 3.0.4
"dueAt": { "type": "string", "format": "date-time", "nullable": true }
```

```json
// OpenAPI 3.1.2 and 3.2.0
"dueAt": { "type": ["null", "string"], "format": "date-time" }
```

Поэтому если после обновления до .NET 11 у вас ломается генератор клиентов и вы "чините" его откатом на `OpenApi3_0`, вы меняете кодирование обнуляемости у каждого необязательного свойства в контракте. Откатывайтесь на `OpenApi3_1`: это та версия, полезная нагрузка которой побайтово совпадает с тем, что вы уже отдавали на .NET 10.

## Есть ли та же проблема в Scalar

Если вы отдаёте справочник через [Scalar вместо Swagger UI](/ru/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), эта ошибка до вас не доходит. Я прогнал то же приложение на .NET 11 с `Scalar.AspNetCore` 2.16.20 и 2.14.14, и обе версии отобразили документ 3.2.0, напечатав `OpenAPI 3.2.0` в заголовке.

Это верно, хотя граф NuGet выглядит тревожно. У `Scalar.AspNetCore.Microsoft` 2.16.20 вообще нет целевой группы `net11.0`, поэтому проект `net11.0` разрешает её ресурсы для `net10.0`, скомпилированные против `Microsoft.OpenApi` 2.7.5 и затем загружаемые в среде выполнения против унифицированной сборки 3.9.0. Это ровно тот риск бинарной совместимости, о котором предупреждает заметка о критическом изменении Microsoft.OpenApi 3.x, и здесь он безобиден: `AddScalarTransformers()` и `ExcludeFromApiReference()` отработали и выдали ожидаемое расширение `x-scalar-ignore`.

То же относится и к написанным вручную трансформерам. Трансформер документа, регистрирующий схему безопасности bearer, и трансформер схемы, проставляющий `x-schema-id`, оба написанные для .NET 10 против `Microsoft.OpenApi` 2.x, скомпилировались и отработали без изменений на .NET 11 с 3.9.0. Если ваши трансформеры в основном читают либо только задают расширения и схемы безопасности, закладывайте нулевые затраты на переход с 2.x на 3.x. Если же они обходят вложенные схемы, конструируют ссылки или использовали удалённую инфраструктуру разбора `ParseNode`, сначала прочитайте [справочник по конвейеру трансформеров](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) и заметки о миграции OpenAPI.NET.

## Какие похожие сбои не являются этой ошибкой

**Пустая страница вообще без серого блока.** Это другой сбой: интерфейс так и не получил документ. Проверьте маршрут. `MapOpenApi` отдаёт `/openapi/{documentName}.json`, и если вы изменили шаблон, интерфейсу об этом надо сообщить, через `SwaggerEndpoint` или через `WithOpenApiRoutePattern` в Scalar. Прежде чем винить версии, запросите через curl тот URL JSON, который страница запрашивает на самом деле.

**HTTP 500 на URL документа.** Значит, трансформер выбросил исключение и отображать было нечего. Самый частый случай вовсе не регрессия .NET 11: `OpenApiSchema.Extensions` равен `null`, пока вы туда не присвоите, и в `Microsoft.OpenApi` 2.x, и в 3.x, так что `schema.Extensions["x-foo"] = ...` одинаково выбрасывает `NullReferenceException` на .NET 10 и на .NET 11. Подстрахуйтесь:

```csharp
// .NET 11, C# 14, Microsoft.OpenApi 3.9.0
options.AddSchemaTransformer((schema, context, ct) =>
{
    schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
    schema.Extensions["x-schema-id"] =
        new JsonNodeExtension(JsonValue.Create(context.JsonTypeInfo.Type.Name));
    return Task.CompletedTask;
});
```

**`error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only`.** Вот это уже настоящий побочный эффект .NET 11, и проявляется он в смешанных решениях. Если проект `net10.0` в итоге разрешает `Microsoft.OpenApi` 3.9.0, через централизованное управление пакетами, плавающую версию или общую ссылку из приложения `net11.0`, генератор исходного кода XML-комментариев OpenAPI из .NET 10 SDK не компилируется против объектной модели 3.x. Держите проекты `net10.0` на `Microsoft.OpenApi` 2.x, а не поднимайте всё решение на одну версию.

**`System.MissingMethodException: Method not found: '... Microsoft.OpenApi.OpenApiOperation.get_Extensions()'`.** Это режим отказа по бинарной совместимости: какая-то библиотека в вашем графе скомпилирована против поверхности `Microsoft.OpenApi`, которой больше нет во время выполнения. Само по себе обновление до .NET 11 его не вызывает; ищите пакет, зафиксированный сильно позади остальных, или явную ссылку на `Microsoft.OpenApi` в вашем csproj, конфликтующую с транзитивной.

## Связанное

- [Как опубликовать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Исправление: не удаётся нацелиться на OpenAPI 3.0 после обновления Swashbuckle.AspNetCore до v9](/ru/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)
- [Как настроить документ OpenAPI через AddOperationTransformer и AddSchemaTransformer](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Как отдавать документацию OpenAPI через Scalar вместо Swagger UI](/ru/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)
- [Миграция со Swashbuckle на встроенный генератор OpenAPI в .NET 11](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)

## Источники

- [Критическое изменение: OpenApiVersion по умолчанию равен OpenApi3_2](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0), Microsoft Learn
- [Критическое изменение: Microsoft.OpenApi обновлён до 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0), Microsoft Learn
- [Генерация документов OpenAPI](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0), Microsoft Learn
- [Заметки о выпусках OpenAPI.NET](https://github.com/microsoft/OpenAPI.NET/releases), microsoft/OpenAPI.NET на GitHub
- [Scalar.AspNetCore.Microsoft падает на трансформерах](https://github.com/scalar/scalar/issues/6020), issue 6020 в scalar/scalar
