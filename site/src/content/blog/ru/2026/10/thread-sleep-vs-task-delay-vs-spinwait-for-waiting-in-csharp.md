---
title: "Thread.Sleep, Task.Delay и SpinWait для ожидания в C#"
description: "Используйте await Task.Delay для любого ожидания по времени в асинхронном коде, Thread.Sleep только на выделенном потоке, которым вы владеете, а SpinWait только для ожиданий короче микросекунды внутри lock-free кода. Чтобы дождаться условия, применяйте сигнал (ManualResetEventSlim, SemaphoreSlim, TaskCompletionSource) вместо любого из этих трёх. Измерено на .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "async"
  - "performance"
lang: "ru"
translationOf: "2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-14
---

Для паузы по времени используйте `await Task.Delay(...)` в любом асинхронном коде, потому что на время ожидания он освобождает поток. `Thread.Sleep` применяйте только на потоке, который вы создали сами (цикл в консольном приложении, выделенный рабочий поток), и никогда на потоке пула потоков или потоке UI. `SpinWait` применяйте только когда ожидание должно закончиться за несколько микросекунд, обычно внутри lock-free кода. А если вы на самом деле ждёте, пока **что-то произойдёт**, а не пока пройдёт время, то ни один из трёх не подходит: используйте сигнал, например `ManualResetEventSlim`, `SemaphoreSlim` или `TaskCompletionSource`. В моих измерениях они просыпались примерно в 50 раз быстрее любого цикла опроса.

Все числа в этой статье измерены на .NET 10.0.10 (SDK 10.0.302), C# 14, на Apple M4 с 10 ядрами под macOS 26.6. Сами API не менялись годами: `Task.Delay` существует с .NET Framework 4.5, `SpinWait` с 4.0, и всё описанное здесь одинаково применимо к .NET 8, 9 и предварительным версиям .NET 11.

## Сравнение с первого взгляда

| | `Thread.Sleep` | `await Task.Delay` | `SpinWait` |
| --- | --- | --- | --- |
| Удерживает поток во время ожидания | Да, заблокирован | Нет, поток возвращается в пул | Да, выполняется или уступает процессор |
| CPU во время ожидания (500 мс, измерено) | 0 мс | 0 мс | 4 мс с `SpinUntil`, 500 мс с `SpinOnce(-1)` |
| Самое короткое реальное ожидание (запрошена `1` мс, macOS) | ~1.5 мс | ~1.3 мс | ~1 мкс на один ранний спин |
| Самое короткое реальное ожидание в Windows (таймер по умолчанию) | ~1-15.6 мс | ~15.6 мс | ~1 мкс на один ранний спин |
| Можно отменить | Нет | Да, через `CancellationToken` | Только вашим собственным условием |
| Тестируется с подменой времени | Нет | Да, `Task.Delay(TimeSpan, TimeProvider)` (.NET 8+) | Нет |
| Безопасен на потоке пула потоков | Нет | Да | Только на микросекунды |
| Безопасен на потоке UI | Нет, UI зависает | Да | Нет |
| Типичное применение | Циклы на выделенных потоках, быстрые консольные утилиты | Откат при повторных попытках, ограничение частоты, опрос в асинхронном коде | Lock-free циклы повторов, примитивы по схеме "покрутиться, затем блокироваться" |

## Что каждый из них на самом деле делает с вашим потоком

`Thread.Sleep(ms)` приостанавливает вызывающий поток ОС. Планировщик снимает его с процессора и не рассматривает снова, пока не истечёт интервал. CPU не расходуется, но поток всё равно существует, держит свой стек и не может делать ничего другого. Для потока, единственная задача которого ждать, это нормально. Для потока, принадлежащего общему ресурсу, это проблема.

`Task.Delay(ms)` возвращает `Task`, который завершается, когда срабатывает внутренний `TimerQueueTimer`. Когда вы делаете `await`, ваш метод возвращает управление вызывающему коду, поток возвращается в пул (или в цикл сообщений UI), а остаток метода планируется как продолжение, когда сработает таймер. Пока задержка не истекла, с вашим методом вообще не связан ни один поток.

