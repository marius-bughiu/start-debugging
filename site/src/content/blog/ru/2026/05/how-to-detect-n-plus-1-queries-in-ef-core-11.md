---
title: "Как обнаружить запросы N+1 в EF Core 11"
description: "Практическое руководство по выявлению запросов N+1 в EF Core 11: как этот шаблон выглядит в реальном коде, как сделать его видимым через журналы, диагностические перехватчики, OpenTelemetry, и тест, который ломает сборку при регрессии горячего пути."
pubDate: 2026-05-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-02
---

Короткий ответ: включите `LogTo` в EF Core 11 с категорией `Microsoft.EntityFrameworkCore.Database.Command` на уровне `Information`, затем выполните подозрительный endpoint один раз. Если вы видите один и тот же `SELECT` с разными значениями параметров, который выполняется 50 раз подряд вместо одного `JOIN`, у вас есть N+1. Долгосрочное решение состоит не только в добавлении `Include`, но и в подключении `DbCommandInterceptor`, который считает команды на запрос, и юнит-теста, который утверждает верхнюю границу количества команд на логическую операцию, чтобы регрессия не могла бесшумно вернуться.

Этот пост рассказывает о том, как N+1 всё ещё проявляется в EF Core 11 (отложенная загрузка, скрытый доступ к навигационным свойствам в проекциях и неправильно применённые split-запросы), о трёх уровнях обнаружения (журналы, перехватчики, OpenTelemetry) и о том, как защититься от него в CI с помощью теста, который падает, когда endpoint превышает свой бюджет запросов. Все примеры используют .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) и SQL Server, но всё, кроме имён событий, специфичных для провайдера, применимо одинаково к PostgreSQL и SQLite.

## Как N+1 на самом деле выглядит в EF Core 11

Учебниковое определение: "один запрос для загрузки N родительских строк, затем один дополнительный запрос на каждого родителя для загрузки связанной коллекции или ссылки, всего N+1 обращений." В реальной кодовой базе на EF Core 11 триггер редко бывает явным `foreach` по `Include`. Четыре формы, которые я вижу чаще всего:

1. **Отложенная загрузка всё ещё включена**: кто-то добавил `UseLazyLoadingProxies()` много лет назад, кодовая база выросла, и теперь Razor-страница итерирует 200 заказов и обращается к `order.Customer.Name`. Каждое обращение запускает отдельный запрос.
2. **Проекция, вызывающая метод**: `Select(o => new OrderDto(o.Id, FormatCustomer(o.Customer)))`, где `FormatCustomer` нельзя транслировать в SQL, поэтому EF Core сваливается в клиентское вычисление и заново запрашивает `Customer` для каждой строки.
3. **`AsSplitQuery` на неправильной форме**: `.Include(o => o.Lines).Include(o => o.Customer).AsSplitQuery()` корректно разделяет один родительский join на несколько обращений, но если вы добавите `.AsSplitQuery()` внутрь `foreach`, который уже итерирует родителей, вы умножаете обращения.
4. **`IAsyncEnumerable`, смешанный с доступом к навигации**: стримить `IAsyncEnumerable<Order>` по [IAsyncEnumerable в EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) и затем обращаться к `order.Customer.Email` в потребителе. Каждый шаг перечисления открывает новое обращение к базе, если навигация ещё не загружена.

Причина, по которой все четыре трудно заметить, в том, что API `DbContext` по умолчанию никогда не выбрасывает исключение и не предупреждает. План запроса в порядке. Единственный сигнал — это болтовня по проводу, и она невидима, пока вы не посмотрите.

## Конкретное воспроизведение

Поднимите крошечную модель и упражняйте её:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Теперь напишите наихудший возможный цикл:

```csharp
// Triggers N+1 if Customer is not eagerly loaded
var orders = await ctx.Orders.ToListAsync();
foreach (var order in orders)
{
    Console.WriteLine($"{order.Id}: {order.Customer?.Name}");
}
```

Без отложенной загрузки `order.Customer` будет `null`, и вы увидите только один `SELECT` из `Orders`. Это другой баг, тихая потеря данных, но это не N+1. Включите отложенную загрузку, и тот же код становится классическим антипаттерном:

```csharp
options.UseLazyLoadingProxies();
```

Теперь вы получаете один `SELECT` из `Orders`, а затем по одному `SELECT * FROM Customers WHERE Id = @p0` на каждый заказ. С 1000 заказов это 1001 обращение. Первое, что вам нужно, — это способ их увидеть.

## Уровень 1: структурированное журналирование с LogTo и правильной категорией

Самый быстрый сигнал обнаружения — это встроенный регистратор команд EF Core. EF Core 11 предоставляет `LogTo` на `DbContextOptionsBuilder` и направляет события через `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting`:

```csharp
services.AddDbContext<ShopContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.LogTo(
        Console.WriteLine,
        new[] { RelationalEventId.CommandExecuting },
        LogLevel.Information);
});
```

Запустите цикл один раз, и консоль наполнится копиями той же параметризованной инструкции. Если вы смотрите на реальное приложение, отправляйте журналы в свой логгер через `ILoggerFactory`:

```csharp
var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
options.UseLoggerFactory(loggerFactory);
options.EnableSensitiveDataLogging(); // only in dev
```

Переключатель `EnableSensitiveDataLogging` делает значения параметров видимыми. Без него вы видите SQL, но не значения, что сильно усложняет наблюдение "100 из них идентичны, кроме `@p0`". Держите его выключенным в продакшене: он журналирует параметры запроса, которые могут содержать PII или секреты. Официальное руководство по этому есть в [документации по журналированию EF Core](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/).

Когда вы видите этот пожарный шланг, ручное правило обнаружения простое: для любого одного логического действия пользователя количество различных SQL-инструкций должно быть ограничено небольшой константой. Endpoint списка не должен масштабировать количество запросов с количеством строк. Если масштабирует, вы нашли один.

## Уровень 2: DbCommandInterceptor, который считает запросы по области видимости

Поток "журналируй и грепай" подходит для одного разработчика и ужасен для команды. Следующий уровень — это перехватчик, который ведёт счётчик на запрос и позволяет вам утверждать на нём. EF Core 11 поставляет [`DbCommandInterceptor`](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors), который вызывается на каждой выполненной команде:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class CommandCounter
{
    private int _count;
    public int Count => _count;
    public void Increment() => Interlocked.Increment(ref _count);
    public void Reset() => Interlocked.Exchange(ref _count, 0);
}

public sealed class CountingInterceptor(CommandCounter counter) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        counter.Increment();
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        counter.Increment();
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}
```

Подключите его как scoped по запросу:

```csharp
services.AddScoped<CommandCounter>();
services.AddScoped<CountingInterceptor>();
services.AddDbContext<ShopContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(sp.GetRequiredService<CountingInterceptor>());
});
```

Теперь любой путь кода может за O(1) спросить: "сколько SQL-команд я только что отправил?". В ASP.NET Core 11 оберните это вокруг запроса:

```csharp
app.Use(async (ctx, next) =>
{
    var counter = ctx.RequestServices.GetRequiredService<CommandCounter>();
    await next();
    if (counter.Count > 50)
    {
        var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
        logger.LogWarning(
            "{Path} executed {Count} SQL commands",
            ctx.Request.Path,
            counter.Count);
    }
});
```

Шумного предупреждения "более 50 команд на запрос" достаточно, чтобы выявить каждого нарушителя во время нагрузочного теста или теневого прогона в продакшене. Это также основа для CI-гейта далее.

Причина, по которой это работает лучше, чем журналы в продакшене, — объём. Регистратор команд на уровне `Information` утопит реальное приложение. Счётчик — это одно целое число на запрос и одна условная строка журнала на нарушителях.

## Уровень 3: OpenTelemetry, где данные уже живут

Если вы уже следуете настройке из [руководства по OpenTelemetry для .NET 11](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/), отдельный счётчик вам не нужен совсем. Пакет [`OpenTelemetry.Instrumentation.EntityFrameworkCore`](https://www.nuget.org/packages/OpenTelemetry.Instrumentation.EntityFrameworkCore) эмитит по одному span'у на каждую выполненную команду с SQL в `db.statement`:

```csharp
services.AddOpenTelemetry()
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o =>
        {
            o.SetDbStatementForText = true;
        })
        .AddOtlpExporter());
