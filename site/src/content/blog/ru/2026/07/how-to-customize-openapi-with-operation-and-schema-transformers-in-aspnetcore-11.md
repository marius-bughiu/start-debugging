---
title: "Как настроить документ OpenAPI с помощью AddOperationTransformer и AddSchemaTransformer в ASP.NET Core 11"
description: "Подробный разбор встроенного конвейера трансформеров OpenAPI в .NET 11: трансформеры операций и схем, объекты контекста, порядок выполнения, трансформеры, активируемые через DI, а также рецепты для заголовков, ответов, примеров и точечных изменений свойств."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "ru"
translationOf: "2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Встроенный генератор `Microsoft.AspNetCore.OpenApi` в .NET 11 владеет документом OpenAPI, и изменять то, что он выдаёт, вы можете через трансформеры. Их три: `AddDocumentTransformer` для всего документа, `AddOperationTransformer` для каждой операции путь-плюс-метод и `AddSchemaTransformer` для каждой модели данных. Чтобы добавить параметр-заголовок или общий ответ ко всем конечным точкам, используйте трансформер операций. Чтобы задать формат, пример или описание для типа или свойства, используйте трансформер схем. Этот пост нацелен на .NET 11 (`net11.0`, C# 14) с `Microsoft.AspNetCore.OpenApi` и `Microsoft.OpenApi` v2 и выходит за пределы однострочников: разбираются объекты контекста, порядок выполнения, на котором люди спотыкаются, и изменения типов в Microsoft.OpenApi v2, из-за которых код не скомпилируется, если вы скопируете примеры для .NET 8.

Если вы ещё не сгенерировали документ, начните с [как отдавать OpenAPI без Swashbuckle](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/); всё изложенное ниже предполагает, что `builder.Services.AddOpenApi()` и `app.MapOpenApi()` уже на месте.

## Что разрешено трогать каждому трансформеру

Три вида трансформеров не взаимозаменяемы, и выбор не того трансформера: самая частая ошибка. Правило касается области действия:

- **Трансформер документа** видит весь `OpenApiDocument`. Это правильный инструмент для `Info`, `servers`, тегов верхнего уровня (`tags`) и схем безопасности, поскольку всё это живёт в корне.
- **Трансформер операций** вызывается один раз на операцию, где операция: это уникальная комбинация пути и HTTP-метода (`GET /todos/{id}`: одна операция, `POST /todos`: другая). Обращайтесь к нему, когда хотите внести изменение на каждой конечной точке или на конечных точках, соответствующих условию, которое вы можете прочитать из метаданных.
- **Трансформер схем** вызывается для каждой схемы, которую производит генератор, включая вложенные. Именно здесь вы задаёте форму тел запросов и ответов: форматы, примеры, описания, допустимость null, устаревание.

Попытка добавить ответ ко "всем операциям" из трансформера документа означает ручной обход `document.Paths`; при использовании трансформера операций фреймворк передаёт вам каждую операцию напрямую. Верно и обратное: установка `document.Info` из трансформера операций выполнялась бы один раз на каждую конечную точку и перезаписывала бы саму себя. Сопоставляйте трансформер с уровнем той сущности, которую вы меняете.

## Четыре шага, чтобы добавить глобальный заголовок и придать форму схеме

Вот базовая процедура от начала до конца. Она регистрирует один трансформер операций, который проставляет заголовок correlation-id на каждую конечную точку, и один трансформер схем, который исправляет формат типа.

1. **Откройте блок опций `AddOpenApi`.** Все три метода `Add*Transformer` относятся к `OpenApiOptions`, поэтому регистрацию вы выполняете внутри делегата `AddOpenApi(options => { ... })`.

