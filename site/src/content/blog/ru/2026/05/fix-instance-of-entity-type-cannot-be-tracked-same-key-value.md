---
title: "Исправление: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"
description: "EF Core 11 выбрасывает это исключение, когда два объекта делят первичный ключ внутри одного DbContext. Отсоедините старый или обновите его на месте. AsNoTracking при чтении предотвращает коллизию."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "change-tracker"
lang: "ru"
translationOf: "2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value"
translatedBy: "claude"
translationDate: 2026-05-07
---

Решение: `DbContext` уже содержит сущность с этим первичным ключом в своём отслеживателе изменений, и вы передали ему вторую экземпляр с тем же ключом. Либо обновите отслеживаемый экземпляр на месте через `SetValues`, либо отсоедините его перед прикреплением своего, либо читайте через `AsNoTracking`, чтобы ничего не отслеживалось с самого начала. Долгоживущие контексты и шаблон "загрузить, затем `Update(newDto)`" — типичные виновники.

```text
System.InvalidOperationException: The instance of entity type 'Customer' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked. When attaching existing entities, ensure that only one entity instance with a given key value is attached. Consider using 'DbContextOptions.EnableSensitiveDataLogging' to see the conflicting key values.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.ThrowIdentityConflict(InternalEntityEntry entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.Add(...)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.StateManager.StartTracking(...)
   at Microsoft.EntityFrameworkCore.DbContext.SetEntityState(...)
   at Microsoft.EntityFrameworkCore.DbContext.Update[TEntity](TEntity entity)
```

Это руководство написано для .NET 11 preview 4 и `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. Поведение идентично с EF Core 2.0; между релизами меняются только внутренние детали трассы стека. Исключение возникает из инварианта `IdentityMap<T>`: `DbContext` хранит максимум один отслеживаемый экземпляр на пару `(EntityType, PrimaryKey)`, и любой второй экземпляр отвергается на месте.

## Зачем существует identity map

Отслеживатель изменений EF Core построен вокруг одного правила: для каждого типа сущности каждое значение первичного ключа отображается максимум на один CLR-объект. Это правило позволяет `SaveChanges` без двусмысленности решать, является ли строка `Added`, `Modified` или `Unchanged`, и заставляет работать навигационный fix-up, когда вы загружаете связанные данные по частям. Два объекта с одним ключом означали бы два конкурирующих ответа на вопрос "каково текущее состояние клиента 42?", поэтому отслеживатель изменений отказывается принимать второй. Исключение, которое вы видите, — это и есть отказ, и он выбрасывается до того, как ваш вызов `SaveChanges` запустится, в момент, когда `DbContext` обнаруживает конфликт во время `Attach`, `Update`, `Add` или любой операции, которая обходит граф.

## Минимальное воспроизведение

Сценарий сбоя почти всегда выглядит так: HTTP-обработчик читает сущность, чтобы провалидировать запрос, затем заново создаёт ту же сущность из DTO и просит EF Core её обновить.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public record CustomerDto(int Id, string Name, string Email);

public class CustomersController(AppDb db) : ControllerBase
{
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, CustomerDto dto)
    {
        var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
        if (existing is null) return NotFound();

        var updated = new Customer
        {
            Id = dto.Id,
            Name = dto.Name,
            Email = dto.Email
        };

        db.Update(updated); // throws: id is already tracked from the read above
        await db.SaveChangesAsync();
        return NoContent();
    }
}
```

Первый вызов `FirstOrDefaultAsync` прикрепляет `existing` (id 42) в состоянии `Unchanged`. Затем `db.Update(updated)` пытается прикрепить другой CLR-объект с id 42. Отслеживатель изменений отвергает его. Текст исключения упоминает "another instance with the same key value", что точно, но легко неправильно прочесть в усталый день: "две экземпляры" — это та, которую EF Core уже знает, и та, которую вы ему сейчас передаёте.

## Три исправления, ранжированные

