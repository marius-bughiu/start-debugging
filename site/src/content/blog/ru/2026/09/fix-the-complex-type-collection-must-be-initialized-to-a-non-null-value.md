---
title: "Исправление: The complex type collection must be initialized to a non-null value"
description: "В EF Core 10.0.x присвоение null сложному свойству с коллекцией из двух элементов внутри сложной коллекции ToJson ломает DetectChanges. Исправлено в 11.0.0-rc.1."
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
translationOf: "2026/09/fix-the-complex-type-collection-must-be-initialized-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-09
---

У сообщения `The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.` есть две причины, и текст у них одинаковый. Если путь в сообщении указывает на свойство, которому вы просто ничего не присвоили, инициализируйте его (`public List<Entry> Entries { get; set; } = new();`), и на этом всё. Если свойство инициализировано, а исключение вылетает из `DetectChanges` или `SaveChanges`, вы столкнулись с [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632): в EF Core с 10.0.0 по 10.0.12 присвоение `null` сложному свойству, допускающему null, тип которого содержит коллекцию из двух и более элементов, внутри сложной коллекции, размеченной через `ToJson()`, обрушивает обнаружение изменений ещё до генерации SQL. Исправление уже влито и входит в `11.0.0-rc.1`; бэкпорт в 10.0.x помечен вехой 10.0.13 и пока не вышел.

## Ошибка в контексте

Сообщение приходит из `CoreStrings.ComplexCollectionNotInitialized`, и его стоит прочитать посимвольно, потому что ещё четыре сообщения из этого же угла трекера изменений выглядят почти так же:

```
System.InvalidOperationException: The complex type collection 'Root[]Group[]Item.Meta.Entries'
must be initialized to a non-null value before the elements can be accessed.
```

В случае бага важные кадры идут, от внутреннего к внешнему, так: `InternalComplexCollectionEntry.GetEntry`, затем `InternalComplexEntry.set_Ordinal`, затем `InternalComplexCollectionEntry.RemoveEntry` и наконец `ChangeDetector.DetectComplexCollectionChanges`. Если в вашей трассировке стека есть `RemoveEntry` и `set_Ordinal`, перед вами баг EF, а не ваш собственный null. Если же наверху стека ваш собственный вызов `EntityEntry.ComplexCollection(...)`, перед вами причина 1, описанная ниже.

Путь свойства в сообщении представляет собой развёрнутую цепочку, а не выражение C#. `[]` обозначает переход через сложную коллекцию, и за ним следует тип элемента, поэтому `Root[]Group[]Item.Meta.Entries` читается как "коллекция `Entries` у `Meta`, которое принадлежит элементу `Item`, находящемуся внутри элемента `Group`, который лежит в коллекции у `Root`". Этот путь быстрее всего приводит к проблемному свойству в глубокой модели.

## Почему трекер изменений не работает с коллекцией, равной null

Сложные коллекции появились в EF Core 10, и у реляционных провайдеров они [обязаны отображаться в один столбец JSON через `ToJson()`](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types). Отдельная таблица для них невозможна. Именно это ограничение и породило данное сообщение: без таблицы и без ключа EF не может определить элемент по первичному ключу, как он делает это для owned-сущности. Он определяет элемент по его **позиции в списке CLR**.

Поэтому `InternalComplexCollectionEntry` ведёт два параллельных списка записей, один для текущих значений и один для исходных, и каждая выдаваемая запись выводится из той коллекции CLR, которая реально лежит в объекте. `GetEntry` не может выдумать позицию в списке, которого нет:

```csharp
// EF Core 10 and 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
if (original)
{
    if (_containingEntry.GetOriginalValue(_complexCollection) == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionEntryOriginalNull(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
else
{
    if (_containingEntry[_complexCollection] == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionNotInitialized(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
```

Две ветки, два разных сообщения. `ComplexCollectionNotInitialized` относится к текущему значению. Если вместо него вы получаете `The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'`, значит коллекция была `null` в момент материализации строки, а инициализировали вы её позже.

