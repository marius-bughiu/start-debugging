---
title: "Исправление: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions"
description: "EnableRetryOnFailure конфликтует с BeginTransaction. Оберните всю транзакцию в db.Database.CreateExecutionStrategy().ExecuteAsync(...), чтобы она повторялась как единое целое."
pubDate: 2026-06-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ru"
translationOf: "2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions"
translatedBy: "claude"
translationDate: 2026-06-10
---

Исправление: вы включили устойчивость подключения с помощью `EnableRetryOnFailure()`, а затем открыли собственную транзакцию через `BeginTransaction()` или `BeginTransactionAsync()`. Стратегия выполнения с повторами не может воспроизвести транзакцию, которую она не начинала, поэтому она отказывает заранее. Получите стратегию из `db.Database.CreateExecutionStrategy()` и выполните всю транзакцию внутри `strategy.ExecuteAsync(...)`. Весь делегат становится единой повторяемой единицей.

```text
System.InvalidOperationException: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions. Use the execution strategy returned by 'DbContext.Database.CreateExecutionStrategy()' to execute all the operations in the transaction as a retriable unit.
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, Func`4 operation, Func`4 verifySucceeded, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerExecutionStrategy.Execute[TState,TResult](...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.BeginTransaction()
```

Это руководство написано для .NET 11 и `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, но сообщение и лежащее в его основе правило стабильны со времён EF Core 1.1, когда появилась устойчивость подключения. Если вы используете EF Core 6, 8 или 9, всё изложенное ниже применимо без изменений. Имя типа в сообщении зависит от вашего провайдера: SQL Server бросает `SqlServerRetryingExecutionStrategy`, Npgsql бросает `NpgsqlRetryingExecutionStrategy`, провайдер MySQL от Pomelo бросает свой собственный. Исправление одинаково для всех.

## Почему стратегия с повторами отклоняет вашу транзакцию

Устойчивость подключения работает, оборачивая каждую операцию с базой данных в цикл повторов. Когда вы вызываете `EnableRetryOnFailure()`, EF Core подставляет стратегию выполнения, которая знает, какие номера ошибок SQL Server являются временными (жертвы взаимной блокировки, разрывы подключения, троттлинг Azure SQL), и повторяет эти операции с экспоненциальной задержкой. Ключевое слово здесь -- *каждая*. Каждый запрос и каждый вызов `SaveChangesAsync()` становится собственной повторяемой единицей. Если одна из них даёт временный сбой, стратегия воспроизводит именно эту операцию.

Транзакция ломает эту модель. Когда вы вызываете `BeginTransactionAsync()`, вы сообщаете EF Core, что несколько операций образуют единую атомарную группу. Если подключение разорвётся в середине, повтор одной инструкции бессмыслен: сервер уже откатил транзакцию, и воспроизведение единственного `INSERT` внутри транзакции, которой больше нет, либо завершится сбоем, либо, что хуже, зафиксирует частичную работу. Стратегия выполнения не может знать, что должна была содержать ваша транзакция, поэтому не может воспроизвести её правильно.

Вместо того чтобы повторять некорректно и рисковать повреждением данных, EF Core бросает исключение в момент, когда вы пытаетесь начать пользовательскую транзакцию при активной стратегии с повторами. Официальное руководство прямо говорит о ставках: наивный повтор через границу фиксации "could lead to data corruption", если операция зависит от состояния хранилища. Исключение -- это защитное ограждение, а не баг.

## Минимальный код, который вызывает ошибку

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(
        connectionString,
        sql => sql.EnableRetryOnFailure())); // <-- resiliency on

// ...somewhere in a service:
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    await using var tx = await _db.Database.BeginTransactionAsync(); // <-- throws here

    var from = await _db.Accounts.FindAsync(fromId);
    var to = await _db.Accounts.FindAsync(toId);
    from!.Balance -= amount;
    to!.Balance += amount;

    await _db.SaveChangesAsync();
    await tx.CommitAsync();
}
```

