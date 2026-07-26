---
title: "Как тестировать зависящий от времени код с TimeProvider и FakeTimeProvider в .NET 11"
description: "Замените DateTime.UtcNow, Stopwatch и Task.Delay на System.TimeProvider, чтобы тесты управляли часами: регистрация во внедрении зависимостей, FakeTimeProvider.Advance и SetUtcNow, тестирование таймаутов и BackgroundService на PeriodicTimer, а также подводные камни с продолжениями после Advance и с xUnit v2."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "async"
  - "timeprovider"
lang: "ru"
translationOf: "2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Чтобы тестировать зависящий от времени код в .NET 11, перестаньте вызывать `DateTime.UtcNow`, `Stopwatch` и `Task.Delay(...)` напрямую и принимайте `System.TimeProvider` через конструктор. В продакшене вы регистрируете `TimeProvider.System` как singleton, а в тестах передаёте `FakeTimeProvider` из пакета `Microsoft.Extensions.TimeProvider.Testing` и управляете часами сами через `Advance(TimeSpan)` и `SetUtcNow(DateTimeOffset)`. Проверка истечения пробного периода, которая раньше требовала ждать 14 дней, превращается в тест из двух строк. Эта статья разбирает весь паттерн на .NET 11 (на момент написания Preview 6, финальный выпуск в ноябре 2026 года) с C# 14 и `Microsoft.Extensions.TimeProvider.Testing` 10.8.0, включая болезненные места: перескок сразу через несколько периодов таймера, продолжения, которые не выполняются после `Advance`, и зависание из-за контекста синхронизации в xUnit v2.

`TimeProvider` поставляется в составе платформы начиная с .NET 8 (`System.Runtime.dll`), поэтому всё описанное здесь без изменений работает и на .NET 8, 9 и 10. Для .NET Framework 4.6.2+, .NET 5-7 и netstandard2.0 существует пакет `Microsoft.Bcl.TimeProvider` с одним отличием в API, о котором сказано в конце.

## Почему статические часы делают тест невыполнимым

Такой код есть где-нибудь в любой кодовой базе:

```csharp
// .NET 11, C# 14 -- untestable
public sealed class TrialService
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        DateTimeOffset.UtcNow - user.SignedUpAt >= TrialLength;
}
```

`DateTimeOffset.UtcNow` -- это статическое свойство, за которым стоят часы операционной системы. Точки расширения нет. Чтобы задействовать ветку истечения, остаются три плохих варианта: ждать две недели, сдвинуть `user.SignedUpAt` назад (что проверяет вычитание, но никогда не момент перехода), или взять фреймворк мокинга, патчащий статику, который тянет за собой перехватчик на основе профилировщика и замедляет весь набор тестов.

Ошибки живут именно на границе. День 14 уже истёк или ещё активен? Что происходит ровно в `SignedUpAt + 14 days`? А при переходе на летнее время в локальной зоне пользователя? Ни на один из этих вопросов нельзя ответить, пока часы принадлежат машине.

## Что на самом деле абстрагирует TimeProvider

`TimeProvider` -- абстрактный класс с пятью возможностями, и знать стоит все, потому что большинство берёт на вооружение только первую:

- `GetUtcNow()` и `GetLocalNow()` возвращают `DateTimeOffset`. Это замена `DateTimeOffset.UtcNow` и `DateTime.Now`.
- `GetTimestamp()` возвращает высокочастотный счётчик тиков, а `GetElapsedTime(long)` / `GetElapsedTime(long, long)` превращают два таких значения в `TimeSpan`. Это замена `Stopwatch`.
- `CreateTimer(TimerCallback, object?, TimeSpan, TimeSpan)` возвращает `ITimer`. Это замена `System.Threading.Timer`.
- `LocalTimeZone` возвращает `TimeZoneInfo`. Это замена `TimeZoneInfo.Local`.
- `TimestampFrequency` сообщает частоту тиков, лежащую в основе `GetTimestamp()`.

