---
title: "Миграция со Swashbuckle на встроенный генератор OpenAPI в .NET 11"
description: "Пошаговая миграция со Swashbuckle.AspNetCore на Microsoft.AspNetCore.OpenApi в .NET 11: замена AddSwaggerGen на AddOpenApi, преобразование фильтров операций, схем и документа в трансформеры, сохранение UI и несовместимые изменения Microsoft.OpenApi v2, которые кусаются."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-16
---

Если ваш проект ASP.NET Core всё ещё вызывает `builder.Services.AddSwaggerGen()` и `app.UseSwagger()`, вы используете Swashbuckle.AspNetCore, пакет, который почти десятилетие нёс на себе историю OpenAPI в .NET. С .NET 9 шаблоны Web API его больше не включают: новый проект вместо него использует собственный пакет Microsoft, `Microsoft.AspNetCore.OpenApi`. Эта статья мигрирует существующую кодовую базу со Swashbuckle на встроенный генератор на `net11.0` с C# 14 и охватывает ту часть, которую пропускают руководства для новых проектов: что удалить, как каждый `IOperationFilter`, `ISchemaFilter` и `IDocumentFilter` отображается на трансформер, как сохранить кликабельный UI и какие несовместимые изменения Microsoft.OpenApi v2 не скомпилируются, пока вы их не исправите.

Для небольшого API с парой фильтров это полдня. Для крупного сервиса с десятком собственных фильтров, провайдерами примеров и несколькими версиями `SwaggerDoc` заложите день. Swashbuckle не устарел, так что это выбор, а не вынужденный марш. Причина это сделать в том, что встроенный генератор поставляется в коробке, следует за средой выполнения от релиза к релизу, поддерживает Native AOT и по умолчанию выдаёт OpenAPI 3.1. Причина подождать в том, что вы опираетесь на возможности UI Swashbuckle или фильтры сообщества, у которых пока нет эквивалента в виде трансформера. Решите это до начала, а не на полпути.

## Зачем мигрировать сейчас

- Генератор поставляется вместе с фреймворком. Никакого стороннего пакета, прикреплённого к вашей сборке, который отстаёт от релиза .NET, а это ровно та боль .NET 6, что подтолкнула Microsoft взять это на себя.
- Он переиспользует поддержку схем `System.Text.Json`, которую остальная часть вашего приложения уже использует, поэтому схемы в документе совпадают с тем, что ваш API на самом деле сериализует.
- Он совместим с Native AOT. Генерация Swashbuckle, насыщенная рефлексией, нет, так что сервису minimal API с AOT всё равно пришлось бы отказаться от Swashbuckle.
- OpenAPI 3.1 и JSON Schema draft 2020-12 идут по умолчанию, а не как включаемая опция.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| `AddSwaggerGen` / `UseSwagger` | Заменены на `AddOpenApi` / `MapOpenApi`; другой маршрут (`/openapi/v1.json`, а не `/swagger/v1/swagger.json`) | высокая |
| `IOperationFilter` / `ISchemaFilter` / `IDocumentFilter` | Больше не вызываются; переписать как `AddOperationTransformer` / `AddSchemaTransformer` / `AddDocumentTransformer` | высокая |
| Встроенный Swagger UI | Фреймворк генерирует только JSON; UI (Scalar или отдельный пакет Swagger UI) вы добавляете сами | высокая |
| Пространство имён `Microsoft.OpenApi` | v2 переносит типы из `Microsoft.OpenApi.Models` в `Microsoft.OpenApi`; `OpenApiSchema` становится `IOpenApiSchema` | средняя |
| Примеры схем | `OpenApiString`/`IOpenApiAny` исчезли; примеры теперь `System.Text.Json.Nodes.JsonNode` | средняя |
| Версия спецификации по умолчанию | Swashbuckle по умолчанию использовал OpenAPI 3.0; встроенный генератор использует 3.1 | средняя |
| `SwaggerDoc("v1", ...)` | Заменён на `AddOpenApi("v1")` плюс трансформер документа для `Info` | низкая |
| `[SwaggerOperation]` / `EnableAnnotations` | Заменены метаданными minimal API (`WithSummary`, `WithDescription`, `WithTags`) | низкая |

