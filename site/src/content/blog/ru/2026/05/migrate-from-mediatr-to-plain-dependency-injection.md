---
title: "Переход с MediatR на простое внедрение зависимостей в .NET 11"
description: "Пошаговый чек-лист для удаления MediatR 12-14 и замены обработчиков IRequest, ISender, pipeline behaviors и INotification на простые классы-сервисы и внедрение через конструктор."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "mediatr"
  - "dependency-injection"
  - "dotnet"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/migrate-from-mediatr-to-plain-dependency-injection"
translatedBy: "claude"
translationDate: 2026-05-30
---

Удаление MediatR из кодовой базы на .NET 11 -- это механический рефакторинг, а не переписывание. Для типичного сервиса с 50-150 обработчиками заложите от половины дня до дня: большинство обработчиков один к одному сворачиваются в методы простых классов-сервисов, вызовы `ISender.Send` превращаются в прямые вызовы интерфейса, и единственная часть, требующая проектного осмысления, -- это конвейер. Ломается всё, что опиралось на разрешение обработчиков в runtime или на обёртывание каждого запроса через `IPipelineBehavior<,>`; это становится внедрением через конструктор и декораторами. Это стоит делать, если вы только вызываете `Send`, если вы выше границы выручки в $5,000,000 редакции Community у MediatR и не хотите покупать коммерческую лицензию, или если вам нужны Native AOT и совместимость с trimming. Это не стоит делать, если ваши pipeline behaviors несут нагрузку на сотнях типов запросов.

Упомянутые версии: это руководство охватывает удаление MediatR 12.5.0 (последний выпуск под лицензией Apache 2.0), 13.0 (выпущен 2025-07-02, первый выпуск под двойной моделью Reciprocal Public License 1.5 / коммерческая от Lucky Penny Software) и текущую линейку 14.x. Замещающий код нацелен на `<TargetFramework>net11.0</TargetFramework>` с SDK .NET 11 и C# 14, плюс Scrutor 6.x для декораторов. Если вы ещё решаете, *стоит ли* уходить, сначала прочитайте [MediatR против простых классов-сервисов в 2026](/ru/2026/05/mediatr-vs-plain-service-classes-in-2026/); эта статья предполагает, что решение уже принято.

## Почему команды удаляют MediatR именно сейчас

- **Лицензия вынуждает принять решение выше $5M.** Бесплатное open-source использование MediatR 13+ -- под RPL-1.5, реципрокной copyleft-лицензией, призванной закрыть лазейку SaaS. Если вы поставляете коммерческое ПО с закрытым исходным кодом выше порога выручки редакции Community, эта лицензия для вас непригодна, так что выбор -- купить или уйти.
- **Переход к определению ведёт к обработчику, а не к `Send`.** Прямые вызовы интерфейса возвращают навигируемость, которую косвенность медиатора отнимает при каждом переходе.
- **Запуск дешевеет, а AOT упрощается.** Удаление сканирования сборок для регистрации обработчиков срезает миллисекунды холодного старта и устраняет рефлексию, которая борется с trimming, что важно при [сокращении времени холодного старта AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).
- **Связывание падает при запуске, а не на первом запросе.** Явная регистрация `AddScoped` превращает отсутствующую зависимость в ошибку времени запуска вместо `InvalidOperationException` в runtime.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Внедрение `ISender` / `IMediator` | Заменяется на конкретный интерфейс сервиса, внедряемый напрямую | высокая |
| `IRequest<T>` + `IRequestHandler<,>` | Сворачиваются в один интерфейс + метод реализации | высокая |
| `IPipelineBehavior<,>` | Нет обобщённой точки обёртывания; заменяется по интерфейсу декораторами или middleware | высокая |
| `INotification` + `INotificationHandler<>` | Заменяется внедрённым `IEnumerable<IHandler>` для fan-out или агрегатором событий | средняя |
| Регистрация `AddMediatR(...)` | Заменяется явными вызовами `AddScoped` (или одним сканированием Scrutor) | средняя |
| `RequestHandlerDelegate<T>` в behaviors | Нет эквивалента; цепочка "next" исчезает | средняя |
| `ISender.CreateStream` (`IStreamRequest`) | Заменяется методом, возвращающим `IAsyncEnumerable<T>` | низкая |
| Модульные тесты, мокающие `ISender` | Перенаправляются на мок конкретного интерфейса | низкая |

