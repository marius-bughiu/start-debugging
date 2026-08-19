---
title: "Решение: не удаётся получить OpenAPI 3.0 после обновления Swashbuckle.AspNetCore до v9"
description: "Swashbuckle 8 и новее выдают openapi 3.0.4, а не 3.0.1, и значения OpenApiSpecVersion для patch-версии не существует. Почему так вышло и четыре способа зафиксировать нужную строку."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore"
translatedBy: "claude"
translationDate: 2026-08-19
---

Вы обновили `Swashbuckle.AspNetCore` до 9.x, в коде по-прежнему стоит `OpenApiSpecVersion.OpenApi3_0`, а сгенерированный документ теперь содержит `"openapi": "3.0.4"` вместо `"openapi": "3.0.1"`. Потребители документа его отвергают, а члена `OpenApi3_0_1` в перечислении просто нет. Строка версии зашита константой внутри `Microsoft.OpenApi`, это не настройка Swashbuckle: 1.6.22 и более ранние пишут `3.0.1`, 1.6.23 и более поздние пишут `3.0.4`. Именно Swashbuckle 8.0.0 взял зависимость на 1.6.23, поэтому изменение затрагивает всех, кто пересекает границу 7.x. Решения ниже по порядку: обновить потребителя, переписать свойство самостоятельно в middleware или зафиксировать весь стек Swashbuckle на 7.2.0.

Всё описанное измерено на .NET SDK 10.0.201 для `net10.0`, с Swashbuckle.AspNetCore 6.5.0, 7.2.0, 8.1.4, 9.0.6 и 10.2.3.

## Ошибки в контексте

Попытка запросить patch-версию напрямую через CLI:

```text
System.NotSupportedException: The specified OpenAPI version "3.0.1" is not supported.
   at Swashbuckle.AspNetCore.Cli.Program.<>c.<Main>b__1_5(IDictionary`2 namedArgs)
   at Swashbuckle.AspNetCore.Cli.CommandRunner.Run(IEnumerable`1 args)
   at Swashbuckle.AspNetCore.Cli.Program.Main(String[] args)
```

Попытка удержать `Microsoft.OpenApi`, оставив Swashbuckle 9:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.OpenApi from 1.6.25 to 1.6.22.
  Reference the package directly from the project to select a different version.
   MyApi -> Swashbuckle.AspNetCore 9.0.6 -> Swashbuckle.AspNetCore.Swagger 9.0.6 -> Microsoft.OpenApi (>= 1.6.25)
   MyApi -> Microsoft.OpenApi (>= 1.6.22)
```

А если заглушить NU1605 и всё же попробовать:

```text
error CS1705: Assembly 'Swashbuckle.AspNetCore.SwaggerGen' with identity
'Swashbuckle.AspNetCore.SwaggerGen, Version=9.0.6.0, ...' uses 'Microsoft.OpenApi, Version=1.6.25.0, ...'
which has a higher version than referenced assembly 'Microsoft.OpenApi' with identity
'Microsoft.OpenApi, Version=1.6.22.0, ...'
```

Старые сборки Swagger UI отображают документ так:

```text
Unable to render this definition
The provided definition does not specify a valid version field.
Please indicate a valid Swagger or OpenAPI version field. Supported version fields are
swagger: "2.0" and those that match openapi: 3.x.y (for example, openapi: 3.1.0).
```

## Почему строка версии равна 3.0.4, а не тому, чем я управляю?

`OpenApiSpecVersion` это небольшое перечисление, и ни один из его членов не несёт номер patch-версии. В `Microsoft.OpenApi` 1.6.25, от которого зависит Swashbuckle 9.0.6, у него ровно два члена:

```text
OpenApi2_0
OpenApi3_0
```

В `Microsoft.OpenApi` 2.7.5, от которого зависит Swashbuckle 10.2.3, добавляется ещё один:

```text
OpenApi2_0
OpenApi3_0
OpenApi3_1
```

Членов 3.0.1, 3.0.3 или 3.0.4 нет, потому что patch-версия не является опцией сериализатора. `OpenApiDocument.SerializeAsV3` пишет константу времени компиляции. Изменение видно по дампу строк из поставляемых сборок:

```text
strings -a -e l on lib/netstandard2.0/Microsoft.OpenApi.dll:
  1.2.3   -> 3.0.1
  1.6.22  -> 3.0.1
  1.6.23  -> 3.0.4
  1.6.25  -> 3.0.4
  2.7.5   -> 3.0.4 and 3.1.1
```

Изменение пришло в [OpenAPI.NET PR #2011](https://github.com/microsoft/OpenAPI.NET/pull/2011), влитом 2024-12-20, который перенёс поведение v2 в ветку v1. Это не баг: OpenAPI 3.0.4 это настоящий patch-релиз спецификации, и выдавать самый свежий patch правильно по умолчанию. Проблема в том, что многие потребители проверяют поле `openapi` по жёстко заданному списку допустимых значений, а не по шаблону `3.0.x`.

## Какая версия Swashbuckle выдаёт какую patch-версию?

Поле `openapi` следует за той сборкой `Microsoft.OpenApi`, которая реально разрешилась, а не за версией Swashbuckle, записанной в csproj:

| Swashbuckle.AspNetCore | Microsoft.OpenApi (объявленная) | поле `openapi` |
| --- | --- | --- |
| 6.5.0 | 1.2.3 | `3.0.1` |
| 7.2.0 | 1.6.22 | `3.0.1` |
| с 8.0.0 по 8.1.4 | 1.6.23 | `3.0.4` |
| с 9.0.0 по 9.0.6 | с 1.6.23 по 1.6.25 | `3.0.4` |
| с 10.0.0 по 10.2.3 | с 2.3.0 по 2.7.5 | `3.0.4`, либо `3.1.1` с `OpenApi3_1` |

Два замечания. Во-первых, настоящая граница это 8.0.0, а не 9.0.0: если вы прыгнули с 7.x сразу на 9.x, вы пересекли её незаметно. Во-вторых, зависимость NuGet задаёт нижнюю границу, а не фиксирует версию. Проект на Swashbuckle 7.2.0, который дополнительно ссылается на что-то, тянущее `Microsoft.OpenApi` 1.6.23 или новее, разрешится в более новую сборку и начнёт выдавать `3.0.4` вообще без изменений Swashbuckle. Если документ изменился, а версия Swashbuckle нет, сначала выполните это:

```bash
dotnet list package --include-transitive
```

## Минимальное воспроизведение на net10.0

```csharp
// .NET SDK 10.0.201, net10.0, Swashbuckle.AspNetCore 9.0.6
using Microsoft.OpenApi;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "Demo", Version = "v1" }));

