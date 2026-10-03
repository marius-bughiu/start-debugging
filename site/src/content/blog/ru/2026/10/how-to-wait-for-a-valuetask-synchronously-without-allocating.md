---
title: "Как синхронно дождаться ValueTask в неасинхронном методе без выделения памяти"
description: "Сначала проверьте IsCompleted и прочитайте результат через GetAwaiter().GetResult(): это стоит 0 байт. Блокируйтесь только если ValueTask ещё не завершён, и делайте это через кешированное событие и UnsafeOnCompleted вместо AsTask(), который выделяет от 72 до 208 байт на вызов. Измерено на .NET 10 и .NET 11 RC1."
pubDate: 2026-10-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "valuetask"
  - "performance"
lang: "ru"
translationOf: "2026/10/how-to-wait-for-a-valuetask-synchronously-without-allocating"
translatedBy: "claude"
translationDate: 2026-10-03
---

Чтобы прочитать `ValueTask<T>` из синхронного метода без выделения памяти, сначала проверьте `IsCompleted`. Если задача уже завершена, один раз вызовите `vt.GetAwaiter().GetResult()` и всё: 0 байт, около 3 нс. Если она ещё выполняется, придётся блокироваться. `vt.AsTask().GetAwaiter().GetResult()` - стандартный безопасный вариант, но он при каждом вызове выделяет обёртку `Task<T>`. Небольшой вспомогательный метод, который коротко крутится в цикле, а затем ждёт на кешированном `ManualResetEventSlim` через `UnsafeOnCompleted`, блокирует поток без единого выделения. Никогда не вызывайте `.Result` или `.GetAwaiter().GetResult()` у `ValueTask`, который ещё не завершился: для экземпляров на основе `IValueTaskSource` поведение не определено, а на практике выбрасывается `InvalidOperationException`. Все числа ниже измерены на Apple M4 с SDK 10.0.302 (.NET 10, C# 14) и повторены на SDK 11.0.100-rc.1.26425.128 (.NET 11 RC1).

## Чем блокировка на ValueTask отличается от блокировки на Task

`Task<T>` - ссылочный тип, который поддерживает блокирующее ожидание. `Task.Wait()`, `.Result` и `GetAwaiter().GetResult()` сначала недолго крутятся в цикле, затем паркуют поток на событии до завершения задачи. Вызывать их у незавершённой `Task` медленно и рискованно (взаимные блокировки, истощение пула потоков), но сам вызов определён: он ждёт.

`ValueTask<T>` - структура, которая оборачивает одно из трёх: обычный результат `T`, `Task<T>` либо `IValueTaskSource<T>` вместе с токеном `short`. Именно третий случай ломает блокировку. `IValueTaskSource<T>` предоставляет `GetStatus`, `OnCompleted` и `GetResult`, и ничто в этом контракте не требует, чтобы `GetResult` ждал. В [документации ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1) перечислены четыре вещи, которые нельзя делать с экземпляром, в том числе "Using `.Result` or `.GetAwaiter().GetResult()` when the operation hasn't yet completed", и прямо сказано, что в этом случае "the results are undefined". В [статье Стивена Тауба о дизайне ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) объясняется причина: источник "need not support blocking until the operation completes, and likely doesn't".

Источники, которые важны на практике, блокировку не поддерживают. `Socket`, `NetworkStream`, `System.IO.Pipelines` и `System.Threading.Channels` отдают `ValueTask` на основе пулируемых объектов `IValueTaskSource`, а большинство самописных источников используют `ManualResetValueTaskSourceCore<T>`, который выбрасывает исключение, если запросить результат слишком рано.

## Минимальный пример неопределённого поведения

Вот пулируемый источник, который завершается в пуле потоков, по тому же принципу, что и внутри `Socket`:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
using System.Threading.Tasks.Sources;

sealed class PooledSource : IValueTaskSource<int>, IThreadPoolWorkItem
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> StartAsync()
    {
        _core.Reset();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: false);
        return new ValueTask<int>(this, _core.Version);
    }

    void IThreadPoolWorkItem.Execute() { Thread.SpinWait(50); _core.SetResult(42); }

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> c, object? s, short token,
        ValueTaskSourceOnCompletedFlags f) => _core.OnCompleted(c, s, token, f);
}
```

Заблокируйтесь на нём так, как блокировались бы на `Task`:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
var src = new PooledSource();
int r = src.StartAsync().GetAwaiter().GetResult();
// System.InvalidOperationException:
//   Operation is not valid due to the current state of the object.
```