`SpinWait` держит поток на процессоре и проверяет условие снова и снова. Это структура с одним важным методом, `SpinOnce()`, и её поведение зависит от того, сколько раз вы его вызвали. По [исходному коду .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs) константы такие: `YieldThreshold = 10`, `Sleep0EveryHowManyYields = 5` и `DefaultSleep1Threshold = 20`:

- Вызовы с 0 по 9 выполняют `Thread.SpinWait(n)`, то есть пустой цикл из инструкций паузы процессора, который с каждой итерацией растёт.
- Начиная с вызова 10, каждый второй вызов уступает квант времени через `Thread.Yield()` или `Thread.Sleep(0)`.
- Начиная с вызова 20, каждый вызов делает `Thread.Sleep(1)`.
- На однопроцессорной машине спин пропускается полностью, и уступка происходит с первого вызова, потому что там спин только задерживает поток, которого вы ждёте.

Так что "`SpinWait`" скорее лестница эскалации, чем спин. Эта деталь определяет большинство компромиссов ниже.

## Измерение: сколько на самом деле длится "подождать 1 мс"?

Этот тест замеряет по 200 вызовов каждого и выводит медиану и 99-й перцентиль:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe.cs
using System.Diagnostics;

foreach (var ms in new[] { 0, 1, 10, 15 })
{
    var sleep = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        Thread.Sleep(ms);
        sleep.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    var delay = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        await Task.Delay(ms);
        delay.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    sleep.Sort(); delay.Sort();
    Console.WriteLine($"{ms} ms: Sleep p50={sleep[100]:F3} | Delay p50={delay[100]:F3}");
}
```

| Запрошено | `Thread.Sleep` p50 | `Thread.Sleep` p99 | `Task.Delay` p50 | `Task.Delay` p99 |
| --- | --- | --- | --- | --- |
| 0 мс | 0.000 мс | 0.015 мс | 0.000 мс | 0.001 мс |
| 1 мс | 1.510 мс | 1.633 мс | 1.297 мс | 1.513 мс |
| 10 мс | 12.012 мс | 12.033 мс | 12.043 мс | 12.083 мс |
| 15 мс | 16.763 мс | 17.071 мс | 17.023 мс | 17.215 мс |

Из этого стоит вынести две вещи. Во-первых, оба ожидают "не меньше указанного", а не "ровно указанное". На macOS превышение стабильно составляло от 0.3 до 2 мс. Во-вторых, `Task.Delay(0)` завершается синхронно: он возвращает уже завершённую задачу, так что `await Task.Delay(0)` вообще не уступает управление. Если в асинхронном коде нужно уступить, для этого предназначен `await Task.Yield()`.

В Windows разрыв намного больше. [Документация `Task.Delay`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay) сообщает, что задержка зависит от системных часов, разрешение которых в Windows около 15 мс, поэтому `Task.Delay(1)` там обычно занимает около 15.6 мс. `Thread.Sleep(1)` в Windows может занимать как почти 1 мс, так и почти 15.6 мс, в зависимости от того, повысил ли какой-либо процесс на машине глобальное разрешение таймера. Ни один из этих API не является точным таймером. Если ваш цикл рассчитывает на тик в 1 мс, на Windows с настройками по умолчанию он будет работать с долей ожидаемой частоты.

## Измерение: что `Thread.Sleep` делает с пулом потоков

Настоящая причина, по которой `Thread.Sleep` опасен, не в CPU и не в точности. Дело в том, что он делает с общим пулом. Этот тест ставит в очередь 200 рабочих элементов, каждый из которых ждёт одну секунду, а затем из выделенного потока измеряет, сколько совершенно новый рабочий элемент ждёт, прежде чем вообще начнёт выполняться:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe3.cs -- sleep|delay
using System.Diagnostics;

string mode = args[0];
var sw = Stopwatch.StartNew();

var tasks = Enumerable.Range(0, 200).Select(_ => Task.Run(async () =>
{
    if (mode == "sleep") Thread.Sleep(1000);
    else await Task.Delay(1000);
})).ToArray();

var sampler = new Thread(() =>
{
    using var started = new ManualResetEventSlim();
    var t = Stopwatch.GetTimestamp();
    ThreadPool.UnsafeQueueUserWorkItem(_ => started.Set(), null);
    started.Wait();
    Console.WriteLine($"new work item waited {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms");
});
sampler.Start();

Task.WaitAll(tasks);
sampler.Join();
Console.WriteLine($"{mode}: 200 waits done in {sw.ElapsedMilliseconds} ms, pool threads = {ThreadPool.ThreadCount}");
```

