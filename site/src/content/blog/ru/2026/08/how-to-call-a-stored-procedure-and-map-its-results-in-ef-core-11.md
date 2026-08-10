---
title: "Как вызвать хранимую процедуру и отобразить её результаты в EF Core 11"
description: "Используйте FromSql на DbSet, когда процедура возвращает полные строки сущности, Database.SqlQuery<T> при проекции и ExecuteSql, когда она не возвращает ничего. Никогда не присоединяйте оператор LINQ к EXEC и не читайте выходной параметр до того, как ридер будет освобождён."
pubDate: 2026-08-10
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-10
---

Короткий ответ: EF Core 11 предоставляет три точки входа для вызова хранимой процедуры, и большая часть проблем возникает именно из-за неверного выбора. Используйте `FromSql` на `DbSet<T>`, когда процедура возвращает все столбцы отображённой сущности. Используйте `Database.SqlQuery<T>`, когда она возвращает проекцию, не являющуюся сущностью; для произвольных DTO это работает начиная с EF Core 8. Используйте `Database.ExecuteSql`, когда она вообще не возвращает набор результатов. Два правила действуют во всех трёх случаях: к `EXEC` нельзя присоединить оператор LINQ, а `Value` выходного параметра равен null до тех пор, пока нижележащий ридер не будет освобождён.

В этой статье разбираются все три API, точные исключения при их неверном применении, выходные и возвращаемые параметры, множественные наборы результатов и поведение отслеживания, которое многих удивляет.

Всё изложенное ниже было измерено на SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) с EF Core 10.0.10 на .NET SDK 10.0.201, поскольку EF Core 11 требует среду выполнения .NET 11, которая на этой машине не установлена. Здесь это менее существенно, чем обычно: EF Core 11 не вносит изменений в `FromSql`, `SqlQuery` и `ExecuteSql`, а [заметки о выпуске EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) вообще не содержат записей о хранимых процедурах. Каждое приведённое здесь сообщение об исключении и каждое поведение идентичны в EF Core 8, 9, 10 и 11. Там, где утверждение взято из документации, а не измерено, я это указываю.

Схема для всех примеров:

```sql
-- SQL Server 2022
CREATE TABLE Blogs (
    Id         int NOT NULL IDENTITY PRIMARY KEY,
    Name       nvarchar(200) NOT NULL,
    Rating     int NOT NULL,
    OwnerEmail nvarchar(200) NULL
);

CREATE PROCEDURE dbo.GetTopBlogs @MinRating int AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs
    WHERE Rating >= @MinRating ORDER BY Rating DESC;
END
```

Обратите внимание на `SET NOCOUNT ON`. Без него SQL Server перед набором результатов отправляет сообщение о количестве затронутых строк, которое некоторые драйверы показывают как фантомный пустой набор результатов. Это ничего не стоит и предотвращает целый класс запутанных ошибок.

## Когда процедура возвращает строки сущности: FromSql

`FromSql` является методом расширения для `DbSet<T>` и подходит тогда, когда набор результатов процедуры столбец в столбец соответствует отображённой сущности:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .ToListAsync();
```

Эта интерполированная вставка не является конкатенацией строк. `FromSql` принимает `FormattableString` и превращает каждую вставку в `DbParameter`, поэтому такой вызов защищён от SQL-инъекций. Увидеть, что именно отправляется, можно вызовом `ToQueryString()`:

```text
DECLARE p0 int = 3;

EXEC dbo.GetTopBlogs @MinRating = @p0
```

EF передал SQL без изменений. Обрамляющего подзапроса нет, и именно этому посвящён следующий раздел.

Результаты возвращаются отслеживаемыми, точно как в обычном LINQ-запросе. После вызова процедуры на три строки я измерил три сущности в трекере изменений. Для путей только на чтение добавьте `AsNoTracking()`; здесь это работает нормально, поскольку SQL при этом не меняется:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsNoTracking()
    .ToListAsync();
```

Для именованных параметров, которые важны, когда у процедуры есть необязательные параметры, оберните значение в `SqlParameter` и сошлитесь на него по имени:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("min", 3);

var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {minRating}")
    .AsNoTracking()
    .ToListAsync();
