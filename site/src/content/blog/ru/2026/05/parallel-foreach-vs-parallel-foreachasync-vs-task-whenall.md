---
title: "Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll в C#"
description: "Используйте Parallel.ForEach для нагружающей CPU работы над данными в памяти, Parallel.ForEachAsync для асинхронного ввода-вывода над множеством элементов с ограничением параллелизма, и Task.WhenAll для небольшого фиксированного fan-out, где нужно запустить все операции сразу и получить результаты."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "ru"
translationOf: "2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall"
translatedBy: "claude"
translationDate: 2026-05-25
---

Используйте `Parallel.ForEach`, когда работа нагружает CPU, а данные уже в памяти: хеширование 100 000 файлов, преобразование большого массива, всё, что загружает ядра. Используйте `Parallel.ForEachAsync`, когда каждый элемент запускает асинхронный ввод-вывод (HTTP-вызов, запрос к базе данных) и вы хотите ограничить число таких операций, выполняемых одновременно. Используйте `Task.WhenAll`, когда у вас небольшой фиксированный набор асинхронных операций, которые нужно запустить все сразу и собрать с них результаты. Единственная ошибка, которая решает за вас: никогда не выполняйте асинхронный ввод-вывод внутри `Parallel.ForEach`, потому что блокировка через `.Result` или `.Wait()` внутри его синхронного тела истощает пул потоков.

Эта статья ориентирована на .NET 11 и C# 14. `Parallel.ForEach` существует с .NET Framework 4.0 (2010); `Task.WhenAll` с .NET Framework 4.5; а `Parallel.ForEachAsync` новичок, добавленный в .NET 6 (2021). Описанное здесь поведение стабильно с .NET 6 по .NET 11.

## Эти три решают разные задачи

Сравнение неудобно, потому что эти три не являются взаимозаменяемыми API с разной производительностью. Это ответы на три разных вопроса.

`Parallel.ForEach` спрашивает: «У меня есть коллекция и синхронная, нагружающая CPU операция на каждый элемент. Распредели её по ядрам». Его тело это `Action<T>`. Он разбивает источник на части, выполняет тело на нескольких потоках пула потоков и блокирует вызывающий поток, пока каждый элемент не завершится. Это рабочая лошадка параллелизма данных из Task Parallel Library.

`Parallel.ForEachAsync` спрашивает: «У меня есть коллекция и асинхронная операция на каждый элемент. Выполни их параллельно, но ограничь, сколько работает одновременно». Его тело это `Func<TSource, CancellationToken, ValueTask>`. Он возвращает `Task`, которую вы ожидаете; он не блокирует. Важно: он ограничивает. По умолчанию он выполняет не более `Environment.ProcessorCount` операций параллельно, и вы можете задать это явно через `ParallelOptions.MaxDegreeOfParallelism`.

`Task.WhenAll` спрашивает: «У меня уже есть куча задач. Сообщи мне, когда все они завершатся». Он ничего не запускает, ничего не ограничивает и не итерирует источник. Вы создаёте задачи (что их запускает), передаёте коллекцию в `WhenAll` и ожидаете единственную задачу, которую он возвращает. Если вы запустите 5000 задач, все 5000 будут выполняться в момент, когда вы ожидаете.

Так что настоящее решение касается формы вашей работы, а не голой скорости: нагрузка на CPU над данными (`Parallel.ForEach`), асинхронный ввод-вывод над множеством элементов с потолком (`Parallel.ForEachAsync`) или известная горстка асинхронных операций, которые нужны все сразу и чьи результаты вам нужны (`Task.WhenAll`).

## Матрица решения

Поведение ниже относится к .NET 6+, если не указано иное; `Parallel.ForEachAsync` не существует до .NET 6.