| | `Thread.Sleep(1000)` | `await Task.Delay(1000)` |
| --- | --- | --- |
| Время всех 200 односекундных ожиданий | 18,034 мс | 1,005 мс |
| Потоков в пуле в конце | 12 | 11 |
| Задержка до старта постороннего рабочего элемента | 17,030 мс | 1 мс |

С `Task.Delay` все 200 ожиданий перекрываются, и весь пакет занимает одну секунду на десяти потоках. С `Thread.Sleep` пул может выполнять одновременно столько сна, сколько у него потоков, поэтому пакет сериализуется группами примерно по десять, и любая другая работа, стоящая в очереди позади, в данном случае тривиальный `started.Set()`, простояла в очереди **17 секунд**. Обратите внимание, что пул не спас положение добавлением потоков: рабочие элементы продолжали завершаться каждую секунду, поэтому его алгоритм hill-climbing довёл число потоков лишь с 10 до 12.

В приложении ASP.NET Core такой рабочий элемент в очереди это следующий HTTP-запрос. Это классический шаблон исчерпания пула потоков, и `Thread.Sleep` внутри обработчика запроса или `BackgroundService` один из самых простых способов его вызвать. То же самое происходит с `Task.Delay(1000).Wait()`, который есть просто `Thread.Sleep` с дополнительными выделениями памяти. Если этот шаблон вам знаком, статья про [устранение взаимных блокировок из-за `.Result` и `.Wait()`](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) разбирает сторону "синхронно поверх асинхронного".

## Измерение: стоимость CPU и задержка пробуждения у `SpinWait`

`SpinWait.SpinUntil(condition)` звучит так, будто он будет жечь ядро всё время ожидания. Благодаря лестнице эскалации этого не происходит:

| Стратегия ожидания, 500 мс реального времени | Использовано процессорного времени |
| --- | --- |
| `Thread.Sleep(500)` | 0 мс |
| `await Task.Delay(500)` | 0 мс |
| `SpinWait.SpinUntil(...)` | 4 мс |
| цикл `SpinOnce(sleep1Threshold: -1)` | 500 мс (одно ядро целиком) |
| пустой цикл `while` | 499 мс |

Первые 10 чистых спинов заняли в сумме 9.8 мкс, а спины с 10 по 19 ещё 10 мкс. После этого каждый `SpinOnce()` это `Thread.Sleep(1)`, который я измерил примерно в 1,265 мкс каждый. Передайте `sleep1Threshold: -1`, чтобы отключить стадию `Sleep(1)`, и получите ровно то, что подразумевает название: ядро, загруженное на сто процентов.

Другая половина компромисса это то, как быстро каждая стратегия замечает, что событие, которого она ждёт, произошло. Здесь второй поток устанавливает флаг через случайные 0-3 мс, а главный поток измеряет время от установки флага до момента, когда он это заметил (по 200 запусков каждой стратегии):

```csharp
// .NET 10.0.10, C# 14
int flag = 0;
using var ev = new ManualResetEventSlim();
// setter thread: busy-waits a random 0-3 ms, then
//   Volatile.Write(ref flag, 1); ev.Set();

SpinWait.SpinUntil(() => Volatile.Read(ref flag) == 1);       // "spinuntil"
while (Volatile.Read(ref flag) == 0) Thread.Sleep(1);         // "sleep1"
while (Volatile.Read(ref flag) == 0) await Task.Delay(1);     // "delay1"
ev.Wait();                                                    // "mres"
```

| Стратегия | Задержка пробуждения p50 | Задержка пробуждения p90 |
| --- | --- | --- |
| `SpinWait.SpinUntil` | 745 мкс | 1,182 мкс |
| опрос через `Thread.Sleep(1)` | 710 мкс | 1,158 мкс |
| опрос через `await Task.Delay(1)` | 836 мкс | 1,205 мкс |
| `ManualResetEventSlim.Wait()` | 15 мкс | 37 мкс |