Строка `BeginTransactionAsync()` никогда не возвращает транзакцию. EF Core сначала проверяет наличие активной стратегии с повторами и бросает `InvalidOperationException`. Обратите внимание, что для этого не обязательно явно вызывать `BeginTransaction`: считается всё, что открывает пользовательскую транзакцию, включая `TransactionScope`, созданный вами самостоятельно.

## Исправление 1: оберните транзакцию в стратегию выполнения

Это каноническое исправление и то, что документирует Microsoft. Запросите у контекста его стратегию выполнения, а затем передайте ей делегат, содержащий всю транзакцию, от `BeginTransactionAsync` до `CommitAsync`. Если временный сбой произойдёт где-либо внутри, стратегия повторно выполнит весь делегат вместе с транзакцией.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    var strategy = _db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var from = await _db.Accounts.FindAsync(fromId);
        var to = await _db.Accounts.FindAsync(toId);
        from!.Balance -= amount;
        to!.Balance += amount;

        await _db.SaveChangesAsync();
        await tx.CommitAsync();
    });
}
```

`CreateExecutionStrategy()` возвращает ту же стратегию с повторами, которую EF Core настроил из вашего вызова `EnableRetryOnFailure()`. Когда устойчивость отключена, он возвращает пустую стратегию, выполняющую делегат ровно один раз, поэтому этот код безопасно писать даже в проектах, где повторы не включены. Это делает `strategy.ExecuteAsync` разумной оболочкой по умолчанию для любой явной транзакции, а не только для приложений, размещённых в Azure.

Есть правило, на котором спотыкаются: делегат должен быть достаточно идемпотентным, чтобы выполняться с начала более одного раза. Не читайте значение до вызова `strategy.ExecuteAsync`, изменяя его и полагаясь на это чтение внутри повтора. Перенесите каждое чтение и запись внутрь делегата, чтобы повтор начинался с чистого листа.

## Исправление 2: ExecuteInTransactionAsync, когда нужно проверить фиксацию

`strategy.ExecuteAsync` покрывает обычный случай, но имеет слепое пятно. Если подключение разорвётся *во время выполнения фиксации*, стратегия не знает, действительно ли сервер зафиксировал изменения. По умолчанию она предполагает откат и воспроизводит операцию, что может вставить дублирующую строку, если вы используете ключи, генерируемые хранилищем.

`ExecuteInTransactionAsync` закрывает этот пробел. Он начинает и фиксирует транзакцию за вас и принимает делегат `verifySucceeded`, который выполняется после временного сбоя фиксации, чтобы проверить, применилась ли работа.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

var blog = new Blog { Url = "https://startdebugging.net" };
_db.Blogs.Add(blog);

await strategy.ExecuteInTransactionAsync(
    _db,
    operation: (ctx, ct) => ctx.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct),
    verifySucceeded: (ctx, ct) =>
        ctx.Blogs.AsNoTracking().AnyAsync(b => b.BlogId == blog.BlogId, ct));

_db.ChangeTracker.AcceptAllChanges();
```

Здесь важны две детали. `SaveChangesAsync` вызывается с `acceptAllChangesOnSuccess: false`, чтобы отслеживаемые сущности оставались в состоянии `Added`, пока вы не убедитесь, что фиксация прошла; именно это позволяет чисто воспроизвести операцию. Затем вы вызываете `ChangeTracker.AcceptAllChanges()` один раз после возврата стратегии. Запрос `verifySucceeded` использует `AsNoTracking()`, чтобы проверочное чтение не конфликтовало с сущностями, всё ещё ожидающими в трекере изменений.

Если вас по-настоящему не волнует редкий сбой в середине фиксации, вариант Microsoft "почти ничего не делать" -- избегать ключей, генерируемых хранилищем (используйте клиентский `Guid`), чтобы слепое воспроизведение бросало нарушение первичного ключа вместо тихого дублирования данных. Тогда достаточно Исправления 1.

## Внешние транзакции и TransactionScope

