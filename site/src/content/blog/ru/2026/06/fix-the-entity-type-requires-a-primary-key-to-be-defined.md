---
title: "Исправление: The entity type 'X' requires a primary key to be defined в EF Core 11"
description: "EF Core не может найти ключ для вашего типа. Назовите свойство Id или {Type}Id, добавьте [Key], вызовите HasKey или, если это представление либо сырой SQL, вызовите HasNoKey."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ru"
translationOf: "2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined"
translatedBy: "claude"
translationDate: 2026-06-12
---

Исправление: EF Core строит вашу модель и находит тип, который считает сущностью, но для которого не может определить первичный ключ. У вас есть три реальных варианта, по порядку: дайте типу ключ (назовите свойство `Id` или `{Type}Id`, добавьте `[Key]` или вызовите `modelBuilder.Entity<T>().HasKey(...)`); сообщите EF Core, что тип намеренно без ключа, через `HasNoKey()` (правильно для представлений и результатов сырого SQL); или не дайте EF Core трактовать его как сущность, удалив лишний `DbSet<T>` или вызвав `modelBuilder.Ignore<T>()`. Выберите тот вариант, который соответствует тому, чем тип является на самом деле.

```text
System.InvalidOperationException: The entity type 'OrderSummary' requires a primary key to be defined.
If you intended to use a keyless entity type, call 'HasNoKey' in 'OnModelCreating'.
For more information on keyless entity types, see https://go.microsoft.com/fwlink/?linkid=2141943.
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateNonNullPrimaryKeys(IModel model)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Это ошибка валидации модели, а не ошибка запроса во время выполнения. Она возникает при первой сборке модели в EF Core: первый запрос, первый `SaveChanges`, первая команда `dotnet ef` или вызов `context.Model`. Имя типа в кавычках -- это тот тип, для которого EF Core не смог определить ключ. Это руководство написано для .NET 11, C# 14 и `Microsoft.EntityFrameworkCore` 11.0.0. Поведение и текст сообщения не менялись со времён EF Core 7, поэтому всё описанное здесь применимо вплоть до той версии.

## Что на самом деле означает "requires a primary key"

Когда EF Core строит вашу модель, он выполняет набор соглашений. Одно из них, `KeyDiscoveryConvention`, пытается выбрать первичный ключ для каждого типа сущности, ища свойство с именем (без учёта регистра) `Id` или `{EntityTypeName}Id`. Если он находит ровно одно такое свойство, оно становится ключом. Если не находит ни одного, сущность остаётся без ключа, и тогда запускается `ModelValidator`, который отклоняет сущности без ключа, не помеченные явно как бесключевые. Это отклонение и есть исключение, которое вы читаете.

Таким образом, ошибка всегда означает одно из двух:

1. EF Core считает этот тип сущностью, но соглашение не смогло определить ключ, а вы его не настроили.
2. EF Core вообще не должен трактовать этот тип как сущность, но что-то затянуло его в модель.

Всё исправление сводится к тому, чтобы выяснить, что из этого верно. Два вопроса решают дело: соответствует ли этот тип реальной таблице или представлению, которые я читаю и записываю, и есть ли у него естественный уникальный идентификатор? Если на оба ответ «да», типу нужен ключ. Если это проекция, строка отчёта или результат сырого SQL, ему нужен `HasNoKey` либо вовсе отсутствие в модели.

## Минимальное воспроизведение

`DbSet` типа, чьё ключевое свойство названо не так, как распознаёт соглашение.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class AppDb : DbContext
{
    public DbSet<OrderSummary> OrderSummaries => Set<OrderSummary>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}

public class OrderSummary
{
    public Guid Reference { get; set; }   // not "Id", not "OrderSummaryId"
    public decimal Total { get; set; }
}
```

`Reference` -- вполне годный идентификатор, но соглашение об этом не знает. Оно искало `Id` или `OrderSummaryId`, не нашло ни того, ни другого, оставило тип без ключа, и валидация упала. Та же ошибка появляется, если вы отображаете SQL-представление на класс, возвращаете строки из `FromSql` в неотображённый тип или случайно выставляете DTO как `DbSet`.

## Исправление 1: дайте типу ключ

Используйте это, когда тип -- настоящая сущность, которую вы запрашиваете и сохраняете. Три способа, в порядке возрастания явности.

