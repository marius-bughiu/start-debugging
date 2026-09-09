---
title: "Исправление: Complex entry original ordinal '-1' is invalid при сохранении комплексной коллекции с ToJson"
description: "Обновите Microsoft.EntityFrameworkCore до 10.0.10 или новее. До этой версии рост вложенной коллекции внутри второго комплексного свойства с ToJson ломал SaveChanges."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "change-tracker"
  - "json"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection"
translatedBy: "claude"
translationDate: 2026-09-09
---

Обновите `Microsoft.EntityFrameworkCore` до 10.0.10 или новее. В версиях с 10.0.0 по 10.0.9, если сущность отображала два и более комплексных свойства через `ToJson()`, а вложенная в одно из них коллекция получала новый элемент между загрузкой и сохранением, трекер изменений переводил все уплощённые комплексные записи в `Modified` или `Unchanged`, включая те, что законно находились в состоянии `Added`. У элемента `Added` исходный порядковый номер равен `-1` по замыслу, поэтому смена состояния упиралась прямо в `ValidateOrdinal` и выбрасывала исключение. Исправление представляет собой однострочную проверку в `InternalEntryBase`, оно не зависит от провайдера, и после обновления никакую конфигурацию менять не нужно.

## Ошибка в контексте

Исключение возникает из `SaveChanges` или `SaveChangesAsync`, до отправки какого-либо SQL:

```
System.InvalidOperationException: Complex entry original ordinal '-1' is invalid for property
'XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner' as it's outside of the collection
of length '1'.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.
      InternalComplexCollectionEntry.ValidateOrdinal(InternalComplexEntry entry, Boolean original)
```

Путь к свойству в сообщении представляет собой уплощённую цепочку, а не выражение C#. `[]` обозначает переход через комплексную коллекцию, поэтому `XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner` читается как "коллекция `Inner` в `XInnerEntry`, которая находится внутри элемента `XDeepItem`, который находится внутри элемента `XMiddleData`, который висит на `XDeepData` в `XWidget`". Этот путь и есть самый быстрый способ добраться до проблемного свойства.

Перед тем как двигаться дальше, стоит проверить две детали, потому что именно они отличают эту ошибку от похожих. Во-первых, в сообщении сказано **original ordinal** и **for property**. В родственном сообщении сказано **ordinal** и **for the collection**, и у него другая первопричина. Во-вторых, число в конце относится к размеру *исходной* коллекции, той, которую EF загрузил из базы данных, а не той, которую вы пытаетесь сохранить.

## Почему порядковый номер равен -1: что EF Core на самом деле отслеживает в комплексной коллекции

Комплексные коллекции появились в EF Core 10, и в реляционных провайдерах они должны отображаться в один столбец JSON через `ToJson()`. Отдельная таблица для них невозможна. Это ограничение здесь принципиально: раз нет ни таблицы, ни ключа, EF не может опознать элемент по первичному ключу, как он делает это для owned-сущности. Он опознаёт элемент по **позиции в массиве**.

Поэтому трекер изменений хранит по две позиции на элемент, в `InternalComplexEntry`:

```csharp
// EF Core 10.0 / 11.0, src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs
public int Ordinal
{
    // -1 is used to indicate that the entry is deleted
    get;
    set { /* ... */ }
}

public int OriginalOrdinal
{
    // -1 is used to indicate that the entry is added
    get;
    set { /* ... */ }
}
```

`Ordinal` указывает, где элемент находится в коллекции, которую вы собираетесь сохранить. `OriginalOrdinal` указывает, где он находился в коллекции, которую материализовал EF. Два сигнальных значения объясняют всё:

- У **удалённого** вами элемента нет позиции в текущей коллекции, поэтому его `Ordinal` равен `-1`.
- У **добавленного** вами элемента нет позиции в исходной коллекции, поэтому его `OriginalOrdinal` равен `-1`.

Каждый переход в отслеживаемое состояние прогоняет соответствующий порядковый номер через проверку границ:

```csharp
// EF Core 10.0, InternalEntryBase.InternalComplexCollectionEntry.ValidateOrdinal
public readonly int ValidateOrdinal(InternalComplexEntry entry, bool original, List<InternalComplexEntry?> entries)
{
    var ordinal = original ? entry.OriginalOrdinal : entry.Ordinal;
    if (ordinal < 0 || ordinal >= entries.Count)
    {
        var property = entry.ComplexProperty;
        throw new InvalidOperationException(
            original
                ? CoreStrings.ComplexCollectionEntryOriginalOrdinalInvalid(/* ... */)
                : CoreStrings.ComplexCollectionEntryOrdinalInvalid(/* ... */));
    }
    // ...
}
```

