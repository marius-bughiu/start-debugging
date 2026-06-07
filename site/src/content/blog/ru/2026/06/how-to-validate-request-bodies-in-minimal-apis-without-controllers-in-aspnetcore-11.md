---
title: "Как валидировать тело запроса в minimal API без контроллеров в ASP.NET Core 11"
description: "В ASP.NET Core 11 есть встроенная валидация для minimal API: вызовите AddValidation, разметьте record запроса атрибутами DataAnnotations, и генератор исходного кода проверит связанную модель и вернёт 400 ProblemDetails ещё до запуска вашего обработчика. Без контроллеров, без FluentValidation, без ручных проверок."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ru"
translationOf: "2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Годами честным ответом на вопрос "как мне валидировать тело запроса в minimal API" было "никак, по крайней мере не автоматически." Minimal API появились без машинерии `ModelState`, которую контроллеры получают бесплатно, поэтому вы прибегали к `FluentValidation`, пакету `MiniValidation` или написанному вручную блоку `if` в каждом обработчике. Это изменилось в .NET 10 и без изменений сохраняется в .NET 11: вызовите `builder.Services.AddValidation()`, разметьте свой тип запроса теми же атрибутами из `System.ComponentModel.DataAnnotations`, которые вы уже знаете (`[Required]`, `[Range]`, `[EmailAddress]`), и генератор исходного кода создаёт endpoint filter, который валидирует связанную модель до того, как выполнится тело вашего обработчика. Недопустимые запросы возвращаются как `400 Bad Request` с телом `ProblemDetails`, без проверки `ModelState.IsValid`, без контроллера, без дополнительного пакета. Всё ниже нацелено на .NET 11 с `Microsoft.NET.Sdk.Web` и C# 14; возможность идентична в .NET 10, где она впервые появилась.

## Почему у minimal API изначально не было валидации

Это было не упущение, а проектное решение. Валидация моделей в MVC работает через конвейер на основе рефлексии: она обходит граф модели в среде выполнения, обнаруживает экземпляры `ValidationAttribute`, вызывает их и заполняет `ModelState`. Именно такая рефлексия и есть тот тип затрат на старте и на каждый запрос, которого стек minimal API был призван избежать, и она враждебна trimming и Native AOT. Поэтому исходная поверхность minimal API связывала ваши параметры и вызывала ваш обработчик, и всё. Если тело было мусором, ваш обработчик видел мусор.

Решение в .NET 10 обходит проблему рефлексии с помощью генератора исходного кода. Во время компиляции он находит каждый тип, используемый как параметр minimal API, читает атрибуты `DataAnnotations` на этих типах и генерирует код валидации напрямую. Никакой рефлексии графа модели в среде выполнения нет, и именно это делает возможность совместимой с лёгкой, дружественной к AOT моделью endpoint. Если вы всё ещё взвешиваете два стиля endpoint, более широкие компромиссы изложены в [minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); это руководство предполагает, что вы остановились на minimal API и хотите вернуть валидацию.

## Три шага, чтобы включить валидацию

1. **Зарегистрируйте сервисы.** Вызовите `builder.Services.AddValidation()` до сборки приложения. Это регистрирует сервисы валидации и endpoint filter, который их запускает.
2. **Убедитесь, что генератор исходного кода активен.** С веб-SDK .NET 10 или .NET 11 генератор валидации подключается автоматически, как только вы вызываете `AddValidation()`. Если ваша сборка предшествует финальному выпуску или вы скопировали урезанный `.csproj`, генератор создаёт перехватчики в пространстве имён `Microsoft.AspNetCore.Http.Validation.Generated`; убедитесь, что это пространство имён включено в `InterceptorsNamespaces` (в текущих сборках SDK делает это за вас).
3. **Разметьте тип запроса и сделайте его `public`.** Поставьте атрибуты `DataAnnotations` на свойства или позиционные параметры вашего record или класса запроса. Тип должен быть `public`, потому что генератор может видеть и генерировать код только для доступных типов.

Это вся настройка. Вот подключение в `Program.cs`:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();          // step 1
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Если `.csproj` когда-либо понадобится свойство явно (более старые SDK), оно выглядит так:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

## Что на самом деле возвращает недопустимый запрос

Отправьте POST с телом, нарушающим два правила, и вы получите машиночитаемый `400`, не написав ни строки обработки ошибок:

```bash
# .NET 11
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"x","name":"","quantity":0}'
```

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."],
    "Quantity": ["The field Quantity must be between 1 and 10000."]
  }
}
```

Это тело является `HttpValidationProblemDetails`, той же формой RFC 9457 / RFC 7807, которую производит MVC, поэтому существующие клиенты, уже разбирающие `errors`, продолжают работать. Обработчик не запускается никогда. Нет `ModelState`, нет проверки `IsValid`, нечего забывать. Словарь ошибок индексируется по имени свойства, а вложенные члены используют путь с точками, что становится важным, как только ваши модели перестают быть плоскими.

## Вложенные объекты валидируются рекурсивно

Валидация автоматически заходит в сложные свойства. Запрос с объектом адреса валидирует и адрес тоже, и ключи ошибок отражают путь:

```csharp
// .NET 11, C# 14
public record CreateOrder(
    [Required, EmailAddress] string CustomerEmail,
    [Required] BillingAddress Billing);

public record BillingAddress(
    [Required, MinLength(2)] string Street,
    [Required, Length(2, 10)] string PostalCode,
    [Required, RegularExpression("^[A-Z]{2}$")] string CountryCode);
```

Отправьте POST с заказом с неверным почтовым индексом, и ключ ошибки будет `Billing.PostalCode`, а не сплющенный `PostalCode`. Генератор обнаружил `BillingAddress`, потому что `CreateOrder` ссылается на него; вам не пришлось регистрировать вложенный тип где-либо. Именно это рекурсивное обнаружение делает возможность по-настоящему полезной, а не игрушкой для тел с единственным полем.

## Когда тип не находится напрямую в сигнатуре обработчика

Генератор находит типы, глядя на параметры обработчиков minimal API и достижимые от них члены. Если тип ссылается только через базовый класс, интерфейс или полиморфизм, генератор может его не обнаружить. Для таких случаев разметьте сам тип атрибутом `[ValidatableType]` из `Microsoft.AspNetCore.Http.Validation`, чтобы явно сказать генератору создать для него логику валидации:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.Validation;
using System.ComponentModel.DataAnnotations;

[ValidatableType]
public abstract record PaymentMethod
{
    [Required, Length(2, 40)] public string Holder { get; init; } = "";
}

public sealed record CardPayment : PaymentMethod
{
    [Required, CreditCard] public string Number { get; init; } = "";
}
```

`[ValidatableType]` это ручной аварийный выход: прибегайте к нему, когда валидация молча не срабатывает на типе, на котором вы её ожидали, что почти всегда означает, что генератор не смог достичь его от параметра обработчика.

## Правила между свойствами с IValidatableObject

Атрибуты валидируют по одному члену за раз. Для правил, охватывающих несколько полей ("дата окончания должна быть позже даты начала", "если задана скидка, причина обязательна"), реализуйте `IValidatableObject`. Его метод `Validate` запускается после проверок атрибутов и выдаёт записи `ValidationResult`:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

Массив строк, который вы передаёте вторым аргументом, управляет тем, под каким ключом ошибка попадёт в словарь `errors`. Передайте `[nameof(End)]`, и клиент увидит `"End": ["End must be after Start."]`; опустите его, и ошибка пойдёт под пустым ключом как ошибка уровня модели. Используйте имя члена, чтобы ваш UI мог подсветить нужное поле.

## Пользовательский ValidationAttribute, когда встроенных не хватает

Когда ни встроенные атрибуты, ни `IValidatableObject` не подходят, напишите `ValidationAttribute`. Генератор исходного кода подхватывает пользовательские атрибуты так же, как он подхватывает `[Range]`:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

Пользовательские атрибуты держат правило рядом с данными и пригодным для повторного использования в каждом endpoint, принимающем `Booking`, и в этом весь смысл валидации на основе атрибутов по сравнению с встроенными блоками `if`, разбросанными по обработчикам.

## Параметры запроса, маршрута и заголовка тоже валидируются

Возможность не ограничивается телом JSON. Атрибуты на скалярных параметрах, связанных из маршрута, строки запроса или заголовков, валидируются той же машинерией:

```csharp
// .NET 11, C# 14
app.MapGet("/search",
    ([Range(1, 100)] int pageSize,
     [Required, MinLength(2)] string query) =>
        TypedResults.Ok(new { pageSize, query }));
```

Запрос к `/search?pageSize=500&query=x` отклоняется с `400` до запуска обработчика, при этом и `pageSize`, и `query` перечислены в `errors`. Это закрывает самый частый пробел в валидации, на который люди натыкаются после тела: параметры пагинации и фильтрации, которые раньше проходили без проверки.

