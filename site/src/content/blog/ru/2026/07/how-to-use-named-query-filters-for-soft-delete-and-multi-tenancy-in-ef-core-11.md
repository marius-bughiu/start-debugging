---
title: "Как использовать именованные фильтры запросов для мягкого удаления и мультитенантности в EF Core 11"
description: "Примените два независимых глобальных фильтра запросов к одной сущности в EF Core 11: фильтр мягкого удаления и фильтр тенанта, каждый с именем, чтобы можно было отключить один без другого через IgnoreQueryFilters."
pubDate: 2026-07-03
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "ru"
translationOf: "2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Чтобы применить фильтр мягкого удаления и фильтр мультитенантности к одной сущности в EF Core 11, дайте каждому имя: вызовите `HasQueryFilter("SoftDeletionFilter", e => !e.IsDeleted)` и `HasQueryFilter("TenantFilter", e => e.TenantId == _tenantId)` в `OnModelCreating`. Оба по умолчанию применяются к каждому запросу. Когда административному экрану нужно увидеть мягко удалённые строки, отключите только этот фильтр с помощью `IgnoreQueryFilters(["SoftDeletionFilter"])`, и фильтр тенанта останется включённым, так что вы никогда не раскроете данные другого тенанта. Именованные фильтры запросов появились в EF Core 10 и являются стандартным способом складывать фильтры в EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). Эта статья показывает полную настройку: как передать id тенанта в контекст, автоматически помечать удаления, выборочно отключать фильтры и разбирает подвох с join, который тихо отбрасывает строки.

## Почему одного фильтра на сущность всегда было мало

Глобальный фильтр запросов - это дополнительная конструкция `Where`, которую EF Core внедряет в каждый запрос к типу сущности. Доминируют два сценария. Мягкое удаление сохраняет строки в таблице с флагом `IsDeleted` вместо того, чтобы выполнять `DELETE`, так что вы получаете журнал аудита и путь к отмене. Мультитенантность хранит строки многих клиентов в одной таблице со столбцом `TenantId`, и фильтр гарантирует, что запрос видит только строки текущего тенанта. Оба случая - именно тот тип сквозного предиката, который вы никогда не захотите писать вручную в каждом `Where`, потому что единственное место, где вы его забудете, - это баг с утечкой данных.

Проблема до EF Core 10 состояла в том, что каждый тип сущности мог иметь ровно один фильтр. Вызов `HasQueryFilter` дважды не складывал предикаты, он тихо заменял первый:

```csharp
// EF Core 9 and earlier -- the second call WINS, soft delete is lost
modelBuilder.Entity<Invoice>().HasQueryFilter(i => !i.IsDeleted);
modelBuilder.Entity<Invoice>().HasQueryFilter(i => i.TenantId == _tenantId);
// Result: only the tenant filter is active. Deleted rows come back.
```

Обходным решением было объединить всё через `&&` в одно выражение:

```csharp
// EF Core 9 -- works, but the two concerns are now welded together
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

Это компилируется и фильтрует корректно, но имеет острый край: нельзя отключить половину. `IgnoreQueryFilters()` работает по принципу «всё или ничего». Как только административному отчёту потребуется включить мягко удалённые счета, вы вызываете `IgnoreQueryFilters()`, и теперь фильтр тенанта тоже пропадает. В мультитенантной системе это не неудобство, а инцидент безопасности. Именованные фильтры существуют именно для того, чтобы сделать возможным «отключи один, оставь другой».

## Определение двух именованных фильтров на одной сущности

В EF Core 11 у `HasQueryFilter` есть перегрузка, которая принимает ключ фильтра первым аргументом. Укажите имя, и вызовы будут складываться, а не перезаписываться:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Invoice
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public bool IsDeleted { get; set; }
    public decimal Amount { get; set; }
}

public class BillingContext(string tenantId) : DbContext
{
    private readonly int _tenantId = int.Parse(tenantId);

    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == _tenantId);
    }
}
```

Теперь обычный запрос фильтруется обоими предикатами:

```csharp
// SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
var invoices = await context.Invoices.ToListAsync();
```

Оба предиката попадают в одну конструкцию SQL `WHERE`, объединённые через `AND`, ровно так, как это делала версия с `&&`. Разница целиком в том, что вы можете сделать дальше: у каждого предиката теперь есть рукоятка, за которую можно взяться по имени.

Правило, которое компилятор не поймает: нельзя смешивать именованный и безымянный фильтр на одном типе сущности. Как только у любого фильтра `Invoice` появляется имя, оно должно быть у всех. Безымянный `HasQueryFilter(i => ...)` на сущности, у которой уже есть именованные фильтры, выбрасывает исключение во время построения модели. Выберите один стиль на сущность и придерживайтесь его.