2. **Зарегистрируйте трансформер операций для заголовка.** Сигнатура делегата: `(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)`. Изменяйте `operation` на месте и возвращайте `Task`.

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Description = "Client-supplied request id, echoed back in the response.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    });
});
```

3. **Зарегистрируйте трансформер схем для типа.** Его делегат: `(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)`. Классический пример: сообщить потребителям, что `decimal` имеет денежную точность, а не является числом с плавающей запятой:

```csharp
// .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(decimal))
    {
        schema.Format = "decimal";
    }
    return Task.CompletedTask;
});
```

4. **Перегенерируйте и проверьте.** Запросите `/openapi/v1.json`. Теперь каждая операция должна нести параметр-заголовок `X-Correlation-Id`, а каждое свойство типа `decimal` должно показывать `"format": "decimal"`. Поскольку `MapOpenApi` перегенерирует документ при каждом запросе, перезапускать нужно только само приложение.

Это и есть весь цикл. Остальная часть поста: детали, которые делают эти трансформеры надёжными, а не неожиданными.

## Объекты контекста, свойство за свойством

Каждый трансформер получает контекст, и контексты различаются, потому что каждый трансформер знает разное.

Контекст **операции** (`OpenApiOperationTransformerContext`) предоставляет `DocumentName`, `Description` (объект `ApiDescription` для конечной точки) и `ApplicationServices` (объект `IServiceProvider`). `Description` здесь важнее всего: он несёт маршрут, HTTP-метод и `ActionDescriptor.EndpointMetadata`, благодаря чему вы делаете трансформер условным. Например, добавить ответ `429` только к тем конечным точкам, к которым действительно прикреплена политика ограничения частоты запросов:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.RateLimiting;

options.AddOperationTransformer((operation, context, cancellationToken) =>
{
    var isRateLimited = context.Description.ActionDescriptor.EndpointMetadata
        .OfType<EnableRateLimitingAttribute>()
        .Any();

    if (isRateLimited)
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too many requests. Retry after the window resets."
        };
    }

    return Task.CompletedTask;
});
```

Контекст **схемы** (`OpenApiSchemaTransformerContext`) предоставляет `DocumentName`, `JsonTypeInfo`, `JsonPropertyInfo` и `ApplicationServices`. `JsonTypeInfo`: это метаданные `System.Text.Json` для описываемого типа, поэтому `context.JsonTypeInfo.Type`: это CLR-тип `Type`. `JsonPropertyInfo` заполняется только тогда, когда схема генерируется для конкретного свойства, что позволяет нацелиться на один член, а не на весь тип:

```csharp
// .NET 11, C# 14
using System.Text.Json.Nodes;

options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    // Target the Email property on any type that has one.
    if (context.JsonPropertyInfo?.Name == "email")
    {
        schema.Format = "email";
        schema.Example = JsonValue.Create("dev@example.com");
    }

    return Task.CompletedTask;
});
```

Контекст **документа** (`OpenApiDocumentTransformerContext`) предоставляет `DocumentName`, `DescriptionGroups` (объект `ApiDescriptionGroups`) и `ApplicationServices`. К трансформерам документа вы обращаетесь, когда цель: корень документа, чаще всего схема безопасности, которую я разбираю ниже.

## Порядок выполнения: сначала схема, затем операция, затем документ

Это та часть, которая порождает баг-репорты "моё изменение пропало". Трансформеры выполняются не в том порядке, который вы могли бы ожидать, читая файл. Фреймворк выполняет их в таком порядке:

- **Сначала трансформеры схем.** Все схемы регистрируются в документе до того, как обрабатывается хоть одна операция, поэтому каждый трансформер схем выполняется раньше любого трансформера операций. Внутри трансформеров схем они выполняются в порядке регистрации, и более поздний видит изменения более раннего.
- **Затем трансформеры операций.** Каждый выполняется, когда его операция добавляется, в порядке регистрации, после того как все схемы уже существуют. К моменту выполнения трансформера операций схемы для типов в этой операции уже сформированы.
- **Трансформеры документа в последнюю очередь.** Они выполняются на финальном проходе, когда присутствуют все операции и схемы. Более поздний трансформер документа видит правки более раннего.

Практическое следствие: если трансформеру документа нужно, чтобы схема уже была сформирована определённым образом, так и будет, потому что схемы выполнились первыми. Но трансформер операций не может рассчитывать на то, что трансформер документа уже отработал, потому что документы выполняются последними. Когда вы генерируете несколько документов, весь конвейер выполняется независимо для каждого документа, поэтому трансформер, зарегистрированный на документе `internal`, никогда не затронет `public`.

## Строго типизированные трансформеры и внедрение зависимостей

