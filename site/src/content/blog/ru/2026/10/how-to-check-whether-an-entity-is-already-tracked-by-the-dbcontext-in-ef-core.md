---
title: "Как проверить, отслеживается ли сущность в DbContext, перед её подключением в EF Core"
description: "Используйте DbSet.Local.FindEntry(key), чтобы спросить у трекера изменений, отслеживается ли сущность с заданным ключом, без обращения к базе данных и без перебора. Почему Entry(entity).State вводит в заблуждение, почему Find выполняет запрос, и проверенный помощник AttachOrMerge для EF Core 10."
pubDate: 2026-10-11
template: how-to
tags:
  - "ef-core"
  - "dotnet-10"
  - "csharp"
  - "change-tracker"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Краткий ответ:** вызовите `db.Set<T>().Local.FindEntry(id)`. Метод возвращает отслеживаемый `EntityEntry<T>` для этого первичного ключа или `null`, если с таким ключом ничего не отслеживается, и никогда не обращается к базе данных. Если вернулась запись, скопируйте свои значения в неё через `entry.CurrentValues.SetValues(incoming)` вместо подключения. Если вернулся `null`, `Attach` или `Update` безопасны. Для составных ключей используйте `Local.FindEntryUntyped([part1, part2])`. Не используйте для этой проверки `db.Entry(incoming).State == EntityState.Detached`: она говорит только об этом конкретном экземпляре объекта, а не о ключе.

