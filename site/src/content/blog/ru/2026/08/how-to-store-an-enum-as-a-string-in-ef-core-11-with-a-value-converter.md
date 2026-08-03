---
title: "Как хранить enum строкой в EF Core 11 с помощью value converter"
description: "Храните C#-перечисления в EF Core 11 читаемыми строками вместо int: HasConversion, массовая настройка для всех enum, ловушка nvarchar(max), проблема сортировки и миграция существующего int-столбца."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "enums"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter"
translatedBy: "claude"
translationDate: 2026-08-03
---

Короткий ответ: в EF Core 11 (на .NET 11 с C# 14) добавьте к свойству `.HasConversion<string>()`, и EF Core сам подберёт встроенный `EnumToStringConverter<TEnum>`. Одновременно добавьте `.HasMaxLength(...)`, иначе SQL Server выдаст столбец `nvarchar(max)`, к которому не подойдёт ни один индекс. Сделайте это один раз для всех enum в модели через `configurationBuilder.Properties<Enum>().HaveConversion<string>()` в `ConfigureConventions`. Равенство и `Contains` по-прежнему корректно транслируются в SQL; реляционные сравнения вроде `>` и `OrderBy` молча переключаются на алфавитный порядок, и именно это ломается по-настоящему.

В этом посте разобраны три способа настроить преобразование, то, как реально выглядят сгенерированные DDL и SQL, пять подвохов, которые кусаются в продакшене, и процедура миграции столбца, где уже лежат int.

Весь SQL и всё поведение ниже измерены на EF Core 10.0.10 против SQLite и против генератора DDL провайдера SQL Server, с SDK .NET 10.0.201. EF Core 11 требует рантайм .NET 11, поэтому запустить его на этой машине не удалось; отличия EF Core 11, отмеченные ниже, взяты из [заметок о выпуске EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) и помечены как таковые. Сам API преобразования значений между EF Core 8 и 11 не менялся.

## Почему int-маппинг по умолчанию опасен

По умолчанию EF Core отображает enum на его базовый числовой тип. `OrderStatus.Shipped` превращается в `2`. Это компактно и сортируется так, как объявлено в enum, но привязывает базу данных к *порядку объявления* типа C#.

```csharp
// .NET 11, C# 14
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Через полгода кто-то вставляет `Refunded` между `Paid` и `Shipped`, потому что так читается лучше. Enum по-прежнему компилируется, все тесты по-прежнему проходят, а каждая строка в базе, которая означала `Shipped`, теперь означает `Refunded`. Ни ошибки компиляции, ни ошибки времени выполнения нет. Это тихая порча данных, которая всплывает только тогда, когда отчёт прочитает человек.

У строк такого режима отказа нет. `"Shipped"` означает `Shipped` независимо от того, что вы сделаете с порядком объявления, и столбец читаем для любого, кто выполняет разовый SQL, работает в BI-инструменте или пишет запрос для поддержки. Платите вы за это объёмом хранения, шириной индекса и оговоркой про сортировку ниже.

## Три способа настроить преобразование

Самая короткая форма использует обобщённую перегрузку `HasConversion`. EF Core смотрит на тип модели (enum) и на запрошенный тип провайдера (`string`) и подбирает встроенный converter автоматически:

```csharp
// EF Core 11, OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Status)
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

Вторая форма выписывает обе лямбды. Для обычного enum она почти никогда не нужна, но именно её [документация по преобразованиям значений](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) показывает первой, так что узнавать её полезно:

```csharp
// EF Core 11 - equivalent to HasConversion<string>(), just more typing
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion(
        v => v.ToString(),
        v => (OrderStatus)Enum.Parse(typeof(OrderStatus), v));
```

Эти две формы *не* идентичны, и разница важна. Встроенный `EnumToStringConverter<TEnum>` разбирает строку без учёта регистра; написанный вручную `Enum.Parse` выше учитывает регистр и падает на строке, где хранится `"pending"` вместо `"Pending"`. Предпочитайте обобщённую перегрузку.

Третья форма полностью обходит fluent API и просто объявляет тип столбца. EF Core видит строковый столбец под enum-свойством и выводит преобразование сам:

```csharp
// EF Core 11 - conversion inferred from the store type
public class Order
{
    public int Id { get; set; }

    [Column(TypeName = "varchar(20)")]
    public OrderStatus Status { get; set; }
}
```

### Настроить все enum модели разом

Повторять `HasConversion<string>()` для сорока свойств значит однажды одно из них забыть. Настройка модели до соглашений сопоставляется по CLR-типу, а документация отмечает, что тип "может быть базовым типом", то есть `System.Enum` сопоставляется с каждым enum в модели:

```csharp
// EF Core 11 - applies to every enum property in the model
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    configurationBuilder
        .Properties<Enum>()
        .HaveConversion<string>()
        .HaveMaxLength(32);
}
```

Я проверил это на EF Core 10.0.10. Дамп модели после этого показывает преобразование и на не допускающем null enum-свойстве, и на допускающем null, вместе с максимальной длиной:

```text
Id:         clr=Int32       provider=(none)  maxlen=
Perms:      clr=Perms       provider=String  maxlen=32
PrevStatus: clr=Nullable`1  provider=String  maxlen=32
Status:     clr=OrderStatus provider=String  maxlen=32
```

Обратите внимание: `IProperty.GetValueConverter()` здесь возвращает `null`, хотя преобразование активно. Когда преобразование берётся из типа провайдера, а не из явного экземпляра converter, оно живёт в type mapping. Если вы изучаете модель в отладчике, смотрите на `property.GetTypeMapping().Converter`, который показывает экземпляр `EnumToStringConverter<TEnum>`.

Настройка до соглашений перекрывает и соглашения, *и* data annotations, поэтому если один enum должен храниться как int, настройте его явно в `OnModelCreating` после этого.

## Ловушка nvarchar(max)

Это самая частая ошибка, и она незаметна, пока запрос не станет медленным.

Настройте преобразование без длины, и провайдер SQL Server не знает, насколько длинны строки, поэтому берёт самое широкое, что у него есть. Вот DDL, который EF Core сгенерировал для модели с тремя преобразованными enum-свойствами, из которых длину задают только два:

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(max) NOT NULL,
    [PrevStatus] varchar(20) NULL,
    [Perms] nvarchar(64) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

У `Status` не было фасетов, поэтому он стал `nvarchar(max)`. В SQL Server на столбец `nvarchar(max)` вообще нельзя повесить обычный индекс, а столбцы статуса это ровно те столбцы, по которым фильтруют постоянно. `PrevStatus` использовал `.HasMaxLength(20).IsUnicode(false)` и получил аккуратный `varchar(20)`.

Есть одно спасение, о котором стоит знать: если объявить индекс по свойству, провайдер SQL Server в EF Core берёт значение по умолчанию для ключевых столбцов вместо `max`:

```csharp
// EF Core 11
modelBuilder.Entity<Order>().Property(o => o.Status).HasConversion<string>();
modelBuilder.Entity<Order>().HasIndex(o => o.Status);
```

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(450) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
GO

CREATE INDEX [IX_Orders_Status] ON [Orders] ([Status]);
```

`nvarchar(450)` это 900 байт, предел размера ключа индекса в SQL Server. Работать будет, но 900-байтовый ключ для столбца со значением `"Pending"` расходует впустую каждую страницу индекса. Задайте длину сами. Имена enum короткие; 32 или 64 символа без Unicode почти всегда правильный выбор.

Если хотите, чтобы длина ехала вместе с converter, а не повторялась в каждом свойстве, передайте `ConverterMappingHints`:

```csharp
// EF Core 11 - the size travels with the converter
var converter = new ValueConverter<OrderStatus, string>(
    v => v.ToString(),
    v => Enum.Parse<OrderStatus>(v, ignoreCase: true),
    new ConverterMappingHints(size: 20, unicode: false));
```

Любой фасет, заданный явно на свойстве, перекрывает эти подсказки.

## Во что на самом деле компилируются ваши LINQ-запросы

Равенство транслируется ровно так, как хотелось бы. Enum преобразуется на пути в параметр, а не на выходе из столбца, поэтому столбец остаётся пригодным для индекса:

```csharp
var pending = await context.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ToListAsync();
```

```sql
SELECT "o"."Id", "o"."Perms", "o"."PrevStatus", "o"."Status"
FROM "Orders" AS "o"
WHERE "o"."Status" = 'Pending'
```

`Contains` по массиву значений enum превращается в параметризованный `IN`, где каждое значение преобразовано:

```sql
-- Parameters: @wanted1='Pending', @wanted2='Paid'
WHERE "o"."Status" IN (@wanted1, @wanted2)
```

`ExecuteUpdate` тоже работает с преобразованными enum и отправляет строку параметром:

```csharp
await context.Orders
    .Where(o => o.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Paid));
```

Обычные случаи на этом заканчиваются. Теперь те, что ведут себя плохо.

### Реляционное сравнение и OrderBy переходят на алфавит

Это настоящая цена хранения строк, и EF Core о ней не предупреждает. Сравнение `>` для enum это совершенно законный C#, и транслируется оно в совершенно законное строковое сравнение SQL, а это не одно и то же:

```csharp
// Intent: "everything after Paid in the workflow"
var later = await context.Orders
    .Where(o => o.Status > OrderStatus.Paid)
    .ToListAsync();
```

```sql
WHERE "o"."Status" > 'Paid'
```

Для трёх строк со значениями `Pending`, `Delivered` и `Cancelled` LINQ в памяти вернёт строки `Delivered` и `Cancelled`. База данных вернёт строку `Pending`, потому что по алфавиту `'Pending' > 'Paid'`, а `'Cancelled'` и `'Delivered'` нет. У `OrderBy(o => o.Status)` та же проблема: возвращается `Cancelled, Delivered, Pending` вместо порядка объявления.

Исправление лежит не в настройках converter. Либо оставьте int для всего, по чему вы сортируете или сравниваете диапазоном, либо добавьте явный столбец `int SortOrder`, либо замените диапазонный запрос явным множеством: `Where(o => finished.Contains(o.Status))`. Если в бою уже есть код, сравнивающий enum диапазоном, найдите его через grep до того, как менять маппинг.

### ToString() в запросе порождает CAST, а EF Core 11 его убирает

Проекция или фильтрация по `Status.ToString()` выглядит безобидно, когда столбец и так строковый, но EF Core 10 всё равно выдаёт приведение, подразумеваемое вызовом CLR:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

Семантически это приведение бессмысленно, а для планировщика запросов губительно: обёртка столбца в функцию мешает SQL Server использовать любой индекс по нему. EF Core 11 обнаруживает и убирает избыточные приведения на этапе постобработки SQL, и заметки о выпуске называют свойства с преобразованием значений типичным источником таких приведений. На EF Core 11 тот же запрос даёт чистое `WHERE [o].[Status] LIKE N'P%'`. Если вы на EF Core 10 или старше, уберите `.ToString()` и используйте `EF.Functions.Like` по свойству либо дождитесь обновления. Проверять это удобно, если [логирование SQL в разработке остаётся включённым](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Чтение значений обратно: неизвестные имена и регистр

Value converter работают на материализации, а строковый столбец принимает что угодно. Строка с именем, которого в вашем enum нет, падает при чтении, а не при запросе:

```text
InvalidOperationException: Cannot convert string value 'Refunded' from the database
to any value in the mapped 'OrderStatus' enum.
```

Исключение возникает при материализации строки, поэтому запрос, возвращающий 10 000 строк, умрёт на той строке, которая окажется испорченной. Защитите столбец ограничением `CHECK`, если база разделяется с чем-то, что пишет в неё напрямую.

С регистром встроенный converter, наоборот, снисходителен: строка со значением `"pending"` материализуется как `OrderStatus.Pending`. Это `EnumToStringConverter<TEnum>` разбирает значение без учёта регистра. Замените его написанным вручную `Enum.Parse(typeof(OrderStatus), v)`, и та же строка бросит исключение, потому что по умолчанию BCL учитывает регистр. Если пишете свой, пишите `Enum.Parse<OrderStatus>(v, ignoreCase: true)`.

### `[Flags]`-перечисления сохраняются и читаются, но не запрашиваются

`[Flags]`-перечисление преобразуется через `ToString()` как любое другое, и получается список через запятую:

```text
row 1 | Read
row 2 | Read, Write
row 3 | None
```

Круговой путь работает. Запросы нет: `Where(o => o.Perms.HasFlag(Perms.Write))` не транслируется в строковый предикат, а `LIKE '%Write%'` не находит ничего полезного и сканирует всё подряд. Держите `[Flags]`-перечисления как int или моделируйте права строками таблицы.

### Параметры сырого SQL молча игнорируют converter

Документация по преобразованию значений перечисляет это как известное ограничение, и стоит посмотреть, как оно выглядит, потому что исключения не будет:

```csharp
var rows = await context.Orders
    .FromSql($"SELECT Id, Status FROM Orders WHERE Status = {OrderStatus.Pending}")
    .ToListAsync();
```

Параметр уходит в базу как `DbType = Int32` со значением `0`. Запрос выполняется, ничего не находит и возвращает пустой список. Передавайте в сыром SQL явное `OrderStatus.Pending.ToString()` или оставайтесь в LINQ. Это отличается от случаев, за которыми стоит [выражение LINQ не удалось транслировать](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/): здесь исключения нет вообще.

## Хранить короткие коды вместо имён

Если нужен `"PND"`, а не `"Pending"` (коды фиксированной ширины часто встречаются в схемах, разделяемых с хранилищем данных), унаследуйтесь от `ValueConverter<TModel, TProvider>`, чтобы отображение было явным и его можно было проверить на ревью:

```csharp
// EF Core 11
public class StatusCodeConverter : ValueConverter<OrderStatus, string>
{
    public StatusCodeConverter() : base(v => ToCode(v), v => FromCode(v)) { }

    private static string ToCode(OrderStatus s) => s switch
    {
        OrderStatus.Pending => "PND",
        OrderStatus.Paid => "PAI",
        OrderStatus.Shipped => "SHP",
        OrderStatus.Delivered => "DLV",
        OrderStatus.Cancelled => "CAN",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null)
    };

    private static OrderStatus FromCode(string c) => c switch
    {
        "PND" => OrderStatus.Pending,
        "PAI" => OrderStatus.Paid,
        "SHP" => OrderStatus.Shipped,
        "DLV" => OrderStatus.Delivered,
        "CAN" => OrderStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown status code '{c}'.")
    };
}
```

```csharp
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<StatusCodeConverter>()
    .HasMaxLength(3)
    .IsUnicode(false);
```

Предикаты транслируются через converter, поэтому `Where(o => o.Status == OrderStatus.Pending)` превращается в `WHERE "o"."Status" = 'PND'`. Поскольку ветви switch исчерпывают известные коды, неожиданное значение даст *ваше* сообщение вместо сообщения EF, а это гораздо легче разбирать. Converter не хранят состояния, их можно разделять между всеми свойствами, которые их используют.

## Миграция столбца, где уже лежат int

Не позволяйте EF Core сгенерировать эту миграцию за вас. Он выдаёт единственный `AlterColumn`, который в SQL Server выполняет неявное преобразование `int` в `nvarchar`: значение `2` становится строкой `"2"`, а не `"Shipped"`. После этого ни одна строка не разбирается, и следующее чтение бросает исключение.

Безопасная процедура состоит из четырёх шагов:

1. Добавьте converter в модель, затем сгенерируйте миграцию командой `dotnet ef migrations add StoreStatusAsString`.
2. Откройте сгенерированную миграцию и замените `AlterColumn` на `AddColumn` для временного столбца, например `StatusText nvarchar(20) NULL`.
3. Между добавлением и удалением вставьте заполнение через `migrationBuilder.Sql(...)`, явно сопоставляя каждый int его имени: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Пишите CASE вручную по объявлению enum, каким оно существует в этом коммите, а не по тому, каким оно станет позже.
4. Удалите старый столбец, переименуйте `StatusText` в `Status` и сделайте его `NOT NULL`. Зеркальную логику напишите в `Down`, чтобы миграция была обратимой.

Проверьте SQL до того, как он выполнится где-то по-настоящему. `dotnet ef migrations script` печатает его, и ровно этот скрипт выполнит на целевой машине [пакет миграций](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/). Если enum используется как внешний ключ или внутри фильтрованного индекса, удалите и создайте индекс заново в той же миграции.

Последний совет по самой модели: value converter рассчитаны на один столбец. В тот момент, когда вы начинаете сериализовать несколько полей в одну строку, чтобы это обойти, вам нужен [комплексный тип, отображённый в JSON](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), по которому EF Core 11 умеет строить индексы и обновлять его на месте. А если EF Core вообще отказывается отображать свойство, это другая проблема с другим решением, разобранная в [ошибке о том, что свойство не удалось отобразить](/ru/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Источники

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) на Microsoft Learn, включая список встроенных converter и задокументированные ограничения.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) про настройку до соглашений и сопоставление по базовому типу.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) про удаление бессмысленных CAST.
- Справочник API [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), отслеживающая задача про запросы внутрь свойств с преобразованием значений.