На обоих SDK исключение выбрасывается сразу. `ManualResetValueTaskSourceCore<T>.GetResult` проверяет, завершена ли операция, и выбрасывает исключение, если нет. Это ещё благоприятный исход. Самописный источник без такой защиты может вернуть `default(T)`, вернуть результат предыдущей операции, использовавшей тот же пулируемый объект, или повредить собственное состояние. Код, который "работает" при разработке, потому что операция случайно успевает завершиться быстро, может упасть в продакшене под нагрузкой. То же относится к необобщённой версии `ValueTask`.

## Шаг 1: бесплатно читаем завершённый ValueTask

Большинство API с `ValueTask` существуют потому, что обычно завершаются синхронно: попадание в кеш, чтение из буфера, канал, в котором уже есть элемент. В таком случае ждать нечего, и документация разрешает читать `.Result` или `GetAwaiter().GetResult()` после того, как экземпляр завершился. `SocketsHttpHandler` в `System.Net.Http` использует именно этот быстрый путь с `IsCompletedSuccessfully`.

```csharp
// .NET 10 / .NET 11 RC1, C# 14
ValueTask<int> vt = cache.GetAsync(key);

if (vt.IsCompleted)
{
    // Allowed: the operation is finished, and we consume it exactly once.
    int value = vt.GetAwaiter().GetResult();
}
```

В синхронном вспомогательном методе предпочитайте `IsCompleted` плюс `GetAwaiter().GetResult()`, а не `IsCompletedSuccessfully` плюс `.Result`. `IsCompleted` истинно также для завершённых с ошибкой и отменённых экземпляров, а `GetAwaiter().GetResult()` повторно выбрасывает исходное исключение (`InvalidOperationException` остаётся `InvalidOperationException`), как это сделал бы `await`. Если проверять только `IsCompletedSuccessfully`, `ValueTask`, завершившийся с ошибкой, попадёт в медленный путь и будет обёрнут в `Task` только ради того, чтобы вы увидели его исключение.

Вот что быстрый путь экономит по сравнению с обычным советом сначала вызвать `AsTask()`, для `ValueTask<int>`, который уже содержит значение 42 (200 000 итераций, `GC.GetTotalAllocatedBytes(precise: true)` до и после):

| Подход, уже завершённый `ValueTask<int>` | .NET 10 | .NET 11 RC1 |
| --- | --- | --- |
| `vt.AsTask().GetAwaiter().GetResult()` | 72 B, ~22 ns | 72 B, ~20 ns |
| `vt.IsCompleted`, затем `vt.GetAwaiter().GetResult()` | 0 B, ~3 ns | 0 B, ~3 ns |

`AsTask()` у `ValueTask`, хранящего значение, должен создать `Task<T>` через `Task.FromResult`, а среда выполнения кеширует такие задачи лишь для нескольких значений (`true`, `false` и малые целые от -1 до 8). Ваш объект `User` или число 42 каждый раз получают новую 72-байтную задачу. Для значения, которого не нужно было ждать, это выделение ничего не даёт.

## Шаг 2: блокируемся на незавершённом ValueTask без AsTask

Когда `IsCompleted` ложно, ждать придётся. Документированный безопасный вариант - `vt.AsTask().GetAwaiter().GetResult()`, и именно его рекомендует [сравнение .Result и GetAwaiter().GetResult()](/ru/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) для такой ситуации. Он корректен, но для экземпляра на основе `IValueTaskSource` `AsTask()` выделяет отдельный подкласс `Task<T>`, который регистрируется в источнике, а если ожидание длится достаточно долго, чтобы `Task` перестал крутиться в цикле и запарковал поток, механизм блокировки выделяет второй объект под событие.

Избежать обоих выделений можно, используя awaiter напрямую. `UnsafeOnCompleted` у awaiter регистрирует обычное продолжение `Action` в нижележащем источнике или задаче и не захватывает `ExecutionContext`. Если этот `Action` - кешированный делегат на кешированный `ManualResetEventSlim.Set`, регистрация ничего не выделяет:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
public static class ValueTaskSyncExtensions
{
    [ThreadStatic] private static ManualResetEventSlim? t_event;
    [ThreadStatic] private static Action? t_set;