| Возможность                         | `Parallel.ForEach`            | `Parallel.ForEachAsync`                       | `Task.WhenAll`                       |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ |
| Лучше для                           | нагружающей CPU работы        | асинхронного ввода-вывода на элемент          | фиксированного набора async-операций |
| Делегат тела                        | `Action<T>` (синхронный)      | `Func<T, CancellationToken, ValueTask>`       | вы создаёте задачи                   |
| Блокирует вызывающий поток          | да                            | нет (возвращает `Task`)                       | нет (возвращает `Task`)              |
| Встроенное ограничение параллелизма | да (`MaxDegreeOfParallelism`) | да (`MaxDegreeOfParallelism`)                 | нет -- все задачи сразу              |
| Степень параллелизма по умолчанию   | управляется планировщиком (`-1`) | `Environment.ProcessorCount`               | без ограничения                      |
| Возвращает результаты               | нет                           | нет (возвращает `Task`, не `Task<T[]>`)       | да (`Task<TResult[]>`, по порядку)   |
| Принимает `IAsyncEnumerable<T>`     | нет                           | да                                            | н/п                                  |
| Отмена                              | `ParallelOptions`             | `ParallelOptions` + токен, переданный в тело  | отменяйте базовые задачи сами        |
| При первом исключении               | прекращает запуск итераций    | отменяет токен, прекращает планировать элементы | даёт каждой задаче дойти до конца  |
| Поверхность исключений              | `AggregateException`          | `AggregateException` (await разворачивает до первого) | `AggregateException` (await разворачивает) |
| Впервые выпущен                     | .NET Framework 4.0            | .NET 6                                         | .NET Framework 4.5                   |

Строки, которые решают большинство реальных случаев, это «делегат тела» и «встроенное ограничение параллелизма». Если ваша работа на элемент `async`, то `Parallel.ForEach` уже неверен. Если вам нужно ограничить параллелизм, то `Task.WhenAll` уже неверен.

## Когда выбирать Parallel.ForEach

Обращайтесь к `Parallel.ForEach`, когда работа на элемент синхронная и нагружает CPU, а коллекция уже материализована в памяти.

- **Преобразование большого массива или списка в памяти.** Изменение размера 50 000 изображений, вычисление контрольных сумм, разбор строк. Работа держит ядро занятым, а разбиение источника по ядрам это именно то, для чего создан `Parallel.ForEach`. Задайте `MaxDegreeOfParallelism`, если хотите оставить запас для другой работы.
- **Позорно параллельные вычисления.** Симуляция Монте-Карло, фильтр на каждый пиксель, пакет независимых матричных операций. Без общего состояния, без ввода-вывода, только CPU.
- **Вы хотите, чтобы вызывающий поток ждал.** `Parallel.ForEach` синхронен по своей природе. В консольном инструменте или фоновом задании, где блокировка приемлема, эта простота является преимуществом.

```csharp
// .NET 11, C# 14 -- CPU-bound work over an in-memory array.
// Parallel.ForEach partitions across cores and blocks until done.
var files = Directory.GetFiles(@"C:\data", "*.bin");
var hashes = new ConcurrentDictionary<string, string>();

Parallel.ForEach(
    files,
    new ParallelOptions { MaxDegreeOfParallelism = Environment.ProcessorCount },
    file =>
    {
        using var stream = File.OpenRead(file);
        byte[] hash = SHA256.HashData(stream);   // CPU + sync I/O, no await
        hashes[file] = Convert.ToHexString(hash);
    });
```

Жёсткое правило: если тело хочет что-то ожидать через `await`, не обращайтесь к `Parallel.ForEach`. Люди обходят синхронный `Action<T>`, записывая `SomeAsyncCall().Result` или `.GetAwaiter().GetResult()` внутри тела. Это блокирует поток пула потоков на всю длительность ввода-вывода, а поскольку `Parallel.ForEach` уже потребляет потоки пула для выполнения итераций, под нагрузкой вы можете вызвать взаимную блокировку или истощить пул. Этот антипаттерн самая частая причина, по которой существует `Parallel.ForEachAsync`.

## Когда выбирать Parallel.ForEachAsync

