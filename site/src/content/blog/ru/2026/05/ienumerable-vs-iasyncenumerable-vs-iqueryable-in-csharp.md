---
title: "IEnumerable vs IAsyncEnumerable vs IQueryable в C#: что должен возвращать метод?"
description: "Три интерфейса последовательностей, три модели выполнения. Используйте IQueryable, когда база данных может транслировать запрос, IAsyncEnumerable, когда производитель асинхронный и вам нужна потоковая передача, IEnumerable для всего остального в памяти."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "linq"
  - "ef-core"
  - "async"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-21
---

Если вы выбираете между `IEnumerable<T>`, `IAsyncEnumerable<T>` и `IQueryable<T>` для сигнатуры метода в C# 14 / .NET 11, правило почти механическое. Возвращайте `IQueryable<T>` только тогда, когда потребитель может скомпоновать дополнительные вызовы `Where`/`Select`/`OrderBy` и нижележащий провайдер (EF Core 11, LINQ to SQL, клиент OData) может транслировать их в удалённый запрос. Возвращайте `IAsyncEnumerable<T>`, когда производитель выполняет ввод-вывод на элемент или на пакет и вы хотите, чтобы потребитель начал обрабатывать данные до того, как производитель закончит. Возвращайте `IEnumerable<T>` для всего, что уже находится в памяти, или что вы решили полностью материализовать на границе. Ошибка, которой нужно избегать, -- это утечка `IQueryable<T>` за пределы репозитория: каждый последующий `.Where(...)` становится частью SQL, хотите вы того или нет, и "где этот запрос на самом деле выполняется" становится вопросом, на который вам придётся отвечать с помощью отладчика.

Эта публикация -- длинная версия. Все примеры нацелены на `<TargetFramework>net11.0</TargetFramework>` с `<LangVersion>14.0</LangVersion>` и, где применимо, `Microsoft.EntityFrameworkCore 11.0.0`.

## Три интерфейса, три модели выполнения

На бумаге эти три интерфейса выглядят похожими. Все они представляют собой одну последовательность `T`. Разница в том, где выполняется работа и когда.

- `IEnumerable<T>` -- синхронная последовательность с моделью pull. `MoveNext` выполняется в вызывающем потоке. Производителем является метод, который порождает элементы, `List<T>`, `T[]` или цепочка LINQ to Objects. Производитель не может ничего ожидать с `await`.
- `IAsyncEnumerable<T>` -- асинхронная последовательность с моделью pull. `MoveNextAsync` возвращает `ValueTask<bool>`, что позволяет производителю ожидать между элементами. Потребитель итерирует с помощью `await foreach`. Введён в C# 8 / .NET Core 3.0; первоклассный в современном LINQ через пакет `System.Linq.Async` и `AsAsyncEnumerable` в EF Core.
- `IQueryable<T>` -- построитель дерева выражений. Каждый `Where`, `Select` или `OrderBy`, который вы цепляете к `IQueryable<T>`, добавляет узел в дерево выражений. Дерево транслируется во что-то исполняемое (SQL-инструкцию, URL OData, запрос Cosmos) только когда вы вызываете терминальный оператор (`ToList`, `FirstOrDefault`, `Count`, `ToListAsync`). До этого никакого ввода-вывода не происходит.

Самое важное следствие: `IEnumerable<T>`, возвращённый вызовом EF Core, уже покинул базу данных. `IQueryable<T>`, возвращённый тем же вызовом, -- нет. Этот единственный факт ответственен за большее количество тикетов "почему этот запрос медленный", чем любая другая отдельная причина в коде EF Core.

## Матрица возможностей

