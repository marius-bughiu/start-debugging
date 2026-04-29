---
title: "Как разделить логику валидации между сервером и Blazor WebAssembly"
description: "Главный источник расхождений в валидации между Blazor WebAssembly клиентом и ASP.NET Core API -- это соблазн писать правила дважды. Это руководство показывает единственную раскладку, которая масштабируется в .NET 11: библиотека классов Shared, владеющая DTO и их валидаторами, потребляемая и WASM клиентом (EditForm + DataAnnotationsValidator или Blazored.FluentValidation), и сервером (фильтр endpoint в minimal API или model binding в MVC), с протестированным циклом, который возвращает серверные ValidationProblemDetails обратно в EditContext."
pubDate: 2026-04-29
tags:
  - "blazor"
  - "blazor-webassembly"
  - "aspnetcore-11"
  - "dotnet-11"
  - "validation"
  - "fluentvalidation"
  - "csharp"
lang: "ru"
translationOf: "2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly"
translatedBy: "claude"
translationDate: 2026-04-29
---

Если ваш Blazor WebAssembly клиент и ASP.NET Core API хранят отдельные копии правил валидации, они расходятся уже на первом спринте и порождают худший вид багов: форма проходит на клиенте, сервер её отклоняет, пользователь видит 400 без какого-либо встроенного сообщения. Единственное долговременное решение -- положить и DTO, и их валидаторы в третий проект, на который ссылаются и клиент, и сервер, а ответ об ошибке от сервера отображать в том же `EditContext`, который использовал клиент. Это руководство выстраивает такую раскладку от начала до конца на .NET 11 (`Microsoft.AspNetCore.App` 11.0.0, `Microsoft.AspNetCore.Components.Web` 11.0.0, C# 14), сначала со встроенным `System.ComponentModel.DataAnnotations`, затем с `FluentValidation` 12 для правил, которые data annotations выразить не могут.

## Почему Shared проект, а не дублированные правила и не пакет NuGet

Два паттерна, которые проваливаются, очевидны задним числом. Копирование атрибутов `[Required]` из DTO API в почти идентичную view model на клиенте порождает расхождение каждый раз, когда кто-то редактирует одно и забывает другое. Положить контракты во внешний пакет NuGet работает для больших систем, но это перебор для одного приложения: вы платите версионными бампами, задержкой восстановления пакетов и внутренним фидом за то, что должно быть проектной ссылкой.

Библиотека классов `Contracts` (или `Shared`) внутри той же solution -- правильная форма. Она нацелена на `net11.0`, не имеет зависимостей от ASP.NET, и на неё ссылаются как `WebApp.Client` (проект Blazor WASM), так и `WebApp.Server` (API ASP.NET Core). Шаблон проекта Blazor WebAssembly, поставляемый с .NET 11 (`dotnet new blazorwasm --hosted` был удалён в .NET 8 и так и остался удалённым в .NET 11; теперь вы создаёте три проекта вручную или используете `dotnet new blazor --interactivity WebAssembly --auth Individual` для унифицированного шаблона Blazor) уже принимает такую раскладку: возьмите тот скаффолд, которым пользуетесь, и добавьте третий проект.

```bash
# .NET 11 SDK (11.0.100)
dotnet new sln -n WebApp
dotnet new classlib -n WebApp.Contracts -f net11.0
dotnet new webapi -n WebApp.Server -f net11.0
dotnet new blazorwasm -n WebApp.Client -f net11.0
dotnet sln add WebApp.Contracts WebApp.Server WebApp.Client
dotnet add WebApp.Server reference WebApp.Contracts
dotnet add WebApp.Client reference WebApp.Contracts
```

Два правила сохраняют `WebApp.Contracts` чистым и предотвращают случайное затягивание серверного кода в WASM-бандл:

1. В `.csproj` нет ни `FrameworkReference`, ни пакетов `Microsoft.AspNetCore.*`. Если вам нужен `IFormFile` или `HttpContext` в контракте, вы смешиваете формат провода с серверной логикой; разделите их.
2. Установлено `<IsTrimmable>true</IsTrimmable>`, чтобы шаг публикации WASM не предупреждал на каждом валидаторе, использующем рефлексию. Мы вернёмся к этому в разделе про AOT.

## DTO, который проходит через все примеры

```csharp
// WebApp.Contracts/RegistrationRequest.cs
// .NET 11, C# 14, System.ComponentModel.DataAnnotations 11.0.0
using System.ComponentModel.DataAnnotations;

namespace WebApp.Contracts;

public sealed record RegistrationRequest
{
    [Required, EmailAddress, StringLength(254)]
    public required string Email { get; init; }

    [Required, StringLength(72, MinimumLength = 12)]
    public required string Password { get; init; }

    [Required, Compare(nameof(Password))]
    public required string ConfirmPassword { get; init; }

    [Range(13, 130)]
    public int Age { get; init; }

    [Required, RegularExpression(@"^[a-zA-Z0-9_]{3,20}$",
        ErrorMessage = "Username must be 3-20 letters, digits, or underscores.")]
    public required string Username { get; init; }
}
```

Члены `required` в сочетании с `init`-only сеттерами дают record, который клиент может построить с синтаксисом инициализатора объекта и который `System.Text.Json` 11 может десериализовать на сервере без беспараметрового конструктора (он протягивает эквивалент `[JsonConstructor]`-инференса через `required`-члены в .NET 11). Тот же record -- это тип, который связывается endpoint-ом API и моделью `EditForm`. Изменить правило можно ровно в одном месте.

## Путь DataAnnotations: ноль дополнительных пакетов

Для большинства CRUD приложений data annotations на общем DTO достаточно. Они выполняются на клиенте, потому что `<DataAnnotationsValidator>` Blazor (в `Microsoft.AspNetCore.Components.Forms`) рефлексирует над моделью и подаёт сообщения в `EditContext`, и они выполняются на сервере, потому что pipeline model binding-а ASP.NET Core вызывает `ObjectGraphValidator` для любого типа, помеченного `[ApiController]`, или любого параметра minimal API, который проходит через стандартный `IValidationProblemDetailsService` (введённый в рамках работы по endpoint filter validation, отслеживаемой в [aspnetcore#52281](https://github.com/dotnet/aspnetcore/pull/52281)).

Серверный endpoint в стиле minimal API:

```csharp
// WebApp.Server/Program.cs
// .NET 11, ASP.NET Core 11.0.0
using Microsoft.AspNetCore.Http.HttpResults;
using WebApp.Contracts;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation(); // .NET 11 endpoint filter that runs DataAnnotations

var app = builder.Build();

app.MapPost("/api/register",
    Results<Ok<RegistrationResponse>, ValidationProblem> (RegistrationRequest req) =>
    {
        // model is already validated by the endpoint filter
        return TypedResults.Ok(new RegistrationResponse(Guid.NewGuid()));
    });

app.Run();

public sealed record RegistrationResponse(Guid UserId);
```

`AddValidation()` -- это helper из .NET 11, который регистрирует endpoint filter, обходящий обнаруженные через `[Validator]` или аннотированные `DataAnnotations` члены каждого параметра и закорачивающийся телом `400` `ValidationProblemDetails` до запуска вашего handler-а. Форма ответа та же, что клиент читает обратно ниже.

Форма клиента в `WebApp.Client/Pages/Register.razor`:

```razor
@* Blazor WebAssembly, .NET 11. Microsoft.AspNetCore.Components 11.0.0 *@
@page "/register"
@using System.Net.Http.Json
@using WebApp.Contracts
@inject HttpClient Http

<EditForm Model="model" OnValidSubmit="SubmitAsync" FormName="register">
    <DataAnnotationsValidator />
    <ValidationSummary />

    <label>Email <InputText @bind-Value="model.Email" /></label>
    <ValidationMessage For="() => model.Email" />

    <label>Password <InputText type="password" @bind-Value="model.Password" /></label>
    <ValidationMessage For="() => model.Password" />

    <button type="submit">Register</button>
</EditForm>

@code {
    private RegistrationRequest model = new()
    {
        Email = "", Password = "", ConfirmPassword = "", Username = ""
    };

    private async Task SubmitAsync()
    {
        var response = await Http.PostAsJsonAsync("api/register", model);
        if (!response.IsSuccessStatusCode)
        {
            await ApplyServerValidationAsync(response);
        }
    }
}
```

Две вещи делают это историей *общей* валидации, а не двух параллельных. Во-первых, `model` -- это `RegistrationRequest`, тот же DTO, что связывает сервер. Во-вторых, когда `<DataAnnotationsValidator>` оценивает форму, он выполняет ровно тот же проход `Validator.TryValidateObject`, что и endpoint filter сервера. Что принимает клиент, то принимает и сервер; что сервер отклоняет с `EmailAddress`, то отклоняет и клиент.

## Перенос ValidationProblemDetails с сервера обратно в EditContext

Даже с общими правилами два класса ошибок приходят только с сервера: межагрегатные проверки (email уникален в таблице пользователей) и инфраструктурные сбои (rate limit, ограничение БД). Для них сервер возвращает `400` с `ValidationProblemDetails`, и клиент должен извлечь каждую ошибку поля и прикрепить её к правильному `FieldIdentifier` в `EditContext`, чтобы пользователь увидел сообщение встроенно рядом с проблемным полем, а не как универсальный alert "регистрация не удалась".

```csharp
// WebApp.Client/Validation/EditContextExtensions.cs
// .NET 11, C# 14
using Microsoft.AspNetCore.Components.Forms;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

public static class EditContextExtensions
{
    private static readonly JsonSerializerOptions Options =
        new(JsonSerializerDefaults.Web);

    public static async Task ApplyValidationProblemAsync(
        this EditContext editContext,
        HttpResponseMessage response)
    {
        if ((int)response.StatusCode != 400) return;

        var problem = await response.Content
            .ReadFromJsonAsync<ValidationProblemDetails>(Options);
        if (problem?.Errors is null) return;

        var messageStore = new ValidationMessageStore(editContext);
        messageStore.Clear();

        foreach (var (fieldName, messages) in problem.Errors)
        {
            // ASP.NET Core uses lowercase-first names by default; normalize.
            var pascal = char.ToUpperInvariant(fieldName[0]) + fieldName[1..];
            var identifier = new FieldIdentifier(editContext.Model, pascal);
            foreach (var msg in messages) messageStore.Add(identifier, msg);
        }

        editContext.NotifyValidationStateChanged();
    }
}
```

Тогда handler в Razor-файле принимает вид:

```csharp
private EditContext editContext = default!;

protected override void OnInitialized() =>
    editContext = new EditContext(model);

private async Task SubmitAsync()
{
    var response = await Http.PostAsJsonAsync("api/register", model);
    if (response.StatusCode == System.Net.HttpStatusCode.BadRequest)
        await editContext.ApplyValidationProblemAsync(response);
}
```

Это важно потому, что сервер -- единственное место, где могут выполняться некоторые проверки. Правило "username уже занят" не может жить в общей библиотеке, потому что требует обращения к базе. Передавая его сбой в тот же `EditContext`, пользователь получает единую ментальную модель: каждая ошибка появляется рядом с проблемным полем, независимо от того, сработало правило в браузере или в API.

## Когда DataAnnotations недостаточно: FluentValidation 12 в общем проекте

DataAnnotations не может выразить условные правила ("Postcode обязателен, если Country равен 'US'"), не может запускать асинхронные проверки против сервиса, и его сообщения об ошибках неудобно локализовать дальше одного файла ресурсов на атрибут. FluentValidation 12, выпущенный в 2026 с первоклассной поддержкой .NET 11, спокойно живёт в том же общем проекте и работает в обе стороны.

Добавьте пакет и напишите валидатор рядом с DTO:

```bash
dotnet add WebApp.Contracts package FluentValidation --version 12.0.0
```

```csharp
// WebApp.Contracts/RegistrationRequestValidator.cs
// FluentValidation 12.0.0, .NET 11, C# 14
using FluentValidation;

namespace WebApp.Contracts;

public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator()
    {
        RuleFor(r => r.Email).NotEmpty().EmailAddress().MaximumLength(254);
        RuleFor(r => r.Password).NotEmpty().MinimumLength(12).MaximumLength(72);
        RuleFor(r => r.ConfirmPassword).Equal(r => r.Password)
            .WithMessage("Passwords do not match.");
        RuleFor(r => r.Username).Matches(@"^[a-zA-Z0-9_]{3,20}$");
        RuleFor(r => r.Age).InclusiveBetween(13, 130);
    }
}
```

На сервере зарегистрируйте FluentValidation как источник валидаторов для того же фильтра `AddValidation()` или вызывайте его явно из фильтра minimal API:

```csharp
// WebApp.Server/Program.cs additions
using FluentValidation;
using WebApp.Contracts;

builder.Services.AddScoped<IValidator<RegistrationRequest>,
                           RegistrationRequestValidator>();

app.MapPost("/api/register", async (
    RegistrationRequest req,
    IValidator<RegistrationRequest> validator) =>
{
    var result = await validator.ValidateAsync(req);
    if (!result.IsValid) return Results.ValidationProblem(result.ToDictionary());
    return Results.Ok(new RegistrationResponse(Guid.NewGuid()));
});
```

`result.ToDictionary()` производит форму `IDictionary<string, string[]>`, которую ожидает `Results.ValidationProblem`, поэтому формат провода, который декодирует клиент, идентичен пути DataAnnotations. Ваше расширение `ApplyValidationProblemAsync` продолжает работать.

На клиенте установите `Blazored.FluentValidation` (форк `aksoftware` -- это активно поддерживаемый в 2026, версия 2.4.0, нацеленная на `net11.0`) и замените `<DataAnnotationsValidator />` на `<FluentValidationValidator />`:

```bash
dotnet add WebApp.Client package Blazored.FluentValidation --version 2.4.0
```

```razor
@using Blazored.FluentValidation

<EditForm Model="model" OnValidSubmit="SubmitAsync">
    <FluentValidationValidator />
    <ValidationSummary />
    @* same fields as before *@
</EditForm>
```

Компонент находит валидатор по соглашению (`FooValidator` для `Foo`) в сборке, содержащей модель, то есть `WebApp.Contracts`. Поскольку валидатор находится в общем проекте, клиент и сервер исполняют один и тот же экземпляр одних и тех же правил. Единственное различие -- *где* они исполняются.

## Асинхронные правила, которые должны выполняться только на сервере

FluentValidation позволяет смешивать синхронные и асинхронные правила. Соблазнительно положить `MustAsync(IsUsernameAvailableAsync)` в валидатор и считать дело сделанным. Не надо: сторона клиента не имеет доступа к вашему `UserManager`, а синхронный Blazor `EditForm` не может ожидать асинхронное правило прямо посреди нажатия клавиши. Работающий паттерн -- пометить async-only правила через `RuleSet`:

```csharp
public sealed class RegistrationRequestValidator : AbstractValidator<RegistrationRequest>
{
    public RegistrationRequestValidator(IUserUniqueness? uniqueness = null)
    {
        // rules that run everywhere
        RuleFor(r => r.Email).NotEmpty().EmailAddress();
        // ... shared rules omitted

        RuleSet("Server", () =>
        {
            if (uniqueness is null) return; // skipped on client
            RuleFor(r => r.Email).MustAsync(uniqueness.IsEmailFreeAsync)
                .WithMessage("This email is already registered.");
            RuleFor(r => r.Username).MustAsync(uniqueness.IsUsernameFreeAsync)
                .WithMessage("Username taken.");
        });
    }
}

// WebApp.Contracts/IUserUniqueness.cs - interface only, no implementation
public interface IUserUniqueness
{
    ValueTask<bool> IsEmailFreeAsync(string email, CancellationToken ct);
    ValueTask<bool> IsUsernameFreeAsync(string username, CancellationToken ct);
}
```

Интерфейс лежит в `WebApp.Contracts`, чтобы валидатор скомпилировался, но реализации там нет. Сервер предоставляет реальную реализацию на базе EF Core; клиент её не регистрирует, поэтому параметр конструктора равен `null`, и ruleset `Server` не добавляет правил. На сервере вы явно его включаете:

```csharp
await validator.ValidateAsync(req,
    options => options.IncludeRuleSets("default", "Server"));
```

Так межагрегатная проверка срабатывает только там, где может, и возвращается клиенту через тот же маппинг `ValidationProblemDetails`, который вы уже построили.

## Подводные камни trim и AOT в шаге публикации WASM

Публикация Blazor WebAssembly в .NET 11 по умолчанию выполняет IL trimming и поддерживает отдельный AOT проход с `<RunAOTCompilation>true</RunAOTCompilation>`. Оба прохода выдают предупреждения, когда библиотека использует неограниченную рефлексию, что и делают и DataAnnotations, и FluentValidation. Три конкретные вещи, которые нужно сделать:

1. Пометьте общий проект как обрезаемый: `<IsTrimmable>true</IsTrimmable>` и `<IsAotCompatible>true</IsAotCompatible>` в `WebApp.Contracts.csproj`. Это заставляет SDK выводить trim-предупреждения внутри общей библиотеки, где вы можете их исправить, вместо того чтобы молча обрезать обнаружение правил у потребителя.
2. Для DataAnnotations runtime со времён .NET 8 поставляет аннотации `[DynamicallyAccessedMembers(All)]` на `Validator.TryValidateObject`, и они по-прежнему действуют в .NET 11; вам не нужно делать ничего больше, пока ваш DTO `public` и достижим из корня, который trimmer видит. `EditForm` достигает типа модели через generic-аргумент, что засчитывается.
3. Для FluentValidation 12 каждый определяемый вами валидатор подвергается рефлексии при старте. Компонент `Blazored.FluentValidation` 2.4.0 сканирует сборку с применёнными аннотациями `[DynamicDependency]`, чтобы пережить trimming, но если вы публикуете с `RunAOTCompilation`, добавьте `<TrimmerRootAssembly Include="WebApp.Contracts" />` в `.csproj` клиента. Это укореняет всю общую сборку и является самым простым корректным ответом; стоимость по размеру WASM мала, поскольку единственные публичные типы в `WebApp.Contracts` -- это DTO и валидаторы, которые вы и так используете.

Если пропустить эти шаги, клиент выглядит здоровым в `dotnet run`, а затем выкатывается Release-билд, в котором валидация молча ничего не делает, потому что trimmer удалил правила, использование которых не смог доказать статически.

## Регистр в именах полей и ловушка snake_case

Стандартные JSON-параметры ASP.NET Core 11 сериализуют имена свойств в `camelCase`. Поэтому `ValidationProblemDetails.Errors` приходит с ключом `email`, а не `Email`, и `FieldIdentifier` чувствителен к регистру. Нормализация в `pascal` в `ApplyValidationProblemAsync` покрывает обычный случай, но не вложенные члены (`Address.PostalCode` становится `address.PostalCode`, если поднять только первую букву). Для вложенных DTO разделите по `.`, поднимите первую букву каждого сегмента и затем спускайтесь во вложенный объект, используя сегменты для построения цепочки экземпляров `FieldIdentifier(parent, propertyName)`. Или, если вы контролируете JSON-параметры, установите `JsonNamingPolicy = null` только для `ProblemDetails`, написав свой `IProblemDetailsService`. Более простой ответ -- держать DTO достаточно плоскими, чтобы переключение регистра было однострочным.

Если вы глобально применяете другую naming policy (snake_case популярен в 2026 из-за инструментов OpenAPI), идея та же: распарсите политику, инвертируйте её и подайте исправленное имя в `FieldIdentifier`. Встроенного helper-а для этого в `Microsoft.AspNetCore.Components.Forms` нет; `EditContext` был спроектирован до того, как `ProblemDetails` стал стандартной формой ошибки, и они до сих пор не соединены.

## Связанные руководства и исходные материалы

Для вспомогательной обвязки, которую это руководство предполагает у вас наличной: [паттерн глобального exception filter в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) ловит не-валидационные сбои, которые никогда не должны доходить до пользователя как 500. Если хотите глубже взглянуть на endpoint, поддерживающий эту форму, [refresh-токены в ASP.NET Core Identity](/ru/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) показывают продолжение `/api/register`. Для типизированных клиентов, генерируемых из того же DTO, чтобы вы не печатали URL вручную, см. [генерация строго типизированных клиентов из спецификации OpenAPI на .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/). А на стороне JSON [пользовательский `JsonConverter` в `System.Text.Json`](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- это правильный аварийный выход, когда одно поле общего DTO нуждается в разной форме на проводе.

Первичные источники, использованные при написании:

- [Endpoint validation filter для minimal API в ASP.NET Core 11](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-11.0#validation), MS Learn.
- [Blazor `EditForm` и `DataAnnotationsValidator`](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/validation?view=aspnetcore-11.0), MS Learn.
- [Справка по `ValidationProblemDetails`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails), .NET API Browser.
- [Документация FluentValidation 12](https://docs.fluentvalidation.net/en/latest/blazor.html), страница интеграции с Blazor.
- [Blazored.FluentValidation 2.4.0](https://github.com/Blazored/FluentValidation), README на GitHub.
- [Руководство по trimming и AOT для Blazor WebAssembly в .NET 11](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/configure-trimmer?view=aspnetcore-11.0), MS Learn.
