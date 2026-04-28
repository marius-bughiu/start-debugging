---
title: "Как прогреть модель EF Core до первого запроса"
description: "EF Core строит свою концептуальную модель лениво при первом обращении к DbContext, поэтому первый запрос в свежем процессе на несколько сотен миллисекунд медленнее любого последующего. Это руководство охватывает три реальных решения в EF Core 11: стартовый IHostedService, который трогает Model и открывает соединение, dotnet ef dbcontext optimize для поставки предкомпилированной модели, и подводные камни ключа кеша, которые всё равно молча перестраивают модель."
pubDate: 2026-04-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "performance"
  - "startup"
  - "csharp"
lang: "ru"
translationOf: "2026/04/how-to-warm-up-ef-core-model-before-the-first-query"
translatedBy: "claude"
translationDate: 2026-04-29
---

Первый запрос через свежесозданный `DbContext` -- самый медленный, который вообще выполнит ваше приложение, и не имеет никакого отношения к базе данных. EF Core не строит свою внутреннюю модель при запуске host. Он ждёт первого момента, когда что-то прочитает `DbContext.Model`, выполнит запрос, вызовет `SaveChanges` или хотя бы перечислит `DbSet`. В этот момент он прогоняет весь конвейер соглашений по вашим типам сущностей, что на модели из 50 сущностей со связями, индексами и value converter может занять 200-500 мс. Последующие контексты в том же процессе получают модель из кеша меньше чем за 1 мс. Это руководство показывает три решения, которые реально сдвигают цифру в EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14): явный прогрев на старте, предкомпилированная модель, выпускаемая `dotnet ef dbcontext optimize`, и подводные камни ключа кеша модели, которые тихо побеждают оба предыдущих.

## Почему первый запрос медленный, даже если база данных прогрета

`DbContext.Model` -- это экземпляр `IModel`, построенный конвейером соглашений. Соглашения -- это десятки реализаций `IConvention` (обнаружение связей, выведение ключей, обнаружение owned-типов, именование внешних ключей, выбор value converter, маппинг JSON-колонок и так далее), которые проходят по каждому свойству каждого типа сущности и каждой навигации. Результат -- неизменяемый граф модели, который EF Core затем держит на протяжении жизни процесса под ключом, который выдаёт `IModelCacheKeyFactory`.

В стандартной регистрации `AddDbContext<TContext>` эта работа происходит лениво. Последовательность runtime при холодном старте выглядит так:

1. Host запускается. Строится `IServiceProvider`. `TContext` зарегистрирован как scoped. Ничего связанного с моделью ещё не выполнялось.
2. Приходит первый HTTP-запрос. Контейнер DI разрешает `TContext`. Его конструктор сохраняет `DbContextOptions<TContext>` и возвращает управление. Связанного с моделью всё ещё ничего не выполнялось.
3. Ваш handler пишет `await db.Blogs.ToListAsync()`. EF Core разыменовывает `Set<Blog>()`, что читает `Model`, что запускает конвейер соглашений. Это и есть 200-500 мс.
4. Затем запрос компилируется (трансляция LINQ в SQL, привязка параметров, кеширование executor), что добавляет ещё 30-80 мс.
5. Запрос наконец попадает в базу данных.

Шаги 3 и 4 происходят только один раз на процесс на тип `DbContext`. Пятый запрос через тот же тип контекста видит обе стоимости как ноль. Поэтому "первый запрос медленный, все следующие быстрые" воспроизводится так чисто и поэтому от этого нельзя избавиться тюнингом базы данных. Работа в вашем процессе, не на проводе.

Если поставить секундомер вокруг двух запросов подряд в свежем процессе, асимметрию видно напрямую:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
var sw = Stopwatch.StartNew();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"first:  {sw.ElapsedMilliseconds} ms");

