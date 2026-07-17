---
title: "Решение: \"The property could not be mapped, because it is not a supported primitive type or a valid entity type\" в EF Core 11"
description: "EF Core наткнулся на свойство, которое не знает, как хранить. Сопоставьте его как комплексный тип, преобразуйте через HasConversion, задайте ему ключ или исключите через [NotMapped]."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ru"
translationOf: "2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

EF Core выбрасывает `The property 'X.Y' could not be mapped, because it is of type 'Z' which is not a supported primitive type or a valid entity type`, когда ваша модель содержит свойство, которое EF Core не может превратить в столбец и не может трактовать как связь. Исправьте одним из четырёх способов, в порядке предпочтения: сопоставьте его как комплексный тип через `ComplexProperty`, если это объект-значение; преобразуйте в скаляр через `HasConversion` (конвертер значений), если это список enum или пользовательская обёртка; задайте типу ключ, чтобы EF Core сопоставил его как связанную сущность; либо полностью исключите его через `[NotMapped]` / `EntityTypeBuilder.Ignore`, если он никогда не должен сохраняться. Это относится к `Microsoft.EntityFrameworkCore` 11.0 на .NET 11 с C# 14, и сообщение остаётся неизменным начиная с EF Core 3.0.

## Ошибка в контексте

Полное исключение времени выполнения -- это `InvalidOperationException`, выбрасываемое, пока EF Core строит модель. Это значит, что оно срабатывает при первом обращении к `DbContext` (запрос, `SaveChanges` или `dotnet ef migrations add`), а не при компиляции:

```
System.InvalidOperationException: The property 'Customer.Tags' could not be mapped, because it is of type 'HashSet<Tag>' which is not a supported primitive type or a valid entity type. Either explicitly map this property, or ignore it using the '[NotMapped]' attribute or by using 'EntityTypeBuilder.Ignore' in 'OnModelCreating'.
```

Два идентификатора в сообщении -- это всё, что вам нужно прочитать: свойство (`Customer.Tags`) и его тип (`HashSet<Tag>`). EF Core сообщает, что обошёл вашу сущность, нашёл этот член и не имел правила для его хранения. Последнее предложение перечисляет запасные выходы, но не тот, что нужен, и именно поэтому эта ошибка отправляет так много людей прямиком к `[NotMapped]`, даже когда данные должны были сохраняться.

## Почему это происходит

EF Core сопоставляет свойство ровно одним из трёх способов. Скаляр становится столбцом (`int`, `string`, `decimal`, `DateTime`, `Guid`, `bool`, `enum`, а начиная с EF Core 8 также `DateOnly` и `TimeOnly` и коллекции примитивов вроде `List<string>`). Тип с обнаруживаемым ключом становится связанной сущностью, подключённой через внешний ключ. А объект-значение без ключа становится комплексным типом или owned-сущностью, хранимой встроенно в таблице владельца.

Эта ошибка означает, что свойство не подошло ни под одну из трёх категорий. Тип -- не скаляр, известный EF Core, у него нет ключа, который EF Core мог бы найти (значит, он не может быть связью), и вы никогда не говорили EF Core трактовать его как комплексный или owned-тип. Частые причины:

- **Пользовательский класс или структура**, используемые как объект-значение (`Address`, `Money`, `GeoPoint`), которые вы так и не настроили.
- **Коллекция пользовательского типа** (`List<OrderLine>`, `HashSet<Tag>`), у типа элемента которой нет ключа.
- **Коллекция enum** (`List<Status>`). Одиночный enum сопоставляется без проблем, но до EF Core 8 коллекция из них -- нет, а коллекция пользовательского типа по-прежнему не сопоставляется без настройки.
- **Словарь или произвольный объект** (`Dictionary<string, string>`, `IDictionary`, `object`, `dynamic`, `JsonElement`), у которого нет естественного представления в виде столбца.
- **Тип из другой библиотеки** (`NodaTime.Instant`, доменный примитив) без встроенного сопоставления в провайдере.

Решение -- никогда не угадывать. Определите, чем *является* данное значение, и затем выберите соответствующее сопоставление.

## Минимальное воспроизведение

Наименьшая программа, воспроизводящая ошибку, использует объект-значение, который выглядит безобидно. У `Address` нет `Id`, поэтому EF Core не может сделать его связанной сущностью, и это не скаляр, поэтому EF Core выбрасывает исключение:

```csharp
// .NET 11, C# 14, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
await db.Database.EnsureCreatedAsync(); // throws here while building the model

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; } // unmapped: not scalar, no key
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

EF Core сообщает `The property 'Customer.ShippingAddress' could not be mapped, because it is of type 'Address'...`. Свойство реально, тип реален, но ничто в модели не говорит EF Core, как `Address` превращается в хранилище.

## Решение в деталях

Двигайтесь сверху вниз. Первое сопоставление, совпадающее с вашим намерением, и есть правильное.

### 1. Это объект-значение: сопоставьте его как комплексный тип

Если свойство -- объект-значение, принадлежащий строке владельца (адрес, денежная сумма, координата), сопоставьте его через `ComplexProperty`. У комплексного типа нет идентичности, и он хранится встроенно, а это именно то, что нужно объекту-значению:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>()
        .ComplexProperty(c => c.ShippingAddress);
}
```