Обратите внимание на то, что делает `ChangeDetector`, потому что это объясняет, почему коллекция, равная null, падает не всегда. `DetectComplexCollectionChanges` читает обе стороны и трактует различие по null как изменение, а не как ошибку:

```csharp
// EF Core 11, ChangeDetector.DetectComplexCollectionChanges
var currentCollection = (IList?)entry[complexProperty];
var originalCollection = (IList?)entry.GetOriginalValue(complexProperty);
var changesFound = currentCollection == null != (originalCollection == null);
```

Оба цикла по элементам защищены проверкой `!= null`. То есть просто равная null коллекция переживает обнаружение изменений; падение случается только тогда, когда что-то обращается к *элементу*.

## Причина 1: свойство-коллекция действительно равно null

Здесь сообщение делает ровно то, для чего написано. Оно срабатывает, как только вы обращаетесь по индексу к записи трекера изменений для коллекции, которой никогда ничего не присваивали:

```csharp
// .NET 10, EF Core 10.0.12. Throws ComplexCollectionNotInitialized.
public class Distributor
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Address> ShippingCenters { get; set; } = null!;  // never assigned
}

var entry = db.Entry(distributor).ComplexCollection(d => d.ShippingCenters)[0];
```

Рекомендация Microsoft на этот счёт прямолинейна: инициализируйте коллекцию прямо в объявлении, чтобы свойство никогда не могло стать null.

```csharp
// .NET 10, EF Core 10.0.12. The documented shape.
public List<Address> ShippingCenters { get; set; } = new();
```

В отличие от навигационной коллекции, список за вас EF не создаст, и прокси ленивой загрузки эту дыру не прикроет. Прежде чем идти охотиться за багом, стоит проверить два варианта той же причины:

- **Свойство-коллекция, допускающее null.** Если вы объявили `List<Address>? ShippingCenters`, а в столбце JSON лежит SQL-`NULL`, материализация честно вернёт вам `null`, и первое же обращение к элементу упадёт. Либо сделайте свойство не допускающим null и заполните столбец значением `'[]'`, либо проверяйте на null перед тем, как трогать трекер изменений.
- **Сложное свойство, допускающее null, внутри пути.** В `Root[]Group[]Item.Meta.Entries` коллекция `Entries` вполне может быть инициализирована в каждом создаваемом вами `Meta`, но если само `Meta` равно `null`, то никакого `Entries` для чтения нет. Ровно такая форма и лежит в основе бага EF, описанного ниже, и её же вы можете воспроизвести сами, обратившись по индексу к трекеру для элемента, у которого только что очистили `Meta`.

Если этот стиль отображения для вас новый, [сложные типы против owned-сущностей в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) объясняет, чем поведение сложных типов отличается от графов owned-сущностей, от которых сейчас уходит большинство, а [пошаговое руководство по отображению](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) разбирает саму конфигурацию.

## Причина 2: dotnet/efcore#38632, путь переиндексации

Интересен тот случай, когда все коллекции в модели инициализированы, а исключение всё равно вылетает из `SaveChangesAsync`. Должны совпасть четыре условия, и в реальной модели они встречаются достаточно часто, чтобы люди попадали сюда, не делая ничего необычного.

```csharp
// .NET 10, EF Core 10.0.12. Complex types are never discovered by convention,
// so every value type here carries [ComplexType].
public class Root
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Group> Groups { get; set; } = new();
}

[ComplexType]
public class Group
{
    public required string Title { get; set; }
    public List<Item> Items { get; set; } = new();
}

[ComplexType]
public class Item
{
    public required string Sku { get; set; }
    public Meta? Meta { get; set; }               // nullable complex property
}

[ComplexType]
public class Meta
{
    public required string Kind { get; set; }     // optional complex types need one required property
    public List<Entry> Entries { get; set; } = new();
}

[ComplexType]
public class Entry
{
    public required string Key { get; set; }
    public string? Value { get; set; }
}
```

