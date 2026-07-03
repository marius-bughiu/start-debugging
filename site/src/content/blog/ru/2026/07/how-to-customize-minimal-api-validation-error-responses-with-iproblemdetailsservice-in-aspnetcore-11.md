---
title: "Как настроить ответы об ошибках валидации в minimal API с помощью IProblemDetailsService в ASP.NET Core 11"
description: "Вызовите AddProblemDetails с колбэком CustomizeProblemDetails, чтобы изменить форму ответа 400, который встроенная валидация minimal API возвращает в ASP.NET Core 11: добавьте traceId, перепишите title, замените 400 на 422 или получите полный контроль с помощью собственного IProblemDetailsWriter."
pubDate: 2026-07-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "validation"
lang: "ru"
translationOf: "2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Встроенная валидация minimal API бесплатно даёт вам `400 Bad Request` с телом `HttpValidationProblemDetails`, но возвращаемая форма - это значение по умолчанию фреймворка: полезная нагрузка RFC 9457 с `type`, `title`, `status` и словарём `errors`. Если вам нужен `traceId` для обращений в поддержку, другой `title`, ссылка на вашу документацию по ошибкам или `422 Unprocessable Entity` вместо `400`, то нужная точка расширения - это `AddProblemDetails(options => options.CustomizeProblemDetails = ...)`. Зарегистрируйте её, и тот же колбэк сработает как для ошибок валидации, так и для необработанных исключений и страниц кодов состояния, поэтому каждая ошибка, которую выдаёт ваш API, несёт одни и те же поля. Именно этого не хватало в ранних предварительных версиях .NET 10, и это подключено в .NET 10 GA и .NET 11: встроенный фильтр валидации теперь направляет свои problem details через `IProblemDetailsService`, поэтому ваша настройка действительно доходит до ошибок валидации. Всё, что описано ниже, ориентировано на .NET 11 с `Microsoft.NET.Sdk.Web` и C# 14; поведение идентично на .NET 10 GA.

## Как выглядит ответ валидации по умолчанию

Начните с настройки, описанной в [как валидировать тела запросов в minimal API без контроллеров](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/): вызовите `AddValidation()`, добавьте аннотации к record запроса и дайте генератору исходного кода сделать работу.

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Отправьте POST с некорректным телом, и вы получите стандартную полезную нагрузку:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  }
}
```

Это корректно и машиночитаемо, но ничего не говорит о вашем сервисе. Здесь нет идентификатора корреляции, который можно вставить в баг-репорт, `type` указывает на RFC, а не на ваш собственный каталог ошибок, а клиенты, которые трактуют `422` как "семантически некорректно, не повторять", получают `400`, который они не могут отличить от некорректно сформированного запроса. Настройка исправляет всё это в одном месте.

## Включение точки расширения для настройки

`AddProblemDetails()` регистрирует стандартный `IProblemDetailsService`, а его перегрузка принимает конфигурацию `ProblemDetailsOptions`, где вы задаёте `CustomizeProblemDetails`. Это свойство представляет собой делегат, получающий `ProblemDetailsContext`, который предоставляет доступ как к `HttpContext`, так и к изменяемому объекту `ProblemDetails`, который вот-вот будет записан.

1. **Зарегистрируйте problem details с колбэком.** Вызовите `builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = ctx => { ... })` перед `builder.Build()`.
2. **Сохраните и `AddValidation()`.** Эти два сервиса независимы: `AddValidation()` создаёт `400`, а `AddProblemDetails()` настраивает тело, которое он несёт.
3. **Изменяйте `ctx.ProblemDetails` внутри колбэка.** Добавляйте элементы в `Extensions`, переписывайте `Title`, `Type` или `Detail` или меняйте `Status`.

Вот код подключения, который добавляет идентификатор корреляции и указатель на поддержку к каждой ошибке валидации:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.Diagnostics;
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Correlate with distributed tracing; fall back to the request id.
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;

        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest)
        {
            ctx.ProblemDetails.Title = "Your request failed validation.";
            ctx.ProblemDetails.Type = "https://api.example.com/errors/validation";
            ctx.ProblemDetails.Extensions["support"] = "support@example.com";
        }
    };
});
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

Тот же некорректный POST теперь возвращает:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation",
  "title": "Your request failed validation.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  },
  "traceId": "00-2f0e...-b7ad...-01",
  "support": "support@example.com"
}
```

Словарь `errors` остался нетронутым, поэтому существующие клиенты продолжают его разбирать. Вы добавили поля, но не сломали контракт. Обратите внимание на `traceId`: берите его из `Activity.Current?.Id`, а не из нового `Guid.NewGuid()`, потому что это значение - реальный W3C trace id, проходящий через ваши журналы и спаны OpenTelemetry. Случайный GUID выглядит как trace id, но не коррелирует ни с чем. Возврат к `HttpContext.TraceIdentifier` покрывает запросы, приходящие без контекста трассировки.

## Почему колбэк доходит до каждой ошибки, а не только валидации