```

Повторное использование одного экземпляра `SqlParameter` в двух последовательных вызовах работает, вопреки распространённому мнению, унаследованному от чистого ADO.NET, где параметр может принадлежать коллекции только одной команды. Я пропустил один и тот же экземпляр через два подряд идущих вызова `FromSqlRaw` без исключений.

### Набор результатов должен содержать все отображённые столбцы

С этой ошибкой сталкиваются первой. Уберите `OwnerEmail` из `SELECT` процедуры, и запрос умрёт:

```text
InvalidOperationException: The required column 'OwnerEmail' was not present
in the results of a 'FromSql' operation.
```

EF материализует сущность целиком, поэтому ридер обязан предоставить каждое отображённое свойство, включая теневые свойства и дискриминаторы. Имена столбцов должны совпадать с именами отображённых столбцов, а не с именами свойств, и это реальное изменение поведения по сравнению с EF6. Порядок значения не имеет, а сопоставление не учитывает регистр. Если изменить процедуру так, чтобы она возвращала недостающие столбцы, невозможно, значит вы возвращаете не сущность и вам следует использовать `SqlQuery<T>`. Это конкретное исключение я подробнее разобрал в [руководстве по ошибке об отсутствующем столбце в FromSql](/ru/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

### Компоновать LINQ поверх EXEC нельзя

Это вторая вещь, на которой спотыкаются все. SQL Server не может вложить вызов процедуры в подзапрос, поэтому в момент добавления оператора, изменяющего SQL, EF сдаётся:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .Where(b => b.Rating > 4)          // composition
    .ToListAsync();
```

```text
InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable
SQL and with a query composing over it. Consider calling 'AsEnumerable' after the
method to perform the composition on the client side.
```

То же исключение возникает для `Include`, `OrderBy`, `Skip`/`Take`, а также для голого `First()` или `Single()`, поскольку все они добавляют `TOP` или `ORDER BY`. Я убедился, что `Include` тоже его выбрасывает, так что жадная загрузка навигационного свойства поверх вызова процедуры недоступна.

Решение названо в самом сообщении. Вставьте `AsEnumerable()` (или `AsAsyncEnumerable()`) сразу после `FromSql`, чтобы провести явную границу между тем, что делает база данных, и тем, что делает ваш процесс:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsEnumerable()                    // everything after this runs in memory
    .Where(b => b.Rating > 4)
    .ToList();
```

Будьте честны с собой относительно цены: каждая возвращённая процедурой строка пересекает сеть и материализуется до того, как выполнится `Where`. Если процедура возвращает 200 000 строк, а вам нужны четыре, вынесите фильтр внутрь процедуры в виде параметра. `AsEnumerable` исправляет корректность, а не производительность.

Отслеживание изменений продолжает действовать и после `AsEnumerable`, что многих сбивает с толку. Граница на стороне клиента переносит только операторы запроса; материализация уже произошла на стороне EF. После `FromSql(...).AsEnumerable().ToList()` я измерил три отслеживаемые сущности. Поставьте `AsNoTracking()` перед `AsEnumerable()`, если вам это не нужно.

Для сравнения, компонуемый `SELECT` оборачивается и проталкивается вниз, и именно это делает `FromSql` по-настоящему полезным для SQL, не связанного с процедурами:

```csharp
// .NET 11, C# 14, EF Core 11
var q = context.Blogs
    .FromSql($"SELECT * FROM Blogs WHERE Rating >= {3}")
    .Where(b => b.Name.StartsWith("S"));
```

```sql
SELECT [b].[Id], [b].[Name], [b].[OwnerEmail], [b].[Rating]
FROM (
    SELECT * FROM Blogs WHERE Rating >= @p0
) AS [b]
WHERE [b].[Name] LIKE N'S%'
```

В этом и состоит всё различие. Компонуемый SQL начинается с `SELECT` и переживает превращение в подзапрос; `EXEC` не переживает.

## Когда процедура возвращает проекцию: SqlQuery&lt;T&gt;

Большинство реальных хранимых процедур возвращают не строки сущности. Они возвращают форму отчёта: соединение, `GROUP BY`, несколько вычисляемых столбцов. Для таких случаев `Database.SqlQuery<T>` отображает набор результатов на обычный CLR-тип, которого вообще нет в вашей модели. Это тот самый API, который большинство статей по теме до сих пор описывает как пригодный только для скалярных значений; это перестало быть правдой в EF Core 8, где его расширили на [любой отображаемый CLR-тип](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types).

```sql
CREATE PROCEDURE dbo.GetBlogStats @MinViews int AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.Name AS BlogName, COUNT(p.Id) AS PostCount, SUM(p.Views) AS TotalViews
    FROM Blogs b JOIN Posts p ON p.BlogId = b.Id
    WHERE p.Views >= @MinViews
    GROUP BY b.Name;
