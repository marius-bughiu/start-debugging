---
title: "Миграция Swashbuckle IOperationFilter и ISchemaFilter на трансформеры OpenAPI в .NET 11"
description: "Пофильтровый справочник по миграции для перевода кода IOperationFilter и ISchemaFilter из Swashbuckle на встроенные трансформеры операций и схем в .NET 11, с сопоставлением объектов контекста и изменениями Microsoft.OpenApi v2, которые ломают компиляцию."
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Если вы уже заменили `AddSwaggerGen()` на `AddOpenApi()` в `net11.0`, то регистрация -- это простая часть. Работа, которая по-настоящему съедает вечер, -- это ваши собственные фильтры: каждый `IOperationFilter` и `ISchemaFilter`, который вы написали под Swashbuckle, перестаёт вызываться в тот момент, когда меняется генератор, потому что встроенный генератор `Microsoft.AspNetCore.OpenApi` не имеет понятия фильтров. У него есть трансформеры. Эта статья -- пофильтровый справочник по миграции: как две интерфейса фильтров сопоставляются с `IOpenApiOperationTransformer` и `IOpenApiSchemaTransformer`, во что превращается каждое свойство контекста, и какие изменения типов в Microsoft.OpenApi v2 не скомпилируются, пока вы их не исправите. Она нацелена на .NET 11 (`net11.0`, C# 14), `Microsoft.AspNetCore.OpenApi` v11 и `Microsoft.OpenApi` v2, с миграцией со Swashbuckle.AspNetCore v10.

Для горстки фильтров это занимает меньше часа. Для крупного сервиса с дюжиной фильтров, поставщиком примеров и фильтром полиморфизма закладывайте полдня. Механическая форма каждой миграции почти идентична, поэтому затраты -- не в переписывании: они в двух объектах контекста, которые предоставляют разную информацию, и в изменениях модели типов Microsoft.OpenApi v2. Если вы ещё не выполнили окружающую замену регистрации, сделайте это сначала по [полному руководству по миграции со Swashbuckle на встроенный генератор](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/); всё дальнейшее предполагает, что `AddOpenApi()` и `MapOpenApi()` уже на месте.

## Зачем вообще переносить фильтры

- Фильтры становятся мёртвым кодом в тот момент, когда вы отказываетесь от генератора Swashbuckle. Они компилируются (типы продолжают существовать, пока пакет подключён), но никогда не выполняются, поэтому ваш документ молча теряет каждую настройку, которую они применяли.
- Трансформеры переиспользуют те же метаданные `System.Text.Json`, которыми сериализует остальная часть вашего приложения, поэтому трансформер схемы видит ровно ту форму типа, которую выдаёт ваш API, а не приближение через рефлексию.
- Трансформеры совместимы с Native AOT. Конвейер фильтров Swashbuckle, построенный на рефлексии, -- нет, поэтому у AOT-сервиса вообще нет варианта с фильтрами.
- Одна модель расширяемости покрывает документ, операцию и схему вместо трёх интерфейсов фильтров плюс атрибутов-аннотаций.

## Что ломается

| Область | Swashbuckle | Встроенный в .NET 11 | Серьёзность |
| --- | --- | --- | --- |
| Хук операции | `IOperationFilter.Apply(OpenApiOperation, OperationFilterContext)` | `IOpenApiOperationTransformer.TransformAsync(...)` | высокая |
| Хук схемы | `ISchemaFilter.Apply(OpenApiSchema, SchemaFilterContext)` | `IOpenApiSchemaTransformer.TransformAsync(...)` | высокая |
| Сигнатура метода | синхронный `void Apply` | `Task TransformAsync(..., CancellationToken)` | средняя |
| Регистрация | `c.OperationFilter<T>(args)` / `c.SchemaFilter<T>(args)` | `options.AddOperationTransformer<T>()` / `AddSchemaTransformer<T>()` | средняя |
| Примеры схемы | `OpenApiString` / `IOpenApiAny` | `System.Text.Json.Nodes.JsonNode` | средняя |
| Поле типа схемы | строка `schema.Type = "string"` + `Nullable` | флаговый enum `JsonSchemaType`, флаг `Null` | средняя |
| Член через рефлексию | `context.MemberInfo` (`MemberInfo`) | `context.JsonPropertyInfo` (`JsonPropertyInfo`) | средняя |
| Генерация подсхем | `context.SchemaGenerator.GenerateSchema(...)` | `context.GetOrCreateSchemaAsync(...)` | низкая |

## Предполётный чек-лист

1. Убедитесь, что SDK .NET 11 установлен на каждой машине разработчика и каждом раннере CI: `dotnet --list-sdks` должен показывать `11.0.x`.
2. Инвентаризируйте фильтры. Выполните grep по решению на `IOperationFilter`, `ISchemaFilter`, `IDocumentFilter`, `OperationFilter<` и `SchemaFilter<`. Этот список -- точный объём данной миграции; больше здесь ничего не меняется.
3. Сохраните эталонный документ. С ещё подключённым Swashbuckle запросите `/swagger/v1/swagger.json` и сохраните файл. Вы будете сравнивать мигрированный документ с ним, конечная точка за конечной точкой.
4. Убедитесь, что `AddOpenApi()` и `MapOpenApi()` уже создают документ по `/openapi/v1.json`. Если нет, сначала мигрируйте регистрацию.
5. Выполняйте работу в ветке с чистым базовым коммитом, чтобы откат был одним `git checkout`.

## Два объекта контекста, сопоставленные

Перед рецептами -- сопоставление, которое делает каждую миграцию механической. Фильтр Swashbuckle и встроенный трансформер передают вам один и тот же объект OpenAPI для изменения (`OpenApiOperation` или `OpenApiSchema`), но контекст вокруг него отличается.

`OperationFilterContext` в `OpenApiOperationTransformerContext`:

| Swashbuckle | Встроенный | Примечания |
| --- | --- | --- |
| `ApiDescription` | `Description` | Тот же тип `ApiDescription`; переименованное свойство. Маршрут, метод и `ActionDescriptor.EndpointMetadata` переносятся. |
| `MethodInfo` | `Description.ActionDescriptor` | Читайте метаданные из дескриптора, а не из сырого `MethodInfo`. |
| `SchemaRepository` | `Document` | Регистрируйте общие схемы через `Document.AddComponent(...)`. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Теперь метод контекста, а не отдельный объект генератора. |
| `DocumentName` | `DocumentName` | Без изменений. |

`SchemaFilterContext` в `OpenApiSchemaTransformerContext`:

| Swashbuckle | Встроенный | Примечания |
| --- | --- | --- |
| `Type` | `JsonTypeInfo.Type` | CLR-`Type` находится на один шаг глубже, внутри метаданных `System.Text.Json`. |
| `MemberInfo` | `JsonPropertyInfo` | Не null только для схемы свойства. Читайте атрибуты через `JsonPropertyInfo.AttributeProvider`. |
| `ParameterInfo` | `ParameterDescription` | `ApiParameterDescription`; null для схемы ответа. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Как выше. |
| `DocumentName` | `DocumentName` | Без изменений. |

Держите эти две таблицы открытыми, пока мигрируете. Девяносто процентов каждого переписывания -- это переименование свойства контекста и подстройка под `JsonTypeInfo`.

## Шаги миграции

### 1. Сопоставьте каждый фильтр с его интерфейсом трансформера и регистрацией

Каждый `IOperationFilter` становится `IOpenApiOperationTransformer` (или встроенным делегатом `AddOperationTransformer`), а каждый `ISchemaFilter` становится `IOpenApiSchemaTransformer`. Синхронный `void Apply` становится асинхронным `TransformAsync`, который возвращает `Task` и принимает `CancellationToken`. Регистрация перемещается из колбэка `AddSwaggerGen` в блок опций `AddOpenApi`.

```csharp
// Before -- Swashbuckle registration, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.OperationFilter<AddCorrelationHeaderFilter>();
    c.SchemaFilter<MarkMoneyFormatFilter>();
});
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer<AddCorrelationHeaderTransformer>();
    options.AddSchemaTransformer<MarkMoneyFormatTransformer>();
});
```

**Проверьте:** проект по-прежнему компилируется с удалёнными или переименованными старыми классами фильтров, а `AddOpenApi` компилируется с новыми регистрациями. Пока ничего не выполняется корректно; следующие шаги заполнят тела.

### 2. Перенесите IOperationFilter, добавляющий ответ или заголовок

Это самый распространённый фильтр и самая механическая миграция. Тело почти не меняется: вы изменяете `operation` на месте. Защититесь от null-коллекции `Parameters` или `Responses`, которую встроенная модель оставляет null, а не выделяет заранее.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddCorrelationHeaderFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = "string" }
        });
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class AddCorrelationHeaderTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    }
}
```

Два изменения помимо сигнатуры: `Type = "string"` становится `Type = JsonSchemaType.String` (тип схемы в Microsoft.OpenApi v2 -- флаговый enum, а не строка), а пространство имён `OpenApiParameter` и компании -- `Microsoft.OpenApi`, а не `Microsoft.OpenApi.Models`. **Проверьте:** запросите `/openapi/v1.json` и убедитесь, что каждая операция теперь несёт параметр-заголовок `X-Correlation-Id`.

### 3. Перенесите IOperationFilter, читающий конечную точку

Условные фильтры, завязанные на маршрут, HTTP-метод или метаданные, -- это то, ради чего был нужен `OperationFilterContext`. `ApiDescription`, который вы читаете, -- тот же тип; он предоставляется как `context.Description`. Шаблон обнюхивания `EndpointMetadata` в поисках атрибута переносится дословно.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi;

internal sealed class ThrottleResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Если ваш старый фильтр обращался к `context.MethodInfo`, чтобы прочитать пользовательский атрибут, предпочтите вместо этого `context.Description.ActionDescriptor.EndpointMetadata`, поскольку конечные точки minimal API предоставляют свои метаданные там и могут не иметь осмысленного `MethodInfo`. **Проверьте:** выберите конечную точку с атрибутом ограничения частоты запросов и одну без него и убедитесь, что только первая показывает ответ `429` в документе.

### 4. Перенесите ISchemaFilter, формирующий тип

Тело фильтра схемы меняется ровно в одном месте: `context.Type` становится `context.JsonTypeInfo.Type`. Всё, что вы делали с `schema`, остаётся тем же.

```csharp
// Before -- Swashbuckle ISchemaFilter
public class DescribeTodoFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (context.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class DescribeTodoTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
        return Task.CompletedTask;
    }
}
```

**Проверьте:** найдите схему `Todo` под `components.schemas` в документе и убедитесь, что описание присутствует.

### 5. Перенесите ISchemaFilter, нацеленный на свойство

Swashbuckle сообщал, что схема -- это схема свойства, передавая вам не-null `context.MemberInfo`. Встроенный эквивалент -- не-null `context.JsonPropertyInfo`. Поскольку встроенный генератор работает на `System.Text.Json`, `JsonPropertyInfo.Name` -- это сериализованное JSON-имя (уже в camelCase, если такова ваша политика), а не имя члена CLR, что устраняет целый класс ошибок несовпадения регистра.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class EmailFormatTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonPropertyInfo?.Name == "email")
        {
            schema.Format = "email";
        }
        return Task.CompletedTask;
    }
}
```

