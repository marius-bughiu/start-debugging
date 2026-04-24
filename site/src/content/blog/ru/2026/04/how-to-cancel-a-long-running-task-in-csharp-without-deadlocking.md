---
title: "Как отменить долго работающую Task в C# без взаимной блокировки"
description: "Кооперативная отмена с CancellationToken, CancelAsync, Task.WaitAsync и связанными токенами в .NET 11. Плюс блокирующие паттерны, превращающие чистую отмену в дедлок."
pubDate: 2026-04-23
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "ru"
translationOf: "2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking"
translatedBy: "claude"
translationDate: 2026-04-24
---

У вас есть `Task`, которая работает долго, пользователь нажимает «Отмена», а приложение либо зависает, либо задача продолжает работать до самого конца. Оба исхода указывают на одно и то же недоразумение: в .NET отмена кооперативна, а её рабочие детали - это `CancellationTokenSource`, `CancellationToken` и ваша готовность действительно проверять токен. Эта статья показывает, как чисто настроить всё это на .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) и как избежать блокирующих паттернов, превращающих чистую отмену в `Wait`-навсегда дедлок. Каждый пример компилируется на .NET 11.

## Кооперативная отмена, ментальная модель в одном абзаце

В .NET нет `Task.Kill()`. CLR не выдернет поток из середины вашего кода. Когда вы хотите отменить работу, вы создаёте `CancellationTokenSource`, передаёте его `Token` каждой функции в цепочке вызовов, и эти функции либо проверяют `token.IsCancellationRequested`, либо вызывают `token.ThrowIfCancellationRequested()`, либо передают токен в асинхронное API, которое его уважает. Когда срабатывает `cts.Cancel()` (или `await cts.CancelAsync()`), токен переключается, и каждое проверяющее место реагирует. Ничего не отменяется, если не попросили проверить.

Именно поэтому `Task.Run(() => LongLoop())` без токена нельзя отменить. Компилятор не внедряет отмену за вас.

## Минимально корректный паттерн

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();

Task work = DoWorkAsync(cts.Token);

// Later, from a Cancel button, a timeout, whatever:
await cts.CancelAsync();

try
{
    await work;
}
catch (OperationCanceledException)
{
    // Expected when cts triggers. Not an error.
}