## Передача id тенанта в контекст

Фильтр мягкого удаления - это константное выражение, но фильтру тенанта нужно значение времени выполнения, а фильтр может читать только состояние, живущее на экземпляре контекста. Самая чистая привязка - разрешить текущего тенанта один раз при конструировании контекста. В приложении ASP.NET Core это обычно означает прочитать его из аутентифицированного пользователя и передать в контекст через внедрение зависимостей:

```csharp
// .NET 11 -- resolve tenant per request and feed it to the context
builder.Services.AddScoped<ITenantProvider, HttpTenantProvider>();

builder.Services.AddDbContext<BillingContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
});

// A small provider that pulls the tenant from the current principal
public sealed class HttpTenantProvider(IHttpContextAccessor accessor) : ITenantProvider
{
    public int TenantId =>
        int.Parse(accessor.HttpContext!.User.FindFirstValue("tenant_id")!);
}
```

Затем сошлитесь на провайдер из контекста. Читать тенанта лениво внутри фильтра (а не кешировать его в поле) важнее, чем кажется, и следующий раздел объясняет почему:

```csharp
// EF Core 11 -- the filter closes over a field EF re-reads on each query
public class BillingContext(DbContextOptions<BillingContext> options,
                            ITenantProvider tenant) : DbContext(options)
{
    private int TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == TenantId);
    }
}
```

EF Core вычисляет выражение тенанта во время запроса, а не при построении модели, поэтому свойство читается для каждого запроса и транслируется в параметр. Это оставляет скомпилированный план запроса переиспользуемым между тенантами, при этом изолируя строки.

### Ловушка с пулингом DbContext

Если вы используете `AddDbContextPool`, будьте осторожны: контекст из пула переиспользуется между запросами, и его конструктор не выполняется снова при переиспользовании. Id тенанта, захваченный в поле внутри конструктора, окажется устаревшим для второго запроса, которому достанется этот экземпляр из пула. Либо избегайте пулинга для контекста с областью тенанта, либо разрешайте тенанта через scoped-провайдер, читаемый во время запроса, как показано выше, а не через значение, замороженное при конструировании. Это самый распространённый способ, которым именованные фильтры тенанта раскрывают данные в продакшене.

## Мягкое удаление без правки каждого места вызова

Фильтр скрывает удалённые строки, но что-то всё же должно устанавливать `IsDeleted = true`. Вы не хотите, чтобы это было разбросано по сервисам. Переопределите `SaveChangesAsync` и преобразуйте удаления в обновления в той узкой точке, через которую проходит каждая запись:

```csharp
// EF Core 11 -- intercept deletes and turn them into soft deletes
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    ChangeTracker.DetectChanges();

    foreach (var entry in ChangeTracker.Entries<Invoice>()
                 .Where(e => e.State == EntityState.Deleted))
    {
        entry.State = EntityState.Modified;
        entry.CurrentValues["IsDeleted"] = true;
    }

    return await base.SaveChangesAsync(ct);
}
```

Теперь `context.Invoices.Remove(invoice)`, за которым следует `SaveChangesAsync`, выполняет `UPDATE`, переключающий флаг, и фильтр запросов заставляет строку исчезнуть из обычных чтений. Если вы уже выполняете `ISaveChangesInterceptor` для проставления аудита, это ещё более подходящий дом для этой логики. Смотрите [как использовать перехватчики EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/), чтобы увидеть вариант с перехватчиком, который оставляет `SaveChanges` нетронутым и переживает вызов из любого репозитория.

## Отключение одного фильтра с сохранением другого

В этом весь смысл именования. `IgnoreQueryFilters` принимает коллекцию имён фильтров, и только они отключаются:

```csharp
// EF Core 11 -- see deleted invoices, but STILL scoped to the current tenant
var withDeleted = await context.Invoices
    .IgnoreQueryFilters(["SoftDeletionFilter"])
    .ToListAsync();
// SQL: WHERE TenantId = @__tenantId   (soft-delete predicate dropped, tenant kept)
```

Фильтр тенанта остаётся нетронутым, так что администратор, просматривающий «все счета, включая удалённые», никогда не увидит данные другого клиента. Беспараметрический `IgnoreQueryFilters()` по-прежнему существует и по-прежнему отключает всё, чего вы почти никогда не хотите для сущности, отфильтрованной по тенанту. Считайте беспараметрический вызов запахом кода для любой таблицы, несущей столбец тенанта.

### Именуйте фильтры константами, а не строковыми литералами