```

В любом бэкенде, который группирует дочерние span'ы под их HTTP-родителем (Aspire dashboard, Jaeger, Honeycomb, Grafana Tempo), endpoint с N+1 показывается как flame graph с одним HTTP-корнем и стопкой одинаковых по форме SQL-span'ов. Визуальный сигнал безошибочен: квадратный блок повторяющихся дочерних span'ов — это всегда N+1. Получив это, вы фактически больше не нуждаетесь в уровне журналирования для повседневной сортировки.

Будьте осторожны с `SetDbStatementForText = true` в продакшене: он отправляет отрендеренный SQL в ваш сборщик, и тот может содержать идентифицирующие значения из `WHERE`-предложений. Большинство команд оставляет его включённым вне продакшена и выключает (или санирует) в продакшене.

## Уровень 4: тест, который ломает сборку

Обнаружение в разработке и продакшене необходимо, но единственное, что предотвращает медленную регрессию обратно к N+1, — это тест. Шаблон использует тот же перехватчик-счётчик и [интеграционный тест на основе Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), бьющий по реальной базе данных:

```csharp
// .NET 11, xUnit 2.9, EF Core 11.0.0, Testcontainers 4.11
[Fact]
public async Task Get_orders_endpoint_executes_at_most_two_commands()
{
    await using var factory = new ShopFactory(); // WebApplicationFactory<Program>
    var counter = factory.Services.GetRequiredService<CommandCounter>();
    counter.Reset();

    var client = factory.CreateClient();
    var response = await client.GetAsync("/orders?take=100");

    response.EnsureSuccessStatusCode();
    Assert.InRange(counter.Count, 1, 2);
}
```

Бюджет "от 1 до 2" отражает реалистичную форму: один `SELECT` для `Orders`, опционально один для `Customers`, если вы подключаете его через `Include`. Если будущее изменение превратит `Include` в lazy load, счётчик подскочит до 101, и тест упадёт. Тесту не нужно знать SQL и заботиться о точном тексте. Он просто навязывает контракт на endpoint.

Тонкий момент: счётчик имеет область видимости, но `WebApplicationFactory` в более старых версиях EF Core разрешает его из корневого провайдера. В EF Core 11 безопасный шаблон — выставить счётчик через middleware на запрос, который кладёт его в `HttpContext.Items`, и затем читать его из `factory.Services` только в тестах, где вы контролируете время жизни. Иначе вы рискуете прочитать счётчик, принадлежащий другому запросу.

## Почему `ConfigureWarnings` — не вся история

В EF Core `ConfigureWarnings` есть с версии 3, и многие руководства скажут вам бросать исключение на `RelationalEventId.MultipleCollectionIncludeWarning` или `CoreEventId.LazyLoadOnDisposedContextWarning`. Оба полезны, но ни один не ловит N+1 напрямую. Они ловят конкретные формы:

- `MultipleCollectionIncludeWarning` срабатывает, когда вы делаете `Include` двух коллекций-братьев в одном неразделённом запросе и предупреждает о картезианском взрыве. Это другая проблема (один большой запрос, возвращающий слишком много строк), и решение — `AsSplitQuery`, который сам может стать N+1, если использовать его неправильно.
- `LazyLoadOnDisposedContextWarning` срабатывает только после того, как `DbContext` уже исчез. Он не ловит lazy-load в активном контексте, который порождает классический N+1.

Нет ни одного предупреждения, которое сказало бы: "вы только что выполнили один и тот же запрос 100 раз". Именно поэтому подход со счётчиком несущий: он наблюдает за поведением, а не за конфигурацией.

## Шаблоны исправления, как только обнаружили один

Обнаружение — это половина работы. Когда тест счётчика падает, исправление обычно вписывается в одну из этих форм:

- **Добавить `Include`**. Самое простое исправление, когда навигация всегда нужна.
- **Перейти к проекции**. `Select(o => new OrderListDto(o.Id, o.Customer.Name))` транслируется в один SQL `JOIN` и избегает материализации полного графа.
- **Использовать `AsSplitQuery`**, когда у родителя есть несколько больших коллекций. Один round-trip на коллекцию всё равно масштабируется как `O(1)` по родителям.
- **Массовая предзагрузка**. Если у вас есть список внешних ключей после родительского запроса, сделайте один последующий `WHERE Id IN (...)` вместо поиска на строку. Трансляция списков параметров в EF Core 11 делает это лаконичным.
- **Полностью отключить отложенную загрузку**. `UseLazyLoadingProxies` редко стоит сюрпризов времени выполнения. Статический анализ и явный `Include` находят больше багов в момент PR, чем в 3 часа ночи.

Если вы мокаете `DbContext` в юнит-тестах, ничего из этого не всплывает. Это ещё одна причина опираться на интеграционные тесты против реальной базы данных, тот же аргумент, что и в [посте о моканье DbContext](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): моки заставляют отслеживатель изменений вести себя нормально, но не могут воспроизвести болтовню по проводу, делающую N+1 видимым.

## Куда смотреть дальше

Шаблоны выше поймают более 95% случаев N+1, но два нишевых инструмента закрывают углы. Профиль `database` инструмента `dotnet-trace` записывает каждую ADO.NET-команду для офлайн-разбора, что полезно, когда регрессия воспроизводится только под нагрузочным тестом (см. [руководство по dotnet-trace](/ru/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) для рабочего процесса). И [`MiniProfiler`](https://miniprofiler.com/) всё ещё хорошо работает как наложение интерфейса на запрос, если вы хотите бейдж для разработчика, говорящий: "эта страница выполнила 47 SQL-запросов".

Что объединяет все они — одна и та же идея: сделать активность по проводу видимой достаточно рано, чтобы разработчик, внёсший регрессию, увидел её до мерджа. EF Core 11 делает это проще, чем любая предыдущая версия, но только если вы согласитесь. По умолчанию — тишина.
