---
title: "Асинхронная валидация приходит в Minimal APIs в .NET 11 Preview 6"
description: "Preview 6 добавляет AsyncValidationAttribute и IAsyncValidatableObject, чтобы правила DataAnnotations могли обращаться к базе данных до запуска вашего endpoint, не блокируя поток."
pubDate: 2026-07-20
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "validation"
  - "minimal-apis"
  - "csharp"
lang: "ru"
translationOf: "2026/07/aspnetcore-11-async-validation-minimal-apis-preview-6"
translatedBy: "claude"
translationDate: 2026-07-20
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) закрывает пробел, который DataAnnotations несёт с момента выхода: валидация была синхронной. Если правилу требовалось обратиться к базе данных (занят ли этот email, свободен ли ещё этот слот?), вы либо блокировали поток внутри `IsValid`, либо отказывались от DataAnnotations и переходили на FluentValidation. Preview 6 добавляет полноценные асинхронные валидаторы и связывает их со встроенной валидацией Minimal APIs, представленной в .NET 10.

## Две новые точки подключения

В `System.ComponentModel.DataAnnotations` появляются два типа. Первый -- это `AsyncValidationAttribute` для правила на отдельном члене:

```csharp
public sealed class UniqueEmailAttribute : AsyncValidationAttribute
{
    // Still required, but throws if the attribute is async-only.
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
        => throw new InvalidOperationException("Use IsValidAsync.");

    protected override async Task<ValidationResult?> IsValidAsync(
        object? value, ValidationContext context, CancellationToken cancellationToken)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var exists = await db.Users.AnyAsync(u => u.Email == (string?)value, cancellationToken);
        return exists ? new ValidationResult("Email is already registered.") : ValidationResult.Success;
    }
}
```

Второй -- это `IAsyncValidatableObject` для правил, которые охватывают несколько свойств или требуют объект целиком. Он возвращает `IAsyncEnumerable<ValidationResult>`, и поскольку он расширяет `IValidatableObject`, вы по-прежнему реализуете синхронный `Validate` (который выбрасывает исключение, когда вы валидируете только асинхронно):

```csharp
public class ReservationRequest : IAsyncValidatableObject
{
    public DateOnly Date { get; set; }
    public int PartySize { get; set; }

    public IEnumerable<ValidationResult> Validate(ValidationContext context)
        => throw new InvalidOperationException("Use ValidateAsync.");

    public async IAsyncEnumerable<ValidationResult> ValidateAsync(
        ValidationContext context,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var taken = await db.Reservations.CountAsync(r => r.Date == Date, cancellationToken);
        if (taken + PartySize > 40)
            yield return new ValidationResult("No capacity left for that date.", [nameof(PartySize)]);
    }
}
```

## Как это подключить

Никакого нового включения помимо вызова `AddValidation()`, который уже появился в .NET 10, не требуется. Зарегистрируйте его, и фреймворк запустит ваши асинхронные валидаторы до того, как выполнится тело endpoint:

```csharp
builder.Services.AddValidation();

app.MapPost("/reservations", (ReservationRequest request) => Results.Ok(request));
```

Недопустимый запрос обрывается на `400` с полезной нагрузкой `ValidationProblemDetails`, ровно как в синхронном пути. Под капотом это опирается на новый API `Validator.ValidateObjectAsync` в базовых библиотеках, поэтому работает и за пределами ASP.NET Core.

## Деталь, которую стоит знать

Асинхронная валидация случайно провоцирует последовательные обращения, поэтому фреймворк выполняет работу параллельно там, где может: асинхронные атрибуты на одном члене стартуют вместе, а элементы коллекции валидируются параллельно. При этом сохраняется существующий порядок между членом, типом и `IValidatableObject`, так что дешёвая проверка `[Required]` падает быстро, прежде чем вы заплатите за запрос к базе данных. Сочетайте это с [автоматической защитой от CSRF](/ru/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) из Preview 6, и встроенный конвейер покрывает заметно больше, чем версией ранее.

Возьмите SDK .NET 11 Preview 6, нацельтесь на `net11.0` и прочитайте [заметки о выпуске ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md), чтобы узнать всю поверхность валидаторов.
