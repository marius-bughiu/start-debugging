---
title: "Как регистрировать и разрешать сервисы с ключом во внедрении зависимостей .NET 11"
description: "Зарегистрируйте несколько реализаций одного типа сервиса под ключом с помощью AddKeyedSingleton/Scoped/Transient, а затем разрешите их через [FromKeyedServices], GetRequiredKeyedService или KeyedService.AnyKey. Регистрации с ключом и без ключа находятся в раздельных таблицах, и именно это сбивает с толку почти всех."
pubDate: 2026-06-23
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dependency-injection"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection"
translatedBy: "claude"
translationDate: 2026-06-23
---

Встроенный в .NET контейнер внедрения зависимостей может хранить несколько реализаций одного типа сервиса и различать их по ключу. Каждую вы регистрируете через `AddKeyedSingleton`, `AddKeyedScoped` или `AddKeyedTransient`, передавая ключ типа `object` (обычно это строка или enum), а конкретную извлекаете через `[FromKeyedServices("key")]` на параметре конструктора или обработчика либо через `provider.GetRequiredKeyedService<T>("key")`. Единственный факт, на котором спотыкаются все: регистрации с ключом и без ключа живут в двух раздельных таблицах. Обычный `GetService<T>()` никогда не увидит регистрацию с ключом, а `[FromKeyedServices]` никогда не увидит регистрацию без ключа. Это руководство написано для .NET 11 (на момент написания preview 5, общая доступность запланирована на ноябрь 2026 года) и `Microsoft.Extensions.DependencyInjection` 11.0.0. Сервисы с ключом появились в .NET 8, и API с тех пор стабилен, поэтому все приёмы здесь без изменений работают и на .NET 8, и на .NET 10.

## Зачем давать сервису ключ вместо создания нового интерфейса

Старый способ зарегистрировать две реализации `IPaymentGateway` состоял в том, чтобы придумать два интерфейса (`IStripeGateway`, `IPayPalGateway`) или зарегистрировать фабричный делегат, выбиравший по строке. Оба подхода просачивают механизм выбора в вашу систему типов. Сервисы с ключом оставляют интерфейс в единственном числе и переносят дискриминатор в регистрацию, то есть именно туда, где и должно находиться решение, принимаемое во время развёртывания или конфигурации.

Канонические случаи:

- **Несколько провайдеров за одним контрактом.** Два платёжных шлюза, три канала уведомлений, основной и резервный HTTP-клиент, каждый зарегистрирован под ключом и выбирается в точке вызова.
- **Именованные кеши или соединения.** Короткоживущий и долгоживущий кеш, оба в форме `IMemoryCache`, с ключами `"short"` и `"long"`.
- **Поиск стратегии во время выполнения.** Словарь стратегий, где ключ вычисляется из запроса, разрешаемый через `IKeyedServiceProvider` вместо написанного вручную `switch`.

Если реализация у вас всегда одна, не прибегайте к ключу. Регистрация с ключом добавляет дискриминатор, который затем приходится держать синхронным между местом регистрации и каждым местом разрешения. Используйте её, когда множественность реальна.

## Регистрация сервисов с ключом

У каждого метода регистрации без ключа есть близнец с ключом, принимающий `serviceKey` в качестве первого аргумента. Вот вся поверхность в одном блоке.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Two implementations of the same interface, told apart by a string key.
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");

// Lifetimes work exactly as their non-keyed counterparts.
builder.Services.AddKeyedScoped<IReportBuilder, PdfReportBuilder>("pdf");
builder.Services.AddKeyedTransient<IReportBuilder, CsvReportBuilder>("csv");

// A factory overload gives you the key and the provider, useful when the
// implementation needs to read its own key or build from config.
builder.Services.AddKeyedSingleton<IClock>("utc", (sp, key) => new SystemClock(DateTimeKind.Utc));

var app = builder.Build();
```

Ключ имеет тип `object` и сравнивается через `Equals`. Строки выбирают чаще, потому что они переживают полный цикл через `appsettings.json`, но enum чище, когда множество замкнуто и известно во время компиляции:

```csharp
// .NET 11, C# 14 - enum keys avoid stringly-typed lookups
public enum Channel { Email, Sms, Push }

