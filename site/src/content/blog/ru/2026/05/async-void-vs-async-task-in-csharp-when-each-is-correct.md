---
title: "async void vs async Task в C#: когда какой вариант правильный"
description: "async Task - значение по умолчанию, а async void - исключение. Используйте async void только для обработчиков событий, обработчиков верхнего уровня в цикле сообщений и небольшого набора колбэков фреймворка, которые требуют сигнатуры void. Везде остальном async Task выигрывает по обработке исключений, композиции и тестируемости."
pubDate: 2026-05-20
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct"
translatedBy: "claude"
translationDate: 2026-05-20
---

Если вы выбираете между `async void` и `async Task` для метода, который собираетесь написать на C# 14 / .NET 10, ответ - `async Task`. Единственные законные причины объявлять `async void` - это обработчики событий, подключённые к событию через `+=`, обработчики верхнего уровня в цикле сообщений (нажатие кнопки WinForms, обработчик `Loaded` в WPF, событие страницы в MAUI) и крошечный набор колбэков фреймворка, чья сигнатура зафиксирована внешним контрактом (`ICommand.Execute`, некоторые тестовые fixtures, отдельные тестовые runner'ы). Для всего, что вы вызываете сами, правильным является `async Task`, потому что исключения становятся ловимыми, точка вызова может ожидать завершения через `await`, а метод становится компонуемым с `Task.WhenAll`, отменой и модульными тестами.

Эта статья - длинная версия данного ответа. Всё ниже использует `<TargetFramework>net10.0</TargetFramework>` и `<LangVersion>14.0</LangVersion>`, если не указано иное, но правила не менялись с момента добавления async в C# 5.0.

## Матрица возможностей

| Возможность                                      | `async void`                                                   | `async Task`                                |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| Вызывающий может использовать `await`            | нет                                                            | да                                          |
| Вызывающий может перехватить брошенные исключения через `catch` | нет, распространяются на `SynchronizationContext` / `AppDomain` | да, перехватываются в возвращаемом `Task` |
| Компонуемость с `Task.WhenAll` / `.WhenAny`      | нет                                                            | да                                          |
| Тестируемость на завершение / результат          | нет, возвращается немедленно                                   | да, сделайте `await` возвращаемого `Task`   |
| Срабатывает `SynchronizationContext.OperationStarted/Completed` | да                                              | нет                                         |
| Переживает необработанное исключение             | по умолчанию аварийно завершает процесс начиная с .NET Framework 4.5 | нет, исключение остаётся на `Task` до наблюдения |
| Сигнатура, совместимая с событиями C#            | да (`EventHandler` возвращает `void`)                          | нет                                         |
| Допустимо в интерфейсах / виртуальных override, где контракт говорит `void` | да                                | только если контракт возвращает `Task`      |

Таблица - это и есть статья. Всё ниже - объяснение почему.

## Почему `async void` враждебен к вызывающим

Компилятор C# переписывает методы `async` в машину состояний, передающую свою работу `AsyncMethodBuilder`. Для методов `async Task` builder'ом является [`AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder), который предоставляет свойство `Task`. Когда машина состояний завершается, builder вызывает `SetResult` или `SetException` на этой задаче, и любой вызывающий, удерживающий ссылку, наблюдает результат.

Для `async void` builder'ом является [`AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder). У него нет `Task`, который можно вернуть. Из этого следуют три конкретных последствия.

Во-первых, у точки вызова нет дескриптора, который можно ожидать. Если вы пишете `DoStuffAsync();`, а `DoStuffAsync` возвращает `void`, строка завершается, когда первый `await` внутри метода приостанавливается, а не когда работа метода заканчивается. Следующая инструкция выполняется немедленно, даже если метод ещё не сделал свою работу. Это причина классического бага "данных уже нет, когда я их читаю".