Та же оболочка работает с `TransactionScope`, в том числе когда он охватывает два контекста. Откройте область и вызовите `Complete()` внутри делегата.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    using var scope = new TransactionScope(
        TransactionScopeAsyncFlowOption.Enabled); // required for await inside

    _db.Orders.Add(order);
    await _db.SaveChangesAsync();

    await _auditDb.SaveChangesAsync();

    scope.Complete();
});
```

Без `TransactionScopeAsyncFlowOption.Enabled` внешняя транзакция не передаётся через `await`, и вы получаете отдельное, трудно диагностируемое `TransactionAbortedException`. Это другая ошибка, но она возникает ровно в том же пути кода, поэтому устанавливайте этот флаг всегда, когда сочетаете `TransactionScope` с асинхронными вызовами EF Core.

## Подводные камни и похожие случаи

**Ошибка может возникнуть на простом запросе, а не только на записи.** Issue на GitHub [dotnet/efcore#29396](https://github.com/dotnet/efcore/issues/29396) отслеживает сообщения о появлении этого сообщения на простом `SELECT`. Обычная причина -- внешний `TransactionScope`, о котором вы забыли (часто открытый в базовом репозитории, тестовой фикстуре или обёртке единицы работы), так что "простой" запрос на самом деле выполняется внутри пользовательской транзакции. Просмотрите стек вызовов на наличие любого `BeginTransaction` или `new TransactionScope` выше сбойной строки.

**Azure SQL может включить это без вашего запроса.** Примерно начиная с EF Core 8 провайдер SQL Server стал по умолчанию использовать стратегию с повторами при обнаружении строки подключения Azure SQL (см. [dotnet/efcore#32165](https://github.com/dotnet/efcore/issues/32165)). Код, работавший локально с LocalDB, внезапно даёт сбой в Azure, потому что устойчивость теперь активна. Если вы видите это только в облачной среде, вот почему. Исправление -- та же оболочка; отключать поведение по умолчанию не нужно.

**Не удаляйте `EnableRetryOnFailure` просто чтобы ошибка исчезла.** Это убирает ошибку, убирая устойчивость, которую вы, предположительно, хотели. Вместо этого оберните транзакцию. Если вам действительно нужно обойти устойчивость для одной изолированной операции, более чистый обходной путь, обсуждаемый в [dotnet/efcore#24922](https://github.com/dotnet/efcore/issues/24922), -- использовать второй, отдельно настроенный контекст без повторов, а не убирать её из основного контекста.

**Это не то же самое, что "A second operation was started on this context instance".** Та ошибка относится к параллельному использованию одного `DbContext`, а не к транзакциям и повторам. Если в вашем сообщении говорится о параллелизме, а не о стратегиях выполнения, см. исправление для [второй операции, начатой на этом контексте](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/).

## Связанное

- [Исправление: SqlException: Timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) охватывает семейство временных сбоев со стороны миграций.
- [Исправление: ObjectDisposedException: Cannot access a disposed context instance](/ru/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) -- другая ловушка жизненного цикла EF Core, бьющая по асинхронному коду.
- [EF Core ExecuteUpdate против загрузки сущностей и SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) показывает, когда явную транзакцию можно вообще избежать.
- [Как использовать перехватчики EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/), чтобы встроиться в конвейер сохранения без ручных транзакций.
- [Миграция с EF Core 6 на EF Core 11: критические изменения, которые реально кусаются](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) указывает на стратегию повторов Azure SQL по умолчанию среди прочих сюрпризов.

## Источники

- [Connection Resiliency, EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) - каноническое руководство по `CreateExecutionStrategy`, `ExecuteInTransactionAsync` и проблеме идемпотентности.
- [Implement resilient Entity Framework Core SQL connections](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/implement-resilient-applications/implement-resilient-entity-framework-core-sql-connections) - взгляд архитектуры микросервисов .NET на тот же шаблон.
- [dotnet/efcore#32165: стратегия повторов по умолчанию для Azure SQL](https://github.com/dotnet/efcore/issues/32165)
- [dotnet/efcore#29396: ошибка на простом SELECT](https://github.com/dotnet/efcore/issues/29396)
- [dotnet/efcore#24922: приостановка настроенной стратегии выполнения](https://github.com/dotnet/efcore/issues/24922)
