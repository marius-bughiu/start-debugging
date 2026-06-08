---
title: "Как использовать перехватчики EF Core 11 для аудита"
description: "Проставляйте столбцы CreatedBy/ModifiedOn и пишите полный журнал изменений с помощью ISaveChangesInterceptor в EF Core 11, включая время жизни в DI, текущего пользователя и подводные камни ExecuteUpdate."
pubDate: 2026-06-08
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "ru"
translationOf: "2026/06/how-to-use-ef-core-11-interceptors-for-auditing"
translatedBy: "claude"
translationDate: 2026-06-08
---

Чтобы аудировать изменения в EF Core 11, реализуйте `ISaveChangesInterceptor` (или наследуйтесь от пустого базового класса `SaveChangesInterceptor`), переопределите `SavingChangesAsync`, чтобы обойти `context.ChangeTracker.Entries()` до того, как запись дойдёт до базы данных, и зарегистрируйте его с помощью `optionsBuilder.AddInterceptors(...)`. Внутри перехватчика вы либо проставляете столбцы аудита (`CreatedBy`, `CreatedOnUtc`, `ModifiedBy`, `ModifiedOnUtc`) на сущностях, реализующих маркерный интерфейс `IAuditable`, либо строите отдельную строку журнала изменений для каждого изменённого свойства. Всё это выполняется внутри той же транзакции, что и ваш `SaveChanges`, поэтому сбой аудита откатывает бизнес-запись вместе с собой. В этой статье используются .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) и C# 14.

Перехватчики здесь правильный инструмент именно потому, что они находятся в той узкой точке, через которую обязана пройти каждая запись. Вы не можете забыть их вызвать, вы не можете обойти их через какой-то забытый метод репозитория, и они видят полностью заполненный `ChangeTracker` с исходными и текущими значениями каждого свойства. Это именно те данные, которые нужны журналу аудита.

## Почему перехватчик лучше переопределения SaveChanges

Расхожий ответ на "проставь мне временные метки" -- переопределить `SaveChanges` в базовом `DbContext`:

```csharp
// The pattern people reach for first -- it works, but it has problems
public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<IAuditable>())
    {
        if (entry.State == EntityState.Added)
            entry.Entity.CreatedOnUtc = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

Это привязывает аудит к вашему подклассу `DbContext`. Как только у вас появляется второй контекст, библиотека, поставляющая собственный контекст, или тест, использующий чистый `DbContext`, поведение незаметно исчезает. Это также вынуждает вас вручную переопределять и `SaveChanges`, и `SaveChangesAsync`, и не даёт чистого места для внедрения текущего пользователя без того, чтобы контекст узнал о HTTP-деталях.

`ISaveChangesInterceptor` -- это отдельный, тестируемый класс с единственной ответственностью. Вы регистрируете его один раз, он применяется к каждому контексту, к которому он подключён, и EF Core автоматически вызывает синхронный или асинхронный вариант в зависимости от того, какую перегрузку `SaveChanges` использовал вызывающий код. Официальная документация EF Core описывает перехватчики как поддерживаемую точку расширения именно для такого рода сквозной функциональности, см. [руководство по перехватчикам на Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors).

## Поверхность перехватчика, которую вы реально используете

`ISaveChangesInterceptor` определяет шесть методов, три синхронных и три асинхронных:

- `SavingChanges` / `SavingChangesAsync` -- срабатывают до того, как EF сгенерирует и отправит SQL. Именно сюда относится работа по аудиту, потому что `ChangeTracker` всё ещё отражает то, что задало приложение.
- `SavedChanges` / `SavedChangesAsync` -- срабатывают после успешной записи. Используйте их, чтобы захватить сгенерированные базой данных значения (ключи identity, вычисляемые столбцы), которые не были известны до записи.
- `SaveChangesFailed` / `SaveChangesFailedAsync` -- срабатывают, когда запись выбрасывает исключение, чтобы вы могли пометить строку аудита в процессе как неудачную.

Вы редко реализуете интерфейс напрямую. Наследуйтесь от `SaveChangesInterceptor`, который предоставляет пустые виртуальные реализации всех шести методов, и переопределяйте только то, что вам нужно.

```csharp
// .NET 11, EF Core 11, C# 14
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class AuditableEntityInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    private static void StampAuditColumns(DbContext? context)
    {
        if (context is null) return;
        // implementation below
    }
}
```

Две детали, на которых спотыкаются. Во-первых, `eventData.Context` допускает null, поэтому проверяйте его. Во-вторых, вы должны переопределить и `SavingChanges`, и `SavingChangesAsync`; EF Core не перенаправляет один в другой. Если вы переопределите только асинхронную версию, а где-то в вашем пути выполнения вызывается синхронный `SaveChanges()`, ваша логика аудита никогда не отработает. Переопределение обоих с общим приватным методом -- безопасный вариант по умолчанию. Если вы хотите принудительно перевести всё на асинхронный путь, выбросьте `NotSupportedException` из синхронного переопределения, чтобы случайный синхронный вызов громко падал, а не молча пропускал аудит.

Возвращаемое значение `InterceptionResult<int>` -- это способ подавить или заменить сохранение. Для аудита вам это почти никогда не нужно, поэтому пробросить входящий `result` напрямую (что делает `base.Saving...`) -- правильно.

## Проставление столбцов аудита на аудируемых сущностях

Лёгкий подход: маркерный интерфейс плюс теневые или реальные свойства. Определите контракт один раз.

```csharp
// .NET 11, C# 14
public interface IAuditable
{
    DateTime CreatedOnUtc { get; set; }
    string? CreatedBy { get; set; }
    DateTime? ModifiedOnUtc { get; set; }
    string? ModifiedBy { get; set; }
}
```

Теперь заполните `StampAuditColumns`. Ключевой вызов -- `ChangeTracker.Entries<IAuditable>()`, который возвращает только отслеживаемые сущности, реализующие интерфейс, уже разбитые по `EntityState`.

```csharp
// .NET 11, EF Core 11, C# 14
private void StampAuditColumns(DbContext? context)
{
    if (context is null) return;

    var now = _timeProvider.GetUtcNow().UtcDateTime; // TimeProvider, .NET 8+
    var user = _currentUser.UserId ?? "system";

    foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
    {
        switch (entry.State)
        {
            case EntityState.Added:
                entry.Entity.CreatedOnUtc = now;
                entry.Entity.CreatedBy = user;
                break;

            case EntityState.Modified:
                entry.Entity.ModifiedOnUtc = now;
                entry.Entity.ModifiedBy = user;
                break;

            case EntityState.Deleted:
                // optional: convert hard delete to soft delete here
                break;
        }
    }
}
```

Тонкость, которую стоит отметить: сущность, единственное изменённое свойство которой -- членство в owned-коллекции, или чьё изменение касается связанной сущности, может появиться здесь как `Modified`. Если вы хотите игнорировать "изменено только потому, что изменился дочерний элемент", вы можете дополнительно проверить `entry.Properties.Any(p => p.IsModified)`. Для большинства случаев использования столбцов аудита простая проверка `State` -- это то, что вам нужно.

Внедряйте `TimeProvider`, а не вызывайте `DateTime.UtcNow` напрямую. Это делает перехватчик пригодным для модульного тестирования с поддельными часами, что важно, потому что временная метка -- это именно то, что вы больше всего хотите проверять в тестах.

## Регистрация перехватчика с правильным временем жизни

Вот подводный камень, порождающий больше всего отчётов об ошибках. Перехватчику нужен текущий пользователь, который обычно берётся из `IHttpContextAccessor`. Это делает перехватчик фактически scoped (на запрос). Но наивный `AddInterceptors(new AuditableEntityInterceptor())` создаёт похожий на singleton экземпляр без DI.

Зарегистрируйте перехватчик в DI и разрешайте его при настройке контекста:

```csharp
// .NET 11, ASP.NET Core 11 -- Program.cs
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, HttpContextCurrentUser>();
builder.Services.AddScoped<AuditableEntityInterceptor>();

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(
        sp.GetRequiredService<AuditableEntityInterceptor>());
});
```

Поскольку `AddDbContext` по умолчанию scoped, а коллбэк настройки получает scoped на запрос `IServiceProvider`, разрешение scoped перехватчика здесь даёт каждому запросу собственный экземпляр с правильным `ICurrentUser`. Если вы зарегистрируете перехватчик как singleton, в то время как он зависит от `IHttpContextAccessor`, вы либо захватите устаревший `HttpContext`, либо споткнётесь о проверку "Cannot consume scoped service from singleton". Если вы видели именно это сообщение, [исправление cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) разбирает, почему контейнер его отклоняет.

Читайте пользователя через accessor в момент, когда выполняется `SavingChanges`, а не в конструкторе, чтобы поиск всегда отражал активный запрос:

```csharp
// .NET 11, C# 14
public sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

