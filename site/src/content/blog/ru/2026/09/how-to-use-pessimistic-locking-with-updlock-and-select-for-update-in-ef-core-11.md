---
title: "Как использовать пессимистичную блокировку с UPDLOCK и SELECT ... FOR UPDATE в EF Core 11"
description: "В EF Core 11 по-прежнему нет API блокировок. Разбираем, как взять настоящую блокировку строки через FromSql: WITH (UPDLOCK, ROWLOCK) в SQL Server, FOR UPDATE в PostgreSQL, ловушка с подзапросом, которая молча расширяет блокировку, NOWAIT и SKIP LOCKED, повторы при дедлоках и что делать, когда строки ещё нет."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-06
---

Короткий ответ: в EF Core 11 нет API пессимистичной блокировки, поэтому блокировку вы берёте сами через `FromSql` внутри явной транзакции. В SQL Server это `SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {id}`, в PostgreSQL это `SELECT * FROM "Orders" WHERE "Id" = {id} FOR UPDATE`. Работает это при соблюдении двух правил, которые как раз чаще всего и нарушают: запрос должен выполняться внутри транзакции, которую вы открыли сами (иначе блокировка снимается в тот же момент, когда читатель завершает работу), и условие `WHERE` должно находиться внутри строки `FromSql`, а не в LINQ-вызове `.Where()`, добавленном следом.

В статье разобраны точный SQL, который EF Core формирует для каждого варианта, почему композиция LINQ поверх блокирующего запроса молча расширяет блокировку на всю таблицу, как `NOWAIT` и `SKIP LOCKED` меняют режим отказа, как повторять операцию после дедлока, не конфликтуя со стратегией устойчивости соединения, и случай, о котором никто не пишет: блокировка строки, которой ещё нет.

