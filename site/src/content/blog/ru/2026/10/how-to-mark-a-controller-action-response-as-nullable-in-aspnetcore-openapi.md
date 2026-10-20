---
title: "Как пометить ответ действия контроллера как допускающий null во встроенном документе OpenAPI в ASP.NET Core"
description: "Microsoft.AspNetCore.OpenApi помечает ответ как допускающий null, только когда действие возвращает голый T? (а в .NET 10 не помечает даже Task<T?>). ActionResult<T?> и IActionResult теряют аннотацию и в .NET 10, и в .NET 11 RC2. Здесь разобрано, почему так происходит, показан проверенный трансформер операций, который это исправляет, и ловушка с 204 No Content, из-за которой спецификация лжёт, пока вы не измените форматтер MVC."
pubDate: 2026-10-20
template: how-to
tags:
  - "aspnetcore"
  - "openapi"
  - "dotnet-11"
  - "dotnet-10"
  - "nullable-reference-types"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-mark-a-controller-action-response-as-nullable-in-aspnetcore-openapi"
translatedBy: "claude"
translationDate: 2026-10-20
---

**Короткий ответ:** в .NET 10 (`Microsoft.AspNetCore.OpenApi` 10.0.13) и .NET 11 RC2 (11.0.0-rc.2.26504.105) встроенный генератор оборачивает схему ответа в `oneOf: [{ "type": "null" }, ...]` только тогда, когда сам возвращаемый тип действия допускает null: `Person?`, а в .NET 11 ещё и `Task<Person?>`. Внутрь `ActionResult<Person?>` он не заглядывает, а у `IActionResult` с `[ProducesResponseType<Person>]` смотреть вообще не на что, поэтому в обоих случаях схема получается без null. Зарегистрируйте трансформер операций, который читает `MethodInfo` действия через `NullabilityInfoContext`, снимает обёртки `Task<>` и `ActionResult<>` и сам оборачивает схему ответа 2xx (код ниже, проверено на обеих версиях). Затем решите, что null на самом деле означает на уровне протокола, потому что MVC по умолчанию отправляет для null-результата **204 No Content**, а не `200` с `null`.

Я столкнулся с этим при генерации клиента через Kiota для API на контроллерах: сгенерированный метод для `GET /people/{id}` возвращал `Person` без null, хотя действие было объявлено как `ActionResult<Person?>`. Всё ниже измерено на тестовом приложении с SDK 10.0.302 (среда выполнения 10.0.10) и SDK 11.0.100-rc.2.26504.105: я выгружал `/openapi/v1.json` и дёргал каждый endpoint через curl.

## Что генератор выдаёт для каждой формы возвращаемого значения

В тестовом контроллере по одному действию на каждую форму, все возвращают `null`, при включённом `<Nullable>enable</Nullable>`:

```csharp
// .NET 10 / .NET 11 RC2, C# 14, <Nullable>enable</Nullable>
[ApiController]
[Route("people")]
public class PeopleController : ControllerBase
{
    [HttpGet("plain")]
    public Person? GetPlain() => null;

    [HttpGet("taskplain")]
    public async Task<Person?> GetTaskPlain() { await Task.Yield(); return null; }

    [HttpGet("actionresult")]
    public ActionResult<Person?> GetActionResult() => (Person?)null;

    [HttpGet("task")]
    public async Task<ActionResult<Person?>> GetTask() { await Task.Yield(); return (Person?)null; }

    [HttpGet("attr")]
    [ProducesResponseType<Person>(StatusCodes.Status200OK)]
    public IActionResult GetAttr() => Ok(null);

    [HttpGet("arint")]
    public ActionResult<int?> GetArInt() => (int?)null;
}
```

Вот схема ответа `200`, которую получила каждая форма:

| Возвращаемый тип | .NET 10.0.13 | .NET 11 RC2 |
|---|---|---|
| `Person?` | допускает null (`oneOf`) | допускает null (`oneOf`) |
| `Task<Person?>` | **не допускает null** | допускает null |
| `ActionResult<Person?>` | **не допускает null** | **не допускает null** |
| `Task<ActionResult<Person?>>` | **не допускает null** | **не допускает null** |
| `IActionResult` + `[ProducesResponseType<Person>]` | **не допускает null** | **не допускает null** |
| `ActionResult<int?>` | `type: ["null", "integer", "string"]`, без `oneOf` | допускает null (`oneOf`) |
| Minimal API `Person? () => null` | допускает null (`oneOf`) | допускает null (`oneOf`) |