sw.Restart();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"second: {sw.ElapsedMilliseconds} ms");
```

На демо-модели из 30 сущностей, нацеленной на SQL Server 2025 с EF Core 11.0.0 на тёплом ноутбуке, первая итерация печатает около `380 ms`, а вторая около `4 ms`. Доминирует построение модели. Если тот же код запускается против холодного AWS Lambda, где host поднимается на каждый вызов, эти 380 мс приземляются прямо в видимую пользователю задержку p99, что ровно тот класс проблемы, который рассматривается в [сокращении времени холодного старта AWS Lambda на .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Решение один: прогрев модели на старте через IHostedService

Самое дешёвое решение переносит стоимость с "первого запроса" на "запуск host", не меняя ни одного боевого пути кода. Зарегистрируйте `IHostedService`, единственная задача которого -- разрешить контекст, заставить модель материализоваться и выйти. Host блокируется на `StartAsync` до открытия слушающего сокета, поэтому к моменту, когда Kestrel принимает запрос, конвейер соглашений уже отработал и закешированная `IModel` сидит в экземпляре опций.

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class EfCoreWarmup(IServiceProvider sp, ILogger<EfCoreWarmup> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var scope = sp.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BloggingContext>();

        // Forces the conventions pipeline to run and the IModel to be cached.
        _ = db.Model;

        // Forces the relational connection-string parsing and the SqlClient pool
        // to allocate one physical connection. ADO.NET keeps it warm in the pool.
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();

        log.LogInformation("EF Core warm-up done in {Elapsed} ms", sw.ElapsedMilliseconds);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Подключите его после `AddDbContext`:

```csharp
// Program.cs, .NET 11, ASP.NET Core 11
builder.Services.AddDbContext<BloggingContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddHostedService<EfCoreWarmup>();
```

Три вещи, которые здесь сделаны правильно и которые часто упускают самописные прогревы:

1. Контекст помещается в scope. `AddDbContext` регистрирует `TContext` как scoped, поэтому разрешение его из корневого provider бросает исключение. `CreateAsyncScope` -- задокументированный паттерн.
2. Читается `db.Model`, а не `db.Set<Blog>().FirstOrDefault()`. Чтение `Model` запускает конвейер соглашений, не компилируя ни одного LINQ-запроса, что удерживает прогрев свободным от round-trip к базе данных, которые могут упасть, потому что схема ещё не готова (думайте про порядок `WaitFor` в Aspire или миграции, которые запускаются после поднятия host).
3. Открывается и закрывается соединение, чтобы пул SqlClient инициализировался. Пул держит физические соединения праздными короткое время, поэтому первый реальный запрос не платит за установку TCP и TLS поверх построения модели.

Регистрация контекста с пулом (`AddDbContextPool<TContext>`) нуждается в том же прогреве, только разрешённом из пула. Любой паттерн работает, но если ещё нужно мутировать регистрацию для замены моделей в тестах, см. [замену RemoveDbContext / pooled factory для тестов в EF Core 11](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) для поддерживаемого способа сделать это без перестройки всего service provider.

Этого решения хватает для большинства приложений ASP.NET Core. Модель всё ещё строится в runtime, вы просто спрятали стоимость в окне запуска host, которое обычно бесплатно или почти бесплатно. Решение, которое реально устраняет стоимость, ниже.

## Решение два: поставка предкомпилированной модели через dotnet ef dbcontext optimize

EF Core 6 представил функцию compiled model, EF Core 7 сделал её стабильной, а EF Core 11 исправил достаточно оставшихся ограничений, чтобы это стало правильным значением по умолчанию для любого сервиса, заботящегося о холодном старте. Идея: вместо запуска конвейера соглашений в runtime запустить его на этапе сборки и эмитнуть рукописную `IModel` как сгенерированный C#. В runtime контекст напрямую загружает уже построенную модель и пропускает соглашения целиком.

CLI-команда -- разовая:

```bash
# .NET 11 SDK, dotnet-ef 11.0.0
dotnet ef dbcontext optimize \
  --output-dir GeneratedModel \
  --namespace MyApp.Data.GeneratedModel \
  --context BloggingContext
