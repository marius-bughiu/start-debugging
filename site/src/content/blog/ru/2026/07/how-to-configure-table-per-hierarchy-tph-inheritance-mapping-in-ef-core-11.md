---
title: "Как настроить наследование по стратегии таблица на иерархию (TPH) в EF Core 11"
description: "TPH -- стратегия наследования по умолчанию в EF Core: одна таблица, один столбец-дискриминатор. Как настроить дискриминатор, разделять столбцы, обрабатывать nullable-свойства производных типов и обойти подводные камни в EF Core 11."
pubDate: 2026-07-13
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-13
---

Короткий ответ: в EF Core 11 (с .NET 11 и C# 14) вам не нужно делать ничего, чтобы получить стратегию таблица на иерархию (TPH). Это поведение по умолчанию. Как только вы отображаете базовый тип и хотя бы один производный, EF Core сохраняет всю иерархию в одной таблице и добавляет строковый столбец `Discriminator`, чтобы различать строки. Настройка сводится к тонкой доводке этого поведения: переименовать столбец-дискриминатор через `HasDiscriminator`, выбрать сохраняемые значения через `HasValue`, отобразить дискриминатор на реальное свойство, пометить иерархию как неполную через `IsComplete(false)` и разделять столбцы между родственными типами. EF Core 11 также снимает давнее ограничение, позволяя использовать комплексные типы и столбцы JSON в иерархиях наследования, и исправляет специфичный для TPH баг с nullability для комплексных свойств, отображённых в JSON.

Эта статья охватывает точный API настройки, схему, которую генерирует EF Core, как на самом деле работает запрос к иерархии TPH, подвох с nullable-столбцами, на который натыкается каждый хотя бы раз, и когда TPH перестаёт быть правильным выбором.

## Почему TPH -- значение по умолчанию и обычно правильный выбор

EF Core поддерживает три реляционные стратегии наследования: таблица на иерархию (TPH), таблица на тип (TPT) и таблица на конкретный тип (TPC). TPH используется по умолчанию, потому что она самая быстрая для типичного случая. Всё живёт в одной таблице, так что загрузка сущности -- это чтение одной строки без join, а запрос базового типа -- обычный `SELECT` без `UNION` и без ветвления по таблицам. И [документация по наследованию EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance), и [руководство по производительности](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping) приходят к одному правилу: используйте TPH, если только бенчмарк или внешнее ограничение не заставят вас от него отказаться.

Цена, которую вы платите, -- более широкая и разреженная таблица. Каждое свойство каждого производного типа становится столбцом общей таблицы, а любой столбец, который используют лишь некоторые строки, должен быть nullable. Для большинства иерархий этот компромисс приемлем. Когда он перестаёт быть приемлемым, вы переходите к TPT или TPC -- это отдельное решение, рассмотренное в конце.

## Отображение по умолчанию, без какой-либо настройки

EF не сканирует вашу сборку в поисках производных типов. Вы включаете каждый тип в модель явно, обычно предоставляя `DbSet` или ссылаясь на него в `OnModelCreating`. Вот двухуровневая иерархия:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public string Network { get; set; } = "";
}