`Parallel.ForEachAsync` это ответ на «у меня много элементов, и каждый вызывает что-то асинхронное, и я не хочу открывать десять тысяч соединений сразу».

- **Вызов HTTP API для каждого из многих элементов.** Обогащение 8000 записей из REST-эндпоинта, где одновременная отправка всех 8000 запросов привела бы к ограничению по частоте или исчерпанию сокетов. Задайте `MaxDegreeOfParallelism = 20`, и он держит 20 запросов в работе, запуская следующий по мере завершения каждого.
- **Работа на элемент с базой данных или очередью с потолком.** Пул соединений имеет конечный размер. `Parallel.ForEachAsync` позволяет согласовать степень параллелизма с пулом, чтобы не блокироваться в ожидании соединений.
- **Потоковый источник.** Он принимает `IAsyncEnumerable<T>`, так что вы можете обрабатывать элементы по мере их поступления из постраничного API или канала, не буферизуя всю последовательность заранее.

```csharp
// .NET 11, C# 14 -- async I/O per item, capped at 20 concurrent calls.
var ids = await db.Products.Select(p => p.Id).ToListAsync(ct);
var client = httpClientFactory.CreateClient("pricing");

await Parallel.ForEachAsync(
    ids,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 20,
        CancellationToken = ct
    },
    async (id, token) =>
    {
        var price = await client.GetFromJsonAsync<Price>($"/price/{id}", token);
        await SavePriceAsync(id, price, token);   // never blocks a pool thread
    });
```

Две важные детали. Во-первых, тело получает `CancellationToken` вторым параметром: передавайте его в каждый асинхронный вызов внутри, а не внешний `ct`, потому что `Parallel.ForEachAsync` отменяет этот внутренний токен, когда одна итерация падает, чтобы остальные могли быстро прерваться. Во-вторых, `MaxDegreeOfParallelism` по умолчанию равен `Environment.ProcessorCount`, что настроено на работу CPU, а не ввода-вывода. Для вызовов с вводом-выводом вы почти всегда захотите задать его выше числа ядер, потому что потоки большую часть времени ждут сеть, а не вычисляют. Если вам нужен более тонкий контроль, чем одно целочисленное ограничение, то [шлюз на основе SemaphoreSlim](/ru/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) в сочетании с `Task.WhenAll` даёт то же ограничение с большей гибкостью менять предел для каждого вызова.

## Когда выбирать Task.WhenAll

`Task.WhenAll` для известного, обычно небольшого набора асинхронных операций, которые вы хотите выполнить параллельно и чьи результаты вам нужны обратно.

- **Фиксированный fan-out.** Загрузить профиль пользователя, его заказы и его уведомления параллельно: три независимых await, которые должны перекрываться. Запустите все три, `await Task.WhenAll`, готово. Это повседневное использование, и оно правильное.
- **Вам нужны результаты, по порядку.** Обобщённая перегрузка возвращает `Task<TResult[]>`, и массив сохраняет порядок входа независимо от порядка завершения. `Parallel.ForEachAsync` возвращает простую `Task` без результатов, так что если вам нужен результат на элемент, путь это `WhenAll` (или сбор в потокобезопасную структуру).
- **Количество ограничено и невелико.** Дюжина вызовов, а не десять тысяч. Поскольку `WhenAll` не делает никакого ограничения, число параллельных операций равно числу запущенных вами задач.

```csharp
// .NET 11, C# 14 -- a small, fixed fan-out; results returned in order.
Task<Profile> profile = LoadProfileAsync(userId, ct);
Task<Order[]> orders = LoadOrdersAsync(userId, ct);
Task<Alert[]> alerts = LoadAlertsAsync(userId, ct);

await Task.WhenAll(profile, orders, alerts);

// Each task is complete here; .Result no longer blocks.
var dashboard = new Dashboard(profile.Result, orders.Result, alerts.Result);
```

