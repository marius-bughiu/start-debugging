---
title: "Как использовать Channels вместо BlockingCollection в C#"
description: "System.Threading.Channels это асинхронная замена BlockingCollection в .NET 11. В руководстве показано, как мигрировать, как выбирать между ограниченным и неограниченным каналом, и как обрабатывать backpressure, отмену и корректное завершение без deadlock-ов."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
  - "async"
lang: "ru"
translationOf: "2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Если у вас есть `BlockingCollection<T>` в приложении .NET, написанном до .NET Core 3.0, современная замена это `System.Threading.Channels`. Замените `new BlockingCollection<T>(capacity)` на `Channel.CreateBounded<T>(capacity)`, замените `Add` / `Take` на `await WriteAsync` / `await ReadAsync`, и вызывайте `channel.Writer.Complete()` вместо `CompleteAdding()`. Потребители итерируют через `await foreach (var item in channel.Reader.ReadAllAsync(ct))` вместо `foreach (var item in collection.GetConsumingEnumerable(ct))`. Всё остаётся потокобезопасным, ни один поток не блокируется в ожидании элементов, а backpressure работает через `await`, а не через парковку рабочего потока.

Это руководство ориентировано на .NET 11 (preview 3) и C# 14, но `System.Threading.Channels` это стабильный встроенный API, начиная с .NET Core 3.0, и он также доступен в .NET Standard 2.0 через [NuGet-пакет `System.Threading.Channels`](https://www.nuget.org/packages/System.Threading.Channels). Ничего из описанного не является эксклюзивом preview-версии.

## Почему BlockingCollection больше не подходит

`BlockingCollection<T>` появился в .NET Framework 4.0 в 2010 году. Его дизайн исходил из мира, где один поток на потребителя был дешёвым, а async/await ещё не существовал. `Take()` паркует вызывающий поток на ядерном примитиве синхронизации до тех пор, пока не появится элемент; `Add()` делает то же самое, когда ограниченная ёмкость заполнена. В консольном приложении, обрабатывающем 10 элементов в секунду, это нормально. В endpoint-е ASP.NET Core, в worker-сервисе или в любом коде, работающем под давлением `ThreadPool`, каждый заблокированный потребитель выводит поток из обращения. Двадцать потребителей, заблокированных на `Take()`, это двадцать потоков, которые runtime не может использовать ни для чего другого, и эвристика hill-climbing thread pool отвечает порождением новых потоков, которые сами по себе дороги (около 1 МБ стека на каждый в Windows по умолчанию).

`System.Threading.Channels` был добавлен в .NET Core 3.0 именно для устранения этих затрат. Потребитель, ожидающий в `ReadAsync`, вообще не удерживает поток: продолжение ставится в очередь thread pool только тогда, когда элемент действительно записан. Это тот же паттерн асинхронной машины состояний, на котором работают `Task` и `ValueTask`, и именно поэтому один процесс ASP.NET Core может содержать десятки тысяч одновременных потребителей канала, не исчерпав thread pool. Официальное [введение в channels](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/) в Microsoft .NET Blog даёт явную рекомендацию: используйте channels для любого нового паттерна producer-consumer, который касается I/O, и оставьте `BlockingCollection<T>` для синхронных, CPU-bound сценариев, где блокировка потока действительно приемлема.

