---
title: "Исправление: ASP.NET Core возвращает 400 \"The X field is required\" для свойства типа string, не допускающего null"
description: "При <Nullable>enable</Nullable> MVC обрабатывает каждый ссылочный тип, не допускающий null, как [Required(AllowEmptyStrings = true)]. Объявите необязательные свойства как string?, задайте им значение по умолчанию или установите SuppressImplicitRequiredAttributeForNonNullableReferenceTypes."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "validation"
  - "nullable-reference-types"
lang: "ru"
translationOf: "2026/09/fix-aspnetcore-400-the-field-is-required-non-nullable-string"
translatedBy: "claude"
translationDate: 2026-09-25
---

Ответ `400 Bad Request` с `"The Name field is required."` для свойства, которое вы никогда не помечали `[Required]`, порождается неявным правилом обязательности в MVC: если в проекте задано `<Nullable>enable</Nullable>`, каждый ссылочный тип, не допускающий null, в привязываемой модели или параметре действия проверяется так, будто у него есть `[Required(AllowEmptyStrings = true)]`. Если значение действительно необязательное, объявите его как `string?`. Если вам нужно прежнее поведение везде, установите `options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true` в `AddControllers`. Если же значение действительно обязательное, оставьте ошибку и настройте её явным `[Required]`.

Все результаты ниже воспроизведены на ASP.NET Core 10.0.10 (SDK 10.0.302) в одном проекте `dotnet new web`, в котором размещены и контроллеры, и конечные точки minimal API. Само правило существует начиная с ASP.NET Core 3.0, поэтому объяснение применимо ко всем версиям от 3.0 до .NET 11.

## Ошибка в контексте

Клиент отправляет JSON-тело, в котором свойство пропущено или передано как `null`, и ещё до выполнения действия получает стандартное тело `ValidationProblemDetails`:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The Name field is required."]
  },
  "traceId": "00-41532a7ee5071512e476fa1aa31447c3-141fcd7662d71a76-00"
}
```

То же сообщение появляется для параметров строки запроса (`"q": ["The q field is required."]`), полей формы и, очень часто, для навигационных свойств EF Core у сущностей, которые привязываются напрямую (`"Customer": ["The Customer field is required."]`). Без `[ApiController]` автоматического ответа 400 не будет, но `ModelState.IsValid` окажется `false` с той же ошибкой, и именно так с ней сталкиваются Razor Pages и отправка форм в MVC.

## Почему это происходит

`DataAnnotationsMetadataProvider` в MVC строит метаданные валидации для каждого привязываемого свойства и параметра. Для каждого ссылочного типа без явного `[Required]` он спрашивает у `NullabilityInfoContext`, что записал компилятор. Если состояние чтения равно `NotNull`, он добавляет `RequiredAttribute` в список валидаторов. Соответствующий комментарий в исходном коде ASP.NET Core говорит об этом прямо: "For non-nullable reference types, treat them as-if they had an implicit [Required]."

Четыре детали этого кода определяют почти каждый случай, с которым вы столкнётесь:

1. **Неявный атрибут использует `AllowEmptyStrings = true`.** Он отклоняет только `null`, но не `""`. JSON-тело с `"name": ""` проходит валидацию.
2. **Значения из формы и строки запроса всё равно отклоняют пустые строки,** потому что привязка модели в MVC преобразует пустой ввод и ввод только из пробелов в `null` (`ConvertEmptyStringToNull` по умолчанию равно `true`) ещё до запуска валидации. И `?q=`, и `?q=%20` завершаются ошибкой "The q field is required."
3. **Параметры со значением по умолчанию исключаются.** `string sort = "name"` никогда не становится неявно обязательным, потому что провайдер пропускает параметры, у которых `HasDefaultValue` равно true.
4. **Код без аннотаций (oblivious) исключается.** Если тип скомпилирован с отключёнными аннотациями допустимости null, состояние чтения равно `Unknown`, а не `NotNull`, поэтому ничего не добавляется. Именно поэтому ошибка обычно появляется в тот день, когда кто-то включает `<Nullable>enable</Nullable>` в старом проекте, хотя ни одна модель не изменилась.

Так делает только MVC. Контроллеры, Razor Pages и представления MVC проходят через `DataAnnotationsMetadataProvider`. Minimal API через него не проходят, включая новую валидацию на основе генератора исходного кода из `AddValidation()` в .NET 10, о которой речь пойдёт в разделе о подводных камнях ниже.

## Минимальное воспроизведение

```csharp
// ASP.NET Core 10.0.10, <Nullable>enable</Nullable>, Program.cs
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();

public record CreateProduct(string Name, string? Nickname, string Sku = "");

