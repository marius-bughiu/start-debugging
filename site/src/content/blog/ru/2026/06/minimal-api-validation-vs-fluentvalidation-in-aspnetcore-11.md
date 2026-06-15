---
title: "Валидация minimal API против FluentValidation в ASP.NET Core 11: что выбрать?"
description: "Используйте встроенную валидацию на генераторе исходного кода для синхронных правил, выразимых атрибутами, в ASP.NET Core 11; обращайтесь к FluentValidation, когда нужны асинхронные правила, сложная логика между полями или валидация вне ваших моделей предметной области."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "ru"
translationOf: "2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

Если вы начинаете новый minimal API в ASP.NET Core 11, используйте встроенную валидацию: вызовите `AddValidation()`, аннотируйте свой record запроса атрибутами `DataAnnotations`, и генератор исходного кода вернёт `400 ProblemDetails` до того, как выполнится ваш handler, без зависимостей и с поддержкой Native AOT. Обращайтесь к FluentValidation (сейчас 12.1.1, Apache 2.0) только тогда, когда нужно то, что встроенная возможность действительно не умеет: асинхронные правила, обращающиеся к базе данных, богатая логика между полями или валидация, полностью вынесенная за пределы ваших моделей предметной области. Решающая ось -- асинхронные и сложные условные правила. Если они вам нужны, побеждает FluentValidation; если нет, встроенная возможность -- вариант с меньшим трением. Всё далее ориентировано на .NET 11 с `Microsoft.NET.Sdk.Web` и C# 14; встроенная возможность впервые появилась в .NET 10 и в 11 не изменилась.

## Матрица возможностей

Это таблица, ради которой вы пришли. Каждая строка отражает .NET 11 и FluentValidation 12.1.1.

| Возможность                      | Встроенная (`DataAnnotations`)          | FluentValidation 12                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------- |
| Зависимость                      | нет (в коробке, .NET 10+)               | пакет NuGet, Apache 2.0                   |
| Механизм                         | генератор исходного кода при компиляции  | рефлексия в среде выполнения + деревья выражений |
| Native AOT / trimming            | совместимо (без рефлексии в runtime)     | требует внимания, частичная поддержка     |
| Асинхронные правила (запросы к БД / HTTP) | нет                            | да (`MustAsync`, `ValidateAsync`)         |
| Правила между полями             | `IValidatableObject` (многословно)      | первоклассно (`RuleFor(...).When(...)`)   |
| Где живут правила                | в модели, как атрибуты                  | в отдельном классе-валидаторе             |
| Условность / наборы правил        | ограниченно                            | `When`/`Unless`/`WhenAsync`, наборы правил |
| Автоматический `400` в minimal API | да, встроенный endpoint-фильтр        | вручную: вы пишете endpoint-фильтр        |
| Форма ответа об ошибке           | `ProblemDetails` (RFC 9457) бесплатно   | вы сами отображаете сбои в ответ          |
| Переиспользуемые составные правила | свой `ValidationAttribute`            | `SetValidator`, цепочки правил, наследование |

Короткий вывод: встроенная возможность оптимизирована под «включил и забыл» на простых моделях, а FluentValidation -- под выразительную силу на сложных. Ни одна не лучше безусловно. Строки, которые решают большинство случаев, -- это асинхронные правила и то, где живут правила.

## Когда выбирать встроенную валидацию

Встроенная валидация, разобранная пошагово в [как валидировать тела запросов в minimal API без контроллеров](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), -- правильный выбор по умолчанию в этих случаях:

- **Новые minimal API на .NET 11 с синхронными правилами.** Если ваша валидация -- это «это поле обязательно, то -- положительное целое, e-mail похож на e-mail», `DataAnnotations` выражает всё это, а генератор исходного кода превращает это в endpoint-фильтр бесплатно. Без пакета, без классов-валидаторов, без обвязки.
- **Развёртывания с Native AOT или агрессивным trimming.** Встроенная возможность спроектирована вокруг генератора исходного кода именно для того, чтобы не нести рефлексию по графу модели в runtime. Это и делает её безопасной при trimming и Native AOT -- та же причина, по которой она чисто интегрируется со [стеком minimal API на Native AOT](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). FluentValidation опирается на рефлексию и скомпилированные деревья выражений, которые требуют дополнительного внимания при trimming.
- **Вы хотите получить контракт `400 ProblemDetails` готовым.** Встроенная валидация возвращает тело `HttpValidationProblemDetails`, проиндексированное по имени свойства, ту же форму RFC 9457, что и MVC, без кода с вашей стороны. С FluentValidation вы сами решаете, как преобразовать `ValidationResult` в HTTP-ответ -- гибкость, которая может быть не нужна в небольшом сервисе.
- **Вы предпочитаете, чтобы правила жили в модели.** Атрибуты держат `[Required]` рядом со свойством, которое оно защищает. Для команды, которой нравится держать данные и их ограничения в одном месте, это совмещение -- преимущество, а не недостаток.

## Когда выбирать FluentValidation

FluentValidation 12 оправдывает свою зависимость, когда встроенная возможность упирается в стену:

- **Асинхронные правила.** Это главная причина к нему обратиться. `DataAnnotations` и `IValidatableObject` синхронны, поэтому «занято ли это имя пользователя?» или «существует ли этот ID товара в каталоге?» нельзя выразить во встроенной возможности, не протащив доступ к данным в handler. FluentValidation поддерживает `MustAsync` и `WhenAsync`, и вы вызываете его через `ValidateAsync`. Библиотека прямо указывает: валидатор, содержащий асинхронные правила, нужно вызывать через `ValidateAsync`, никогда через `Validate`, иначе он выбрасывает исключение.
- **Богатая логика между полями и условная логика.** «Дата окончания позже даты начала» выполнима через `IValidatableObject`, но как только у вас появляется «если `PaymentType` равен `Invoice`, то `PurchaseOrderNumber` обязателен, если только клиент не `Internal`», подход «атрибуты плюс `IValidatableObject`» превращается в путаницу блоков `if`. У FluentValidation `RuleFor(x => x.PurchaseOrderNumber).NotEmpty().When(x => x.PaymentType == PaymentType.Invoice)` читается как само требование.
- **Валидация должна быть вне модели предметной области.** В кодовой базе с чистой архитектурой или DDD украшение доменного record атрибутами `[Range]` и `[EmailAddress]` связывает модель с заботой уровня представления. FluentValidation держит каждое правило в отдельном классе `AbstractValidator<T>`, так что модель остаётся POCO без атрибутов.
- **Переиспользование и композиция по многим типам запросов.** `SetValidator`, наследование валидаторов и наборы правил позволяют скомпоновать `MoneyValidator` в каждый запрос, несущий цену, с плавностью, которую свои типы `ValidationAttribute` не достигают, когда правило обретает структуру.

## Как каждый вариант выглядит в коде

Встроенный вариант -- это те аннотации, которые вы уже знаете, плюс одна регистрация сервиса:

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

Недопустимое тело никогда не доходит до handler. Оно автоматически возвращается как `400` с payload `ProblemDetails`, проиндексированным по `Sku`, `Name` и `Quantity`.

Эквивалент на FluentValidation переносит правила в класс-валидатор и, поскольку встроенный конвейер автоматической валидации устарел (об этом ниже), подключает их через endpoint-фильтр, который вы вызываете явно:

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
using FluentValidation;
using FluentValidation.Results;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
   .AddEndpointFilter(async (ctx, next) =>
   {
       var product = ctx.GetArgument<CreateProduct>(0);
       var validator = ctx.HttpContext.RequestServices
           .GetRequiredService<IValidator<CreateProduct>>();

       ValidationResult result = await validator.ValidateAsync(product);
       if (!result.IsValid)
           return Results.ValidationProblem(result.ToDictionary());

       return await next(ctx);
   });

public record CreateProduct(string Sku, string Name, int Quantity);

public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator()
    {
        RuleFor(x => x.Sku).NotEmpty().Length(3, 20);
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2);
        RuleFor(x => x.Quantity).InclusiveBetween(1, 10_000);
    }
}
```

Это больше кода, но именно здесь живёт сила. Добавьте асинхронную проверку уникальности -- и встроенная возможность просто не может за этим угнаться:

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator(IProductRepository repo)
    {
        RuleFor(x => x.Sku)
            .NotEmpty()
            .Length(3, 20)
            .MustAsync(async (sku, ct) => !await repo.SkuExistsAsync(sku, ct))
            .WithMessage("A product with this SKU already exists.");
    }
}
```

`MustAsync` обращается к базе данных во время валидации. Нет ни одного атрибута `DataAnnotations`, который делал бы это без того, чтобы вы открыли `DbContext` внутри правила, а `IValidatableObject.Validate` синхронен, поэтому ничего await-ить не может. Это та стена, которая отправляет команды к FluentValidation.

Шаблонный код endpoint-фильтра можно вынести в небольшое обобщённое расширение, чтобы каждый endpoint лишь добавлял `.WithValidation<CreateProduct>()`. Механика композиции фильтров по группе маршрутов та же, что описана в [организации endpoint-ов minimal API с помощью MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), так что единый `MapGroup(...).AddEndpointFilter(...)` может валидировать целую группу.

## Бенчмарк: запуск, а не установившийся режим

Честная история о производительности здесь -- не про пропускную способность запросов. Для горстки свойств оба подхода валидируют за микросекунды, и стоимость теряется на фоне десериализации JSON и того, что делает ваш handler. Измеримая разница -- на краях: холодный старт и AOT.

Поскольку встроенная возможность генерируется во время компиляции, она не добавляет рефлексии при запуске. FluentValidation строит цепочки правил на деревьях выражений, которые компилируются при первом использовании, поэтому первая валидация каждого типа несёт разовую стоимость JIT и компиляции выражения. На прогретом сервере эта стоимость амортизируется до нуля. На [холодно стартующей serverless-функции](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/), которая обслуживает один запрос и замирает, вы платите её на значимой доле вызовов.

