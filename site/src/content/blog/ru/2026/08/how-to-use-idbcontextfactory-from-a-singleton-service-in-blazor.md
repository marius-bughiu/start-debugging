---
title: "Как использовать IDbContextFactory<T> из singleton-сервиса в Blazor"
description: "Singleton не может внедрить DbContext, но может внедрить IDbContextFactory<T>, потому что AddDbContextFactory по умолчанию регистрирует фабрику как singleton. Создавайте и освобождайте по одному контексту на вызов и никогда не сохраняйте экземпляр."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "ef-core"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-16
---

Singleton-сервис не может принять `DbContext` в конструкторе: `AddDbContext<T>` регистрирует контекст как scoped, и валидатор областей ASP.NET Core отклоняет такой захват при старте приложения. А вот `IDbContextFactory<T>` принять может, потому что `AddDbContextFactory<T>` по умолчанию регистрирует фабрику как **singleton**. Внедрите фабрику, вызывайте `CreateDbContextAsync` внутри каждого метода, оборачивайте результат в `await using` и никогда не сохраняйте полученный контекст в поле. Последнее правило и есть самое главное: singleton в Blazor разделяется всеми цепями (circuits) на сервере, поэтому закешированный контекст одновременно используют несколько пользователей, и EF Core либо портит состояние, либо выбрасывает исключение.

Это руководство написано для .NET 11 и EF Core 11. Всё изложенное без изменений применимо к .NET 6, 8 и 10, так как форма регистрации `IDbContextFactory<T>` не менялась с EF Core 5.0. Дампы регистраций и сообщения об ошибках ниже получены на SDK .NET 10.0.201 с `Microsoft.EntityFrameworkCore.Sqlite` 10.0.11, поскольку именно этот runtime был установлен на момент написания.

## Почему singleton в Blazor это самый неудобный случай для DbContext

Серверный Blazor держит по одной *цепи* (circuit) на подключённого пользователя. Эта цепь представляет собой единственную долгоживущую область DI, которая существует столько же, сколько вкладка браузера, а не столько, сколько HTTP-запрос. Собственное руководство Microsoft по EF Core в Blazor прямо называет все три стандартных времени жизни неподходящими для `DbContext`: singleton разделяет один экземпляр между всеми пользователями, scoped разделяет один экземпляр между всеми компонентами внутри цепи одного пользователя, а transient порождает контексты, живущие столько же, сколько удерживающий их компонент.

Singleton хуже всех трёх, и получить его случайно очень легко. Кеш каталога, сервис справочных таблиц, `IHostedService`, обновляющий справочные данные, `IEmailSender`, пишущий строку аудита: всё это естественным образом singleton-сервисы, всем им нужен доступ к базе данных, и ни один из них не может удерживать `DbContext`.

Наивный вариант отлавливается валидацией областей при старте. Если зарегистрировать контекст обычным способом и внедрить его в singleton, `BuildServiceProvider` с `ValidateOnBuild` завершится ошибкой:

```text
Error while validating the service descriptor 'ServiceType: BadWarmer Lifetime: Singleton
ImplementationType: BadWarmer': Cannot consume scoped service 'AppDb' from singleton 'BadWarmer'.
```

Это та же самая проверка на захваченную зависимость, которая в обычных приложениях ASP.NET Core порождает [ошибку потребления scoped-сервиса из singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/). Фабрика и есть штатный выход из положения.

## Что на самом деле регистрирует AddDbContextFactory

Возможность внедрить фабрику в singleton это не соглашение, а объявленное значение по умолчанию. Сигнатура выглядит так:

```csharp
// EF Core 11, Microsoft.Extensions.DependencyInjection
public static IServiceCollection AddDbContextFactory<TContext>(
    this IServiceCollection serviceCollection,
    Action<DbContextOptionsBuilder>? optionsAction = null,
    ServiceLifetime lifetime = ServiceLifetime.Singleton)
    where TContext : DbContext;
```

