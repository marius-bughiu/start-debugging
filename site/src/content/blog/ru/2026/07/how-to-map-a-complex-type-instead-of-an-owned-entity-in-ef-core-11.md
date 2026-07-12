---
title: "Как отобразить составной тип вместо owned-сущности в EF Core 11"
description: "Owned-сущности несут скрытый ключ и ссылочную идентичность, которые противоречат объектам-значениям. Вот как отобразить объект-значение как составной тип в EF Core 11, когда стоит переходить и какие есть подводные камни."
pubDate: 2026-07-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "owned-entities"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Короткий ответ: в EF Core 11 (с .NET 11 и C# 14) отображайте объект-значение вроде `Address` или `Money` через `ComplexProperty`, а не через `OwnsOne`. У составного типа нет ключа и нет идентичности, поэтому EF Core обращается с ним по семантике значений: присваивание копирует поля, сравнение сравнивает содержимое, а `ExecuteUpdate` может затрагивать его свойства. Owned-сущность за кулисами по-прежнему остаётся типом сущности с теневым ключом и ссылочной идентичностью, и именно это является источником сюрпризов, с которыми люди сталкиваются (нельзя присвоить общую ссылку, ломается равенство в LINQ, блокируется массовое обновление). Составные типы появились в EF Core 8, получили опциональное (допускающее null) отображение и JSON-столбцы в EF Core 10, а в EF Core 11 стали пригодны для использования в иерархиях наследования TPT/TPC с более чистым API конфигурации. Переход это изменение конфигурации модели плюс одна миграция.

Этот пост рассматривает, что на самом деле различается между двумя вариантами отображения, точную конфигурацию `ComplexProperty` для разделения таблицы и JSON, как перевести существующее отображение `OwnsOne` без потери данных, и случаи, когда всё ещё приходится прибегать к owned-сущностям.

## Почему owned-сущности никогда не были правильной формой для объекта-значения

Когда в EF Core добавили типы owned-сущностей, их преподносили как способ моделировать объекты-значения: `Address`, который живёт внутри `Customer` и отображается в ту же таблицу. Это работает, но всегда было компромиссом. Owned-сущность **является типом сущности**. EF Core даёт ей первичный ключ (обычно теневой ключ, которым он управляет за вас), отслеживает её в трекере изменений как отдельный узел и рассуждает о ней в терминах ссылочной идентичности. [Документация по owned-сущностям](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities) годами предупреждала об острых краях, вытекающих из этого.

Три из этих краёв цепляют постоянно.

Во-первых, нельзя разделить экземпляр. Выглядит так, будто это должно работать, но не работает:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws with owned entities
```

Поскольку оба свойства относятся к одному и тому же типу сущности, EF Core видит одну сущность, на которую ссылаются дважды, и отклоняет её. Во-вторых, равенство в LINQ сравнивает по идентичности, а не по содержимому, поэтому `context.Customers.Where(c => c.BillingAddress == c.ShippingAddress)` означает не то, что вы думаете. В-третьих, `ExecuteUpdate` вообще не поддерживает свойства owned-сущностей.

Составной тип это то отображение, которое действительно предназначалось для этого. У него нет собственной идентичности. Он полностью определяется своими данными, а это и есть определение объекта-значения. Присваивание копирует поля. Сравнение сравнивает поля. И EF Core 11 поддерживает его в `ExecuteUpdate`. Собственная рекомендация команды EF в [заметках о выпуске EF Core 10](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types) прямолинейна: "пользователям, уже применяющим типы owned-сущностей для этого, рекомендуется перейти на составные типы."

## Минимальное отображение составного типа

Начните с объекта-значения и сущности, которая его содержит. Объекту-значению не нужен ключ, не нужен `Id`, ничего, что пахнет идентичностью:

```csharp
// .NET 11, C# 14, EF Core 11
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; }
    public Address? BillingAddress { get; set; }
}
```

Есть два способа сообщить EF Core, что это составной тип. Fluent API в `OnModelCreating`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>(b =>
    {
        b.ComplexProperty(c => c.ShippingAddress);
        b.ComplexProperty(c => c.BillingAddress);
    });
}
```