public class BankTransferPayment : Payment
{
    public string Iban { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
    public DbSet<CardPayment> CardPayments { get; set; } = null!;
    public DbSet<BankTransferPayment> BankTransferPayments { get; set; } = null!;
}
```

Вообще без конфигурации наследования EF Core 11 генерирует одну таблицу со всеми свойствами всех типов плюс столбец `Discriminator`, который он добавляет неявно:

```sql
CREATE TABLE [Payments] (
    [Id] int NOT NULL IDENTITY,
    [Amount] decimal(18,2) NOT NULL,
    [CreatedAt] datetime2 NOT NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [Last4] nvarchar(max) NULL,
    [Network] nvarchar(max) NULL,
    [Iban] nvarchar(max) NULL,
    CONSTRAINT [PK_Payments] PRIMARY KEY ([Id])
);
```

Стоит обратить внимание на две вещи. Дискриминатор -- строковый столбец, хранящий имя CLR-типа (`"CardPayment"`, `"BankTransferPayment"`, `"Payment"`), чтобы EF знал, какой тип материализовать для каждой строки. И `Last4`, `Network` и `Iban` все nullable, потому что у строки `BankTransferPayment` нет полей карты, а у строки `CardPayment` нет IBAN. Эта nullability автоматическая и, как мы увидим, её нельзя переопределить для свойства производного типа.

## Как запрос TPH фильтрует по типу

Когда вы запрашиваете базовый тип, EF Core читает каждую строку и по дискриминатору строит для неё правильный конкретный объект:

```csharp
// .NET 11, EF Core 11
var all = await context.Payments.ToListAsync();
// SELECT [p].[Id], [p].[Amount], [p].[CreatedAt], [p].[Discriminator],
//        [p].[Last4], [p].[Network], [p].[Iban]
// FROM [Payments] AS [p]
```

Когда вы запрашиваете производный тип, EF добавляет предикат по дискриминатору, так что вы получаете только подходящие строки:

```csharp
// .NET 11, EF Core 11
var cards = await context.CardPayments
    .Where(c => c.Network == "Visa")
    .ToListAsync();
// ... WHERE [p].[Discriminator] = N'CardPayment' AND [p].[Network] = N'Visa'
```

Вы также можете фильтровать по типу внутри запроса базового типа через `OfType<T>()` или паттерн типа C#, и оба транслируются в один и тот же предикат по дискриминатору:

```csharp
// .NET 11, EF Core 11
var cardsOnly = await context.Payments.OfType<CardPayment>().ToListAsync();
```

Есть одно правило материализации, которое стоит знать: если таблица содержит значение дискриминатора, не сопоставленное ни с одним типом вашей модели, EF выбрасывает исключение, дойдя до этой строки, потому что не знает, что строить. Это происходит только если что-то помимо EF записало строки с неизвестным дискриминатором. Если это ваш случай, пометьте отображение как неполное (ниже), чтобы EF всегда добавлял предикат-фильтр дискриминатора, даже для запросов базового типа.

## Настройка столбца-дискриминатора и его значений

Неявный столбец `Discriminator` и хранящиеся в нём имена CLR-типов редко являются тем, что вам нужно в схеме, с которой придётся жить. Переименуйте столбец, зафиксируйте его тип и выберите стабильные строковые значения через `HasDiscriminator` и `HasValue`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Payment>()
        .HasDiscriminator<string>("payment_type")
        .HasValue<Payment>("base")
        .HasValue<CardPayment>("card")
        .HasValue<BankTransferPayment>("bank_transfer");
}
```

Фиксация явных строк `HasValue` важнее, чем кажется. Если вы полагаетесь на значение по умолчанию (имя CLR-типа), то переименование класса при последующем рефакторинге незаметно меняет сохранённое значение дискриминатора, и каждая существующая строка в продакшене теперь имеет значение, которое ваша новая модель не распознаёт. Явные значения развязывают базу данных и имена ваших классов.

Дискриминатор не обязан быть строкой. `int` или `enum` меньше и лучше индексируется:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator<int>("payment_type")
    .HasValue<Payment>(0)
    .HasValue<CardPayment>(1)
    .HasValue<BankTransferPayment>(2);
```

Поскольку EF добавляет дискриминатор неявно как [теневое свойство](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), вы можете настраивать его как любое другое свойство, например ограничить длину строки, чтобы она не была `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .Property("payment_type")
    .HasMaxLength(20);
```

## Отображение дискриминатора на реальное свойство .NET

Иногда вы хотите, чтобы метка типа была читаемой на самой сущности, а не спрятанной в теневом свойстве. Добавьте свойство базовому типу и укажите на него в `HasDiscriminator`:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PaymentType { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator(p => p.PaymentType)
    .HasValue<CardPayment>("card")
    .HasValue<BankTransferPayment>("bank_transfer");
```

Теперь `payment.PaymentType` заполняется для каждой загруженной сущности. EF управляет значением: он устанавливает его при вставке на основе конкретного типа и не даст записать значение, противоречащее типу. Считайте его в своём коде только для чтения. Отображённый дискриминатор удобен для отчётных запросов и для ответов API, где клиенту нужно имя типа без рефлексии с вашей стороны.

## Сообщаем EF, что иерархия неполная

Если другая система пишет строки в ту же таблицу со значениями дискриминатора, которые вы намеренно не отображаете, пометьте дискриминатор как неполный, чтобы EF всегда фильтровал, в том числе в запросах базового типа:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator()
    .IsComplete(false);
```

С `IsComplete(false)` вызов `context.Payments.ToListAsync()` добавляет `WHERE [payment_type] IN (N'card', N'bank_transfer', ...)` и пропускает строки, чей дискриминатор не отображён, вместо того чтобы выбрасывать по ним исключение. Это как раз запасной выход для общей таблицы, где EF владеет лишь частью типов.

## Разделение столбца между родственными типами

По умолчанию два родственных типа, оба объявляющие свойство с одним именем, получают два отдельных столбца. Если свойства одного типа и действительно представляют одно и то же хранилище, отобразите их на один столбец через `HasColumnName`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Reference)
    .HasColumnName("Reference");

modelBuilder.Entity<BankTransferPayment>()
    .Property(b => b.Reference)
    .HasColumnName("Reference");
```

Это делает таблицу уже, но есть ловушка запроса, на которую документация указывает прямо. Реляционные провайдеры не добавляют предикат дискриминатора, когда вы читаете общий столбец через приведение. Запрос вроде `(payment as CardPayment).Reference` возвращает значение `Reference` и для родственных строк, потому что столбец физически общий. Чтобы ограничить его одним типом, нужно самому ветвить по типу:

```csharp
// .NET 11, EF Core 11 - guard the cast so siblings return null
var refs = await context.Payments
    .Select(p => p is CardPayment ? ((CardPayment)p).Reference : null)
    .ToListAsync();
```

Разделяйте столбцы только когда значения действительно означают одно и то же понятие. При сомнении дайте EF выделить каждому родственнику свой nullable-столбец.

## Подвох с nullable-столбцами, которого никто не ждёт

Вот тот, что удивляет людей. Свойство, обязательное для производного типа, не может быть столбцом `NOT NULL` при TPH. Поскольку все типы делят одну таблицу, столбец, принадлежащий `CardPayment`, должен быть nullable, чтобы строки `BankTransferPayment` могли оставить его пустым. Даже если `Last4` помечено `required` в C#, EF Core вынужден отобразить его как nullable-столбец:

```sql
[Last4] nvarchar(max) NULL   -- required on CardPayment, still NULL in the DB
```

База данных не будет за вас гарантировать, что "у каждого платежа картой есть Last4". Уровень приложения и собственная валидация EF Core обеспечивают это при записи, но сырой `INSERT` или неудачная миграция могут создать строку карты с null в `Last4`, и схема этого не остановит. Если гарантированный на уровне базы данных non-null для производных свойств -- жёсткое требование, это настоящая причина выбрать TPT (каждый тип получает свою таблицу, так что там столбец может быть `NOT NULL`) или добавить ограничение `CHECK` вручную в миграции. Это самая частая причина, по которой команда уводит иерархию с TPH, так что взвесьте это, прежде чем закрепляться.

## Что EF Core 11 изменил для наследования

Сама TPH стабильна годами; изменения EF Core 11 касаются того, что можно поместить внутрь иерархии. Комплексные типы и столбцы JSON теперь работают на типах сущностей, использующих наследование TPT и TPC, что раньше не поддерживалось и вынуждало возвращаться к owned-сущностям для любого унаследованного объекта-значения. TPH уже поддерживала комплексные типы, и EF Core 11 исправил специфичный для TPH баг, где [комплексное свойство, хранящееся как JSON, ошибочно помечалось как не-nullable в иерархии классов TPH](https://github.com/dotnet/efcore/issues/37404). Так что объект-значение, отображённый в таблицу TPH, теперь ведёт себя nullable так, как и должен:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class CardMetadata
{
    public required string Bin { get; set; }
    public string? IssuerCountry { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public CardMetadata? Metadata { get; set; }
}
```

Конфигурация тоже стала короче по всем фронтам. EF Core 11 позволяет сцеплять доступ к членам напрямую через `Property`, так что углубление в комплексный тип или в свойство рядом с дискриминатором больше не требует промежуточного построителя:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Metadata!.Bin)
    .HasMaxLength(8);
```

Если вы сочетаете унаследованный объект-значение с отображением через разделение таблицы или JSON, механика этого отображения та же, что в [как отобразить комплексный тип вместо owned-сущности в EF Core 11](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), а сторона запросов JSON рассмотрена в [как отображать и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Массовые обновления и фильтры запросов хорошо ладят с TPH

Поскольку иерархия TPH -- это одна таблица, `ExecuteUpdate` и `ExecuteDelete` чисто нацеливаются на производный тип, применяя за вас предикат дискриминатора:

```csharp
// .NET 11, EF Core 11
await context.CardPayments
    .Where(c => c.Network == "Amex")
    .ExecuteUpdateAsync(s => s.SetProperty(c => c.Amount, c => c.Amount * 1.03m));
// UPDATE [p] SET [p].[Amount] = ... WHERE [p].[payment_type] = N'card' AND ...
```

Компромиссы между этим путём и загрузкой сущностей те же, что в [как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Фильтры запросов тоже сочетаются с дискриминатором, так что фильтр мягкого удаления или мультиарендности на базовом типе применяется ко всей иерархии, как описано в [как использовать именованные фильтры запросов для мягкого удаления и мультиарендности в EF Core 11](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## Когда уходить с TPH

Оставайтесь на TPH, если только не выполнено одно из этого:

- **Вам нужен гарантированный базой данных non-null для производных свойств.** TPH этого не может; общий столбец обязан быть nullable. TPT даёт каждому типу свою таблицу, где столбец может быть `NOT NULL`.
- **Таблица становится по-настоящему разреженной и широкой.** Иерархия со множеством производных типов, каждый из которых добавляет несколько обязательных в коде столбцов, порождает таблицу, состоящую в основном из null. Если это вредит хранилищу или ваш DBA против, TPT нормализует это ценой join.
- **Вы в основном запрашиваете один листовой тип, и бенчмарки показывают выигрыш TPC.** TPC держит каждый конкретный тип в своей таблице со всеми столбцами inline, что может обойти TPH на запросах одного листового типа. Измерьте перед переходом; TPC приносит свою генерацию ключей и ограничения внешних ключей.

Учтите, что смена типа сущности во время выполнения (превращение `CardPayment` в `BankTransferPayment`) не поддерживается ни в одной стратегии. Вы удаляете и вставляете заново. Это реальность моделирования, а не ограничение TPH.

Практическое правило: TPH -- значение по умолчанию, потому что это правильное значение по умолчанию. Настройте дискриминатор так, чтобы ваша схема не зависела от имён классов, помните, что столбцы производных типов всегда nullable, и обращайтесь к TPT или TPC только когда конкретное ограничение или реальный бенчмарк подскажут это. Если это решение -- часть более крупного скачка версий, [руководство по миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) охватывает изменения наследования и отображения, которые обычно всплывают рядом.

## Похожие материалы

- [Как отобразить комплексный тип вместо owned-сущности в EF Core 11](/ru/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) объясняет отображение объектов-значений, которое теперь работает внутри иерархий наследования.
- [Как отображать и запрашивать столбцы JSON в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) охватывает JSON-сторону комплексных свойств в таблице TPH.
- [Как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) показывает путь массовой записи, который предикаты дискриминатора оставляют чистым.
- [Как использовать именованные фильтры запросов для мягкого удаления и мультиарендности в EF Core 11](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) сочетает глобальные фильтры с иерархией TPH.
- [Fix: The entity type requires a primary key to be defined в EF Core 11](/ru/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined) -- дополнение, когда у базового или производного типа отсутствует ключ.

## Источники

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Modeling for performance: inheritance mapping](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core shadow properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)
- [Complex property stored as JSON marked non-nullable in TPH class hierarchy (efcore#37404)](https://github.com/dotnet/efcore/issues/37404)