Реализация по умолчанию -- статическое свойство `TimeProvider.System`: UTC берётся из `DateTimeOffset.UtcNow`, зона из `TimeZoneInfo.Local`, метки времени из `Stopwatch`, таймеры из `System.Threading.Timer`. Её использование не стоит ничего по сравнению с прямыми вызовами, потому что это тонкий слой перенаправления ровно к этим вызовам.

`CreateTimer` важен потому, что BCL встроила `TimeProvider` и в асинхронные примитивы. Эти перегрузки принимают `TimeProvider` и проводят через него свой внутренний таймер:

- `Task.Delay(TimeSpan, TimeProvider)` и `Task.Delay(TimeSpan, TimeProvider, CancellationToken)`
- `Task.WaitAsync(TimeSpan, TimeProvider)` и её перегрузка с `CancellationToken`
- `new CancellationTokenSource(TimeSpan, TimeProvider)`
- `new PeriodicTimer(TimeSpan, TimeProvider)`

Так что цикл повторов с задержкой, дедлайн запроса и фоновый сервис с опросом становятся управляемыми из теста без единого `Thread.Sleep`.

## Шаги, чтобы сделать зависящий от времени класс тестируемым

1. Добавьте параметр `TimeProvider` в конструктор класса, который читает часы. Не задавайте ему значение по умолчанию `TimeProvider.System`, иначе нетестируемый путь останется случайно достижимым.
2. Замените внутри этого класса каждый `DateTime.UtcNow`, `DateTimeOffset.Now`, `Stopwatch.StartNew()`, `new Timer(...)` и голый `Task.Delay(...)` на эквивалент из `TimeProvider`.
3. Зарегистрируйте настоящие часы в корне композиции: `builder.Services.AddSingleton(TimeProvider.System);`.
4. Добавьте `Microsoft.Extensions.TimeProvider.Testing` в тестовый проект.
5. В каждом тесте создайте `FakeTimeProvider`, зафиксируйте начальный момент и двигайте часы между проверками через `Advance` или `SetUtcNow`.

Остальная часть статьи разворачивает каждый из этих шагов в рабочий код.

## Переписываем сервис так, чтобы он принимал часы

```csharp
// .NET 11, C# 14
public sealed class TrialService(TimeProvider timeProvider)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        timeProvider.GetUtcNow() - user.SignedUpAt >= TrialLength;
}
```

Это всё изменение в продакшен-коде. Первичный конструктор захватывает провайдер, а единственное отличие в месте вызова -- `timeProvider.GetUtcNow()` вместо `DateTimeOffset.UtcNow`.

Регистрация занимает одну строку, потому что `TimeProvider.System` -- singleton, который безопасно разделять во всём приложении:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<TrialService>();

var app = builder.Build();
```

Собственные компоненты ASP.NET Core уже ищут эту регистрацию. Начиная с .NET 8 интерфейс `ISystemClock` объявлен устаревшим во всём стеке аутентификации и Identity, а классы параметров вместо него предоставляют записываемое свойство `TimeProvider`, которое разрешается из контейнера, если вы его зарегистрировали. Регистрация `TimeProvider.System` тем самым делает тестируемыми и проверку времени жизни токенов, и истечение cookie.

## Первый тест с FakeTimeProvider

```
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

Версия 10.8.0 актуальна на июль 2026 года. Она нацелена на .NET 8.0 и новее, а также на .NET Framework 4.6.2 и новее, и на современном .NET не тянет зависимостей.

```csharp
// .NET 11, C# 14, xUnit v3, Microsoft.Extensions.TimeProvider.Testing 10.8.0
using Microsoft.Extensions.Time.Testing;

public class TrialServiceTests
{
    [Fact]
    public void Trial_is_active_on_day_13_and_expired_on_day_14()
    {
        var time = new FakeTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 0, 0, TimeSpan.Zero));

        var user = new User(SignedUpAt: time.GetUtcNow());
        var sut = new TrialService(time);

        time.Advance(TimeSpan.FromDays(13));
        Assert.False(sut.IsTrialExpired(user));

        time.Advance(TimeSpan.FromDays(1));
        Assert.True(sut.IsTrialExpired(user));
    }
}
```