Более резкое различие -- публикация. Minimal API на Native AOT со встроенным валидатором публикуется и работает без предупреждений trimming, потому что нет рефлексии, которую нужно сохранить. То же приложение с FluentValidation вызовет предупреждения trimming, если вы не закрепите валидируемые типы и их члены, поскольку библиотека рефлексирует по вашей модели и по выражениям доступа к членам. Это не «FluentValidation медленный», это «FluentValidation стоит вам работы по обеспечению trim-безопасности, которой встроенная возможность не требует». Если ваша цель развёртывания -- AOT, считайте это решающим фактором, а не подсчётом наносекунд. Цифры старше текущего цикла .NET 11 стоит перемерить, прежде чем им доверять; внутренности валидации менялись между .NET 8 и .NET 10.

## Подводный камень, который решает за вас: устаревший пакет AspNetCore

Если вы пойдёте искать интеграцию FluentValidation с ASP.NET Core, вы найдёте пакет `FluentValidation.AspNetCore` и его старый конвейер автоматической валидации. Не начинайте с него. Сопровождающие пометили его как устаревший, и документация прямо говорит: "We no longer recommend using this approach for new projects but it is still available for legacy implementations." Он не выполняет асинхронные валидаторы (он выбрасывает исключение), никогда не поддерживал minimal API или Blazor, а его неявное поведение трудно отлаживать. Рекомендуемый в 2026 году путь -- ручной, показанный выше: зарегистрируйте `IValidator<T>` в DI и сами вызывайте `ValidateAsync`, из endpoint-фильтра для minimal API или из handler. Если учебник велит вам вызвать `AddFluentValidationAutoValidation()`, он предшествует этой рекомендации.

Второй подводный камень режет в другую сторону, в пользу FluentValidation: страх насчёт лицензии тут неуместен. FluentValidation остаётся Apache 2.0 и бесплатным, в том числе для коммерческого использования. Библиотека, перешедшая на ограничительную платную лицензию в январе 2025 года, -- это Fluent Assertions, другой проект с обманчиво похожим именем. Они не связаны, и выбор FluentValidation не подвергает вас плате за место. Если ревьюер политик отметит "Fluent*" в вашем списке зависимостей, это и есть различие, которое нужно провести.

Последний -- ловушка корректности, уникальная для FluentValidation: если хоть одно правило валидатора асинхронно, каждое место вызова должно использовать `ValidateAsync`. Случайный синхронный `Validate()` на валидаторе, содержащем правило `MustAsync`, выбрасывает исключение в runtime, а не при компиляции, поэтому может пройти тесты, которые никогда не задействуют этот путь, и упасть в продакшене. Стандартизируйте `ValidateAsync` повсюду, чтобы полностью избежать этой ловушки.

## Рекомендация, повторно

По умолчанию выбирайте встроенную валидацию в ASP.NET Core 11. Она бесплатна, совместима с AOT, отдаёт вам стандартный контракт `ProblemDetails`, и для синхронных правил атрибутной формы, составляющих большую часть валидации запросов, она строго меньше работы, чем добавление зависимости. Выбирайте FluentValidation осознанно, когда упёрлись в конкретный предел: асинхронные правила, которым нужен ввод-вывод, условная логика между полями, которую `IValidatableObject` делает уродливой, или архитектурное правило, что валидация не должна трогать ваши модели предметной области. Многие реальные системы заканчивают с обоими, и это нормально: пусть встроенная возможность охраняет простые DTO, а FluentValidation владеет горсткой типов запросов с действительно сложными правилами. Ошибка -- по привычке хвататься за библиотеку валидации в новом сервисе на .NET 11, прежде чем у вас появилось правило, которое фреймворк уже не может выразить бесплатно.

## Связанное

- [Как валидировать тела запросов в minimal API без контроллеров в ASP.NET Core 11](/ru/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) -- полная настройка встроенной возможности.
- [Minimal API против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) -- решение о модели endpoint-а, лежащее в основе этого.
- [Как организовать endpoint-ы minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) -- применение фильтра валидации ко всей группе маршрутов.
- [Использование Native AOT с minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) -- почему валидатор на генераторе важен при trimming.
- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) -- подстраховка для всего, что валидация не ловит.

## Источники

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (встроенная валидация minimal API, `AddValidation`, генератор исходного кода, `ProblemDetails`).
- Документация FluentValidation, [ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html) (устаревание автоматической валидации, рекомендуемый ручной подход с `IValidator<T>`).
- Документация FluentValidation, [Asynchronous Validation](https://docs.fluentvalidation.net/en/latest/async.html) (`MustAsync`, `WhenAsync`, требование `ValidateAsync`).
- FluentValidation, [Deprecation of the FluentValidation.AspNetCore package (issue #1960)](https://github.com/FluentValidation/FluentValidation/issues/1960).
- NuGet, [FluentValidation 12.1.1](https://www.nuget.org/packages/fluentvalidation/) (текущая версия, лицензия Apache 2.0).
- DevClass, [Another open source project shifts to restrictive license: Fluent Assertions](https://www.devclass.com/development/2025/01/16/another-open-source-project-shifts-to-restrictive-license-fluent-assertions-following-xceed-partnership/) (смена лицензии коснулась Fluent Assertions, а не FluentValidation).
</content>
