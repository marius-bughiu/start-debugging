---
title: "Как валидировать опции при старте с помощью IValidateOptions<T> в .NET 11"
description: "Реализуйте IValidateOptions<T>, зарегистрируйте его во внедрении зависимостей и добавьте ValidateOnStart, чтобы неверный appsettings.json убивал процесс, а не первый запрос, который его затронет. Разбираются перегрузка Validate<TValidator>() из .NET 11, асинхронная валидация через IAsyncValidateOptions<T> и три случая, когда ValidateOnStart молча ничего не делает."
pubDate: 2026-08-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "configuration"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Чтобы приложение падало при старте из-за неверной конфигурации, напишите класс, реализующий `IValidateOptions<TOptions>`, зарегистрируйте его во внедрении зависимостей как singleton и добавьте `.ValidateOnStart()` к `OptionsBuilder<TOptions>` для этого типа. Без `ValidateOnStart` валидаторы выполняются лениво при первом обращении к `.Value`, а это обычно означает первый запрос, который затронет настройку, в продакшене, в три часа ночи. С ним `Host.StartAsync` заставляет каждый зарегистрированный тип опций выполнить привязку и валидацию до запуска хотя бы одного размещённого сервиса, а сбой выбрасывает `OptionsValidationException` из `host.RunAsync()`. Всё изложенное ниже ориентировано на .NET 11 с `Microsoft.Extensions.Options` 11.0.0 и C# 14. Ядро из `IValidateOptions<T>` и `ValidateOnStart` ведёт себя так с тех пор, как API переехал из `Microsoft.Extensions.Hosting.dll` в `Microsoft.Extensions.Options.dll`, поэтому оно работает без изменений на .NET 8 - .NET 10; перегрузка `Validate<TValidator>()` и асинхронный конвейер появились в .NET 11 и отмечены явно.

## Ленивая валидация - это валидация, о которой вы узнаёте от клиента

`ValidateDataAnnotations()` и `Validate(delegate)` подвешивают валидаторы к конвейеру опций, но сам конвейер ленив по замыслу. `IOptions<T>` - это singleton, чьё `.Value` вычисляется при первом чтении. То есть такая регистрация:

```csharp
// .NET 11, C# 14
builder.Services
    .AddOptions<PaymentOptions>()
    .Bind(builder.Configuration.GetSection("Payments"))
    .ValidateDataAnnotations();
```

даёт приложение, которое чисто стартует с пустой секцией `Payments`, проходит health check, обслуживает трафик, а затем выбрасывает `OptionsValidationException` при первом же запросе к эндпоинту оплаты. Развёртывание прошло успешно. Канареечная версия была зелёной. Сбой проявился как 500 на карте клиента.

Весь смысл валидации при старте в том, чтобы превратить это в падение на запуске, с которым оркестраторы уже умеют работать: контейнер завершается с ненулевым кодом, выкатка останавливается, предыдущая ревизия продолжает обслуживать. Такой сбой намного лучше, чем частично сломанный процесс.

## Шаги, чтобы валидация при старте действительно срабатывала

1. **Опишите класс опций с именем секции.** Только публичные свойства на чтение и запись, класс не абстрактный, с публичным конструктором без параметров. Поля не привязываются.
2. **Напишите валидатор как класс, реализующий `IValidateOptions<TOptions>`**, возвращая `ValidateOptionsResult.Fail` со всеми ошибками, а не только с первой.
3. **Зарегистрируйте валидатор во внедрении зависимостей.** Используйте `TryAddEnumerable` с singleton-дескриптором `ServiceDescriptor`, потому что конвейер разрешает `IEnumerable<IValidateOptions<TOptions>>`, и обычный `AddSingleton`, вызванный дважды, даст вам валидатор в двух экземплярах.
4. **Добавьте `.ValidateOnStart()`** к builder или начните с `AddOptionsWithValidateOnStart<TOptions>()`, чтобы просто не смочь об этом забыть.
5. **Запустите host.** `ValidateOnStart` ничего не делает, пока не выполнится `Host.StartAsync`. Одной сборки host недостаточно.