END
```

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
    public int TotalViews { get; set; }
}

var stats = await context.Database
    .SqlQuery<BlogStat>($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`BlogStat` не требует ни `DbSet`, ни записи в `OnModelCreating`, ни атрибутов. Что я проверил относительно поведения отображения:

- **Сопоставление идёт по имени столбца, а не по позиции.** Я вернул три столбца в перемешанном порядке, и каждое свойство встало на своё место.
- **Сопоставление не учитывает регистр.** И `blogname`, и `POSTCOUNT` связались корректно.
- **Лишние столбцы в наборе результатов игнорируются.** Добавление четвёртого столбца `Surprise` не выбросило исключение, хотя документация утверждает, что тип "должен иметь свойство для каждого значения в наборе результатов". Не опирайтесь на это; это недокументированное поведение, а не контракт.
- **Отсутствующий столбец фатален.** Уберите `TotalViews` из `SELECT`, и вы получите то же сообщение `The required column 'TotalViews' was not present in the results of a 'FromSql' operation.`, что и на пути сущности.
- **Null в свойстве, не допускающем null, выбрасывает** `SqlNullValueException: Data is Null. This method or property cannot be called on Null values.` Объявите свойство допускающим null или используйте `COALESCE` в SQL.

Используйте `[Column("...")]`, когда имя столбца результата не может совпасть с именем вашего свойства:

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    [Column("blog_name")]
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
}
```

Правило о некомпонуемости действует здесь точно так же. `SqlQuery<T>(...).Where(...)` поверх `EXEC` выбрасывает ровно то же исключение, и `AsEnumerable()` служит тем же решением.

Для одиночного скалярного значения `SqlQuery<T>` с примитивным типом работает напрямую:

```csharp
// .NET 11, C# 14, EF Core 11
var count = (await context.Database
    .SqlQuery<int>($"EXEC dbo.GetBlogCount")
    .ToListAsync()).Single();
```

Документация EF Core предписывает давать выходному столбцу псевдоним `AS Value` для скалярного `SqlQuery`. Это требование действует только при компоновке LINQ поверх запроса, поскольку EF нужно имя, на которое сошлётся генерируемый им внешний `SELECT`. Вызову процедуры без компоновки псевдоним не нужен; я убедился, что `SELECT COUNT(*)` без псевдонима связывается нормально.

### Альтернатива через сущность без ключа

До EF Core 8 единственным способом отобразить форму результата, не являющуюся сущностью, был тип сущности без ключа, и он остаётся лучшим выбором, когда эта форма является частью вашей предметной области и вы хотите запрашивать её как `DbSet`:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<BlogStat>().HasNoKey().ToView(null);
}