Имена фильтров - это магические строки, и опечатка в `IgnoreQueryFilters(["SoftDeletonFilter"])` тихо проваливается, не отключая ничего. Зафиксируйте имена один раз:

```csharp
// EF Core 11 -- one source of truth for filter names
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant = nameof(Tenant);
}

modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant, i => i.TenantId == TenantId);
```

Затем оберните вызов ignore в метод расширения, чтобы ни один вызывающий код никогда не набирал имя фильтра:

```csharp
// EF Core 11 -- intent-revealing API, filter name hidden
public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> query)
    => query.IgnoreQueryFilters([InvoiceFilters.SoftDelete]);

// Call site reads like English and cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

## Join по обязательной навигации, который тихо отбрасывает строки

Самый неприятный подвох с фильтрами запросов не имеет отношения к именованию, и он кусается сильнее всего в мультитенантных моделях, где каждая таблица несёт фильтр. Когда отфильтрованная сущность находится на обязательной стороне навигации, EF Core транслирует `Include` в `INNER JOIN`. Если фильтр удаляет родительскую строку, inner join удаляет и дочернюю, и вы получаете меньше результатов, чем ожидали.

Рассмотрим отфильтрованный `Blog` с обязательными дочерними `Post`:

```csharp
// EF Core 11 -- required navigation plus a filter on the principal
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired();
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));

var allPosts = await db.Posts.ToListAsync();                       // returns 6
var withBlog = await db.Posts.Include(p => p.Blog).ToListAsync();  // returns 3
```

Второй запрос отбрасывает все посты, чей блог был отфильтрован, потому что `INNER JOIN` требует совпадающей строки блога. Документация Microsoft указывает на это прямо: использование обязательной навигации для доступа к сущности, у которой определён глобальный фильтр запросов, «может привести к неожиданным результатам». Есть два решения. Сделайте навигацию необязательной, чтобы EF выдал `LEFT JOIN`:

```csharp
// EF Core 11 -- LEFT JOIN keeps the children even when the parent is filtered
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired(false);
```

Или, что лучше для мультитенантности, применяйте один и тот же фильтр согласованно к обоим концам, чтобы дочерние строки, которые оказались бы висящими, удалялись у источника:

```csharp
// EF Core 11 -- matching filters on both entities keep the two queries in sync
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));
modelBuilder.Entity<Post>().HasQueryFilter("UrlFilter", p => p.Blog.Url.Contains("fish"));
```

Подход с согласованным фильтром - правильное значение по умолчанию, когда ваш столбец тенанта живёт в каждой таблице: `TenantFilter` и на `Blog`, и на `Post` означает, что ни `INNER JOIN`, ни `LEFT JOIN` не смогут вытащить строку чужого тенанта.

## Ограничения, которые стоит знать, прежде чем закладываться

Несколько ограничений задают, насколько далеко можно это протолкнуть. Фильтры можно определять только на корневом типе сущности иерархии наследования, так что нельзя поставить разный фильтр на каждый производный тип при отображении «таблица на иерархию». EF Core не обнаруживает циклы в определениях фильтров, так что фильтр на `Blog`, ссылающийся на `Post`, чей фильтр ссылается на `Blog`, может уйти в бесконечный цикл во время трансляции, поэтому определяйте их аккуратно. И если вы настраиваете сущности через классы `IEntityTypeConfiguration<T>`, а не напрямую в `OnModelCreating`, внутри `Configure` нет экземпляра контекста, из которого можно прочитать тенанта; документированный обходной путь - добавить приватное поле контекста в класс конфигурации и сослаться на него из выражения фильтра.

Замечание о производительности: поскольку значение тенанта становится параметром запроса, предикаты мягкого удаления и тенанта не фрагментируют ваш кеш планов запросов так, как это делала бы встроенная константа. Это оставляет именованные фильтры дешёвыми даже под высокой мультитенантной нагрузкой. Если вы проверяете число запросов, добавляя фильтры, сверьтесь с [как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), поскольку фильтр, тянущийся через навигацию, может добавить join, который вы не планировали.

Именованные фильтры запросов превращают глобальные фильтры из тупого инструмента в компонуемый. Два предиката, два имени и возможность снять ровно один из них ровно для одного запроса - это разница между переключателем мягкого удаления и случайной утечкой тенанта.

## Связанное

- [Как использовать перехватчики EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: FOREIGN KEY constraint failed при удалении сущности в EF Core 11](/ru/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution в EF Core 11](/ru/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Как сделать keyset-пагинацию (курсорную) в EF Core 11](/ru/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)

## Источники

- [Global Query Filters, документация EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
