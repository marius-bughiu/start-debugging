---
title: "Исправление: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause"
description: "EF Core формирует [col] json '$.path' AS JSON внутри OPENJSON WITH, и Azure SQL отклоняет это с ошибкой Msg 13618. Обновитесь до EF Core 10.0.11+ или понизьте уровень совместимости провайдера до 160."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "azure"
  - "json"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql"
translatedBy: "claude"
translationDate: 2026-09-09
---

Обновите `Microsoft.EntityFrameworkCore.SqlServer` до 10.0.11 или новее. До этой версии EF Core формировал `[col] json '$.path' AS JSON` внутри выражения `OPENJSON ... WITH` всякий раз, когда сопоставленный с JSON комплексный тип содержал вложенную коллекцию, а провайдер работал на уровне совместимости 170. SQL Server 2025 принимает нативный тип `json` в этой позиции, Azure SQL не принимает и отклоняет его с ошибкой Msg 13618. Если обновиться нельзя, передайте `o => o.UseCompatibilityLevel(160)`. Есть нюанс: исправление срабатывает, только когда EF знает, что работает с Azure SQL, то есть когда вы вызываете `UseAzureSql`, а не `UseSqlServer` со строкой подключения к Azure.

## Ошибка в контексте

Исключение выглядит как обычное `SqlException` при первом же запросе, который заходит во вложенную JSON-коллекцию:

```
Microsoft.Data.SqlClient.SqlException (0x80131904): AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.AsyncEnumerator.InitializeReaderAsync(AsyncEnumerator enumerator, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, ...)
   at Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync[TSource](IQueryable`1 source, CancellationToken cancellationToken)
```

Номер серверной ошибки 13618. SQL, который её вызвал, выглядит так:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

Проблемная строка это `[partNumbers] json '$.partNumbers' AS JSON`. Всё остальное в инструкции корректно.

Признак того, что вы попали именно на эту страницу, а не на похожую: сбой зависит от окружения. Один и тот же бинарник, одна и та же модель и один и тот же запрос работают против локального SQL Server 2025 и падают против Azure SQL, даже когда обе базы данных сообщают уровень совместимости 170.

## Почему это происходит

Здесь сталкиваются три независимых факта.

**`AS JSON` всегда требовал `nvarchar(max)`.** [Справочник по OPENJSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql) говорит прямо: "If you specify the `AS JSON` option, the type of the column must be **nvarchar(MAX)**." Это правило появилось на девять лет раньше нативного типа `json`.

**SQL Server 2025 смягчил правило, Azure SQL нет.** Нативный тип данных `json` общедоступен в Azure SQL Database и Azure SQL Managed Instance и находится в предварительной версии в SQL Server 2025. Но [ограничения типа данных json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations) отдельно оговаривают `OPENJSON`: "Currently, the `OPENJSON()` function doesn't accept the **json** data type in some platforms. Currently, it's an implicit conversion. Explicitly convert to **nvarchar(max)** first. In SQL Server 2025 (17.x), the `OPENJSON()` function does support **json**." Значит, тип `json` в выражении `WITH` это возможность локального SQL Server 2025, а не Azure SQL.

**`UseAzureSql` по умолчанию включает уровень совместимости 170, а именно 170 заставляет EF выбирать тип `json`.** В `SqlServerOptionsExtension` значение `SqlServerDefaultCompatibilityLevel` равно 160, а `AzureSqlDefaultCompatibilityLevel` равно 170. `SqlServerSingletonOptions.SupportsJsonType` возвращает true начиная со 170. На практике это означает, что вам не нужно ничего включать: одной замены `UseSqlServer` на `UseAzureSql` достаточно, чтобы перевести JSON-столбцы на нативный тип `json` и начать формировать `json ... AS JSON` в генерируемых запросах.

До EF Core 10.0.11 метод `SqlServerQuerySqlGenerator.GenerateColumnInfo` выводил `columnInfo.TypeMapping.StoreType` дословно для каждого столбца выражения `WITH`. Когда тип хранения был `json`, а столбец нёс `AS JSON`, получался SQL, который мог разобрать только SQL Server 2025.

Обратите внимание, что форма запроса имеет значение. JSON-столбец, который вы читаете целиком, сюда никогда не попадает, как и `Where` по скалярному значению внутри документа. `AS JSON` появляется, когда запрос заходит во вложенную внутри JSON-документа коллекцию, потому что EF приходится передавать этот вложенный массив во второй вызов `OPENJSON`. Если вы впервые видите, как EF превращает вложенные документы в деревья `OPENJSON`, механика разобрана в статье [сопоставление и запросы к JSON-столбцам в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Минимальное воспроизведение

Модели нужен сопоставленный с JSON комплексный тип, содержащий коллекцию комплексных типов, которая содержит коллекцию примитивов. Именно такая форма описана в [dotnet/efcore#38615](https://github.com/dotnet/efcore/issues/38615):

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
public class Car
{
    public int CarId { get; set; }
    public string Vin { get; set; } = null!;
    public string DealerId { get; set; } = null!;
    public CarConfiguration CarConfiguration { get; set; } = null!;
}

public class CarConfiguration
{
    public string? CurrentTrim { get; set; }
    public List<OptionPackage>? OptionPackages { get; set; }
}

public class OptionPackage
{
    public required string PackageId { get; set; }
    public required ICollection<string> PartNumbers { get; set; }
}
```

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Car>(builder =>
    {
        builder.ToTable("Cars");
        builder.HasKey(e => e.CarId);
        builder.Property(e => e.Vin).IsUnicode(false).HasMaxLength(32);
        builder.Property(e => e.DealerId).IsUnicode(false).HasMaxLength(32);

        builder.ComplexProperty(e => e.CarConfiguration, pp =>
        {
            pp.ToJson("CarConfiguration");
            pp.IsRequired();
            pp.Property(p => p.CurrentTrim).HasJsonPropertyName("currentTrim");

            pp.ComplexCollection(p => p.OptionPackages, op =>
            {
                op.HasJsonPropertyName("optionPackages");
                op.Property(o => o.PackageId).HasJsonPropertyName("packageId");
                op.PrimitiveCollection(o => o.PartNumbers)
                    .ElementType(e => e.IsUnicode(false).HasMaxLength(32))
                    .HasJsonPropertyName("partNumbers");
            });
        });
    });
}
```

В этой конфигурации намеренно нет `HasColumnType("json")`. Он и не нужен: на уровне совместимости 170 провайдер сам выбирает нативный тип.

Падает любая проекция, которая спускается на два уровня вниз:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
var options = new DbContextOptionsBuilder<CarContext>()
    .UseAzureSql(connectionString)   // defaults to compatibility level 170
    .Options;

await using var ctx = new CarContext(options);

var partNumbers = await ctx.Cars
    .Where(c => c.Vin == "1FA6P8TH8J5123456" && c.DealerId == "DEALER-001")
    .SelectMany(c => c.CarConfiguration.OptionPackages!)
    .Where(op => op.PackageId == "PKG-SPORT")
    .SelectMany(op => op.PartNumbers)
    .ToListAsync();                  // Msg 13618 on Azure SQL
```

