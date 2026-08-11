---
title: "Решение: The type or namespace name 'OpenApiReference' could not be found"
description: "OpenApiReference удалён в Microsoft.OpenApi 2.0. Смены using на Microsoft.OpenApi недостаточно: замените каждое использование типизированной ссылкой вроде OpenApiSchemaReference."
pubDate: 2026-08-11
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "openapi"
lang: "ru"
translationOf: "2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-08-11
---

Типа `OpenApiReference` больше нет. В Microsoft.OpenApi 2.0 все пространства имён модели были объединены в `Microsoft.OpenApi`, а сам обобщённый тип ссылки удалён, поэтому замена `using Microsoft.OpenApi.Models;` на `using Microsoft.OpenApi;` убирает ошибку про пространство имён и оставляет эту. Решение состоит в том, чтобы заменить каждое `new OpenApiReference { Type = ..., Id = "X" }` на типизированный класс ссылки для того компонента, на который вы указывали, например `new OpenApiSchemaReference("X", document)` или `new OpenApiSecuritySchemeReference("Bearer", document)`. Всё изложенное ниже проверено на SDK 10.0.201, `Microsoft.AspNetCore.OpenApi` 10.0.10 и `Microsoft.OpenApi` 2.11.0.

## Ошибка в контексте

В этом семействе две ошибки, и по поиску сюда приходят с любой из них. Если старые директивы `using` ещё на месте, компилятор жалуется на пространство имён, а не на тип:

```
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
error CS0234: The type or namespace name 'Any' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
```

Удалите эти using или замените их на `using Microsoft.OpenApi;`, и вы получите ту ошибку, из-за которой сюда и пришли:

```
error CS0246: The type or namespace name 'OpenApiReference' could not be found (are you missing a using directive or an assembly reference?)
error CS0246: The type or namespace name 'OpenApiString' could not be found (are you missing a using directive or an assembly reference?)
error CS0117: 'OpenApiSecurityScheme' does not contain a definition for 'Reference'
error CS0029: Cannot implicitly convert type 'string' to 'Microsoft.OpenApi.JsonSchemaType?'
error CS1061: 'OpenApiDocument' does not contain a definition for 'SerializeAsJson'
```

Второй блок и есть ключевой признак. `CS0234` означает «пространство имён переехало». `CS0246` именно на `OpenApiReference` означает «тип исчез», и никакая директива using его не вернёт.

## Почему это происходит

Начиная с версии 10.0 пакет `Microsoft.AspNetCore.OpenApi` жёстко зависит от Microsoft.OpenApi 2.x, и .NET 11 это сохраняет. Добавьте пакет в пустой веб-проект `net10.0`, и транзитивная зависимость станет видна:

```
> Microsoft.AspNetCore.OpenApi      10.0.10     10.0.10
   > Microsoft.OpenApi              2.0.0
```

Microsoft.OpenApi 2.0 внёс три изменения, которые сходятся на одной и той же строке вашего кода:

- **Пространства имён были объединены.** `Microsoft.OpenApi.Models`, `Microsoft.OpenApi.Any`, `Microsoft.OpenApi.Interfaces` и `Microsoft.OpenApi.Writers` слились в `Microsoft.OpenApi`. Публичная сборка теперь предоставляет ровно три пространства имён: `Microsoft.OpenApi`, `Microsoft.OpenApi.Reader` и `Microsoft.OpenApi.MicrosoftExtensions`.
- **`OpenApiReference` удалён** вместе со свойством `Reference` у всех ссылаемых моделей. У `OpenApiSecurityScheme` вообще нет члена `Reference`, отсюда и `CS0117` выше.
- **Ссылки стали полноценными типами.** Вместо того чтобы прикреплять ссылку к пустой модели, вы создаёте отдельный объект ссылки, реализующий тот же интерфейс, что и его цель.

Если вы используете Swashbuckle, а не встроенный генератор, тот же обрыв находится на один пакет дальше. Swashbuckle.AspNetCore 9.0.6 разрешается в `Microsoft.OpenApi` 1.6.25, и старый код продолжает компилироваться; Swashbuckle.AspNetCore 10.1.0 разрешается в `Microsoft.OpenApi` 2.3.0, и компиляция прекращается. Ломает вас обновление Swashbuckle, а не обновление SDK.

## Минимальное воспроизведение

Вот форма, которая есть почти у всех, обычно внутри вызова `AddSecurityRequirement` из Swagger, скопированного из какого-нибудь руководства по JWT:

```csharp
// FAILS on .NET 10/11 with Microsoft.OpenApi 2.x
using Microsoft.OpenApi.Models;
using Microsoft.OpenApi.Any;

var reference = new OpenApiReference
{
    Type = ReferenceType.SecurityScheme,
    Id = "Bearer"
};

var scheme = new OpenApiSecurityScheme
{
    Reference = reference
};

var schema = new OpenApiSchema
{
    Type = "string",
    Default = new OpenApiString("hello")
};

var json = new OpenApiDocument().SerializeAsJson(OpenApiSpecVersion.OpenApi3_0);
```