var stats = await context.Set<BlogStat>()
    .FromSql($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`ToView(null)` сообщает EF, что у типа нет базовой таблицы, поэтому миграции не станут её создавать. Типы без ключа никогда не отслеживаются, что я подтвердил: ноль записей после материализации трёх строк. Берите `SqlQuery<T>` для разовых отчётов, а тип без ключа, когда форма переиспользуется по всему приложению или ей нужен [запрос, генерируемый EF, наряду с процедурой](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types).

## Когда процедура не возвращает ничего: ExecuteSql

Для процедуры, которая только пишет, используйте `ExecuteSql`. Она возвращает количество затронутых строк, а не что-либо вычисленное процедурой:

```csharp
// .NET 11, C# 14, EF Core 11
var rowsAffected = await context.Database
    .ExecuteSqlAsync($"EXEC dbo.BumpRatings @By = {1}");
```

`ExecuteSql` параметризует так же, как `FromSql`; `ExecuteSqlRaw` служит запасным выходом, когда SQL приходится собирать динамически. Это иной инструмент, нежели [`ExecuteUpdate` и `ExecuteDelete` для массовых записей](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), которые генерируют SQL из LINQ, а не вызывают написанное вами.

Важная оговорка: `ExecuteSql` выполняется вне трекера изменений. Изменённые им в базе строки не отражаются в сущностях, уже загруженных контекстом, поэтому последующий `SaveChanges` может записать поверх них устаревшие значения. Вызывайте его до загрузки либо затем применяйте `Reload()` к затронутым записям.

## Выходные параметры и проблема с моментом чтения, на которой попадаются все

Процедура, возвращающая и набор результатов, и выходной параметр, является распространённым шаблоном для постраничного вывода:

```sql
CREATE PROCEDURE dbo.GetTopBlogsWithCount @MinRating int, @TotalCount int OUTPUT AS
BEGIN
    SET NOCOUNT ON;
    SELECT @TotalCount = COUNT(*) FROM Blogs;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs WHERE Rating >= @MinRating;
END
```

Выходным параметрам нужны явные экземпляры `SqlParameter` и `FromSqlRaw`, поскольку `Direction` приходится задавать самостоятельно:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("MinRating", SqlDbType.Int) { Value = 3 };
var totalCount = new SqlParameter("TotalCount", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};

var blogs = await context.Blogs
    .FromSqlRaw("EXEC dbo.GetTopBlogsWithCount @MinRating, @TotalCount OUTPUT",
        minRating, totalCount)
    .ToListAsync();

var total = (int)totalCount.Value;   // only valid after ToListAsync
```

Обратите внимание на ключевое слово `OUTPUT` в тексте SQL. Опустите его, и SQL Server сочтёт параметр только входным и молча ничего не вернёт.

Теперь та часть, которая стоит людям целого вечера. `totalCount.Value` равен `null` до закрытия `DbDataReader`, потому что именно тогда SQL Server отправляет значения выходных параметров по сети. Измерено напрямую:

```text
before enumeration:  total.Value = null
mid-enumeration:     total.Value = null
after dispose:       total.Value = 5
```

Чтение `totalCount.Value` строкой ниже построения запроса даёт `null` и `NullReferenceException` при приведении типа. Оно должно идти после завершения перечисления. `ToListAsync()`, `First()` поверх `AsEnumerable()` и `await foreach` по `AsAsyncEnumerable()` работают, поскольку каждый из них освобождает ридер.

Следствие хуже. Если взять перечислитель и не освободить его, вы получите два сбоя разом:

```csharp
// .NET 11, C# 14, EF Core 11 - do not do this
var e = context.Blogs
    .FromSqlRaw("EXEC dbo.ManyRowsWithCount @Total OUTPUT", total)
    .AsEnumerable().GetEnumerator();
e.MoveNext();                        // reader is open and never closed
```

`total.Value` остаётся `null`, а следующий запрос к этому `DbContext` падает с `InvalidOperationException: There is already an open DataReader associated with this Connection which must be closed first.` Я случайно наткнулся на это при тестировании, и это сломало все последующие запросы к контексту. Если перечисляете вручную, оберните это в `using`.

## Получение значения RETURN, которое не является выходным параметром

`RETURN 42` в T-SQL представляет собой третий канал, отдельный от выходных параметров и наборов результатов. Очевидный подход не работает:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
```

```text
SqlException: Must declare the scalar variable "@ret".
```

`ParameterDirection.ReturnValue` распознаётся только тогда, когда команда является настоящим `CommandType.StoredProcedure`, а EF всегда отправляет `CommandType.Text`. Работают два способа. Более простой объявляет параметр как `Output` и позволяет синтаксису `EXEC @ret =` выполнить привязку:

```csharp
// .NET 11, C# 14, EF Core 11
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};
var by = new SqlParameter("By", SqlDbType.Int) { Value = 1 };

context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
var returnValue = (int)ret.Value;   // 42
```

Второй способ спускается до чистого `DbCommand` на соединении EF, что заодно даёт `CommandType.StoredProcedure` и, следовательно, настоящую поддержку `ReturnValue`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.BumpRatings";
cmd.CommandType = CommandType.StoredProcedure;
cmd.Parameters.Add(new SqlParameter("@By", SqlDbType.Int) { Value = 1 });
var ret = new SqlParameter("@ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
cmd.Parameters.Add(ret);

await cmd.ExecuteNonQueryAsync();
var returnValue = (int)ret.Value;   // 42
```

Оба вернули 42. Используйте первый, если вам не нужен `CommandType.StoredProcedure` по другой причине. Если вы открываете соединение сами, помните, что EF не закроет его за вас.

## Множественные наборы результатов по-прежнему не поддерживаются

Если ваша процедура возвращает два набора результатов, EF читает первый и молча отбрасывает остальные. Без исключения, без предупреждения. Я вызвал через `FromSql` процедуру, возвращающую и блоги, и посты, и получил обратно три блога, а пять постов были выброшены.

[FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127) открыт с апреля 2017 года и находится в вехе Backlog, так что в EF Core 11 это не появится. Обходной путь состоит в чистом `DbDataReader` и `NextResult()`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.TwoResultSets";
cmd.CommandType = CommandType.StoredProcedure;

await using var reader = await cmd.ExecuteReaderAsync();

var blogs = new List<Blog>();
while (await reader.ReadAsync())
    blogs.Add(new Blog { Id = reader.GetInt32(0), Name = reader.GetString(1) });

await reader.NextResultAsync();

var posts = new List<Post>();
while (await reader.ReadAsync())
    posts.Add(new Post { Id = reader.GetInt32(0), Title = reader.GetString(2) });
```

Это вернуло три блога и пять постов, корректно разделённых. Вы теряете материализацию и отслеживание EF; если отслеживание нужно, присоединяйте результаты вручную. При таком объёме ручной работы `QueryMultiple` из Dapper выглядит разумной альтернативой, а компромиссы здесь те же, что я измерил в [сравнении компилированных запросов, чистого SQL и Dapper](/ru/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/).

## Отображение вставок, обновлений и удалений на процедуры

Всё вышесказанное касается чтения. Обратное направление, когда `SaveChanges` вызывает ваши процедуры вместо генерации `INSERT`/`UPDATE`/`DELETE`, представляет собой отдельную возможность, добавленную в EF Core 7 и не изменившуюся в 11:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Person>()
    .InsertUsingStoredProcedure(
        "People_Insert",
        spb =>
        {
            spb.HasParameter(p => p.Name);
            spb.HasResultColumn(p => p.Id);
        })
    .DeleteUsingStoredProcedure(
        "People_Delete",
        spb =>
        {
            spb.HasOriginalValueParameter(p => p.Id);
            spb.HasRowsAffectedResultColumn();
        });
```

Прежде чем на это решаться, стоит знать две вещи из документации. Параметры должны объявляться в том же порядке, в каком они идут в определении процедуры, поскольку EF всегда вызывает позиционно, а не по имени. И для значений ключа в процедурах обновления и удаления обязательны параметры исходных значений. Этот путь я не проверял на базе данных, поэтому считайте пример взятым из документации.

Команда EF прямо высказывается об этой возможности в собственных заметках о выпуске: поддержка отображения на хранимые процедуры не означает, что хранимые процедуры рекомендуются.

## Выбор подходящего API

Если процедура возвращает полные строки сущности, используйте `FromSql` на `DbSet` и смиритесь с отслеживанием. Если она возвращает проекцию, используйте `Database.SqlQuery<T>` с обычным DTO либо тип сущности без ключа, когда форма переиспользуется. Если она не возвращает ничего, используйте `ExecuteSql`. Если она возвращает несколько наборов результатов или нужное вам значение `RETURN`, спускайтесь до `DbCommand`.

Что бы вы ни выбрали, ставьте `AsEnumerable()` после вызова, как только захотите отфильтровать, и читайте выходные параметры только после завершения перечисления. Эти два правила покрывают большинство вопросов по теме.

## Связанные материалы

- [Fix: требуемый столбец отсутствовал в результатах операции FromSql](/ru/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Компилированные запросы EF Core против чистого SQL и Dapper](/ru/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: выражение LINQ не удалось транслировать в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Как журналировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)

## Источники

- [SQL Queries, документация EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Raw SQL queries for unmapped types, новое в EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)
- [Keyless entity types, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [Stored procedure mapping, новое в EF Core 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/whatsnew#stored-procedure-mapping)
- [Новое в EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [dotnet/efcore#8127, FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127)
- [RelationalStrings.FromSqlNonComposable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationalstrings.fromsqlnoncomposable)