Вот всё целиком.

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class PaymentOptions
{
    public const string SectionName = "Payments";

    [Required]
    public required string ApiKey { get; set; }

    [Required]
    [Url]
    public required string Endpoint { get; set; }

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [Range(0, 10)]
    public int MaxRetries { get; set; } = 3;
}
```

Валидатор. Обратите внимание, что он собирает ошибки, а не выходит на первой, поэтому тот, кто чинит сломанный `appsettings.json`, получает полный список за один запуск, а не по одной ошибке на перезапуск:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
    public ValidateOptionsResult Validate(string? name, PaymentOptions options)
    {
        var builder = new ValidateOptionsResultBuilder();

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            builder.AddError("ApiKey is missing.", nameof(PaymentOptions.ApiKey));
        }
        else if (!options.ApiKey.StartsWith("pk_", StringComparison.Ordinal))
        {
            builder.AddError(
                "ApiKey must start with 'pk_'. A secret key was probably pasted by mistake.",
                nameof(PaymentOptions.ApiKey));
        }

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out Uri? endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps)
        {
            builder.AddError(
                "Endpoint must be an absolute https URI.",
                nameof(PaymentOptions.Endpoint));
        }

        // Cross-property rule: nothing in DataAnnotations can express this.
        if (options.TimeoutSeconds * (options.MaxRetries + 1) > 300)
        {
            builder.AddError(
                $"TimeoutSeconds ({options.TimeoutSeconds}) times MaxRetries + 1 "
                + $"({options.MaxRetries + 1}) exceeds the 300s gateway budget.");
        }

        return builder.Build();
    }
}
```

`ValidateOptionsResultBuilder` живёт в `Microsoft.Extensions.Options` и существует именно для того, чтобы вы не собирали `StringBuilder` вручную. `Build()` возвращает `ValidateOptionsResult.Success`, если ничего не добавлено, так что никаких плясок с null в конце нет. `AddError` принимает необязательное имя свойства, которое подставляется в начало сообщения, а ещё есть `AddResult(ValidationResult)` и `AddResults(IEnumerable<ValidationResult>)`, чтобы перенести вывод DataAnnotations в тот же список.

Регистрация:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection.Extensions;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptionsWithValidateOnStart<PaymentOptions>()
    .Bind(builder.Configuration.GetSection(PaymentOptions.SectionName))
    .ValidateDataAnnotations();

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<PaymentOptions>, ValidatePaymentOptions>());

var app = builder.Build();
await app.RunAsync();
```

`AddOptionsWithValidateOnStart<TOptions>()` - это просто `AddOptions<TOptions>().ValidateOnStart()` с порядком, который невозможно забыть. Есть также перегрузка с двумя параметрами типа, `AddOptionsWithValidateOnStart<TOptions, TValidateOptions>()`, которая регистрирует валидатор за вас и сводит две регистрации выше к одному вызову.

`ValidateDataAnnotations()` и написанный вручную `IValidateOptions<T>` не исключают друг друга. Атрибуты отвечают за форму отдельных свойств, класс - за правила, которые охватывают несколько свойств или требуют сервис. Выполняются все зарегистрированные валидаторы, и все их ошибки собираются вместе.

## Что на самом деле регистрирует ValidateOnStart

`ValidateOnStart` ничего не выполняет в момент регистрации. Прочитайте [исходный код среды выполнения](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) .NET 11, и увидите три вещи:

```csharp
optionsBuilder.Services.TryAddTransient<IStartupValidator, StartupValidator>();
optionsBuilder.Services.TryAddTransient<IAsyncStartupValidator, StartupValidator>();
optionsBuilder.Services.AddOptions<StartupValidatorOptions>()
    .Configure<IOptionsMonitor<TOptions>>((vo, options) =>
    {
        // This adds an action that resolves the options value to force evaluation
        // We don't care about the result as duplicates are not important
        vo._validators[(typeof(TOptions), optionsBuilder.Name)] = () => options.Get(optionsBuilder.Name);
    });