Никакого сна, никакой подтасовки дат, и граница на 14-м дне проверяется явно. Три детали `FakeTimeProvider` стоит усвоить сразу:

**Конструктор без параметров стартует с полуночи 1 января 2000 года UTC.** Это сделано намеренно: фиксированный, очевидно синтетический момент, который никогда случайно не совпадёт с "сегодня". Передавайте `DateTimeOffset` в конструктор, когда сама дата является частью проверяемого поведения, например високосный день или переход через конец месяца.

**`LocalTimeZone` по умолчанию равна `TimeZoneInfo.Utc`, а не зоне машины.** Поэтому `GetLocalNow()` совпадает с `GetUtcNow()`, пока вы не вызовете `SetLocalTimeZone(...)`. Именно это делает чувствительные к часовому поясу тесты детерминированными на агенте сборки, находящемся в другом регионе, чем ваш ноутбук:

```csharp
// .NET 11, C# 14 -- pin the zone so a CI agent in UTC behaves like a user in Bucharest
var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 3, 30, 0, TimeSpan.Zero));
time.SetLocalTimeZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Bucharest"));

Assert.Equal(new TimeSpan(2, 0, 0), time.GetLocalNow().Offset); // after the DST fall-back
```

**`SetUtcNow` двигается только вперёд.** Передача значения раньше текущего времени бросает `ArgumentOutOfRangeException` с сообщением "Cannot go back in time.". Если вам действительно нужно смоделировать оператора или демон NTP, переводящий часы назад, используйте `AdjustTime(DateTimeOffset)`. `AdjustTime` сдвигает текущее время, не срабатывая ни на одном ожидающем таймере, и сдвигает точку пробуждения каждого ожидающего таймера на ту же дельту, как и происходит при реальном изменении системных часов.

## Тестируем таймаут вместо того, чтобы его ждать

Интересны не метки времени, а ожидания. Политика повторов с экспоненциальной задержкой обычно тратит на тест секунды реального времени. Проведите её ожидание через провайдер, и уйдут микросекунды:

```csharp
// .NET 11, C# 14
public sealed class RetryingFetcher(HttpClient http, TimeProvider timeProvider)
{
    public async Task<string> FetchAsync(string url, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await http.GetStringAsync(url, ct);
            }
            catch (HttpRequestException) when (attempt < 3)
            {
                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt));
                await Task.Delay(backoff, timeProvider, ct);
            }
        }
    }
}
```

С дедлайнами то же самое. `new CancellationTokenSource(TimeSpan, TimeProvider)` даёт источник токенов, чей внутренний таймер управляется поддельными часами, так что весь паттерн `CancelAfter` для соблюдения асинхронного дедлайна становится проверяемым:

```csharp
// .NET 11, C# 14
[Fact]
public async Task Deadline_fires_after_five_seconds()
{
    var time = new FakeTimeProvider();
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);

    Assert.False(cts.IsCancellationRequested);

    time.Advance(TimeSpan.FromSeconds(5));

    Assert.True(cts.IsCancellationRequested);
}
```

## Тестируем BackgroundService, опрашивающий по таймеру

Опрашивающий worker на `PeriodicTimer` -- классический компонент из категории "это мы юнит-тестами не покрываем". С перегрузкой, принимающей `TimeProvider`, он становится обычным кодом:

```csharp
// .NET 11, C# 14
public sealed class ExpiryWorker(IExpiryStore store, TimeProvider timeProvider)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await store.PurgeExpiredAsync(timeProvider.GetUtcNow(), stoppingToken);
        }
    }
}
```

В тесте есть тонкость: worker должен дойти до `WaitForNextTickAsync` и зарегистрировать свой таймер до того, как вы сдвинете время, иначе вы перескочите тик, который никогда не был запланирован. Не решайте это через `Thread.Sleep`. Сначала уступите поток, потом сдвиньте время, потом дождитесь сигнала о том, что работа действительно выполнилась:

```csharp
// .NET 11, C# 14, xUnit v3
[Fact]
public async Task Worker_purges_once_per_five_minute_tick()
{
    var time = new FakeTimeProvider();
    var store = new RecordingExpiryStore(); // sets a TaskCompletionSource on each call
    var worker = new ExpiryWorker(store, time);

    await worker.StartAsync(CancellationToken.None);
    await Task.Yield(); // let ExecuteAsync reach WaitForNextTickAsync

    time.Advance(TimeSpan.FromMinutes(5));
    await store.NextPurge; // completes when PurgeExpiredAsync is entered

    Assert.Equal(1, store.PurgeCount);

    await worker.StopAsync(CancellationToken.None);
}
```

Ожидание сигнала, который поднимает продакшен-код, а не ожидание реального времени, и есть то, что не даёт этому тесту стать нестабильным на загруженном агенте CI. Та же дисциплина применима, когда тестируемый worker использует [сервисы с областью действия внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): разрешайте область внутри цикла, а затем проверяйте то, что эта область произвела.

## Advance срабатывает на периодических таймерах один раз за каждый прошедший период

Это поведение удивляет чаще всего. `FakeTimeProvider.Advance` проходит по списку ожидающих, вызывает каждый обратный вызов, чья точка пробуждения уже пройдена, а для периодического таймера прибавляет период к точке пробуждения и проверяет снова. Один вызов поэтому срабатывает на пятиминутном таймере двенадцать раз:

```csharp
// .NET 11, C# 14 -- twelve ticks, not one
time.Advance(TimeSpan.FromHours(1)); // PeriodicTimer period = 5 minutes
```

Для `PeriodicTimer` конкретно это не означает двенадцать итераций цикла, потому что `WaitForNextTickAsync` схлопывает тики, приходящие, пока никто не ждёт. Но для голого `ITimer` из `CreateTimer` с конечным периодом вы получите двенадцать вызовов обратного вызова, синхронно, в том потоке, который вызвал `Advance`. Если нужен ровно один тик, сдвигайте время ровно на один период.

Синхронность важна и по второй причине: любое исключение, брошенное внутри обратного вызова таймера, вылетает из вашего вызова `Advance`, а не из какого-то фонового потока, где оно было бы проглочено. Обычно это подарок, но это значит, что строка с `Advance` может бросить провал проверки, происходящий из кода несколькими слоями дальше.

## Продолжения, которые не выполняются после Advance