Или пометьте тип атрибутом `[ComplexType]`, чтобы EF Core подхватывал его по соглашению везде, где он встречается:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}
```

Это сопоставляется через разделение таблицы: столбцы `ShippingAddress_Street` и `ShippingAddress_City` в `Customers`, без join, без внешнего ключа. Комплексные типы -- современная замена owned-сущностям для объектов-значений, и они приносят семантику значений, которой у owned-сущностей никогда не было. Полная картина, включая случаи, когда их всё ещё недостаточно, изложена в статье [как сопоставить комплексный тип вместо owned-сущности в EF Core 11](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Если тип -- `record`, сначала прочтите [как правильно использовать records с EF Core 11](/ru/2026/04/how-to-use-records-with-ef-core-11-correctly/), потому что равенство record взаимодействует с отслеживанием изменений так, что это стоит понять до выпуска.

### 2. На самом деле это один скаляр: преобразуйте его через HasConversion

Если свойство концептуально -- одно значение, для которого у EF Core нет встроенного сопоставления, конвертер значений превращает его в скаляр по пути в базу данных и обратно при извлечении. Это охватывает типы `NodaTime`, доменные примитивы или enum, который вы хотите хранить как его имя в виде текста:

```csharp
// .NET 11, EF Core 11 - store the enum as its name, not its int
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<string>();
```

Для пользовательского типа-обёртки укажите оба направления явно:

```csharp
// .NET 11, EF Core 11 - EmailAddress is a struct wrapping a string
modelBuilder.Entity<Customer>()
    .Property(c => c.Email)
    .HasConversion(
        email => email.Value,          // to the database column (nvarchar)
        value => new EmailAddress(value)); // back from the column
```

Конвертер значений -- правильный инструмент, когда есть чистое сопоставление без потерь в один столбец. Если сопоставление с потерями или тип действительно составной (несколько полей), используйте вместо этого комплексный тип. Не хватайтесь за конвертер лишь для того, чтобы сериализовать целый граф объектов в одну строку; этот путь -- следующий, и у него более острые края.

### 3. Это коллекция или словарь: коллекции примитивов или столбец JSON

EF Core 8 добавил нативное сопоставление для **коллекций примитивов**, поэтому в EF Core 11 `List<string>`, `int[]` или `List<DateOnly>` сопоставляется автоматически в столбец JSON без настройки. Если вы всё ещё видите ошибку для коллекции примитивов, значит, вы на EF Core 7 или старше; обновление устраняет её напрямую.

Для коллекции **пользовательского типа** или **словаря** EF Core не может вывести форму, поэтому сериализуйте всё свойство в столбец JSON. В EF Core 11 самый чистый путь для коллекции объектов-значений -- комплексный тип, сопоставленный в JSON:

```csharp
// .NET 11, EF Core 11 - store the whole collection as one json document
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Tags, b => b.ToJson());
```

Для `Dictionary<string, string>` или другого свободного набора конвертер значений, запускающий `System.Text.Json`, даёт то же хранилище в один столбец:

```csharp
// .NET 11, EF Core 11 - dictionary stored as a json string
modelBuilder.Entity<Customer>()
    .Property(c => c.Metadata)
    .HasConversion(
        dict => JsonSerializer.Serialize(dict, (JsonSerializerOptions?)null),
        json => JsonSerializer.Deserialize<Dictionary<string, string>>(json, (JsonSerializerOptions?)null)
                ?? new());
```

Столбец JSON доступен для запросов в современных провайдерах, поэтому вы не отказываетесь от фильтрации ради хранения в один столбец. Сторона запросов, включая SQL-функции, проникающие внутрь JSON-документа, рассматривается в статье [как сопоставлять и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/). Если вам нужна пользовательская форма сериализации вместо стандартной, статья [как написать пользовательский JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) показывает, как точно управлять тем, что окажется в столбце.

### 4. На самом деле это связанная сущность: задайте ей ключ

Если свойство должно быть собственной таблицей с собственными строками (`Order`, ссылающийся на реальные записи `OrderLine`, а не встроенный объект-значение), значит, это сущность, и ошибка означает, что EF Core не смог найти ключ для установления связи. Добавьте ключ, и EF Core автоматически настроит внешний ключ:

```csharp
// .NET 11, C# 14, EF Core 11
public class OrderLine
{
    public int Id { get; set; }     // now discoverable as a key
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public List<OrderLine> Lines { get; set; } = []; // maps as a one-to-many
}
```

Если у типа есть идентификатор, не названный `Id` или `OrderLineId`, сообщите об этом EF Core через `HasKey` в `OnModelCreating`. Тип без ключа, у которого нет естественного ключа, но которому всё же нужны собственные строки, следует сопоставить как owned-коллекцию через `OwnsMany`. А если ошибка, на которую вы на самом деле смотрите, -- это [тип сущности 'X' требует определения первичного ключа](/ru/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/), то это близкий родственник: EF Core зашёл достаточно далеко, чтобы трактовать тип как сущность, но затем не нашёл ключа.

### 5. Оно никогда не должно сохраняться: исключите его

Если свойство -- вычисляемое удобство, кеш или ссылка на сервис, которым нечего делать в базе данных, исключите его. Атрибут -- самый быстрый способ:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    [NotMapped]
    public string DisplayName => $"{Name} (#{Id})";
}
```