static async Task DoWorkAsync(CancellationToken ct)
{
    for (int i = 0; i < 1_000_000; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(10, ct); // async APIs should take the token
    }
}
```

Три правила делают здесь всю работу:

1. `CancellationTokenSource` освобождается (`using var`), чтобы его внутренний таймер и wait handle были отпущены.
2. Каждый уровень цепочки вызовов принимает `CancellationToken` и либо проверяет его, либо пробрасывает дальше.
3. Вызывающий делает `await` на задаче и ловит `OperationCanceledException`. Отмена всплывает как исключение, чтобы очистка в блоках `finally` всё равно выполнялась.

## CPU-bound циклы: ThrowIfCancellationRequested

Для CPU-bound работы рассыпайте `ct.ThrowIfCancellationRequested()` с такой частотой, при которой отзывчивость приемлема, но проверка не становится горячим путём. Проверка дешёвая (`Volatile.Read` по `int`), но в плотном внутреннем цикле, обрабатывающем десятки миллионов элементов, она всё равно появляется в профилях. Хороший дефолт - раз на каждую внешнюю итерацию цикла, делающего «одну единицу работы».

```csharp
// .NET 11, C# 14
static long SumPrimes(int max, CancellationToken ct)
{
    long sum = 0;
    for (int n = 2; n <= max; n++)
    {
        if ((n & 0xFFFF) == 0) ct.ThrowIfCancellationRequested(); // every 65536 iterations
        if (IsPrime(n)) sum += n;
    }
    return sum;
}
```

Когда работа живёт в фоновом потоке, запущенном через `Task.Run`, передайте токен и самому `Task.Run`:

```csharp
var task = Task.Run(() => SumPrimes(10_000_000, cts.Token), cts.Token);
```

Передача токена в `Task.Run` означает, что если токен отменён **до** запуска делегата, задача переходит сразу в `Canceled`, не выполняясь. Без него делегат доходит до конца, и только внутренняя проверка может его остановить.

## I/O-bound работа: пробрасывайте токен в каждое асинхронное API

Каждое современное I/O-API .NET принимает `CancellationToken`. `HttpClient.GetAsync`, `Stream.ReadAsync`, `DbCommand.ExecuteReaderAsync`, `SqlConnection.OpenAsync`, `File.ReadAllTextAsync`, `Channel.Reader.ReadAsync`. Если не опускать токен ниже, отмена останавливается на вашем уровне, а нижележащий I/O продолжается, пока ОС или удалённая сторона не сдастся.

```csharp
// .NET 11, C# 14
static async Task<string> FetchWithTimeoutAsync(string url, TimeSpan timeout, CancellationToken outer)
{
    using var http = new HttpClient();
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
    linked.CancelAfter(timeout);

    using HttpResponseMessage resp = await http.GetAsync(url, linked.Token);
    resp.EnsureSuccessStatusCode();
    return await resp.Content.ReadAsStringAsync(linked.Token);
}
```

В этом фрагменте стоит отметить две вещи. `CreateLinkedTokenSource` объединяет «вызывающий хочет отмену» и «мы сдались после `timeout`» в один токен. А `CancelAfter` - правильный способ выразить таймаут, а не `Task.Delay`, соревнующийся с работой, потому что он использует один элемент очереди таймера, а не аллоцирует целую `Task`.

## Ловушки дедлока в порядке частоты

### Ловушка 1: блокировка на async-методе из захватывающего контекста

```csharp
// BAD on WinForms, WPF, or any SynchronizationContext that runs on one thread
string html = FetchAsync(url).Result;
```

`FetchAsync` внутри делает `await`, что постит продолжение обратно в захваченный `SynchronizationContext`. Этот контекст - UI-поток. UI-поток заблокирован на `.Result`. Продолжение не может выполниться. Дедлок. Отмена здесь не поможет, потому что задача никогда не завершится.

Исправление - не `ConfigureAwait(false)` в вашем коде. Исправление - просто не блокироваться. Сделайте вызывающего async:

```csharp
string html = await FetchAsync(url);
```

Если вы абсолютно не можете использовать `await` (например, в конструкторе), используйте `Task.Run`, чтобы сначала уйти из захваченного контекста. Это капитуляция, а не решение.

### Ловушка 2: ConfigureAwait(false) только на внешнем await

Автор библиотеки оборачивает один вызов в `ConfigureAwait(false)`, видит, что дедлок исчезает в юнит-тесте, и выпускает релиз. Потом вызывающий оборачивает всё в `.Result`, и дедлок возвращается, потому что внутренний `await` в вызываемом коде контекст всё же захватил.

`ConfigureAwait(false)` - настройка на каждый `await`. Либо каждый `await` в каждом методе библиотеки использует её, либо никакой. Миру аннотаций `Nullable` повезло; этому - нет. На .NET 11 с C# 14 можно включить анализатор `CA2007`, чтобы принудить `ConfigureAwait(false)` в библиотеках, и использовать `ConfigureAwaitOptions.SuppressThrowing`, когда вы хотите дождаться завершения задачи, не интересуясь её исключением.

### Ловушка 3: CancellationTokenSource.Cancel() вызывается из колбэка, зарегистрированного на том же токене

`CancellationTokenSource.Cancel()` по умолчанию выполняет зарегистрированные колбэки **синхронно** в вызывающем потоке. Если один из таких колбэков вызывает `Cancel()` на том же источнике или блокируется на локе, который держит другой колбэк, вы получаете рекурсивный или реентерабельный дедлок. На .NET 11 предпочтите `await cts.CancelAsync()`, когда держите любой лок, когда находитесь в `SynchronizationContext`, или когда колбэки нетривиальны. `CancelAsync` диспетчеризует колбэки асинхронно, так что `Cancel` возвращает управление вам первым.

```csharp
// .NET 11, C# 14
lock (_state)
{
    _state.MarkStopping();
}
await _cts.CancelAsync(); // callbacks fire after we are out of the lock
```

### Ловушка 4: задача, игнорирующая свой токен

Самая частая причина «отмена ничего не делает» - вовсе не дедлок, а задача, которая никогда не проверяет. Чините в источнике:

```csharp
static async Task BadAsync(CancellationToken ct)
{
    await Task.Delay(5000); // no token, so unaffected by cancel
}