Причина предпочесть `CustomizeProblemDetails` ручному редактированию каждой конечной точки - это охват. Когда зарегистрирован `AddProblemDetails()`, колбэк выполняется для problem details, создаваемых механизмом обработки ошибок фреймворка: `ExceptionHandlerMiddleware`, `StatusCodePagesMiddleware`, страницей исключений для разработчика и, начиная с .NET 10 GA, встроенным фильтром валидации minimal API. Один колбэк - и ваш `traceId` попадает в `400` от валидации, `404` от несопоставленного маршрута и `500` от необработанного исключения. Именно эта согласованность и есть весь смысл контракта problem details: клиент должен иметь возможность прочитать `traceId` из любой ошибки, которую возвращает ваш API, без особой обработки того, какой слой её породил.

Чтобы получить случаи `404` и `500`, а также валидацию, зарегистрируйте два middleware, которые заполняют пустые ответы об ошибках:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler();   // turns unhandled exceptions into ProblemDetails
app.UseStatusCodePages();    // fills empty 4xx/5xx responses with ProblemDetails
app.Run();
```

Без них голый `Results.NotFound()` или несопоставленный маршрут вернёт пустое тело, потому что problem details генерируются только "для ответов, которые ещё не имеют содержимого тела". Валидация - это исключение, которому не нужно такое подключение: сам фильтр валидации вызывает `IProblemDetailsService`, поэтому его `400` настраивается независимо от того, добавили ли вы `UseStatusCodePages()`. Если вы также хотите, чтобы ваш глобальный обработчик-подстраховка ловил то, что не ловит валидация, механика пути обработки исключений описана в [как добавить глобальный фильтр исключений в ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Возврат 422 вместо 400 для валидации

Распространённый выбор при проектировании API - различать "я не смог разобрать ваш запрос" (`400`) и "я его разобрал, но он нарушает правила" (`422 Unprocessable Entity`). Поскольку колбэк может изменять `Status`, а middleware записывает статус из `ProblemDetails`, вы можете повысить ошибки валидации до `422` в одном месте:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Built-in validation always produces a 400 with an errors dictionary.
        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest
            && ctx.ProblemDetails.Extensions.ContainsKey("errors"))
        {
            ctx.ProblemDetails.Status = StatusCodes.Status422UnprocessableEntity;
            ctx.HttpContext.Response.StatusCode =
                StatusCodes.Status422UnprocessableEntity;
        }
    };
});
```

Устанавливайте и поле `ProblemDetails.Status` (то, что появляется в JSON-теле), и `HttpContext.Response.StatusCode` (реальную строку HTTP-статуса). Пропустите второе - и вы отправите тело, заявляющее `422` на HTTP-ответе `400`, что хуже, чем каждое из них по отдельности. Проверка ключа `errors` сужает переопределение именно до ошибок валидации, поэтому обычный `400` из другого места вашего приложения сохранит свой статус.

## Полный контроль с помощью собственного IProblemDetailsWriter

`CustomizeProblemDetails` изменяет объект; он не управляет сериализацией и не решает, когда записывать. Для этого реализуйте `IProblemDetailsWriter`. Writer получает шлюз `CanWrite` и `WriteAsync`, который владеет телом ответа, что позволяет вам ветвиться по коду состояния, согласованию контента или метаданным конечной точки:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http;

public sealed class ValidationProblemDetailsWriter : IProblemDetailsWriter
{
    public bool CanWrite(ProblemDetailsContext context)
        => context.ProblemDetails.Status is 400 or 422;