```

Он добавляет замыкание во внутренний словарь `StartupValidatorOptions` с ключом `(Type, name)`. Замыкание вызывает `IOptionsMonitor<TOptions>.Get(name)`, а это заставляет `OptionsFactory<TOptions>.Create` пройти цепочку `IConfigureOptions<T>`, затем цепочку `IPostConfigureOptions<T>`, затем каждый `IValidateOptions<T>`. Валидация - побочный эффект принудительной привязки.

`TryAdd` здесь важен. В прежних выпусках это был `AddTransient`, поэтому вызов `ValidateOnStart` для десяти типов опций клал в контейнер десять копий `StartupValidator`. Ключ словаря объясняет и старую острую грань: ключ `(Type, name)` даёт каждому именованному экземпляру собственную запись вместо того, чтобы последний перезаписывал остальные.

Триггер находится в `Host.StartAsync`, после `IHostLifetime.WaitForStartAsync` и до запуска любого размещённого сервиса:

```csharp
IStartupValidator? validator = Services.GetService<IStartupValidator>();
validator?.Validate();

IAsyncStartupValidator? asyncValidator = Services.GetService<IAsyncStartupValidator>();
if (asyncValidator is not null)
{
    await asyncValidator.ValidateAsync(cancellationToken).ConfigureAwait(false);
}
```

Два следствия стоит усвоить. Первое: валидация выполняется до `IHostedLifecycleService.StartingAsync`, поэтому `BackgroundService` никогда не увидит наполовину корректную конфигурацию. Второе: если падает больше одного типа опций, `StartupValidator` собирает исключения и перевыбрасывает их как `AggregateException`, так что вы видите все сломанные секции в одной строке журнала, а не ловите их по одной между перезапусками.

## Перегрузка Validate<TValidator>() в .NET 11

До .NET 11 подключение валидатора означало две инструкции, которые должны были согласовываться друг с другом: `AddSingleton` для валидатора и отдельная цепочка `AddOptions`. В .NET 11 добавлена обобщённая перегрузка [`OptionsBuilder<TOptions>.Validate<TValidator>()`](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries#options-builder-validation-improvements), принимающая параметр типа вместо делегата:

```csharp
// .NET 11 only
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

Тип валидатора обязан реализовывать `IValidateOptions<TOptions>` и уже быть зарегистрированным в контейнере, и в этом весь смысл: валидатор разрешается через внедрение зависимостей, поэтому может принимать зависимости в конструкторе, например `IHostEnvironment`, `TimeProvider` или `HttpClient`. Раньше это было неудобно, потому что перегрузки `Validate` с делегатом дают только экземпляр опций, а до пяти внедрённых сервисов были доступны лишь на стороне `Configure`.

Не пропускайте `AddSingleton`. Перегрузка разрешает тип, но не регистрирует его.

## Асинхронная валидация с IAsyncValidateOptions<T>

Интересное дополнение .NET 11 в том, что валидация при старте теперь может выполнять ввод-вывод. Часть конфигурации неверна только так, что этого не увидеть, не спросив у кого-то: строка подключения, которая разбирается, но указывает на несуществующую базу данных; OIDC-authority, чей документ discovery отдаёт 404; контейнер blob-хранилища, который управляемая identity не может прочитать. До .NET 11 честных вариантов было два: блокировать поток внутри `Validate` или сдаться и проверять при первом использовании.

`IAsyncValidateOptions<TOptions>` - асинхронный близнец `IValidateOptions<TOptions>`:

```csharp
namespace Microsoft.Extensions.Options;

public interface IAsyncValidateOptions<in TOptions> where TOptions : class
{
    Task<ValidateOptionsResult> ValidateAsync(
        string? name, TOptions options, CancellationToken cancellationToken = default);
}
```

Реализация, которая доказывает, что эндпоинт оплаты действительно доступен:

```csharp
// .NET 11 only
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentEndpointAsync(IHttpClientFactory httpClientFactory)
    : IAsyncValidateOptions<PaymentOptions>
{
    public async Task<ValidateOptionsResult> ValidateAsync(
        string? name, PaymentOptions options, CancellationToken cancellationToken = default)
    {
        using HttpClient client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                new Uri(new Uri(options.Endpoint), "/.well-known/health"), cancellationToken);

            return response.IsSuccessStatusCode
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Payment endpoint {options.Endpoint} returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return ValidateOptionsResult.Fail(
                $"Payment endpoint {options.Endpoint} is unreachable: {ex.Message}");
        }
    }
}
```

Регистрируйте его так же, как синхронный, через `TryAddEnumerable` для `IAsyncValidateOptions<PaymentOptions>`, и сохраните вызов `ValidateOnStart()`. Регистрация в `OptionsBuilderExtensions` материализует все зарегистрированные `IAsyncValidateOptions<TOptions>` во второй словарь `_asyncValidators` и устанавливает асинхронный делегат, только если есть хотя бы один. Если ни одного не зарегистрировано, ничего не меняется и асинхронных издержек нет.

Два поведения, которые стоит учесть. Асинхронные валидаторы выполняются только при старте: асинхронный конвейер висит на `IAsyncStartupValidator`, а не на `IOptionsFactory`, поэтому позднее ленивое обращение к `.Value` их никогда не запустит. И этап 2 выполняется, только если успешно прошёл этап 1, и это сделано намеренно. Нет смысла тратить пять секунд на сетевые пробы, когда URL эндпоинта уже не прошёл атрибут `[Url]`.

Соответствующая работа в DataAnnotations вышла одновременно: `AsyncValidationAttribute` с переопределяемым `IsValidAsync`, `IAsyncValidatableObject` на модели и `Validator.ValidateObjectAsync` / `TryValidateObjectAsync` / `ValidatePropertyAsync` / `ValidateValueAsync`. Берите их, если хотите выразить правило атрибутом на свойстве, а не отдельным классом.

## Обойтись без ручного валидатора с помощью [OptionsValidator]

Если все ваши правила - это атрибуты DataAnnotations, не пишите метод `Validate` вовсе. Генератор исходного кода для валидации опций напишет реализацию `IValidateOptions<T>` за вас на этапе компиляции:

```csharp
// .NET 8 and later
using Microsoft.Extensions.Options;

[OptionsValidator]
public sealed partial class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
}
```

Пустой partial-класс плюс атрибут, и генератор выдаёт `Validate(string?, PaymentOptions)`, который вызывает `Validator.TryValidateValue` для каждого свойства с заранее созданными статическими экземплярами атрибутов, собирая результат в `ValidateOptionsResultBuilder`. Никакой рефлексии по типу опций во время выполнения, и именно поэтому такая форма правильна для Native AOT. Генератор включён по умолчанию, как только проект ссылается на `Microsoft.Extensions.Options` 8.0 или новее, а `ValidateDataAnnotations()` становится избыточным, как только вы его используете. В сгенерированном коде он также заменяет `RangeAttribute`, `MinLengthAttribute`, `MaxLengthAttribute` и `LengthAttribute` на эквиваленты без рефлексии. Если хотите больше контекста о том, что генератор делает со сборкой, посмотрите разбор [что такое генератор исходного кода и когда он нужен](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) и заметки про [код, безопасный для обрезки](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/), объясняющие, почему валидация без рефлексии важна.

По умолчанию валидация DataAnnotations не рекурсивна. Вложенный объект опций или `List<T>` из подопций не валидируется, пока вы этого не укажете, через `[ValidateObjectMembers]` и `[ValidateEnumeratedItems]` соответственно. Оба работают с генератором.

## Где ValidateOnStart молча ничего не делает

Режим отказа, который никто не ловит на ревью, - `ValidateOnStart` зарегистрирован, но никогда не выполняется. Три случая:

**Вы никогда не запускаете host.** Тест или утилита, которые вызывают `builder.Build()` и разрешают сервисы из `host.Services` без `StartAsync`, пропускают валидацию целиком. Если нужна проверка в интеграционном тесте, разрешите опции явно через `GetRequiredService<IOptions<T>>().Value` внутри `try` или вызовите напрямую `host.Services.GetService<IStartupValidator>()?.Validate()`.