static async Task GoodAsync(CancellationToken ct)
{
    await Task.Delay(5000, ct); // throws OperationCanceledException on cancel
}
```

Если вы не можете изменить вызываемый код (сторонний код без параметра-токена), `Task.WaitAsync(CancellationToken)` из .NET 6+ даёт лазейку: ожидание становится отменяемым, даже если нижележащая работа - нет.

```csharp
// .NET 11, C# 14
Task<string> hardcoded = LegacyFetchThatIgnoresTokensAsync();
string result = await hardcoded.WaitAsync(ct); // returns immediately on cancel; the underlying work keeps running
```

Будьте честны с собой: это разблокирует вас, но не останавливает работу. На .NET 11 нижележащий `HttpClient`, файловый хендл или что бы ни делал legacy-код, продолжает работу до конца, а её результат отбрасывается. Для долго работающего цикла, удерживающего эксклюзивные ресурсы, это утечка, а не отмена.

## Связанные токены: отмена вызывающим + таймаут + shutdown

Реалистичный серверный эндпоинт хочет отменять по трём причинам: вызывающий отсоединился, таймаут запроса истёк, или хост завершает работу. `CreateLinkedTokenSource` объединяет их.

```csharp
// .NET 11, C# 14 - ASP.NET Core 11 minimal API
app.MapGet("/report", async (HttpContext ctx, IHostApplicationLifetime life, CancellationToken requestCt) =>
{
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestCt, life.ApplicationStopping);
    linked.CancelAfter(TimeSpan.FromSeconds(30));

    string report = await BuildReportAsync(linked.Token);
    return Results.Text(report);
});
```

ASP.NET Core уже даёт `HttpContext.RequestAborted` (предоставленный как параметр `CancellationToken`, когда вы его принимаете). Свяжите его с `IHostApplicationLifetime.ApplicationStopping`, чтобы graceful shutdown тоже отменял работу в полёте, и добавьте сверху таймаут на эндпоинт. Если сработает любой из трёх, `linked.Token` переключится.

## OperationCanceledException против TaskCanceledException

Оба существуют. `TaskCanceledException` наследуется от `OperationCanceledException`. Ловите `OperationCanceledException`, если вам конкретно не нужно отличать «задача была отменена» от «вызывающий отменил другую операцию». На практике всегда ловите базовый класс.

Тонкий момент: когда вы делаете `await` на отменённой задаче, возвращаемое исключение может не нести оригинальный токен. Если нужно знать, какой токен сработал, проверьте `ex.CancellationToken == ct`, а не инспектируйте, какой токен вы передали в какое API.

## Освобождайте ваш CancellationTokenSource, особенно когда используете CancelAfter

`CancellationTokenSource.CancelAfter` планирует работу на внутреннем таймере. Если забыть освободить CTS, запись таймера остаётся жить до того момента, пока её не достанет GC, что на нагруженном сервере - утечка памяти и таймера, которая ничего не роняет, но проявляется как медленный рост в `dotnet-counters`. `using var cts = ...;` или `using (var cts = ...) { ... }` каждый раз.

Если хотите передать CTS фоновому владельцу, убедитесь, что ровно одно место отвечает за его освобождение, и освобождайте только после того, как все держатели его токена отпустят его.

## Фоновые сервисы: stoppingToken - ваш друг

В `BackgroundService` `ExecuteAsync` получает `CancellationToken stoppingToken`, который переключается, когда хост начинает shutdown. Используйте его как корень каждой цепочки отмены внутри сервиса. Не создавайте свежие CTS, отвязанные от shutdown, иначе graceful `Ctrl+C` выйдет в таймаут, и хост разорвёт процесс жёстким способом.

```csharp
// .NET 11, C# 14
public sealed class Crawler(IHttpClientFactory http, ILogger<Crawler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var perItem = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                perItem.CancelAfter(TimeSpan.FromSeconds(10));

                await CrawlNextAsync(http.CreateClient(), perItem.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // host is stopping; exit cleanly
            }
            catch (OperationCanceledException)
            {
                log.LogWarning("Per-item timeout elapsed, continuing.");
            }
        }
    }
}
```

`catch` с фильтром `when` отличает «мы завершаем работу» от «мы получили таймаут на одной единице работы». Shutdown ломает внешний цикл. Таймаут на элемент логируется и идём дальше.

## А что насчёт Thread.Abort, Task.Dispose или жёсткого убийства?

`Thread.Abort` не поддерживается в .NET Core и бросает `PlatformNotSupportedException` на .NET 11. `Task.Dispose` существует, но не то, что вы думаете, он только освобождает `WaitHandle`, он не отменяет задачу. API «убей эту задачу» намеренно нет. Ближайший аварийный клапан - запустить действительно неотменяемую работу в отдельном процессе (`Process.Start` + `Process.Kill`) и жить с оверхедом межпроцессного взаимодействия. Для всего остального кооперативная отмена - это и есть API.

## Сводим всё вместе

Работающая кнопка «Отмена» в девяти случаях из десяти - результат трёх маленьких привычек: каждый async-метод принимает `CancellationToken` и пробрасывает его, каждый длинный цикл вызывает `ThrowIfCancellationRequested` с разумной частотой, и ничто нигде в цепочке вызовов не блокируется на `.Result` или `.Wait()`. Добавьте `using` на CTS, `CancelAfter` для таймаутов, `await CancelAsync()` внутри локов и `WaitAsync` как аварийный клапан для кода, который вы не можете изменить.

## Связанное чтение

- [Стриминг строк из базы с IAsyncEnumerable](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), который сильно опирается на ту же обвязку токенов.
- [Более чистые async stack traces в рантайме .NET 11](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), полезно, когда `OperationCanceledException` всплывает глубоко в пайплайне.
- [Как вернуть несколько значений из метода в C# 14](/ru/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) хорошо сочетается с async-методами, которые хотят вернуть «результат или причину отмены».
- [Конец `lock (object)` в .NET 9](/2026/01/net-9-the-end-of-lockobject/) для более широкого контекста threading, в котором работает ваш код отмены.

## Источники

- [Task Cancellation](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-cancellation), MS Learn.
- [Cancellation in Managed Threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads), MS Learn.
- [Coalesce cancellation tokens from timeouts](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/coalesce-cancellation-tokens-from-timeouts), MS Learn.
- [`CancellationTokenSource.CancelAsync`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelasync), справочник API.
- [`Task.WaitAsync(CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync), справочник API.