Всё ниже запускалось на EF Core 10.0.12 (`Microsoft.EntityFrameworkCore.Sqlite` 10.0.12) на .NET 10 SDK 10.0.302. Семейство `LocalView<T>.FindEntry` появилось в EF Core 8 ([dotnet/efcore#29686](https://github.com/dotnet/efcore/pull/29686)), поэтому тот же код работает на EF Core 8, 9, 10 и на release candidate версиях EF Core 11.

## Почему вопрос "отслеживается ли она?" касается ключей, а не объектов

Трекер изменений ведёт identity map: для каждого типа сущности один отслеживаемый экземпляр CLR на каждое значение первичного ключа. Когда вы вызываете `Attach`, `Update` или `Add` со вторым экземпляром, ключ которого уже есть в этой карте, EF Core выбрасывает знакомое исключение [`The instance of entity type cannot be tracked because another instance with the same key value is already being tracked`](/ru/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

Поэтому вопрос, на который нужно ответить перед подключением, звучит так: "есть ли в identity map *какой-либо* экземпляр с этим ключом?" Это не то же самое, что "отслеживается ли *этот* экземпляр?", а самая часто советуемая проверка отвечает именно на второй вопрос.

## Минимальный пример ловушки

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite
using var db = new Shop(options);

var tracked  = db.Customers.First(c => c.Id == 1);           // tracked, Unchanged
var incoming = new Customer { Id = 1, Name = "changed" };    // e.g. deserialized from a request

Console.WriteLine(db.Entry(tracked).State);   // Unchanged
Console.WriteLine(db.Entry(incoming).State);  // Detached  <-- looks "safe"

db.Attach(incoming);
// InvalidOperationException: The instance of entity type 'Customer' cannot be tracked
// because another instance with the same key value for {'Id'} is already being tracked.
```

`db.Entry(incoming)` без возражений возвращает запись в состоянии `Detached`, потому что `incoming` действительно не отслеживается. Он не выбрасывает исключение и не начинает отслеживать объект (в моём запуске трекер изменений после этого по-прежнему содержал ровно одну запись). Код вида `if (db.Entry(x).State == EntityState.Detached) db.Attach(x);` проходит проверку и тут же падает на следующей строке. Такой приём подходит для вопроса "подключал ли я уже именно этот объект?" и не подходит для отсоединённых сценариев, где объект пришёл из DTO, кеша или тела JSON.

## Варианты, измеренные на практике

Я подключил счётчик к `CoreEventId.DetectChangesStarting` и `DbCommandInterceptor`, считающий выполненные reader-ы, а затем прогнал каждый вариант на контексте, отслеживающем один `Customer`:

| Проверка | Отвечает на вопрос о ключе? | Проходов `DetectChanges` | Запросов к БД |
| --- | --- | --- | --- |
| `db.Entry(incoming).State` | Нет, только про этот экземпляр | 0 | 0 |
| `db.ChangeTracker.Entries<Customer>().Any(e => e.Entity.Id == 1)` | Да, линейным перебором | 1 | 0 |
| `db.Customers.Find(1)` (отслеживается) | Да, возвращает отслеживаемый экземпляр | 0 | 0 |
| `db.Customers.Find(2)` (не отслеживается) | Не проверка: загружает строку | 0 | 1 |
| `db.Customers.Local.FindEntry(1)` | Да, поиском в identity map | 1 (от геттера `Local`) | 0 |
| `cachedLocal.FindEntry(1)` | Да | 0 | 0 |

Несколько моментов бросаются в глаза.

**`Find` не является проверкой отслеживания.** Он сначала смотрит в identity map, поэтому для отслеживаемого случая ничего не стоит, но если ключ не отслеживается, он идёт в базу данных и начинает отслеживать всё, что нашёл. Если использовать `Find`, чтобы решить, подключать ли сущность, то вы либо загрузите ненужную строку, либо получите отслеживаемый экземпляр и затем подключите поверх него собственную копию, что приведёт к исключению.

**`ChangeTracker.Entries<T>()` работает, но перебирает.** Он сначала запускает `DetectChanges`, а затем перечисляет все отслеживаемые записи этого типа. При десяти сущностях это шум. Для долгоживущего контекста в настольном приложении или пакетном задании с десятками тысяч записей выполнение этого для каждого входящего элемента даёт квадратичную сложность. (В EF Core 11 [API `GetEntriesForState`](/ru/2026/04/efcore-11-changetracker-getentriesforstate/) пропускает проход `DetectChanges`, но всё равно остаётся перечислением.)

**`Local.FindEntry` - специально созданный для этого API.** Он разрешает ключ через ту же identity map, которую проверяет `Attach`, поэтому даёт именно тот ответ, на основании которого `Attach` будет действовать. Единственный `DetectChanges` в таблице происходит от геттера свойства `DbSet<T>.Local`, а не от `FindEntry`: когда я сохранил `LocalView<Customer>` в переменную и вызвал `FindEntry` на ней, счётчик остался нулевым. [Документация по API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry) говорит то же самое и рекомендует переиспользовать объект `Local` для повторных поисков.

## Проверить, затем подключить или слить

Вот порядок действий для обновления отсоединённой сущности, то есть сценария, в котором этот вопрос обычно и возникает:

1. Получите локальное представление один раз: `var local = db.Customers.Local;`.
2. Найдите ключ через `local.FindEntry(incoming.Id)`.
3. Если вернулась запись, скопируйте входящие значения в отслеживаемый экземпляр через `entry.CurrentValues.SetValues(incoming)`. EF Core пометит как изменённые только те свойства, значения которых действительно изменились.
4. Если вернулся `null`, этот ключ никем не занят, поэтому `Update(incoming)` (или `Attach` плюс явные флаги `IsModified`) безопасны.
5. Вызовите `SaveChanges` один раз в конце.

В виде помощника:

```csharp
// .NET 10, EF Core 10.0.12
static Customer AttachOrMerge(Shop db, Customer incoming)
{
    var existing = db.Customers.Local.FindEntry(incoming.Id);
    if (existing is null)
    {
        db.Customers.Update(incoming);   // nothing tracked with this key
        return incoming;
    }

    existing.CurrentValues.SetValues(incoming);  // merge into the tracked instance
    return existing.Entity;
}
```

Запуск на контексте, который уже отслеживает клиента 1:

```text
Helper: same=True state=Modified name=merged modifiedProps=Name
```

Возвращённый объект - это экземпляр, который контекст уже отслеживал, его состояние перешло из `Unchanged` в `Modified`, и помечено только `Name`, поэтому сгенерированный `UPDATE` затрагивает один столбец. Возвращайте вызывающему коду отслеживаемый экземпляр, а не `incoming`: после слияния `incoming` остаётся отсоединённым объектом, о котором EF Core ничего не знает.

## Обобщённая версия для любого типа сущности

Помощник на каждую сущность вам вряд ли нужен. `FindEntryUntyped` принимает значения ключа как `IEnumerable<object?>` в порядке следования ключа, а модель подскажет, какие свойства образуют первичный ключ:

```csharp
// .NET 10, EF Core 10.0.12
static EntityEntry<T>? FindTrackedEntry<T>(DbContext db, T entity) where T : class
{
    var key = db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!;
    var entry = db.Entry(entity);   // Detached entry, does not start tracking
    var keyValues = key.Properties
        .Select(p => entry.Property(p.Name).CurrentValue)
        .ToArray();

    return db.Set<T>().Local.FindEntryUntyped(keyValues);
}

static bool IsTracked<T>(DbContext db, params object?[] keyValues) where T : class
    => db.Set<T>().Local.FindEntryUntyped(keyValues) is not null;
```

Чтение ключа через `db.Entry(entity).Property(...)` вместо рефлексии означает, что ключи из shadow-свойств и ключи, отображённые на поля, работают без особых случаев. В примере `FindTrackedEntry(db, incoming)` нашёл отслеживаемого клиента, хотя сам `incoming` был другим объектом, и именно этого поведения не хватает проверке через `Entry(...).State`.

## Подводные камни, на которые вы наткнётесь

### Составным ключам нужен `FindEntryUntyped`, а не `FindEntry`

`FindEntry` обобщённый: `FindEntry<TKey>(TKey keyValue)`. Если передать массив или список, компилятор без возражений свяжет `TKey` с `object[]` или `List<object?>`, а EF Core будет воспринимать всё это как единственное значение ключа:

```csharp
// .NET 10, EF Core 10.0.12. OrderLine has HasKey(x => new { x.OrderId, x.LineNo })
db.OrderLines.Local.FindEntry(new object[] { 10, 1 });
// ArgumentException: Entity type 'OrderLine' is defined with a 2-part composite key,
// but 1 values were passed to the 'Find' method.

db.OrderLines.Local.FindEntryUntyped([10, 1]);   // works, returns the tracked entry
```

Я также попробовал переменную типа `IEnumerable<object?>`, надеясь попасть в необобщённую перегрузку. То же исключение: перегрузки `FindEntry(IEnumerable<object?>)` для первичных ключей не существует, у необобщённой версии собственное имя.

### Тип ключа должен совпадать точно

`FindEntry<TKey>` ничего не преобразует. С ключом типа `int`:

```text
FindEntry(1L): ArgumentException: Property 'Customer.Id' is of type 'int' but the generic type provided is of type 'long'.
```

`FindEntryUntyped` не более снисходителен, он проверяет тип упакованного значения:

```text
FindEntryUntyped([1L]): ArgumentException: The 'FindEntry' or 'GetEntries' method was passed a 'long' value for the 'Id' property, when a 'int' value was expected.
```

Это проявляется, когда ключ приходит из значения маршрута или из универсального репозитория с типом `long` или `object`. Перед вызовом приведите его к типу CLR свойства ключа (`key.Properties[i].ClrType`).

### Удалённые сущности всё ещё отслеживаются

После `db.Customers.Remove(customer2)`:

```text
FindEntry(2) after Remove: Deleted; Local.Count=1; Find(2)=entity
```

Локальная *коллекция* скрывает сущности в состоянии `Deleted` (`Local.Count` упал до 1, [как описано в документации](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries#the-local-view)), но `FindEntry` всё равно возвращает запись, как и `Find`. Для нашей цели это правильно, поскольку ключ всё ещё в identity map и `Attach` всё равно выбросил бы исключение. Но если ваша логика слияния предполагает, что "найдено" означает "живая", проверяйте `entry.State` перед вызовом `SetValues`, иначе вы перенесёте изменения свойств на строку, которую `SaveChanges` вот-вот удалит.

### "Не отслеживается" не означает "существует в базе данных"

Когда `FindEntry` возвращает `null`, помощник вызывает `Update`, который помечает все свойства как изменённые и генерирует `UPDATE`. Для ключа, которого нет в таблице, `SaveChanges` затрагивает ноль строк и выбрасывает `DbUpdateConcurrencyException`. В примере `AttachOrMerge(db, new Customer { Id = 3 })` оставил сущность в состоянии `Modified`, а не `Added`. Если входящий объект может быть новым, решайте это по собственным данным (значение ключа по умолчанию, столбец версии, явный флаг) до выбора между `Add` и `Update`. Другой вариант - вообще отказаться от отслеживания и использовать для записи [`ExecuteUpdate`](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

### Значения ключа по умолчанию для ключей, генерируемых хранилищем

Подключение `Customer` с `Id`, равным `0`, не выбрасывает исключение и не вызывает коллизию: EF Core видит не заданный ключ, генерируемый хранилищем, и отслеживает сущность как `Added` с временным значением. Проверка `FindEntry(0)` заранее ничего полезного там не скажет. Ветвитесь по `entry.IsKeySet` (или `id == default`) до выполнения поиска.

### Поиск по альтернативному или внешнему ключу

У `LocalView<T>` также есть `FindEntry<TProperty>(string propertyName, TProperty value)` и `GetEntries(...)` для поиска не по первичному ключу, например `Local.FindEntry(nameof(Customer.Email), email)`. Они быстры, когда свойство является альтернативным или внешним ключом, потому что EF Core уже поддерживает для них структуры поиска. Для обычных свойств они переходят к перебору отслеживаемых записей. В примере `Local.FindEntry(nameof(Customer.Name), "a")` вернул нужную запись, но `Name` не ключ, так что это был перебор.

### Отключение AutoDetectChanges

При `db.ChangeTracker.AutoDetectChangesEnabled = false` ни геттер `Local`, ни `Entries<T>()` не запускают `DetectChanges` (счётчик 0 в обоих случаях). Поиск по identity map это не затрагивает, поскольку ключи отслеживаемой сущности не могут меняться. Если вы отключаете автоматическое обнаружение для цикла массового импорта, вызывайте `db.ChangeTracker.DetectChanges()` сами перед `SaveChanges`, когда изменяете отслеживаемые сущности напрямую.

## Когда лучшее решение - вообще не отслеживать

Если проверка появилась в вашем коде потому, что более раннее чтение в том же контексте начало отслеживать сущность, которую вы теперь хотите обновить, более чистое решение часто находится выше по потоку. Читайте с `AsNoTracking()`, когда результат только отображается или преобразуется в DTO ([сравнение AsNoTracking и AsNoTrackingWithIdentityResolution](/ru/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) объясняет, что выбрать), и делайте контексты короткоживущими, чтобы одна единица работы не наследовала отслеживаемые сущности другой. `FindEntry` - правильный инструмент, когда один контекст законно видит один и тот же ключ с двух сторон: настольное приложение с долгоживущим контекстом, пакетное задание, сливающее записи из нескольких файлов, или граф, в котором приходят частично пересекающиеся сущности, уже загруженные вами.

Тот же поиск полезен в тестах. Если вы заменили провайдер заглушкой, а ваши проверки зависят от того, что отслеживается, `Local.FindEntry` читает настоящую identity map, что удерживает вас в рамках, описанных в статье о [мокировании DbContext без поломки отслеживания изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

### Читайте дальше

- [Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/ru/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/ru/2026/04/efcore-11-changetracker-getentriesforstate/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/ru/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [ExecuteUpdate vs loading entities and SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Источники

- [`LocalView<TEntity>.FindEntry` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry), Microsoft Learn.
- [`LocalView<TEntity>.FindEntryUntyped` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentryuntyped), Microsoft Learn.
- [Accessing tracked entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries), документация EF Core (Entry, Find, Entries, локальное представление и стоимость его `DetectChanges`).
- [Lookup entities by primary key, alternate key, or foreign key](https://github.com/dotnet/efcore/pull/29686), dotnet/efcore PR #29686 (влит в декабре 2022, вошёл в EF Core 8).
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), документация EF Core.
