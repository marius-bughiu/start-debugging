---
title: "Исправление: Invalid column name 'Value' при использовании SqlQueryRaw<T> для скалярного результата в EF Core"
description: "EF Core оборачивает скалярный SqlQuery<T> в подзапрос и выбирает столбец с именем Value, как только вы добавляете First, Where, Max или Single. Задайте в SQL псевдоним AS Value или сначала материализуйте результат."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "efcore"
  - "ef-core-11"
  - "dotnet"
lang: "ru"
translationOf: "2026/10/fix-invalid-column-name-value-when-using-sqlqueryraw-for-a-scalar-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-06
---

`Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First()` завершается ошибкой `Invalid column name 'Value'`, потому что любой оператор LINQ, добавленный к скалярному `SqlQuery<T>` или `SqlQueryRaw<T>`, заставляет EF Core обернуть ваш SQL в подзапрос и выбрать из него столбец с буквальным именем `Value`. Исправление: задайте псевдоним единственному выходному столбцу: `SELECT COUNT(*) AS Value FROM Blogs`, а в PostgreSQL в кавычках: `AS "Value"`. Если менять SQL нельзя, сначала материализуйте результат (`ToListAsync()`, затем выберите строку в памяти). Всё ниже измерено на EF Core 10.0.12 и EF Core 11.0.0-rc.1, которые ведут себя здесь одинаково, а само правило существует с момента появления `SqlQuery<T>` в EF Core 7.0.

## Ошибка в контексте

В SQL Server исключение имеет тип `SqlException`, номер 207:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Invalid column name 'Value'.
```

Один и тот же баг выглядит по-разному у каждого провайдера, поэтому его трудно найти поиском. Сообщения SQLite и PostgreSQL скопированы из лабораторных запусков ниже; строки SQL Server это ошибки движка для SQL, который отправляет EF (экземпляра SQL Server для этого поста не было):

```text
SQLite:      SQLite Error 1: 'no such column: s.Value'.
PostgreSQL:  42703: column s.Value does not exist
SQL Server:  Invalid column name 'Value'.                       (error 207)
SQL Server:  No column name was specified for column 1 of 's'.  (error 8155, unaliased COUNT(*), MAX(...) etc.)
```

Вариант в SQL Server зависит от вашего SQL. Если запрос возвращает именованный столбец, например `SELECT Id FROM Blogs`, SQL Server сообщает, что `Value` не существует. Если возвращается выражение вообще без имени, например `COUNT(*)`, SQL Server падает раньше, потому что производная таблица не может содержать безымянный столбец. Исправление в обоих случаях одно и то же.

## Почему EF Core запрашивает столбец с именем Value

`SqlQuery<T>` для скалярного `T` транслируется в `RelationalQueryableMethodTranslatingExpressionVisitor`. В исходном коде EF Core 11 RC 1 транслятор создаёт `FromSqlExpression` для вашего SQL с псевдонимом таблицы `s` (сгенерированным из `"sql"`) и столбец проекции, имя которого берётся из жёстко заданной константы:

```csharp
// EF Core 11.0.0-rc.1, src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs
private const string SqlQuerySingleColumnAlias = "Value";
```

API для изменения этого имени нет. Пока поверх запроса ничего не компонуется, EF отправляет ваш SQL без изменений и читает первый столбец по позиции, поэтому имя столбца не важно, и `ToList()` работает. Как только вы добавляете оператор, который должен сослаться на столбец в SQL, EF генерирует внешний `SELECT [s].[Value] FROM (<your SQL>) AS [s]`, и база данных ищет столбец, которого там нет.

[Документация по сырому SQL в EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types) формулирует правило одним предложением: при компоновке LINQ поверх скалярного SQL-запроса "you must name the output column `Value`". Ловушка в том, что методы вроде `First()` и `Single()` не выглядят как компоновка, но ею являются.

## Минимальный пример воспроизведения

Следующее консольное приложение воспроизводит ошибку на SQLite в памяти, поэтому сервер не нужен. Приведённые ниже инструкции SQL Server были получены от провайдера SQL Server с помощью перехватчика, который подавляет подключение и записывает `DbCommand.CommandText`, так что это точные инструкции, которые отправляет EF; экземпляр SQL Server не использовался.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (identical on .NET 10 + EF Core 10.0.12)
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).Options);
db.Database.EnsureCreated();
db.Blogs.AddRange(new Blog { Name = "a", Views = 5 }, new Blog { Name = "b", Views = 50 });
db.SaveChanges();

// Works: no composition, EF reads column 0 by position.
var all = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").ToList();

// Throws: SQLite Error 1: 'no such column: s.Value'.
var count = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First();

class Blog { public int Id { get; set; } public string Name { get; set; } = ""; public int Views { get; set; } }
class Db(DbContextOptions<Db> o) : DbContext(o) { public DbSet<Blog> Blogs => Set<Blog>(); }
```