Шесть строк и пять разных ломающих изменений. Устранять их по одной ошибке компилятора за раз медленно, поэтому полезно знать всю схему соответствий заранее.

## Решение по шагам

### 1. Замените директивы using

Все using моделей `Microsoft.OpenApi.*` схлопываются в один:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
using Microsoft.OpenApi;
using System.Text.Json.Nodes;   // needed wherever you used IOpenApiAny
```

Замена `using Microsoft.OpenApi.Models;` на `using Microsoft.OpenApi;` по всему проекту безопасна. `using Microsoft.OpenApi.Any;` и `using Microsoft.OpenApi.Interfaces;` просто удалите.

### 2. Замените OpenApiReference типизированной ссылкой

Это та часть, которую никакой `using` не исправит. В Microsoft.OpenApi 2.x есть по одному классу ссылки на каждый ссылаемый компонент, и у всех одинаковая форма конструктора `(string referenceId, OpenApiDocument hostDocument = null, string externalResource = null)`:

| Прежний `ReferenceType` | Новый тип |
| --- | --- |
| `ReferenceType.Schema` | `OpenApiSchemaReference` |
| `ReferenceType.SecurityScheme` | `OpenApiSecuritySchemeReference` |
| `ReferenceType.Parameter` | `OpenApiParameterReference` |
| `ReferenceType.RequestBody` | `OpenApiRequestBodyReference` |
| `ReferenceType.Response` | `OpenApiResponseReference` |
| `ReferenceType.Header` | `OpenApiHeaderReference` |
| `ReferenceType.Example` | `OpenApiExampleReference` |
| `ReferenceType.Link` | `OpenApiLinkReference` |
| `ReferenceType.Callback` | `OpenApiCallbackReference` |
| `ReferenceType.Tag` | `OpenApiTagReference` |
| `ReferenceType.PathItem` | `OpenApiPathItemReference` |

Так ссылка на схему безопасности превращается в одно выражение:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
// old: new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }
var schemeRef = new OpenApiSecuritySchemeReference("Bearer", document);
```

Эти типы ссылок реализуют интерфейс своей цели (`OpenApiSchemaReference` является `IOpenApiSchema`, `OpenApiSecuritySchemeReference` является `IOpenApiSecurityScheme`), поэтому они напрямую подходят к тем коллекциям, которые раньше принимали саму модель.

### 3. Устраните сопутствующие поломки на тех же строках

В том же блоке обычно всплывают ещё три переименования:

- `OpenApiSchema.Type` из `string` превратился во флаговое перечисление `JsonSchemaType` с членами `Null`, `Boolean`, `Integer`, `Number`, `String`, `Object` и `Array`. Поскольку это `[Flags]`-перечисление, допустимость null в OpenAPI 3.1 выражается как `JsonSchemaType.String | JsonSchemaType.Null`, а не отдельным свойством `Nullable`.
- Вся иерархия `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiArray`, `OpenApiObject` и прочие) удалена в пользу `JsonNode` из `System.Text.Json.Nodes`.
- `SerializeAsJson` и `SerializeAsYaml` теперь асинхронные методы расширения: `SerializeAsJsonAsync` и `SerializeAsYamlAsync`. `Maximum`, `Minimum`, `ExclusiveMaximum` и `ExclusiveMinimum` сменили тип с `double?` на `string?`, чтобы числа произвольной точности переживали полный цикл сериализации.

### 4. Полный рабочий вариант

Вот воспроизведение выше, переписанное в виде трансформера документа, который вы бы и правда зарегистрировали в приложении на .NET 11. Он компилируется без замечаний с `Microsoft.AspNetCore.OpenApi` 10.0.10:

```csharp
// .NET 11, Microsoft.AspNetCore.OpenApi 10.0.10, Microsoft.OpenApi 2.11.0
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

public sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= new List<OpenApiSecurityRequirement>();
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = new List<string>()
        });

        return Task.CompletedTask;
    }
}
```

И эквиваленты на стороне схем:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var schema = new OpenApiSchema
{
    Type = JsonSchemaType.String | JsonSchemaType.Null,   // was Type = "string" + Nullable = true
    Default = (JsonNode)"hello",                          // was new OpenApiString("hello")
    Enum = new List<JsonNode> { (JsonNode)"a", (JsonNode)"b" },
    Maximum = "100"                                       // was double? Maximum = 100
};

IOpenApiSchema widgetRef = new OpenApiSchemaReference("Widget", document);