builder.Services.AddKeyedScoped<INotifier, EmailNotifier>(Channel.Email);
builder.Services.AddKeyedScoped<INotifier, SmsNotifier>(Channel.Sms);
builder.Services.AddKeyedScoped<INotifier, PushNotifier>(Channel.Push);
```

Вы можете зарегистрировать один и тот же тип реализации под несколькими ключами и можете зарегистрировать более одной реализации под **одним** ключом. Второй случай превращается в разрешение `IEnumerable<T>`, рассмотренное ниже.

## Три способа разрешить сервис с ключом

### Внедрение через конструктор с `[FromKeyedServices]`

Атрибут находится в `Microsoft.Extensions.DependencyInjection` и помечает один параметр конструктора, чтобы контейнер разрешил его из таблицы с ключом. Это та форма, которую вы хотите в обычных сервисах и контроллерах, потому что она оставляет потребителя свободным от любой ссылки на `IServiceProvider`.

```csharp
// .NET 11, C# 14
public sealed class CheckoutService(
    [FromKeyedServices("stripe")] IPaymentGateway gateway)
{
    public Task<string> ChargeAsync(decimal amount) => gateway.ChargeAsync(amount);
}
```

Тот же атрибут работает на параметре обработчика minimal API, что является самым чистым способом привязать зависимость с ключом к endpoint:

```csharp
// .NET 11, C# 14 - keyed dependency straight into a minimal API handler
app.MapPost("/charge/{provider}",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));
```

Он также работает на параметре action MVC-контроллера и на параметре конструктора контроллера, в обоих случаях без какой-либо дополнительной регистрации.

### Императивное разрешение через `GetRequiredKeyedService`

Когда ключ известен только во время выполнения (вычислен из запроса, прочитан из конфигурации), атрибут времени компиляции использовать нельзя. Внедрите `IServiceProvider` и вызовите методы-расширения с ключом. Провайдер, создаваемый `Build()`, реализует `IKeyedServiceProvider`, поэтому они всегда работают с контейнером по умолчанию.

```csharp
// .NET 11, C# 14 - the key is decided at runtime
public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string providerKey, decimal amount)
    {
        // Throws InvalidOperationException if nothing is registered under the key.
        var gateway = services.GetRequiredKeyedService<IPaymentGateway>(providerKey);
        return gateway.ChargeAsync(amount);
    }
}
```

Используйте `GetKeyedService<T>(key)` (без "Required"), когда отсутствие регистрации является нормальным, а не исключительным исходом; он возвращает `null` вместо выбрасывания исключения. Внутри scoped-потребителя разрешайте из scoped-провайдера, чтобы scoped-экземпляр с ключом имел правильную область. Если вы прибегаете к области внутри синглтона вроде `BackgroundService`, действует та же дисциплина `IServiceScopeFactory`, что и для любого [scoped-сервиса внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): то, что регистрация имеет ключ, не меняет правил времени жизни.

### Разрешение всех реализаций под одним ключом

Зарегистрируйте более одной реализации под одним ключом и разрешите их как набор:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IValidationRule, NotEmptyRule>("order");
builder.Services.AddKeyedSingleton<IValidationRule, PositiveAmountRule>("order");

public sealed class OrderValidator(
    [FromKeyedServices("order")] IEnumerable<IValidationRule> rules)
{
    public bool IsValid(Order o) => rules.All(r => r.Check(o));
}
```

`GetKeyedServices<IValidationRule>("order")` является императивным эквивалентом и возвращает обе реализации в порядке регистрации.

## Совпадение с любым ключом через `KeyedService.AnyKey`

Иногда нужна одна регистрация, отвечающая за *каждый* ключ, при этом реализация читает ключ, под которым её разрешили. Для этого и существует `KeyedService.AnyKey`. Сочетайте его с параметром `[ServiceKey]`, чтобы реализация получала реальный ключ во время конструирования.