Во-вторых, исключения, брошенные внутри метода `async void`, нигде не сохраняются. `AsyncVoidMethodBuilder.SetException` отправляет их в `SynchronizationContext`, который был текущим при старте метода. В процессе WinForms или WPF это означает цикл сообщений UI-потока, который вызывает `Application.ThreadException` (WinForms) или `Application.DispatcherUnhandledException` (WPF). В консольном приложении или фоновом контексте ASP.NET Core synchronization context равен null, поэтому исключение помещается в очередь пула потоков, который выставляет его на `AppDomain.CurrentDomain.UnhandledException` и, начиная с .NET Framework 4.5 и каждого релиза .NET 5+, завершает процесс. Нет `try/catch` на точке вызова, который мог бы вас спасти, потому что исключение никогда не проходит через точку вызова.

В-третьих, метод вызывает [`SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted) на старте и `OperationCompleted` в конце. Большинство контекстов игнорируют эти вызовы. Исключения - это контексты в стиле `AsyncOperationManager`, используемые `xUnit` и несколькими тестовыми фреймворками: они подсчитывают невыполненную асинхронную работу, чтобы тестовый runner знал, когда считать тест завершённым. Для метода `async void` runner будет ждать. Для обычных вызывающих эта работа теряется впустую.

## Минимальное воспроизведение: падение, которое нельзя поймать

```csharp
// .NET 10, C# 14, console app
using System;
using System.Threading.Tasks;

try
{
    Boom();
    await Task.Delay(100);
}
catch (Exception ex)
{
    Console.WriteLine($"caught: {ex.Message}");
}

static async void Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async void");
}
```

Запустите это. Вывод - не "caught: from async void". Это трассировка необработанного исключения, и процесс завершается с ненулевым кодом. Блок `catch` выше никогда не видит исключение, потому что исключение бросается на воркере пула потоков, возобновившем машину состояний после `Task.Yield`, а не на стеке исходного вызывающего.

Замените одно ключевое слово:

```csharp
// .NET 10, C# 14
static async Task Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async Task");
}
```

Теперь `await Boom();` на точке вызова перехватывает исключение, и даже `Boom();` без `await` не завершит процесс аварийно: исключение сидит на ненаблюдаемом `Task`, пока кто-нибудь его не понаблюдает либо `Task` не финализируется (что по умолчанию также больше не завершает процесс с тех пор, как значение по умолчанию `<ThrowUnobservedTaskExceptions>` переключилось на `false` в .NET 4.5).

## Когда `async void` корректен

Есть ровно три категории, в которых `async void` уместен. Будьте строги в том, чтобы оставаться внутри них.

**Обработчики событий, подключённые к CLR-событию.** Делегат `EventHandler` возвращает `void`. Вы не можете заставить метод возвращать `Task` и при этом подписаться через `+=`. Если вы пишете обработчик `Button.Click`, обработчик `Window.Loaded`, обработчик MAUI `Page.Appearing` или любую сигнатуру вида `void (object?, EventArgs)`, он должен быть `async void`. Фреймворк (WinForms, WPF, MAUI, Avalonia, Uno) вызывает событие на UI-потоке, и synchronization context отправляет необработанные исключения обратно в событие необработанных исключений диспетчера UI-потока, которое большинство приложений уже логирует. Держите обработчик тонким и делегируйте работу методу `async Task`, как только сделаете формирование аргументов:

```csharp
// .NET 10, MAUI, C# 14
private async void OnSaveClicked(object? sender, EventArgs e)
{
    try
    {
        await SaveAsync(_viewModel.Form);
    }
    catch (Exception ex)
    {
        await DisplayAlert("Save failed", ex.Message, "OK");
    }
}