    public ValueTask WriteAsync(ProblemDetailsContext context)
    {
        context.ProblemDetails.Extensions["apiVersion"] = "2026-07";
        return new ValueTask(
            context.HttpContext.Response.WriteAsJsonAsync(
                context.ProblemDetails,
                context.ProblemDetails.GetType(),
                options: null,
                contentType: "application/problem+json"));
    }
}
```

Зарегистрируйте его в DI, причём зарегистрируйте до `AddControllers()` или `AddRazorPages()`, если вы используете любой из них, потому что они регистрируют собственные writer'ы, и порядок решает, какой из них победит:

```csharp
// .NET 11, C# 14
builder.Services.AddTransient<IProblemDetailsWriter, ValidationProblemDetailsWriter>();
```

Прибегайте к writer'у только тогда, когда колбэка недостаточно: другая сериализация для разных клиентов, XML наряду с JSON или выдача совершенно другой схемы для одного кода состояния. Для добавления полей и подправки текста `CustomizeProblemDetails` - это меньше кода и меньше того, в чём можно ошибиться.

## Настройка одной конечной точки вместо всего приложения

Всё вышеописанное было глобальным. Когда вы хотите, чтобы ответ валидации одной конечной точки был оформлен по-другому, верните problem details самостоятельно из обработчика с помощью `TypedResults.ValidationProblem`, который принимает словарь `extensions` напрямую:

```csharp
// .NET 11, C# 14
app.MapPost("/legacy/products", (CreateProduct product) =>
{
    var errors = new Dictionary<string, string[]>();
    if (product.Quantity <= 0)
        errors["Quantity"] = ["Quantity must be positive on the legacy endpoint."];

    if (errors.Count > 0)
        return TypedResults.ValidationProblem(
            errors,
            extensions: new Dictionary<string, object?>
            {
                ["legacy"] = true
            });

    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

Здесь есть острый угол, который стоит назвать прямо: `ProblemDetails`, который вы конструируете и возвращаете напрямую из обработчика, будь то через `TypedResults.ValidationProblem`, `Results.Problem` или `TypedResults.Problem`, сериализуется прямо в ответ и **не** проходит через `IProblemDetailsService`. Ваш глобальный колбэк `CustomizeProblemDetails` для него не выполнится, поэтому `traceId`, который вы добавили централизованно, будет отсутствовать. Если вы смешиваете глобальную настройку с проблемами, возвращаемыми из обработчика, либо добавляйте общие поля и в обработчике, либо оставляйте валидацию на встроенном фильтре, который действительно направляет её через сервис. Это самый частый сюрприз: колбэк покрывает problem details, генерируемые фреймворком, а не те, которые вы создаёте сами.

## Подводные камни, которые кусают в продакшене

- **Заголовок `Accept` определяет, получите ли вы вообще JSON.** `DefaultProblemDetailsWriter` записывает для `application/json`, `application/problem+json` и подстановочных знаков вроде `*/*` и `application/*`. Клиент, отправляющий `Accept: text/html` или `application/xml`, запускает запасной путь и не получает тела problem details. Если ваши потребители - это браузеры или SOAP-клиенты, учитывайте это, а не предполагайте, что JSON всегда отправляется.
- **`CustomizeProblemDetails` не вызывался для валидации в ранних предварительных версиях .NET 10.** Это отслеживалось как [dotnet/aspnetcore#62723](https://github.com/dotnet/aspnetcore/issues/62723): фильтр валидации обходил `IProblemDetailsService`. В .NET 10 GA и .NET 11 он подключён через сервис. Если ваш колбэк срабатывает для исключений, но молча пропускает ошибки валидации, значит, вы на устаревшем preview SDK; обновите его.
- **Порядок имеет значение, когда вы также используете контроллеры.** MVC создаёт problem details валидации через `ProblemDetailsFactory` и `InvalidModelStateResponseFactory`, а не только через `CustomizeProblemDetails`. Смешанному приложению с конечными точками minimal API и контроллерами нужны оба пути настроенными, иначе ваши контроллеры и ваши minimal API разойдутся в форме ошибок.
- **Не допускайте утечки внутренностей в `Detail`.** Соблазнительно засунуть сообщение исключения в `ProblemDetails.Detail` внутри колбэка. В продакшене это раскрывает фрагменты трассировки стека и внутренние имена типов. Держите `Detail` безопасным для клиента и вместо этого помещайте диагностическую информацию за вашим `traceId` в журналах.
- **Колбэк выполняется на горячем пути каждой ошибки.** Держите его дешёвым. Чтение `Activity.Current` и установка ключей словаря - это нормально; открытие соединения с базой данных или вызов удалённого сервиса внутри `CustomizeProblemDetails` - нет, потому что он выполняется синхронно во время записи ответа.

Модель, которую стоит запомнить: `AddValidation()` решает, что некорректно, `AddProblemDetails()` решает, как описывается некорректность, а `CustomizeProblemDetails` - это единственное место, где можно оформить это описание сразу для каждой ошибки, генерируемой фреймворком. Добавьте свой `traceId` там, перепишите `title` там, повысьте до `422` там и прибегайте к собственному `IProblemDetailsWriter` только тогда, когда вам нужно владеть сериализацией. Для всего, что фильтр валидации не ловит, [глобальный фильтр исключений](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) проносит ту же настройку насквозь, а если вы всё ещё решаете, покрывает ли встроенный валидатор ваши правила вообще, [валидация minimal API против FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) проводит эту границу.

## Связанное

- [Как валидировать тела запросов в minimal API без контроллеров в ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) - настройка `AddValidation()`, которую настраивает этот пост.
- [Валидация minimal API против FluentValidation в ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) - подходит ли встроенный валидатор вашим правилам, прежде чем настраивать его вывод.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) - как ловить то, что не ловит валидация, с той же формой `ProblemDetails`.
- [Как организовать конечные точки minimal API с помощью MapGroup в ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) - применение валидации и её problem details ко всей группе маршрутов.
- [Minimal API против контроллеров в ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) - чем различается обработка ошибок между двумя моделями конечных точек.

## Источники

- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0) (`AddProblemDetails`, middleware, генерирующие problem details, `CustomizeProblemDetails`, запасной путь `IProblemDetailsService` и поддерживаемые типы медиа).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) (настройка ответов об ошибках валидации minimal API с помощью `IProblemDetailsService`, `TypedResults.ValidationProblem`).
- Microsoft Learn, [ProblemDetailsOptions.CustomizeProblemDetails](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.problemdetailsoptions.customizeproblemdetails) (сигнатура колбэка и `ProblemDetailsContext`).
- dotnet/aspnetcore, [CustomizeProblemDetails not invoked for minimal API validation (issue #62723)](https://github.com/dotnet/aspnetcore/issues/62723) (пробел эпохи preview, устранённый для .NET 10 GA).