| Возможность                                     | `IEnumerable<T>`         | `IAsyncEnumerable<T>`        | `IQueryable<T>`                     |
| ----------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------------- |
| Модель выполнения                               | синхронный pull          | асинхронный pull             | отложенная, транслируется провайдером|
| Где выполняется работа                          | вызывающий поток, в памяти| на стороне производителя, awaitable | удалённый провайдер (БД, OData, Cosmos) |
| Может использовать `await` между элементами     | нет                      | да                           | н/д (нет работы на элемент)         |
| Доступные операторы LINQ                        | LINQ to Objects          | LINQ to Objects (Async)      | специфичное для провайдера подмножество |
| Компонуется после возврата                      | да (в памяти)            | да (в памяти)                | да (транслируется удалённо)         |
| Потоковая передача без буферизации              | да (ленивый `yield return`)| да                         | зависит от провайдера               |
| Отмена                                          | нет, цикл синхронный     | `CancellationToken` на элемент| на запрос через `ToListAsync(token)`|
| Риск при возврате из репозитория                | низкий                   | средний (время жизни провайдера)| высокий (вызывающий может добавить SQL) |
| Лучше всего подходит                            | коллекции в памяти       | удалённые потоки, server-sent| внутренние объекты запроса репозитория |
| Материализуется при                             | каждом `MoveNext`        | каждом `await MoveNextAsync` | терминальном операторе              |

Матрица -- это и есть публикация. Всё ниже -- обоснование.

## Когда `IEnumerable<T>` -- правильный тип возврата

`IEnumerable<T>` -- значение по умолчанию для "у меня есть элементы, дай мне последовательность". Он синхронный, имеет все операторы LINQ to Objects и дёшево компонуется. Используйте его для:

- Метода, который порождает элементы из коллекции в памяти или чистого вычисления.
- Метода, который уже материализовал данные и теперь возвращает представление над ними (`return list.Where(x => x.IsActive);`).
- Метода, который обходит синхронный источник, например файл, который вы читаете с помощью `File.ReadLines`, или десериализованный DOM.

Ловушка -- использовать `IEnumerable<T>` как тип возврата метода репозитория, который оборачивает асинхронный вызов ввода-вывода. Это заставляет репозиторий делать `.ToList()` внутри и терять свойство потоковости, либо заставляет вызывающего использовать `.Result` и блокировку пула потоков. И то, и другое -- неправильно. Если источник асинхронный, сигнатурой должна быть `IAsyncEnumerable<T>` или `Task<List<T>>`, а не `IEnumerable<T>`.

```csharp
// .NET 11, C# 14
public static IEnumerable<string> ReadLowercaseLines(string path)
{
    foreach (var line in File.ReadLines(path))
    {
        yield return line.ToLowerInvariant();
    }
}
```

`File.ReadLines` возвращает `IEnumerable<string>`, который лениво читает файл. Преобразование остаётся ленивым. Ничто не заставляет файл полностью загружаться до того, как первый элемент достигнет вызывающего.

Ключевое слово `yield return` -- то, что заставляет это работать. Оно сообщает компилятору сгенерировать машину состояний, которая возвращает элементы по одному, приостанавливая метод между yield. Это синхронное зеркало `await foreach` плюс `yield return` вместе.

## Когда `IAsyncEnumerable<T>` -- правильный тип возврата

`IAsyncEnumerable<T>` -- то, к чему вы прибегаете, когда производителю нужно ожидать с `await` между элементами. Кардинальный пример -- HTTP-эндпоинт с пагинацией: вы извлекаете страницу 1, выдаёте каждый элемент, извлекаете страницу 2, выдаёте каждый элемент. Вы хотите, чтобы потребитель начал работу на странице 1, пока страница 2 ещё в пути. Вы также хотите, чтобы `CancellationToken` был проброшен, чтобы потребитель мог чисто остановить производителя.

Используйте его для:

- Удалённых источников с пагинацией (HTTP API, возвращающие страницы, Server-Sent Events, потребители очередей сообщений).
- Запросов EF Core 11, которые потоково передают результаты в CSV или в другой HTTP-ответ без материализации в памяти.
- Любого производителя, где важно противодавление: потребитель читает, обрабатывает и только потом запрашивает следующий элемент.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<Order> FetchAllAsync(
    HttpClient http,
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    string? next = "/api/orders?page=1";
    while (next is not null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = await http.GetFromJsonAsync<PageOf<Order>>(next, cancellationToken)
                   ?? throw new InvalidOperationException("page was null");
        foreach (var order in page.Items)
        {
            yield return order;
        }
        next = page.NextLink;
    }
}
```

Две детали, на которых люди спотыкаются. Во-первых, `[EnumeratorCancellation]` обязателен, чтобы проводить токен из `WithCancellation(...)` в месте вызова в итератор. Без него вызов `await foreach (var x in source.WithCancellation(token))` молча отбрасывает токен. Во-вторых, асинхронный итератор-метод не может использовать `try/catch` вокруг `yield return` для исключения, приходящего из нижестоящего оператора; исключение проходит через потребителя, а не через производителя. Оборачивайте вызовы ввода-вывода явно, когда вам нужна логика повторных попыток.

Для EF Core 11 эквивалент на `DbSet<T>` -- `AsAsyncEnumerable`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
await foreach (var order in db.Orders
    .Where(o => o.Status == "shipped")
    .AsAsyncEnumerable()
    .WithCancellation(cancellationToken))
{
    await sink.WriteAsync(order, cancellationToken);
}
```