Когда ожидание длится дольше примерно 20 мкс, `SpinUntil` оказывается просто циклом опроса с `Thread.Sleep(1)` под более красивым названием и просыпается не быстрее. Ожидание на событии было в 50 раз быстрее по медиане и не использовало CPU во время ожидания. `ManualResetEventSlim` и `SemaphoreSlim` и так немного покрутятся, прежде чем заблокироваться, так что одним вызовом вы получаете и дешёвый быстрый путь `SpinWait`, и эффективный медленный путь ожидания в ядре.

## Когда выбирать `await Task.Delay`

- **Повторные попытки и откат в асинхронном коде.** HTTP-клиент, повторяющий запрос после 429, цикл переподключения к базе данных. Передайте `CancellationToken` запроса, чтобы завершение работы или отключение клиента отменяли ожидание, а не оставляли его висеть.
- **Периодическая работа в `BackgroundService`.** `await Task.Delay(interval, stoppingToken)` в цикле подходит. Если нужны тики, не уплывающие на длительность работы, лучше подходит `PeriodicTimer` (.NET 6+).
- **Ограничение частоты или debounce на потоке UI.** WPF, WinForms, MAUI и Blazor остаются отзывчивыми, потому что поток UI свободен, пока задержка не истекла.
- **Всё, что вы хотите покрыть модульными тестами.** Перегрузка `Task.Delay(TimeSpan, TimeProvider, CancellationToken)` (.NET 8+) позволяет тесту мгновенно продвигать время с помощью `FakeTimeProvider`; я разбирал это в статье про [тестирование кода, зависящего от времени, с `TimeProvider`](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).

```csharp
// .NET 10, C# 14
async Task<HttpResponseMessage> GetWithRetryAsync(
    HttpClient http, string url, TimeProvider time, CancellationToken ct)
{
    for (int attempt = 0; ; attempt++)
    {
        var response = await http.GetAsync(url, ct);
        if (response.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt == 4)
            return response;

        response.Dispose();
        var backoff = TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt));
        await Task.Delay(backoff, time, ct); // cancellable, testable, holds no thread
    }
}
```

## Когда выбирать `Thread.Sleep`

- **Поток, который вы создали и которым владеете.** `new Thread(...)`, который раз в секунду опрашивает оборудование или файл, и на этом потоке больше ничего не планируется. Его блокировка не стоит ничего, что нужно кому-то ещё.
- **Синхронная консольная утилита или скрипт.** Не асинхронный `Main`, которому просто нужно сделать паузу между шагами. Нет ни пула, ни потока UI, которые можно было бы исчерпать.
- **Намеренное воспроизведение блокировки.** Тесты или демонстрации, где нужно имитировать медленный синхронный вызов, как в тесте на исчерпание пула выше.

Даже на выделенном потоке стоит рассмотреть `WaitHandle.WaitOne(timeout)` или `CancellationToken.WaitHandle.WaitOne(timeout)`. Он ждёт тот же интервал, но возвращается раньше, когда потоку велят остановиться, чего `Thread.Sleep` сделать не может:

```csharp
// .NET 10, C# 14: a dedicated worker thread that can be stopped promptly
void PollLoop(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        PollDevice();
        ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(1)); // returns immediately on Cancel()
    }
}
```

## Когда выбирать `SpinWait`

- **Lock-free циклы повторов.** Цикл compare-and-swap, который не удался, потому что другой поток находится посреди обновления. Другой поток закончит за наносекунды, поэтому переключение контекста обошлось бы дороже ожидания.
- **Быстрый путь вашего собственного примитива синхронизации.** Покрутитесь несколько раз через `SpinOnce()`, пока `NextSpinWillYield` равен false, затем перейдите к настоящему блокирующему ожиданию. Это та же структура, которую внутри использует `ManualResetEventSlim`.

```csharp
// .NET 10, C# 14: spin briefly, then block
var spinner = new SpinWait();
while (!IsReady())
{
    if (spinner.NextSpinWillYield)
    {
        readyEvent.Wait(); // stop spinning, let the OS park the thread
        break;
    }
    spinner.SpinOnce();
}
```