## Предполётный чек-лист

1. Установите .NET 11 SDK на каждую машину разработчика и раннер CI. Проверьте с помощью `dotnet --list-sdks` и убедитесь, что появляется `11.0.x`.
2. Инвентаризируйте свою поверхность Swashbuckle. Сделайте grep по решению на `AddSwaggerGen`, `OperationFilter<`, `SchemaFilter<`, `DocumentFilter<`, `SwaggerDoc`, `EnableAnnotations` и `[SwaggerOperation`. Список фильтров и есть реальный объём миграции.
3. Снимите эталонный документ. Запустите приложение и сохраните `/swagger/v1/swagger.json` в файл. В конце вы сравните новый документ с ним.
4. Отметьте любого потребителя, привязанного к OpenAPI 3.0. Генератор клиента, который давится на 3.1, -- самый частый сюрприз, и решается он одной строкой, ниже.
5. Сделайте коммит чистой базы, чтобы откат был одной командой.

## Шаги миграции

### 1. Поменяйте пакеты

Удалите пакет генератора и добавьте пакет фреймворка. Если хотите сохранить вид Swagger UI, оставьте только его пакет UI-ресурсов, который отделён от генератора.

```dotnetcli
# .NET 11
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.AspNetCore.OpenApi
```

Если вы использовали `Swashbuckle.AspNetCore.Filters` (набор фильтров примеров/auth от сообщества), удалите и его; его возможности становятся трансформерами. **Проверка:** `dotnet build` завершается успешно или падает только на ныне отсутствующих символах `AddSwaggerGen`/фильтров, которые вы сейчас замените. Чистая компиляция здесь означала бы, что вы на самом деле никогда не использовали Swashbuckle.

### 2. Замените два вызова регистрации

Это центральная замена. Swashbuckle регистрировал генератор и два middleware; встроенная версия регистрирует сервис и сопоставляет конечную точку.

```csharp
// Before -- Swashbuckle, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Todo API", Version = "v1" });
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
```

Документ переезжает с `/swagger/v1/swagger.json` на `/openapi/v1.json`. Имя документа по умолчанию -- `v1`, откуда и берётся имя маршрута. Обратите внимание на фильтр `IsDevelopment()`: документ OpenAPI -- это полная карта вашей поверхности атаки, поэтому по умолчанию не отдавайте его в публичный интернет. **Проверка:** запустите приложение и запросите `/openapi/v1.json`. Вы должны получить документ 3.1, перечисляющий каждую конечную точку. Блок `Info` пока общий; шаг 4 это исправляет.

### 3. Верните UI

Swashbuckle включал Swagger UI, так что `/swagger` просто работал. Встроенный генератор выдаёт только JSON. Выберите средство просмотра и направьте его на документ. По умолчанию в шаблоне с .NET 9 это Scalar:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Если ваша команда привязана к Swagger UI, он по-прежнему работает. Установите `Swashbuckle.AspNetCore.SwaggerUi` (только UI-ресурсы, не генератор) и направьте его на новый маршрут:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

**Проверка:** перейдите на `/scalar` (или `/swagger`) и убедитесь, что операции отрисовываются и "Try it out" достигает вашего API. Детали для нового проекта по каждому средству просмотра -- в [как отдать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

### 4. Перенесите метаданные документа в трансформер

`SwaggerDoc("v1", new OpenApiInfo { ... })` задавал заголовок, версию и описание. Во встроенной модели это трансформер документа, который проходит по `OpenApiDocument` перед его сериализацией.

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints."
        };
        return Task.CompletedTask;
    });
});
```

Следите за `using`. С Microsoft.OpenApi v2 (от которого теперь зависят и Swashbuckle v10, и `Microsoft.AspNetCore.OpenApi`) типы модели переехали из `Microsoft.OpenApi.Models` в `Microsoft.OpenApi`. Если скопировать старый код `OpenApiInfo` дословно, он не разрешится. **Проверка:** перезагрузите документ и убедитесь, что блок `info` показывает ваш заголовок и описание.

### 5. Преобразуйте фильтры операций в трансформеры операций

`IOperationFilter` выполнялся один раз на операцию, чтобы добавить ответ, заголовок или описание. Сигнатура трансформера другая, но тело почти идентичное.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddThrottleResponseFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Responses.TryAdd("429",
            new OpenApiResponse { Description = "Too Many Requests" });
    }
}
// registered: c.OperationFilter<AddThrottleResponseFilter>();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too Many Requests"
        };
        return Task.CompletedTask;
    });
});
```