```csharp
// .NET 10, EF Core 10.0.12. On relational providers a complex collection must be JSON.
modelBuilder.Entity<Root>()
    .ComplexCollection(r => r.Groups, g => g.ToJson());
```

И сама модификация, примерно настолько обыденная, насколько вообще бывает связка загрузить-изменить-сохранить:

```csharp
// .NET 10, EF Core 10.0.12. Throws inside DetectChanges, before any SQL is sent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);

var item = root.Groups[0].Items[0];
// item.Meta.Entries came back from the JSON column with two elements.
item.Meta = null;

await db.SaveChangesAsync();
```

Присвоение `Meta` значения null удаляет содержащую сложную запись. Удаление запускает переиндексацию записей, стоявших после неё, а эта переиндексация присваивает `Ordinal` каждой уцелевшей записи, что снова приводит в `GetEntry` для `Meta.Entries`. К этому моменту `Meta` уже равно `null`, поэтому показанная выше ветка текущего значения выбрасывает исключение. Если в `Entries` один элемент или ни одного, переиндексировать нечего, и тот же самый код сохраняется без ошибок. Именно поэтому баг со стороны выглядит настолько произвольным.

Автор отчёта столкнулся с проблемой на 10.0.9 и 10.0.10, комментатор подтвердил её заново на 10.0.11 2026-08-15, и задача до сих пор открыта относительно 10.0.12, текущего стабильного патча. Проблема не зависит от провайдера и подтверждена как на Npgsql, так и на SQLite, потому что падение происходит в общем трекере изменений, выше уровня абстракции провайдера. Обновление одного лишь провайдера не поможет.

## Исправление в деталях

### Перейти на EF Core 11 RC1