private async Task SaveAsync(FormData form)
{
    using var http = _httpFactory.CreateClient("api");
    var response = await http.PostAsJsonAsync("/forms", form);
    response.EnsureSuccessStatusCode();
}
```

`try/catch` обязателен в обработчике. Обработчик - единственное место, где у вас есть шанс наблюдать исключение до того, как runtime превратит его в падение, так что не оставляйте его пустым.

**Колбэки верхнего уровня цикла сообщений.** Некоторые фреймворки предоставляют точки подключения, которые выглядят как события, но на самом деле являются делегатами с сигнатурой `void`: обработчик `Executed` маршрутизируемой команды, override `ICommand.Execute(object)` (интерфейс возвращает `void`), обработчик `BackgroundWorker.DoWork`, обработчик `Timer.Elapsed` с сигнатурой в стиле `System.Timers.Timer` и так далее. Правило то же, что и для событий: держите их тонкими и оборачивайте в `try/catch`.

**Колбэки фреймворка, чей контракт зафиксирован.** xUnit 2 вызывает `IAsyncLifetime.InitializeAsync` и `DisposeAsync` как `Task`, но некоторые хуки в стиле атрибутов в тестовых runner'ах всё ещё ожидают метод `void`, а некоторые хуки IoC-контейнеров (`IHostedService` из `Microsoft.Extensions.Hosting` возвращает `Task`, но более старый колбэк `IApplicationLifetime.ApplicationStarted` возвращает `void`). Если сигнатура сторонней библиотеки говорит `void`, выбора нет. Задокументируйте это в комментарии, чтобы будущий читатель не "починил" это.

Всё остальное - `async Task`.

## Что вы теряете, прибегая к `async void`

Если методу нужно громко падать при ошибке, он не возвращает ничего значимого, и вы прибегаете к `async void`, чтобы пропустить церемонию `await`, вы подписались на:

- **Потерянные трассировки стека.** Исключение, всплывающее на synchronization context, теряет исходный стек точки вызова. Вы видите перебрасываемый кадр, а не "это было вызвано из `OnSaveClicked`".
- **Никакой отмены.** Вы не можете пропустить отмену через метод, потому что у вызывающего нет `Task`, который можно ожидать. Аргумент `CancellationToken` всё ещё работает внутри метода, но вызывающий не может реагировать на `OperationCanceledException`, так как оно никогда не распространяется обратно.
- **Никакого таймаута через `Task.WhenAny`.** Распространённый шаблон - `await Task.WhenAny(work, Task.Delay(timeout, ct))`. Для этого вам нужен `Task`. У `async void` его нет.
- **Никаких тестов на завершение.** xUnit, NUnit и MSTest могут ожидать `async Task`-метод теста и наблюдать его результат. Они не могут ожидать `async void`-тест. Некоторые фреймворки делают особые случаи для `async void`-тестовых методов (старый NUnit, MSTest v2 с особенностями адаптера); ни один не рекомендует это. Смотрите более детальный шаблон в [как тестировать код, использующий HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), где каждый тест - `async Task`.
- **Fire-and-forget, который также fire-and-crash.** Многие шаблоны "fire-and-forget" молча становятся вызовами `async void`, когда разработчики забывают `await`. Решение - не `async void`; решение - явный discard `_ = SomeAsync();` и принятие того, что получаемый `Task` не наблюдается, или, что лучше, передача задачи в известное место, которое её наблюдает (логгер, фоновая очередь).

## Бенчмарк: экономит ли что-нибудь `async void`?

Иногда аргумент в пользу `async void` - "это дешевле, потому что нет аллокации `Task`". Давайте измерим.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
// dotnet add package BenchmarkDotNet
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<AsyncShapes>();

[MemoryDiagnoser]
public class AsyncShapes
{
    [Benchmark(Baseline = true)]
    public async Task ReturnsTask()
    {
        await Task.Yield();
    }

    [Benchmark]
    public void ReturnsVoid()
    {
        DoVoid();

        static async void DoVoid() => await Task.Yield();
    }
}
```

Методология: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X, однопоточный синхронный benchmark-harness. Оба метода выполняют один `Task.Yield`, что вынуждает continuation на пуле потоков.