Сама по себе эта проверка корректна. `-1` действительно выходит за границы. Ошибка была в том, что выше по стеку что-то просило запись `Added` стать `Modified`, а `Added -> Modified` это как раз тот переход, который валидирует исходный порядковый номер. Запись, у которой по замыслу должно быть `OriginalOrdinal == -1`, проталкивалась через путь кода, который это запрещает.

Вызывающей стороной был `SetComplexCollectionModified`. Когда обнаружение изменений решало, что комплексная коллекция изменилась, оно обходило `GetFlattenedComplexEntries()`, возвращающий все комплексные записи во всём вложенном графе сущности, и переводило каждую в `Modified` или `Unchanged`. Только что добавленные элементы попадали под раздачу вместе со всеми остальными.

## Минимальное воспроизведение: два комплексных свойства JSON и растущая вложенная коллекция

Автор [dotnet/efcore#38299](https://github.com/dotnet/efcore/issues/38299) свёл триггер к четырём условиям, которые должны выполняться одновременно:

1. Сущность отображает два и более комплексных свойства через `ToJson()`.
2. Один из этих документов JSON содержит вложенные объекты, которые сами содержат коллекции.
3. Тип элемента вложенной коллекции объявляет два и более свойства-подколлекции `List<T>`.
4. Одна из этих подколлекций растёт между загрузкой и сохранением.

Стоит нарушить любое из них, и сущность сохраняется без проблем, поэтому в реальной кодовой базе это выглядит как плавающий сбой. Вот наименьшая модель, удовлетворяющая всем четырём:

```csharp
// .NET 10, EF Core 10.0.7, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.1
public class Widget
{
    public int Id { get; set; }
    public required FlatData Flat { get; set; }   // JSON column 1
    public required DeepData Deep { get; set; }   // JSON column 2
}

public class FlatData
{
    public string? Note { get; set; }
}

public class DeepData
{
    public List<MiddleData> Middle { get; set; } = [];
}

public class MiddleData
{
    public string Name { get; set; } = "";
    public List<InnerEntry> Inner { get; set; } = [];   // sub-collection 1
    public List<InnerEntry> Extra { get; set; } = [];   // sub-collection 2
}

public class InnerEntry
{
    public string Value { get; set; } = "";
}
```

Отображение использует `ComplexProperty` для двух корней и `ComplexCollection` для всего вложенного. `ToJson()` на корне достаточно: вложенные коллекции наследуют отображение в JSON:

```csharp
// .NET 10, EF Core 10.0.7
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Widget>(b =>
    {
        b.ComplexProperty(w => w.Flat, c => c.ToJson());

        b.ComplexProperty(w => w.Deep, c =>
        {
            c.ToJson();
            c.ComplexCollection(d => d.Middle, m =>
            {
                m.ComplexCollection(x => x.Inner);
                m.ComplexCollection(x => x.Extra);
            });
        });
    });
}
```

И две строки, которые всё ломают:

```csharp
// .NET 10, EF Core 10.0.7. Throws on SaveChangesAsync, before any SQL is generated.
var widget = await db.Widgets.SingleAsync(w => w.Id == 1);
widget.Deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });
await db.SaveChangesAsync();
```

Ничего экзотичного здесь нет. Именно к такой форме вы приходите, как только следуете собственному совету Microsoft и переносите отображённый в JSON граф owned-сущностей на комплексные типы, поэтому сообщения об ошибке концентрируются у команд, выполняющих эту миграцию. Если вы взвешиваете такой переход, [комплексные типы против owned-сущностей в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) разбирает компромиссы, а [пошаговое руководство по отображению](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) разбирает конфигурацию.

## Исправление в деталях

### Обновитесь до EF Core 10.0.10 или новее

Это и есть настоящее исправление, выпущенное в [PR #38373](https://github.com/dotnet/efcore/pull/38373) в ветку `release/10.0`. Поднимите все пакеты EF Core одновременно, включая провайдер:

```xml
<!-- .NET 10. Bump the provider package to a matching 10.0.x too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.12" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.12" />
```

Изменение учит рекурсивный обход не трогать записи в состоянии `Added`:

```csharp
// EF Core 10.0.10+, InternalEntryBase.SetComplexCollectionModified
if (recurse)
{
    var newElementState = isModified ? EntityState.Modified : EntityState.Unchanged;
    foreach (var complexEntry in GetFlattenedComplexEntries())
    {
        // Added elements represent pending additions with no original ordinal, so forcing them to
        // Modified/Unchanged is incorrect and would fail the original ordinal validation. Leave their
        // state (computed by change detection) untouched, mirroring the bulk state-change logic in
        // InternalComplexCollectionEntry.SetState.
        if (!UseOldBehavior38299
            && complexEntry.EntityState is EntityState.Added)
        {
            continue;
        }

        complexEntry.SetEntityState(newElementState, modifyProperties: true);
    }
}
```

Из чтения патча следуют две вещи. Проверка находится в общем трекере изменений, выше абстракции провайдера, поэтому одним разом чинит SQL Server, Npgsql и SQLite; если вы надеялись, что поможет обновление одного лишь провайдера, оно не поможет. И та же проверка присутствует в кодовой базе EF Core 11 без флага `UseOldBehavior38299`, так что обновление до EF Core 11 тоже снимает проблему.

### Если вы закреплены ниже 10.0.10, пишите столбец JSON в обход трекера изменений

Сбой целиком живёт в отслеживании изменений. `ExecuteUpdateAsync` к нему вообще не обращается, а EF Core 10 умеет напрямую адресовать комплексное свойство, отображённое в JSON:

```csharp
// .NET 10, EF Core 10.0.7. Untracked read, then a set-based write.
var deep = await db.Widgets
    .AsNoTracking()
    .Where(w => w.Id == id)
    .Select(w => w.Deep)
    .SingleAsync();

deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });

await db.Widgets
    .Where(w => w.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Deep, deep));
```

Взамен вы теряете обычные гарантии `SaveChanges`: нет проверки токена оптимистичной конкурентности, нет перехватчиков на записи, и документ JSON переписывается целиком, а не по одному изменённому пути. Проверьте трансляцию на своём провайдере, прежде чем закладываться на этот вариант, а если вы обращаетесь к `ExecuteUpdate` шире, компромиссы разобраны в [ExecuteUpdate против загрузки сущностей и SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

### Если вы можете изменить модель, нарушьте одно из четырёх условий

Условие 1 устранить дешевле всего. Обход порождает плохую пару из `Added` и `-1` только тогда, когда сущность несёт больше одного комплексного свойства JSON, поэтому отображение второго через table splitting выводит его из игры:

```csharp
// .NET 10, EF Core 10.0.7. Flat becomes Flat_Note on the Widgets table.
b.ComplexProperty(w => w.Flat);   // no ToJson()
```

Это требует миграции и меняет форму хранения, так что относитесь к нему как к последнему средству, а не как к быстрой разблокировке. Условие 3 это вторая мягкая цель: если вложенный тип элемента объявляет лишь одну `List<T>`, форма выпадает из описанного триггера. Ни то, ни другое не является гарантией команды EF, это вывернутый наизнанку минимизированный список автора отчёта, поэтому проверьте на своей модели, прежде чем на это опираться.

## Тонкости и варианты: остальные ошибки порядкового номера из этого семейства

Ещё три сообщения приходят из того же угла трекера изменений, и их принимают за это.

**`Complex entry ordinal '-1' is invalid for the collection '...' as it's outside of the collection of length 'N'.`** Обратите внимание на формулировку: *ordinal*, а не *original ordinal*, и *for the collection*, а не *for property*. Оно срабатывает, когда вы переводите сущность из `Deleted` обратно в `Unchanged`, то есть при классическом ручном мягком удалении. Это [dotnet/efcore#37724](https://github.com/dotnet/efcore/issues/37724), исправлено в **10.0.6** восстановлением текущего порядкового номера из исходного:

```csharp
// EF Core 10.0.6+, InternalComplexEntry.SetEntityState
if (oldState is EntityState.Detached or EntityState.Deleted
    && newState is not EntityState.Detached and not EntityState.Deleted)
{
    if (!UseOldBehavior37724 && Ordinal == -1)
    {
        Ordinal = OriginalOrdinal;
    }

    ContainingEntry.ValidateOrdinal(this, original: false);
}
```

Если вы реализуете мягкое удаление ручным переключением `EntityState`, подумайте, стоит ли делать это вообще: [именованные фильтры запросов](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) выражают то же намерение, не трогая трекер изменений.

**`Index was out of range. Must be non-negative and less than the size of the collection.`** Это `ArgumentOutOfRangeException`, а не `InvalidOperationException`, и выбрасывается оно после того, как обновление базы данных уже прошло успешно, на фазе принятия изменений. Это [dotnet/efcore#37585](https://github.com/dotnet/efcore/issues/37585), срабатывающее при удалении элемента из комплексной коллекции, элементы которой содержат собственные списки. Тоже исправлено в **10.0.6**.

**`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.`** Присвоение `null` допускающему null комплексному свойству, которое содержит коллекцию, на отслеживаемой сущности, когда во вложенной коллекции два и более элемента. Это [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632), запланировано на **10.0.13**. По состоянию на EF Core 10.0.12, последний стабильный патч, задача остаётся открытой, так что если вы видите именно это сообщение, обновление пока не поможет.

Есть и случай, когда ошибка порядкового номера действительно ваша, а не EF. `ComplexCollectionEntry` предоставляет индексатор и `GetOriginalEntry(int)`, и оба валидируют аргумент:

```csharp
// .NET 10, EF Core 10.0.12. Throws if the collection has fewer than 4 elements.
var entry = db.Entry(widget).ComplexCollection(w => w.Deep.Middle)[3];

// Throws if the collection loaded from the database had fewer than 4 elements,
// even when the current collection is longer.
var original = db.Entry(widget).ComplexCollection(w => w.Deep.Middle).GetOriginalEntry(3);
```

Вторая строка это ловушка. Чтение исходной записи по индексу, который появляется только после ваших добавлений в памяти, даёт ту же формулировку *original ordinal*, что и описанная выше ошибка, но с положительным порядковым номером вместо `-1`. Если в вашем сообщении номер не `-1`, вы смотрите на собственную арифметику индексов.

## Что на самом деле делает переключатель Microsoft.EntityFrameworkCore.Issue38299?

Каждый из этих патчей выпускается в ветке `release/10.0` за переключателем совместимости `AppContext`:

```csharp
// EF Core 10.0.x, InternalEntryBase.InternalComplexCollectionEntry.cs
internal static readonly bool UseOldBehavior37724 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue37724", out var enabled) && enabled;

internal static readonly bool UseOldBehavior38299 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue38299", out var enabled) && enabled;
```

Внимательно прочитайте направление, потому что оно обратно тому, что подсказывает название большинству читателей. Установка переключателя в `true` **восстанавливает старое, сломанное поведение**. Он существует, чтобы команда, построившая обходное решение поверх ошибки, могла принять патч-релиз, не сломав это решение. Это не исправление, и его включение вернёт ровно то исключение, из-за которого вы сюда пришли.

Если старое поведение действительно нужно временно зафиксировать, делать это следует в файле проекта, а не в коде, чтобы значение было установлено до загрузки любого типа EF:

```xml
<!-- .NET 10. Restores pre-10.0.10 behaviour. Do not use this to "fix" the crash. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.Issue38299" Value="true" />
</ItemGroup>
```

Переключатели заодно служат журналом изменений. Выполните `grep` по `UseOldBehavior` в `src/EFCore/ChangeTracking/Internal/`, и вы получите полный список того, что менялось в отслеживании комплексных коллекций на протяжении линейки патчей 10.0: `37724` и `38299` в `InternalEntryBase`, `37585` и `38632` внутри вложенной структуры `InternalComplexCollectionEntry`.

Поскольку все четыре ошибки живут в отслеживании изменений, а не в генерации SQL, ни одна из них не проявляется в журнале запросов, в трассировке профилировщика или в диффе `dotnet ef migrations script`. Первый сигнал это всегда исключение на `SaveChanges` с кадром `ValidateOrdinal` у вершины стека. Увидев этот кадр, прекращайте читать конфигурацию модели и идите сразу к версиям пакетов.

## Похожие материалы

- [Комплексные типы против owned-сущностей в EF Core 11: что выбрать?](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Как отобразить комплексный тип вместо owned-сущности в EF Core 11](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)
- [Как отображать и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [Исправление: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause](/ru/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)
- [Как использовать именованные фильтры запросов для мягкого удаления и мультитенантности в EF Core 11](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)

## Источники

- [dotnet/efcore#38299: ComplexProperty ToJson(): SaveChangesAsync throws "ordinal -1 is invalid" when nested sub-collection grows](https://github.com/dotnet/efcore/issues/38299)
- [dotnet/efcore#38373: исправление, в ветку release/10.0](https://github.com/dotnet/efcore/pull/38373)
- [dotnet/efcore#37724: Can't change state of entity with complex collection](https://github.com/dotnet/efcore/issues/37724)
- [dotnet/efcore#37585: Deleting an item from a ComplexCollection that contains an array results in Error](https://github.com/dotnet/efcore/issues/37585)
- [dotnet/efcore#38632: DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [Комплексные типы, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [InternalComplexEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