[PR #38667](https://github.com/dotnet/efcore/pull/38667) был влит в `main` 2026-07-20 с вехой 11.0-rc1, так что исправление уже сегодня есть в пакетах `11.0.0-rc.1.26425.128`. Изменение сводится к перестановке, а не к новой логике: отслеживаемые записи теперь возвращаются раньше проверки коллекции CLR на null, поэтому переиндексация во время очистки работает даже тогда, когда родительское сложное значение уже стало `null`.

```csharp
// EF Core 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
// Must check tracked entries first to allow reindexing during cleanup when the parent is null.
var existingEntries = original ? _originalEntries : _entries;
if (existingEntries != null
    && (uint)ordinal < (uint)existingEntries.Count
    && existingEntries[ordinal] is { } existingEntry)
{
    return existingEntry;
}
```

```xml
<!-- .NET 10 or .NET 11. Bump the provider package to a matching 11.0.0-rc.1 too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="11.0.0-rc.1.26425.128" />
```

EF Core 11 станет стабильным вместе с .NET 11 в ноябре 2026 года, так что окно предварительной версии здесь короткое, а не бессрочное. Это всё же предварительная версия, поэтому перед выкаткой прочитайте остальные примечания к выпуску EF Core 11.

### Следить за 10.0.13, если нужен сервисный выпуск

Задачу переоткрыли после исправления в `main` именно для того, чтобы отследить бэкпорт в `release/10.0`, и она несёт веху 10.0.13. Если вы находитесь в поддерживаемой сервисной линии и не можете взять предварительную версию, ждать нужно именно её. До этого обновление внутри 10.0.x проблему не снимет.

### Разделить модификацию на два SaveChanges

Триггеру нужны два и более элемента во вложенной коллекции в тот момент, когда родитель становится null. Если уменьшить коллекцию отдельным сохранением, чтобы и текущий, и исходный снимок были пустыми до обнуления родителя, переиндексация не понадобится вовсе:

```csharp
// .NET 10, EF Core 10.0.12. Two round trips, no reindex over a null parent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);
var item = root.Groups[0].Items[0];

item.Meta!.Entries.Clear();
await db.SaveChangesAsync();   // original values are accepted here

item.Meta = null;
await db.SaveChangesAsync();
```

Это вывернутый наизнанку минимальный список условий из отчёта, а не гарантия от команды EF, и обходится он в лишний обмен с базой данных и потерю атомарности одного сохранения. Оберните оба вызова в явную транзакцию, если промежуточное состояние не должно быть видно другим читателям, и проверьте всё на своей модели, прежде чем полагаться на этот приём.

### Писать столбец JSON мимо трекера изменений

Падение целиком живёт в обнаружении изменений, а `ExecuteUpdateAsync` к нему даже не подходит. EF Core 10 умеет адресовать сложную коллекцию, отображённую в JSON, напрямую:

```csharp
// .NET 10, EF Core 10.0.12. Untracked read, then a set-based write.
var groups = await db.Roots
    .AsNoTracking()
    .Where(r => r.Id == id)
    .Select(r => r.Groups)
    .SingleAsync();

groups[0].Items[0].Meta = null;

await db.Roots
    .Where(r => r.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(r => r.Groups, groups));
```

За эту запись вы платите обычными гарантиями `SaveChanges`: нет проверки оптимистичной параллельности, нет перехватчиков `SaveChanges`, и переписывается весь документ JSON, а не единственный изменённый путь. Если вы собираетесь применять такой подход шире, компромиссы разобраны в статье [ExecuteUpdate против загрузки сущностей и SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

## Похожие сообщения, приводящие на эту страницу

Ещё четыре строки в `CoreStrings` упоминают сложные коллекции и значения null и к #38632 отношения не имеют.

**`The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'.`** Это `ComplexCollectionEntryOriginalNull`, соседняя ветка того же `if`. Коллекция была `null` в момент материализации строки. Читать исходные значения коллекции, у которой их никогда не было, это не баг, а вопрос без ответа. Перечитайте сущность или перестаньте читать исходные значения по этому пути.

**`The value for the property '...' cannot be set, because it's on the complex type collection element '...[N]' that contains a 'null' value.`** Это `ComplexCollectionNullElementSetter`. Коллекция существует, но один из её *элементов* равен `null`. Достаточно массива JSON вида `[{...}, null]`. Отфильтруйте null перед сохранением или перестаньте записывать их в массив.

**`Complex entry original ordinal '-1' is invalid for property '...' as it's outside of the collection of length 'N'.`** Другой баг с другим исправлением, разобранный в статье [Complex entry original ordinal '-1' is invalid при сохранении сложной коллекции ToJson](/ru/2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection/). Обратите внимание на формулировку: *original ordinal* и *for property*. Тот баг исправлен в 10.0.10, поэтому, в отличие от нынешнего, обновление внутри 10.0.x его снимает.

**`The complex type collection '...' cannot be configured because complex value type collections are not supported.`** Это `ComplexValueTypeCollection`, и выбрасывается оно на этапе построения модели, а не при сохранении. Элементы сложной коллекции должны быть ссылочными типами; `List<Coordinate>`, где `Coordinate` объявлен как `readonly record struct`, отобразить не получится. Следите за [dotnet/efcore#31411](https://github.com/dotnet/efcore/issues/31411), если вам это нужно.

Если ваша ошибка упоминает `AS JSON option can be specified only for column of nvarchar(max)`, то это проблема типа столбца в SQL Server, а не трекера изменений, и разобрана она отдельно в статье [про исправление AS JSON на Azure SQL](/ru/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/). Общую картину отображения даёт статья [как отображать и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Источники

- [dotnet/efcore#38632: ComplexCollection + ToJson(): DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [dotnet/efcore#38667: исправление, влито 2026-07-20](https://github.com/dotnet/efcore/pull/38667)
- [Сложные типы, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [Выпуски и планирование EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
- [ChangeDetector.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/ChangeDetector.cs)
- [CoreStrings.resx, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx)