Ловушка с `Task.WhenAll` это использовать его для неограниченного списка. `Task.WhenAll(ids.Select(id => CallApiAsync(id)))` над 10 000 id запускает все 10 000 вызовов в момент перечисления LINQ, потому что `Select` материализует задачи, и каждая задача запускается при создании. Это атака отказа в обслуживании против вашего собственного нижестоящего сервиса. Как только список становится большим или неограниченным, вам нужен `Parallel.ForEachAsync` (или шлюз `SemaphoreSlim`) вместо этого.

## Бенчмарк: 500 имитированных вызовов ввода-вывода

Голая скорость здесь обманчивая ось, потому что самый быстрый вариант обычно самый опасный. Честное сравнение это скорость против пикового параллелизма. Каждый «элемент» ниже ожидает `Task.Delay(20)`, чтобы изобразить сетевой вызов в 20 мс, выполнено над 500 элементами.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x, dotnet run -c Release
// Each item simulates a 20 ms I/O call.
[MemoryDiagnoser]
public class FanOutBench
{
    private readonly int[] _items = Enumerable.Range(0, 500).ToArray();
    private static Task IoAsync(CancellationToken ct = default) => Task.Delay(20, ct);

    [Benchmark]
    public Task WhenAll_Unbounded() =>
        Task.WhenAll(_items.Select(_ => IoAsync()));

    [Benchmark]
    public Task ForEachAsync_DefaultDop() =>
        Parallel.ForEachAsync(_items, async (_, ct) => await IoAsync(ct));