Чтобы увидеть неправильный SQL, подписка Azure не нужна. `ToQueryString()` генерирует запрос, не открывая подключение, поэтому одноразового консольного приложения с фиктивной строкой подключения достаточно, чтобы понять, какую форму выдаёт ваша сборка. Запуск этой обвязки против 10.0.10 печатает показанную выше строку `[partNumbers] json '$.partNumbers' AS JSON`.

## Исправление подробно

### 1. Обновитесь до EF Core 10.0.11 или новее

Это и есть настоящее исправление, и оно не требует изменений в модели или запросе. [dotnet/efcore#38665](https://github.com/dotnet/efcore/pull/38665) попал в ветку `release/10.0` 2026-07-20 и вышел в 10.0.11 (2026-08-11). Текущий патч 10.0.12 тоже его содержит.

```xml
<!-- .NET 10 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.12" />
```

То же воспроизведение, тот же запрос, `Microsoft.EntityFrameworkCore.SqlServer` 10.0.12 и `UseAzureSql`:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] nvarchar(max) '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

Генератор теперь подменяет тип только в этой одной позиции:

```csharp
// dotnet/efcore, SqlServerQuerySqlGenerator.GenerateColumnInfo, release/10.0
if (columnInfo.AsJson
    && columnInfo.TypeMapping.StoreType == "json"
    && (_sqlServerSingletonOptions.EngineType != SqlServerEngineType.SqlServer
        || _sqlServerSingletonOptions.SqlServerCompatibilityLevel < 170))
{
    Sql.Append("nvarchar(max)");
}
else
{
    Sql.Append(columnInfo.TypeMapping.StoreType);
}
```