```csharp
// .NET 11, C# 14 - one registration that serves any key
builder.Services.AddKeyedSingleton<ITenantStore>(
    KeyedService.AnyKey,
    (sp, key) => new TenantStore((string)key!));

public sealed class TenantStore : ITenantStore
{
    public TenantStore(string tenantId) => TenantId = tenantId;
    public string TenantId { get; }
}

// A consumer can ask for any tenant; the key flows into the factory.
var acme = app.Services.GetRequiredKeyedService<ITenantStore>("acme");
var globex = app.Services.GetRequiredKeyedService<ITenantStore>("globex");
```

Атрибут `[ServiceKey]` на параметре конструктора работает и без фабричной перегрузки. Контейнер внедряет ключ, который был использован для разрешения экземпляра:

```csharp
// .NET 11, C# 14 - the implementation discovers its own key
public sealed class TenantStore(
    [ServiceKey] string tenantId,
    AppDbContext db) : ITenantStore
{
    public string TenantId => tenantId;
}

builder.Services.AddKeyedScoped<ITenantStore, TenantStore>(KeyedService.AnyKey);
```

Поведением `AnyKey` управляют два правила. Первое: регистрация с точным ключом выигрывает у регистрации `AnyKey`, когда существуют обе. Второе: вы не можете *разрешать* с `KeyedService.AnyKey` в качестве ключа; это сигнальное значение только на стороне регистрации. Запрос `GetRequiredKeyedService<T>(KeyedService.AnyKey)` выбрасывает исключение.

## Разделение, вызывающее больше всего путаницы

Регистрации с ключом и без ключа являются двумя различными таблицами внутри контейнера. Этот единственный факт объясняет почти все сообщения об ошибках вида «но я же его зарегистрировал»:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");

var sp = builder.Services.BuildServiceProvider();

sp.GetService<IPaymentGateway>();                 // null - no NON-keyed registration
sp.GetKeyedService<IPaymentGateway>("stripe");    // the StripeGateway
sp.GetKeyedService<IPaymentGateway>("paypal");    // null - nothing under that key
```

Обычный параметр конструктора `IPaymentGateway gateway` (без атрибута) разрешается только из таблицы без ключа и не найдёт регистрацию с ключом. Если вы хотите, чтобы сервис был доступен обоими способами, зарегистрируйте его дважды, один раз с ключом и один раз без. Обратная ловушка столь же распространена: `[FromKeyedServices("stripe")]` против сервиса, зарегистрированного обычным `AddSingleton`, не разрешается ни во что, потому что атрибут читает только таблицу с ключом.

Это разделение также является причиной того, что `GetServices<T>()` (перечисление без ключа) не включает регистрации с ключом. Если вы полагаетесь на перечисление «всех реализаций», заранее решите, есть ли у них ключ, и сохраняйте последовательность.

## Детали, которые стоит знать перед выпуском

**`ActivatorUtilities.CreateInstance` учитывает `[FromKeyedServices]`, но только для типов, которые он активирует.** Тип, созданный контейнером (или `ActivatorUtilities`), получает свои параметры с ключом заполненными. Тип, который вы создаёте сами через `new`, не получает ничего внедрённого, ни с ключом, ни без. Это важно для фабричного кода и для всего за пределами графа DI.

**`Equals` и `GetHashCode` ключа должны быть стабильными.** Строки и enum-ы подходят. Изменяемый ссылочный тип в роли ключа или ключ с равенством по значению, меняющимся со временем, молча не совпадёт. Предпочитайте неизменяемые ключи.

**Внедрение через `ServiceKey` требует правильного типа.** Если вы регистрируете под ключом `string`, а объявляете `[ServiceKey] int id`, конструирование выбросит исключение во время разрешения. Держите объявленный тип параметра присваиваемым из ключа, с которым вы регистрировали.

**Валидация выполняется на регистрацию, а не на ключ.** Когда `ValidateOnBuild` включена (по умолчанию в `Development` под `WebApplication.CreateBuilder`), валидатор мест вызова проверяет граф каждой регистрации с ключом так же, как и без ключа. Scoped-сервис с ключом, захваченный синглтоном, по-прежнему выбрасывает `Cannot consume scoped service from singleton`; наличие ключа не освобождает вас от правил времени жизни. Если вы столкнётесь со сбоем разрешения, сообщение читается так же, как и в случае без ключа, и [исправление unable to resolve service while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) разбирает, как его читать; только помните, что таблица с ключом раздельна, когда проверяете, существует ли регистрация.

**Native AOT и trimming поддерживаются.** Сервисы с ключом спроектированы дружественными к AOT: разрешение не опирается на рефлексию во время выполнения над вашими типами, поэтому они переживают trimming без дополнительных аннотаций `DynamicallyAccessedMembers`. Если вы взвешиваете модель развёртывания, компромиссы из [Native AOT vs ReadyToRun vs JIT](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) применимы без изменений и с регистрациями с ключом в графе.

**Не каждый сторонний контейнер поддерживает ключи.** Встроенный контейнер поддерживает. Если вы подключили старую версию Autofac, Lamar или DryIoc, подтвердите её мост для сервисов с ключом, прежде чем полагаться на `[FromKeyedServices]`; эта возможность является контрактом `Microsoft.Extensions.DependencyInjection.Abstractions`, который каждый контейнер должен реализовать.

## Полный проработанный пример

Вот форма от начала до конца: два шлюза с ключом по имени, маршрутизатор, выбирающий один во время выполнения по маршруту, и шлюз по умолчанию, внедряемый прямо в обработчик.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");
builder.Services.AddScoped<PaymentRouter>();

var app = builder.Build();

// Runtime selection: the provider name comes from the URL.
app.MapPost("/charge/{provider}",
    (string provider, decimal amount, PaymentRouter router)
        => router.ChargeAsync(provider, amount));

// Compile-time selection: this endpoint always uses Stripe.
app.MapPost("/charge-stripe",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));

app.Run();

public interface IPaymentGateway { Task<string> ChargeAsync(decimal amount); }

public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string key, decimal amount)
    {
        var gateway = services.GetKeyedService<IPaymentGateway>(key)
            ?? throw new ArgumentException($"Unknown gateway '{key}'", nameof(key));
        return gateway.ChargeAsync(amount);
    }
}
```