"Допускает null" здесь означает, что схема получилась такой:

```json
"schema": {
  "oneOf": [
    { "type": "null" },
    { "$ref": "#/components/schemas/Person" }
  ]
}
```

а "не допускает null" означает голый `{ "$ref": "#/components/schemas/Person" }`. Сам компонент `Person` никогда не помечается как допускающий null. Это сделано намеренно: начиная с .NET 10 RC1 ([dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)) генератор держит один общий компонент на тип, а допустимость null выражает в месте использования через встроенную обёртку `oneOf`, поэтому тип, допускающий null в одном endpoint и не допускающий в другом, не раздваивается на два компонента.

## Почему ActionResult<T?> теряет аннотацию

Решение принимается в одном внутреннем методе, `TypeExtensions.ShouldApplyNullableResponseSchema` в `src/OpenApi/src/Extensions/TypeExtensions.cs`. В теге `v10.0.0` он делает следующее:

1. Берёт `MethodInfo` действия из `ControllerActionDescriptor`.
2. Снимает `Task<T>` или `ValueTask<T>` с `MethodInfo.ReturnType`.
3. Если этот тип не *равен* `ApiResponseType.Type` (тип, который ApiExplorer сообщает для ответа), возвращает `false`.
4. Иначе выполняет `NullabilityInfoContext.Create(methodInfo.ReturnParameter)` и проверяет `WriteState == Nullable`.

На шаге 3 `ActionResult<Person?>` и отсеивается. ApiExplorer сообщает тип ответа `Person`, метод возвращает `ActionResult<Person>`, типы не равны, на этом всё. До проверки допустимости null дело не доходит. То же с `IActionResult` и атрибутом: возвращаемый тип `IActionResult`, тип ответа `Person`.

Шаг 4 объясняет промах `Task<Person?>` в .NET 10. Развёрнутый тип совпадает, но проверка допустимости null выполняется для *исходного* возвращаемого параметра, то есть для `Task<Person?>`. Сам `Task` не допускает null, поэтому `WriteState` равен `NotNull`.

[dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661), влитый в июле 2026 и вошедший в .NET 11, переписал этот метод. Теперь он сразу возвращает результат по `ModelMetadata.IsNullableValueType` (это чинит `ActionResult<int?>`), а для ссылочных типов проходит по `NullabilityInfo.GenericTypeArguments[0]` сквозь `Task<>`/`ValueTask<>` (это чинит `Task<Person?>`). `ActionResult<>` он не разворачивает, поэтому для ссылочного типа `NullabilityInfo` останавливается на `ActionResult<Person?>`, который не null, и результат по-прежнему `false`. В описании PR об этом прямо сказано: обработка ссылочных типов "is still not handled very well in this PR". Тег RC2 и `main` содержат тот же код, что и RC1, так что не ждите изменений до GA.

## Исправление: трансформер операций, который разворачивает ActionResult<T>

Встроенный конвейер передаёт в трансформер операции полный `ApiDescription`, и этого достаточно, чтобы выполнить проверку заново, но правильно. Этот трансформер обрабатывает два случая: допустимость null, которую можно вывести из возвращаемого типа, и явный атрибут `[NullableResponse(statusCode)]` для действий с `IActionResult`, где выводить нечего.