var app = builder.Build();
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.MapGet("/orders/{id}", (int id) => new Order(id, "open", null)).WithName("GetOrder");
app.Run();

record Order(int Id, string Status, string? Note);
```

`GET /swagger/v1/swagger.json` возвращает:

```json
{
  "openapi": "3.0.4",
  "info": { "title": "Demo", "version": "v1" },
  "paths": { }
}
```

Явная установка `OpenApiVersion` здесь ничего не меняет, потому что `OpenApi3_0` и так значение по умолчанию, а более тонкой градации перечисление не предлагает.

## Можно ли передать patch-версию в CLI?

Нет. `dotnet swagger tofile` разбирает `--openapiversion` по закрытому набору из трёх строк. Из исходников v10.2.3:

```csharp
// Swashbuckle.AspNetCore.Cli/Program.cs, v10.2.3
specVersion = versionArg switch
{
    "2.0" => OpenApiSpecVersion.OpenApi2_0,
    "3.0" => OpenApiSpecVersion.OpenApi3_0,
    "3.1" => OpenApiSpecVersion.OpenApi3_1,
    _ => throw new NotSupportedException($"The specified OpenAPI version \"{versionArg}\" is not supported."),
};
```

В 9.0.6 ветки `"3.1"` тоже нет, так что доступны только `2.0` и `3.0`. Измеренный вывод для каждого допустимого значения в 10.2.3: `2.0` даёт `"swagger": "2.0"`, `3.0` даёт `"openapi": "3.0.4"`, `3.1` даёт `"openapi": "3.1.1"`. Всё остальное, включая `3.0.1` и `3.1.1`, приводит к исключению.

Отдельное замечание про CLI: инструмент 9.0.6 поставляется с apphost для `net9.0`, поэтому он отказывается запускаться на машине, где установлена только среда выполнения .NET 10. Установите `DOTNET_ROLL_FORWARD=Major` перед вызовом или поставьте соответствующую среду выполнения.

## Поможет ли откат Microsoft.OpenApi до 1.6.22?

Не поможет ни на Swashbuckle 9, ни на 10, и именно этот совет чаще всего встречается в старых обсуждениях. Прямая ссылка сначала вызывает NU1605, который NuGet по умолчанию считает ошибкой. Если подавить его через `<WarningsNotAsErrors>NU1605</WarningsNotAsErrors>`, восстановление разрешится в 1.6.22, а затем компиляция упадёт с `CS1705`, потому что `Swashbuckle.AspNetCore.Swagger` 9.0.6 собран против идентичности сборки 1.6.25. Обе ошибки воспроизводятся на чистом проекте `net10.0`.

Путь фиксации версий работает, только если откатить весь стек:

```xml
<!-- net10.0, verified: emits "openapi": "3.0.1" -->
<ItemGroup>
  <PackageReference Include="Swashbuckle.AspNetCore" Version="7.2.0" />
  <PackageReference Include="Microsoft.OpenApi" Version="1.6.22" />
