---
title: "Валидация minimal API против FluentValidation в ASP.NET Core 11: что выбрать?"
description: "Сравнение встроенной валидации Minimal API и FluentValidation: асинхронные правила, фильтры конечных точек, версии и лицензия."
pubDate: 2026-06-15
updatedDate: 2026-11-02
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

ASP.NET Core 10 добавил встроенную валидацию Minimal API через `AddValidation()`. .NET 11 расширяет её: Preview 6 добавил поддержку `AsyncValidationAttribute` и `IAsyncValidatableObject` для Minimal API. Поэтому сама необходимость асинхронной проверки не делает FluentValidation обязательным в .NET 11.

**Исправление — 2 ноября 2026 года:** сравнение теперь учитывает встроенную асинхронную валидацию .NET 11. Синхронные примеры ниже проверены с SDK 10.0.302 и FluentValidation 12.1.1; выполнение на .NET 11 и результаты бенчмарков не заявляются.

## Встроенная валидация

DataAnnotations позволяет размещать простые ограничения рядом с моделью. В проекте с Web SDK зарегистрируйте валидацию и сопоставьте обработчик:

```csharp
// Program.cs: Microsoft.NET.Sdk.Web, net10.0 or later.
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

Некорректный ввод вызывает ответ 400 с описанием ошибок валидации до запуска обработчика. Генератор поддерживает атрибуты параметров этого позиционного record. Обычной библиотеке классов с моделями нужны пакет `Microsoft.Extensions.Validation` и регистрация для каждой соответствующей сборки, описанная в документации.

Встроенная обработка .NET 10 синхронна. Для асинхронной валидации .NET 11 используйте документированные API и проверяйте конкретную версию preview или релиза. Внешним запросам по-прежнему нужны отмена и ограничение времени; уникальность необходимо обеспечивать и при сохранении данных.

## FluentValidation через фильтр конечной точки

FluentValidation выносит правила в отдельные классы. Это удобно для композиции, наборов правил, условий или проекта, уже использующего эту API. Следующий фильтр предназначен для одной конечной точки:

```csharp
// Program.cs: add a PackageReference to FluentValidation 12.1.1.
using FluentValidation;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .AddEndpointFilter(async (context, next) =>
    {
        var product = context.GetArgument<CreateProduct>(0);
        var validator = context.HttpContext.RequestServices
            .GetRequiredService<IValidator<CreateProduct>>();
        var result = await validator.ValidateAsync(
            product, context.HttpContext.RequestAborted);
        if (!result.IsValid)
            return Results.ValidationProblem(result.ToDictionary());
        return await next(context);
    });

app.Run();

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

Фильтр предполагает, что `CreateProduct` — аргумент с индексом ноль. Не переносите его без изменений на группу обработчиков с другими сигнатурами. Если возможны асинхронные правила, вызывайте `ValidateAsync`, передавайте токен отмены запроса и регистрируйте необходимые зависимости в DI.

Этот подход отличается от старой автоматической MVC-интеграции `FluentValidation.AspNetCore`. Та обработка синхронна, не интегрирует Minimal API и больше не рекомендуется документацией FluentValidation для новых проектов. Не путайте её с новой встроенной валидацией ASP.NET Core.

## Выбор и лицензия

Учитывайте сопровождение и повторное использование правил, развёрнутую версию платформы и требуемый клиентам формат ошибок. Для простой модели с DataAnnotations встроенная проверка — подходящая отправная точка. FluentValidation предлагает другую организацию и композицию правил. Ни один подход не гарантирует лучшую скорость или совместимость Native AOT для любого пользовательского валидатора и зависимости. Проверяйте результат публикации и фактическую работу.

Используемый здесь FluentValidation 12.1.1 распространяется по Apache License 2.0. FluentAssertions — другой проект; новости о его лицензии не определяют лицензию FluentValidation. Проверяйте конкретную поставляемую версию зависимости.

Об организации обработчиков см. [группы маршрутов MapGroup](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Источники

- [ASP.NET Core validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-11.0)
- [.NET 11: asynchronous Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0#async-validation-for-minimal-apis)
- [FluentValidation: ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)
- [FluentValidation: asynchronous rules](https://docs.fluentvalidation.net/en/latest/async.html)
- [FluentValidation 12.1.1 license](https://github.com/FluentValidation/FluentValidation/blob/12.1.1/License.txt)
