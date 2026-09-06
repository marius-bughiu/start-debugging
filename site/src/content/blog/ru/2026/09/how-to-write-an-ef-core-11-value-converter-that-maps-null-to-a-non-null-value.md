---
title: "Как написать value converter в EF Core 11, который преобразует null из базы данных в ненулевое значение в коде"
description: "По умолчанию EF Core никогда не передаёт null в value converter. Разбираем внутренний конструктор convertsNulls, который это меняет, вызов IsRequired(false), от которого он зависит, почему он не работает с enum и другими типами значений, ловушку WHERE col = NULL, которую он создаёт, и два подхода, решающие задачу без внутреннего API."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "nullability"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-06
---

Короткий ответ: EF Core намеренно никогда не передаёт `null` в value converter, поэтому `HasConversion(v => ..., v => v ?? "Unknown")` для NULL-столбца молча ничего не делает. Изменить это можно только конструктором `ValueConverter<TModel, TProvider>` с четырьмя аргументами и `convertsNulls: true`, который помечен как `[EntityFrameworkInternal]` и выдаёт предупреждение `EF1001`. Он работает, но только для свойств, CLR-тип которых является ссылочным, только если вы дополнительно вызовете `.IsRequired(false)`, и ценой поломки всех LINQ-запросов, фильтрующих по значению-заглушке. Для `enum`, `int`, `DateTime` и любого другого типа значения, не допускающего null, заставить это работать невозможно вовсе. Для них отобразите свойство, допускающее null, и выставьте наружу ненулевой фасад.

В этой статье разбирается, что EF на самом деле делает с NULL-столбцом, точная конфигурация, при которой `convertsNulls` работает, четыре формы запросов, которые он ломает (с SQL, который EF генерирует для каждой), стена, в которую вы упираетесь на типах значений, и два поддерживаемых подхода, которые стоит использовать вместо этого.