## Запись полного журнала изменений, а не только временных меток

Проставление столбцов отвечает на вопрос "кто и когда трогал эту строку". Журнал изменений отвечает на вопрос "что именно изменилось". Для этого вы обходите изменённые свойства и записываете исходные значения против текущих. EF Core даёт вам оба через `PropertyEntry`.

```csharp
// .NET 11, EF Core 11, C# 14
private static List<AuditTrail> BuildTrail(DbContext context, DateTime now, string user)
{
    var trail = new List<AuditTrail>();

    foreach (var entry in context.ChangeTracker.Entries())
    {
        if (entry.Entity is AuditTrail) continue; // never audit the audit table
        if (entry.State is EntityState.Detached or EntityState.Unchanged) continue;

        var record = new AuditTrail
        {
            TableName = entry.Metadata.GetTableName(),
            Action = entry.State.ToString(),
            UserId = user,
            TimestampUtc = now,
            Changes = new Dictionary<string, object?>()
        };

        foreach (var prop in entry.Properties)
        {
            if (entry.State == EntityState.Added)
                record.Changes[prop.Metadata.Name] = prop.CurrentValue;
            else if (entry.State == EntityState.Modified && prop.IsModified)
                record.Changes[prop.Metadata.Name] =
                    new { Old = prop.OriginalValue, New = prop.CurrentValue };
            else if (entry.State == EntityState.Deleted)
                record.Changes[prop.Metadata.Name] = prop.OriginalValue;
        }

        trail.Add(record);
    }

    return trail;
}
```

Сериализуйте `Changes` в столбец JSON, и у вас есть запрашиваемая история. Обратите внимание, что `entry.Properties` перечисляет только скалярные свойства; навигации и owned-типы требуют `entry.References` и `entry.Collections`, если они вас интересуют.

## Проблема временных ключей и почему существует SavedChanges

Для вставленных строк со сгенерированными базой данных ключами `prop.CurrentValue` во время `SavingChanges` -- это временная заглушка, а не реальное значение identity. EF Core ещё не общался с базой данных. Если ваш журнал аудита записывает первичный ключ новых строк, захват его в `SavingChanges` пишет неправильное значение.

Это и есть единственная причина, по которой существует `SavedChanges`. Чистый подход двухфазный: постройте строки аудита в `SavingChanges`, удержите их на экземпляре перехватчика, затем разрешите теперь уже реальные значения ключей и сохраните журнал в `SavedChangesAsync`.

```csharp
// .NET 11, EF Core 11, C# 14
private readonly List<(EntityEntry Entry, AuditTrail Record)> _pending = [];

public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
    DbContextEventData eventData, InterceptionResult<int> result,
    CancellationToken ct = default)
{
    _pending.Clear();
    var ctx = eventData.Context!;
    foreach (var entry in ctx.ChangeTracker.Entries())
        // ... stash (entry, partial record) into _pending
    return base.SavingChangesAsync(eventData, result, ct);
}

public override async ValueTask<int> SavedChangesAsync(
    SaveChangesCompletedEventData eventData, int result,
    CancellationToken ct = default)
{
    foreach (var (entry, record) in _pending)
        record.EntityId = entry.Property("Id").CurrentValue?.ToString();

    // persist _pending to the audit store now that keys are real
    return await base.SavedChangesAsync(eventData, result, ct);
}
```