В вашей таблице ничего не меняется. Столбец на диске остаётся `json`, переписывается только объявление в выражении `WITH`, а `OPENJSON` по-прежнему принимает столбец `json` первым аргументом через неявное преобразование.

### 2. Если обновиться нельзя, понизьте уровень совместимости до 160

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.SqlServer 10.0.9 or 10.0.10
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

На 160 `SupportsJsonType` равен false, JSON-столбец сопоставляется с `nvarchar(max)`, а выражение `WITH` возвращается к `[partNumbers] nvarchar(max) '$.partNumbers' AS JSON`. Проверено на 10.0.10.

Цена не ограничивается одним этим выражением. Уровень совместимости 160 также отключает трансляцию `JSON_CONTAINS`, поддержку `.modify()` типа `json` для `ExecuteUpdate` и остальные трансляции, доступные только на 170, описанные в статье [трансляция JSON_CONTAINS в EF Core 11](/ru/2026/04/efcore-11-json-contains-sql-server-2025/). Что важнее, это меняет тип столбца в модели, и конвейер миграций это заметит. Чтение типа хранения прямо из реляционной модели на 10.0.12 делает это наглядным:

```
UseAzureSql (default compat 170)            Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(170)   Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(160)   Cars.CarConfiguration -> nvarchar(max)
```

Если ваша таблица уже использует `json`, а вы понижаете уровень совместимости, следующий `dotnet ef migrations add` сгенерирует `ALTER COLUMN` обратно на `nvarchar(max)`. SQL Server всё равно не позволит преобразовать столбец `json` в строковый тип через `ALTER TABLE`, поэтому такая миграция упадёт при развёртывании, а не перепишет данные молча. Считайте 160 временной заплаткой времени выполнения и держите её вне модели, из которой вы генерируете миграции, либо примите, что остаётесь на хранении `nvarchar(max)` навсегда.

### 3. Проверьте, что вы действительно вызываете `UseAzureSql`

Именно на этом спотыкаются те, кто обновился, а ошибка осталась. Посмотрите на условие в генераторе ещё раз: он подставляет `nvarchar(max)`, когда тип движка не `SqlServer` либо когда это `SqlServer` с уровнем совместимости ниже 170. Направьте `UseSqlServer` на строку подключения к Azure SQL, запросите уровень 170, и EF решит, что говорит с локальным SQL Server 2025, который поддерживает `json` в `OPENJSON`. На 10.0.12 эта комбинация по-прежнему выдаёт падающую строку:

```sql
-- UseSqlServer + UseCompatibilityLevel(170), EF Core 10.0.12
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
```

Это корректное поведение, а не вторая ошибка: EF не может узнать, куда указывает строка подключения, не спросив сервер. Решение в том, чтобы объявить используемый движок. `UseAzureSql` существует начиная с EF Core 9.0 и заодно бесплатно настраивает подходящую для Azure устойчивость подключения.

```csharp
// .NET 10, EF Core 9.0 and later
builder.Services.AddDbContext<CarContext>(options =>
    options.UseAzureSql(builder.Configuration.GetConnectionString("CarContext")));
```

Azure SQL Managed Instance использует тот же вызов. У Azure Synapse есть `UseAzureSynapse`, который безусловно сообщает `SupportsJsonType` как false, поэтому до этой ветки кода он никогда не доходит.

### 4. Что не работает: переопределение типа столбца-контейнера

Напрашивающийся обходной путь это принудительно вернуть JSON-столбец к строковому типу:

```csharp
// Does NOT fix the WITH clause
pp.ToJson("CarConfiguration");
pp.HasColumnType("nvarchar(max)");
```

На 10.0.10 с `UseSqlServer` и уровнем 170 это по-прежнему выдаёт `[partNumbers] json '$.partNumbers' AS JSON`. Причина в том, что `HasColumnType` задаёт тип хранения столбца-контейнера, тогда как запись выражения `WITH` для вложенной коллекции берёт свой тип из сопоставления JSON-типов провайдера, которое выбирается по уровню совместимости. Изменение внешнего столбца не доходит до внутреннего объявления. Используйте вместо этого обновление версии или уровень совместимости.

## Подводные камни и похожие ошибки

**"The store type 'nvarchar(2000)' specified for JSON column ... is not supported by the current provider."** Другая ошибка, другая причина. Это `InvalidOperationException`, которое выбрасывает валидация модели ещё до генерации какого-либо SQL, и оно срабатывает в любой конфигурации, с Azure или без:

```
InvalidOperationException: The store type 'nvarchar(2000)' specified for JSON column 'CarConfiguration' in table 'Cars' is not supported by the current provider. JSON columns require a provider-specific JSON store type.
```

Оно означает, что вы закрепили JSON-столбец за `nvarchar(x)` без MAX, что работало в EF Core 9 и стало ошибкой валидации в EF Core 10 ([dotnet/efcore#37424](https://github.com/dotnet/efcore/issues/37424)). Используйте `nvarchar(max)` или `json`, либо уберите вызов `HasColumnType` и дайте провайдеру выбрать самому.

**Написанный вручную SQL и `FromSql`.** Msg 13618 это правило T-SQL, а не EF. Если падающая инструкция это ваш собственный `OPENJSON ... WITH (Payload nvarchar(100) '$.payload' AS JSON)`, ни одна версия EF её не исправит: расширьте объявление столбца до `nvarchar(max)`. Страница [решения распространённых проблем с JSON](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server) в документации SQL разбирает то же правило со стороны T-SQL. Поскольку сырой SQL обходит конвейер запросов, `ToQueryString()` здесь не поможет: выполняется ровно тот SQL, который вы написали.

**Локальный SQL Server 2025 не затронут.** Если ваша база данных это SQL Server 2025 (17.x), а EF настроен через `UseSqlServer` с уровнем 170, `json ... AS JSON` корректен, и SQL до 10.0.11 выполняется нормально. Именно эта асимметрия объясняет, почему баг дожил до момента, когда клиент запустил ту же сборку против Azure.

**Уровень совместимости EF это не уровень базы данных.** `UseCompatibilityLevel(170)` лишь сообщает EF, какой SQL ему разрешено генерировать. Он не выполняет `ALTER DATABASE ... SET COMPATIBILITY_LEVEL`. Настройка EF на 170 против базы, которая всё ещё на 150, порождает совсем другое семейство синтаксических ошибок.

**`SELECT`, который читает только документ целиком, безопасен.** Если ошибка появилась после, казалось бы, не связанного рефакторинга, ищите новый `SelectMany`, `Any` или `Contains` по вложенной коллекции. Именно они втягивают второй `OPENJSON` и столбец `AS JSON`. Включение журналирования SQL, как описано в статье [как журналировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), за один запрос покажет, какой запрос изменил форму.

## Есть ли исправление в EF Core 11

Тот же код генератора присутствует в ветке `release/11.0`, поэтому `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128, опубликованный 2026-09-08, содержит исправление. Этот пакет нацелен только на `net11.0`, так что для проверки нужен SDK .NET 11. Все примеры SQL выше получены на SDK .NET 10.0.302 против EF Core 10.0.10, 10.0.11 и 10.0.12 с помощью `ToQueryString()`.

Если вы всё равно переводите насыщенную JSON модель на EF Core 11, это стоит сделать в том же проходе, что и решения о сопоставлении из статьи [комплексные типы против owned-сущностей](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) и изменения уровня провайдера из статьи [миграция с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/). Общий вывод выходит за рамки одной этой ошибки: "Azure SQL" и "SQL Server 2025" это не одна и та же цель, они расходятся именно на JSON, и EF знает, на какой из них вы работаете, только потому что вы ему это сказали.

## Похожие материалы

- [Как сопоставлять и запрашивать JSON-столбцы в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [EF Core 11 транслирует Contains в JSON_CONTAINS на SQL Server 2025](/ru/2026/04/efcore-11-json-contains-sql-server-2025/)
- [Комплексные типы против owned-сущностей в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Как журналировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Миграция с EF Core 6 на EF Core 11: критические изменения, которые действительно бьют](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Источники

- [dotnet/efcore#38615, исключение при запросе json, возникающее только на Azure SQL с уровнем совместимости 170](https://github.com/dotnet/efcore/issues/38615)
- [dotnet/efcore#38665, исправление сбоя OPENJSON AS JSON на Azure SQL, когда тип столбца json на уровне совместимости 170](https://github.com/dotnet/efcore/pull/38665)
- [dotnet/efcore#37424, EF10 SQL Server: JSON-типы, сопоставленные с nvarchar(x), больше не работают](https://github.com/dotnet/efcore/issues/37424)
- [OPENJSON (Transact-SQL), включая правило о типе столбца для AS JSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)
- [Ограничения типа данных json, про OPENJSON и тип json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)
- [Провайдер базы данных Microsoft SQL Server для EF Core, про UseAzureSql и уровни совместимости](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [Решение распространённых проблем с JSON в SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)