Параметр `lifetime` по умолчанию равен `ServiceLifetime.Singleton` и задаёт "время жизни, с которым регистрируются фабрика **и опции**". Дамп дескрипторов сервисов, добавляемых единственным вызовом `AddDbContextFactory<AppDb>`, делает картину наглядной:

```text
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions
Singleton  Microsoft.EntityFrameworkCore.Internal.IDbContextFactorySource`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]
Scoped     AppDb
```

Здесь стоит обратить внимание на две вещи.

Во-первых, `IDbContextFactory<AppDb>` зарегистрирован как singleton, поэтому внедрение его в ваш собственный singleton проходит валидацию областей без нареканий. Конкретной реализацией оказывается встроенная в EF Core `DbContextFactory<TContext>`.

Во-вторых, и это многих удивляет: `AddDbContextFactory` **дополнительно регистрирует и сам тип контекста как scoped**. Это документированное поведение, а не утечка. В примечаниях к API сказано прямо: "For convenience, this method also registers the context type itself as a scoped service. This allows a context instance to be resolved from a dependency injection scope directly or created by the factory, as appropriate." То есть после одного вызова `AddDbContextFactory` запись `@inject AppDb Db` по-прежнему компилируется и по-прежнему работает в компоненте. В Blazor это ловушка, потому что такой scoped-экземпляр принадлежит цепи и разделяется всеми компонентами вкладки. Регистрация фабрики никому не мешает внедрить контекст неправильным способом.

## Как настроить это за четыре шага

1. Зарегистрируйте фабрику в `Program.cs` и оставьте время жизни по умолчанию. Не передавайте `ServiceLifetime.Scoped`, это самый частый способ всё сломать.

   ```csharp
   // .NET 11, EF Core 11
   builder.Services.AddDbContextFactory<CatalogDb>(options =>
       options.UseSqlServer(builder.Configuration.GetConnectionString("Catalog")));

   builder.Services.AddSingleton<CatalogCache>();
   ```

2. Объявите в контексте конструктор с параметром `DbContextOptions<TContext>`, ровно так же, как для `AddDbContext`. Фабрика передаёт опции именно через этот конструктор, поэтому контекст, у которого есть только конструктор без параметров, создать не удастся.

   ```csharp
   public sealed class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
   {
       public DbSet<Product> Products => Set<Product>();
   }
   ```

3. Внедрите `IDbContextFactory<TContext>` в singleton и создавайте по одному контексту на каждый вызов метода. Используйте `CreateDbContextAsync` и `await using`, чтобы асинхронное освобождение шло по собственному пути провайдера.

   ```csharp
   public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
   {
       public async Task<List<Product>> GetActiveAsync(CancellationToken ct = default)
       {
           await using var db = await factory.CreateDbContextAsync(ct);
           return await db.Products
               .AsNoTracking()
               .Where(p => p.IsActive)
               .ToListAsync(ct);
       }
   }
   ```

4. Включите валидацию областей во всех средах, чтобы будущий рефакторинг, вернувший захваченный `DbContext`, падал при старте, а не в три часа ночи под нагрузкой.

   ```csharp
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

Контексты, которые выдаёт фабрика, **не** принадлежат контейнеру DI. Документация EF Core говорит об этом прямо: созданные таким образом экземпляры "are not managed by the application's service provider and therefore must be disposed by the application". Конструкция `await using` из шага 3 это не необязательная вежливость: без неё вы утекаете соединениями на всё время жизни процесса.

## Что действительно ломается при кешировании контекста

Соблазнительное сокращение состоит в том, чтобы создать один контекст в конструкторе singleton и переиспользовать его. В разработке это выглядит безобидно, ведь пользователь там только один. Вот тот же `CatalogCache` с единственным контекстом, к которому обращаются 25 конкурентных вызовов на настоящих потоках:

```csharp
// Do not do this. One context, shared by every circuit on the server.
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    private readonly CatalogDb _shared = factory.CreateDbContext();

    public Task<int> CountAsync() => _shared.Products.CountAsync();
}
```

Три запуска подряд на EF Core 10.0.11 дали три разных результата, два из которых были разными исключениями:

```text
run 1: InvalidOperationException: A second operation was started on this context instance
       before a previous operation completed. This is usually caused by different threads
       concurrently using the same instance of DbContext.
run 2: InvalidOperationException: ExecuteReader can only be called when the connection is open.
run 3: InvalidOperationException: A second operation was started on this context instance ...
```

Именно этот недетерминизм и важен. Детектор потокобезопасности EF Core выдаёт первое, понятное сообщение, когда выигрывает гонку, но выигрывает он не всегда: во втором запуске всплыл сырой сбой состояния соединения из ADO.NET, потому что две операции уже переплелись на одном соединении. При другом стечении обстоятельств та же ошибка молча возвращает неверные данные вместо того, чтобы хоть что-то выбросить. Ранее в моих тестах 25 задач, случайно завершившихся синхронно, все вернули правильный ответ и ничего не выбросили, и ровно поэтому такая ошибка доезжает до продакшена.

При переходе на один контекст на вызов те же 25 конкурентных обращений завершились успешно с одинаковыми результатами. Это не хитрый код, это просто честно применённое [правило одной единицы работы](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/).

Те же рассуждения объясняют, почему захват контекста в отсоединённую задачу приводит к [ObjectDisposedException на уже освобождённом экземпляре контекста](/ru/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/): обе ошибки возникают оттого, что контекст переживает операцию, которой он был нужен.

## Перегрузка, которая незаметно ломает весь подход

`AddDbContextFactory` принимает необязательный параметр `lifetime`. Передача `ServiceLifetime.Scoped` это популярный копипаст-совет, обычно унаследованный из мультиарендного примера, где строка подключения вычисляется на каждый запрос. Он меняет регистрацию фабрики и возвращает ровно ту захваченную зависимость, которой вы пытались избежать:

```csharp
// This compiles, then fails at startup once a singleton consumes the factory.
builder.Services.AddDbContextFactory<CatalogDb>(
    options => options.UseSqlServer(connectionString),
    lifetime: ServiceLifetime.Scoped);
```

```text
Error while validating the service descriptor 'ServiceType: CacheWarmer Lifetime: Singleton
ImplementationType: CacheWarmer': Cannot consume scoped service
'Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]' from singleton 'CacheWarmer'.
```

Если строка подключения действительно нужна отдельная на каждую цепь, не делайте фабрику scoped, чтобы потом потреблять её из singleton. Оставьте фабрику singleton и передавайте арендатора явно, либо разрешайте специфичную для арендатора фабрику через `IServiceScopeFactory` внутри метода. Это подводит нас к настоящему ограничению всего подхода.

## У singleton нет цепи, а значит нет и пользователя

Это второе ограничение, с которым сталкиваются после того, как разберутся с проводкой. Singleton создаётся один раз на весь сервер. У него нет ни `AuthenticationStateProvider`, ни привязанного к цепи резолвера арендатора, ни `HttpContext`. Любые `DbContextOptions`, вычисляемые из текущего пользователя, попросту не существуют в тот момент, когда работает ваш singleton.

Конкретно, вот это не работает:

```csharp
// The singleton has no circuit, so there is no current user to read here.
builder.Services.AddDbContextFactory<CatalogDb>((sp, options) =>
    options.UseSqlServer(sp.GetRequiredService<ITenantContext>().ConnectionString));
```

Если данные, с которыми работает ваш singleton, действительно относятся к конкретному пользователю, то singleton для них неподходящее место. Либо перенесите работу в scoped-сервис, который вызывает компонент, либо передавайте идентификатор арендатора параметром метода и выбирайте строку подключения самостоятельно:

```csharp
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    public async Task<int> CountForAsync(string tenantId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Products.CountAsync(p => p.TenantId == tenantId, ct);
    }
}
```

Справочные данные, таблицы подстановки и агрегаты по всем арендаторам хорошо ложатся на singleton с фабрикой. Всё, что привязано к "текущему пользователю", не ложится. Если вы берёте singleton в основном ради того, чтобы избежать повторных запросов, то более подходящий примитив это кеш, а выбор между вариантами разбирается в статье [HybridCache против IMemoryCache и IDistributedCache](/ru/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/).