```

Это пишет папку с файлами вроде `BloggingContextModel.cs`, `BlogEntityType.cs`, `PostEntityType.cs`. Добавьте папку под систему контроля версий, направьте `UseModel` на сгенерированный singleton, и построение модели в runtime исчезает:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<BloggingContext>(o => o
    .UseSqlServer(builder.Configuration.GetConnectionString("Db"))
    .UseModel(MyApp.Data.GeneratedModel.BloggingContextModel.Instance));
```

На той же демо-модели из 30 сущностей первый запрос после этой смены падает с 380 мс до примерно 18 мс. Оставшаяся стоимость -- трансляция LINQ в SQL для конкретной формы запроса, которая идёт пер-форма-запроса и которую второй вызов того же запроса уже кеширует. Если запрос -- тот же, что вы выполняете на каждый запрос, кеш запросов EF съедает стоимость на итерации два, и первый запрос фактически становится таким же быстрым, как установившийся режим.

Три детали, которые кусают, когда делаешь это впервые:

1. **Регенерируйте при изменении модели.** Оптимизированная модель -- снимок. Добавление свойства, индекса или правила в `OnModelCreating` и поставка без повторного запуска `dotnet ef dbcontext optimize` производят рассогласование в runtime, которое EF Core ловит и бросает. Подключите команду к сборке (`<Target Name="OptimizeEfModel" BeforeTargets="BeforeBuild">`) или к тому же шагу, который запускает миграции, чтобы они не могли разойтись.
2. **Флаг `--precompile-queries` существует в preview EF Core 11.** Он расширяет оптимизацию на слой LINQ-в-SQL для известных запросов. На момент `Microsoft.EntityFrameworkCore.Tools` 11.0.0 он задокументирован как preview и эмитит атрибуты, которые можно прочитать в официальной [документации по предкомпилированным запросам](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries). Используйте его для AOT-привязанных приложений, где reflection ограничен, или для горячих путей, где маржинальные 30-80 мс ещё имеют значение.
3. **Предкомпилированная модель обязательна для Native AOT.** `OnModelCreating` запускает пути reflection, которые AOT-trimmer не может проанализировать статически, поэтому без предкомпилированной модели опубликованное приложение падает при первом обращении к `DbContext`. Если вы также смотрите на AOT для остального host, те же ограничения из [использования Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) применяются и к EF Core.

Для сервиса, который уже запускает `dotnet ef migrations` в CI, добавление `dotnet ef dbcontext optimize` в тот же шаг -- две строки YAML, и оно окупается на каждом холодном старте навсегда.

## Подводный камень ключа кеша модели, который побеждает оба решения

Существует категория багов, где прогрев работает чисто, предкомпилированная модель загружается чисто, а первый видимый пользователю запрос *всё равно* медленный. Причина почти всегда -- `IModelCacheKeyFactory`. EF Core кеширует материализованную `IModel` в статическом словаре, ключом является объект, который возвращает factory. Factory по умолчанию возвращает ключ, который -- просто тип контекста. Если ваш `OnModelCreating` обращается к runtime-состоянию (id арендатора, культура, feature flag), модель должна кешироваться отдельно по каждому значению этого состояния, и нужно сообщить об этом EF Core, заменив factory.

```csharp
// .NET 11, EF Core 11.0.0
public sealed class TenantBloggingContext(
    DbContextOptions<TenantBloggingContext> options,
    ITenantProvider tenant) : DbContext(options)
{
    public string Tenant { get; } = tenant.CurrentTenant;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Blog>().ToTable($"Blogs_{Tenant}");
    }
}

public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is TenantBloggingContext t ? (context.GetType(), t.Tenant, designTime) : context.GetType();
}
```

