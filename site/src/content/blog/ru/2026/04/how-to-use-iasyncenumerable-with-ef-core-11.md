---
title: "Как использовать IAsyncEnumerable<T> с EF Core 11"
description: "Запросы EF Core 11 напрямую реализуют IAsyncEnumerable<T>. Как стримить строки через await foreach, когда предпочесть его вместо ToListAsync, и подводные камни со соединениями, трекингом и отменой."
pubDate: 2026-04-22
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "ru"
translationOf: "2026/04/how-to-use-iasyncenumerable-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

Если у вас есть запрос в EF Core 11, возвращающий много строк, вам не обязательно материализовать весь результат в `List<T>` до начала обработки. EF Core `IQueryable<T>` уже реализует `IAsyncEnumerable<T>`, так что можно сделать `await foreach` прямо по нему, и каждая строка будет выдаваться по мере того, как её производит база. Никакого `ToListAsync`, никакого самописного итератора, никакого пакета `System.Linq.Async`. Это короткий ответ. Эта статья разбирает механику, особенности версии для EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14) и подводные камни, которые кусают людей, прикручивающих стриминг к кодовой базе, не спроектированной под него.

## Зачем EF Core вообще выставляет `IAsyncEnumerable<T>`

Пайплайн запросов EF Core построен вокруг data reader. Когда вы вызываете `ToListAsync()`, EF Core открывает соединение, выполняет команду и вытягивает строки из reader в буферизованный список до исчерпания reader, потом всё закрывает. Вы получаете `List<T>`, что удобно, но весь результат теперь живёт в памяти процесса, а первая строка видна вашему коду только после того, как последняя строка прочитана.

`IAsyncEnumerable<T>` выворачивает это наизнанку. Вы запрашиваете строки по одной. EF Core открывает соединение, запускает команду и выдаёт первую материализованную сущность, как только первая строка пришла по проводу. Ваш код начинает работать сразу. Память остаётся ограниченной тем, что удерживает тело цикла. Для отчётов, экспортов и пайплайнов, которые трансформируют строки перед записью куда-то ещё, это тот самый паттерн.

Поскольку `DbSet<TEntity>` и `IQueryable<TEntity>`, возвращаемый любой LINQ-цепочкой, оба реализуют `IAsyncEnumerable<TEntity>`, явный вызов `AsAsyncEnumerable()` не нужен. Интерфейс на месте. Машинерия async foreach его подхватывает.

## Минимальный пример

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();

await foreach (var invoice in db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt))
{
    await ProcessAsync(invoice);
}
```

Это всё. Никакого `ToListAsync`. Никакой промежуточной аллокации. Нижележащий `DbDataReader` остаётся открытым всё время цикла. Каждая итерация вытягивает следующую строку с провода, материализует `Invoice` и передаёт в тело цикла.

Сравните с версией на основе списка:

```csharp
// Buffers every row into memory before the first ProcessAsync call
var invoices = await db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt)
    .ToListAsync();