Переименуйте свойство, чтобы соглашение его нашло:

```csharp
// .NET 11, EF Core 11.0.0 -- convention discovers this automatically
public class OrderSummary
{
    public Guid Id { get; set; }          // discovered by KeyDiscoveryConvention
    public decimal Total { get; set; }
}
```

Или сохраните собственное имя и аннотируйте его:

```csharp
// .NET 11, EF Core 11.0.0
public class OrderSummary
{
    [Key]
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Или настройте его в `OnModelCreating` -- это правильное место, когда вы не можете или не хотите ставить атрибуты на тип (например, класс живёт в доменном проекте, который не должен ссылаться на EF Core):

```csharp
// .NET 11, EF Core 11.0.0
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderSummary>().HasKey(o => o.Reference);
}
```

Для составного ключа передайте анонимный объект. Эквивалента атрибута `[Key]`, который надёжно задаёт порядок столбцов, нет, поэтому предпочитайте текучую форму:

```csharp
// .NET 11, EF Core 11.0.0 -- composite key, order matters for the index
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });
```

Одна ловушка внутри этого исправления: ключевое свойство должно быть читаемым, отображаемым CLR-свойством. Публичное **поле**, свойство, помеченное `[NotMapped]`, или свойство типа, который EF Core не может отобразить, не будут обнаружены, и вы продолжите получать ошибку, хотя «там же явно есть Id». Сделайте его автосвойством отображаемого типа (`int`, `long`, `Guid`, `string` и так далее).

## Исправление 2: объявите тип бесключевым через HasNoKey

Используйте это, когда у типа действительно нет первичного ключа: представление базы данных, форма результата хранимой процедуры или строка отчёта только для чтения. Бесключевые типы сущностей доступны только для чтения, никогда не отслеживаются механизмом отслеживания изменений и не могут участвовать в `SaveChanges`.

```csharp
// .NET 11, EF Core 11.0.0 -- a view with no natural key
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToView("vw_OrderSummary");
```

Форма с атрибутом -- `[Keyless]` над классом, что эквивалентно вызову `HasNoKey()`:

```csharp
// .NET 11, EF Core 11.0.0
[Keyless]
public class OrderSummary
{
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Если бесключевой тип питается сырым SQL, а не представлением, отобразите его на запрос, а не на таблицу:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToSqlQuery("SELECT Reference, SUM(Total) AS Total FROM Orders GROUP BY Reference");
```

Не хватайтесь за `HasNoKey` лишь для того, чтобы ошибка исчезла на типе, у которого идентичность всё-таки есть. Бесключевую сущность нельзя обновить или удалить через контекст, и EF Core не дедуплицирует строки с одинаковыми значениями, поэтому вы можете молча получить дубликаты в памяти. `HasNoKey` -- это утверждение о данных, а не обходной приём.

## Исправление 3: вообще не давайте EF Core отображать тип

Часто тип не является сущностью и никогда не должен был ею быть. Он попал в модель одним из трёх способов:

- Вы добавили `DbSet<SomeDto>` для проекции или view-model. Удалите его и проецируйте через `Select` в DTO вместо этого.
- У отображённой сущности есть навигационное свойство, указывающее на тип, поэтому EF Core отобразил его транзитивно. Если эта навигация не должна быть связью, пометьте её `[NotMapped]`.
- Вы где-то вызвали `modelBuilder.Entity<SomeDto>()` (часто чтобы задать одно свойство), что регистрирует его как сущность.

Чтобы явно исключить тип, проигнорируйте его:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Ignore<OrderSummary>();
```

Или на свойстве, вызывающем транзитивное отображение:

```csharp
// .NET 11, EF Core 11.0.0
public class Order
{
    public int Id { get; set; }

    [NotMapped]
    public OrderSummary? Computed { get; set; }   // a view model, not a relationship
}
```

Для разовых проекций отображённый тип вам, как правило, вообще не нужен. Проецируйте прямо в нужную форму, и EF Core никогда не пытается дать ей ключ:

```csharp
// .NET 11, EF Core 11.0.0 -- no DbSet, no HasNoKey, nothing to key
var summaries = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => new OrderSummary { Reference = g.Key, Total = g.Sum(o => o.Total) })
    .ToListAsync();
```

## Варианты, приводящие к той же ошибке

### Отображение record без Id

Позиционный `record` отлично работает как сущность, но только если один из его параметров становится обнаруживаемым ключом. `public record OrderSummary(Guid Reference, decimal Total);` попадает в эту ошибку по той же причине, что и класс: `Reference` -- это не `Id`. Назовите первый параметр `Id`, добавьте `[property: Key]` к позиционному параметру или настройте `HasKey` в `OnModelCreating`. Механика отображения record, включая init-only-свойства и равенство по значению, разобрана в руководстве о [корректном использовании record с EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

### Типы результата Database.SqlQuery<T> и FromSql

`db.Database.SqlQuery<OrderSummary>($"...")` отображает `OrderSummary` как неявный бесключевой тип на момент запроса, и этому пути не нужна никакая настройка. Но если вы вдобавок вызовете `modelBuilder.Entity<OrderSummary>()` для того же типа в другом месте, вы уже зарегистрировали его как обычную сущность, и соглашение требует ключ. Либо держите тип полностью вне `OnModelCreating` (пусть `SqlQuery` сам им займётся), либо зарегистрируйте его явно с `HasNoKey()`. Это и есть первопричина в [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), где тип запроса столкнулся с настроенной сущностью того же имени.

### Ошибка называет тип, который вы не писали

Если тип в кавычках -- это тип фреймворка или библиотеки, его затянула навигация. Найдите сущность, которая на него ссылается, и решите: настоящая связь (настройте ключ на ссылаемом типе) или нет (пометьте навигацию `[NotMapped]` или сделайте `Ignore<T>()` для типа). Это часто всплывает со строго типизированными JSON-столбцами и межсхемными внешними ключами, как в [dotnet/efcore#36614](https://github.com/dotnet/efcore/issues/36614).

### Падает только под dotnet ef, а не во время выполнения

`dotnet ef migrations add` и `dotnet ef database update` строят полную модель, поэтому вскрывают ошибки модели, которые узкий путь кода во время выполнения мог ещё не запустить. Ошибка настоящая; инструменты просто нашли её первыми. Если сборка времени проектирования не может даже сконструировать ваш контекст, вы сначала увидите другое сообщение; оно разобрано в материале [почему dotnet ef migrations add не может создать ваш DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

### Ключ, допускающий null, или затенённый ключ

Если ваше ключевое свойство допускает null (`int?`), EF Core его обнаружит, но `ModelValidator` отклонит null-первичные ключи с очень близким сообщением. Сделайте ключ не допускающим null. Аналогично, если и базовый, и производный класс объявляют `Id`, затенённый член может запутать обнаружение; объявите ключ один раз на типе, который отображает EF Core.

## Подтверждение исправления

После применения одного из трёх исправлений принудительно постройте модель, не запуская приложение, чтобы цикл обратной связи был быстрым:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef dbcontext info --startup-project ./Api
```

Если модель валидна, команда печатает провайдера и детали контекста. Если тип всё ещё без ключа и не помечен, она бросает то же исключение, и сообщение точно указывает, какой тип остаётся неразрешённым. Разбирайтесь по одному; модель с несколькими типами представлений или DTO может бросать по разу на тип, пока каждый не будет обработан.

Стоящая того ментальная модель: эта ошибка -- это EF Core, просящий вас классифицировать тип. Сущность с идентичностью, бесключевая форма только для чтения или не-сущность. Как только вы ответите на это, исправление становится механическим. Когда вы подключаете эти типы к тестам и хотите, чтобы отслеживание изменений вело себя правильно, шаблоны из [как мокать DbContext, не ломая отслеживание изменений](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) и [как прогреть модель EF Core перед первым запросом](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) хорошо сочетаются с правильной настройкой ключей.

## Источники

- [Keyless entity types](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types), документация EF Core, о `HasNoKey`, `[Keyless]` и ограничениях только для чтения.
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys), документация EF Core, об обнаружении по соглашению, `[Key]` и составных ключах.
- [Model validation and conventions](https://learn.microsoft.com/en-us/ef/core/modeling/), документация EF Core.
- [dotnet/efcore#29198](https://github.com/dotnet/efcore/issues/29198) и [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), канонические issue за этим сообщением.