Для вызова `First()` провайдер SQL Server отправляет:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, captured CommandText
SELECT TOP(1) [s].[Value]
FROM (
    SELECT COUNT(*) FROM Blogs
) AS [s]
```

## Какие операторы вызывают ошибку

Я запускал каждый оператор с неименованным `SELECT Id FROM Blogs` на обеих версиях EF. Таблица показывает результат на SQLite; столбец с SQL показывает, что провайдер SQL Server сгенерировал для того же запроса.

| Вызов `SqlQueryRaw<int>(...)` | Сгенерированный внешний SQL (SQL Server) | Результат без псевдонима |
|---|---|---|
| `ToList()` / `ToListAsync()` | нет, ваш SQL отправляется как есть | работает |
| `AsEnumerable().First()` | нет, `First` выполняется в памяти | работает |
| `First()` / `FirstOrDefault()` | `SELECT TOP(1) [s].[Value] FROM (...) AS [s]` | ошибка |
| `Single()` / `SingleOrDefault()` | `SELECT TOP(2) [s].[Value] FROM (...) AS [s]` | ошибка |
| `Where(x => x > 1)` | `SELECT [s].[Value] ... WHERE [s].[Value] > 1` | ошибка |
| `Max()` / `Min()` | `SELECT MAX([s].[Value]) FROM (...) AS [s]` | ошибка |
| `Count()` | `SELECT COUNT(*) FROM (...) AS [s]` | работает |
| `Any()` | `SELECT CASE WHEN EXISTS (SELECT 1 FROM (...) AS [s]) ...` | работает |

`Count()` и `Any()` тоже оборачивают ваш SQL, но никогда не обращаются к столбцу, поэтому им это сходит с рук. Так код проходит ревью: путь с `Count()` протестирован, потом кто-то меняет его на `FirstOrDefault()`, и в продакшене начинаются исключения.

## Исправление 1: задайте выходному столбцу псевдоним AS Value

Это исправление рекомендует документация, и оно оставляет компоновку на стороне сервера:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = await db.Database
    .SqlQueryRaw<int>("SELECT COUNT(*) AS Value FROM Blogs")
    .FirstAsync();

var bigIds = await db.Database
    .SqlQuery<int>($"SELECT Id AS Value FROM Blogs")
    .Where(id => id > 1)
    .OrderBy(id => id)
    .ToListAsync();
```

Теперь оба запроса выполняются, а второй фильтруется и сортируется в базе данных:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider
SELECT [s].[Value]
FROM (
    SELECT Id AS Value FROM Blogs
) AS [s]
WHERE [s].[Value] > 1
ORDER BY [s].[Value]
```

Здесь обнаружилась небольшая разница между версиями: EF Core 10.0.12 генерирует `ORDER BY CAST([s].[Value] AS int)` для того же запроса, а EF Core 11 RC 1 убирает лишнее приведение. На результат это не влияет, но меняет текст плана, если вы сравниваете запросы при обновлении.

Псевдоним одинаково работает для любого скалярного типа, который EF умеет отображать, включая `string`, `DateTime`, `Guid` и nullable-типы вроде `int?`. Для агрегата, который может вернуть `NULL`, используйте тип, допускающий null. На пустой таблице `SqlQueryRaw<int>("SELECT MAX(Views) AS Value FROM Blogs")` выбрасывает `Nullable object must have a value.` независимо от компоновки, а версия с `int?` возвращает `null`:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
int? maxViews = await db.Database
    .SqlQueryRaw<int?>("SELECT MAX(Views) AS Value FROM Blogs")
    .FirstOrDefaultAsync();
```

## Исправление 2: заключайте псевдоним в кавычки в PostgreSQL

PostgreSQL приводит неквотированные идентификаторы к нижнему регистру, а Npgsql заключает в кавычки генерируемый им столбец. Поэтому `AS Value` создаёт столбец `value`, EF запрашивает `s."Value"`, и вы получаете ту же ошибку, хотя следовали документации. Это измерено на Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 и 11.0.0-rc.1.1 с PostgreSQL 18:

```csharp
// .NET 11 RC 1, Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.1.1
// Throws: 42703: column s.Value does not exist
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS Value FROM \"Blogs\"").FirstAsync();

// Works
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM \"Blogs\"").FirstAsync();
```

В сырой строковой константе C# 11+ кавычки остаются читаемыми:

```csharp
// .NET 11 RC 1, C# 14
var count = await db.Database.SqlQuery<int>($"""
    SELECT count(*)::int AS "Value" FROM "Blogs"
    """).FirstAsync();
```

SQLite сопоставляет имена столбцов без учёта регистра, поэтому там работает `AS value`, а SQL Server следует сортировке (collation) базы данных, которая по умолчанию нечувствительна к регистру. Пишите `"Value"` с заглавной V везде, и запрос останется переносимым.

## Исправление 3: сначала материализуйте результат, если нельзя менять SQL