## Предварительный чек-лист

- SDK .NET 11 установлен: подтвердите с помощью `dotnet --version` (ожидайте `11.x`).
- У вас есть чистая ветка git и зелёный набор тестов *до* начала. Проверьте с помощью `dotnet test` и подтвердите ноль провалов.
- Инвентаризируйте затронутую поверхность. Выполните поиск и запишите количества, потому что они говорят о размере работы:

```bash
# .NET 11 - inventory MediatR usage before touching anything
grep -rn "IRequestHandler\|IRequest<\|: IRequest" src/      # handlers + requests
grep -rn "IPipelineBehavior" src/                            # the hard part
grep -rn "INotification" src/                                # fan-out
grep -rn "ISender\|IMediator\|\.Send(\|\.Publish(" src/      # call sites
```

- Решите форму замены behaviors *в первую очередь*. Если у вас ноль совпадений `IPipelineBehavior`, это чистая замена найти-и-заменить. Если у вас их несколько, спланируйте, станет ли каждый декоратором, middleware ASP.NET Core или фильтром endpoint.
- Добавьте Scrutor, если будете использовать декораторы: `dotnet add package Scrutor` (6.x, под лицензией MIT).

## Шаги миграции

1. **Преобразуйте каждый запрос и обработчик в интерфейс сервиса и метод.**

Запрос MediatR -- это тип сообщения плюс отдельный обработчик. Замените оба одним интерфейсом и одной реализацией. Группируйте связанные запросы в один сервис, вместо того чтобы создавать по интерфейсу на каждый старый запрос.

```csharp
// .NET 11, C# 14, MediatR 14.x - BEFORE
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
```

```csharp
// .NET 11, C# 14 - AFTER: plain service, no MediatR reference
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
```

**Проверьте:** в новом файле нет `using MediatR;`, а тело обработчика побайтово идентично, не считая сигнатуры метода. Параметры `record` запроса становятся параметрами метода в том же порядке.

2. **Замените места вызова `ISender.Send` прямыми вызовами интерфейса.**

Каждый вызывающий код, который внедрял `ISender` или `IMediator`, теперь внедряет конкретный интерфейс сервиса и вызывает метод.

```csharp
// .NET 11, C# 14 - BEFORE
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);

// AFTER
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

**Проверьте:** после этого шага `grep -rn "ISender\|IMediator" src/` возвращает только строки, которые вы намеренно ещё не мигрировали. Счётчик должен двигаться к нулю.

3. **Зарегистрируйте сервисы явно.**

Удалите `AddMediatR(...)` и зарегистрируйте каждый сервис. Явная регистрация безопасна для trimming и падает быстро при запуске, что и есть тот режим отказа, который стоит за [Unable to resolve service for type while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

Если вам нужна регистрация по соглашению без рефлексионной модели MediatR, Scrutor сканирует по имени интерфейса:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

**Проверьте:** приложение запускается. Запустите его и обратитесь к мигрированному endpoint; отсутствующая регистрация теперь падает при запуске, а не на первом запросе. Убедитесь, что не закрались ошибки scoped-из-singleton -- класс багов, разобранный в [Cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

4. **Замените pipeline behaviors декораторами или middleware.**

Это единственный шаг, требующий рассуждения. `IPipelineBehavior<,>` обёртывал каждый запрос в одном месте. У вас есть две честные замены.

Для сквозных задач, которые действительно относятся к отдельному сервису (журналирование, кеширование, повторы), используйте декоратор Scrutor:

```csharp
// .NET 11, C# 14, Scrutor 6.x - BEFORE was a generic ValidationBehavior<TRequest,TResponse>
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

// Registration: wrap the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