</ItemGroup>
```

Swashbuckle 7.2.0 всё ещё нацелен на `netstandard2.0` и нормально работает на `net10.0`, разрешая `Microsoft.OpenApi` в 1.6.22. Явная ссылка на `Microsoft.OpenApi` нужна, чтобы транзитивное повышение снова не утащило вас вперёд. Считайте это временной мерой со сроком, а не решением: вы замораживаете генератор OpenAPI на две мажорные версии назад, а в 8.x и 9.x есть исправления генерации схем, которые вам рано или поздно понадобятся.

## Как переписать строку версии на Swashbuckle 9 или 10?

Точки расширения нет. Сопровождающие Swashbuckle прямо сказали это в [issue #3540](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540): `SwaggerMiddleware` сериализует прямо в поток ответа, ничего не оставляя посередине. Обходной путь, который они предлагают и который действительно работает, это буферизовать ответ и отредактировать свойство. Он одинаково работает на 9.0.6 и 10.2.3, потому что никогда не касается объектной модели:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6 and 10.2.3, both verified
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/swagger")
        && ctx.Request.Path.Value!.EndsWith(".json"),
    branch => branch.Use(async (ctx, next) =>
    {
        var original = ctx.Response.Body;
        using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;

        await next();

        ctx.Response.Body = original;
        if (ctx.Response.StatusCode != StatusCodes.Status200OK)
        {
            buffer.Position = 0;
            await buffer.CopyToAsync(original);
            return;
        }

        var json = Encoding.UTF8.GetString(buffer.ToArray())
            .Replace("\"openapi\": \"3.0.4\"", "\"openapi\": \"3.0.1\"", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes);
    }));

app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.UseSwaggerUI();
```

Регистрируйте его до `UseSwagger`. Swagger UI продолжает работать, `/swagger/index.html` по-прежнему возвращает 200, а JSON-эндпоинт отдаёт `3.0.1`. Важны две детали: вернуть `ctx.Response.Body` на исходный поток до записи и выставить `ContentLength` после переписывания, поскольку замена меняет количество байт. Фильтр `.EndsWith(".json")` не даёт буферизации задевать статические файлы UI. Если вы отдаёте ещё и YAML, добавьте отдельную ветку: там свойство пишется как `openapi: '3.0.4'`, и JSON-замена не сработает.