Самая часто сообщаемая проблема с `FakeTimeProvider` -- тест, который зависает или проверяет слишком рано после `Advance`; она заведена как [dotnet/extensions#5326](https://github.com/dotnet/extensions/issues/5326). Форма такая:

```csharp
// .NET 11, C# 14 -- flaky: the continuation may not have run yet
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
Assert.True(delayTask.IsCompleted); // not guaranteed
```

`Advance` завершает нижележащую задачу, но продолжение, прикреплённое где-то через `await`, только планируется, а не выполняется на месте. Решение -- ожидать то, что вас интересует, а не опрашивать флаг:

```csharp
// .NET 11, C# 14 -- deterministic
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
await delayTask; // returns immediately, and orders the continuation
```

Во многих примерах кода после `Advance` встречается `await Task.Delay(1)`. Это работает, потому что даёт планировщику настоящий ход, но возвращает в тест зависимость от реального времени, избавление от которой и было всей его целью. Лучше дождитесь самой операции или `TaskCompletionSource`, которую завершает продакшен-код.

Смежная ловушка -- `AutoAdvanceAmount`. Её установка заставляет часы двигаться вперёд при каждом *чтении* `GetUtcNow()` или `GetTimestamp()`, что удобно для кода, измеряющего интервал между двумя чтениями:

```csharp
// .NET 11, C# 14 -- every clock read advances by 100ms
var time = new FakeTimeProvider { AutoAdvanceAmount = TimeSpan.FromMilliseconds(100) };

long start = time.GetTimestamp();
long end = time.GetTimestamp();

Assert.Equal(TimeSpan.FromMilliseconds(100), time.GetElapsedTime(start, end));
```

Но автопродвижение не двигает таймеры, потому что никто не читает часы от имени таймера. `Task.Delay(TimeSpan, TimeProvider)` никогда не завершится на одном лишь автопродвижении: явный `Advance` всё равно нужен. Это различие стоит помнить до того, как потратить на него полдня.

## Зависание из-за контекста синхронизации в xUnit v2

Если тестовый проект всё ещё на xUnit v2, а тестируемый код использует `ConfigureAwait(false)`, тест с `FakeTimeProvider` может уйти во взаимную блокировку. xUnit v2 устанавливает `AsyncTestSyncContext` на время каждого теста, и взаимодействие этого контекста с выполняемыми на месте обратными вызовами таймера оставляет тест стоять навсегда. README пакета описывает обходной путь:

```csharp
// .NET 11, C# 14 -- xUnit v2 only
SynchronizationContext.SetSynchronizationContext(null);
```

Поставьте это в начало затронутого теста или в конструктор фикстуры. xUnit v3 полностью удалил `AsyncTestSyncContext`, так что там проблемы нет. Если вы выбираете тестовый фреймворк для нового проекта, это ещё один небольшой аргумент в пользу v3.

## Что переводить не стоит

`TimeProvider` -- это точка расширения, а не религия. Два правила удерживают его от расползания:

Внедряйте его в класс, который принимает *решение* на основе времени, а не в каждый класс, который просто передаёт метку времени дальше. DTO с полем `CreatedAt` часы не нужны, а фабрике, которая эту метку проставляет, нужны.

Не читайте часы дважды в одном методе, ожидая одинакового значения. `timeProvider.GetUtcNow()` -- это вызов метода, а не кешированное свойство, и с заданным `AutoAdvanceAmount` он намеренно возвращает разные значения. Прочитайте один раз в локальную переменную и работайте с ней: это хорошая практика и с `DateTime.UtcNow`, а здесь становится требованием корректности.

Наконец, на .NET Framework и netstandard2.0 через `Microsoft.Bcl.TimeProvider` асинхронных перегрузок в виде методов экземпляра не существует. Используйте вместо них методы расширения из `System.Threading.Tasks.TimeProviderTaskExtensions`: `timeProvider.Delay(...)`, `timeProvider.CreateCancellationTokenSource(...)` и `task.WaitAsync(timeout, timeProvider, ct)`. Поведение то же, отличается только форма вызова, так что библиотеке с несколькими целевыми платформами понадобится небольшой `#if` или общий вспомогательный метод.

## Похожие материалы

- Механика таймаутов, которую эта статья делает тестируемой, полностью разобрана в руководстве по [соблюдению асинхронного дедлайна с CancellationTokenSource.CancelAfter](/ru/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).
- Каждый из этих тестов зависит от того, дойдёт ли токен до операции, чему посвящена статья о [передаче CancellationToken через асинхронные методы](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Когда тестируемому коду нужна настоящая база данных, а не поддельные часы, смотрите [интеграционные тесты против настоящего SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Выбор того, где вообще должен жить цикл опроса, разобран в [BackgroundService vs IHostedService vs Hangfire](/ru/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).
- Блокирующее ожидание асинхронного вызова -- самый быстрый способ подвесить тест с `FakeTimeProvider` по причинам, никак не связанным с часами: смотрите [взаимную блокировку при вызове .Result или .Wait()](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

## Источники

- [TimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider) на Microsoft Learn
- [What is the TimeProvider class](https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview) в документации по основам .NET
- [Справочник по API FakeTimeProvider](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.time.testing.faketimeprovider)
- [README Microsoft.Extensions.TimeProvider.Testing](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/README.md) в dotnet/extensions
- [Исходный код FakeTimeProvider.cs](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/FakeTimeProvider.cs)
- [dotnet/extensions#5326: продолжения Task.Delay не выполняются при вызове Advance](https://github.com/dotnet/extensions/issues/5326)
- [Критическое изменение: ISystemClock объявлен устаревшим](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/8.0/isystemclock-obsolete)