Применяйте их в этом порядке. Первые два полностью избегают проблемы; третье — для случаев, когда вы по-настоящему не можете.

### 1. Обновите отслеживаемую сущность на месте через SetValues

Если вы уже загрузили строку, отслеживатель изменений — ваш союзник. Мутируйте отслеживаемый экземпляр и пусть EF Core вычислит дифф:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
    if (existing is null) return NotFound();

    db.Entry(existing).CurrentValues.SetValues(dto);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`CurrentValues.SetValues` копирует совпадающие имена свойств с исходного объекта на отслеживаемую сущность и помечает как `Modified` только те столбцы, которые действительно изменились. Сгенерированный оператор `UPDATE` затрагивает только грязные столбцы. Это самый чистый шаблон для "редактирования существующей строки из DTO", потому что он остаётся внутри identity map и производит минимальный SQL.

### 2. Читайте через AsNoTracking, затем Update

Если вы загрузили строку только для проверки существования, делайте это без отслеживания:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var exists = await db.Customers
        .AsNoTracking()
        .AnyAsync(c => c.Id == id);
    if (!exists) return NotFound();

    var updated = new Customer { Id = dto.Id, Name = dto.Name, Email = dto.Email };
    db.Update(updated);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`AnyAsync` не материализует сущность, так что ничего не отслеживается. `db.Update(updated)` прикрепляет новый экземпляр в состоянии `Modified`, и EF Core записывает каждое свойство одним обращением `UPDATE`. Компромисс по сравнению с исправлением 1 в том, что каждый столбец записывается по проводу, грязный или нет, потому что у EF Core нет оригинальных значений для сравнения. Для широких таблиц это расточительно; для узких таблиц это простейший код.

Для более широких шаблонов того, что отслеживается и что нет, см. обзор в [API записей отслеживателя изменений](/2026/04/efcore-11-changetracker-getentriesforstate/).

### 3. Отсоедините существующую сущность, затем прикрепите свою

Когда вы не можете избежать ситуации с двойным экземпляром (долгоживущий контекст, сторонняя библиотека, которая загружает за вашей спиной), сначала отсоедините конфликтующую запись:

```csharp
// .NET 11, EF Core 11.0.0
public async Task ReplaceCustomer(int id, Customer incoming)
{
    var local = db.ChangeTracker.Entries<Customer>()
        .FirstOrDefault(e => e.Entity.Id == id);

    if (local is not null)
        local.State = EntityState.Detached;

    db.Update(incoming);
    await db.SaveChangesAsync();
}
```

`ChangeTracker.Entries<T>()` работает в памяти и не обращается к базе данных. Установка `State = Detached` удаляет запись из identity map, что освобождает ключ для нового экземпляра. Это аварийный люк, а не значение по умолчанию, потому что он заставляет вас рассуждать о том, какой экземпляр "побеждает", если другой код держит ссылку на отсоединённый.

EF Core 11 также напрямую выставляет `db.Entry(local.Entity).State = EntityState.Detached`, когда у вас уже есть проблемный объект на руках. Обе формы делают одно и то же: вытаскивают запись из identity map.

## Распространённые формы, которые это вызывают

### DbContext, зарегистрированный как Singleton, или захваченный внутри Singleton

Подавляющее большинство сообщений "но мой код обновляет только один раз" оказываются несоответствием времени жизни `DbContext`. `DbContext` задуман как `Scoped`, то есть один на запрос. Если он зарегистрирован как `Singleton` (или внедрён в один), каждый запрос наслаивает сущности на одну и ту же identity map, и второе обновление того же ключа выбрасывает исключение.

```csharp
// Bad: long-lived AppDb captures the change tracker for the lifetime of the host
builder.Services.AddSingleton<AppDb>();

// Good: scoped per request, change tracker resets between requests
builder.Services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));
```