Разделение намеренно: endpoint `/charge/{provider}` нуждается в `IServiceProvider`, потому что ключ является данными, тогда как `/charge-stripe` использует атрибут, потому что ключ является константой. Прибегайте к `[FromKeyedServices]`, когда ключ известен во время компиляции, и возвращайтесь к `GetKeyedService`/`GetRequiredKeyedService` только тогда, когда он действительно неизвестен.

## Где сервисы с ключом уместны дальше

DI с ключом является правильным инструментом, когда у одного контракта есть несколько реальных реализаций, выбираемых по конфигурации или на запрос. Это неправильный инструмент для единственной реализации, для сквозных задач, которые лучше решает паттерн options, или для логики выбора, достаточно сложной, чтобы заслужить собственную фабричную абстракцию. Когда вы к нему прибегаете, держите ключи неизменяемыми, регистрируйте по одному разу на каждый предполагаемый путь разрешения и помните, что таблицы с ключом и без ключа никогда не видят друг друга.

Для смежных паттернов: решение о том, откуда endpoint-ы берут свои зависимости, является частью более широкого выбора [minimal API против контроллеров](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), а регистрация с ключом хорошо сочетается с [HybridCache в ASP.NET Core 11](/ru/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/), когда вам нужны именованные экземпляры кеша за одним интерфейсом.

## Источники

- [Dependency injection in .NET - keyed services](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services), MS Learn.
- [`ServiceCollectionServiceExtensions` keyed methods](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicecollectionserviceextensions), справочник API .NET.
- [`FromKeyedServicesAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.fromkeyedservicesattribute) и [`ServiceKeyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicekeyattribute), справочник API .NET.
- [`IKeyedServiceProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.ikeyedserviceprovider) и [`KeyedService.AnyKey`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.keyedservice.anykey), справочник API .NET.
