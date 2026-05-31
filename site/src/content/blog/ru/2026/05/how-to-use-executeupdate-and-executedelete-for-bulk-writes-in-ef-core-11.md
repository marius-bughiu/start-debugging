---
title: "Как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11"
description: "Полное руководство по ExecuteUpdate и ExecuteDelete в EF Core 11: какой SQL они генерируют, ловушка трекера изменений, которая молча перезаписывает вашу массовую запись, транзакции, контроль конкурентного доступа через число затронутых строк и сеттеры через делегат из EF Core 10, позволяющие собирать условные обновления обычными инструкциями if."
pubDate: 2026-05-31
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Краткий ответ: чтобы обновить или удалить много строк одной инструкцией SQL, напишите LINQ-`Where`, чтобы выбрать строки, а затем вызовите `ExecuteUpdateAsync` или `ExecuteDeleteAsync` на полученном запросе. EF Core 11 транслирует всё это в единственный `UPDATE` или `DELETE`, который выполняется в базе данных, без загруженных сущностей, без трекера изменений и без `SaveChanges`. Оба метода выполняются немедленно и возвращают число затронутых строк. Единственная ловушка, в которую попадаются все: поскольку эти методы никогда не трогают трекер изменений, любая уже загруженная сущность сохраняет своё устаревшее значение, и последующий `SaveChanges` с удовольствием перезапишет вашу массовую запись.

Эта статья охватывает `ExecuteUpdate` и `ExecuteDelete` в `Microsoft.EntityFrameworkCore` 11.0.0 на .NET 11 против SQL Server 2025: точный SQL, который они генерируют, обновление нескольких свойств, ссылку на существующее значение столбца, ловушку отслеживания изменений и как её обойти, семантику транзакций, реализацию собственного оптимистичного контроля конкурентного доступа через число затронутых строк, условные сеттеры через делегат, появившиеся в EF Core 10, и ограничения, которые отправляют вас обратно к `SaveChanges`. Реляционные API идентичны на PostgreSQL и SQLite; различается лишь генерируемый диалект SQL.

## Почему цикл с SaveChanges -- неподходящий инструмент для массовых записей

Наивный способ выполнить мягкое удаление каждого блога с низким рейтингом выглядит разумно, пока вы не посмотрите на SQL:

```csharp
// .NET 11, EF Core 11.0.0 - the slow way
await foreach (var blog in context.Blogs.Where(b => b.Rating < 3).AsAsyncEnumerable())
{
    context.Blogs.Remove(blog);
}

await context.SaveChangesAsync();
```

Это запрашивает каждую подходящую строку по сети, материализует каждую в отслеживаемую сущность, помечает её как `Deleted` в трекере изменений, а затем при `SaveChanges` выдаёт по одному `DELETE` на строку. Если подходят 50 000 блогов, это один большой `SELECT`, 50 000 выделений памяти и 50 000 инструкций `DELETE` (сгруппированных в пакеты, но всё равно параметризованных по отдельности). База данных выполняет огромную работу для операции, которая концептуально является единственной инструкцией на основе множеств.

`ExecuteDelete` сводит всё это к единственному обращению к серверу:

```csharp
// .NET 11, EF Core 11.0.0
int deleted = await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteDeleteAsync();
```

EF Core 11 транслирует предикат LINQ в SQL ровно так же, как сделал бы для запроса, но выдаёт `DELETE` вместо `SELECT`:

```sql
DELETE FROM [b]
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Ничего не загружается, ничего не отслеживается, а `deleted` содержит число строк. Вы можете поместить в `Where` любой транслируемый LINQ, включая соединения и подзапросы, точно так же, как при выборке строк.

## Обновление на месте с помощью ExecuteUpdate

`ExecuteUpdate` -- это собрат `UPDATE`. Вместо удаления блогов с низким рейтингом скройте их:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.IsVisible, false));
```

`Where` выбирает строки; вызов `SetProperty` указывает, какой столбец меняется и на какое значение. EF Core 11 выдаёт:

```sql
UPDATE [b]
SET [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Чтобы изменить несколько столбцов сразу, объедините вызовы `SetProperty` в цепочку. Все они попадают в одну инструкцию:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.IsVisible, false)
        .SetProperty(b => b.Rating, 0));
```

```sql
UPDATE [b]
SET [b].[Rating] = 0,
    [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

### Вычисление нового значения из старого

Второй аргумент `SetProperty` не обязан быть константой. Передайте лямбду, и вы получите текущую строку, так что сможете вычислить новое значение из существующих столбцов. Чтобы увеличить каждый подходящий рейтинг на единицу:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters =>
        setters.SetProperty(b => b.Rating, b => b.Rating + 1));
```

Внутри этой лямбды `b.Rating` -- это значение столбца до обновления, и EF Core транслирует всё выражение в SQL, так что арифметика происходит в базе данных, атомарно, без состояния гонки «прочитал-изменил-записал»:

```sql
UPDATE [b]
SET [b].[Rating] = [b].[Rating] + 1
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Это паттерн, который вам нужен для счётчиков, балансов и меток версий. Делать это через `SaveChanges` означает загрузить строку, изменить её в памяти и сохранить, что открывает окно, в котором другая транзакция может изменить ту же строку между вашим чтением и записью. У `UPDATE` на основе множеств такого окна нет.

## Ловушка трекера изменений, которая молча проглатывает вашу запись

Вот самое важное, что нужно усвоить про оба метода: они вступают в силу немедленно и не имеют никакого взаимодействия с трекером изменений EF. Это источник их скорости и одновременно источник единственной ошибки, которую все совершают хотя бы раз.

Внимательно проследите эту последовательность:

```csharp
// .NET 11, EF Core 11.0.0
// 1. Tracking query: this Blog is now tracked, Rating == 5 in memory.
var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");

// 2. Bump every blog's rating by one in the database. Runs now.
await context.Blogs
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.Rating, b => b.Rating + 1));

// 3. Mutate the tracked instance in memory.
blog.Rating += 2;

// 4. Persist tracked changes.
await context.SaveChangesAsync();
```

После шага 2 строка в базе данных равна `6`. Но отслеживаемый экземпляр по-прежнему считает, что исходное значение равно `5`, потому что `ExecuteUpdate` ничего не сообщил трекеру изменений. Шаг 3 устанавливает значение в памяти в `7`. Когда на шаге 4 выполняется `SaveChanges`, EF сравнивает текущее значение `7` с *исходным*, которое он записал на шаге 1 (`5`), решает, что свойство изменилось, и записывает `7`. Ваш массовый `+1` пропал, перезаписанный `SaveChanges`, который понятия не имел, что он вообще был.

Официальная рекомендация из [документации EF Core по ExecuteUpdate и ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete) предельно прямая: избегайте смешивания отслеживаемых изменений `SaveChanges` и неотслеживаемых изменений через `ExecuteUpdate`/`ExecuteDelete` над одними и теми же сущностями в одной единице работы. На практике есть два чистых способа не попасть в беду:

1. Выполняйте массовую запись против контекста, чей запрос этих строк использовал `AsNoTracking()`, так что ничего отслеживаемого не сможет устареть.
2. Если вам нужно читать сущности, выполните массовую запись, а затем вызовите `context.ChangeTracker.Clear()` перед повторным запросом, чтобы следующее чтение заново заполнилось из базы данных свежими значениями.

```csharp
// .NET 11, EF Core 11.0.0 - re-read fresh after a bulk write
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.IsVisible, false));

context.ChangeTracker.Clear();

var hidden = await context.Blogs
    .AsNoTracking()
    .Where(b => !b.IsVisible)
    .ToListAsync();