Если вам действительно нужен контекст внутри `Singleton` (например, `BackgroundService` или задание Hangfire), внедрите `IDbContextFactory<AppDb>` и создавайте свежий контекст на каждую единицу работы:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class CustomerSyncService(IDbContextFactory<AppDb> factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            // ... work with db ...
        }
    }
}
```

### Графы с жадной загрузкой, которые встречаются с вручную прикреплённой сущностью

Если вы загружаете клиента с его заказами жадной загрузкой, а затем пытаетесь `Attach(customer)` откуда-то ещё (другой результат запроса, сериализованное тело запроса, попадание в кеш), граф заказов сталкивается с тем, что уже отслеживается. Либо опустите запрос на стороне чтения до `AsNoTracking()`, чтобы граф не оказался в карте, либо используйте `db.Entry(customer).State = EntityState.Modified` только на корне и обходите детей явно.

### Замоканный DbContext в тестах

Если вы используете замоканный `DbContext` для написания тестов, мок часто не реализует identity map корректно, так что в продакшене попадает на эту ошибку, а тесты проходят. Происходит и обратное: настоящий in-memory провайдер отслеживает сущности, которые мок не отслеживал, и тест падает по причинам, никак не связанным с тестируемой системой. Решение — тестировать против настоящего провайдера; руководство по [подводным камням мокирования DbContext](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) описывает, что мок даёт, а что нет.

### EnableSensitiveDataLogging — ваш отладчик

Сообщение исключения говорит "Consider using `DbContextOptions.EnableSensitiveDataLogging` to see the conflicting key values" не зря. Без него EF Core скрывает реальный первичный ключ в ошибке, чтобы избежать утечки PII в логи. Включите его локально, чтобы увидеть, какая строка дублируется:

```csharp
// .NET 11, EF Core 11.0.0 -- development only
builder.Services.AddDbContext<AppDb>(o => o
    .UseSqlServer(cs)
    .EnableSensitiveDataLogging()
    .EnableDetailedErrors());
```

Никогда не отгружайте это в продакшен; тот же флаг будет печатать значения параметров в ваши логи на каждой команде.

## Варианты, которые выглядят как эта ошибка, но не являются ею

### "Cannot insert explicit value for identity column"

Другое исключение, другая причина: SQL Server отвергает ненулевой первичный ключ в столбце `IDENTITY`. Решение — `SET IDENTITY_INSERT ON` или, чаще, не присваивать ключ при вставке. Отслеживатель изменений не задействован.

### "An attempt was made to use the model while it was being created"

Это баг порядка инициализации, обычно вызванный статическим полем `DbContext` или чтением из модели внутри `OnModelCreating`. Identity map тоже не задействована.

### "A second operation was started on this context instance before a previous operation completed"

Это конкурентность, а не конфликт ключа. Scoped `DbContext` не потокобезопасен; два параллельных `await` на одном экземпляре производят это исключение. Другая ошибка, другое решение (снова `IDbContextFactory` или сериализуйте работу).

## Связанные материалы

Для более широкого контекста EF Core см. обзор [обнаружения N+1 запросов](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), руководство по [скомпилированным запросам на горячих путях](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) и обзор [записей как сущностей EF Core](/2026/04/how-to-use-records-with-ef-core-11-correctly/), у которого свои подводные камни identity map вокруг `with`-выражений. Когда вы попадаете на эту ошибку в коде запуска, а не в обработчике запроса, [чек-лист поиска DefaultConnection](/2026/05/fix-no-connection-string-named-defaultconnection/) покрывает сторону конфигурации. Для тестовых фикстур, которые передают вашему коду настоящую базу данных, [обзор Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) — самый чистый сетап.

## Источники

- [Tracking and No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking), документация EF Core.
- [Change Tracker API](https://learn.microsoft.com/en-us/ef/core/change-tracking/), документация EF Core.
- [Working with disconnected entity graphs](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), документация EF Core.
- [Интерфейс `IDbContextFactory<TContext>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [Метод `PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