```csharp
// .NET 10 and .NET 11 (Microsoft.AspNetCore.OpenApi 10.0.x / 11.0.0-rc.2)
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class NullableResponseAttribute(int statusCode) : Attribute
{
    public int StatusCode { get; } = statusCode;
}

public sealed class NullableResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.Description.ActionDescriptor is not ControllerActionDescriptor action
            || operation.Responses is null)
        {
            return Task.CompletedTask;
        }

        // 1. Explicit opt-in: [NullableResponse(200)]
        var statusCodes = action.MethodInfo
            .GetCustomAttributes<NullableResponseAttribute>()
            .Select(a => a.StatusCode)
            .ToHashSet();

        // 2. Inferred from the return type: T?, ActionResult<T?>, and their Task/ValueTask forms
        if (TryGetNullableResponseType(action.MethodInfo, out var valueType))
        {
            foreach (var responseType in context.Description.SupportedResponseTypes)
            {
                if (responseType.Type == valueType && responseType.StatusCode is >= 200 and < 300)
                {
                    statusCodes.Add(responseType.StatusCode);
                }
            }
        }

        foreach (var statusCode in statusCodes)
        {
            if (!operation.Responses.TryGetValue(statusCode.ToString(), out var response)
                || response.Content is null)
            {
                continue;
            }

            foreach (var mediaType in response.Content.Values)
            {
                // Microsoft.OpenApi 3.x (.NET 11) exposes IOpenApiMediaType with a read-only Schema.
                if (mediaType is OpenApiMediaType { Schema: { } schema } concrete && !IsNullWrapper(schema))
                {
                    concrete.Schema = new OpenApiSchema
                    {
                        OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, schema]
                    };
                }
            }
        }

        return Task.CompletedTask;
    }

    private static bool TryGetNullableResponseType(MethodInfo method, out Type? valueType)
    {
        var type = method.ReturnType;
        var nullability = new NullabilityInfoContext().Create(method.ReturnParameter);

        if (type.IsGenericType
            && (type.GetGenericTypeDefinition() == typeof(Task<>)
                || type.GetGenericTypeDefinition() == typeof(ValueTask<>)))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ActionResult<>))
        {
            type = type.GetGenericArguments()[0];
            nullability = nullability.GenericTypeArguments[0];
        }

        valueType = type;
        return nullability.WriteState == NullabilityState.Nullable;
    }

    private static bool IsNullWrapper(IOpenApiSchema schema) =>
        schema.OneOf?.Any(s => s.Type == JsonSchemaType.Null) == true;
}
```

Зарегистрируйте его для каждого публикуемого документа:

```csharp
// .NET 10 / .NET 11 RC2
builder.Services.AddControllers();
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

А атрибут используйте там, где возвращаемый тип ничего не сообщает:

```csharp
// .NET 10 / .NET 11 RC2
[HttpGet("attr")]
[ProducesResponseType<Person>(StatusCodes.Status200OK)]
[NullableResponse(StatusCodes.Status200OK)]
public IActionResult GetAttr() => Ok(null);
```

С зарегистрированным трансформером каждая строка таблицы выше дала обёртку `oneOf` на обеих версиях, включая `Task<Person?>` в .NET 10. `ActionResult<Person>`, не допускающий null, остался простым `$ref`.

Несколько проектных решений стоит пояснить:

- **Он оборачивает место использования, а не компонент.** Это соответствует тому, что сам фреймворк делает с #63301. Если вместо этого задать `Type |= JsonSchemaType.Null` для компонента `Person` в трансформере схемы, то каждый endpoint, возвращающий `Person`, станет допускать null, в том числе те, что null никогда не возвращают.
- **Он трогает только ответы 2xx, чей тип совпадает с объявленным `T`.** Ответ `404` с `ProblemDetails` у того же действия остаётся нетронутым.
- **Он идемпотентен.** Если фреймворк уже обернул схему (голый `Person?` или `Task<Person?>` в .NET 11), `IsNullWrapper` её пропускает, и `oneOf` внутри `oneOf` не появляется. Когда фреймворк научится обрабатывать `ActionResult<T?>`, трансформер молча превратится в пустую операцию.
- **Паттерн `is OpenApiMediaType` нужен для .NET 11.** `Microsoft.AspNetCore.OpenApi` 10.0.13 подтягивает `Microsoft.OpenApi` 2.x, где значения `Content` являются конкретным `OpenApiMediaType`. Пакет 11.0 RC2 подтягивает `Microsoft.OpenApi` 3.10.2, где `Content` это `IDictionary<string, IOpenApiMediaType>`, а у `IOpenApiMediaType.Schema` нет setter. Присваивание через интерфейс завершается ошибкой `CS0200: Property or indexer 'IOpenApiMediaType.Schema' cannot be assigned to -- it is read only`. Сопоставление с образцом компилируется на обеих версиях.

Общую механику трансформеров (порядок, активацию через DI, объект контекста) смотрите в [подробном разборе трансформеров](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Ловушка: null-результат контроллера это 204, а не 200

Вот что те же endpoints реально вернули по сети, одинаково в .NET 10 и .NET 11 RC2:

```text
GET /people/actionresult   -> HTTP/1.1 204 No Content   (no body)
GET /people/plain          -> HTTP/1.1 204 No Content
GET /people/taskplain      -> HTTP/1.1 204 No Content
GET /minimal/maybe         -> HTTP/1.1 200 OK, application/json, body: null
```

MVC по умолчанию регистрирует `HttpNoContentOutputFormatter`, у которого свойство `TreatNullValueAsNoContent` по умолчанию равно `true`: любой объектный результат `null` превращается в `204` с пустым телом. В Minimal API такого форматтера нет, поэтому они действительно отправляют `200` с JSON-литералом `null`.

Это значит, что для контроллеров собственная обёртка `oneOf` фреймворка у голого `Person?` уже описывает ответ, которого сервер никогда не отправляет: клиент, сгенерированный из такой спецификации, ожидает `200` с `null`, а получает `204`. Поэтому выберите один из двух честных контрактов.

### Вариант A: оставить 204 и задокументировать его

Не трогайте MVC, оставьте схему `200` без null и объявите `204`:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 204 No Content
[HttpGet("{id:int}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status204NoContent)]
public async Task<ActionResult<Person?>> Get(int id) => await _people.FindAsync(id);
```

