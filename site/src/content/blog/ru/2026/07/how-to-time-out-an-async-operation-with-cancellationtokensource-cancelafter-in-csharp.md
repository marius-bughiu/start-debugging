---
title: "Ограничение времени выполнения асинхронной операции с помощью CancellationTokenSource.CancelAfter в C#"
description: "Используйте CancellationTokenSource.CancelAfter для задания дедлайна асинхронных операций в .NET 11: конструктор против CancelAfter, связанные токены, обработка исключений, Task.WaitAsync, TryReset для пула объектов и тестируемые тайм-ауты с TimeProvider."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "ru"
translationOf: "2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Чтобы задать дедлайн для асинхронной операции, нужны три вещи: `CancellationTokenSource`, вызов `cts.CancelAfter(TimeSpan.FromSeconds(5))` и передача `cts.Token` в каждый асинхронный метод цепочки. Когда дедлайн истекает, токен срабатывает, любой последующий `await` выбрасывает `OperationCanceledException`, которое вы перехватываете. В этой статье рассматривается полный паттерн для .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): когда использовать перегрузку конструктора вместо `CancelAfter`, как комбинировать тайм-аут с внешним `CancellationToken`, как отличить тайм-аут от отмены вызывающим кодом, `Task.WaitAsync` для кода, который нельзя изменить, `TryReset` для пула объектов, а также как сделать тайм-ауты тестируемыми с помощью `TimeProvider`.

## Операция, которая зависает навсегда

Вызов `HttpClient` без явного дедлайна ожидает столько, сколько потребуется серверу. `HttpClient.Timeout` по умолчанию равен 100 секундам -- достаточно, чтобы при высокой нагрузке переполнить очередь запросов. Кроме того, `HttpClient.Timeout` нельзя комбинировать с `CancellationToken` вызывающего кода, а при срабатывании он выбрасывает `TaskCanceledException` с `InnerException` типа `TimeoutException` -- это другая форма по сравнению с кооперативной отменой. Ручной паттерн с `CancelAfter` обеспечивает как соблюдение дедлайна, так и возможность композиции.

```csharp
// .NET 11, C# 14 -- опасно: HttpClient.Timeout по умолчанию равен 100 секундам
using HttpClient http = new();
string json = await http.GetStringAsync("https://slow-api.example.com/data");
```

## CancelAfter в одном шаге

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(5));

try
{
    using HttpClient http = new();
    string json = await http.GetStringAsync(
        "https://slow-api.example.com/data", cts.Token);
    Console.WriteLine(json);
}
catch (OperationCanceledException) when (cts.IsCancellationRequested)
{
    Console.WriteLine("Запрос завершился по тайм-ауту через 5 секунд.");
}
```

`CancelAfter` планирует внутренний однократный таймер. Когда таймер срабатывает, он вызывает `Cancel()` на CTS, что переводит состояние токена из "не запрошено" в "запрошено". Любой `await` внутри `GetStringAsync`, который проверяет токен, выбрасывает `OperationCanceledException`. Условие `when` гарантирует, что вы перехватите исключение только в том случае, если сработал ваш собственный CTS, а не какая-либо другая отмена от фреймворка или вызывающего кода.

## Перегрузка конструктора против CancelAfter

```csharp
// .NET 11, C# 14 -- эквивалентны для фиксированного однократного дедлайна:
using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

using var cts2 = new CancellationTokenSource();
cts2.CancelAfter(TimeSpan.FromSeconds(5));
```

Используйте перегрузку конструктора, когда дедлайн фиксирован в момент создания объекта и не изменится. Предпочитайте `CancelAfter`, когда вы создаёте CTS заранее, а дедлайн определяете позже, или когда нужно сбросить его в ходе операции -- например, watchdog, обновляющий своё окно при каждом успешном heartbeat:

```csharp
// .NET 11, C# 14 -- паттерн watchdog со сбросом дедлайна при каждом пакете
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));

await foreach (Packet packet in ReadPacketsAsync(cts.Token))
{
    Process(packet);
    cts.CancelAfter(TimeSpan.FromSeconds(10));  // сбросить 10-секундное окно
}
```

Каждый вызов `CancelAfter` заменяет ранее запланированное время через `ITimer.Change` внутри -- без новых выделений памяти. Новый отсчёт начинается с момента вызова.

## Комбинирование тайм-аута с внешним CancellationToken

В ASP.NET Core `HttpContext.RequestAborted` срабатывает при отключении клиента. В `BackgroundService` `stoppingToken` срабатывает при завершении работы. Тайм-аут должен отменять операцию при истечении дедлайна или при отмене вызывающим кодом. Используйте `CancellationTokenSource.CreateLinkedTokenSource`:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithDeadlineAsync(
    string url,
    CancellationToken callerToken = default)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
        callerToken, timeoutCts.Token);

    using HttpClient http = new();
    return await http.GetStringAsync(url, linked.Token);
}
```

