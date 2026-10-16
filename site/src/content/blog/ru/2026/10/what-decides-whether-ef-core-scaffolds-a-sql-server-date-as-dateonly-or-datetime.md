---
title: "Что определяет, создаст ли EF Core для столбца SQL Server `date` тип `DateOnly` или `DateTime` при scaffold?"
description: "Это определяет версия EF Core у провайдера SQL Server в вашем стартовом проекте: EF Core 7 и более ранние создают для date тип DateTime, EF Core с 8 по 11 создают DateOnly. Здесь показано сопоставление типов, которое принимает решение, измеренный результат для EF Core 7, 8, 10 и 11 RC 2, а также два способа вернуть DateTime, не переключив столбец незаметно на datetime2."
pubDate: 2026-10-16
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "sql-server"
  - "scaffolding"
  - "dateonly"
lang: "ru"
translationOf: "2026/10/what-decides-whether-ef-core-scaffolds-a-sql-server-date-as-dateonly-or-datetime"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Короткий ответ:** решает одно: версия `Microsoft.EntityFrameworkCore.SqlServer` (и `Microsoft.EntityFrameworkCore.Design`), на которую ссылается ваш стартовый проект при запуске `dotnet ef dbcontext scaffold`. Scaffolder спрашивает у источника сопоставления типов провайдера, какой тип CLR используется по умолчанию для каждого типа хранилища. До EF Core 7 включительно для `date` возвращается `DateTime`, а для `time` возвращается `TimeSpan`. Начиная с EF Core 8, через EF Core 10 и release candidate EF Core 11, возвращаются `DateOnly` и `TimeOnly`. Переключателя `dotnet ef`, который это меняет, нет. Если нужно вернуть `DateTime`, либо переопределите сопоставление типов на этапе проектирования через `IDesignTimeServices`, либо отредактируйте шаблон T4. Если применить исправление шаблона из официальных заметок о критических изменениях как написано, ваши столбцы `date` во время выполнения окажутся сопоставлены с `datetime2`. Ниже показано, почему так происходит и как это исправить.