У `OperationFilterContext` было `ApiDescription`; `context` трансформера предоставляет тот же `ApiDescription`, так что любая условная логика, завязанная на маршрут, HTTP-метод или метаданные, переносится без изменений. **Проверка:** найдите конечную точку, на которую был нацелен ваш фильтр, и убедитесь, что ответ `429` (или то, что вы добавили) появляется у неё в документе.

### 6. Преобразуйте фильтры схем и документа

`ISchemaFilter` становится `AddSchemaTransformer`. Контекст теперь передаёт `JsonTypeInfo` вместо `Type`, поэтому вы читаете `context.JsonTypeInfo.Type`:

```csharp
// After -- .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(Todo))
    {
        schema.Description = "A single task tracking item.";
    }
    return Task.CompletedTask;
});
```

`IDocumentFilter` становится `AddDocumentTransformer`, тем же хуком, что использовался для `Info` в шаге 4. Применяйте его для `servers`, тегов верхнего уровня и схем безопасности. Частый случай -- объявить схему Bearer, чтобы UI показывал кнопку Authorize; это можно сделать инлайн или через строго типизированный `IOpenApiDocumentTransformer`, когда нужно внедрить сервисы. **Проверка:** убедитесь, что описание схемы (или схема безопасности) появляется там, где его ставил старый фильтр. Если вы вдобавок завязываете кнопку Authorize на схему безопасности, а средство просмотра молча игнорирует токен, почти всегда это некорректная схема, что я разобрал в [почему ваш токен Bearer игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

### 7. Замените аннотации метаданными minimal API

Если вы использовали `EnableAnnotations()` и `[SwaggerOperation(Summary = "...", Description = "...")]`, уберите атрибуты и выразите те же метаданные соглашениями конечных точек. Они напрямую попадают в операцию:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Для контроллеров комментарии XML-документации и атрибуты `[ProducesResponseType]`, которые у вас уже есть, читаются обозревателем API, так что многое достаётся бесплатно. Если держать конечные точки сгруппированными через [MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), один `WithTags` на группе может пометить каждую операцию в ней. **Проверка:** сводки и теги отрисовываются в UI, а `EnableAnnotations` больше нигде в проекте не встречается.

### 8. Обработайте несколько документов и версионирование

Повторяющийся `SwaggerDoc("v1", ...)` / `SwaggerDoc("v2", ...)` из Swashbuckle становится повторяющимися вызовами `AddOpenApi`, каждый со своим именем и опциями. Какие конечные точки попадают в какой документ, решает `ShouldInclude`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
builder.Services.AddOpenApi("internal");
```

Каждое имя получает свой маршрут: `/openapi/public.json` и `/openapi/internal.json`. Если вы используете `Asp.Versioning`, он интегрируется с этой моделью документов, а не борется с ней. **Проверка:** запросите каждый маршрут документа и убедитесь, что в каждом появляются правильные конечные точки.

## Верификация

Прогоните этот чек-лист, прежде чем удалять старый путь кода:

- `dotnet build` чист, без предупреждений, включая оставшиеся ссылки на `Microsoft.OpenApi.Models`.
- `dotnet test` проходит, особенно любой контрактный тест, который фиксировал старый путь `/swagger/v1/swagger.json`; обновите их на `/openapi/v1.json`.
- Сравните новый `/openapi/v1.json` с эталоном, который вы сохранили на предполётной проверке. Ожидайте, что строка версии изменится с `3.0.x` на `3.1.x`, а обработка `nullable` в схемах будет отличаться; всё остальное должно совпадать операция за операцией.
- Каждая конечная точка, которую затрагивали ваши старые фильтры, по-прежнему несёт те же ответы, заголовки и описания.
- UI загружается, и "Try it out" достигает реальной конечной точки.
- Если вы генерируете клиент из спецификации, перегенерируйте его и убедитесь, что он по-прежнему компилируется. См. [как сгенерировать строго типизированный клиент из спецификации OpenAPI](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## План отката

Эта миграция обратима, пока вы не начнёте удалять классы фильтров. Чтобы откатиться, `dotnet remove package Microsoft.AspNetCore.OpenApi`, заново добавьте `Swashbuckle.AspNetCore` и восстановите `AddSwaggerGen` / `UseSwagger` / `UseSwaggerUI`. Поскольку переписывания фильтров в трансформеры -- это правки на месте, чистый коммит из предполётной проверки и есть ваш настоящий откат: сделайте `git checkout` коммита, и вы за один шаг снова на Swashbuckle. Делайте миграцию в ветке и храните эталонный коммит, пока новый документ не отработает в реальной среде.

## Грабли, на которые мы наступили

**Значение OpenAPI 3.1 по умолчанию ломает инструментарий, понимающий только 3.0.** Это самый частый тикет после миграции. Если нижестоящий генератор отвергает документ, понизьте версию явно, а не откатывайте всю миграцию:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

**Примеры схем теперь `JsonNode`, а не `OpenApiString`.** Microsoft.OpenApi v2 убрал иерархию `IOpenApiAny`. Если фильтр схемы задавал `schema.Example = new OpenApiString("...")`, эквивалент в трансформере присваивает `System.Text.Json.Nodes.JsonNode`, например `JsonValue.Create("...")` или `JsonObject`. Это та единственная правка, которая с наибольшей вероятностью не скомпилируется во время переписывания.

**Документ перегенерируется при каждом запросе.** `MapOpenApi` прогоняет полный конвейер каждый раз, когда обращаются к конечной точке, намеренно, чтобы трансформеры могли реагировать на живое состояние. Для нагруженного документа кешируйте его через `.CacheOutput()` на конечной точке или генерируйте на этапе сборки с `Microsoft.Extensions.ApiDescription.Server` и отдавайте статический файл. Генерация на этапе сборки запускает ваш `Program.cs`, так что защищайте код запуска (например, открытие подключения к базе данных) по имени входной сборки, когда он не должен выполняться во время сборки.

**Выведенные схемы строже, чем у Swashbuckle.** Встроенный генератор документирует только то, что видит обозреватель API. Если минимальная конечная точка возвращает `IResult` без типизированной перегрузки или вызова `Produces<T>`, схема ответа отсутствует. Swashbuckle иногда замазывал это рефлексией; новый генератор хочет аннотацию. Добавьте `Produces<T>` и `Accepts<T>` там, где схема пропадает.

**`OpenApiSchema` теперь интерфейс.** Коду, который объявлял `OpenApiSchema schema` как параметр или локальную переменную, может потребоваться `IOpenApiSchema`, а свойство `Nullable` исчезло в пользу `JsonSchemaType.Null`. Если вы писали сложные фильтры схем, именно сюда попадает большинство ошибок компиляции.

Ментальная модель невелика, как только она встаёт на место: фреймворк владеет документом, трансформеры заменяют фильтры, а UI -- отдельная, заменяемая забота. Основная масса работы -- переписывания фильтров в трансформеры и изменения пространства имён и типов Microsoft.OpenApi v2; сама замена регистрации -- это две строки.

## Связанное чтение

- [Как отдать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Как организовать конечные точки minimal API с MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как сгенерировать строго типизированный код клиента из спецификации OpenAPI в .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar в ASP.NET Core: почему ваш токен Bearer игнорируется](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Миграция с .NET 8 на .NET 11: полный чек-лист](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Источники

- [Generate OpenAPI documents, документация ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Customize OpenAPI documents, документация ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.AspNetCore.OpenApi на NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server на NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