Передавайте `linked.Token` во все последующие вызовы. Связанный токен отменяется, если срабатывает любой из источников. `CreateLinkedTokenSource` принимает произвольное количество токенов; возвращённый CTS отменяется, как только любой из них отменяется.

Всегда вызывайте `Dispose` как для тайм-аутного CTS, так и для связанного. Неосвобождённые экземпляры CTS с ожидающими таймерами не собираются сборщиком мусора до срабатывания таймера.

## Различение тайм-аута и отмены вызывающим кодом

Оба случая выбрасывают `OperationCanceledException`. Чтобы передать вызывающему коду осмысленную информацию об ошибке, преобразуйте настоящий тайм-аут в `TimeoutException`:

```csharp
// .NET 11, C# 14
catch (OperationCanceledException ex)
{
    if (timeoutCts.IsCancellationRequested)
        throw new TimeoutException(
            "Операция завершилась по тайм-ауту через 5 секунд.", ex);

    // Вызывающий код отменил -- перебрасываем без обёртки, чтобы токен
    // вызывающего кода распространился без изменений
    throw;
}
```

Это важно, когда вызывающий код не знает о внутреннем `CancellationTokenSource`. Вызывающий код, перехватывающий `TimeoutException`, не должен инспектировать токены, которые он никогда не создавал.

При использовании связанного CTS проверяйте `timeoutCts.IsCancellationRequested` напрямую. Не сравнивайте `ex.CancellationToken` со связанным токеном -- `ex.CancellationToken` содержит тот составной токен, который сработал первым (вызывающего кода, тайм-аутный или связанный), что зависит от состояния гонки.

## Task.WaitAsync для кода без параметра токена

Не все API принимают `CancellationToken`. В .NET 6 добавлен `Task.WaitAsync` для таких случаев:

```csharp
// .NET 11, C# 14 -- обёртка для устаревшего API без токена
Task<string> slowWork = LegacyApiAsync();

try
{
    string result = await slowWork.WaitAsync(TimeSpan.FromSeconds(5));
}
catch (TimeoutException)
{
    // Дедлайн истёк. slowWork ВСЁ ЕЩЁ ВЫПОЛНЯЕТСЯ в фоне.
    Console.WriteLine("Прекращаем ожидание через 5 секунд.");
}
```

`WaitAsync(TimeSpan)` выбрасывает `TimeoutException` (не `OperationCanceledException`) и не отменяет базовую задачу. Работа продолжается до самостоятельного завершения. Используйте `WaitAsync` только тогда, когда не можете передать токен в вызываемый код; потребление ресурсов продолжается в любом случае.

Комбинированная перегрузка принимает как дедлайн, так и `CancellationToken`:

```csharp
// .NET 11, C# 14 -- поддерживает отмену И ограничение по времени
await slowWork.WaitAsync(TimeSpan.FromSeconds(5), callerToken);
```

Эта перегрузка выбрасывает `TimeoutException`, если первым истекает дедлайн, или `TaskCanceledException` (подкласс `OperationCanceledException`), если первым срабатывает токен.

## Сброс и отключение существующего тайм-аута

`CancelAfter` можно вызывать многократно. Каждый вызов заменяет ранее запланированный дедлайн:

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));   // начальный дедлайн: 10с

// Продлить: перезапустить таймер с окном 5 секунд с текущего момента
cts.CancelAfter(TimeSpan.FromSeconds(5));

// Полностью отключить тайм-аут без отмены CTS:
cts.CancelAfter(Timeout.InfiniteTimeSpan);   // больше не срабатывает
```

`Timeout.InfiniteTimeSpan` равно `-1` миллисекундам, что отключает внутренний таймер без перевода CTS в состояние отмены.

После отмены CTS вызов `CancelAfter` не имеет никакого эффекта. Проверяйте `IsCancellationRequested` заранее, если отмена могла уже произойти.

## TryReset для пула объектов

В высокопроизводительном коде, выполняющем множество коротких операций, создание нового `CancellationTokenSource` на каждый запрос приводит к выделениям памяти. В .NET 6 добавлен `TryReset` для повторного использования:

```csharp
// .NET 11, C# 14 -- паттерн пула CTS
private CancellationTokenSource _cts = new();