Поскольку перехватчик теперь хранит состояние на каждое сохранение в `_pending`, он должен быть scoped или transient, никогда не общим singleton. Singleton переплёл бы `_pending` между параллельными запросами и испортил бы журнал. Это ещё одна причина, по которой приведённая выше регистрация в DI использует `AddScoped`.

Если вы обходите `ChangeTracker` на горячем пути и `DetectChanges` всплывает в профилировании, [API `GetEntriesForState` в EF Core 11 пропускает полный обход DetectChanges](/ru/2026/04/efcore-11-changetracker-getentriesforstate/), когда вам нужны только сущности в определённом состоянии.

## Подводный камень, незаметно пропускающий ваш аудит: ExecuteUpdate и ExecuteDelete

`SaveChangesInterceptor` срабатывает только для `SaveChanges` и `SaveChangesAsync`. Массовые операции `ExecuteUpdate` и `ExecuteDelete` транслируются напрямую в один SQL-оператор и никогда не загружают сущности в `ChangeTracker`, поэтому они полностью обходят ваш перехватчик аудита. Это сделано намеренно и является частым источником путаницы "почему этого изменения нет в журнале аудита".

```csharp
// This UPDATE is NOT audited -- it never touches the ChangeTracker
await db.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled));
```

Если путь кода должен аудироваться, либо проведите его через отслеживаемые сущности и `SaveChanges`, либо аудируйте массовую операцию явно на месте вызова. Компромиссы между двумя стилями записи разобраны в руководстве по [ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Выбирайте массовый путь ради пропускной способности, примите, что он находится вне перехватчика, и сделайте это явным решением, а не сюрпризом.

## Мягкие удаления из того же хука

Поскольку перехватчик видит записи `EntityState.Deleted` до того, как сгенерирован SQL, это естественное место для преобразования жёсткого удаления в мягкое. Переключите состояние на `Modified` и установите ваш флаг:

```csharp
// .NET 11, EF Core 11, C# 14
case EntityState.Deleted when entry.Entity is ISoftDeletable sd:
    entry.State = EntityState.Modified;
    sd.IsDeleted = true;
    sd.DeletedOnUtc = now;
    sd.DeletedBy = user;
    break;
```

Сочетайте это с глобальным фильтром запросов (`modelBuilder.Entity<T>().HasQueryFilter(e => !e.IsDeleted)`), чтобы мягко удалённые строки исчезали из обычных запросов. Просто помните, что перехватчик и фильтр -- это две половины одной возможности: перехватчик пишет флаг, фильтр его скрывает.

## Проверка, что это работает

Перехватчики легко тестировать модульно, потому что это обычные классы. Создайте один с поддельными `TimeProvider` и `ICurrentUser`, добавьте сущность в контекст, настроенный с перехватчиком, вызовите `SaveChangesAsync` и проверьте проставленные значения. Для сквозного покрытия контекст in-memory или SQLite с перехватчиком, зарегистрированным через `AddInterceptors`, прогоняет реальный конвейер EF. Если вы строите этот тестовый каркас вокруг поддельного контекста, правила сохранения отслеживания изменений в целости приведены в [как замокать DbContext, не сломав отслеживание изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/), а если ваши записи аудита начинают выбрасывать исключения о параллельном использовании контекста, см. [a second operation was started on this context instance](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/).

Краткая версия: наследуйтесь от `SaveChangesInterceptor`, переопределите и `SavingChanges`, и `SavingChangesAsync`, обойдите `ChangeTracker.Entries()` ради данных, зарегистрируйте перехватчик как scoped через DI, чтобы он мог читать текущего пользователя, используйте `SavedChangesAsync`, когда вам нужны реальные ключи, и помните, что `ExecuteUpdate`/`ExecuteDelete` обходят всё это стороной. Это покрывает подавляющее большинство реальных требований к аудиту в .NET без единой строки кода аудита, просачивающейся в вашу доменную логику.

Первоисточник: [документация по перехватчикам EF Core](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors) на Microsoft Learn, которая включает канонический пример с отдельной базой данных аудита, на котором строится эта статья.