Если буферизовать не хочется, замените эндпоинт целиком и сериализуйте документ сами:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6
app.MapGet("/swagger/v1/swagger.json", (ISwaggerProvider provider) =>
{
    var document = provider.GetSwagger("v1");
    var node = JsonNode.Parse(document.SerializeAsJson(OpenApiSpecVersion.OpenApi3_0))!;
    node["openapi"] = "3.0.1";
    return Results.Text(
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
        "application/json");
}).ExcludeFromDescription();
```

`ExcludeFromDescription()` здесь не опция. Без него эндпоинт обнаруживает сам себя, и `/swagger/v1/swagger.json` появляется как задокументированный путь в собственном выводе. `SerializeAsJson` в ветке 1.6.x живёт в `Microsoft.OpenApi.Extensions`; в Swashbuckle 10 с `Microsoft.OpenApi` 2.x этого расширения больше нет, поэтому там предпочтителен middleware.

Для документа, генерируемого во время сборки через `dotnet swagger tofile` или `OpenApiGenerateDocumentsOnBuild`, ничего из этого в коде делать не нужно. Сгенерируйте с `--openapiversion 3.0` и поправьте файл отдельным шагом сборки:

```bash
jq '.openapi = "3.0.1"' swagger.json > swagger.tmp && mv swagger.tmp swagger.json
```

## Swagger UI по-прежнему отклоняет определение, что дальше?

Если браузер показывает "The provided definition does not specify a valid version field", с документом всё в порядке, а UI устарел. Поддержка 3.0.4 появилась в swagger-ui [v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0), выпущенной 2025-02-17, через [PR #10247](https://github.com/swagger-api/swagger-ui/pull/10247). Swashbuckle подхватил её в `Swashbuckle.AspNetCore.SwaggerUI` 7.3.0. Всё, что старше, показывает ошибку на совершенно корректном документе 3.0.4.

Ловушка в рассинхроне версий внутри одного решения. `Swashbuckle.AspNetCore.SwaggerUI` это отдельный пакет, и проекты, ссылающиеся на три подпакета по отдельности, часто поднимают `Swagger` и `SwaggerGen`, оставляя `SwaggerUI` позади. Проверьте все три, затем перезагрузите страницу с очисткой кеша, потому что встроенный `swagger-ui-bundle.js` кешируется агрессивно.

Если проблема в рендерере, а не в документе, это подходящий момент посмотреть на [отдачу документации через Scalar](/ru/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), который читает и 3.0.4, и 3.1 без нареканий.

## А если мне действительно нужен 3.1?

Тогда нужен Swashbuckle 10 или новее, потому что в `Microsoft.OpenApi` 1.6.x члена `OpenApi3_1` нет вовсе. В 10.x это включается явно, так что по умолчанию остаётся 3.0.4, а 3.1 запрашивается отдельно:

```csharp
// net10.0, Swashbuckle.AspNetCore 10.2.3, emits "openapi": "3.1.1"
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
```

Заложите время на обновление. Swashbuckle 10 переходит на `Microsoft.OpenApi` v2, где пространства имён уплощены, поэтому первое, во что вы упрётесь, это:

```text
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi'
```

Удалите `using Microsoft.OpenApi.Models;`, поскольку типы теперь лежат прямо в `Microsoft.OpenApi`. Кроме того, конкретные типы модели становятся интерфейсами (`OpenApiSchema` превращается в `IOpenApiSchema`), строковые имена типов заменяются значениями перечисления `JsonSchemaType`, а `WithOpenApi()` больше не поддерживается. [Руководство по миграции на v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md) советует сначала пройти через 9.0.6, и это хороший совет: так ломающие изменения 9.x (отказ от `netstandard2.0`, удаление устаревших членов, удаление `--serializeasv2`) отделяются от изменений OpenAPI.NET v2.

## Какое решение выбрать?

По порядку того, что я сделал бы на практике:

1. Обновите потребителя. `3.0.4` это корректный OpenAPI 3.0, и любой актуальный валидатор, генератор или шлюз его принимает. Большинство таких сообщений сводится к инструменту, отставшему на три версии.
2. Если потребитель это вендор, которого не сдвинуть, добавьте переписывание в middleware. Это 20 строк, оно не зависит от версии и не замораживает граф зависимостей.
3. Правьте файл в CI через `jq`, если документ генерируется на этапе сборки, а не отдаётся во время выполнения.
4. Фиксируйте Swashbuckle на 7.2.0 только как временную меру, с заведённой задачей на снятие.

Что не работает, что бы ни говорили результаты поиска: откат `Microsoft.OpenApi` под актуальным Swashbuckle и поиск члена `OpenApiSpecVersion`, кодирующего patch-версию.

## Похожие материалы

- [Переход с Swashbuckle на встроенный генератор OpenAPI](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) описывает обратное направление, если вы предпочитаете уйти от Swashbuckle, а не следить за его версиями.
- [Ошибка компиляции 'OpenApiReference' could not be found](/ru/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/) это родственный сбой из того же уплощения пространств имён в `Microsoft.OpenApi` v2.
- [Перенос IOperationFilter и ISchemaFilter на трансформеры](/ru/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/) это самая долгая часть миграции.
- [Сравнение Scalar и Swagger UI](/ru/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) стоит прочитать, если версию отверг рендерер, а не потребляющий сервис.
- [Генерация строго типизированных клиентов из спецификации OpenAPI](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) пригодится, если ваш документ отвергает генератор кода.

## Источники

- [OpenAPI.NET PR #2011: bumps v3 patch version to 3.0.4](https://github.com/microsoft/OpenAPI.NET/pull/2011)
- [Swashbuckle.AspNetCore issue #3540: changing the openapi version in swagger.json](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540)
- [Swashbuckle.AspNetCore issue #3216: 7.2.0 json doc says openapi 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3216)
- [Swashbuckle.AspNetCore issue #3265: add support for OpenAPI 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3265)
- [Заметки о выпуске Swashbuckle.AspNetCore v9.0.0](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v9.0.0)
- [Заметки о выпуске Swashbuckle.AspNetCore v10.0.0](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.0.0)
- [Руководство по миграции Swashbuckle.AspNetCore на v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Заметки о выпуске swagger-ui v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)
