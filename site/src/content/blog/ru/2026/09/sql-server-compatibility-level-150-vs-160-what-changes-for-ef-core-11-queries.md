---
title: "Уровень совместимости SQL Server 150 или 160: что меняется в запросах EF Core 11"
description: "EF Core 11 теперь по умолчанию задаёт для UseSqlServer уровень совместимости 160, из-за чего в ваш SQL попадают LEAST, GREATEST и двухаргументные LTRIM/RTRIM, в том числе в каждом Take(n).FirstOrDefault(). Оставляйте 160 на SQL Server 2022 и новее; закрепите UseCompatibilityLevel(150), если хоть одно окружение ещё работает на SQL Server 2019."
pubDate: 2026-09-16
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-09-16
---

Короткий ответ: если каждая база данных, с которой работает ваше приложение, развёрнута на SQL Server 2022 или новее, оставьте новое значение EF Core 11 по умолчанию, уровень совместимости 160. Он превращает `Math.Min`/`Math.Max`, `EF.Functions.Least`/`Greatest`, `Min`/`Max` по встроенным массивам и цепочки вызовов `Take` в `LEAST`/`GREATEST`, а `TrimStart(char)`/`TrimEnd(char)` в двухаргументные `LTRIM`/`RTRIM`. Если хоть одно окружение ещё работает на SQL Server 2019, вызовите `UseCompatibilityLevel(150)` до обновления. На уровне 160 даже такой обычный запрос, как `.Take(pageSize).FirstOrDefaultAsync()`, превращается в `SELECT TOP(LEAST(@p, 1))`, а в SQL Server 2019 нет `LEAST`.