Или сделайте это в конфигурации модели, что оставляет POCO, не зависящие от персистентности, свободными от атрибутов EF Core:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Ignore(c => c.DisplayName);
```

`Ignore` -- правильное решение только тогда, когда ответ на вопрос "должен ли этот столбец существовать?" действительно отрицательный. Хвататься за него, чтобы заглушить ошибку для данных, которые вы собирались сохранить, -- самый частый способ превратить эту ошибку в тихий баг с потерей данных.

## Тонкости и варианты

**Ошибку вызвало вычисляемое свойство только для чтения.** EF Core пытается сопоставить любое читаемое свойство, включая свойства с телом-выражением. Если `DisplayName => ...` выводится из других столбцов, ему не нужно хранилище; исключите его. Если оно дорогое и вы хотите иметь его в базе данных, вместо этого сопоставьте вычисляемый столбец через `HasComputedColumnSql`.

**Оно сломалось после того, как вы добавили `required` или изменили тип.** Добавление свойства несопоставленного типа или замена `string` на пользовательскую структуру вводит несопоставленный член. Ошибка называет точное свойство; проверьте, что изменилось в этом типе.

**Коллекция enum.** `List<Status>` выбрасывает ошибку в EF Core 7 и старше, потому что коллекции enum тогда ещё не были коллекциями примитивов. Начиная с EF Core 8 она сопоставляется в столбец JSON автоматически. Если вы в разгаре обновления, поведение коллекций enum -- одно из нескольких изменений сопоставления в [руководстве по миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Тип живёт в другой сборке, и вы не можете его аннотировать.** Вы не можете поставить `[ComplexType]` или `[NotMapped]` на тип, который вам не принадлежит, но у каждого атрибута есть fluent-эквивалент в `OnModelCreating` (`ComplexProperty`, `Property(...).HasConversion(...)`, `Ignore`). Настройте его из своего `DbContext`, и вы никогда не тронете чужой тип.

**Навигация к абстрактному типу или интерфейсу.** EF Core не может сопоставить свойство, типизированное как интерфейс (`IAddress`) или как несопоставленная база без дискриминатора. Сопоставьте конкретный тип или настройте наследование явно.

**Это фильтр `DbSet`, а не сохраняемое свойство.** Если "свойство" на самом деле -- помощник, запрашивающий другие данные, ему вообще не место на сущности. Перенесите его в репозиторий или сервис, чтобы EF Core никогда не видел его во время построения модели.

Решение, которое навсегда убережёт вас от этой ошибки, -- это единственный вопрос, задаваемый до добавления свойства: чем это является в терминах хранения? Объект-значение идёт встроенно как комплексный тип. Одно преобразуемое значение получает `HasConversion`. Набор данных становится столбцом JSON. Нечто с идентичностью становится связанной сущностью с ключом. А чисто in-memory помощник исключается. EF Core выбрасывает ошибку именно потому, что отказывается угадывать, что из этого вы имели в виду.

## Связанное

- [Как сопоставить комплексный тип вместо owned-сущности в EF Core 11](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) -- глубокий разбор сопоставления объекта-значения, на которое эта ошибка указывает чаще всего.
- [Как сопоставлять и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) охватывает хранение и фильтрацию сериализованной коллекции или документа.
- [Решение: тип сущности 'X' требует определения первичного ключа](/ru/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) -- родственная ошибка, когда EF Core трактует тип как сущность, но не находит ключа.
- [Как правильно использовать records с EF Core 11](/ru/2026/04/how-to-use-records-with-ef-core-11-correctly/) важно, когда ваш объект-значение -- record и в игре отслеживание изменений.
- [Как написать пользовательский JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) точно формирует то, что хранит свойство с конвертером в JSON.

## Источники

- [Преобразования значений, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)
- [Комплексные типы, что нового в EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Коллекции примитивов, что нового в EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#primitive-collections)
- [Исключение типов или свойств из модели, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/#excluding-types-from-the-model)
- [dotnet/efcore issue #15987: property could not be mapped, not a supported primitive type](https://github.com/dotnet/efcore/issues/15987)