Это сохраняет SQL-датаридер открытым и подтягивает строки по запросу. Полный набор никогда не оказывается в `List<Order>`. Подробности по EF Core см. в [как использовать IAsyncEnumerable с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

## Когда `IQueryable<T>` -- правильный тип возврата

`IQueryable<T>` -- правильная форма внутри репозитория или вспомогательного класса построения запросов, где от вызывающего всё ещё ожидается, что он будет компоновать. Это неправильная форма за сетевой границей или из слоя, который следующий вызывающий может не понять.

Используйте его для:

- Расширения `Queryable`, которое принимает существующий `IQueryable<T>` и добавляет условие `Where`: `q.WhereActive()`. Провайдер транслирует предикат; вы никогда не запускаете на материализованных данных.
- Метода репозитория, который выставляет узкий, специфичный для проекта запрос, который вызывающий будет далее фильтровать, разбивать на страницы или подсчитывать: `IQueryable<Invoice> Unpaid(int customerId)`.
- API библиотеки, где от потребителя ожидается построение выражений, например контроллер OData или собственный DSL поиска.

Шаблон, который кусается, -- выставлять `IQueryable<T>` из сервисного слоя, который вызывающий считает возвращающим данные в памяти:

```csharp
// Антишаблон: не возвращайте IQueryable<T> из публичного сервиса
public IQueryable<Order> GetRecentOrders() => _db.Orders.Where(o => o.At > _start);

// Вызывающий, в километрах отсюда
var bad = service.GetRecentOrders()
                 .Where(o => SomeLocalMethod(o))   // EF Core бросает: не транслируется
                 .OrderBy(o => o.Total)
                 .Take(50)
                 .ToList();
```

`SomeLocalMethod` -- это метод C#, который EF Core не может транслировать. Вызов `Where` добавляет выражение, которое провайдер не может опустить до SQL, и при материализации вы получаете исключение. Или хуже: в провайдере, который молча откатывается к вычислению на клиенте, вы случайно вытягиваете все строки по сети, чтобы фильтровать в процессе. EF Core 11 бросает по умолчанию; более старый код с вставленными в середину цепочки переключениями `AsEnumerable` ещё труднее читать.

Исправление -- материализовать на границе:

```csharp
// .NET 11, C# 14
public async Task<IReadOnlyList<Order>> GetRecentOrdersAsync(
    int count, CancellationToken ct)
{
    return await _db.Orders
        .Where(o => o.At > _start)
        .OrderByDescending(o => o.At)
        .Take(count)
        .ToListAsync(ct);
}
```

Метод теперь возвращает конкретную, материализованную коллекцию. Вызывающий не может случайно добавить SQL. Если вызывающий хочет другой фильтр, он явно просит его через параметр или новый метод. Это та же логика, которая стоит за [как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): будьте явны в том, где находится граница запроса.

## Бенчмарк: потоковая передача миллиона строк тремя способами

Реальное число. Настройка: 1 000 000 узких строк (`Guid Id`, `int Status`, `DateTime At`) в SQL Server 2022. Потребитель считает строки, проходящие фильтр (`Status == 1`), и записывает сумму временных меток. Делаем это тремя способами:

- `IEnumerable<T>`, произведённый через `ToList()` и затем перечисленный.
- `IAsyncEnumerable<T>`, произведённый через `AsAsyncEnumerable()`.
- `IQueryable<T>`, потребляемый внутри того же метода через `await Where(...).CountAsync()`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, BenchmarkDotNet 0.14.0
[MemoryDiagnoser]
public class SequenceShapes
{
    private AppDb _db = null!;

    [GlobalSetup] public void Setup() => _db = AppDb.Connect();

    [Benchmark]
    public long Materialize_Then_Enumerate()
    {
        var rows = _db.Events.ToList();              // pull all 1,000,000
        long sum = 0; long count = 0;
        foreach (var r in rows)
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark]
    public async Task<long> StreamAsync()
    {
        long sum = 0; long count = 0;
        await foreach (var r in _db.Events.AsAsyncEnumerable())
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark(Baseline = true)]
    public async Task<long> Queryable_Aggregate()
    {
        var count = await _db.Events.Where(e => e.Status == 1).CountAsync();
        var sum   = await _db.Events.Where(e => e.Status == 1)
                                    .SumAsync(e => (long)e.At.Ticks);
        return sum + count;
    }
}
```

Методика: BenchmarkDotNet 0.14.0, .NET 11.0.0 RTM, EF Core 11.0.0, SQL Server 2022 16.0.4135 на той же машине через loopback. Windows 11 24H2, AMD Ryzen 9 7900X, 64 ГБ DDR5. Числа -- из одного репрезентативного запуска.

| Метод                           | Среднее      | Выделено    |
| ------------------------------- | ------------ | ----------- |
| Queryable_Aggregate (baseline)  | 38 ms        | 1.4 KB      |
| StreamAsync                     | 1,210 ms     | 410 MB      |
| Materialize_Then_Enumerate      | 1,380 ms     | 432 MB      |

Шаблон согласуется с тем, как работают три интерфейса. `IQueryable<T>` позволяет базе данных сделать подсчёт и суммирование и отправить обратно два скаляра. `IAsyncEnumerable<T>` экономит вам около 12 процентов общего времени по сравнению с `ToList`-и-цикл, и экономит профиль памяти в форме пика (выделение `List<Event>` в `Materialize_Then_Enumerate` видно в `dotnet-counters` как одиночный пик `gen2`). Но обе проигрывают queryable-форме в 30 раз, потому что работа принадлежала базе данных, а не клиенту.

Вывод не "всегда используйте IQueryable". Он таков: если операция может быть выражена на языке запросов провайдера, не вытаскивайте строки. Если вам нужно вытащить строки (экспорт в CSV, преобразование, которое не транслируется, нижестоящий сервис, который хочет отдельные элементы), предпочитайте `IAsyncEnumerable<T>` материализованному `IEnumerable<T>`.

## Подводные камни, которые решают за вас

Несколько вещей принимают решение за вас независимо от предпочтений.

- **`IQueryable<T>` требует живого провайдера.** Возврат `IQueryable<T>` из метода, у которого `DbContext` уничтожается при возврате метода, -- это замаскированный use-after-free. Дерево выражений всё ещё существует, но в момент материализации вызывающим вылетает `ObjectDisposedException`. Либо держите контекст живым на время жизни queryable, либо материализуйте перед возвратом.

- **`IAsyncEnumerable<T>` требует `[EnumeratorCancellation]`.** Без него токен отмены, который вызывающий передаёт через `.WithCancellation(token)`, никогда не достигает производителя. Компилятор вас не предупредит; баг тихий, и токен игнорируется. Анализатор Roslyn `CA1068` ловит отсутствующий параметр; `CA2016` ловит отсутствующую передачу токена в асинхронные вызовы внутри.

- **Операторы LINQ различаются.** `Skip`, `Take`, `OrderBy`, `Select`, `Where`, `First`, `Count` существуют у всех трёх. Но `IAsyncEnumerable<T>` нуждается в пакете `System.Linq.Async` для `WhereAsync`, `SelectAwait`, `SelectMany`, `GroupBy` и сопутствующих. `IQueryable<T>` поддерживает только подмножество, которое его провайдер может транслировать; всё остальное либо бросает (EF Core 11), либо молча откатывается к вычислению на клиенте (некоторые более старые провайдеры).

- **`IQueryable<T>` течёт модель персистентности.** Если вызывающий может написать `.Where(...)`, вызывающий пишет SQL. Переименование имени колонки в сущности становится изменением "ищи по всей кодовой базе", потому что каждый queryable-потребитель касается этой колонки. Репозиторий, возвращающий материализованные DTO, скрывает схему; тот, что возвращает `IQueryable<Entity>`, -- нет.

- **Смешивание их в цепочке.** Вызов `.AsEnumerable()` или `.AsAsyncEnumerable()` в середине цепочки `IQueryable<T>` конвертирует остаток в вычисление в памяти. Каждый `Where` после этой точки выполняется на клиенте. Иногда это то, чего вы хотите (сложный предикат, который не транслируется); часто это баг производительности. Сделайте переключение явным и поставьте рядом комментарий.

- **`yield return` внутри `using` -- это нормально, но ресурс живёт столько, сколько живёт итератор.** Синхронный итератор, который открывает `FileStream` и порождает строки, держит файл открытым, пока потребитель не освободит перечислитель или не закончит итерацию. То же самое применяется, с худшими режимами отказа, к асинхронным итераторам, которые держат `DbDataReader`. Всегда итерируйте до конца или вызывайте `await foreach` внутри блока using/awaiting.

## Мнение, переформулированное

По умолчанию -- `IEnumerable<T>` для работы в памяти. Прибегайте к `IAsyncEnumerable<T>` в тот момент, когда производителю нужен `await`, и проводите `[EnumeratorCancellation]` с первого дня. Держите `IQueryable<T>` внутри слоя репозитория или построителя запросов; конвертируйте в материализованный `IReadOnlyList<T>` или в `IAsyncEnumerable<T>` перед пересечением сервисной границы.

Два следствия, которые стоит закрепить в мышечной памяти:

- "Возвращайте минимальную мощность, которая нужна вызывающему". Метод, который концептуально возвращает список, должен возвращать `IReadOnlyList<T>`, а не `IQueryable<T>`. Мощность, которая не нужна вызывающему, -- это мощность, которой вызывающий может злоупотребить.
- "Материализация -- это граница". Решите, где она происходит, один раз, в одном месте, и пишите остаток слоя под этот контракт. Кодовые базы, где каждый метод возвращает `IQueryable<T>` "на всякий случай", заканчиваются разбросанными случайным образом вызовами `.ToList()` и бюджетом медленных запросов, которым никто не владеет.

## Связанные материалы

- [Как использовать IAsyncEnumerable с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [EF Core 11 vs Dapper для массовых вставок: реальный бенчмарк](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Как использовать скомпилированные запросы с EF Core на горячих путях](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Как потоково передать файл из эндпоинта ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Источники

- [IQueryable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.linq.iqueryable-1)
- [IAsyncEnumerable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1)
- [Generate asynchronous streams (async iterators) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream)
- [EnumeratorCancellationAttribute -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Client vs server evaluation -- EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [System.Linq.Async on NuGet](https://www.nuget.org/packages/System.Linq.Async)