```

Самая чистая ментальная модель: относитесь к `ExecuteUpdate`/`ExecuteDelete` так, будто они принадлежат отдельному, более низкоуровневому слою доступа к данным, который просто делит с вами `DbContext`. Они говорят на SQL, а не на сущностях. Это та же граница, которую вы соблюдаете, когда [мокаете DbContext, не ломая отслеживание изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): трекер изменений -- это объект с состоянием в памяти, и записи по побочному каналу его не обновляют.

## Транзакции: ничего не происходит неявно

Ни один из методов не открывает транзакцию за вас. Каждый вызов -- это собственное обращение к серверу и, если вы его не обернёте, собственная неявная транзакция. Эта последовательность -- четыре отдельные транзакции:

```csharp
// .NET 11, EF Core 11.0.0 - four independent transactions, NOT atomic
await context.Blogs.ExecuteUpdateAsync(/* update A */);
await context.Blogs.ExecuteUpdateAsync(/* update B */);

var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");
blog.Rating += 2;
await context.SaveChangesAsync();
```

Если обновление B выбросит исключение, обновление A уже зафиксировано. Отката нет, потому что общей транзакции никогда не было. Когда две или более массовые записи должны успешно завершиться или провалиться вместе, запустите явную транзакцию через [DatabaseFacade](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.databasefacade):

```csharp
// .NET 11, EF Core 11.0.0 - one atomic unit
await using var tx = await context.Database.BeginTransactionAsync();

await context.Blogs
    .Where(b => b.Rating < 0)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, 0));

await context.Posts
    .Where(p => p.IsOrphaned)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Теперь обе инструкции делят одну транзакцию и откатываются вместе при сбое. Если одна из них выполняется против медленной таблицы и вы столкнётесь с [SqlException: Timeout expired](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), явная транзакция -- это также место, где вы задали бы более длинный тайм-аут команды для пакета.

## Реализуйте собственный контроль конкурентного доступа через число строк

`SaveChanges` даёт вам оптимистичный контроль конкурентного доступа бесплатно через токены конкурентного доступа: он добавляет токен в предложение `WHERE` и выбрасывает `DbUpdateConcurrencyException`, если ни одна строка не совпадает. `ExecuteUpdate` и `ExecuteDelete` не трогают трекер изменений, поэтому не могут делать этого автоматически. Вместо этого они дают вам сырьё: число затронутых строк.

Поместите токен конкурентного доступа в собственный `Where` и проверьте возвращаемое значение:

```csharp
// .NET 11, EF Core 11.0.0 - hand-rolled optimistic concurrency
int updated = await context.Blogs
    .Where(b => b.Id == id && b.Version == expectedVersion)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.Title, newTitle)
        .SetProperty(b => b.Version, b => b.Version + 1));

if (updated == 0)
{
    // Either the row is gone or someone else bumped Version first.
    throw new DbUpdateConcurrencyException("Blog was modified concurrently.");
}
```