Или атрибут `[ComplexType]` на объекте-значении, что позволяет EF Core подхватывать его по соглашению везде, где он используется:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}
```

По умолчанию это отображается в **разделение таблицы**: столбцы адреса живут прямо в таблице `Customers` с префиксом.

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress_Street] nvarchar(max) NOT NULL,
    [ShippingAddress_City] nvarchar(max) NOT NULL,
    [ShippingAddress_PostalCode] nvarchar(max) NOT NULL,
    [BillingAddress_Street] nvarchar(max) NULL,
    [BillingAddress_City] nvarchar(max) NULL,
    [BillingAddress_PostalCode] nvarchar(max) NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

Обратите внимание, что нет отдельной таблицы `Addresses` и нет внешнего ключа. В этом и суть: объект-значение является частью строки своего владельца, без соединения и без идентичности, которой нужно управлять.

## Опциональным (допускающим null) составным типам нужно хотя бы одно обязательное свойство

Приведённое выше `BillingAddress? BillingAddress` работает, потому что EF Core 10 добавил поддержку **опциональных** составных типов. Весь объект может быть null, и EF Core определяет наличие по значениям столбцов. Есть одно правило, на котором люди спотыкаются: у опционального составного типа должно быть хотя бы одно обязательное (не допускающее null) свойство. EF Core использует этот столбец, чтобы отличить "весь адрес равен null" от "адрес присутствует, но его опциональные поля равны null". Если бы каждое свойство `Address` допускало null, у EF Core не было бы сигнала, чтобы различить эти два состояния, и построение модели выбросило бы исключение.

На практике это почти никогда не является ограничением, потому что у реального адреса есть хотя бы одно поле, которое обязано присутствовать. Если у вас действительно есть объект-значение, где каждое поле опционально, добавьте дискриминатор или пересмотрите, должно ли оно вообще допускать null.

## Отображение составного типа в один JSON-столбец

Разделение таблицы разбрасывает поля по столбцам. Если вы предпочли бы держать объект-значение как один непрозрачный JSON-документ, EF Core 10 добавил `ToJson()` для составных свойств, а EF Core 11 сохраняет это стабильным:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress, c => c.ToJson());
    b.ComplexProperty(c => c.BillingAddress, c => c.ToJson());
});
```

На SQL Server 2025 (или Azure SQL) это использует нативный тип столбца `json`:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress] json NOT NULL,
    [BillingAddress] json NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

JSON-отображение даёт вам одну вещь, которую разделение таблицы сделать не может: **коллекции внутри отображаемого типа**. Составной тип, отображённый с разделением таблицы, обязан быть единичным значением, но составной тип, отображённый в JSON, может содержать `List<string>` или вложенный список объектов-значений. Вы по-прежнему можете делать запросы внутрь документа. На SQL Server 2025 `context.Customers.Where(c => c.ShippingAddress.City == "Cluj")` транслируется в поиск `JSON_VALUE`, а EF Core 11 добавляет `EF.Functions.JsonPathExists` и `EF.Functions.JsonContains`, оба из которых работают с составными типами, отображёнными в JSON. Более широкую картину по запросам к данным, отображённым в JSON, см. в [как отображать и запрашивать JSON-столбцы в EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) и в [трансляции JSON_CONTAINS, добавленной на SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/).

## Что на самом деле даёт семантика значений

Как только отображение становится составным типом, три острых края owned-сущностей исчезают.

Разделение экземпляра теперь работает, потому что присваивание копирует поля, а не создаёт псевдоним отслеживаемой ссылки:

```csharp
// .NET 11, EF Core 11 - complex type mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress; // copies the values
await context.SaveChangesAsync(); // succeeds
```

Равенство в LINQ сравнивает содержимое, поэтому это возвращает клиентов, у которых два адреса действительно равны:

```csharp
// .NET 11, EF Core 11
var sameAddress = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress)
    .ToListAsync();
```

А массовое обновление дотягивается внутрь составного типа, чего owned-сущности никогда не позволяли:

```csharp
// .NET 11, EF Core 11
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Если вы взвешиваете пути записи против загрузки и изменения сущностей, компромиссы те же, что рассмотрены в [ExecuteUpdate против загрузки сущностей и SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/); составные типы просто делают случай объекта-значения пригодным для быстрого пути.

Структуры тоже работают, что хорошо согласуется с идеей "нет идентичности":

```csharp
// .NET 11, C# 14, EF Core 11
public struct Money
{
    public required decimal Amount { get; set; }
    public required string Currency { get; set; }
}
```

Записи (record) тоже хорошо подходят, а взаимодействие между записями, составными типами и отслеживанием изменений стоит прочитать целиком в [как правильно использовать записи с EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Перевод существующего отображения OwnsOne на составной тип

Если вы уже поставляете `OwnsOne`, переход механический, и с разделением таблицы он обычно нейтрален к схеме, потому что столбцы именуются и типизируются одинаково. Вот процедура.

1. **Подтвердите текущую форму хранения.** Если ваш `OwnsOne` отображается в таблицу владельца (по умолчанию), столбцы уже имеют вид `Owner_Property`. Если используется `OwnsOne(...).ToTable("Addresses")` (отдельная таблица) или `OwnsOne(...).ToJson()`, отметьте это, потому что целевое хранилище влияет на то, будет ли миграция перемещать данные.
2. **Устраните утечку идентичности из объекта-значения.** Удалите любое свойство `Id`, любую явную конфигурацию ключа и любую навигацию обратно к владельцу. У составного типа не может быть ключа или обратной ссылки.
3. **Замените `OwnsOne` на `ComplexProperty`.** Измените `b.OwnsOne(c => c.ShippingAddress)` на `b.ComplexProperty(c => c.ShippingAddress)`, а `b.OwnsOne(c => c.ShippingAddress, a => a.ToJson())` на `b.ComplexProperty(c => c.ShippingAddress, a => a.ToJson())`. Перенесите конфигурацию отдельных свойств, такую как `HasMaxLength` и `HasColumnName`.
4. **Сделайте опциональные объекты-значения допускающими null в CLR-типе.** Если owned-ссылка могла бы отсутствовать, объявите свойство как `Address?` и убедитесь, что у типа есть хотя бы одно обязательное свойство, чтобы EF Core мог обнаружить null.
5. **Добавьте и проверьте миграцию.** Выполните `dotnet ef migrations add SwitchAddressToComplexType`. Для `OwnsOne` с разделением таблицы в той же таблице миграция должна быть пустой или почти пустой, потому что столбцы не перемещаются. Если она хочет удалить и пересоздать столбцы, значит имена ваших столбцов разошлись; зафиксируйте их через `HasColumnName`, пока diff не станет чистым, чтобы не потерять данные.
6. **Сначала проверьте поведение с сохранением данных на копии.** Примените миграцию к временной базе данных, восстановленной из продакшена, прежде чем запускать её по-настоящему, особенно если вы переходите с отдельной таблицы или с `nvarchar` JSON на нативный тип `json`.

Единственная миграция, которая действительно перемещает данные, это переход с `OwnsOne(...).ToTable("Addresses")` (отдельная таблица) на составной тип с разделением таблицы. Для этого нет чистого автоматически генерируемого пути, потому что строки должны переехать из дочерней таблицы в родительскую. Напишите эту миграцию вручную: добавьте новые столбцы, `UPDATE ... FROM`, чтобы скопировать значения, затем удалите старую таблицу. Если вы уже глубоко в обновлении EF Core, та же осторожность применима к остальной части вашей модели; [руководство по миграции с EF Core 6 на EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) охватывает ломающие изменения, которые обычно всплывают рядом с этим.

## EF Core 11 убирает трение наследования и конфигурации

Две вещи конкретно улучшились в EF Core 11, что упрощает переход.

Составные типы (и JSON-столбцы) теперь работают на сущностях, использующих **наследование TPT (table-per-type) и TPC (table-per-concrete-type)**. До EF Core 11 составное свойство на базовом типе в иерархии TPT/TPC не поддерживалось, что вынуждало возвращаться к owned-сущностям для любого унаследованного объекта-значения. Теперь это отображается корректно:

```csharp
// .NET 11, C# 14, EF Core 11
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Animal>().UseTptMappingStrategy();
```

EF Core 11 создаёт столбцы `Details_BirthDate` и `Details_Veterinarian` в таблице `Animal`, как и ожидалось.

Конфигурация тоже стала короче. Раньше, чтобы добраться до свойства составного типа, нужно было сначала получить построитель составного типа:

```csharp
// Pre-EF Core 11
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.ShippingAddress)
    .Property(a => a.Street)
    .HasMaxLength(200);