Для задач, которые на самом деле относятся к HTTP (журналирование запросов, отображение исключений в ProblemDetails, аутентификация), полностью вынесите их из слоя приложения в middleware ASP.NET Core или фильтр endpoint. Behavior, который перехватывал исключения и формировал ответы, относится к тому же месту, что и [глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/), а не к декоратору.

Если вы использовали FluentValidation внутри `ValidationBehavior`, сохраните валидаторы и вызывайте их из одного декоратора или из фильтра endpoint minimal API:

```csharp
// .NET 11, C# 14 - a validation decorator replacing ValidationBehavior for one interface
public sealed class ValidatingOrderService(
    IOrderService inner,
    IValidator<CreateOrder> validator) : IOrderService
{
    public async Task<OrderDto> CreateAsync(CreateOrder cmd, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(cmd, ct);
        return await inner.CreateAsync(cmd, ct);
    }

    public Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
        => inner.GetByIdAsync(orderId, ct);
}
```

**Проверьте:** напишите или сохраните тест, утверждающий, что сквозная задача по-прежнему выполняется, например что недопустимая команда бросает `ValidationException` до обращения к базе данных. Выполните `dotnet test` и подтвердите, что тесты behavior проходят.

5. **Замените fan-out `INotification`.**

`Publish` у MediatR вызывал каждый `INotificationHandler<T>`. Замените его внедрённым `IEnumerable<T>` небольшого интерфейса обработчика, который вы определяете, и тонким издателем.

```csharp
// .NET 11, C# 14 - BEFORE: INotification + handlers, AFTER: explicit fan-out
public interface IOrderPlacedHandler
{
    Task HandleAsync(OrderPlaced evt, CancellationToken ct);
}

public sealed class OrderEventPublisher(IEnumerable<IOrderPlacedHandler> handlers)
{
    public async Task PublishAsync(OrderPlaced evt, CancellationToken ct)
    {
        foreach (var handler in handlers)
            await handler.HandleAsync(evt, ct);
    }
}

// Registration - each handler registered against the interface
builder.Services.AddScoped<IOrderPlacedHandler, SendConfirmationEmail>();
builder.Services.AddScoped<IOrderPlacedHandler, UpdateInventory>();
builder.Services.AddScoped<OrderEventPublisher>();
```

Контейнер передаёт вам каждый зарегистрированный обработчик в `IEnumerable<IOrderPlacedHandler>`, так что добавление обработчика -- одна строка регистрации, та же эргономика, что давал MediatR. Если вы публикуете много типов событий, сгенерируйте издателя с обобщённым `IEventPublisher<T>` вместо одного на каждое событие.

**Проверьте:** утвердите, что публикация события вызывает все зарегистрированные обработчики. Достаточно теста с двумя фейковыми обработчиками, каждый из которых записывает вызов.

6. **Удалите пакет и последние ссылки.**

Когда места вызова исчезли, уберите зависимость.

```bash
# .NET 11 - remove the package from every project that referenced it
dotnet remove package MediatR
grep -rn "MediatR" src/ || echo "clean"
```

**Проверьте:** `grep -rn "MediatR" src/` печатает `clean`. В сборке нет неразрешённого `using MediatR;`, и `dotnet build -c Release` завершается успешно без предупреждений об отсутствующем пакете.

## Проверка: дымовой тест после миграции

Пройдите этот список сверху вниз и не пропускайте строку о производительности:

- `dotnet build -c Release` завершается успешно без предупреждений.
- `dotnet test` проходит с нулём провалов, включая тесты behavior и fan-out, которые вы добавили на шагах 4 и 5.
- Приложение запускается, и каждый endpoint, ранее диспетчеризовавшийся через MediatR, возвращает тот же ответ, что и прежде. Отсутствующая регистрация теперь всплывает здесь, при запуске.
- `grep -rn "MediatR" src/` ничего не возвращает.
- В журналах не появляется предупреждение о лицензии (проверка лицензии MediatR 13+ записывала предупреждение при незарегистрированном ключе; теперь оно должно исчезнуть).
- Холодный старт такой же или лучше. Если приложение serverless, измерьте время запуска до и после; удаление сканирования сборок не должно его ухудшить.

