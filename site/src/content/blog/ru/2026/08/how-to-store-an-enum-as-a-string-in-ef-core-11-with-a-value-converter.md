---
title: "Как хранить enum строкой в EF Core 11 с помощью value converter"
description: "Храните C#-перечисления в EF Core 11 читаемыми строками вместо int: HasConversion, массовая настройка для всех enum, ловушка nvarchar(max), проблема сортировки и миграция существующего int-столбца."
pubDate: 2026-08-03
updatedDate: 2026-11-02
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

Для хранения имён enum в EF Core используйте `.HasConversion<string>()`. Выберите длину, вмещающую допустимые имена, и проверьте DDL провайдера. Фильтры равенства используют преобразованные значения. Сравнение и сортировка строк зависят от правил сортировки базы и могут не совпадать с числовым порядком состояний.

**Исправление, 2 ноября 2026 года.** Прежняя версия утверждала, что встроенный конвертер не читает числовые строки, а предел ключа индекса SQL Server всегда равен 900 байтам. Оба утверждения ошибочны. Раздел миграции теперь различает материализацию значения и совпадение в предикате.

Проверка выполнена с SDK 10.0.302 и EF Core 10.0.10. Чтение и предикаты исполнены в SQLite, а DDL и SQL запросов сгенерированы провайдером SQL Server без подключения к серверу. Оптимизации EF Core 11 описаны в [примечаниях к выпуску](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew). Для [преобразования NULL базы](/ru/2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value/) действуют отдельные правила.

## Почему int-маппинг по умолчанию опасен

По умолчанию EF Core использует базовый числовой тип enum. При неявных значениях вставка или перестановка члена может изменить номера следующих членов. Задавайте явные стабильные значения, если числа входят в контракт хранения.

```csharp
// Implicit numeric values follow declaration order.
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Через полгода кто-то вставляет `Refunded` между `Paid` и `Shipped`, потому что так читается лучше. Enum по-прежнему компилируется, все тесты по-прежнему проходят, а каждая строка в базе, которая означала `Shipped`, теперь означает `Refunded`. Ни ошибки компиляции, ни ошибки времени выполнения нет. Это тихая порча данных, которая всплывает только тогда, когда отчёт прочитает человек.

Хранение имён устраняет зависимость от порядка объявления. Переименование всё ещё меняет контракт и требует миграции либо явного сопоставления. Учитывайте читаемость, хранение, индексы и порядок сортировки.

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
// Explicit converter: Enum.Parse here is case-sensitive.
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

Укажите подходящую длину и проверьте миграцию. SQL Server различает обычные столбцы, ключи индекса и включённые неключевые столбцы.

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

В примере `Status` без ограничений становится `nvarchar(max)`. Такой столбец не может быть обычным ключом индекса, но может быть включён как неключевой столбец некластеризованного индекса. `PrevStatus` с `.HasMaxLength(20).IsUnicode(false)` получает `varchar(20)`.

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

Провайдер SQL Server в проверке EF Core 10.0.10 создал для индексируемого свойства `nvarchar(450)`, до 900 байтов символьных данных. Начиная с SQL Server 2016, предел ключа кластеризованного индекса — 900 байтов, некластеризованного — 1700. Объявленный максимум не равен фактическому размеру короткого значения. Выбирайте длину для всех допустимых имён или кодов.

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

### Проверка SQL для ToString()

Проекция или фильтрация по `Status.ToString()` выглядит безобидно, когда столбец и так строковый, но EF Core 10 всё равно выдаёт приведение, подразумеваемое вызовом CLR:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

Провайдер SQL Server в EF Core 10.0.10 сгенерировал показанный `CAST`. Использование индекса зависит от плана. EF Core 11 документирует оптимизацию лишних преобразований, но проверьте `ToQueryString()` на развёртываемой версии и провайдере. Для точного статуса сравнивайте значения enum напрямую. `EF.Functions.Like` требует строковое выражение и не принимает это свойство enum непосредственно. См. [журнал SQL при разработке](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

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

### В raw SQL передавайте значение провайдера

Интерполированный аргумент raw SQL не применяет автоматически конвертер свойства модели. Передавайте хранимое представление явно. Для встроенного сопоставления по имени:

```csharp
var providerValue = OrderStatus.Pending.ToString();
var rows = await context.Orders
    .FromSql($"SELECT * FROM Orders WHERE Status = {providerValue}")
    .ToListAsync();
```

Интерполяция здесь передаёт параметр. При собственном коде `PND` передавайте этот код для `Pending`. Целое число может дать иные строки или ошибку преобразования в зависимости от провайдера. Запрос сущности также должен возвращать столбцы для материализации. Это отличается от [ошибки трансляции LINQ](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

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

Простая конверсия столбца может оставить `2` как текст `"2"` вместо `"Shipped"`. В SQLite встроенный конвертер EF Core 10.0.10 прочитал обе строки как `Shipped`. Фильтр равенства нашёл только строку с именем, поскольку значение провайдера было `"Shipped"`. Даже `"99"` материализовалось как значение без имени, а `"Bogus"` вызвало исключение. Числовой текст нарушает контракт даже при успешном чтении.

При согласованной миграции заполните ожидаемые имена явно. Сделайте резервную копию, проверьте на копии и учтите процессы, продолжающие запись в старый столбец во время развёртывания.

1. Добавьте converter в модель, затем сгенерируйте миграцию командой `dotnet ef migrations add StoreStatusAsString`.
2. Откройте сгенерированную миграцию и замените `AlterColumn` на `AddColumn` для временного столбца, например `StatusText nvarchar(20) NULL`.
3. Между добавлением и удалением вставьте заполнение через `migrationBuilder.Sql(...)`, явно сопоставляя каждый int его имени: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Пишите CASE вручную по объявлению enum, каким оно существует в этом коммите, а не по тому, каким оно станет позже.
4. Удалите старый столбец, переименуйте `StatusText` в `Status` и сделайте его `NOT NULL`. Зеркальную логику напишите в `Down`, чтобы миграция была обратимой.

До удаления проверьте количество строк, несопоставленные числа, допустимость NULL и каждое сопоставление. Пересоздайте затронутые индексы и внешние ключи, проверьте обновление и поддерживаемый откат. Просмотрите `dotnet ef migrations script` и отрепетируйте реальное развёртывание, включая [пакет миграций](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), если он используется.

Последний совет по самой модели: value converter рассчитаны на один столбец. В тот момент, когда вы начинаете сериализовать несколько полей в одну строку, чтобы это обойти, вам нужен [комплексный тип, отображённый в JSON](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), по которому EF Core 11 умеет строить индексы и обновлять его на месте. А если EF Core вообще отказывается отображать свойство, это другая проблема с другим решением, разобранная в [ошибке о том, что свойство не удалось отобразить](/ru/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Источники

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) на Microsoft Learn, включая список встроенных converter и задокументированные ограничения.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) про настройку до соглашений и сопоставление по базовому типу.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) про удаление бессмысленных CAST.
- Справочник API [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), отслеживающая задача про запросы внутрь свойств с преобразованием значений.
- [SQL Server index key limits](https://learn.microsoft.com/en-us/sql/sql-server/maximum-capacity-specifications-for-sql-server?view=sql-server-ver17)
- [EF Core 10.0.10 enum converter source](https://github.com/dotnet/efcore/blob/v10.0.10/src/EFCore/Storage/ValueConversion/Internal/StringEnumConverter.cs)