Всё описанное ниже проверено на `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 с .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) и C# 14, а для картины "до" на версии 10.0.12 с SDK 10.0.302. Я сравнивал SQL, который генерируют обе версии. На живом SQL Server я его не запускал, поэтому поведение на стороне сервера взято из документации SQL Server, ссылки на которую приведены ниже.

## 150 и 160 в двух словах

| Форма LINQ (EF Core 11) | Уровень 150 (по умолчанию в EF Core 10) | Уровень 160 (по умолчанию в EF Core 11) |
| --- | --- | --- |
| `Math.Max(a, b)` в `Where` / `OrderBy` | Выбрасывает "could not be translated" | `GREATEST([a], [b])` |
| `Math.Min(a, b)` в финальном `Select` | Вычисляется на клиенте | `LEAST([a], [b])` на сервере |
| `EF.Functions.Greatest(a, b, c)` в `Where` | Выбрасывает "could not be translated" | `GREATEST([a], [b], [c])` |
| `new[] { a, b }.Max()` | `(SELECT MAX(...) FROM (VALUES ...))` | `GREATEST([a], [b])` |
| `Take(n).FirstOrDefault()` | Вложенный `TOP(1)` поверх подзапроса с `TOP(@p)` | `TOP(LEAST(@p, 1))` |
| `Skip(s).Take(n).First()` | `TOP(1)` поверх подзапроса с `OFFSET`/`FETCH` | `FETCH NEXT LEAST(@p1, 1) ROWS ONLY` |
| `TrimStart('0')` в `Where` | Выбрасывает "could not be translated" | `LTRIM([col], N'0')` |
| `ExecuteUpdate`, присваивающий JSON-свойству столбец `DateTime` | Выбрасывает исключение | `JSON_MODIFY(..., JSON_VALUE(JSON_OBJECT('v': [col]), '$.v'))` |
| DDL / миграции | Одинаково | Одинаково |
| JSON-столбцы | `nvarchar(max)` | `nvarchar(max)` (на `json` переключает только 170) |
| Минимальный сервер | SQL Server 2019 | SQL Server 2022 (и уровень базы данных 160 для `LTRIM`/`RTRIM` с символами) |

## Уровень совместимости EF не равен уровню совместимости вашей базы данных

Настроек две, и обе называются "уровень совместимости".

**Настройка EF** это то, что вы передаёте в `UseCompatibilityLevel`. EF никогда не читает её с сервера. Она фиксируется при построении параметров и определяет лишь то, какие возможности SQL может использовать конвейер запросов. В `SqlServerOptionsExtension` в EF Core 11 значения по умолчанию такие: `SqlServerDefaultCompatibilityLevel = 160` и `AzureSqlDefaultCompatibilityLevel = 170`. В EF Core 10 первое было равно 150. Это изменение описано в [dotnet/efcore#38198](https://github.com/dotnet/efcore/issues/38198), вошло в PR #38199 и значится как критическое изменение с низким влиянием для EF Core 11.

**Настройка базы данных** это `sys.databases.compatibility_level`. Она управляет поведением оптимизатора запросов и несколькими правилами синтаксиса. На уровне базы данных 160 SQL Server 2022 включает оптимизацию планов, чувствительных к параметрам (parameter sensitive plan optimization), и обратную связь по оценке кардинальности. База данных, которую вы восстанавливаете или подключаете на более новом сервере, сохраняет свой старый уровень. Поэтому база, перенесённая с SQL Server 2019 на 2022, вполне может оставаться на уровне 150.

Эти две настройки взаимодействуют только через SQL, который отправляет EF. Страница Microsoft об уровнях совместимости говорит, что новый синтаксис T-SQL не ограничивается уровнем совместимости базы данных, за исключением случаев, когда он может сломать существующие приложения. `GREATEST` и `LEAST` в списке исключений нет, поэтому они работают на SQL Server 2022 при любом уровне базы данных. Необязательный аргумент *characters* у `LTRIM` и `RTRIM` как раз исключение: его документация требует уровень совместимости базы данных 160.

Также обратите внимание, что `UseAzureSql` и `UseSqlServer` это разные пути. `UseAzureSql` уже в EF Core 10 по умолчанию использовал 170, так что для пользователей Azure SQL ничего из описанного в этой статье не меняется. Если же вы направляете `UseSqlServer` на Azure SQL, вы, как и все остальные, только что перешли со 150 на 160.

## Как я измерял разницу

Проверочная программа трижды строит одну и ту же модель (по умолчанию, `UseCompatibilityLevel(150)`, `UseCompatibilityLevel(160)`). Для запросов она печатает `ToQueryString()`. Для `FirstOrDefaultAsync` и `ExecuteUpdateAsync` перехватчик подавляет открытие соединения и захватывает текст команды, так что база данных не участвует:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
var configs = new (string Name, Action<DbContextOptionsBuilder> Configure)[]
{
    ("UseSqlServer (default)", o => o.UseSqlServer(Cs)),
    ("UseSqlServer + 150", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(150))),
    ("UseSqlServer + 160", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(160))),
};

foreach (var (name, configure) in configs)
{
    using var db = Shop.Create(configure); // adds the interceptor, EnableServiceProviderCaching(false)
    Q("Math.Max in Where", () => db.Products
        .Where(p => Math.Max(p.Stock, p.ReorderLevel) > 10).ToQueryString());
    Q("TrimStart('0') in Where", () => db.Products
        .Where(p => p.Sku.TrimStart('0') == "42").ToQueryString());
    // ...one line per shape in the table above
}

class NoDb : DbCommandInterceptor, IDbConnectionInterceptor
{
    public ValueTask<InterceptionResult> ConnectionOpeningAsync(DbConnection c, ConnectionEventData d,
        InterceptionResult r, CancellationToken t = default) => ValueTask.FromResult(InterceptionResult.Suppress());

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand cmd,
        CommandEventData d, InterceptionResult<DbDataReader> r, CancellationToken t = default)
    {
        Capture.Last = cmd.CommandText;
        throw new CapturedException(); // stop before anything needs a real reader
    }
    // ConnectionOpening (sync) and NonQueryExecutingAsync follow the same pattern
}
```

Запуск того же файла на EF Core 10.0.12 дал полезный контрольный результат. EF Core 10 с `UseCompatibilityLevel(160)` выдал SQL, идентичный SQL EF Core 11 по умолчанию. Ни одна из этих трансляций не появилась впервые в EF Core 11. `Math.Min`/`Math.Max` через `LEAST`/`GREATEST` и перегрузки `TrimStart`/`TrimEnd` для `char` вышли ещё в EF Core 9 и были доступны только на уровне 160. EF Core 11 лишь сменил значение по умолчанию, так что они включаются без вашего запроса.

## Изменение, которое кусается: Take, за которым следует First или Single