В такой конфигурации обёртка для допустимости null на `200` не нужна, поэтому не регистрируйте трансформер, и помните, что у голого возвращаемого `Person?` обёртка от фреймворка всё равно появится. Большинство генераторов клиентов трактуют `204` без тела как "результата нет", что обычно и нужно вызывающей стороне.

### Вариант B: отправлять 200 с null и пометить 200 как допускающий null

Отключите преобразование в no-content, а затем пусть трансформер опишет результат:

```csharp
// .NET 10 / .NET 11 RC2: null result -> 200 OK with body "null"
using Microsoft.AspNetCore.Mvc.Formatters;

builder.Services.AddControllers(o =>
{
    var noContent = o.OutputFormatters.OfType<HttpNoContentOutputFormatter>().Single();
    noContent.TreatNullValueAsNoContent = false;
});
builder.Services.AddOpenApi(o => o.AddOperationTransformer<NullableResponseTransformer>());
```

После этого изменения `GET /people/actionresult` вернул `HTTP/1.1 200 OK`, `Content-Type: application/json; charset=utf-8`, тело `null`, что в точности соответствует схеме `oneOf`. Действие `void` не изменилось (и до, и после оно возвращало `200` с пустым телом). На странице Microsoft Learn про форматирование показан другой способ, `o.OutputFormatters.RemoveType<HttpNoContentOutputFormatter>()`; я предпочитаю переключать свойство, потому что оно явно выражает намерение и не затрагивает остальные случаи форматтера.

Используйте вариант B, когда API потребляет что-то, уже ожидающее `200`/`null`, или когда вы переносите endpoints между контроллерами и Minimal API и хотите, чтобы они вели себя одинаково. Во всех остальных случаях используйте вариант A: это поведение фреймворка по умолчанию, и трансформер не нужен.

## Подводные камни и граничные случаи

**Любой `[ProducesResponseType]` убирает выведенный 200.** В первом тесте я поставил на действие `ActionResult<Person?>` только `[ProducesResponseType(StatusCodes.Status404NotFound)]`, и ответ `200` полностью исчез из документа, так что трансформеру нечего было оборачивать. Как только у действия есть явные метаданные ответов, ApiExplorer перестаёт добавлять `200` по умолчанию для `ActionResult<T>`. Добавьте `[ProducesResponseType(StatusCodes.Status200OK)]` (тип не нужен, `T` подставится сам) рядом с кодами ошибок.