## Когда стоит взять пулинговую фабрику

`AddPooledDbContextFactory<TContext>` тоже регистрирует singleton `IDbContextFactory<TContext>`, реализованный через `PooledDbContextFactory<TContext>`, с параметром `poolSize`, который по умолчанию равен 1024 начиная с EF Core 6 (в EF Core 5.0 он был 128). Освобождение пулингового контекста сбрасывает его и возвращает в пул, вместо того чтобы выбросить, что заметно снижает количество выделений памяти на горячих путях.

Проверенное поведение на EF Core 10.0.11: создать контекст, освободить его и создать следующий возвращает **тот же самый** экземпляр, а обращение к первому после освобождения выбрасывает `ObjectDisposedException`. То есть пул действительно переиспользует объекты, а обращение после освобождения по-прежнему отлавливается.

Две оговорки перед переходом:

- Пулинговые перегрузки не принимают параметр `lifetime`, а `optionsAction` в них обязателен, а не опционален. Настройку нужно делать снаружи, потому что `OnConfiguring` для пулинговых контекстов не вызывается вовсе.
- Пулинговые контексты не могут принимать произвольные сервисы через конструктор, так как экземпляр переиспользуется между никак не связанными операциями. Любое состояние, которое вы положите на контекст, доживёт до следующего вызывающего, если EF Core его не сбросит.

Для singleton, выполняющего частые короткие чтения, пулинговая фабрика это более удачный вариант по умолчанию. Для singleton, работающего изредка, обычная фабрика проще, а разница в выделениях памяти в профиле не проявится. Если горячий путь это сами запросы, а не создание контекста, то куда больший эффект дадут [скомпилированные запросы для горячих путей EF Core](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Режимы рендеринга, WebAssembly и фоновые сервисы

Стоит назвать три пограничных случая, потому что они меняют то, где живёт singleton.

**Режимы рендеринга interactive WebAssembly и Auto.** Singleton, зарегистрированный в `Program.cs` серверного проекта, существует только на сервере. У компонентов, выполняющихся на клиенте, свой провайдер сервисов в проекте WebAssembly, а `DbContext` вообще не может открыть соединение с базой данных из песочницы браузера. Если компонент переводят с interactive server на interactive WebAssembly, singleton, от которого он зависел, молча перестаёт разрешаться на стороне клиента. Эта же граница стоит за [проблемой состояния между статическим и интерактивным рендерингом в Blazor](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

**Статический SSR и предварительный рендеринг.** При статическом серверном рендеринге цепи нет, но корневой провайдер приложения по-прежнему существует, поэтому singleton с фабрикой работает как обычно. Это один из немногих шаблонов доступа к данным, который ведёт себя одинаково при статическом SSR, предварительном рендеринге и интерактивном серверном рендеринге, и это серьёзный довод в его пользу.

**BackgroundService.** `AddHostedService<T>` регистрирует singleton, поэтому у размещённого сервиса, которому нужны данные, ровно та же проблема и ровно то же решение. Внедряйте `IDbContextFactory<T>`, когда работа сводится к чистому доступу к данным; берите `IServiceScopeFactory`, когда единице работы нужно несколько scoped-сервисов сразу, о чём рассказано в статье [использование scoped-сервисов внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

Правило достаточно короткое, чтобы уместиться в одну строку: singleton может держать фабрику, но никогда не контекст. Всё остальное в этой статье следствие этого правила.

## Источники

- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), документация EF Core, про `AddDbContextFactory` и освобождение неуправляемых контейнером контекстов.
- [ASP.NET Core Blazor with Entity Framework Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-ef-core), про цепи и про то, почему singleton, scoped и transient одинаково плохо подходят для `DbContext`.
- [EntityFrameworkServiceCollectionExtensions.AddDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), про значение по умолчанию `ServiceLifetime.Singleton` и про scoped-регистрацию типа контекста.
- [EntityFrameworkServiceCollectionExtensions.AddPooledDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.addpooleddbcontextfactory), про значение `poolSize` по умолчанию и оговорку насчёт `OnConfiguring`.