    [Benchmark]
    public Task ForEachAsync_Dop50() =>
        Parallel.ForEachAsync(
            _items,
            new ParallelOptions { MaxDegreeOfParallelism = 50 },
            async (_, ct) => await IoAsync(ct));
}
```

Репрезентативные результаты на 16-ядерном Ryzen 7 / Windows 11 / .NET 11, со столбцом пикового параллелизма, добавленным вручную из конфигурации:

| Метод                      | Среднее | Пик параллельных операций | Примечания                         |
| -------------------------- | ------- | ------------------------- | ---------------------------------- |
| `WhenAll_Unbounded`        | ~24 мс  | 500                       | самый быстрый, но 500 открытых соединений |
| `ForEachAsync_Dop50`       | ~210 мс | 50                        | 10 пакетов по 50                   |
| `ForEachAsync_DefaultDop`  | ~640 мс | 16 (`ProcessorCount`)     | потолок по умолчанию это число CPU, мал для ввода-вывода |

`WhenAll` здесь примерно в 25 раз быстрее, чем `ForEachAsync` по умолчанию, и в этом и суть: он достигает этой скорости, открывая 500 соединений сразу. Если ваш нижестоящий сервис это выдерживает, отлично. Если это сторонний API с ограничением по частоте, то «медленный» ограниченный прогон это тот, который не приносит вам 429 или `SocketException`. `Parallel.ForEachAsync` по умолчанию самый медленный, потому что его степень параллелизма по умолчанию равна `Environment.ProcessorCount`, настроенному на работу CPU; для ввода-вывода вы намеренно её повышаете, как показывает `Dop50`. Вывод не «WhenAll побеждает», а «выберите параллелизм, который вы можете себе позволить, затем выберите API, который его обеспечивает».

## Подводные камни, которые решают за вас

Несколько ограничений полностью переопределяют предпочтение.

**Асинхронное тело означает не `Parallel.ForEach`.** Его тело это `Action<T>`. Асинхронной перегрузки нет. Блокировка внутри через `.Result` или `.GetAwaiter().GetResult()` занимает поток пула на каждую итерацию и приглашает истощение. Если работа ожидает через await, вы на `Parallel.ForEachAsync` или `Task.WhenAll`. См. [async void vs async Task](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), чтобы понять, почему `async`-лямбда молча становится `async void` при присвоении `Action<T>`, что проглатывает исключения и полностью разрушает цикл.

**Неограниченный список означает не `Task.WhenAll`.** У `WhenAll` нет ограничения. Над большим или неизвестным числом элементов он запускает всё сразу. Если вы не можете гарантировать, что количество невелико, используйте `Parallel.ForEachAsync` с `MaxDegreeOfParallelism`.

**Множественные сбои проявляются по-разному.** Все три собирают исключения в `AggregateException`, но то, как вы их наблюдаете, различается. `Parallel.ForEach` (синхронный) бросает `AggregateException` напрямую, так что `catch (AggregateException ae)` видит каждое внутреннее исключение. С `Parallel.ForEachAsync` и `Task.WhenAll` вы делаете `await`, а `await` разворачивает только *первое* исключение; чтобы увидеть все, проверьте свойство `.Exception` упавшей задачи. Более глубокое различие это время: `Task.WhenAll` даёт каждой задаче дойти до конца даже после того, как одна упала, так что вы получаете сбои от всех них, тогда как `Parallel.ForEachAsync` отменяет свой внутренний токен при первом сбое и прекращает планировать новые итерации, то есть закорачивает. Если требование «попробовать всё, сообщить обо всех сбоях», это указывает на `WhenAll`; если «остановиться, как только один упадёт», это указывает на `ForEachAsync`.

**До .NET 6 означает отсутствие `Parallel.ForEachAsync`.** Если вы застряли на .NET Framework или .NET Core 3.1, этого API не существует. Идиоматическая замена это шлюз `SemaphoreSlim` вокруг `Task.WhenAll`, или для формы производитель/потребитель, [Channel вместо BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

Ещё одно сквозное замечание: когда любой из них выполняет асинхронную работу, отмена должна протекать насквозь. `Parallel.ForEachAsync` передаёт вашему телу токен; `Task.WhenAll` отменяется только если созданные вами задачи учитывают токен. Правильно это связать это отдельная тема, рассмотренная в [как отменить долго выполняющуюся Task без взаимных блокировок](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Рекомендация, повторно

Решайте по форме работы. Нагрузка на CPU над коллекцией в памяти: `Parallel.ForEach`, с `MaxDegreeOfParallelism`, если хотите оставить ядра свободными. Асинхронный ввод-вывод над множеством элементов, где нужно ограничить параллелизм: `Parallel.ForEachAsync`, и не забудьте поднять `MaxDegreeOfParallelism` выше числа ядер для ввода-вывода и передать токен тела в каждый внутренний вызов. Небольшой фиксированный fan-out, где нужно всё в работе и нужны результаты: `Task.WhenAll`, но никогда над неограниченным списком. Самая короткая верная версия: CPU и данные это `Parallel.ForEach`; асинхронный ввод-вывод в масштабе это `Parallel.ForEachAsync`; известная горстка await это `Task.WhenAll`.

## Связанное

- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/ru/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) охватывает более низкоуровневые примитивы, на которых построены эти более высокоуровневые API.
- [async void vs async Task в C#: когда каждое верно](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) объясняет ловушку `async void`, которая срабатывает, когда вы передаёте асинхронную лямбду в `Parallel.ForEach`.
- [Как отменить долго выполняющуюся Task в C# без взаимных блокировок](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) это половина про отмену для всех трёх.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ru/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) показывает шлюз SemaphoreSlim, который ограничивает `Task.WhenAll`, когда вам нужно больше контроля, чем даёт `Parallel.ForEachAsync`.
- [Как использовать Channels вместо BlockingCollection в C#](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) это альтернатива производитель/потребитель, когда работа это конвейер, а не плоский fan-out.

## Источники

- [Справочник метода Parallel.ForEachAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreachasync)
- [Справочник метода Task.WhenAll (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.whenall)
- [Справочник метода Parallel.ForEach (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreach)
- [ParallelOptions.MaxDegreeOfParallelism (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.paralleloptions.maxdegreeofparallelism)
- [Parallel.ForEachAsync and Exceptions (Jeremy Bytes)](https://jeremybytes.blogspot.com/2024/02/parallelforeachasync-and-exceptions.html)