Зарегистрируйте замену в опциях:

```csharp
builder.Services.AddDbContext<TenantBloggingContext>(o => o
    .UseSqlServer(connStr)
    .ReplaceService<IModelCacheKeyFactory, TenantModelCacheKeyFactory>());
```

Без решения с прогревом здесь идут не так две вещи:

- Первый запрос для арендатора `acme` перестраивает модель по ключу кеша `(TenantBloggingContext, "acme", false)`. Первый запрос для арендатора `globex` перестраивает её снова по `(TenantBloggingContext, "globex", false)`. Каждый отдельный ключ кеша один раз затрагивает конвейер соглашений. Наивный прогрев, который разрешает только одного арендатора, прогревает только один из N кешей.
- Factory ключа кеша, замыкающаяся на больше состояния, чем нужно (например, целый снимок `IConfiguration`), фрагментирует кеш. Если обнаружите, что модель перестраивается на каждый запрос, залогируйте возвращаемое значение `IModelCacheKeyFactory.Create` и проверьте, не нестабильно ли оно.

Решение прогрева с самого начала продолжает работать, нужно только итеривать его по интересующим вас измерениям ключа кеша: в hosted service разрешите контекст для каждого известного арендатора до объявления старта завершённым. Если множество арендаторов неограниченно (поддомены на клиента в multi-tenant SaaS), решение с предкомпилированной моделью тоже не спасёт, потому что `dotnet ef dbcontext optimize` производит один снимок, не семейство по арендаторам. В этом случае примите стоимость первого попадания на арендатора и вместо этого ограничьте её более строгим `UseQuerySplittingBehavior` и небольшими реляционными улучшениями запросов, описанными в [как EF Core 11 обрезает reference joins в split queries](/ru/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/).

## Прагматичный порядок действий

Если вы пришли за "что мне делать и в каком порядке", это последовательность, которую я применяю на реальном сервисе:

1. Измерьте. Снимите хронометраж первых трёх запросов в свежем процессе. Если первый меньше 50 мс, ничего не делайте.
2. Добавьте `IHostedService` `EfCoreWarmup`. Это 30 строк кода, и он превращает видимые пользователю 300 мс в 300 мс при запуске host.
3. Если важно само время старта (Lambda, Cloud Run, autoscaler), запустите `dotnet ef dbcontext optimize` и `UseModel(...)`. Подключите команду к CI.
4. Если у вас собственный `IModelCacheKeyFactory`, проверьте, что он захватывает. Убедитесь, что множество ключей перечислимо, и прогрейте каждую запись. Если оно неограниченно, примите стоимость на ключ и перестаньте с этим бороться.
5. Если второй запрос тоже медленный, стоимость в трансляции LINQ, а не в построении модели. Исследуйте `DbContextOptionsBuilder.EnableSensitiveDataLogging` плюс `LogTo` с фильтром по `RelationalEventId.QueryExecuting`, или предкомпилируйте запрос.

Это та же форма, что прогрев любого кеша: выясните, где живёт стоимость, перенесите её раньше и проверьте перенос секундомером.

## Связанное

- [Как мокать DbContext, не ломая отслеживание изменений](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Как использовать IAsyncEnumerable с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Как сократить время холодного старта AWS Lambda на .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [EF Core 11: RemoveDbContext и замена pooled factory для тестов](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [EF Core 11 preview 3 обрезает reference joins в split queries](/ru/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/)

## Источники

- [Compiled models в EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models) - Microsoft Learn
- [Расширенные темы производительности EF Core: компилированные запросы](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) - Microsoft Learn
- [Справочник по `dotnet ef dbcontext optimize`](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-dbcontext-optimize) - Microsoft Learn
- [Справочник API `IModelCacheKeyFactory`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.imodelcachekeyfactory) - Microsoft Learn
- [Стратегии тестирования EF Core](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) - Microsoft Learn