## Отключение валидации для одного endpoint

Иногда endpoint принимает тип, который валидируется везде, но здесь вам нужно сырое значение, например внутренний административный маршрут, который намеренно принимает в остальном недопустимые данные. Сцепите `DisableValidation()` на этом единственном endpoint:

```csharp
// .NET 11, C# 14
app.MapPost("/internal/import", (CreateProduct product) =>
        TypedResults.Accepted($"/products/{product.Sku}", product))
    .DisableValidation();
```

Это убирает фильтр валидации с этого единственного endpoint, не трогая глобальную регистрацию `AddValidation()`, поэтому все остальные endpoint, использующие `CreateProduct`, продолжают валидировать.

## Детали, о которых стоит знать до выпуска

Несколько острых углов сбивают людей с толку в первый раз:

- **Тип запроса должен быть `public`.** Генератор исходного кода может создавать код только для типов, которые он может назвать. `record` или `class`, объявленный без `public` или вложенный в другой тип без нужной доступности, молча не получает валидацию. Если валидация "не работает", сначала проверьте модификатор доступа.
- **Позиционные параметры record: размещение атрибута имеет значение.** `[Required] string Name` на позиционном параметре record читается генератором, но если вы вдобавок полагаетесь на то, что атрибут находится на сгенерированном *свойстве* (для инструментов, рефлексирующих над ним в среде выполнения), используйте явную цель: `[property: Required] string Name`. Сам генератор валидации читает форму параметра, поэтому большей части кода `property:` не нужен, но смешивание ожиданий это частый источник путаницы.
- **Валидация выполняется как endpoint filter, поэтому порядок фильтров имеет значение.** Фильтр валидации добавляется на каждый endpoint. Если вы вдобавок добавляете собственные вызовы `AddEndpointFilter`, учитывайте, где валидация находится в цепочке. О том, как складывается порядок фильтров между route groups, см. [как организовать endpoint minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Это не замена FluentValidation во всех случаях.** `DataAnnotations` плюс `IValidatableObject` покрывают подавляющее большинство валидации запросов. Если у вас есть движок правил, асинхронные правила, обращающиеся к базе данных, или крупное существующее вложение в FluentValidation, оставьте его. Встроенная возможность для тех, кто "просто хочет, чтобы `[Required]` действительно что-то делал" без зависимости.
- **Обработчик пропускается при сбое, поэтому вашему объединению `TypedResults` не нужна ветвь `BadRequest` для валидации.** `400` производится фильтром, до того как ваш обработчик вернёт результат, поэтому обработчик с типом `Results<Created<T>, NotFound>` в порядке; сбои валидации никогда до него не доходят. 400 ProblemDetails генерируется независимо от ваших объявленных типов возврата.
- **Ошибки DI на этапе разрешения не связаны с этим.** Если endpoint выбрасывает исключение при активации сервиса, а не при валидации ввода, это совершенно другой сбой; см. [Unable to resolve service for type while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) для него.

Ментальная модель, которую стоит унести: валидация minimal API в .NET 11 это `DataAnnotations`, которые вы уже знаете, сделанные автоматическими генератором исходного кода во время компиляции и выставленные через фильтр на каждый endpoint, возвращающий стандартный `ProblemDetails`. Вы размечаете, вызываете `AddValidation()`, и недопустимые запросы останавливаются у двери. Поскольку она основана на генераторе, а не на рефлексии, она не мешает trimming и Native AOT, и именно поэтому она поставляется [безопасной для trimming со стеком minimal API на Native AOT](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Для всего, что фильтр не ловит, [глобальный фильтр исключений](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) всё ещё подстраховывает остальную часть конвейера запросов.

## Связанное

- [Minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) для выбора между двумя моделями endpoint в первую очередь.
- [Как организовать endpoint minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) о том, где фильтр валидации находится относительно фильтров группы.
- [Использование Native AOT с minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) о том, почему валидатор на основе генератора важен при trimming.
- [Добавление глобального фильтра исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) чтобы поймать всё, что валидация не ловит.
- [Fix: Unable to resolve service for type while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) для ошибок активации, которые выглядят как сбои валидации, но ими не являются.

## Источники

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (поддержка валидации для minimal API, `AddValidation`, `[ValidatableType]`, `DisableValidation`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (валидация вложенных объектов, форма ответа об ошибке).