**Host не из `Microsoft.Extensions.Hosting`.** Процитированное выше место вызова находится в `Host.StartAsync`. Среды выполнения, которые строят собственный host, самая известная из них - внутрипроцессная модель Azure Functions, до него никогда не доходят, и это ровно [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034). Модель изолированного worker - обычный generic host, и она работает. На всём необычном проверяйте намеренно сломанной секцией, а не предположением.

**Вы зарегистрировали валидатор, но не builder.** `services.Configure<T>(section)` плюс регистрация валидатора даёт только ленивую валидацию. `Configure<T>` не создаёт `OptionsBuilder<T>`, поэтому цеплять `ValidateOnStart` не к чему. Нужен `AddOptions<T>().Bind(section)` или `AddOptionsWithValidateOnStart<T>().Bind(section)`.

Ещё один случай, не молчаливый, но его легко прочитать неправильно: валидаторы выполняются для каждого именованного экземпляра. Если у вас три именованных `PaymentOptions`, а вы вызвали только `AddOptions<PaymentOptions>("primary").ValidateOnStart()`, остальные два валидируются лениво. Каждому имени нужна собственная цепочка. Когда вы подключаете несколько вариантов одного класса настроек, это естественно сочетается с [сервисами с ключом во внедрении зависимостей .NET 11](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) на стороне потребителей.

## Что делать с исключением

`OptionsValidationException` несёт `OptionsType`, `OptionsName` и `Failures` как `IEnumerable<string>`. Его `Message` - это ошибки, склеенные через `;`, что нормально в журнале контейнера и нечитаемо в терминале. Если приложение - это CLI или сервис для разработчиков, перехватить его в начале `Main` и вывести по одной ошибке на строку будет небольшой любезностью:

```csharp
// .NET 11, C# 14
try
{
    await app.RunAsync();
}
catch (OptionsValidationException ex)
{
    Console.Error.WriteLine($"Invalid configuration for {ex.OptionsType.Name}:");
    foreach (string failure in ex.Failures)
    {
        Console.Error.WriteLine($"  - {failure}");
    }
    return 78; // EX_CONFIG
}
```

Оберните это ещё и в `catch (AggregateException agg)`, если валидируете больше одного типа опций, потому что именно так `StartupValidator` отдаёт несколько ошибок.

Валидация при старте - самая дешёвая работа по надёжности, доступная в .NET-приложении. Это один вызов метода на builder, который у вас уже есть, и он превращает целую категорию инцидентов в продакшене, неверно сконфигурированное развёртывание, в сбой запуска, с которым ваш процесс выкатки уже умеет работать.

## Связанные материалы

- [IOptions&lt;T&gt; vs IOptionsSnapshot&lt;T&gt; vs IOptionsMonitor&lt;T&gt; в .NET 11](/ru/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) помогает выбрать правильный аксессор до того, как вы его валидируете.
- [Fix: Cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) разбирает ошибку захваченной зависимости, на которую вы наткнётесь, если валидатор принимает scoped-зависимость.
- [Fix: No connection string named 'DefaultConnection' could be found](/ru/2026/05/fix-no-connection-string-named-defaultconnection/) - классический сбой ленивой конфигурации, который предотвращает валидация при старте.
- [Что такое генератор исходного кода и когда он мне нужен?](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) объясняет, что `[OptionsValidator]` делает на этапе компиляции.
- [Что такое контракт IHostedService и когда его использовать?](/ru/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) показывает, что выполняется сразу после успешной валидации.

## Источники

- [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options) на MS Learn - про `ValidateOnStart`, `AddOptionsWithValidateOnStart` и атрибуты рекурсивной валидации.
- [Compile-time options validation source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/options-validation-generator) - про `[OptionsValidator]` и генерируемый вывод.
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries) - про перегрузку `Validate<TValidator>()` и асинхронную валидацию DataAnnotations.
- [`OptionsBuilderExtensions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) и [`IAsyncValidateOptions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/IAsyncValidateOptions.cs) в dotnet/runtime.
- [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034), `ValidateOnStart()` does not work in Azure Functions.