Всё ниже я измерял на macOS с SDK 10.0.302 для `Microsoft.EntityFrameworkCore.SqlServer` 7.0.20, 8.0.32, 10.0.13 и 11.0.0-rc.2.26504.105 (на SDK 11.0.100-rc.1). SQL Server на этой машине нет, поэтому `DatabaseModel`, который scaffolder обычно читает из `INFORMATION_SCHEMA`, я собрал вручную и пропустил через настоящие службы этапа проектирования SQL Server. Путь генерации кода (фабрика модели scaffolding, генератор C#, шаблоны T4) тот же, что выполняет `dotnet ef dbcontext scaffold` после чтения схемы.

## Решение принимает источник сопоставления типов, а не инструмент

При scaffold EF Core читает тип хранилища каждого столбца (`date`, `datetime2`, `nvarchar(50)` и так далее) и должен выбрать тип CLR. Отдельной таблицы правил scaffolding для этого нет. Вызывается `IScaffoldingTypeMapper.FindMapping(storeType, ...)`, который запрашивает у `IRelationalTypeMappingSource` провайдера сопоставление по умолчанию для этого типа хранилища. Тип CLR, который провайдер регистрирует для `date` первым, и попадает в вашу сущность.

В EF Core 8 провайдер SQL Server получил встроенную поддержку `DateOnly` и `TimeOnly` ([dotnet/efcore#24507](https://github.com/dotnet/efcore/issues/24507)) и сделал их сопоставлениями по умолчанию для `date` и `time`. Страница [критических изменений EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only) описывает это как изменение среднего влияния, которое затрагивает только пользователей database-first, повторно выполняющих scaffold.

Вот проба, которая напрямую обращается к mapper:

```csharp
// .NET 10, EF Core 10.0.13 (same code compiles against 7.0.20, 8.0.32, 11.0.0-rc.2)
// Reference Microsoft.EntityFrameworkCore.Design with IncludeAssets="all" so the code can see its types.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Design.Internal;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
new SqlServerDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
var mapper = services.BuildServiceProvider().GetRequiredService<IScaffoldingTypeMapper>();

foreach (var storeType in new[] { "date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset" })
    Console.WriteLine($"{storeType,-15} -> {mapper.FindMapping(storeType, keyOrIndex: false, rowVersion: false)?.ClrType.Name}");
```

Результаты, по одному столбцу на версию провайдера:

| Тип хранилища | EF Core 7.0.20 | EF Core 8.0.32 | EF Core 10.0.13 | EF Core 11.0 RC 2 |
| --- | --- | --- | --- | --- |
| `date` | `DateTime` | `DateOnly` | `DateOnly` | `DateOnly` |
| `time` | `TimeSpan` | `TimeOnly` | `TimeOnly` | `TimeOnly` |
| `datetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetime2` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `smalldatetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetimeoffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` |

Итак, вот факты, которые это определяют:

- **Версия пакета провайдера в стартовом проекте.** `dotnet ef` загружает `Microsoft.EntityFrameworkCore.Design` и провайдер из выходных файлов сборки вашего проекта, а не из пакета инструмента, поэтому сопоставление берётся из версии EF Core проекта. Закрепление более старого инструмента `dotnet-ef` `DateTime` не вернёт. Вы получите лишь предупреждение "tools version is older than that of the runtime", а то и что-нибудь похуже.
- **Тип хранилища, а не данные.** Изменились `date` и `time`. Типы `datetime`, `datetime2` и `smalldatetime` во всех версиях создаются как `DateTime`, потому что ни один из них не хранит только дату.
- **Провайдер.** Это решение принимается для каждого провайдера отдельно. Службы этапа проектирования Npgsql (я проверял 10.0.3) тоже сопоставляют `date` PostgreSQL с `DateOnly`, а `time` с `TimeOnly`.

Больше ничто не влияет: ни версия SQL Server, ни уровень совместимости базы данных, ни `--use-database-names`, ни `--data-annotations`.

## Как выглядит сгенерированный код до и после

Я выполнил scaffold таблицы с ключом `int`, столбцом `date NOT NULL`, столбцом `date`, допускающим null, столбцом `time` и столбцом `datetime2`. EF Core 7.0.20 пишет следующее:

```csharp
// Scaffolded by EF Core 7.0.20
public partial class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShippedOn { get; set; }
    public TimeSpan CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
    entity.Property(e => e.OrderDate).HasColumnType("date");
    entity.Property(e => e.ShippedOn).HasColumnType("date");
});
```

EF Core 8.0.32, 10.0.13 и 11.0 RC 2 пишут следующее, идентично во всех трёх:

```csharp
// Scaffolded by EF Core 8.0.32 / 10.0.13 / 11.0.0-rc.2
public partial class Order
{
    public int Id { get; set; }
    public DateOnly OrderDate { get; set; }
    public DateOnly? ShippedOn { get; set; }
    public TimeOnly CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
});
```

Обратите внимание, что исчезло из `OnModelCreating`. В EF Core 7 `DateTime` по соглашению сопоставляется с `datetime2`, поэтому scaffolder должен был записать `HasColumnType("date")`, чтобы столбец остался `date`. В EF Core 8+ `DateOnly` по соглашению сопоставляется с `date`, поэтому scaffolder считает `HasColumnType("date")` избыточным и убирает его. Тип столбца больше нигде не присутствует в сгенерированном коде. Он подразумевается типом CLR. Именно из-за этой детали очевидный способ вернуться к `DateTime` оказывается неработающим.

## Исправление шаблона из документации теряет тип столбца

Страница критических изменений предлагает способ смягчения: выполнить `dotnet new ef-templates`, открыть `CodeTemplates/EFCore/EntityType.t4` и подменять тип CLR, когда столбец имеет тип `date` или `time`:

```csharp
// EntityType.t4 snippet from the EF Core 8 breaking-changes page
var clrType = property.GetColumnType() switch
{
    "date" when property.ClrType == typeof(DateOnly) => typeof(DateTime),
    "date" when property.ClrType == typeof(DateOnly?) => typeof(DateTime?),
    "time" when property.ClrType == typeof(TimeOnly) => typeof(TimeSpan),
    "time" when property.ClrType == typeof(TimeOnly?) => typeof(TimeSpan?),
    _ => property.ClrType
};
```

Я применил эту правку к шаблонам EF Core 10.0.13 (`Microsoft.EntityFrameworkCore.Templates` 10.0.13) и снова выполнил scaffold. Теперь сущность содержит `DateTime OrderDate`. Но `DbContext.t4` по-прежнему формирует fluent API из модели, где свойство имеет тип `DateOnly`, поэтому он по-прежнему не добавляет `HasColumnType("date")`. В итоге вы получаете свойство `DateTime` без типа столбца где-либо.

Во время выполнения EF Core применяет соглашение для `DateTime`, то есть `datetime2`. Вот контекст, соответствующий тому, что выдал шаблон, рядом с контекстом, где тип столбца восстановлен:

```csharp
// .NET 10, EF Core 10.0.13
var day = new DateTime(2026, 10, 16);
foreach (DbContext db in new DbContext[] { new ImplicitContext(), new ExplicitContext() })
{
    var p = db.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.OrderDate))!;
    Console.WriteLine($"{db.GetType().Name}: {p.GetColumnType()}");
    Console.WriteLine(db.Set<Order>().Where(o => o.OrderDate == day).ToQueryString());
}

public class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
}

public class ImplicitContext() : ShopContext(false); // what the docs' template produces
public class ExplicitContext() : ShopContext(true);  // with HasColumnType("date")

public abstract class ShopContext(bool explicitType) : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlServer("Server=.;Database=Shop");
    protected override void OnModelCreating(ModelBuilder b) => b.Entity<Order>(e =>
    {
        e.Property(x => x.Id).ValueGeneratedNever();
        if (explicitType) e.Property(x => x.OrderDate).HasColumnType("date");
    });
}
```

Вывод:

```text
ImplicitContext: datetime2
DECLARE @day datetime2 = '2026-10-16T00:00:00.0000000';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
ExplicitContext: date
DECLARE @day date = '2026-10-16';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
```

Без типа столбца каждый параметр, сравниваемый с этим столбцом, передаётся по сети как `datetime2`. У `datetime2` более высокий [приоритет типов данных](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), чем у `date`, поэтому SQL Server преобразует столбец в `datetime2` для сравнения. Значение `DateTime` с временной частью тогда никогда не равно сохранённой дате, тогда как параметр `date` сначала отбросил бы время. Если проект также использует миграции, `GenerateCreateScript()` теперь выдаёт `[OrderDate] datetime2 NOT NULL`, и следующий `migrations add`, затрагивающий таблицу, захочет изменить столбец. Половина сниппета про `time` безвредна, потому что `TimeSpan` и так сопоставляется с `time` по соглашению.

Исправление состоит ещё из одного блока в том же шаблоне, сразу после `switch`, чтобы подменённое свойство несло с собой свой тип хранилища:

```csharp
// CodeTemplates/EFCore/EntityType.t4, EF Core 10.0.13 templates, after the clrType switch
        usings.AddRange(code.GetRequiredUsings(clrType));

        if (clrType != property.ClrType)
        {
            // Keep the store type: DateTime/TimeSpan would otherwise map to datetime2/time by convention.
            usings.Add("System.ComponentModel.DataAnnotations.Schema");
#>
    [Column(TypeName = "<#= property.GetColumnType() #>")]
<#
        }
```

Затем замените `property.ClrType` на `clrType` в строках `needsNullable`, `needsInitializer` и в строках свойств, как показано в документации. После повторного scaffold сущность выглядит так:

```csharp
// Scaffolded by EF Core 10.0.13 with the patched EntityType.t4
using System.ComponentModel.DataAnnotations.Schema;

public partial class Order
{
    public int Id { get; set; }

    [Column(TypeName = "date")]
    public DateTime OrderDate { get; set; }

    [Column(TypeName = "date")]
    public DateTime? ShippedOn { get; set; }

    [Column(TypeName = "time")]
    public TimeSpan CutoffTime { get; set; }

    public DateTime CreatedAt { get; set; }
}
```

Атрибут выводится независимо от того, передаёте ли вы `--data-annotations`, потому что его пишет код вашего шаблона, а не генератор кода аннотаций. Это именно то, что нужно, так как fluent-часть его никогда не запишет.

## Более чистый откат: переопределить сопоставление типов на этапе проектирования

Подход с шаблоном исправляет результат уже после того, как EF решил, что свойство имеет тип `DateOnly`. Более надёжный вариант меняет само решение, из-за чего EF Core 8+ ведёт себя в точности как EF Core 7 для `date` и `time`, включая fluent API. `dotnet ef` находит любую реализацию `IDesignTimeServices` в стартовом проекте и запускает её **после** собственных регистраций провайдера и EF (см. `DesignTimeServicesBuilder.CreateServiceCollection`), поэтому более поздний `AddSingleton` побеждает:

```csharp
// .NET 10, EF Core 10.0.13 / 11.0. Lives in the startup project; only used by dotnet ef.
#pragma warning disable EF1001 // SqlServerTypeMappingSource is an internal API
using System.Data;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.SqlServer.Infrastructure.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

public sealed class ShopDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IRelationalTypeMappingSource, DateTimeScaffoldingTypeMappingSource>();
}

public sealed class DateTimeScaffoldingTypeMappingSource(
    TypeMappingSourceDependencies dependencies,
    RelationalTypeMappingSourceDependencies relationalDependencies,
    ISqlServerSingletonOptions sqlServerSingletonOptions)
    : SqlServerTypeMappingSource(dependencies, relationalDependencies, sqlServerSingletonOptions)
{
    protected override RelationalTypeMapping? FindMapping(in RelationalTypeMappingInfo mappingInfo)
        => mappingInfo.StoreTypeNameBase switch
        {
            "date" => new SqlServerDateTimeTypeMapping("date", DbType.Date),
            "time" => new SqlServerTimeSpanTypeMapping("time"),
            _ => base.FindMapping(mappingInfo)
        };
}
```

С этой регистрацией EF Core 10.0.13 создаёт для той же таблицы результат EF Core 7 байт в байт: `DateTime OrderDate`, `DateTime? ShippedOn`, `TimeSpan CutoffTime` и `HasColumnType("date")` снова в `OnModelCreating`. Поскольку теперь сравнение происходит между `DateTime` и его значением по умолчанию `datetime2`, генератор кода знает, что явный тип столбца нужен. Столбец `time(0)` тоже обрабатывается правильно, как `HasColumnType("time(0)")`, тогда как стандартный EF Core 10 пишет `TimeOnly` с `HasPrecision(0)`.

Три вещи, которые стоит знать об этом способе:

- `SqlServerTypeMappingSource` находится в пространстве имён `Internal`, отсюда подавление `EF1001`. В EF Core 8 и 9 его конструктор принимал два параметра, а в EF Core 10 получил `ISqlServerSingletonOptions`, так что при обновлении мажорных версий ожидайте, что этот класс придётся править.
- Он влияет только на этап проектирования. Ваш `DbContext` во время выполнения эту службу никогда не видит, потому что `IDesignTimeServices` вызывается только инструментами.
- Используйте `AddSingleton`, а не `TryAddSingleton`. Провайдер уже зарегистрировал свой источник сопоставления типов, поэтому `TryAdd` молча ничего не делает. Та же ловушка встречается, когда вы [заменяете плюрализатор для `dbcontext scaffold`](/ru/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/).

Если вы выполняете scaffold через EF Core Power Tools или его CLI `efcpt`, это уже встроено: его механизм обратной разработки поставляется с переопределением `SqlServerTypeMappingSource`, делающим ровно описанное выше, которое включается параметрами `type-mappings` / `use-DateOnly-TimeOnly` в `efcpt-config.json`. Опубликованная схема конфигурации указывает для этого параметра значение по умолчанию `false`, поэтому проверьте свой файл конфигурации, а не предполагайте, какой тип получите.

## Нужно ли вообще возвращаться к DateTime?

Обычно нет. Для столбца, хранящего календарный день, `DateOnly` является честным типом. `DateTime`, сопоставленный с `date`, несёт время и `Kind`, которые база данных отбрасывает, и это несоответствие стоит за множеством ошибок на один день, когда значения пересекают часовые пояса или границы JSON. EF Core 8+ транслирует распространённые члены `DateOnly` для SQL Server, `System.Text.Json` из коробки сериализует его как `"2026-10-16"`, а Dapper [снова нативно поддерживает `DateOnly` начиная с 2.1.86](/ru/2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support/).

Возвращайтесь к `DateTime`, когда не можете перевести потребителей в том же релизе: общая сборка DTO, слой отчётности, который везде выполняет арифметику над `DateTime`, или команда, которая выполняет повторный scaffold еженедельно и не может разом справиться с сотнями ошибок компиляции. В таком случае выберите одно из двух описанных выше исправлений и сделайте его частью репозитория, чтобы следующий, кто выполнит повторный scaffold, получил те же типы.

## Подводные камни после повторного scaffold

- **Наполовину перенесённые модели.** Если вы выполняете scaffold только части таблиц с `--table`, новые сущности получают `DateOnly`, а старые, поддерживаемые вручную, сохраняют `DateTime`. Оба варианта работают, так как EF Core 8+ нормально сопоставляет `DateTime` с `HasColumnType("date")`, но соединения и сравнения между ними теперь требуют преобразований в C#. Выбирайте один тип на столбец, а не на дату scaffold.
- **Модели code-first не затронуты.** Значение по умолчанию для существующего свойства `DateTime` по-прежнему `datetime2`, а явный `HasColumnType("date")` по-прежнему работает. При обновлении пакета во время выполнения ничего не меняется. Меняется только заново сгенерированный код. Если после обновления миграция вдруг хочет изменить столбец, поищите отсутствующий тип столбца, как выше, затем прочитайте, [почему EF Core сообщает об отложенных изменениях модели](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/).
- **`datetime` остаётся `DateTime`.** Изменились только `date` и `time`. Устаревший столбец `datetime` (точность 3.33 мс) по-прежнему создаётся как `DateTime` с `HasColumnType("datetime")` во всех версиях.
- **Обновление с EF Core 6 или 7 с пакетом ErikEJ.** Если вы использовали `ErikEJ.EntityFrameworkCore.SqlServer.DateOnlyTimeOnly` и `UseDateOnlyTimeOnly()`, чтобы получить `DateOnly` до EF Core 8, удалите оба при обновлении. Теперь поддержка встроена. Остальная часть этого перехода разобрана в [руководстве по критическим изменениям с EF Core 6 до 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Проверяйте SQL, а не C#.** Переключение на `datetime2` выше компилируется, работает и возвращает правдоподобные результаты для значений в полночь. Увидеть его можно только по типу параметра, поэтому [журналируйте SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) или хотя бы раз вызовите `ToQueryString()` после любой кастомизации scaffolding.

## Связанные материалы

- [Как добавить пользовательскую плюрализацию в `dotnet ef dbcontext scaffold` с помощью `IPluralizer`](/ru/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/), ещё один хук `IDesignTimeServices`, который понадобится вам в том же классе.
- [Миграция с EF Core 6 на EF Core 11: критические изменения, которые больно бьют](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Исправление "The JSON value could not be converted to System.DateTime"](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/), включая случай, когда значение в сообщении должно быть `DateOnly`.
- [Как журналировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Источники

- [Breaking changes in EF Core 8.0: SQL Server `date` and `time` now scaffold to `DateOnly` and `TimeOnly`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only), Microsoft Learn.
- [dotnet/efcore#24507: DateOnly and TimeOnly support for SQL Server](https://github.com/dotnet/efcore/issues/24507)
- [Custom reverse engineering templates (T4)](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/templates), Microsoft Learn.
- [Design-time services](https://learn.microsoft.com/en-us/ef/core/cli/services), Microsoft Learn.
- [`DesignTimeServicesBuilder.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Design/Internal/DesignTimeServicesBuilder.cs), dotnet/efcore.
- [Data type precedence (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), Microsoft Learn.
- [EF Core Power Tools `SqlServerTypeMappingSource`](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/RevEng.Core.80/SqlServerTypeMappingSource.cs) and [efcpt config schema](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-schema.json), ErikEJ/EFCorePowerTools.