public class Order
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!; // EF Core navigation
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController, Route("api")]
public class ProductsController : ControllerBase
{
    [HttpPost("create")] public IActionResult Create(CreateProduct p) => Ok(p);
    [HttpPost("order")]  public IActionResult Order(Order o) => Ok(o);
    [HttpGet("search")]  public IActionResult Search(string q) => Ok(q);
}
```

Что вернул каждый запрос:

| Запрос | Статус | Ключ ошибки |
| --- | --- | --- |
| `POST /api/create` с `{}` | 400 | `Name` |
| `POST /api/create` с `{"name":null}` | 400 | `Name` |
| `POST /api/create` с `{"name":""}` | 200 | нет |
| `POST /api/create` с `{"name":"x"}` | 200 | нет |
| `POST /api/order` с `{"title":"t","customerId":1}` | 400 | `Customer` |
| `GET /api/search` | 400 | `q` |
| `GET /api/search?q=` | 400 | `q` |

`Nickname` (объявлен как `string?`) и `Sku` (параметр со значением по умолчанию) ни разу не вызвали ошибку. `Title` тоже, потому что инициализатор `= ""` означает, что при отсутствии свойства десериализация JSON оставляет его равным `""`, а `""` удовлетворяет `AllowEmptyStrings = true`.

Строка с `Order` сбивает с толку чаще всего. `Customer` не допускает null, потому что так требует EF Core для обязательной связи, `= null!` подавляет [CS8618](/ru/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), а затем MVC читает ту же аннотацию и требует, чтобы клиент прислал в теле целый объект `Customer`.

## Исправление 1: объявите необязательные значения как допускающие null (рекомендуется)

Если значение может законно отсутствовать, об этом должен говорить тип. Это исправляет валидацию и даёт вам проверки на null от компилятора внутри действия:

```csharp
// ASP.NET Core 10.0.10
public record CreateProduct(string Name, string? Nickname, string? Description);

[HttpGet("search")]
public IActionResult Search(string? q) => Ok(q ?? "(all)");
```

Для параметров запроса и маршрута, у которых есть разумное запасное значение, подходит и значение по умолчанию, и читается оно лучше, чем проверка на null:

```csharp
// ASP.NET Core 10.0.10
[HttpGet("list")]
public IActionResult List(string sort = "name", int page = 1) => Ok(new { sort, page });
```

Для сущностей EF Core правильное исправление состоит в том, чтобы перестать привязывать сущность. Принимайте DTO запроса, который несёт `CustomerId` и ничего больше, а затем отображайте его на сущность:

```csharp
// ASP.NET Core 10.0.10, EF Core 10
public record CreateOrder(string Title, int CustomerId);

[HttpPost("order")]
public async Task<IActionResult> Order(CreateOrder dto, AppDbContext db)
{
    var order = new Order { Title = dto.Title, CustomerId = dto.CustomerId };
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    return CreatedAtAction(nameof(Order), new { id = order.Id }, new { order.Id });
}
```

Если прямо сейчас изменить привязку сущности нельзя, `[ValidateNever]` на навигационном свойстве (из `Microsoft.AspNetCore.Mvc.ModelBinding.Validation`) указывает MVC пропустить его валидацию:

```csharp
// ASP.NET Core 10.0.10
[ValidateNever]
public Customer Customer { get; set; } = null!;
```

С ним `{"title":"t"}` успешно привязался, а `Customer` остался `null`. Это заплатка, а не архитектурное решение. Клиент по-прежнему может прислать вложенный объект `customer`, который EF Core охотно попытается вставить.

## Исправление 2: отключите неявное правило глобально

Когда вы включаете ссылочные типы, допускающие null, в большом существующем API и не можете проверить все модели сразу, подавите вывод в `AddControllers` (или `AddMvc`, `AddRazorPages().AddMvcOptions(...)`):

```csharp
// ASP.NET Core 10.0.10, Program.cs
builder.Services.AddControllers(options =>
{
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
});
```

С этой опцией каждая строка таблицы выше вернула 200, кроме пустого запроса, который вернул `204 No Content`, потому что действие получило `null`, а `Ok(null)` превращается в 204. Обратите внимание, что это значит: действие выполнилось с `q == null`, хотя сигнатура говорит `string q`. Вы обменяли 400 на значение, про которое компилятор клянётся, что оно не может быть null. Считайте это переключателем на время миграции и планируйте убрать его, как только модели будут аннотированы честно.

## Исправление 3: оставьте правило, но задайте своё сообщение

Если свойство действительно обязательное, неявная валидация делает свою работу, и претензия только к формулировке. Явный атрибут заменяет неявный (провайдер добавляет свой, только когда `[Required]` отсутствует):

```csharp
// ASP.NET Core 10.0.10
using System.ComponentModel.DataAnnotations;