foreach (var invoice in invoices)
{
    await ProcessAsync(invoice);
}
```

Для 50 строк разница невидима. Для 5 миллионов строк потоковая версия заканчивает первую накладную раньше, чем буферизованная версия успеет аллоцировать список.

## Как правильно передать cancellation token

Перегрузка `IQueryable<T>.GetAsyncEnumerator(CancellationToken)` принимает токен, но когда вы пишете `await foreach (var x in query)`, нет места, куда его передать. Решение - `WithCancellation`:

```csharp
public async Task ExportPendingAsync(CancellationToken ct)
{
    await foreach (var invoice in db.Invoices
        .Where(i => i.Status == InvoiceStatus.Pending)
        .AsNoTracking()
        .WithCancellation(ct))
    {
        ct.ThrowIfCancellationRequested();
        await writer.WriteAsync(invoice, ct);
    }
}
```

`WithCancellation` не оборачивает последовательность в другой итератор. Он просто протягивает токен в вызов `GetAsyncEnumerator`, который EF Core пробрасывает в `DbDataReader.ReadAsync`. Если вызывающий отменит токен, ожидающий `ReadAsync` отменяется, команда прерывается на сервере, а `OperationCanceledException` всплывает через ваш `await foreach`.

Не пропускайте токен. Забытый токен в потоковом запросе EF Core - это зависший запрос в продакшне, когда HTTP-клиент отсоединяется. Путь на основе списка падает так же, но здесь болит сильнее, потому что соединение удерживается весь цикл, а не только на шаге материализации.

## Выключайте трекинг, если он вам реально не нужен

`AsNoTracking()` важнее в стриминге, чем в буферизации. С включённым change tracking каждая сущность, выданная энумератором, добавляется в `ChangeTracker`. Это ссылка, которую GC не может собрать, пока вы не освободите `DbContext`. Стриминг миллиона строк через запрос с трекингом убивает смысл стриминга: память растёт линейно с количеством строк, как и с `ToListAsync`.

```csharp
await foreach (var row in db.AuditEvents
    .AsNoTracking()
    .Where(e => e.OccurredAt >= cutoff)
    .WithCancellation(ct))
{
    await sink.WriteAsync(row, ct);
}
```

Сохраняйте трекинг, только если собираетесь мутировать сущности и вызывать `SaveChangesAsync` внутри цикла, что, как аргументирует следующий раздел, почти никогда делать не следует.

## Нельзя открыть второй запрос на том же контексте, пока один стримит

Это самый частый подводный камень в продакшне. `DbDataReader`, открываемый EF Core при начале перечисления, удерживает соединение. Если внутри цикла вы вызываете другой метод EF Core, которому нужно то же соединение, вы получаете:

```
System.InvalidOperationException: There is already an open DataReader associated
with this Connection which must be closed first.
```

На SQL Server это можно обойти, включив Multiple Active Result Sets (`MultipleActiveResultSets=True` в строке подключения), но у MARS свои компромиссы по производительности, и не все провайдеры его поддерживают. Лучший паттерн - не смешивать операции на одном контексте. Либо:

- Сначала собрать нужные ID, закрыть поток, потом сделать последующую работу; либо
- Использовать второй `DbContext` для внутренних вызовов.

```csharp
await foreach (var order in queryCtx.Orders
    .AsNoTracking()
    .WithCancellation(ct))
{
    await using var writeCtx = await factory.CreateDbContextAsync(ct);
    writeCtx.Orders.Attach(order);
    order.ProcessedAt = DateTime.UtcNow;
    await writeCtx.SaveChangesAsync(ct);
}
```

`IDbContextFactory<TContext>` (зарегистрированный через `AddDbContextFactory` в вашей настройке DI) - самый чистый способ получить второй контекст, не воюя со scoped-временем жизни.

## Стриминг и транзакции плохо сочетаются

Потоковый энумератор держит соединение открытым, пока крутится цикл. Если этот цикл также участвует в транзакции, транзакция остаётся открытой весь цикл. Долгоживущие транзакции - это путь к эскалации блокировок, заблокированным писателям и тем таймаутам, которые проявляются только под нагрузкой.

Два правила, которые держат это в рамках:

1. Не открывайте транзакцию вокруг потокового чтения, если не нужен именно согласованный снапшот.
2. Если нужен снапшот, рассмотрите уровень изоляции `SNAPSHOT` на SQL Server или `REPEATABLE READ` на вашем провайдере и относитесь к телу цикла как к горячему пути. Никаких HTTP-вызовов, никаких ожиданий, видимых пользователю.

Для задач массовой обработки обычная форма такая: потоковое чтение, запись построчно или батчами в короткой транзакции на отдельном контексте, коммит, идём дальше.

## `AsAsyncEnumerable` существует, и иногда он нужен

Если у вас есть метод, принимающий `IAsyncEnumerable<T>`, и вы хотите подать ему запрос EF Core, прямая передача `IQueryable<T>` компилируется, потому что интерфейс реализован, но в месте вызова это выглядит неправильно. `AsAsyncEnumerable` - это no-op в рантайме, который делает намерение явным:

```csharp
public async Task ExportAsync(IAsyncEnumerable<Invoice> source, CancellationToken ct)
{
    // Consumes a generic async sequence. Does not know it is EF.
}

await ExportAsync(
    db.Invoices.AsNoTracking().AsAsyncEnumerable(),
    ct);