| Метод       | Среднее    | Аллоцировано |
| ----------- | ---------- | ------------ |
| ReturnsTask | 1.34 us    | 152 B        |
| ReturnsVoid | 1.29 us    | 136 B        |

Версия `async void` экономит 16 байт (один экземпляр `Task`) и примерно на 4% быстрее, что несущественно по сравнению с прыжком в пул потоков. Современные runtime'ы делают pooling `AsyncTaskMethodBuilder.Task` для негенерических завершённых задач, поэтому разница в аллокациях в установившемся режиме даже меньше, чем показывает микробенчмарк. Аргумент производительности в пользу `async void` нереален.

## Подвох, который решает за вас

Если вас тянет к `async void` для не-событийного метода, две вещи должны изменить ваше мнение моментально.

Первое - fire-and-forget-задачи, охватывающие время жизни запроса. ASP.NET Core по умолчанию не даёт вам `SynchronizationContext`, поэтому исключение в `async void` всплывает в `ThreadPool.UnobservedExceptionEvent` и, в зависимости от ваших настроек `<ServerGarbageCollection>`, может уронить с собой worker-процесс. В тот момент, когда вы решаете "запустить какую-то фоновую работу из контроллера", переключайтесь на `IHostedService` или, для разового запуска, возвращайте `Task` фреймворку через что-то, что его наблюдает (`BackgroundService`, очередь, осведомлённая об `IHostApplicationLifetime`, [Channels](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)).

Второе - интерфейсы. Если вы когда-либо захотите, чтобы метод был мокаемым или частью контракта, он должен что-то возвращать. `Task` - стандартный тип возврата для асинхронной операции, не производящей значения. `void` не может быть ожидаем через `await` мок-объектом или fake, и вы не сможете координировать настройку теста вокруг него. Шаблон мокинга в [как мокать DbContext без поломки отслеживания изменений](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) опирается на члены, возвращающие `Task`, по той же причине.

## Категоричная рекомендация, ещё раз

По умолчанию используйте `async Task`. Используйте `async void` для ровно трёх категорий выше: обработчики CLR-событий, колбэки в стиле цикла сообщений или команд, чья сигнатура зафиксирована фреймворком, и сторонние хуки, требующие `void`. Оборачивайте каждый `async void` в `try/catch` и делегируйте работу хелперу `async Task`, как только вы сформировали аргументы вызова. Если вы видите `async void` на методе, который вы написали сами по любой другой причине, относитесь к этому как к скрытому падению процесса и меняйте.

Два следствия, которые стоит закрепить в мышечной памяти:

- `async void`, который выполняет `I/O` и забывает `try/catch`, - это падение, ожидающее `await`. Машине состояний некуда положить брошенное исключение, кроме synchronization context, а большинство контекстов в современном .NET трактуют это как фатальное.
- `async Task`, который вы никогда не ожидаете через `await`, - это не то же самое, что `async void`. `Task` всё равно перехватывает исключение; оно просто сидит там до наблюдения или финализации. Используйте `_ = SomeAsync();` только тогда, когда вы уверены в времени жизни, и предпочитайте передавать `Task` инфраструктуре фоновой очереди, которая им владеет.

## Связанное

- [Как отменить долго выполняющуюся Task в C# без deadlock'а](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Как использовать Channels вместо BlockingCollection в C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)
- [Как тестировать код, использующий HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException: A task was canceled в HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Fix: InvalidOperationException: Synchronous operations are disallowed в ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)

## Источники

- [Типы возврата async -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-return-types)
- [Stephen Cleary, "Async/Await -- Best Practices in Asynchronous Programming"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [Stephen Cleary, "Async OOP 5: Events"](https://blog.stephencleary.com/2013/02/async-oop-5-events.html)
- [Справочник `AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder)
- [Справочник `AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder)
- [Справочник `SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted)