Этого я не ожидал, и затрагивает оно код, никак не связанный с `Math`. Когда в запросе уже есть ограничение числа строк и вы добавляете ещё одно, EF их объединяет. Если оба ограничения константы, он оставляет меньшее. В противном случае он вызывает `GenerateLeast`, который возвращает выражение `LEAST` только на уровне 160 или выше. Ниже 160 он возвращает null, и EF откатывается к вложенному запросу.

`FirstOrDefaultAsync` добавляет ограничение 1, а `SingleOrDefaultAsync` ограничение 2. EF параметризует значение, переданное в `Take`, даже литерал вроде `Take(20)`. Поэтому репозиторий, возвращающий постраничный `IQueryable`, и вызывающий код, запрашивающий первую строку, выглядят так:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var first = await db.Products
    .OrderBy(p => p.Id)
    .Take(pageSize)
    .FirstOrDefaultAsync();
```

На уровне 160 (по умолчанию в EF Core 11):

```sql
SELECT TOP(LEAST(@p, 1)) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
FROM [Products] AS [p]
ORDER BY [p].[Id]
```

На уровне 150 (по умолчанию в EF Core 10):

```sql
SELECT TOP(1) [p0].[Id], [p0].[CreatedAt], [p0].[ListPrice], [p0].[Name], ...
FROM (
    SELECT TOP(@p) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
    FROM [Products] AS [p]
    ORDER BY [p].[Id]
) AS [p0]
ORDER BY [p0].[Id]
```

Со `Skip` ограничение переезжает в `OFFSET @p ROWS FETCH NEXT LEAST(@p1, 1) ROWS ONLY`. `Take(n).Take(m)` с двумя параметрами даёт `TOP(LEAST(@p, @p1))`. `Take(n).AnyAsync()` и `Take(n).CountAsync()` не затронуты, потому что они оборачивают ограниченный запрос, а не накладывают второе ограничение. `Take(n).Take(n)` с одним и тем же параметром тоже не затронут: EF видит два равных ограничения и оставляет одно.

На SQL Server 2022 форма для уровня 160 просто даёт более короткий SQL. На SQL Server 2019 сервер отвергает `LEAST` как неизвестную встроенную функцию. Этот код компилировался, проходил тесты на более новом сервере и работал на EF Core 10. Именно поэтому набор тестов, запускаемый на контейнере SQL Server 2022, вас не предупредит.

## Math.Min, Math.Max и встроенные массивы

На уровне 150 `Math.Max` и `EF.Functions.Greatest` вообще не транслируются. В `Where` или `OrderBy` вы получаете привычное `InvalidOperationException` с предложением переписать запрос или перейти на вычисление на клиенте. В финальной проекции EF молча выбирает оба столбца и выполняет `Math.Min` на клиенте:

```sql
-- level 150: Select(p => new { p.Id, Effective = Math.Min(p.Price, p.ListPrice) })
SELECT [p].[Id], [p].[Price], [p].[ListPrice]
FROM [Products] AS [p]

-- level 160
SELECT [p].[Id], LEAST([p].[Price], [p].[ListPrice]) AS [Effective]
FROM [Products] AS [p]
```

Эта проекция и есть второе незаметное изменение после обновления: тот же LINQ теперь зависит от наличия `LEAST` на сервере.

У встроенных массивов на уровне 150 был работающий запасной вариант, коррелированный подзапрос с `VALUES`:

```sql
-- level 150: Where(p => new[] { p.Stock, p.ReorderLevel }.Max() > 10)
WHERE (
    SELECT MAX([v].[Value])
    FROM (VALUES ([p].[Stock]), ([p].[ReorderLevel])) AS [v]([Value])) > 10

-- level 160
WHERE GREATEST([p].[Stock], [p].[ReorderLevel]) > 10
```

Семантика null совпадает. `GREATEST` и `LEAST` игнорируют аргументы `NULL`, если только все они не `NULL`, точно так же, как `MAX` по строкам `VALUES` и как `Enumerable.Min` по `decimal?[]`. EF это тоже проверяет: для типа результата, допускающего null, он выбирает `LEAST`/`GREATEST` только тогда, когда функция не распространяет null. Поэтому `new decimal?[] { p.SalePrice, p.Price }.Min()` превращается в `LEAST([p].[SalePrice], [p].[Price])` без изменения результатов.

## TrimStart и TrimEnd с символами

Обрезка без аргументов на любом уровне это `LTRIM(col)`. Обрезке конкретных символов нужна двухаргументная форма из SQL Server 2022, и EF использует её только на уровне 160:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var bySku = db.Products.Where(p => p.Sku.TrimStart('0') == "42");
var byName = db.Products.Where(p => p.Name.TrimEnd(' ', '.') == "Widget");
```