```

Он также заставляет вызов покинуть мир `IQueryable`. После прохода через `AsAsyncEnumerable()` любые последующие LINQ-операторы работают на клиенте как операторы async-итератора, а не как SQL. Именно такого поведения вы хотите здесь, потому что принимающий метод не должен случайно переписать запрос.

## Что происходит, если вы выходите из цикла раньше

Async-итераторы убираются при disposal. Когда `await foreach` выходит по любой причине (break, исключение или завершение), компилятор вызывает `DisposeAsync` на энумераторе, который закрывает `DbDataReader` и возвращает соединение в пул. Поэтому `await using` на `DbContext` всё ещё важен, но отдельному запросу свой using не нужен.

Неочевидное следствие: если вы делаете `break` после первой строки запроса на 10 миллионов строк, EF Core остальные строки не читает, но база, возможно, уже накатила многие из них. План запроса не знает, что вы потеряли интерес. Для SQL Server клиентский `DbDataReader.Close` отправляет cancel по TDS-потоку, и сервер сдаётся, но для огромных числ строк вы всё равно можете увидеть несколько секунд работы сервера после выхода из цикла. Это почти никогда не проблема, но стоит знать, когда отладчик показывает запрос, работающий на сервере после того, как ваш тест уже прошёл.

## Не злоупотребляйте `ToListAsync` поверх потокового источника

Время от времени кто-то пишет так:

```csharp
// Pointless: materializes the whole thing, then streams it
var all = await db.Invoices.ToListAsync(ct);
await foreach (var item in all.ToAsyncEnumerable()) { }
```

Никакой пользы. Если нужен стриминг, идите прямо из `IQueryable` в `await foreach`. Если нужна буферизация, держите `List<T>` и используйте обычный `foreach`. Смешивание всегда выдаёт того, кто не понял, чего хотел.

Аналогично, вызов `.ToAsyncEnumerable()` на запросе EF Core избыточен в EF Core 11: источник уже реализует интерфейс. Компилируется и работает, но не добавляйте.

## Client-evaluation всё ещё просачивается

Транслятор запросов EF Core хорош, но не каждое LINQ-выражение переводится в SQL. Если не может, EF Core 11 по умолчанию бросает на финальном операторе (в отличие от молчаливого client-eval в EF Core 2.x). Стриминг это не меняет: если ваш фильтр `.Where` ссылается на метод, который EF Core не может перевести, весь запрос падает во время перечисления, а не при старте `await foreach`.

Сюрприз в том, что с `await foreach` исключение всплывает на первом `MoveNextAsync`, который внутри заголовка цикла, а не перед ним. Оберните настройку в `try`, если хотите отличать ошибки настройки от ошибок обработки:

```csharp
try
{
    await foreach (var row in query.WithCancellation(ct))
    {
        try { await ProcessAsync(row, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Row {Id} failed", row.Id); }
    }
}
catch (Exception ex)
{
    log.LogError(ex, "Query failed before first row");
    throw;
}
```

## Когда `ToListAsync` всё ещё правильный ответ

Стриминг не универсально лучше. Берите `ToListAsync`, когда:

- Результат маленький и ограниченный (скажем, до нескольких тысяч строк).
- Нужно итерировать результат больше одного раза.
- Нужен `Count`, индексация или любая другая операция `IList<T>`.
- Планируется биндить результат в UI-контрол или сериализовать его в тело ответа, ожидающее материализованную коллекцию.

Стриминг выигрывает, когда результат большой, когда память важна, когда потребитель сам асинхронный (`PipeWriter`, `IBufferWriter<T>`, `Channel<T>`, шина сообщений) или когда задержка первого байта важнее общей пропускной способности.

## Быстрый чеклист по стримингу в EF Core 11

- `await foreach` прямо по `IQueryable<T>`. Никакого `ToListAsync`.
- Всегда `AsNoTracking()`, если нет конкретной причины не делать этого.
- Всегда `WithCancellation(ct)`.
- Используйте `IDbContextFactory<TContext>`, если нужен второй контекст для записей внутри цикла.
- Не оборачивайте потоковое чтение в длинную транзакцию.
- Не открывайте второй reader на том же контексте без MARS.
- Ожидайте, что первый `MoveNextAsync` вытащит ошибки трансляции и соединения.

## Связанное

- [Как правильно использовать records с EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/) хорошо сочетается с потоковым чтением, когда ваши сущности неизменяемые.
- [Одношаговые миграции EF Core 11 через `dotnet ef update add`](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) покрывает сторону инструментов того же релиза.
- [Стриминг задач с Task.WhenEach в .NET 9](/2026/01/streaming-tasks-with-net-9-task-wheneach/) для другого главного паттерна `IAsyncEnumerable<T>` в современном .NET.
- [HttpClient GetFromJsonAsAsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/) показывает тот же потоковый паттерн на стороне HTTP.
- [EF Core 11 preview 3 подрезает reference-джойны в split-запросах](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) для контекста производительности того же релиза.

## Источники

- [EF Core Async Queries, MS Learn](https://learn.microsoft.com/en-us/ef/core/miscellaneous/async).
- [Жизненный цикл и пулинг `DbContext`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/).
- [`IDbContextFactory<TContext>`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- [`AsyncEnumerableReader` в исходниках EF Core на GitHub](https://github.com/dotnet/efcore).