Поскольку проверка `Version` является частью SQL-`WHERE`, сравнение и запись -- это одна атомарная инструкция. Ни одна строка не совпадёт, если другая транзакция уже увеличила `Version`, `updated` вернётся как `0`, и вы отреагируете. Это часто *быстрее* отслеживаемого пути для обновлений одной строки на нагруженных конечных точках и хорошо сочетается с паттернами на стороне чтения из [скомпилированных запросов для горячих путей](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Условные сеттеры без деревьев выражений (EF Core 10 и новее)

До EF Core 10 аргумент сеттеров был деревом выражений, что делало динамические обновления болезненными: вы не могли вставить инструкцию `if` в середину текучей цепочки, поэтому условные обновления означали либо разветвление всего вызова, либо построение деревьев выражений вручную. Начиная с EF Core 10 и унаследовано в EF Core 11, есть перегрузка, чей аргумент сеттеров -- обычный делегат с телом из инструкций. Вы можете использовать обычный поток управления C#:

```csharp
// .NET 11, EF Core 11.0.0 - conditional setters with normal control flow
await context.Blogs
    .Where(b => b.Id == id)
    .ExecuteUpdateAsync(setters =>
    {
        setters.SetProperty(b => b.Title, newTitle);

        if (rankChanged)
        {
            setters.SetProperty(b => b.Rating, newRating);
        }

        foreach (var (column, value) in extraFlags)
        {
            // build setters in a loop, one per flag that actually changed
            setters.SetProperty(column, value);
        }
    });
```

Тело делегата выполняется один раз, на C#, чтобы собрать список столбцов для установки; затем EF Core 11 транслирует это в единственный `UPDATE`. Это идиоматический способ реализовать конечную точку PATCH, где клиент присылает только те поля, которые хочет изменить. Вы собираете ровно те сеттеры, что нужны, и выдаёте одну инструкцию, вместо того чтобы обновлять все столбцы или прибегать к загрузке-изменению-сохранению. Старая перегрузка на основе выражений по-прежнему существует и подходит для статичного случая с всегда одними и теми же столбцами.

## Ссылки на связанные сущности и ограничения

`ExecuteUpdate` не может ссылаться на навигацию напрямую внутри `SetProperty`. Это не транслируется:

```csharp
// .NET 11, EF Core 11.0.0 - does NOT work
await context.Blogs.ExecuteUpdateAsync(
    setters => setters.SetProperty(b => b.Rating, b => b.Posts.Average(p => p.Rating)));
```

Обходной путь -- сделать `Select` в анонимную проекцию, которая сначала вычислит значение, а затем вызвать `ExecuteUpdate` над этой проекцией:

```csharp
// .NET 11, EF Core 11.0.0 - set each Blog's rating to the average of its Posts
await context.Blogs
    .Select(b => new { Blog = b, NewRating = b.Posts.Average(p => p.Rating) })
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.Blog.Rating, x => x.NewRating));
```

EF Core 11 превращает среднее в коррелированный подзапрос внутри `UPDATE`:

```sql
UPDATE [b]
SET [b].[Rating] = CAST((
    SELECT AVG(CAST([p].[Rating] AS float))
    FROM [Post] AS [p]
    WHERE [b].[Id] = [p].[BlogId]) AS int)
FROM [Blogs] AS [b]
```

Помимо навигаций, держите в уме эти ограничения:

- **Только обновление и удаление.** Метода `ExecuteInsert` нет. Вставки по-прежнему идут через `Add` плюс `SaveChanges`.
- **Не возвращает старые значения.** SQL может вернуть затронутые строки, но EF Core 11 этого не предоставляет; вы получаете только число.
- **Нет группировки между вызовами.** Два вызова `ExecuteUpdate` -- это два обращения к серверу. Нет аналога накопления изменений и однократного сброса.
- **Одна таблица на инструкцию.** Как и в сыром SQL `UPDATE`/`DELETE`, один вызов нацелен на одну таблицу. Обновление по иерархии наследования TPT, охватывающей несколько таблиц, невыразимо в одном вызове.
- **Только реляционные провайдеры.** Это методы расширения над реляционным провайдером запросов; у in-memory провайдера их нет.

Первое заслуживает внимания: если ваш горячий путь -- это *вставки* большого объёма, ни один из методов не поможет. Это отдельная задача со своим ответом, измеренная в [EF Core 11 против Dapper для массовых вставок](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Когда что выбирать

Решение в основном зависит от того, нужны ли вам сущности. Если вы удаляете или обновляете строки по предикату и не нуждаетесь в затронутых объектах в памяти после этого, `ExecuteDelete`/`ExecuteUpdate` почти всегда правильный выбор: одна инструкция, без материализации, без накладных расходов на отслеживание. Это тот же инстинкт, который заставляет вас выследить и убить [запрос N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), то есть отказ делать обращения к серверу на каждую строку, когда база данных может выполнить всю работу одной операцией на основе множеств.

Возвращайтесь к `SaveChanges`, когда вам действительно нужен трекер изменений: сложные графы объектов, каскадное поведение, зависящее от отслеживаемого состояния, автоматические токены конкурентного доступа, либо перехватчики и доменные события, подключённые к `SaveChanges`. И всякий раз, когда вы смешиваете оба подхода, помните про границу. Массовые методы пишут SQL напрямую и оставляют ваши отслеживаемые сущности замороженными в прошлом. Очищайте трекер или запрашивайте с `AsNoTracking()` после массовой записи, оборачивайте работу из нескольких инструкций в явную транзакцию и проверяйте возвращённое число строк, когда корректность зависит от того, сколько строк действительно изменилось.