```sql
-- level 160
WHERE LTRIM([p].[Sku], N'0') = N'42'
WHERE RTRIM([p].[Name], N' .') = N'Widget'
```

На уровне 150 оба варианта выбрасывают "could not be translated". В финальном `Select` они выполняются на клиенте, а на уровне 160 переезжают на сервер. Это тот случай, который зависит ещё и от собственного уровня базы данных. На SQL Server 2022 документация `LTRIM` требует уровень совместимости базы данных 160 для аргумента characters. База данных, восстановленная из 2019 и так и не поднятая, отвергнет его, хотя `GREATEST` на том же сервере работает без проблем.

## ExecuteUpdate в JSON-столбцы

Для сложных типов, сопоставленных с JSON, присвоение свойству столбца типа `int` или `string` работает на обоих уровнях. Присвоение столбца другого типа, например `DateTime`, требует `JSON_OBJECT`, который тоже появился в SQL Server 2022:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
await db.Products.ExecuteUpdateAsync(s =>
    s.SetProperty(p => p.Details.LastPriceChange, p => p.CreatedAt));
```

На уровне 160 это превращается в `JSON_MODIFY([p].[Details], '$.LastPriceChange', JSON_VALUE(JSON_OBJECT('v': [p].[CreatedAt]), '$.v'))`. На уровне 150 EF выбрасывает исключение. EF Core 10.0.12 выдаёт сообщение, которое подсказывает, что делать: "'ExecuteUpdate' cannot set a property in a JSON column to an expression containing a column on SQL Server versions before 2022". EF Core 11 RC 1 оборачивает его в общее сообщение "could not be translated, see inner exception".

## Что не меняется между 150 и 160

Схема. `GenerateCreateScript()` вернул идентичный DDL на уровнях 150 и 160 для модели со сложным типом JSON. `SupportsJsonType` переключается только на 170, поэтому JSON-столбцы остаются `nvarchar(max)`, и переход между 150 и 160 не создаёт миграцию. Запросы к JSON на основе `OPENJSON`, которым нужен уровень 130, не затронуты. Всё, что требует 170 (нативный тип `json`, `JSON_CONTAINS`, `.modify()`), остаётся выключенным на обоих уровнях.

## Когда оставить 160

- **Каждое окружение работает на SQL Server 2022 или 2025 либо на Azure SQL / Managed Instance.** Вы получаете более короткий SQL для постраничных запросов, `Math.Min`/`Math.Max` на сервере и обрезку символов, которая транслируется, а не выбрасывает исключение.
- **Вы раньше задавали `UseCompatibilityLevel(160)` вручную.** Этот вызов можно удалить. Результат тот же, как показал контрольный запуск на EF Core 10.
- **Вы полагались на вычисление `Math.Min` или `TrimStart('0')` на клиенте в проекциях.** Перенос этой работы на сервер обычно и есть то, чего вы хотели.

## Когда закрепить 150

- **Хоть одно окружение работает на SQL Server 2019.** Сюда входят staging, локальная установка у клиента или реплика для аварийного восстановления. Документация провайдера EF Core 11 по-прежнему указывает SQL Server 2019 как поддерживаемый, но только на уровне 150.
- **Ваши базы данных работают на SQL Server 2022 с уровнем базы данных 150, и вы это не контролируете.** Например, базой владеет вендор, который не станет поднимать уровень, потому что 160 меняет планы запросов. `GREATEST`/`LEAST` там всё равно будут работать, а `LTRIM`/`RTRIM` с символами нет. Закрепление 150 является единственной настройкой на стороне EF, которая покрывает оба случая.
- **Вы поставляете один бинарник множеству арендаторов с неизвестными версиями SQL Server.** Выберите уровень, который способен выполнить ваш самый старый поддерживаемый сервер.

## Задайте уровень явно и проверяйте его при запуске

Собственная документация провайдера от Microsoft рекомендует настраивать уровень явно, и смена значения по умолчанию даёт хороший повод последовать этому совету. Читайте его из конфигурации, чтобы каждое окружение могло объявить, на чём оно работает:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
var level = builder.Configuration.GetValue("Database:CompatibilityLevel", 150);

builder.Services.AddDbContext<Shop>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop"),
        sql => sql.UseCompatibilityLevel(level)));
```