    public static T WaitSync<T>(this ValueTask<T> task)
    {
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();   // fast path, 0 bytes

        // Short spin: many pending operations finish within microseconds.
        // Polling IsCompleted calls GetStatus, which may be called repeatedly.
        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);             // no ExecutionContext capture
        mres.Wait();
        return awaiter.GetResult();                 // consume exactly once
    }

    public static void WaitSync(this ValueTask task)
    {
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);
        mres.Wait();
        awaiter.GetResult();
    }
}
```

Детали, благодаря которым это корректно:

1. **Одно потребление.** `ValueTask` читается ровно один раз, через `GetResult()`, после срабатывания продолжения. Опрос `IsCompleted` потреблением не считается: он вызывает `GetStatus` у источника, а его разрешено вызывать многократно до чтения результата.
2. **Одно событие на поток.** Заблокированный поток может ждать только одного, поэтому достаточно события с `[ThreadStatic]`, а вложенные ожидания в том же потоке невозможны, пока он заблокирован. Кешированный делегат `Action` тоже создаётся один раз на поток.
3. **`ConfigureAwait(false)`.** Без него источнику велели бы выполнить продолжение в захваченном `SynchronizationContext`. В потоке UI этот контекст - тот самый поток, который вы блокируете, поэтому `Set` никогда не выполнился бы. С `ConfigureAwait(false)` продолжение выполняется там, где источник завершается.
4. **`UnsafeOnCompleted`, а не `OnCompleted`.** Безопасный вариант захватывает и восстанавливает `ExecutionContext`, что бессмысленно для делегата, который только устанавливает событие.
5. **Сначала крутимся, потом паркуемся.** Блокировка в `Task` сначала крутится в цикле, а потом засыпает, и этот вспомогательный метод должен делать так же. В первой версии моего бенчмарка я сразу парковал поток (`spinCount: 0`, без цикла ожидания), и на коротких операциях это было примерно вдвое медленнее `AsTask()`, потому что каждое ожидание оплачивало переход в ядро.

## Что показывают числа

Тот же стенд, 200 000 итераций для коротких операций и 2 000 для случая с 1 мс, байты на вызов измерены по всем потокам:

| Незавершённый `ValueTask<int>` | Подход | .NET 10 | .NET 11 RC1 |
| --- | --- | --- | --- |
| `IValueTaskSource`, завершается за микросекунды | `AsTask().GetAwaiter().GetResult()` | 80 B | 80 B |
| `IValueTaskSource`, завершается за микросекунды | `WaitSync()` | 0 B | 0 B |
| `IValueTaskSource`, завершается примерно через 1 мс | `AsTask().GetAwaiter().GetResult()` | 144 B | 208 B |
| `IValueTaskSource`, завершается примерно через 1 мс | `WaitSync()` | 0 B | 0 B |
| На основе `Task` (`Task.Run`) | `AsTask().GetAwaiter().GetResult()` | 72 B | 72 B |
| На основе `Task` (`Task.Run`) | `WaitSync()` | 72 B | 72 B |

Дробные байты, которые стенд показал для `WaitSync()` (от 0.1 до 0.3 B на вызов), - это служебные расходы пула потоков, а не выделения на каждый вызов. 72 B в строках для `Task` - это `Task<int>`, который создаёт сам `Task.Run`. Для `ValueTask` на основе `Task` метод `AsTask()` просто возвращает обёрнутую задачу, поэтому ни один из подходов ничего не добавляет.

Выигрыш вспомогательного метода не в задержке. На коротких операциях оба подхода занимали от 1 до 6 микросекунд на вызов, а разброс между запусками превышал разницу между ними. В случае с 1 мс оба отличались менее чем на 1%, потому что доминирует само ожидание. Если ваша цель - скорость, а не выделения, реально помогает только быстрый путь из шага 1, а дальше - не блокироваться вовсе.

Итак, честный вывод: проверка `IsCompleted` бесплатна и экономит 72 байта при каждом синхронном завершении, а это обычный случай для любого API, заслужившего возвращаемый тип `ValueTask`. Блокирующий вспомогательный метод экономит ещё от 80 до 208 байт на медленном пути, что имеет значение, только если сам медленный путь горячий.

## Подводные камни и особые случаи

**Это не устраняет взаимные блокировки при синхронном ожидании асинхронного кода.** `ConfigureAwait(false)` у *вашего* awaiter управляет только тем, где выполняется *ваше* продолжение. Если в асинхронном методе, на котором вы блокируетесь, есть `await` без `ConfigureAwait(false)`, а `WaitSync()` вызывается из потока WPF, WinForms, MAUI или классического ASP.NET, это внутреннее продолжение ставится в очередь потока, который вы только что заблокировали, и вы получаете взаимную блокировку точно так же, как с `.Result`. Механизм и способы исправления разобраны в статье [почему блокировка на асинхронном методе приводит к взаимной блокировке](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**Истощение пула потоков это тоже не устраняет.** Поток пула, запаркованный в `mres.Wait()`, - это поток, который пул не может использовать для выполнения того самого продолжения, которое его разбудит. Ноль выделений не означает нулевую стоимость. Применяйте это на настоящих синхронных границах (метод `Dispose`, синхронный интерфейс, которым вы не владеете, переопределение `Stream.Read`, реализованное поверх асинхронного ядра), а не как способ избежать перевода цепочки вызовов в асинхронный режим. Если границу можно сдвинуть, настоящее решение по-прежнему - [перевод блокирующих вызовов на async по всей цепочке](/ru/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/).

**Не трогайте ValueTask после `WaitSync()`.** После вызова `GetResult` пулируемый источник уже может обслуживать другую операцию. Скопировать структуру и дождаться копии позже - та же ошибка, что и двойной await. CA2012 ("Use ValueTasks correctly") ловит очевидные варианты, но не все, потому что анализатор не может проследить `ValueTask` через вспомогательный метод вроде этого. Полный контракт "один await" описан в [разборе ValueTask](/ru/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

**`Preserve()` - не обходной путь.** `ValueTask<T>.Preserve()` возвращает экземпляр, который можно потреблять многократно, но для незавершённого экземпляра на основе `IValueTaskSource` он делает это, вызывая `AsTask()` внутри, так что выделяет ту же обёртку, которой вы пытались избежать.

**Исключения приходят без обёртки.** Поскольку вспомогательный метод заканчивается на `GetAwaiter().GetResult()`, операция, завершившаяся с ошибкой, выбрасывает исходный тип исключения, как и `await`. На стенде `ValueTask<int>`, выбросивший `InvalidOperationException` после `Task.Yield()`, дошёл из `WaitSync()` как `InvalidOperationException`, а не как `AggregateException`.

**Отмена проявляется как `OperationCanceledException`.** Если операция была отменена, `GetResult` выбрасывает `TaskCanceledException` или `OperationCanceledException` в зависимости от источника. В приведённом выше вспомогательном методе нет перегрузки с тайм-аутом. Если она нужна, передайте тайм-аут в `mres.Wait`, а при тайм-ауте больше не обращайтесь к `ValueTask`: его продолжение всё ещё зарегистрировано и позже вызовет `Set` у вашего потокового события, поэтому перед следующим ожиданием в этом потоке нужно также заменить `t_event` и `t_set` новыми экземплярами.

**Если API ваш, подумайте, нужен ли там вообще `ValueTask`.** Метод, который регулярно потребляют синхронно, - это метод, чьи вызывающие борются с его возвращаемым типом. Либо добавьте синхронного соседа `TryGet` для быстрого пути, либо вернитесь к `Task<T>`, как описано в [миграции с ValueTask обратно на Task](/ru/2026/06/migrate-from-valuetask-back-to-task-when-and-why/).

## Порядок принятия решения

1. Если можно использовать `await`, используйте `await`. Всё в этой статье - для синхронных границ, которые нельзя убрать.
2. Проверьте `IsCompleted`. Если истинно, один раз вызовите `GetAwaiter().GetResult()`. Ноль выделений, исходный тип исключения.
3. Если задача не завершена, а вызов не горячий, `AsTask().GetAwaiter().GetResult()` корректен и скучен. Используйте его.
4. Если задача не завершена, а вызов настолько горячий, что от 80 до 208 байт на вызов заметны в профилировщике, используйте вспомогательный метод `WaitSync()` выше.
5. Никогда не вызывайте `.Result` или `GetAwaiter().GetResult()` у незавершённого `ValueTask`. Поведение не определено, а с `ManualResetValueTaskSourceCore<T>` выбрасывается исключение.

## Связанные материалы

- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await в C#](/ru/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) рассматривает тот же вопрос со стороны `Task`.
- [Что такое ValueTask и когда он оправдан](/ru/2026/06/what-is-valuetask-and-when-is-it-worth-it/) объясняет пулирование `IValueTaskSource` и правило "один await".
- [Миграция с ValueTask обратно на Task](/ru/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) - вариант, когда вызывающим постоянно нужен синхронный доступ.
- [Исправление взаимной блокировки при вызове .Result или .Wait() у асинхронного метода](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) объясняет, почему ничто из этого небезопасно в потоке UI.

## Источники

- [ValueTask&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), Microsoft Learn (замечания о неопределённом использовании)
- [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), Stephen Toub, .NET Blog
- [IValueTaskSource&lt;TResult&gt; Interface](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.ivaluetasksource-1), Microsoft Learn
- [ManualResetValueTaskSourceCore&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1), Microsoft Learn
- [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012), Microsoft Learn
- [ValueTask.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/ValueTask.cs)