Не используйте `SpinWait` для ожиданий, измеряемых миллисекундами, и не вызывайте `Thread.SpinWait(n)` напрямую с большим `n`. [Документация `SpinWait`](https://learn.microsoft.com/dotnet/api/system.threading.spinwait) позиционирует его как низкоуровневый строительный блок для кода синхронизации, а спин окупается только тогда, когда ожидаемое ожидание короче стоимости переключения контекста. Если вы не пишете lock-free структуру данных или примитив синхронизации, он вам, скорее всего, не нужен. Статья про [`lock`, `Monitor`, `SemaphoreSlim` и `System.Threading.Lock`](/ru/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) рассказывает о примитивах более высокого уровня, которые уже делают этот спин за вас.

## Подвох, который решает за вас: вы ждёте времени или события?

Большинство вызовов `Thread.Sleep` и `Task.Delay`, которые я вижу на код-ревью, на самом деле не ожидания по времени. Это циклы опроса: "поспать 100 мс, проверить, закончилась ли работа, повторить". Такой шаблон всегда проигрывает по обеим осям. Он добавляет до целого интервала задержки после события и просыпается впустую всё время до него.

Если событие вызывает другая часть вашей программы, сигнализируйте о нём напрямую:

```csharp
// .NET 10, C# 14: replace "while (!done) await Task.Delay(100);"
var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

_ = Task.Run(async () =>
{
    await DoWorkAsync();
    completion.TrySetResult();
});

await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); // a real timeout, no polling
```

`RunContinuationsAsynchronously` не даёт коду, который ожидает `completion.Task`, выполняться прямо в потоке, вызвавшем `TrySetResult`. `WaitAsync(TimeSpan)` (.NET 6+) даёт тайм-аут без самодельного `Task.WhenAny(task, Task.Delay(...))`. Для передачи данных между производителем и потребителем используйте `Channel<T>`, а для "не более N одновременно" используйте `SemaphoreSlim.WaitAsync`. Опрашивайте только тогда, когда событие происходит вне вашего процесса и ничто не может вас уведомить, например эндпоинт статуса удалённого задания. Тогда `await Task.Delay` с `CancellationToken` это правильный интервал опроса.

## Рекомендация

По умолчанию используйте `await Task.Delay(interval, cancellationToken)`. Он не удерживает поток, не использует CPU, его можно отменить, а с `TimeProvider` его можно тестировать без реального ожидания. В измерении выше он выполнил 200 односекундных ожиданий за 1 секунду, тогда как `Thread.Sleep` потратил на них 18 секунд и заблокировал посторонние задачи на 17 из них.

Используйте `Thread.Sleep` только на потоке, который больше никто не делит, и даже там предпочитайте отменяемый `WaitHandle.WaitOne(timeout)`. Используйте `SpinWait` только для ожиданий короче переключения контекста внутри lock-free кода или кода синхронизации; для чего-то более долгого он всё равно вырождается в цикл `Sleep(1)`. И прежде чем выбрать любой из них, спросите себя, ждёте ли вы времени или чего-то, что должно произойти. Если второго, то `TaskCompletionSource`, `ManualResetEventSlim`, `SemaphoreSlim` или `Channel<T>` разбудят вас примерно в 50 раз быстрее.

### Читайте дальше

- [Как задать тайм-аут асинхронной операции с помощью `CancellationTokenSource.CancelAfter`](/ru/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [Как отменить долгую задачу в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [`Task.Run`, `Task.Factory.StartNew` и `ThreadPool.QueueUserWorkItem`](/ru/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [`Volatile.Read` и `Volatile.ReadBarrier` в .NET 10](/ru/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/)

### Источники

- [Справочник API `Thread.Sleep`](https://learn.microsoft.com/dotnet/api/system.threading.thread.sleep), Microsoft Learn
- [Справочник API `Task.Delay`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay), включая примечание о разрешении системных часов
- [Справочник API `SpinWait`](https://learn.microsoft.com/dotnet/api/system.threading.spinwait), Microsoft Learn
- [`SpinWait.cs` в v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), dotnet/runtime
- [Отладка исчерпания пула потоков](https://learn.microsoft.com/dotnet/core/diagnostics/debug-threadpool-starvation), документация по диагностике .NET
- [Обзор `TimeProvider`](https://learn.microsoft.com/dotnet/standard/datetime/timeprovider-overview), Microsoft Learn