Затем падайте сразу, если настроенный уровень требует больше, чем может дать сервер:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<Shop>();

    // EngineEdition 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
    var engineEdition = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [Value]")
        .SingleAsync();
    var serverMajor = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [Value]")
        .SingleAsync();
    var databaseLevel = await db.Database
        .SqlQuery<int>($"SELECT CAST(compatibility_level AS int) AS [Value] FROM sys.databases WHERE name = DB_NAME()")
        .SingleAsync();

    // SQL Server 2019 = 15, 2022 = 16, 2025 = 17; the matching levels are 150, 160, 170
    var isAzure = engineEdition is 5 or 8;
    if ((!isAzure && level > serverMajor * 10) || level > databaseLevel)
        throw new InvalidOperationException(
            $"EF is configured for compatibility level {level}, but the server is version {serverMajor} " +
            $"and the database is at level {databaseLevel}.");
}
```

Azure SQL не сообщает версию коробочного SQL Server, которую можно так сравнить, поэтому там проверка опирается только на уровень базы данных. Сравнение с уровнем базы данных строже, чем нужно для `LEAST`/`GREATEST`. Я предпочитаю именно его, потому что `LTRIM` с символами действительно зависит от уровня базы данных, а проверка, покрывающая лишь половину случаев, хуже, чем никакой. Запускайте ту же проверку в интеграционных тестах на контейнере *самой старой* поддерживаемой вами версии сервера, а не самой новой.

## Рекомендация ещё раз

Уровень 160 является правильным значением по умолчанию в 2026 году. SQL Server 2022 вышел почти четыре года назад, и SQL получается лучше. Но значение по умолчанию это догадка о вашем сервере, и для компании на SQL Server 2019 она ошибочна так, что на это не укажет ни компилятор, ни анализатор, ни миграция. Первым признаком станет ошибка SQL во время выполнения в запросах, которые работали в EF Core 10. Поэтому задавайте `UseCompatibilityLevel` явно в каждом приложении, которое переводите на EF Core 11: 160 или выше, если все серверы 2022+, и 150, если хотя бы один из них старше.

## Связанные материалы

- Шаг к 170 гораздо крупнее, потому что он меняет типы столбцов: [нативный столбец json или nvarchar(max) в EF Core 11](/ru/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/).
- Если вы переходите со старого релиза, в статье [о критических изменениях EF Core 6-11, которые действительно кусаются](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) разобраны и другие трансляции, зависящие от версии.
- Сбои уровня 150 из этой статьи это классическая [ошибка "LINQ expression could not be translated"](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), и способы переписать запрос оттуда здесь тоже применимы.
- Чтобы увидеть, какой SQL ваше приложение на самом деле отправляет после обновления, [журналируйте SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Чтобы ловить несовпадение версии сервера в CI, [запускайте интеграционные тесты на реальном SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), закрепив самую старую версию из продакшена.

## Источники

- [Критические изменения EF Core 11: уровень совместимости SQL Server теперь по умолчанию равен 160](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes#sqlserver-compatibility-level-160)
- [dotnet/efcore#38198: Bump default SQL Server compatibility level from 150 to 160](https://github.com/dotnet/efcore/issues/38198)
- [dotnet/efcore#38196: Math.Min/Max not translating on the old default level](https://github.com/dotnet/efcore/issues/38196)
- [Провайдер SQL Server для EF Core: уровень совместимости](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/#compatibility-level)
- [ALTER DATABASE compatibility level: поддерживаемые уровни и различия между 150 и 160](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql)
- [LTRIM (Transact-SQL): аргументу characters требуется уровень совместимости 160](https://learn.microsoft.com/en-us/sql/t-sql/functions/ltrim-transact-sql)
- Исходный код EF Core на теге `v11.0.0-rc.1.26425.128`: `SqlServerSqlTranslatingExpressionVisitor.GenerateGreatest`/`GenerateLeast`, `RelationalQueryableMethodTranslatingExpressionVisitor.ApplyLimit`, `SqlServerStringMethodTranslator.TranslateTrimStartEnd`, `SqlServerSingletonOptions`