**`string?` это не JSON.** Действие с `string?`, возвращающее null, вернуло `200` с `Content-Type: text/plain` и пустым телом, когда `TreatNullValueAsNoContent` был выключен, потому что для строк побеждает `StringOutputFormatter`. Документ при этом по-прежнему объявляет `application/json` с допускающей null строкой. Если вы возвращаете строки из контроллеров, добавьте `[Produces("application/json")]` или возвращайте небольшой DTO.

**Вывод OpenAPI 3.0 выглядит иначе, но означает то же самое.** При `o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0` `Microsoft.OpenApi` сериализует ветку null как `{ "enum": [null], "nullable": true }` внутри `oneOf`. Это корректно для 3.0, и генераторы это понимают. По умолчанию используется `3.1.1` в .NET 10 и `3.2.0` в .NET 11; если Swagger UI отказывается открывать документ 3.2, см. [исправление Swagger UI для .NET 11](/ru/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/).

**Контекст допустимости null имеет значение.** `NullabilityInfoContext` читает метаданные `[Nullable]` компилятора. В файле или проекте с отключёнными ссылочными типами, допускающими null, `Person?` вызывает предупреждение, а `Person` сообщается как `Unknown`, а не `Nullable`, поэтому ни фреймворк, ни трансформер ничего не помечают. Это правильный исход: код без аннотаций не даёт никаких обещаний в ту или иную сторону.

**Типизированные результаты это отдельный путь кода.** Minimal API и контроллеры, возвращающие `Results<Ok<Person>, NotFound>`, описывают ответы через `IEndpointMetadataProvider`, а не через возвращаемый тип метода. Я проверил и Minimal API, возвращающий `Results<Ok<Person?>, NotFound>`, и действие контроллера, возвращающее `Ok<Person?>`: в .NET 10 и .NET 11 RC2 схема `200` была простой ссылкой на `Person`. Приведённый выше трансформер тоже ничего не выводит из `Ok<T>`, поэтому ставьте `[NullableResponse(200)]` на такие действия контроллеров (для Minimal API используйте `AddOperationTransformer` с проверкой по маршруту, поскольку там нет `ControllerActionDescriptor`). Если вы выбираете между формами, [типизированные результаты, IResult и IActionResult](/ru/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/) объясняют, что каждая из них сообщает ApiExplorer.

**Не "чините" это в трансформере схемы.** Соблазн сделать `Person` допускающим null глобально, чтобы каждый `$ref` принимал null, понятен. Но вы теряете различие между endpoints, а в OpenAPI 3.1+ обёртка `oneOf`, которую фреймворк добавляет в других местах, получает две ветви, обе из которых соответствуют `null`, и `oneOf` не проходит валидацию (он требует ровно одного совпадения). В PR #67661 именно эта причина названа для того, чтобы внутренняя схема оставалась без null.

## Читайте дальше

- [Как настроить документ OpenAPI с помощью AddOperationTransformer и AddSchemaTransformer в ASP.NET Core 11](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Типизированные результаты (Results<>), IResult и IActionResult в ASP.NET Core 11](/ru/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Миграция со Swashbuckle на встроенный генератор OpenAPI в .NET 11](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Как сгенерировать строго типизированный клиентский код из спецификации OpenAPI в .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Исправление: Swagger UI показывает Unable to render this definition после перехода на .NET 11](/ru/2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11/)

## Источники

- [TypeExtensions.cs (`ShouldApplyNullableResponseSchema`), dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/OpenApi/src/Extensions/TypeExtensions.cs)
- [Fix nullability handling in OpenApi, dotnet/aspnetcore#67661](https://github.com/dotnet/aspnetcore/pull/67661)
- [Model nullable types using oneOf in OpenAPI schema, dotnet/aspnetcore#63301](https://github.com/dotnet/aspnetcore/pull/63301)
- [Model nullable types using allOf in JSON schema (tracking issue), dotnet/aspnetcore#63029](https://github.com/dotnet/aspnetcore/issues/63029)
- [Customize OpenAPI documents, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi)
- [Format response data in ASP.NET Core Web API (special-case formatters), Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/web-api/advanced/formatting)
- [HttpNoContentOutputFormatter.TreatNullValueAsNoContent, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.formatters.httpnocontentoutputformatter.treatnullvalueasnocontent)
- [NullabilityInfoContext, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.nullabilityinfocontext)