public class CreateCustomer
{
    [Required(AllowEmptyStrings = false, ErrorMessage = "Customer name is required.")]
    public string Name { get; set; } = default!;
}
```

Это же способ заставить пустую JSON-строку не проходить проверку, чего неявное правило никогда не делает. Обычный `[Required]` (где `AllowEmptyStrings` по умолчанию равно `false`) в моём воспроизведении отклонил `{"name":""}` с ответом 400. И наоборот, `[Required(AllowEmptyStrings = true)]` в моём воспроизведении принял `""`, как и неявное поведение.

Если нужно изменить форму ответа, а не сообщение, это вопрос problem details, а не валидации. Подход из статьи о [настройке ответов с ошибками валидации через IProblemDetailsService](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) работает и для контроллеров.

## Подводные камни и похожие ошибки

**Minimal API ведут себя иначе.** Тот же record `CreateProduct`, привязанный в конечной точке minimal API, принял `{}` и `{"name":null}` с ответом 200 и `Name == null`, даже с зарегистрированным `builder.Services.AddValidation()` и `[StringLength(20)]` на другом свойстве (который при нарушении давал 400, то есть валидатор работал). Генератор исходного кода для валидации в .NET 10 учитывает атрибуты, но не выводит `[Required]` из допустимости null. Если вы [валидируете тела запросов в minimal API](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), добавляйте `[Required]` явно. *Параметры* minimal API устроены иначе: отсутствующий параметр строки запроса `string q`, не допускающий null, возвращает 400 из самого привязчика параметров, а в режиме Development страница исключений показывает `BadHttpRequestException: Required parameter "string q" was not provided from query string.`

**Ключевое слово C# `required` даёт другую ошибку.** `public required string Name { get; set; }` проверяется System.Text.Json во время десериализации, до валидации MVC. Тело ответа в моём воспроизведении было таким:

```json
{
  "$": ["JSON deserialization for type 'ReqKw' was missing required properties including: 'name'."],
  "o": ["The o field is required."]
}
```

Вторая запись, с ключом по имени параметра действия, это снова неявное правило: десериализация не удалась, параметр остался `null`, и затем был помечен параметр `ReqKw o`, не допускающий null. Объявление параметра как `[FromBody] ReqKw? o` убирает эту лишнюю запись. Ключевое слово `required` и `[JsonRequired]` взаимодействуют по-своему, это разобрано в статьях о том, [как заставить System.Text.Json игнорировать свойство с модификатором required](/ru/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/), и о [CS9035](/ru/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**"The p field is required" при пустом теле.** Запрос вообще без тела к `Create(CreateProduct p)` вернул две ошибки: `"": ["A non-empty request body is required."]` и `"p": ["The p field is required."]`. Если объявить параметр как `CreateProduct? p`, пустое тело превращается в успешную привязку с `p == null` (действие вернуло 204 из `Ok(null)`), поэтому делайте так, только если пустое тело допустимо для этой конечной точки. `MvcOptions.AllowEmptyInputInBodyModelBinding` служит глобальным переключателем для первого сообщения.

**Контекст допустимости null в другой сборке.** Правило читает аннотации сборки, в которой объявлена модель, а не веб-проекта. Модели в общей библиотеке, скомпилированной с `<Nullable>disable</Nullable>`, никогда не получают неявный атрибут, даже если в проекте API допустимость null включена. Верно и обратное: включение допустимости null в общей библиотеке меняет поведение API, не затрагивая проект API.

**Унаследованные свойства.** Аннотация читается с того члена, который объявляет свойство. Если DTO наследуется от базового класса из другого проекта, решает контекст допустимости null базового класса, а не производного типа. Если свойство, которое вы считаете `string?`, всё равно сообщает "required", найдите, где оно на самом деле объявлено.

**Для типов значений нужно другое исправление.** Отсутствующий `int` вообще не вызывает это правило (типы значений пропускаются). Он молча получает значение по умолчанию `0`. Если нужно "обязательно к передаче", используйте `int?` с `[Required]`.

## Связанные материалы

- [Как валидировать тела запросов в minimal API без контроллеров в ASP.NET Core 11](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), где атрибуты остаются единственным источником обязательности.
- [Валидация minimal API против FluentValidation в ASP.NET Core 11](/ru/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/), если вы решаете, где должны жить подобные правила.
- [Исправление CS8618: свойство, не допускающее null, должно содержать значение, отличное от null](/ru/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), сторона компилятора для тех же аннотаций.
- [Как обработать ответ RFC 9457 ProblemDetails в типизированном HttpClient](/ru/2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient/), для клиентов, читающих словарь `errors` из примера выше.

## Источники

- [Non-nullable reference types and [Required] attribute](https://learn.microsoft.com/aspnet/core/mvc/models/validation#non-nullable-reference-types-and-required-attribute) в статье "Model validation in ASP.NET Core MVC and Razor Pages" на Microsoft Learn.
- Справочник по API [`MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes).
- [`DataAnnotationsMetadataProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Mvc/Mvc.DataAnnotations/src/DataAnnotationsMetadataProvider.cs) в ветке `release/10.0`, где видны вывод `AllowEmptyStrings = true` и исключение по `HasDefaultValue`.
- [dotnet/aspnetcore#16654](https://github.com/dotnet/aspnetcore/issues/16654), один из ранних отчётов о том, как правило удивило пользователей на унаследованных свойствах.