public async Task ProcessRequestAsync()
{
    if (!_cts.TryReset())
        _cts = new CancellationTokenSource();

    _cts.CancelAfter(TimeSpan.FromSeconds(5));

    await DoWorkAsync(_cts.Token);
}
```

`TryReset` возвращает `true`, если CTS не был отменён и его можно безопасно переиспользовать; `false` -- если был отменён и требуется новый экземпляр. Метод не является потокобезопасным при одновременных запросах на отмену -- вызывайте его только после завершения предыдущей операции, единственным владельцем. ASP.NET Core использует этот паттерн внутри Kestrel.

## Тестируемые тайм-ауты с TimeProvider

Ждать 5 реальных секунд в модульном тесте медленно и ненадёжно. `TimeProvider`, введённый в .NET 8 и стабильный в .NET 11, делает внутренний таймер внедряемым:

```csharp
// .NET 11, C# 14
public async Task<string> FetchAsync(
    string url,
    TimeProvider? clock = null)
{
    clock ??= TimeProvider.System;
    using var cts = clock.CreateCancellationTokenSource(TimeSpan.FromSeconds(5));

    using HttpClient http = new();
    return await http.GetStringAsync(url, cts.Token);
}
```

В тестах внедряйте `FakeTimeProvider` из NuGet-пакета `Microsoft.Extensions.TimeProvider.Testing`:

```csharp
// xUnit, .NET 11, C# 14
[Fact]
public async Task FetchAsync_ThrowsOnTimeout()
{
    var clock = new FakeTimeProvider();
    Task<string> fetch = FetchAsync("https://slow.example.com", clock);

    clock.Advance(TimeSpan.FromSeconds(10));  // мгновенно перематываем на 10 секунд

    await Assert.ThrowsAsync<OperationCanceledException>(() => fetch);
}
```

Отмена срабатывает синхронно при перемотке часов. Без `Task.Delay`. Без нестабильного времени выполнения тестов.

## Освобождение CTS

`CancellationTokenSource` реализует `IDisposable`, а не `IAsyncDisposable`. Метода `DisposeAsync` не существует. При вызове `CancelAfter` в очереди таймеров пула потоков регистрируется таймер. Этот таймер удерживает ссылку на CTS, предотвращая сборку мусора до его срабатывания.

Всегда освобождайте ресурсы:

```csharp
// Правильно: гарантированная очистка даже при исключении
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await DoWorkAsync(cts.Token);
// cts.Dispose() вызывается здесь; таймер отменяется и освобождается
```

При освобождении отменяется ожидающий таймер, освобождаются дескрипторы ожидания и CTS удаляется из любой цепочки `CreateLinkedTokenSource`, к которой он принадлежит. На сервере, обрабатывающем тысячи одновременных запросов, утечки экземпляров CTS приводят к накоплению таймеров.

## Типичные ошибки

**HttpClient.Timeout конкурирует с вашим токеном.** `HttpClient.Timeout` по умолчанию равен 100 секундам. Если вы также передаёте токен с `CancelAfter`, работают два таймера. При срабатывании `HttpClient.Timeout` выбрасывается `TaskCanceledException`, где `ex.InnerException is TimeoutException`; при срабатывании вашего токена -- `OperationCanceledException`, где `ex.CancellationToken == cts.Token`. Отключите одно из двух: либо установите `HttpClient.Timeout` в `Timeout.InfiniteTimeSpan` и управляйте дедлайном самостоятельно, либо полагайтесь на `HttpClient.Timeout` и откажитесь от ручного CTS. Подробнее см. [Fix: TaskCanceledException в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

**CancelAfter после Cancel не имеет эффекта.** После перевода CTS в состояние отмены вызов `CancelAfter` ничего не делает. Отмена -- это однонаправленный переход.

**Маршалинг на поток пользовательского интерфейса.** В WinForms, WPF или MAUI продолжение после отменённого `await` выполняется на потоке пула, захватившем завершение, а не на потоке пользовательского интерфейса. Если вы обновляете элементы UI в блоке catch, явно переключитесь на нужный поток. В ASP.NET Core `SynchronizationContext` не установлен, поэтому [ConfigureAwait(false) не имеет эффекта](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/).

**Не передавайте один токен в параллельные ветви непреднамеренно.** При распределении работы с помощью `Task.WhenAll` и передаче одного `cts.Token` во все ветви первая отмена отменит все остальные. Обычно это желаемое поведение для общего дедлайна, но делайте это осознанно.

## Связанные статьи

- Передача единственного `CancellationToken` через каждый асинхронный уровень: [Как передавать CancellationToken через асинхронные методы в .NET 11](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- Ручная отмена без дедлайна: [Как отменить долго выполняющуюся задачу в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- Три причины, по которым HttpClient выбрасывает TaskCanceledException: [Fix: TaskCanceledException в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- ConfigureAwait(false) в коде библиотек: [ConfigureAwait(false) против значения по умолчанию в .NET 11](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- async void vs async Task -- какой распространяет исключения: [async void vs async Task в C#: когда что использовать](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)

## Источники

- [CancellationTokenSource.CancelAfter -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelafter)
- [CancellationTokenSource.TryReset -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.tryreset)
- [Task.WaitAsync -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [TimeProvider.CreateCancellationTokenSource -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider.createcancellationtokensource)
- [Microsoft.Extensions.TimeProvider.Testing на NuGet](https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing)
