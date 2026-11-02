---
title: "MediatR против простых сервисных классов в 2026: должна ли смена лицензии вас сдвинуть?"
description: "Сравнение диспетчеризации и конвейера MediatR с прямым вызовом служб: проверка DI, условия лицензии и измерение производительности."
pubDate: 2026-05-23
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/mediatr-vs-plain-service-classes-in-2026"
translatedBy: "claude"
translationDate: 2026-05-23
---

Если у каждого запроса есть очевидный получатель, подойдёт прямой вызов службы. MediatR полезнее, когда несколько типов запросов используют общий конвейер или уведомления получают несколько обработчиков. Отдельно проверьте условия лицензии используемой версии.

**Исправление — 2 ноября 2026 г.:** исправлены сведения о проверке DI и лицензировании, убраны неподтверждённые оценки времени диспетчеризации и выделений памяти.

Примеры ориентированы на `net11.0` и показывают контракты MediatR 13/14. Описанная ниже проверка DI выполнена на .NET 10.

## Что на самом деле изменилось в июле 2025

MediatR 12.5.0 распространялся под Apache 2.0. В июле 2025 года автор объявил о вариантах RPL-1.5 и коммерческой лицензии начиная с версии 13.0.0. На ранние версии распространяются их исходные условия.

[Критерии Community от Lucky Penny Software](https://luckypennysoftware.com/faq) включают годовую валовую выручку или бюджет некоммерческой организации менее 5 млн долларов США и не более 10 млн долларов внешнего капитала. Поставщик также оговаривает условия для государственных и квазигосударственных организаций, использования в вузах и работы для клиентов. Проверьте условия для своей организации и задачи.

## Матрица возможностей с первого взгляда

| Аспект | MediatR 13+ | Простые сервисные классы |
| ------ | ----------- | ------------------------ |
| Диспетчеризация запросов | Косвенность через `ISender.Send` | Прямой вызов метода внедрённого интерфейса |
| Сквозная функциональность | `IPipelineBehavior<,>` как первоклассный механизм | Декораторы (Scrutor) или явные вызовы |
| Проверка DI | Зависит от регистраций и параметров провайдера | Зависит от регистраций и параметров провайдера |
| Уведомления / fan-out | Встроенная публикация `INotification` | Список handler-ов, написанный вручную |

Основное различие в архитектуре — конвейер: многие запросы получают общее место для валидации, журналирования, транзакций или кеширования.

## Как выглядит MediatR и простой эквивалент

Вот каноническая форма MediatR: запрос, handler и вызывающий код, который диспетчеризует через `ISender`.

```csharp
// .NET 11, C# 14, MediatR 13+ - request + handler
using MediatR;

public record GetOrderById(int OrderId) : IRequest<OrderDto>;

public sealed class GetOrderByIdHandler(AppDbContext db)
    : IRequestHandler<GetOrderById, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderById request, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([request.OrderId], ct)
            ?? throw new OrderNotFoundException(request.OrderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);
```

Простая версия сворачивает запрос и handler в один метод внедрённого сервиса. Вызывающий код зависит напрямую от интерфейса.

```csharp
// .NET 11, C# 14 - plain service class, no MediatR
public interface IOrderService
{
    Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct);
}

public sealed class OrderService(AppDbContext db) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([orderId], ct)
            ?? throw new OrderNotFoundException(orderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

При вызове через интерфейс переход к определению ведёт к методу интерфейса, а IDE помогает найти его реализации. Для `Send` ищите обработчик типа запроса.

`AddScoped` регистрирует службу. Если для встроенного провайдера включён `ValidateOnBuild`, при построении хоста может обнаружиться незарегистрированная зависимость конструктора зарегистрированной службы. Если проверка выключена, хост может собраться, а ошибка возникнет при разрешении службы. [Настройки проверки ASP.NET Core по умолчанию](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild) зависят от среды. `ValidateScopes` отдельно проверяет время жизни служб.

При проверке для этой правки в .NET 10 была зарегистрирована scoped-служба с отсутствующей зависимостью конструктора. С настройками по умолчанию Development завершился ошибкой при `Build()`, а Production — при разрешении службы. Явная настройка `ValidateOnBuild` меняла момент ошибки.

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicitly register the scoped service
builder.Services.AddScoped<IOrderService, OrderService>();
```

## Pipeline behavior и как жить без него

Вот где MediatR оправдывает своё место. Pipeline behavior оборачивает каждый запрос, что даёт вам ровно одно место для добавления валидации, журналирования, измерения времени или транзакции.

```csharp
// .NET 11, C# 14, MediatR 13+ - cross-cutting validation for ALL requests
using MediatR;

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        foreach (var validator in validators)
            await validator.ValidateAndThrowAsync(request, ct);
        return await next(ct);
    }
}
```

Зарегистрированный один раз, этот behavior выполняется перед каждым handler-ом. Заменить это скопированными и вставленными вызовами валидации в каждом простом сервисе было бы регрессом, и это лучший аргумент, чтобы сохранить медиатор. Но вы можете получить то же свойство "обернуть всё" в простом DI с помощью паттерна декоратора, используя Scrutor (под лицензией MIT) для регистрации декоратора вокруг интерфейса:

```csharp
// .NET 11, C# 14, Scrutor 6.x - a decorator gives you the same cross-cutting hook
public sealed class LoggingOrderService(
    IOrderService inner,
    ILogger<LoggingOrderService> logger) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        logger.LogInformation("Fetching order {OrderId}", orderId);
        return await inner.GetByIdAsync(orderId, ct);
    }
}

// Registration: decorate the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

Компромисс честен: behavior MediatR универсален для каждого запроса при одной регистрации, тогда как декоратор действует на отдельный интерфейс. Если у вас одна-две сквозные функции и горстка сервисных интерфейсов, декораторы выигрывают в ясности. Если у вас десять behaviors, которые должны единообразно применяться к двумстам типам запросов, универсальный конвейер MediatR действительно требует меньше кода, и это тот сценарий, в котором остаться (и платить или квалифицироваться для Community) оправданно. Для запросных функций, которые на самом деле являются функциями HTTP, учтите, что часть того, что люди помещают в behaviors, относится к middleware или фильтрам, к той же области, что охватывает [добавление глобального фильтра исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Сколько на самом деле стоит диспетчеризация

`Send` разрешает обработчик и выполняет настроенный конвейер. Прямой вызов использует внедрённую службу. Сопоставимого замера для этих путей в статье нет, поэтому время и число выделений памяти на вызов не приводятся.

Если стоимость диспетчеризации влияет на выбор, сравните пути с одинаковой работой обработчика, временем жизни, средой выполнения и цепочкой behaviors. Регистрацию и холодный старт измеряйте отдельно. Явная регистрация позволяет обойтись без поиска обработчиков в сборке. Проверьте trimming и Native AOT на опубликованном приложении.

## Деталь, которая решает за вас

Несколько ограничений улаживают этот вопрос ещё до того, как в дело вступает архитектурный вкус.

Приложение, закреплённое на 12.5.0, остаётся на этой версии и её условиях. Прежде чем закреплять версию надолго, оцените потребности в обслуживании.

**Если вы только когда-либо вызываете `Send`, медиатор вам не нужен.** Честная проверка: откройте своё решение и поищите `IPipelineBehavior` и `INotification`. Если behaviors ноль и вы не публикуете уведомления, MediatR работает как слой косвенности поверх вызовов методов, и его удаление - механический рефакторинг, который делает код более навигируемым, убирает зависимость и стирает вопрос лицензии одним движением. Это тот же инстинкт рационализации библиотек, что стоит за выбором встроенного варианта в [System.Text.Json против Newtonsoft.Json в 2026](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## Решение, в одну строку

Для прямого вызова службы подходит явное внедрение зависимостей. Сохраните MediatR, если нескольким типам запросов полезны общий конвейер или уведомления. Если выбраны службы, используйте [пошаговое руководство по миграции](/ru/2026/05/migrate-from-mediatr-to-plain-dependency-injection/).

## Связанное

- [Minimal APIs vs controllers in ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json против Newtonsoft.Json в 2026](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Источники

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - объявление о выпуске от 2025-07-02, граница v13.0 и двойная модель RPL-1.5 / коммерческая.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - пороги Community в 5 000 000 дохода и 10 000 000 капитала, подсчёт разработчиков по "программному доступу" и проверка лицензии только в журнал.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - подтверждение, что старые версии остаются под своей первоначальной лицензией с открытым исходным кодом.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - первый выпуск с двойной лицензией.
- [Scrutor на GitHub](https://github.com/khellang/Scrutor) - расширение `Decorate` под лицензией MIT, используемое для замены pipeline behaviors декораторами.