Замечание о версиях. EF Core 11 по состоянию на сентябрь 2026 находится в предварительной версии и выходит вместе с .NET 11 в ноябре 2026, согласно [странице релизов и планирования EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 требует среды выполнения .NET 11. Поскольку единственный SDK на этой машине это .NET 10.0.302, весь приведённый ниже сгенерированный SQL получен через `ToQueryString()` на `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10 и `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3. В этой области в EF11 ничего не изменилось: страница [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) не перечисляет изменений в `FromSql`, транзакциях или блокировках.

## API блокировок в EF Core по-прежнему нет, и это осознанно

Запрос открыт с сентября 2021 года как [dotnet/efcore#26042, "Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency)"](https://github.com/dotnet/efcore/issues/26042). У него метка `needs-design`, он лежит в вехе Backlog без целевой версии. EF Core 11 его не закрывает.

Почему универсальный API сделать сложно, видно из остальной части статьи: SQL Server выражает блокировку как подсказку таблицы, привязанную к ссылке на таблицу, PostgreSQL выражает её как предложение уровня инструкции с четырьмя разными степенями строгости, и обе СУБД расходятся в том, что происходит с соединениями, `LIMIT` и несуществующими строками. Формы, которая аккуратно ложится на обе, не существует. Поэтому SQL вы пишете сами.

Альтернатива, к которой стоит обращаться в первую очередь, это токен параллелизма `rowversion`. Пессимистичная блокировка уместна только тогда, когда конфликтующая работа происходит внутри одной короткой транзакции на сервере. Если между чтением, изменением и записью находится человек, используйте [токен параллелизма rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/): держать транзакцию базы данных открытой всё время, пока пользователь пьёт кофе, нельзя.

## Настройка в четыре шага

1. **Откройте явную транзакцию.** `await using var tx = await context.Database.BeginTransactionAsync();`. Любая блокировка строки живёт и умирает вместе с транзакцией. Без неё EF Core оборачивает чтение в собственную неявную транзакцию, которая фиксируется сразу после исчерпания читателя, и блокировка исчезает микросекундами позже.
2. **Прочитайте строку через `FromSql`, поместив фильтр внутрь строки SQL.** Синтаксис блокировки должен стоять у той ссылки на таблицу, которая действительно просматривается.
3. **Измените отслеживаемую сущность и вызовите `SaveChangesAsync`.** Результаты `FromSql` отслеживаются по умолчанию, ровно как у любого другого LINQ-запроса, поэтому обновление формируется автоматически.
4. **Зафиксируйте транзакцию.** Блокировка снимается при фиксации или откате, и не раньше.

Вот версия для SQL Server целиком:

```csharp
// EF Core 11 (verified on EF Core 10.0.10), .NET 11, C# 14
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

И версия для PostgreSQL, тот же код с другой строкой:

```csharp
// Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE""")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

Интерполяция в `FromSql` это не конкатенация строк. Подстановка `{orderId}` превращается в `DbParameter`, поэтому такой код защищён от инъекций. `ToQueryString()` это подтверждает:

```sql
-- SQL Server, from ToQueryString()
DECLARE p0 int = 42;

SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = @p0
```

Одно ограничение из [документации по SQL-запросам EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries): результирующий набор должен содержать столбец для каждого сопоставленного свойства сущности, с сопоставленными именами столбцов. `SELECT *` этому удовлетворяет. Вручную перечисленный набор столбцов, в котором забыто свойство, выбрасывает исключение при материализации, чему посвящена статья [требуемый столбец отсутствовал в результатах операции FromSql](/ru/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

## Что на самом деле даёт UPDLOCK в SQL Server

`UPDLOCK` берёт блокировки обновления (U) вместо разделяемых (S) и, согласно [справочнику по подсказкам таблиц](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), удерживает их до завершения транзакции. Вторая половина этого утверждения и есть весь смысл. Обычный `SELECT` при `READ COMMITTED` берёт разделяемые блокировки и снимает их сразу после чтения строки, поэтому две транзакции могут обе прочитать, обе решить записать, а затем попасть во взаимную блокировку, когда каждая попытается преобразовать свою S-блокировку в X-блокировку. U-блокировки несовместимы между собой, поэтому второй читатель блокируется на чтении, а не попадает в дедлок на записи. Именно этот дедлок преобразования и есть классический симптом, из-за которого разработчики начинают искать эту возможность.

Три детали, которые стоит усвоить:

- **`ROWLOCK` это запрос гранулярности, а не гарантия.** Он просит блокировки строк там, где SQL Server обычно взял бы блокировки страницы или таблицы. Добавляйте его, чтобы просмотр нескольких строк не эскалировал до блокировки страницы над строками, которых вы не касались. Если `UPDLOCK` по какой-то причине окажется совмещён с `TABLOCK`, документация говорит, что вы получите исключительную блокировку таблицы, а это редко то, что нужно.
- **Один `UPDLOCK` не останавливает вставки.** Он блокирует существующие строки. Если ваша логика звучит как «просуммируй позиции этого заказа, затем вставь ещё одну», другая транзакция может вставить позицию, которая изменит сумму. Добавьте `HOLDLOCK`, который документация описывает как эквивалент `SERIALIZABLE`, чтобы получить блокировки диапазона ключей по предикату на всё время транзакции: `WITH (UPDLOCK, HOLDLOCK, ROWLOCK)`.
- **Блокировки могут ложиться на ключи индекса, а не на строки данных.** Раздел «Remarks» говорит об этом прямо: если на запрос отвечает покрывающий некластеризованный индекс, блокировка берётся на ключ индекса. Обычно это незаметно, но изредка именно этим объясняется, почему два, казалось бы, непересекающихся запроса блокируют друг друга.

Учтите также объявленное устаревание: подсказки таблиц без ключевого слова `WITH` всё ещё разбираются, но Microsoft пометила эту форму к удалению. Пишите `WITH (UPDLOCK, ROWLOCK)`, с запятыми между подсказками, а не `(UPDLOCK ROWLOCK)`.

## В PostgreSQL четыре степени блокировки, и FOR UPDATE самая строгая

[Документация по предложению блокировки в SELECT](https://www.postgresql.org/docs/current/sql-select.html) определяет `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` и `FOR KEY SHARE` в порядке убывания строгости. `FOR UPDATE` блокирует всех остальных, кто хочет заблокировать строку, плюс `UPDATE` и `DELETE`. `FOR NO KEY UPDATE` это то, что обычный `UPDATE`, не затрагивающий столбец ключа, берёт самостоятельно, и это правильный выбор, когда вы меняете только неключевые столбцы и не хотите блокировать проверки внешних ключей из дочерних таблиц, которые берут `FOR KEY SHARE`.

Шаблон, на котором спотыкаются, это `FOR UPDATE` вместе с `Include`. PostgreSQL отказывается блокировать nullable-сторону внешнего соединения: "FOR UPDATE cannot be applied to the nullable side of an outer join". Решение это `FOR UPDATE OF "Orders"`, где названа только та таблица, которую вы действительно хотите заблокировать. В EF Core проблема в основном решается сама, потому что `Include` компонуется поверх вашего `FromSql` как подзапрос, а соединение оказывается снаружи:

```sql
-- Npgsql, FromSql with FOR UPDATE plus .Include(o => o.Lines)
SELECT o."Id", o."Status", o."Total", o0."Id", o0."OrderId", o0."Quantity"
FROM (
    SELECT * FROM "Orders" WHERE "Id" = @p0 FOR UPDATE
) AS o
LEFT JOIN "OrderLines" AS o0 ON o."Id" = o0."OrderId"
ORDER BY o."Id"
```

Строка `Orders` заблокирована, строки `OrderLines` нет. Если позиции тоже нужно заблокировать, заблокируйте их вторым `FromSql` к `OrderLines`, в согласованном порядке.

## Ловушка с подзапросом, которая молча расширяет блокировку

Это тот режим отказа, на который я поставил бы деньги в продакшен-коде. `FromSql` компонуется: любой LINQ-оператор, добавленный следом, превращает ваш SQL в производную таблицу. Вынесите фильтр из строки в `.Where()`, и EF Core сформирует вот это:

```sql
-- Npgsql: .FromSql($"""SELECT * FROM "Orders" FOR UPDATE""").Where(o => o.Status == "Pending")
SELECT o."Id", o."Status", o."Total"
FROM (
    SELECT * FROM "Orders" FOR UPDATE
) AS o
WHERE o."Status" = 'Pending'
```

Теперь `FOR UPDATE` привязан к нефильтрованному просмотру `Orders`. PostgreSQL не проталкивает внешний предикат внутрь подзапроса с предложением блокировки, потому что это изменило бы набор блокируемых строк. Документация говорит о том же в обходном приёме для `ORDER BY`: `SELECT * FROM (SELECT * FROM mytable FOR UPDATE) ss ORDER BY column1` «блокирует все строки». То есть такой запрос блокирует каждую строку таблицы и останавливает всех остальных писателей, причём без ошибки, без предупреждения и без чего-либо в плане запроса, что выглядело бы очевидно неправильным.

SQL Server выдаёт ту же форму и более тонкую проблему:

```sql
-- SQL Server: .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)").Where(o => o.Status == "Pending")
SELECT [o].[Id], [o].[Status], [o].[Total]
FROM (
    SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)
) AS [o]
WHERE [o].[Status] = N'Pending'
```

Производная таблица в T-SQL не является барьером оптимизации, поэтому оптимизатор может протолкнуть предикат внутрь, а может и нет. То, какие строки окажутся заблокированы, становится свойством выбранного плана, а не вашего кода. Это не та ошибка, которую хочется отлаживать в три часа ночи.

Правило: всё, что сужает набор строк, идёт внутрь строки `FromSql`. Цепочку LINQ добавляйте следом только для того, что не может расширить блокировку, например для `Include` или проекции. И проверьте это один раз, либо через `ToQueryString()` в тесте, либо [журналируя SQL, который формирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## NOWAIT и SKIP LOCKED: выбор способа отказа

По умолчанию заблокированный запрос на блокировку ждёт. Обе СУБД дают две альтернативы.

**Быстрый отказ.** `FOR UPDATE NOWAIT` в PostgreSQL немедленно выбрасывает SQLSTATE `55P03` (`lock_not_available`) вместо ожидания. Подсказка таблицы `NOWAIT` в SQL Server документирована как эквивалент `SET LOCK_TIMEOUT 0` для этой таблицы и проявляется как ошибка 1222, "Lock request time out period exceeded". В обоих случаях вы получаете исключение, которое можно превратить в 409, вместо запроса, который тридцать секунд занимает поток:

```csharp
// Npgsql: fail immediately rather than queue behind another worker
try
{
    var order = await context.Orders
        .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE NOWAIT""")
        .SingleAsync();
}
catch (PostgresException ex) when (ex.SqlState == "55P03")
{
    return Results.Conflict("Order is being modified by another request.");
}
```

**Пропуск спорных строк.** Это шаблон очереди задач и единственный случай, где пессимистичная блокировка однозначно является правильным решением. PostgreSQL записывает это как `SKIP LOCKED`, SQL Server как `READPAST`, который документация описывает как созданный именно для того, «чтобы снизить конкуренцию за блокировки при реализации рабочей очереди на таблице SQL Server».

```csharp
// SQL Server: claim up to 10 unclaimed jobs, skipping rows other workers hold
await using var tx = await context.Database.BeginTransactionAsync();

var jobs = await context.Jobs
    .FromSql($"""
        SELECT TOP (10) * FROM [Jobs] WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE [Status] = 'Queued' ORDER BY [Id]
        """)
    .ToListAsync();

foreach (var job in jobs)
{
    job.Status = "Running";
}

await context.SaveChangesAsync();
await tx.CommitAsync();
```

Два ограничения на `READPAST`. Он пропускает блокировки уровня строки, но не уровня страницы, и это ещё одна причина сочетать его с `ROWLOCK`. И его нельзя использовать, когда `READ_COMMITTED_SNAPSHOT` установлен в `ON`, а уровень изоляции сессии это `READ COMMITTED`; в такой конфигурации придётся добавить подсказку `READCOMMITTEDLOCK`. В PostgreSQL `SKIP LOCKED` даёт намеренно несогласованное представление, что нормально для очереди и неверно для всего, что вы собираетесь агрегировать.

## Дедлоки никуда не денутся, поэтому делайте повторы

Пессимистичная блокировка превращает большинство конфликтов записи в ожидание, но не устраняет взаимные блокировки: две транзакции, блокирующие строки A потом B и B потом A, всё равно попадут в дедлок (ошибка 1205 в SQL Server, SQLSTATE `40P01` в PostgreSQL). Дешёвое структурное решение это всегда захватывать блокировки в детерминированном порядке, что обычно означает сортировку по первичному ключу до начала блокировок.

Для остального нужны повторы. Если вы включили `EnableRetryOnFailure`, учтите, что стратегия выполнения с повторами отказывается оборачивать транзакцию, открытую вами, и выбрасывает `InvalidOperationException`. Через стратегию должна проходить вся единица работы, что подробно разобрано в статье [стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/):

```csharp
var strategy = context.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    await using var tx = await context.Database.BeginTransactionAsync();

    var order = await context.Orders
        .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
        .SingleAsync();

    order.Status = "Confirmed";
    await context.SaveChangesAsync();
    await tx.CommitAsync();
});
```

Одна оговорка: стандартная `SqlServerRetryingExecutionStrategy` в EF повторяет операции для конкретного списка временных номеров ошибок SQL Server. Проверьте, входят ли дедлоки в нужный вам набор, или задайте собственный `errorNumbersToAdd`, вместо того чтобы предполагать, что 1205 обработан.

## Нельзя заблокировать строку, которой не существует

Самое серьёзное ограничение. `SELECT ... FOR UPDATE` для ещё не вставленной строки возвращает ноль строк и ничего не блокирует, поэтому классическая гонка «проверь, занято ли это имя пользователя, затем вставь его» блокировками строк не защищена совсем. Обе транзакции не видят ничего, обе вставляют, и одна получает нарушение уникального ограничения, что и есть сценарий из статьи [fix 23505 duplicate key value violates unique constraint при конкурентной вставке в EF Core](/ru/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

Три выхода, в порядке возрастания того, насколько они вам должны нравиться:

- **Уникальный индекс плюс перехваченное исключение.** Ограничение обеспечивает база данных, а вы переводите исключение провайдера в доменную ошибку. Скучно, корректно и является ответом по умолчанию.
- **Блокировка предиката.** В SQL Server `WITH (UPDLOCK, HOLDLOCK)` поверх того `WHERE`, который совпал бы, берёт блокировку диапазона ключей и действительно останавливает конкурирующую вставку. У PostgreSQL прямого эквивалента нет, кроме уровня изоляции `SERIALIZABLE`.
- **Рекомендательная блокировка по значению как ключу.** `pg_advisory_xact_lock(key)` в PostgreSQL берёт блокировку на произвольное 64-битное число, которая автоматически снимается в конце транзакции (в отличие от `pg_advisory_lock`, действующей на уровне сессии и переживающей откат). Эквивалент в SQL Server это `sys.sp_getapplock` с `@LockOwner = 'Transaction'` и строковым именем ресурса, возвращающий `0` или `1` при успехе, `-1` при таймауте и `-3`, если запрос выбран жертвой дедлока.

```csharp
// PostgreSQL: serialise on a logical key rather than a row
await using var tx = await context.Database.BeginTransactionAsync();
await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({tenantId})");
// ... read, decide, insert ...
await tx.CommitAsync();
```

Рекомендательные блокировки уместны, когда сериализовать нужно решение, а не строку: «ночную сводку по этому арендатору может выполнять только один worker».

## Когда стоит взять совсем другой инструмент

Если вся операция это одно арифметическое обновление, не блокируйте вообще. `UPDATE Accounts SET Balance = Balance - 10 WHERE Id = 1 AND Balance >= 10` атомарен, берёт собственную исключительную блокировку на время выполнения инструкции и по числу затронутых строк сообщает, выполнялось ли предусловие. В EF Core это `ExecuteUpdateAsync`, а компромиссы по сравнению с загрузкой сущности разобраны в статье [ExecuteUpdate против загрузки сущностей и SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/). Пессимистичная блокировка оправдывает себя только тогда, когда между чтением и записью есть настоящая логика, которую SQL выразить не может.

И держите транзакцию короткой. Всё, что вы делаете между `BeginTransactionAsync` и `CommitAsync`, это время, которое другие запросы проводят заблокированными. HTTP-вызов к платёжному провайдеру внутри транзакции, удерживающей блокировки, это способ уронить целую таблицу из-за одной медленной зависимости.

### Читайте дальше

- [Как реализовать оптимистичный параллелизм с токеном rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: требуемый столбец отсутствовал в результатах операции FromSql в EF Core 11](/ru/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [Как журналировать SQL, который формирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ExecuteUpdate против загрузки сущностей и SaveChanges в EF Core](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Источники

- [Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency), dotnet/efcore#26042](https://github.com/dotnet/efcore/issues/26042), открыт с 2021 года и всё ещё в вехе Backlog.
- [Table hints (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) про `UPDLOCK`, `HOLDLOCK`, `ROWLOCK`, `READPAST`, `NOWAIT`, устаревание ключевого слова `WITH` и блокировки на ключах индекса.
- [SELECT, The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) про четыре степени блокировки, `NOWAIT`, `SKIP LOCKED`, список `OF table` и замечание о блокировке в подзапросах.
- [Explicit locking, документация PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) про матрицу конфликтов строковых блокировок и рекомендательные блокировки уровня транзакции.
- [SQL queries in EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) про параметризацию `FromSql`, композицию, оборачивание в подзапрос и отслеживание изменений.
- [sys.sp_getapplock (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) про режимы блокировки, владение на уровне транзакции против сессии и коды возврата.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), подтверждающая, что EF11 требует среды выполнения .NET 11, и не перечисляющая изменений в блокировках или `FromSql`.