## План отката

Эта миграция обратима покоммитно, но утомительна для отката целиком, поэтому делайте её поэтапно. Держите каждый из шести шагов отдельным коммитом и мигрируйте по одному вертикальному срезу за раз (один интерфейс сервиса и его вызывающий код), а не всё решение сразу. MediatR и простые сервисы могут сосуществовать во время перехода: оставьте `AddMediatR` зарегистрированным для немигрированных обработчиков, пока переводите остальное. Если срез ведёт себя неправильно, откатите коммиты этого среза, и остальное приложение не пострадает. Здесь нет изменений данных или схемы, так что откат -- это чисто откат кода без миграции, которую нужно отменять.

## Подводные камни, на которые мы наткнулись

**Порядок `IPipelineBehavior` не отображается на декораторы напрямую.** MediatR выполняет behaviors в порядке регистрации вокруг одного обработчика. Декораторы Scrutor вкладываются в порядке вызова `Decorate`, и *последний* зарегистрированный декоратор -- *самая внешняя* обёртка. Ошибитесь в порядке -- и ваш декоратор журналирования выполнится внутри декоратора валидации, а не вокруг него. Напишите по тесту порядка на каждый декорированный интерфейс.

**`ISender` внутри обработчика, вызывающего другой обработчик, становится прямым вызовом сервиса, и это может вскрыть цикл.** Косвенность MediatR скрывала зависимости между обработчиками. Когда `OrderService` внедряет `ICustomerService`, а `CustomerService` внедряет `IOrderService`, контейнер падает при запуске с циклической зависимостью. Это миграция выносит на поверхность проблему проектирования, которую MediatR маскировал; разорвите цикл, вынеся общую логику в третий сервис.

**Потоковые запросы требуют `IAsyncEnumerable<T>`, а не `Task<T>`.** Если вы использовали `IStreamRequest<T>` и `CreateStream`, замещающий метод возвращает `IAsyncEnumerable<T>` и использует `yield return`. Не сворачивайте его в `Task<List<T>>`; это меняет семантику потоковой передачи и может исчерпать память на больших результатах -- та же ловушка, что описана в [чтении большого CSV в .NET 11 без нехватки памяти](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

**Тесты, мокавшие `ISender`, молча проходят впустую.** Тест, который настраивал `sender.Send(...)` на возврат значения, выдаст ошибку компиляции, как только `ISender` исчезнет, и это хорошо. Но тест, который внедрял настоящий `IMediator` и утверждал поведение через него, нужно перенаправить на конкретный интерфейс. Перезапустите весь набор, не доверяйте одной только зелёной сборке.

Это та самая рационализация зависимостей, которая окупается так же, как выбор встроенного сериализатора в [System.Text.Json против Newtonsoft.Json в 2026](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/): на одну стороннюю библиотеку меньше на горячем пути, на один вопрос лицензирования меньше и код, по которому новый коллега может ориентироваться, не изучая сначала соглашение о диспетчеризации.

## Связанные материалы

- [MediatR против простых классов-сервисов в 2026: должна ли смена лицензии вас сдвинуть?](/ru/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Переход с Newtonsoft.Json на System.Text.Json в большой кодовой базе](/ru/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Minimal APIs против контроллеров в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Источники

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - смена лицензии 2025-07-02, граница v13.0 и двойная модель RPL-1.5 / коммерческая.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - пороги редакции Community в $5,000,000 выручки и $10,000,000 капитала и проверка лицензии только с записью в журнал.
- [LuckyPennySoftware/MediatR на GitHub](https://github.com/LuckyPennySoftware/MediatR) - текущий исходный код 14.x, заменяемые контракты `IPipelineBehavior` и `INotification`.
- [Scrutor на GitHub](https://github.com/khellang/Scrutor) - расширения `Decorate` и `Scan` под лицензией MIT, используемые для замены behaviors и регистрации сервисов по соглашению.
- [Внедрение зависимостей в .NET - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection) - времена жизни сервисов и разрешение `IEnumerable<T>`, используемые для fan-out уведомлений.