Также есть измеримая разница в throughput. Собственные бенчмарки Microsoft и несколько независимых сравнений (см. [сравнение производительности producer/consumer от Michael Shpilt](https://michaelscodingspot.com/performance-of-producer-consumer/)) показывают, что `Channel<T>` примерно в 4 раза превосходит `BlockingCollection<T>` по throughput для типичных размеров сообщений, потому что канал использует lock-free операции `Interlocked` на быстром пути и избегает переходов в ядро, которые требует `BlockingCollection`.

## Минимальное воспроизведение паттерна BlockingCollection

Вот канонический setup `BlockingCollection<T>`, которому следует большинство legacy-кода. Используется ограниченная ёмкость (чтобы продюсеры дросселировали, когда потребители отстают), `CancellationToken` и `CompleteAdding`, чтобы потребители корректно завершались.

```csharp
// .NET 11, C# 14 -- legacy pattern, do not write new code like this
using System.Collections.Concurrent;

var queue = new BlockingCollection<int>(boundedCapacity: 100);
using var cts = new CancellationTokenSource();

var producer = Task.Run(() =>
{
    for (int i = 0; i < 10_000; i++)
        queue.Add(i, cts.Token);

    queue.CompleteAdding();
});

var consumer = Task.Run(() =>
{
    foreach (int item in queue.GetConsumingEnumerable(cts.Token))
        Process(item);
});

await Task.WhenAll(producer, consumer);

static void Process(int item) { /* work */ }
```

Два потока остаются занятыми на всё время жизни этого pipeline. Если `Process` делает I/O, поток потребителя простаивает во время каждого ожидания, эквивалентного `await`, и канал может справиться лучше. Если масштабироваться до четырёх продюсеров и восьми потребителей, это уже двенадцать занятых потоков.

## Эквивалент на Channels

Вот тот же pipeline с использованием `System.Threading.Channels`. Форма кода похожа; разница в том, что ни один поток не блокируется.

```csharp
// .NET 11, C# 14 -- modern replacement
using System.Threading.Channels;

var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(100)
{
    FullMode = BoundedChannelFullMode.Wait,
    SingleReader = false,
    SingleWriter = false
});

using var cts = new CancellationTokenSource();

var producer = Task.Run(async () =>
{
    for (int i = 0; i < 10_000; i++)
        await channel.Writer.WriteAsync(i, cts.Token);

    channel.Writer.Complete();
});

var consumer = Task.Run(async () =>
{
    await foreach (int item in channel.Reader.ReadAllAsync(cts.Token))
        await ProcessAsync(item);
});

await Task.WhenAll(producer, consumer);

static ValueTask ProcessAsync(int item) => ValueTask.CompletedTask;
```

Стоит сразу указать на три отличия. `WriteAsync` возвращает `ValueTask` вместо блокировки, когда буфер полон: продолжение продюсера возобновляется только когда появляется место. `ReadAllAsync` возвращает `IAsyncEnumerable<T>`, который завершается при вызове `Writer.Complete()`, в точности отражая поведение `GetConsumingEnumerable` после `CompleteAdding`. И `Channel.CreateBounded` требует явного указания `FullMode`, что заставляет принять решение, которое `BlockingCollection` молча принимал за вас (всегда блокировал).

## Ограниченный или неограниченный: выбирайте осознанно

`Channel.CreateBounded(capacity)` имеет жёсткий верхний предел на буферизованные элементы и применяет backpressure к продюсерам, когда буфер полон. `Channel.CreateUnbounded()` не имеет верхнего предела, поэтому записи завершаются синхронно и никогда не ждут. Неограниченные каналы соблазнительны, потому что выглядят быстрее в микробенчмарке, но это утечка памяти, ожидающая случиться: если ваш потребитель отстанет хотя бы на несколько секунд в pipeline с высоким throughput, канал с радостью буферизует гигабайты рабочих элементов до того, как кто-то это заметит. По умолчанию используйте `CreateBounded`. Прибегайте к `CreateUnbounded` только тогда, когда можете доказать, что потребитель быстрее продюсера, или когда скорость продюсера ограничена чем-то ещё (например, приёмником webhook, throughput которого ограничен upstream-отправителем).

`BoundedChannelFullMode` управляет тем, что происходит, когда ограниченный канал полон и продюсер вызывает `WriteAsync`. Четыре варианта:

- `Wait` (по умолчанию): `ValueTask` продюсера не завершается до появления свободного места. Это прямой эквивалент блокирующего поведения `BlockingCollection.Add` и правильный выбор по умолчанию.
- `DropOldest`: самый старый элемент в буфере удаляется, чтобы освободить место. Используйте для телеметрии, где устаревшие данные хуже отсутствующих.
- `DropNewest`: самый новый элемент уже в буфере удаляется. Редко полезно.
- `DropWrite`: новый элемент молча отбрасывается. Используйте для fire-and-forget-логирования, где отбросить новую запись дешевле, чем применить backpressure к продюсеру.

Если вы выбираете `DropOldest` / `DropNewest` / `DropWrite`, `WriteAsync` всегда завершается синхронно, поэтому продюсер никогда не дросселируется. Смешивание этих режимов с ожиданием "я хочу backpressure" частая причина багов. `Wait` единственный режим, который реально применяет backpressure.

## Миграция существующего pipeline BlockingCollection

Большая часть кода на BlockingCollection переводится механически. Таблица перевода:

- `new BlockingCollection<T>(capacity)` -> `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait })`
- `new BlockingCollection<T>()` (неограниченный) -> `Channel.CreateUnbounded<T>()`
- `collection.Add(item, token)` -> `await channel.Writer.WriteAsync(item, token)`
- `collection.TryAdd(item)` -> `channel.Writer.TryWrite(item)` (возвращает `bool`, никогда не блокирует)
- `collection.Take(token)` -> `await channel.Reader.ReadAsync(token)`
- `collection.TryTake(out var item)` -> `channel.Reader.TryRead(out var item)`
- `collection.GetConsumingEnumerable(token)` -> `channel.Reader.ReadAllAsync(token)` (с `await foreach`)
- `collection.CompleteAdding()` -> `channel.Writer.Complete()` (или `Complete(exception)`, чтобы сигнализировать о сбое)
- `collection.IsCompleted` -> `channel.Reader.Completion.IsCompleted`
- `BlockingCollection.AddToAny / TakeFromAny` -> прямого эквивалента нет, см. "подводные камни" ниже

Не блокирующие `TryWrite` и `TryRead` критичны для одного конкретного сценария: синхронных путей кода, в которые нельзя ввести `await`. Они возвращают `false` вместо ожидания, и вы можете опрашивать или переходить на другой путь. Большинству кода они не нужны; предпочитайте асинхронные формы.

Если ваши продюсеры работают на thread pool и канал горячий, возможно, вы захотите установить `SingleWriter = true` (или `SingleReader = true`). Channels используют другую, более быструю внутреннюю реализацию, когда знают, что есть ровно один продюсер или потребитель. Проверка только оппортунистическая: runtime её не принуждает, поэтому устанавливайте этот флаг честно. Если установить `SingleWriter = true` и затем случайно иметь двух продюсеров, `WriteAsync` будет вести себя некорректно тонкими способами (потерянные элементы, сломанная completion).

## Backpressure, отмена и корректное завершение

Backpressure работает через `ValueTask` от `WriteAsync`. Когда буфер полон, задача продюсера не завершена до тех пор, пока потребитель не прочитает элемент, и в этот момент один ожидающий писатель освобождается. По форме это семафор, но семантика привязана к состоянию буфера, а не к отдельному счётчику.

Отмена распространяется так же, как в любом асинхронном API. Передавайте `CancellationToken` в `WriteAsync`, `ReadAsync` и `ReadAllAsync`. Когда токен срабатывает, выполняющийся `ValueTask` бросает `OperationCanceledException`. Сам канал токеном не отменяется: другие продюсеры и потребители, не передавшие этот токен, продолжают работать нормально. Если хотите отменить весь pipeline, вызовите `channel.Writer.Complete()` (или `Complete(exception)`), что сигнализирует всем текущим и будущим читателям, что данных больше не будет. См. [как отменить долго выполняющийся Task в C# без deadlock-ов](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) для более общего паттерна.

Корректное завершение в worker-сервисе выглядит так:

```csharp
// .NET 11, C# 14
public class ImportWorker : BackgroundService
{
    private readonly Channel<ImportJob> _channel =
        Channel.CreateBounded<ImportJob>(new BoundedChannelOptions(500)
        {
            FullMode = BoundedChannelFullMode.Wait
        });

    public ChannelWriter<ImportJob> Writer => _channel.Writer;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(stoppingToken))
                await ProcessAsync(job, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // expected on host shutdown
        }
        finally
        {
            _channel.Writer.TryComplete();
        }
    }

    private static ValueTask ProcessAsync(ImportJob job, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public record ImportJob(string Id);
```

Две заметки. `TryComplete` (вместо `Complete`) идемпотентен и безопасен для вызова из `finally`. Фильтр `OperationCanceledException` поглощает отмену только тогда, когда она действительно приходит от `stoppingToken`: отмена, инициированная другим токеном, всё равно распространяется, что и нужно.

Если ваши продюсеры могут падать, предпочитайте `channel.Writer.Complete(exception)`. Следующий вызов потребителя `ReadAsync` или `ReadAllAsync` повторно бросит это исключение, что является эквивалентом канала к тому, как `BlockingCollection.GetConsumingEnumerable` повторно бросает после вызова `CompleteAdding` следом за сбоем.

## Подводные камни, с которыми вы столкнётесь

`Channel.Writer.WriteAsync` возвращает `ValueTask`, а не `Task`. Если сохранить результат и await-ить его более одного раза, вы вызываете неопределённое поведение: `ValueTask` задокументирован как single-await. В 99% случаев это `await channel.Writer.WriteAsync(item)` инлайн; беспокоиться об этом стоит только если вы начинаете передавать возвращаемое значение куда-то ещё.

`Reader.Completion` это `Task`, который завершается, когда `Writer.Complete` вызван и все элементы вычерпаны. Если хотите узнать, когда канал полностью пуст и закрыт, await-ьте `Reader.Completion`. Не проверяйте `Reader.Count == 0`: это свойство существует, но конкурирует с записями в полёте.

`ChannelReader<T>.WaitToReadAsync` возвращает `false` только когда канал завершён и пуст. Это правильный примитив для самописных циклов потребителя, в которых `await foreach` не подходит, например потому, что вы хотите читать пакетами:

```csharp
// .NET 11, C# 14 -- batched consumer
while (await channel.Reader.WaitToReadAsync(ct))
{
    var batch = new List<int>(capacity: 100);
    while (batch.Count < 100 && channel.Reader.TryRead(out int item))
        batch.Add(item);

    if (batch.Count > 0)
        await ProcessBatchAsync(batch, ct);
}

static ValueTask ProcessBatchAsync(IReadOnlyList<int> items, CancellationToken ct)
    => ValueTask.CompletedTask;
```

У `BlockingCollection` были `AddToAny` и `TakeFromAny`, работавшие через несколько коллекций. У channels прямого эквивалента нет. Если вам действительно нужен fan-in между N каналами, идиоматический паттерн породить по одному потребительскому таску на исходный канал, и все они пишут в один общий downstream-канал; это чисто компонуется с моделью отмены и остаётся async-дружественным. Если вам действительно нужен fan-out (один продюсер кормит N потребителей), запустите N reader-task-ов против одного и того же `Reader`: channels безопасны для нескольких читателей, пока вы не установили `SingleReader = true`.

`System.Threading.Channels` это не сериализационный канал, как `chan` в Go, и не примитив распределённого messaging. Это исключительно in-process. Если вам нужен messaging между процессами или машинами, используйте настоящий брокер сообщений (Azure Service Bus, RabbitMQ, Kafka). Channels правильный инструмент внутри одного процесса; они неправильный инструмент в тот момент, когда в дело вступает сеть.

## Когда BlockingCollection ещё оправдан

Есть один узкий случай, когда сохранять `BlockingCollection<T>` разумно: синхронный CPU-bound пул воркеров внутри консольного приложения или batch-задания, где вы контролируете количество потоков и не беспокоитесь о давлении на thread pool, потому что давления на thread pool, о котором стоило бы беспокоиться, нет. [Обзор Channels на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) явно об этом говорит. Везде в других местах (ASP.NET Core, worker-сервисы, любой код, касающийся I/O, любой код, разделяемый с async-aware потребителями) предпочитайте `System.Threading.Channels`.

## Связанное

- [Как отменить долго выполняющийся Task в C# без deadlock-ов](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Как использовать IAsyncEnumerable&lt;T&gt; с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Как читать большой CSV в .NET 11, не исчерпав память](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Как стримить файл из endpoint-а ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Источники

- [An Introduction to System.Threading.Channels (Microsoft .NET Blog)](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/)
- [Channels overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)
- [BoundedChannelOptions class reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.channels.boundedchanneloptions)
- [Performance Showdown of Producer/Consumer Implementations in .NET (Michael Shpilt)](https://michaelscodingspot.com/performance-of-producer-consumer/)
- [System.Threading.Channels source on GitHub](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.Channels)