Если SQL приходит из хранимой процедуры, представления, которым вы не владеете, или общей константы, заберите строки на клиент и завершите обработку там:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = (await db.Database
        .SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs")
        .ToListAsync())
    .Single();

// or, synchronously
var count2 = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").AsEnumerable().Single();
```

Ни один из вариантов не генерирует подзапрос, поэтому имя столбца не имеет значения. Делайте так только для запросов, возвращающих несколько строк. `AsEnumerable().Where(...)` передаёт весь результат на клиент до фильтрации, а именно этого и должна была избежать компоновка на сервере.

Это также единственный вариант для хранимой процедуры, потому что `EXEC` вообще нельзя использовать как подзапрос. Компоновка поверх неё выбрасывает другую ошибку ещё до обращения к серверу; этот случай я разобрал в руководстве по [вызову хранимой процедуры и отображению её результатов](/ru/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/).

## Подводные камни и похожие ошибки

**`ORDER BY` внутри вашего SQL плюс `First()` в SQL Server.** Даже с псевдонимом `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs ORDER BY Views DESC").First()` генерирует `SELECT TOP(1) [s].[Value] FROM (SELECT Views AS Value FROM Blogs ORDER BY Views DESC) AS [s]`. SQLite принимает это, но SQL Server отклоняет с ошибкой 1033 ("The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified"). Даже если бы SQL Server принял запрос, `ORDER BY` внутри производной таблицы не гарантирует порядок внешнего запроса. Вместо этого перенесите сортировку в LINQ: `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs").OrderByDescending(v => v).First()`.

**DTO вместо скаляра.** Для `SqlQuery<BlogStat>` (несопоставленные типы, EF Core 8+) EF не использует `Value`; он ссылается на один столбец на каждое свойство, по имени свойства. `SELECT Name AS BlogName, Views FROM Blogs` с компоновкой `.Where(b => b.Views > 10)` завершается ошибкой `no such column: b.Name` на SQLite (псевдоним теперь `b`, из имени типа), а тот же запрос без компоновки завершается ошибкой `The required column 'Name' was not present in the results of a 'FromSql' operation`. Исправление: задать каждому столбцу псевдоним, совпадающий с именем свойства. Второму сообщению посвящено отдельное руководство: [the required column was not present in the results of a FromSql operation](/ru/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

**`FromSql` для `DbSet`.** Запросы сущностей никогда не используют `Value`. Если вы получили там `Invalid column name`, то имя в сообщении это один из ваших отображённых столбцов, а причина в столбце, отсутствующем в списке `SELECT`.

**Ваш собственный столбец буквально называется `Value`.** Тогда `SELECT Value FROM Settings` компонуется без проблем и без псевдонима, поэтому некоторые примеры в интернете кажутся работающими без него. Переименуйте столбец таблицы, и эти примеры сломаются.

**Как увидеть настоящий SQL.** `ToQueryString()` для некомпонованного `SqlQueryRaw<int>(...)` выводит только ваш собственный SQL, а после `First()` его вызвать нельзя. Вместо этого журналируйте выполняемые команды (`LogTo` с `RelationalEventId.CommandExecuted` или перехватчик), как описано в посте о [журналировании SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/). Внешний `SELECT [s].[Value]` становится очевидным, как только вы его увидите.

## Когда сырой SQL не подходит

Большая часть скалярного сырого SQL, который я вижу на ревью кода, это `COUNT`, `MAX` или `EXISTS`, которые LINQ выражает напрямую: `db.Blogs.CountAsync()`, `db.Blogs.MaxAsync(b => (int?)b.Views)`, `db.Blogs.AnyAsync(...)`. Они никогда не вызывают эту ошибку и транслируются провайдером с правильным квотированием для каждой базы данных. Оставьте `SqlQuery<T>` для запросов, которые LINQ выразить не может, а если вы выбираете между сырым SQL, скомпилированными запросами и Dapper для горячего пути, в [сравнении скомпилированных запросов EF Core, сырого SQL и Dapper](/ru/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) есть цифры. Если вы перешли на сырой SQL, потому что запрос LINQ не удалось транслировать, руководство по [исправлению "The LINQ expression could not be translated"](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) обычно возвращает вас к LINQ.

## Связанные материалы

- [Fix: The required column 'X' was not present in the results of a 'FromSql' operation in EF Core 11](/ru/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [How to call a stored procedure and map its results in EF Core 11](/ru/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core compiled queries vs raw SQL vs Dapper](/ru/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: The LINQ expression could not be translated in EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Источники

- [SQL Queries: querying scalar (non-entity) types](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types), документация EF Core
- [SQL Queries: composing with LINQ](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#composing-with-linq), включая ограничение `ORDER BY` в SQL Server
- [`RelationalQueryableMethodTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs), dotnet/efcore
- [`RelationalDatabaseFacadeExtensions.SqlQueryRaw<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlqueryraw), справочник API
- [Database engine errors](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors), документация SQL Server (207, 1033, 8155)