Замечание о версиях. EF Core 11 находится в предварительной версии по состоянию на сентябрь 2026 года и выходит вместе с .NET 11 в ноябре 2026 года, согласно [странице релизов и планирования EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 требует среды выполнения .NET 11, а единственный SDK на этой машине -- .NET 10.0.302, поэтому всё изложенное ниже измерено на `Microsoft.EntityFrameworkCore.Sqlite` 10.0.10 с базой данных SQLite в памяти. В EF11 в этой области ничего не изменилось: страница [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) не перечисляет изменений ни в value conversions, ни в обработке null, а `convertsNulls` остаётся внутренним с EF Core 6.0.

## Почему ваш converter никогда не вызывается для NULL-столбца

[Документация по value conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) формулирует правило прямо: значение null никогда не передаётся в value converter, а null в столбце базы данных всегда остаётся null в экземпляре сущности. Это не упущение. Именно это позволяет использовать один converter и для первичного ключа, не допускающего null, и для допускающих null внешних ключей, которые на него ссылаются, не описывая обработку null дважды.

Следствие в том, что очевидный код не делает ничего:

```csharp
// .NET 11, C# 14 - this ?? is dead code
modelBuilder.Entity<Order>()
    .Property(o => o.Notes)
    .HasConversion(v => v, v => v ?? "");
```

Ветка `v ?? ""` никогда не достигается, потому что EF обрывает преобразование до входа в неё.

Что произойдёт дальше, зависит от CLR-типа. Возьмём унаследованную таблицу, где столбец допускает null и NULL несёт смысл:

```sql
CREATE TABLE Orders (
    Id     INTEGER PRIMARY KEY AUTOINCREMENT,
    Notes  TEXT NULL,   -- NULL means "no notes"
    Status TEXT NULL    -- NULL means "status unknown"
);
INSERT INTO Orders (Notes, Status) VALUES (NULL, NULL);
INSERT INTO Orders (Notes, Status) VALUES ('hi', 'Shipped');
```

отображённую на сущность, которая обещает ненулевые значения:

```csharp
// .NET 11, C# 14
public enum ShippingStatus { Unknown, Pending, Shipped }

public class Order
{
    public int Id { get; set; }
    public string Notes { get; set; } = "";      // never null, we hope
    public ShippingStatus Status { get; set; }   // Unknown, we hope
}
```

Прочитайте первую строку, и `Notes` окажется `null` -- вопреки инициализатору и вопреки объявлению без null, потому что EF присваивает значение столбца свойству напрямую. Со `Status` хуже: data reader провайдера выбрасывает исключение раньше, чем EF успевает что-либо сделать, и на SQLite оно выглядит так:

```
System.InvalidOperationException: The data is NULL at ordinal 2. This method can't be
called on NULL values. Check using IsDBNull before calling.
```

Это исключение -- самый частый способ обнаружить проблему. Точный тип зависит от провайдера, но причина всегда одна: EF генерирует проверку `IsDBNull` только для столбца, который считает допускающим null, а здесь он так не считает. Этот сбой отличается от [свойство не удалось отобразить, поскольку это не поддерживаемый примитивный тип](/ru/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/), который срабатывает на этапе построения модели, а не при материализации.

## Converter, который всё-таки преобразует null

У `ValueConverter<TModel, TProvider>` есть второй конструктор, добавленный в EF Core 6.0, принимающий флаг `convertsNulls`:

```csharp
[Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkInternal]
public ValueConverter(
    Expression<Func<TModel, TProvider>> convertToProviderExpression,
    Expression<Func<TProvider, TModel>> convertFromProviderExpression,
    bool convertsNulls,
    ConverterMappingHints? mappingHints = default);
```

Перегрузки `HasConversion` для него нет, поэтому придётся наследоваться. Процедура состоит из трёх шагов:

1. Напишите класс-converter, у которого тип провайдера явно допускает null, и передайте `convertsNulls: true` в базовый конструктор.
2. Подавите `EF1001` вокруг класса, поскольку конструктор внутренний.
3. Вызовите `.IsRequired(false)` для свойства, чтобы EF считал столбец допускающим null и генерировал проверку `IsDBNull`, необходимую пути чтения.

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToEmptyString : ValueConverter<string, string?>
{
    public NullToEmptyString()
        : base(
            v => v.Length == 0 ? null : v,   // model -> provider
            v => v ?? "",                    // provider -> model
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Notes)
        .HasConversion(new NullToEmptyString())
        .IsRequired(false);
}
```

Без `#pragma` сборка выдаёт:

```
warning EF1001: Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<string, string?>
is an internal API that supports the Entity Framework Core infrastructure and not subject to the same
compatibility standards as public APIs. It may be changed or removed without notice in any release.
```

Это предупреждение, а не ошибка, но при `TreatWarningsAsErrors` оно становится ошибкой, и именно поэтому об этом API обычно узнают.

При такой конфигурации работают оба направления. Первая строка материализуется с `Notes`, равным `""`, а не `null`, а сохранение новой сущности с `Notes`, равным `""`, записывает в столбец настоящий `NULL`, что подтверждается последующим чтением сырой таблицы.

Шаг 3 не является необязательным, и именно его почти все пропускают. Уберите `.IsRequired(false)`, и `Notes` останется в модели не допускающим null (`IsNullable = False`), EF пропустит проверку на null, а чтение выбросит то же исключение `The data is NULL at ordinal 1`, что и раньше. Converter настроен правильно и никогда не вызывается. Если вы не уверены, в каком вы состоянии, `context.Model.FindEntityType(typeof(Order))!.FindProperty("Notes")!.IsNullable` отвечает на это одной строкой.

## Ловушка запросов: WHERE col = NULL

Вот та часть, о которой [документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) предупреждает, но не показывает, и именно она объясняет, почему API внутренний. EF применяет половину converter-а "модель в провайдер" и к константам в запросе. Ваша заглушка превращается в `null`, и EF помещает этот `null` в SQL как обычный операнд сравнения.

Четыре способа спросить "у каких заказов нет заметок", SQL, который EF Core 10.0.10 генерирует для каждого, и число строк для таблицы с одной строкой NULL и одной строкой `'hi'`:

| LINQ | Сгенерированный предикат SQL | Строк |
| --- | --- | --- |
| `o.Notes == ""` | `"o"."Notes" = NULL` | 0 |
| `o.Notes == null!` | `"o"."Notes" IS NULL` | 1 |
| `string.IsNullOrEmpty(o.Notes)` | `"o"."Notes" IS NULL OR "o"."Notes" = NULL` | 1 |
| `o.Notes.Length == 0` | `length("o"."Notes") = 0` | 0 |

Естественный запрос, сравнивающий с придуманной вами заглушкой, не возвращает ничего. `= NULL` никогда не истинно в трёхзначной логике SQL, поэтому строка молча пропускается. Ни исключения, ни предупреждения -- просто фильтр, который в продакшене тихо не находит ни одной строки.

Работает запрос `o.Notes == null` -- сравнение, которое анализатор ссылочных типов, допускающих null, помечает как всегда ложное, для свойства, которое после материализации действительно никогда не бывает null. Вы пишете код, который компилятор считает мёртвым, чтобы получить нужный SQL. `string.IsNullOrEmpty` выживает лишь случайно: EF разворачивает его в два предиката, и половина с `IS NULL` вытягивает результат. `Length == 0` не работает по обычной причине -- NULL распространяется через `length()`.

Это не баг, который чинится где-то ниже по течению. Именно это имеет в виду [issue #26230](https://github.com/dotnet/efcore/issues/26230) под формулировкой "value conversion to null in the store generates bad queries", и именно поэтому команда EF пометила конструктор внутренним в версии 6.0 вместо публичного выпуска: сбой невидим и его нелегко обнаружить. Если вы всё же идёте этим путём, смягчение состоит в том, чтобы проверять предикат, а не доверять ему: либо через `ToQueryString()` в тесте, либо [логируя SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Почему это не работает для enum, int или DateTime

Для типа значения, не допускающего null, `convertsNulls` доводит вас до середины и останавливается. Напишем converter:

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToUnknown : ValueConverter<ShippingStatus, string?>
{
    public NullToUnknown()
        : base(
            v => v == ShippingStatus.Unknown ? null : v.ToString(),
            v => v == null ? ShippingStatus.Unknown : Enum.Parse<ShippingStatus>(v),
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001
```

Сторона записи работает: сохранение `ShippingStatus.Unknown` записывает `NULL`. Сторона чтения -- нет, и причина в шаге 3 выше. `.IsRequired(false)` выбрасывает исключение на этапе построения модели:

```
System.InvalidOperationException: The property 'Order.Status' cannot be marked as
nullable/optional because the type of the property is 'ShippingStatus' which is not a
nullable type. Any property can be marked as non-nullable/required, but only properties
of nullable types can be marked as nullable/optional.
```

Проверка допустимости null в EF смотрит на CLR-тип, а не на converter, поэтому никакая комбинация настроек до цели не доведёт. Опустите вызов -- и модель сохранит `IsNullable = False`, EF пропустит проверку `IsDBNull`, и любое чтение NULL-строки выбросит исключение. Третьего варианта нет. `convertsNulls` на типе значения, не допускающем null, -- это возможность только для записи, что хуже, чем бесполезно: она с готовностью сохранит NULL, которые та же модель не сможет прочитать обратно.

## Два подхода, которые действительно работают

### Отобразить свойство, допускающее null, и выставить ненулевой фасад

Отображённое свойство честно отражает допустимость null в базе данных. Доменное свойство выполняет подстановку значения на чистом C#, где транслятор запросов не участвует:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    public ShippingStatus? StatusRaw { get; set; }

    [NotMapped]
    public ShippingStatus Status
    {
        get => StatusRaw ?? ShippingStatus.Unknown;
        set => StatusRaw = value == ShippingStatus.Unknown ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.StatusRaw)
        .HasColumnName("Status")
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

Никакого внутреннего API, никакого `EF1001`, и запросы корректны по построению: `Where(o => o.StatusRaw == null)` даёт `WHERE "o"."Status" IS NULL` и находит NULL-строку, а `Where(o => o.StatusRaw == ShippingStatus.Shipped)` даёт `WHERE "o"."Status" = 'Shipped'`. Половина с преобразованием enum в строку -- это обычное встроенное преобразование, описанное в статье [как хранить enum строкой с помощью value converter](/ru/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), включая `HasMaxLength`, который не даёт SQL Server выдать неиндексируемый `nvarchar(max)`.

Цена в том, что LINQ должен обращаться к `StatusRaw`, а не к `Status`. Обращение к `Status` внутри `Where` приводит к [выражение LINQ не удалось транслировать](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), поскольку у членов `[NotMapped]` нет соответствия в SQL. Это честный обмен: транслятор отказывается работать вместо того, чтобы молча выдать `= NULL`.

### Отобразить приватное поле-хранилище

Если вы не хотите расширять публичную поверхность свойством `StatusRaw`, отобразите поле и оставьте одно публичное свойство:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    private string? _notes;

    public string Notes
    {
        get => _notes ?? "";
        set => _notes = value.Length == 0 ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>(e =>
    {
        e.Ignore(o => o.Notes);
        e.Property<string?>("_notes")
            .HasColumnName("Notes")
            .UsePropertyAccessMode(PropertyAccessMode.Field);
    });
}
```

Чтение и запись ведут себя так же, как в варианте с фасадом, а `Where(o => EF.Property<string>(o, "_notes") == null)` транслируется в `WHERE "o"."Notes" IS NULL`. Недостаток в том, что каждый запрос к этому столбцу идёт через строковый `EF.Property<T>`, за которым не последует ни один рефакторинг переименования. Предпочитайте фасад, если только дополнительное публичное свойство не является действительно неприемлемым.

### Или измените данные

Об этом стоит сказать прямо, потому что часто это и есть правильный ответ: если NULL и ваша заглушка означают ровно одно и то же, схема несёт различие, которого нет в предметной области. Один `UPDATE Orders SET Status = 'Unknown' WHERE Status IS NULL`, один `ALTER COLUMN ... NOT NULL` и один `HasDefaultValue("Unknown")` устраняют проблему, а не обходят её. Это миграция данных, а не трюк с отображением, и [как переименовать таблицу в миграции без потери данных](/ru/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) описывает общий вид ручного редактирования миграции, чтобы изменения данных шли рядом с изменениями схемы.

## В каком состоянии находится эта возможность

[Issue #13850](https://github.com/dotnet/efcore/issues/13850), "Allow HasConversion/ValueConverters to convert nulls", по-прежнему открыт и лежит в milestone Backlog без срока. Запрос 2026 года на публичную перегрузку `HasConversion`, принимающую `convertsNulls`, [issue #36365](https://github.com/dotnet/efcore/issues/36365), был закрыт как его дубликат. Так что для EF Core 11 всё остаётся на конструкторе с четырьмя аргументами, вместе с предупреждением.

Используйте его, когда свойство модели -- ссылочный тип, заглушка никогда не применяется в фильтрах, и у вас есть тест, проверяющий `ToQueryString()` для каждого запроса к этому столбцу. Во всех остальных случаях, и всегда для типов значений, отображайте свойство, допускающее null, и выполняйте подстановку в C#.

### Читайте далее

- [Как хранить enum строкой в EF Core 11 с помощью value converter](/ru/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)
- [Решение: "The LINQ expression could not be translated" в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Решение: "The property could not be mapped, because it is not a supported primitive type or a valid entity type" в EF Core 11](/ru/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)
- [Как логировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Решение: CS8618 "Non-nullable property must contain a non-null value when exiting constructor" в C#](/ru/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)

### Источники

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), документация EF Core
- [Конструкторы ValueConverter&lt;TModel,TProvider&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.valueconverter-2.-ctor), справочник API .NET
- [Issue #26230: Problems with value converters that convert nulls](https://github.com/dotnet/efcore/issues/26230), dotnet/efcore
- [Issue #13850: Allow HasConversion/ValueConverters to convert nulls](https://github.com/dotnet/efcore/issues/13850), dotnet/efcore
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), документация EF Core