Встроенные делегаты годятся для изменений без состояния. Когда трансформеру нужен сервис, реализуйте интерфейс и зарегистрируйте тип так, чтобы фреймворк активировал его из DI. Эти интерфейсы: `IOpenApiDocumentTransformer`, `IOpenApiOperationTransformer` и `IOpenApiSchemaTransformer`, у каждого один метод `TransformAsync`. Используйте первичный конструктор для внедрения:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider authenticationSchemeProvider) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        var schemes = await authenticationSchemeProvider.GetAllSchemesAsync();
        if (schemes.Any(s => s.Name == "Bearer"))
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                In = ParameterLocation.Header,
                BearerFormat = "JSON Web Token"
            };
        }
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

Зарегистрируйте активируемый через DI трансформер обобщённой перегрузкой (`AddDocumentTransformer<T>()`), заранее созданным экземпляром (`AddDocumentTransformer(new T())`) или делегатом. Во внедрении зависимостей участвует только обобщённая форма. Обобщённая форма разрешается заново при каждой генерации документа и затем освобождается, поэтому трансформер, реализующий `IDisposable`, очищается каждый раз, когда документ производится. Именно из-за этого времени жизни на одну генерацию трансформеры стоит держать дешёвыми: с работающей конечной точкой `MapOpenApi` конвейер выполняется при каждом запросе к маршруту документа. Если документ дорого строить, кешируйте конечную точку с помощью `.CacheOutput()` или генерируйте его на [этапе сборки](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Регистрация схемы безопасности: каноническая задача трансформера документа. Если вы подключили схему, но просмотрщик всё равно игнорирует токен, причина почти всегда в некорректной схеме в документе, а не в ошибке клиента, что я разобрал от начала до конца в [почему ваш Bearer-токен игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/). Про соответствующий поток Swagger UI на уровне конечной точки см. [добавление потоков аутентификации OpenAPI](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

## Трансформеры операций на уровне конечной точки

Вам не всегда нужно изменение на каждой операции. Трансформер операций, зарегистрированный на одной конечной точке, выполняется только для этой конечной точки: через `AddOpenApiOperationTransformer` на построителе конечной точки. Пометить один маршрут устаревшим: однострочник:

```csharp
// .NET 11, C# 14
app.MapGet("/v1/report", GenerateReport)
   .AddOpenApiOperationTransformer((operation, context, cancellationToken) =>
   {
       operation.Deprecated = true;
       operation.Description = "Superseded by /v2/report. Removed in the next major version.";
       return Task.CompletedTask;
   });
```

Это чётко ограничивает область: никакого разбора `context.Description`, никакого сопоставления маршрутов, только та конечная точка, к которой вы его прикрепили. Хорошо сочетается с группировкой конечных точек, поскольку трансформер, прикреплённый к группе, распространяется на каждую операцию в ней. См. [организация конечных точек minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) для этого паттерна.

## Генерация схемы на лету

Иногда трансформеру операций нужна схема для типа, на который конечная точка иначе не ссылается, например для общего тела ошибки. Начиная с .NET 10, контекст трансформера предоставляет `GetOrCreateSchemaAsync`, который строит схему по той же логике, что и генератор, и `context.Document.AddComponent`, который размещает её под `components.schemas` для повторного использования:

```csharp
// .NET 11, C# 14
options.AddOperationTransformer(async (operation, context, cancellationToken) =>
{
    var errorSchema = await context.GetOrCreateSchemaAsync(
        typeof(ProblemDetails), null, cancellationToken);
    context.Document?.AddComponent("Error", errorSchema);

    operation.Responses ??= new OpenApiResponses();
    operation.Responses["4XX"] = new OpenApiResponse
    {
        Description = "Bad request.",
        Content = new Dictionary<string, OpenApiMediaType>
        {
            ["application/problem+json"] = new OpenApiMediaType
            {
                Schema = new OpenApiSchemaReference("Error", context.Document)
            }
        }
    };
});
```

Это чистый способ задокументировать согласованный контракт ошибок, не украшая каждую конечную точку атрибутом `Produces<ProblemDetails>`. Если вы формируете сами ответы об ошибках, а не просто документируете их, это отдельная забота, которой занимается [IProblemDetailsService](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Изменения типов в Microsoft.OpenApi v2, ломающие старые примеры

.NET 10 обновил зависимость `Microsoft.OpenApi` до v2, и объектная модель изменилась так, что код не скомпилируется, если вы вставите трансформер из .NET 8. Больнее всего бьют три изменения:

**`OpenApiSchema.Type` теперь перечисление-флаги, а не строка.** В v1 вы писали `Type = "string"` с отдельным `Nullable = true`. В v2 `Type`: это допускающий null `JsonSchemaType`, а допустимость null выражается объединением с флагом `Null`:

```csharp
// .NET 11, Microsoft.OpenApi v2
// A nullable string:
schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
```

**Примеры имеют тип `JsonNode`, а не `OpenApiString`.** Вся иерархия `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`) была удалена. Присваивайте вместо неё `System.Text.Json.Nodes.JsonNode`, поэтому пример свойства выше использовал `JsonValue.Create(...)`. Для примера объекта постройте `JsonObject`. Это та единственная правка, которая с наибольшей вероятностью не скомпилируется при миграции старых фильтров схем, о чём я подробнее рассказываю в [руководстве по миграции со Swashbuckle на встроенный генератор](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).

**Ссылки типизированы.** Вместо ручного построения `OpenApiReference` используйте `OpenApiSchemaReference("Name", document)` и `OpenApiSecuritySchemeReference("Bearer", document)`. Они разрешаются относительно документа, который вы передаёте, что отлавливает висячую ссылку при конструировании, а не при сериализации.

## Подводные камни, которые всплывают после того, как документ выглядит правильным

**Трансформеры схем могут выполняться более одного раза для одного и того же типа.** Трансформер схем срабатывает на каждое вхождение схемы, а проход, который дедуплицирует одинаковые схемы в `components.schemas`, выполняется *после* всех трансформеров. Поэтому у типа, используемого в трёх местах, трансформер схем может быть вызван три раза. Держите логику идемпотентной: проверяйте перед добавлением и никогда не дописывайте в список, к которому можете вернуться.

**Повторное использование схем: не то, чем вы управляете из трансформера.** Будет ли схема встроена или вынесена в `components.schemas`, решает фреймворк после выполнения трансформеров, используя `OpenApiOptions.CreateSchemaReferenceId`. Перечисления всегда выносятся по ссылке; чтобы вместо этого встроить их, верните `null` из этого делегата для типов-перечислений:

```csharp
// .NET 11, C# 14
options.CreateSchemaReferenceId = type =>
    type.Type.IsEnum ? null : OpenApiOptions.CreateDefaultSchemaReferenceId(type);
```

**Трансформер операций не может видеть работу трансформера документа.** Поскольку документы выполняются последними, не помещайте схему в трансформер документа и не пытайтесь сослаться на неё из трансформера операций в том же прогоне. Регистрируйте схему *и* требование на уровне операции из одного и того же трансформера документа или применяйте требование к каждой операции из трансформера документа, который в конце обходит `document.Paths`.

**Документируется только то, что видит проводник API.** Трансформеры формируют то, что существует; они не могут выдумать операцию, которую проводник так и не обнаружил. Если minimal API возвращает голый `IResult` без `Produces<T>`, для трансформера просто нет схемы ответа, которую можно было бы тронуть. Сначала аннотируйте конечную точку. Точные схемы важны и дальше по цепочке, поскольку [генератор строго типизированного клиента](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) хорош ровно настолько, насколько хорош документ, который вы ему подаёте.

Ментальная модель невелика, как только она укладывается: схемы формируются первыми, операции следующими, документ последним, и каждый трансформер трогает только тот слой, по которому назван. Выберите уровень, изменяйте на месте, держите идемпотентным, и документ, который вы отдаёте, будет ровно тем, которого ждут ваши потребители и генераторы кода.

## Похожие материалы

- [Как отдавать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Миграция со Swashbuckle на встроенную генерацию документа OpenAPI в .NET 11](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Как добавить потоки аутентификации OpenAPI в Swagger UI в .NET 11](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Scalar в ASP.NET Core: почему ваш Bearer-токен игнорируется](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Как организовать конечные точки minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)

## Источники

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [IOpenApiSchemaTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapischematransformer)
- [Breaking change: Microsoft.OpenApi upgraded to v2, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