Если ваш старый фильтр читал пользовательский атрибут из `MemberInfo`, получайте его через `context.JsonPropertyInfo?.AttributeProvider?.GetCustomAttributes(...)`, который предоставляет нижележащий `PropertyInfo`. **Проверьте:** убедитесь, что каждое свойство `email` во всех ваших схемах теперь несёт `"format": "email"`.

### 6. Перенесите поставщик примеров

Примеры схем -- то, что вероятнее всего не скомпилируется. Microsoft.OpenApi v2 удалил всю иерархию `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`). Примеры теперь -- `System.Text.Json.Nodes.JsonNode`.

```csharp
// Before -- Swashbuckle, IOpenApiAny example
schema.Example = new OpenApiString("dev@example.com");
```

```csharp
// After -- .NET 11, C# 14
using System.Text.Json.Nodes;

schema.Example = JsonValue.Create("dev@example.com");
```

Для составного примера постройте `JsonObject` вместо `OpenApiObject`: `new JsonObject { ["id"] = 1, ["title"] = "Write" }`. **Проверьте:** поле `example` целевой схемы отображается как корректный JSON в документе и в вашем интерфейсе.

### 7. Перенесите фильтр, которому нужны были аргументы конструктора или сервисы

Swashbuckle позволял передавать аргументы конструктора при регистрации (`c.OperationFilter<T>(arg1, arg2)`) или разрешать сервисы, потому что фильтры активировались из контейнера. Встроенная обобщённая регистрация `options.AddOperationTransformer<T>()` активирует трансформер из внедрения зависимостей, поэтому внедряйте через первичный конструктор, а не передавайте позиционные аргументы.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class TosLinkTransformer(IOptions<ApiInfoOptions> options)
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.ExternalDocs = new OpenApiExternalDocs
        {
            Url = options.Value.TermsOfServiceUrl
        };
        return Task.CompletedTask;
    }
}
```

Только обобщённая перегрузка участвует во внедрении зависимостей; `AddOperationTransformer(new T(...))` и перегрузка с делегатом -- нет. Обобщённая форма разрешается заново при каждой генерации документа и освобождается после, поэтому трансформер `IDisposable` очищается каждый раз, когда строится документ. **Проверьте:** внедрённое значение появляется в документе, и трансформер разрешается без ошибки "no service for type" при первом запросе.

### 8. Перенесите фильтр, генерировавший подсхемы

Самые хитрые фильтры вызывали `context.SchemaGenerator.GenerateSchema(type, context.SchemaRepository)`, чтобы построить схему для типа, который операция иначе не ссылалась, например общего тела ошибки. Встроенная замена -- `context.GetOrCreateSchemaAsync(...)` плюс `context.Document.AddComponent(...)`.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class ErrorResponseTransformer : IOpenApiOperationTransformer
{
    public async Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Обратите внимание на типизированный `OpenApiSchemaReference("Error", context.Document)` вместо собранного вручную `OpenApiReference`. **Проверьте:** схема `Error` появляется один раз под `components.schemas`, а операции ссылаются на неё, а не встраивают копию. Механика "сначала-трансформер" `GetOrCreateSchemaAsync` подробно разобрана в [настройке OpenAPI с помощью трансформеров операций и схем](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Верификация

Выполните это перед удалением старых классов фильтров:

- `dotnet build` чист, без ссылок на `Microsoft.OpenApi.Models` или интерфейсы фильтров `Swashbuckle.AspNetCore.SwaggerGen`.
- Сравните мигрированный `/openapi/v1.json` с эталоном, который вы сохранили в предполётной проверке. Ожидайте, что версия спецификации и обработка `nullable` будут отличаться (3.1 против 3.0); каждый ответ, заголовок, описание и пример, которые создавали ваши фильтры, должны совпадать операция за операцией.
- Каждое свойство, на которое был нацелен фильтр схемы, по-прежнему показывает тот же формат, пример или описание.
- `dotnet test` проходит, включая любой контрактный тест, фиксировавший форму документа.
- Если вы подаёте документ генератору клиентов, перегенерируйте и убедитесь, что он по-прежнему собирается. См. [генерация строго типизированного кода клиента из спецификации OpenAPI](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## План отката

Эта миграция обратима, пока вы не удалите классы фильтров. Поскольку каждое переписывание -- это новый класс трансформера рядом со старым фильтром, самый безопасный откат -- чистый базовый git-коммит из предполётной проверки: `git checkout` коммита и повторное добавление `c.OperationFilter<T>()` / `c.SchemaFilter<T>()` в блок `AddSwaggerGen`. Держите и фильтры, и трансформеры в дереве, пока мигрированный документ не отработает в реальной среде, затем удалите фильтры отдельным коммитом.

## Подводные камни, на которые мы наткнулись

**Трансформеры схем выполняются более одного раза для одного и того же типа.** Трансформер схемы срабатывает на каждое вхождение схемы, а проход, дедуплицирующий одинаковые схемы в `components.schemas`, идёт после трансформеров. У типа, используемого в трёх местах, трансформер вызывается три раза, поэтому держите логику идемпотентной: проверяйте перед добавлением и никогда не добавляйте в список, который можете посетить снова. У `ISchemaFilter` Swashbuckle была связанная острая грань (он не вызывался для уже сослаемых схем), поэтому не предполагайте, что старое число вызовов переносится.

**Порядок выполнения -- схемы, затем операции, затем документы.** Фильтры в Swashbuckle выполнялись в порядке регистрации внутри каждого вида. Встроенный конвейер выполняет сначала все трансформеры схем, затем трансформеры операций, затем трансформеры документов, и он работает на каждую генерацию документа. Трансформер операции не может полагаться на то, что трансформер документа отработал, потому что документы идут последними. На этом спотыкается всякий, кто поместил схему безопасности в трансформер документа и попытался сослаться на неё из трансформера операции в том же проходе.

**`context.Type` теперь на два шага дальше.** Самая частая ошибка компиляции после массовой замены -- оставить `context.Type` в трансформере схемы. Это `context.JsonTypeInfo.Type`. Близкий второй -- `context.MemberInfo`, который стал `context.JsonPropertyInfo`.

**Документ перегенерируется на каждый запрос.** `MapOpenApi` выполняет весь конвейер трансформеров каждый раз, когда достигается маршрут, поэтому держите трансформеры дешёвыми. Для нагруженного документа кешируйте его через `.CacheOutput()` на конечной точке или генерируйте на этапе сборки. Swashbuckle кешировал агрессивнее, поэтому тяжёлый фильтр, который раньше был в порядке, теперь может проявиться как задержка.

**`OpenApiSchema` -- конкретный тип в трансформере, но `IOpenApiSchema` появляется в других местах.** Делегат трансформера передаёт вам изменяемый `OpenApiSchema`. Другие API v2 возвращают `IOpenApiSchema`, поэтому вспомогательному методу, который раньше принимал `OpenApiSchema`, может понадобиться интерфейс. Если вы подключили схему безопасности через трансформер документа, а средство просмотра игнорирует токен, это почти всегда некорректная схема, а не ошибка клиента, что разобрано от начала до конца в [почему ваш токен Bearer игнорируется в Scalar](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

Ментальная модель мала, когда всё встаёт на место: фильтр и трансформер оба передают вам один и тот же объект OpenAPI для изменения, поэтому тело почти не меняется. Миграция -- это переименование свойств контекста, переход на `JsonTypeInfo`, перенос примеров на `JsonNode` и сохранение логики схемы идемпотентной, потому что теперь она выполняется более одного раза. Делайте это фильтр за фильтром, сравнивайте с эталоном, и документ, который вы отдаёте, -- тот, который ваши потребители уже ожидают.

## Похожие материалы

- [Миграция со Swashbuckle на встроенный генератор OpenAPI в .NET 11](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Как настроить OpenAPI с помощью трансформеров операций и схем в ASP.NET Core 11](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Как отдавать OpenAPI без Swashbuckle в ASP.NET Core 11](/ru/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Как организовать конечные точки minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Scalar в ASP.NET Core: почему ваш токен Bearer игнорируется](/ru/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)

## Источники

- [Настройка документов OpenAPI, документация ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [OpenApiSchemaTransformerContext, справочник API .NET](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.openapischematransformercontext)
- [IOpenApiOperationTransformer, справочник API .NET](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [Swashbuckle.AspNetCore, миграция на v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Руководство по обновлению Microsoft.OpenAPI v2](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