string json = await document.SerializeAsJsonAsync(OpenApiSpecVersion.OpenApi3_1);
```

Сериализация построенного так документа даёт ровно то, чего вы ожидаете: требование безопасности выражено именем схемы, компонент на месте:

```json
{
  "openapi": "3.1.1",
  "components": {
    "securitySchemes": {
      "Bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [ { "Bearer": [ ] } ]
}
```

## Подводные камни, которые проявляются уже после успешной сборки

**Не «чините» это обновлением Microsoft.OpenApi до 3.x.** Соблазн есть, потому что 3.9.0 - текущая версия в NuGet, тогда как ASP.NET Core 10 фиксирует 2.0.0. Добавьте явную `PackageReference` на 3.9.0 в проект со встроенным генератором, и сборка упадёт внутри собственного сгенерированного кода Microsoft:

```
obj\Debug\net10.0\Microsoft.AspNetCore.OpenApi.SourceGenerators\...\OpenApiXmlCommentSupport.generated.cs(399,41):
error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only
```

Генератор исходного кода для XML-комментариев, поставляемый с `Microsoft.AspNetCore.OpenApi` 10.0.10, написан под поверхность 2.x. Оставайтесь на линии 2.x, пока не сдвинется сам пакет ASP.NET Core.

**А вот зафиксировать Microsoft.OpenApi на 2.7.5 или новее стоит.** Версия 2.0.0, которую ASP.NET Core 10.0.10 подтягивает транзитивно, несёт уведомление высокой серьёзности, и NuGet сообщит об этом при восстановлении:

```
warning NU1903: Package 'Microsoft.OpenApi' 2.0.0 has a known high severity vulnerability
```

Это CVE-2026-49451, неконтролируемая рекурсия на циклических ссылках схем, затрагивающая версии с 2.0.0-preview.11 по 2.7.4 и с 3.0.0 по 3.5.3. Явная `<PackageReference Include="Microsoft.OpenApi" Version="2.11.0" />` убирает предупреждение и по-прежнему собирается без замечаний с генератором из 10.0.10. Особенно это важно, если ваше приложение разбирает документы OpenAPI, написанные не вами.

**Коллекции больше не инициализируются сами.** В 1.x `new OpenApiDocument().Components` возвращал пустой `OpenApiComponents`. В 2.x там null, как и в `Components.Schemas`, `Components.SecuritySchemes` и `Document.Tags`. `Paths` и `Servers` по-прежнему инициализируются. Именно поэтому трансформер выше применяет `??=` на каждом уровне перед индексацией, и именно поэтому это самое частое `NullReferenceException` сразу после успешной сборки обновлённого проекта.

**Ссылки разрешаются лениво через workspace документа.** Если вы собираете документ вручную, а не доверяете это ASP.NET Core, свойство `Target` у ссылки остаётся null, а её проксируемые свойства возвращаются пустыми, пока компоненты не зарегистрированы:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var reference = new OpenApiSchemaReference("Widget", document);
// reference.Target is null here, reference.Description is empty

document.Workspace.RegisterComponents(document);
// reference.Target is now resolved, reference.Description reads through to the target
```

Разрешение ленивое, поэтому ссылка, созданная до вызова `RegisterComponents`, начинает разрешаться корректно после него. Сериализация выводит `$ref` в любом случае; удивляет именно чтение через прокси.

**Следите за интерфейсными типами в сигнатурах трансформеров.** `Components.Schemas` - это `IDictionary<string, IOpenApiSchema>`, а `Components.SecuritySchemes` - `IDictionary<string, IOpenApiSecurityScheme>`, а не конкретные классы. Коду, который рассчитывал на конкретный тип, теперь нужно приведение или сопоставление с образцом, поскольку значением может оказаться объект ссылки, а не встроенная схема.

**`OpenApiSecuritySchemeReference` не отображается как `$ref`.** Его `Reference.ReferenceV3` - это просто `Bearer`, тогда как у `OpenApiSchemaReference("Widget")` это `#/components/schemas/Widget`. Так и должно быть по спецификации OpenAPI: требование безопасности адресуется именем схемы. Не ищите в выводе пропавший `$ref`.

## Похожие материалы

Если вы разбираете более крупное обновление OpenAPI, соседние темы разобраны здесь: уход от Swashbuckle описан в статье [миграция с Swashbuckle на встроенный генератор OpenAPI](/ru/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/), а сопутствующее переписывание фильтров в трансформеры - в статье [перенос IOperationFilter и ISchemaFilter в трансформеры OpenAPI](/ru/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/). Про сам API трансформеров смотрите [настройку документа через AddOperationTransformer и AddSchemaTransformer](/ru/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/). Когда документ снова собирается, его ещё нужно где-то показать, и об этом статья [публикация документации OpenAPI через Scalar](/ru/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/). А если эта ошибка всплыла в рамках более крупного перехода, [чек-лист с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) перечисляет остальные пакеты, сдвинувшиеся в то же время.

## Источники

- [Руководство по переходу на OpenAPI.NET 2.0](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md), авторитетный список удалённых типов и переименованных свойств.
- [Issue 61123 в dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/issues/61123), сообщение об исчезновении `OpenApiSecurityScheme.Reference` в .NET 10 Preview 2.
- [Issue 3522 в Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3522), смена пространств имён глазами пользователей Swashbuckle.
- [GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc) / CVE-2026-49451, уведомление, стоящее за предупреждением `NU1903`.