```

EF Core 11 позволяет пробрасывать доступ к члену напрямую в `Property`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Property(c => c.ShippingAddress.Street)
    .HasMaxLength(200);
```

EF Core 11 также принёс пакет стабилизирующих исправлений для составных типов, включая корректное сравнение вложенных составных типов, корректное присваивание `ExecuteUpdate` во вложенные свойства и исправление `NullReferenceException`, когда два типа делили допускающее null составное свойство, отображённое в один столбец. Если вы пробовали составные типы в EF Core 9 и натыкались на шероховатости, EF Core 11 это выпуск, в котором они задуманы как полноценная замена owned-сущностей.

## Когда всё ещё приходится использовать owned-сущность

Составные типы покрывают не каждый случай. Прибегайте к `OwnsOne` или `OwnsMany`, когда:

- **Вам нужен объект-значение в отдельной таблице.** Составные типы всегда встроены, либо как разделённые столбцы, либо как один JSON-столбец. Нет `ComplexProperty(...).ToTable("Addresses")`. Если ваша схема требует данные в собственной таблице с внешним ключом, это owned-сущность (или полноценная сущность).
- **Вам нужна коллекция, отображённая в отдельные строки.** Составной тип с разделением таблицы обязан быть единичным значением; коллекции структур вообще не поддерживаются. Составной тип, отображённый в JSON, может содержать коллекцию внутри документа, но если вы хотите каждый элемент как отдельную строку в дочерней таблице, `OwnsMany` остаётся инструментом.
- **Что-то действительно нуждается в идентичности.** Если два "объекта-значения" с одинаковым содержимым должны быть различимы, или вам нужно отслеживать и обновлять их независимо, это не объекты-значения. Моделируйте их как настоящую связанную сущность.

Правило большого пальца то же самое, что отличает `class` от `record`: если вещь определяется своими данными, отображайте её как составной тип; если у неё есть идентичность, которая переживает её данные, это сущность. Для большинства типов `Address`, `Money`, `GeoPoint` и `DateRange` в кодовой базе .NET 11 составные типы теперь являются правильным выбором по умолчанию, а owned-сущности это исключение, к которому вы спускаетесь только тогда, когда форма хранения вынуждает.

## Дополнительное чтение

- [Как правильно использовать записи с EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/) подробнее разбирает записи как составные типы против сущностей и правила отслеживания изменений за этим разделением.
- [Как отображать и запрашивать JSON-столбцы в EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) охватывает сторону запросов к составным типам, отображённым в JSON.
- [EF Core 11 транслирует Contains в JSON_CONTAINS на SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) объясняет JSON-функции, которые теперь работают с составными типами.
- [ExecuteUpdate против загрузки сущностей и SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) обрамляет путь массового обновления, который составные типы открывают для объектов-значений.
- [Миграция с EF Core 6 на EF Core 11: ломающие изменения, которые действительно цепляют](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) это спутник, если этот переход часть более крупного обновления.

## Источники

- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
