---
title: "Исправление: AggregateException \"One or more errors occurred\" при ожидании Task.WhenAll в C#"
description: "await Task.WhenAll выбрасывает лишь одну из ошибок. Сохраните задачу WhenAll в переменной и прочитайте Exception.InnerExceptions, чтобы увидеть все ошибки, а не одну."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "ru"
translationOf: "2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall"
translatedBy: "claude"
translationDate: 2026-08-05
---

Если несколько задач в `Task.WhenAll` завершились с ошибкой, возвращённая задача переходит в состояние ошибки с `AggregateException`, сообщение которой равно "One or more errors occurred", но `await` разворачивает её и повторно выбрасывает ровно одно из внутренних исключений. Все остальные сбои молча отбрасываются и до вашего блока `catch` не доходят. Исправление состоит в том, чтобы сохранить возвращаемую `Task.WhenAll` задачу в локальной переменной, ожидать её внутри `try` и прочитать `whenAll.Exception.InnerExceptions` в `catch`, чтобы получить их все. Если вы видите в `catch` буквальный тип `AggregateException`, значит, вы блокируетесь через `.Wait()` или `.Result` вместо ожидания, а это отдельная и более серьёзная проблема. Проверено на .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), поведение среды выполнения измерено на .NET 10.0.5; соответствующий код рантайма побайтово одинаков в ветках `release/10.0` и `main`.

## Ошибка в контексте

Блокирующее ожидание задачи `WhenAll` отдаёт обёртку напрямую:

```
Unhandled exception. System.AggregateException: One or more errors occurred. (Connection refused) (The operation has timed out.)
 ---> System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   --- End of inner exception stack trace ---
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)
```

При ожидании через `await` никакой `AggregateException` не будет, только одно из внутренних исключений:

```
Unhandled exception. System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   at OrderSync.SyncAllAsync()
```

Это одна и та же ситуация по сути. Именно две разные формы приводят к тому, что поиск по этой ошибке выдаёт противоречивые советы.

## Почему await скрывает все сбои, кроме одного

Документация `Task.WhenAll` говорит, что задача завершается в состоянии `Faulted`, "где её исключения будут содержать агрегацию набора развёрнутых исключений от каждой из переданных задач". Эта агрегация живёт в свойстве `Exception` возвращённой задачи и действительно содержит каждый сбой.

Потеря происходит уровнем выше. `await` по спецификации повторно выбрасывает исключение задачи уже развёрнутым, поэтому при одной упавшей задаче вы ловите `HttpRequestException`, а не `AggregateException`. Такое разворачивание правильно по умолчанию: почти любой асинхронный API даёт максимум одну ошибку, и писать `catch (AggregateException ae) { ae.InnerException ... }` вокруг каждого await было бы мучительно. `Task.WhenAll` -- главный API, где это допущение ломается, а awaiter не может сообщить, что ошибок было четыре. Он берёт один exception dispatch info из списка и выбрасывает его. Об этом писали в [dotnet/runtime#31494](https://github.com/dotnet/runtime/issues/31494) и затем в [dotnet/runtime#47605](https://github.com/dotnet/runtime/issues/47605), прося опциональный await, который передавал бы всю агрегацию. Ни одно предложение не выпущено, поэтому обходной путь ниже остаётся ответом.

Следствие важно для ваших блоков `catch`: после `await Task.WhenAll(...)` блок `catch (AggregateException)` не срабатывает никогда. Если вы его написали, это мёртвый код, а настоящее исключение проходит мимо.

## Минимальное воспроизведение

```csharp
// .NET 11, C# 14
static async Task FailAsync(string message)
{
    await Task.Delay(10);
    throw new InvalidOperationException(message);
}

try
{
    await Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));
}
catch (Exception ex)
{
    Console.WriteLine(ex.Message);   // prints one message, not three
}
```

На входе три сбоя, на выходе один. Ничто внутри блока `catch` не может восстановить два остальных, потому что единственной ссылкой на агрегацию была временная переменная, которую вернул `Task.WhenAll` и поглотил `await`.

## Исправление 1: сохранить задачу WhenAll и прочитать InnerExceptions

Это исправление для подавляющего большинства случаев, и единственное изменение -- локальная переменная:

```csharp
// .NET 11, C# 14
Task whenAll = Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));

try
{
    await whenAll;
}
catch
{
    // whenAll.Exception is the AggregateException the await threw away
    foreach (Exception inner in whenAll.Exception!.InnerExceptions)
    {
        _logger.LogError(inner, "Sync step failed");
    }
    throw;
}
```

`whenAll.Exception` не равно null ровно тогда, когда `whenAll.Status == TaskStatus.Faulted`, а коллекция `InnerExceptions` содержит по одной записи на каждую упавшую задачу, каждая с нетронутой исходной трассировкой стека. Пустой `catch` с `throw` сохраняет прежнее поведение для вызывающего кода (он по-прежнему видит одно развёрнутое исключение) и одновременно даёт полную точность в логе.

Две детали делают приём механически безопасным. Во-первых, не помещайте сам вызов `Task.WhenAll(...)` внутрь `try`: выбрасывает `await`, а не вызов, но присваивание снаружи делает переменную видимой в `catch`. Во-вторых, используйте `catch` или `catch (Exception)`, а не `catch (AggregateException)`, по причине из предыдущего раздела.

## Исправление 2: не давать задаче WhenAll падать вовсе

Если ваш fan-out -- это пакет, где частичный сбой нормален, чище не выпускать исключения из отдельных задач. Оберните каждую единицу работы так, чтобы она возвращала результат вместо выброса:

```csharp
// .NET 11, C# 14
static async Task<(int Id, Exception? Error)> RunSafeAsync(int id, Func<Task> work)
{
    try
    {
        await work();
        return (id, null);
    }
    catch (Exception ex)
    {
        return (id, ex);
    }
}

var results = await Task.WhenAll(orders.Select(o => RunSafeAsync(o.Id, () => SyncAsync(o))));

foreach (var (id, error) in results.Where(r => r.Error is not null))
{
    _logger.LogError(error, "Order {OrderId} failed", id);
}
```

`Task.WhenAll` теперь всегда доходит до конца, так что распаковывать агрегацию не нужно, угадывать фильтр исключений не нужно, а связь между каждым сбоем и вызвавшим его элементом сохраняется. Именно эту связь Исправление 1 дать не может: `InnerExceptions` -- плоский список исключений без обратной ссылки на породившую их задачу. Когда нужно повторить сбойные элементы или сообщить, какие записи были отклонены, берите эту форму.

Цена в том, что по-настоящему фатальная ошибка больше не распространяется сама. Явно решите, что делать, когда `results` содержит ошибки, иначе вы построили молчаливый сбой.

## Исправление 3: намеренно перебросить всю агрегацию

Когда вызывающий код действительно должен видеть каждый сбой, перебросьте агрегацию вместо того, чтобы `await` выбирал одно исключение. `ExceptionDispatchInfo` сохраняет исходные трассировки стека:

```csharp
// .NET 11, C# 14
using System.Runtime.ExceptionServices;

public static async Task WhenAllWithAggregateAsync(IEnumerable<Task> tasks)
{
    Task whenAll = Task.WhenAll(tasks);
    try
    {
        await whenAll;
    }
    catch
    {
        ExceptionDispatchInfo.Capture(whenAll.Exception!).Throw();
    }
}
```

Вызывающие этот помощник получают `AggregateException` со всеми внутренними исключениями, а именно к этому обычно и стремятся, когда пишут `catch (AggregateException)` после `await`. Применяйте его на границе, где одна логическая операция действительно упала сразу несколькими способами, например при пакетном импорте, который обязан сообщить обо всех ошибках валидации. Не делайте это поведением по умолчанию: оно проталкивает обработку `AggregateException` в каждый вызывающий код, а именно эту эргономическую проблему разворачивание в `await` и должно было устранить.

## Какое исключение на самом деле выбрасывает await?

Здесь большинство существующих ответов ошибаются, включая те, что говорят "первое исключение". Всё зависит от того, какую перегрузку вы вызвали, и разница детерминирована.

```csharp
// .NET 10.0.5, C# 14 -- three tasks that fail at staggered times,
// slowest one first in argument order
static async Task FailAfterAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

static async Task<int> FailAfterIntAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

// non-generic overload -> Task
var nonGeneric = Task.WhenAll(
    FailAfterAsync(150, "index0-slow"),
    FailAfterAsync(80,  "index1-medium"),
    FailAfterAsync(10,  "index2-fast"));
// await throws:    index2-fast
// InnerExceptions: index2-fast, index1-medium, index0-slow

// generic overload -> Task<int[]>
var generic = Task.WhenAll(
    FailAfterIntAsync(150, "index0-slow"),
    FailAfterIntAsync(80,  "index1-medium"),
    FailAfterIntAsync(10,  "index2-fast"));
// await throws:    index0-slow
// InnerExceptions: index0-slow, index1-medium, index2-fast
```

Негенерический `Task.WhenAll` упорядочивает `InnerExceptions` по **времени завершения**. Генерический `Task.WhenAll<TResult>` упорядочивает их по **позиции аргумента**. Оба выбрасывают `InnerExceptions[0]`. Этот результат был стабилен при повторных запусках на .NET 10.0.5.

Причина видна в исходном коде рантайма. Оба promise находятся в [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs). Негенерический `WhenAllPromise` намеренно не удерживает входной массив; его колбэк завершения `Invoke` добавляет каждую упавшую задачу в список по мере её завершения, а затем проходит по этому списку:

```csharp
// dotnet/runtime, Task.WhenAllPromise.Invoke
if (failedOrCanceled is List<Task> list)
{
    foreach (Task task in list) { HandleTask(task); }
}
```

Генерический `WhenAllPromise<T>` удерживает массив, потому что обязан выдать результаты `T[]` по порядку, и обходит его по индексу:

```csharp
// dotnet/runtime, Task.WhenAllPromise<T>.Invoke
for (int i = 0; i < m_tasks.Length; i++)
{
    Task<T>? task = m_tasks[i];
    if (task.IsFaulted) { observedExceptions ??= new(); observedExceptions.AddRange(task.GetExceptionDispatchInfos()); }
    ...
}
```

Это расхождение появилось в .NET 8 и было заведено как [dotnet/runtime#93504](https://github.com/dotnet/runtime/issues/93504) после того, как негенерический путь переписали ради уменьшения аллокаций. Задачу закрыли как "not planned", и в документации критических изменений её нет. На практике: никогда не пишите код, зависящий от того, какой именно сбой всплывёт из `await Task.WhenAll`. Читайте весь список, как в Исправлении 1.

## Отмена исчезает, когда что-то падает

Вторая молчаливая потеря -- это отмена. Если одна задача отменена, а другая упала, отменённая не даёт ничего:

```csharp
// .NET 10.0.5
var mixed = Task.WhenAll(canceledTask, faultingTask);
try { await mixed; } catch (Exception ex) { /* InvalidOperationException */ }

// mixed.Status                          -> Faulted
// mixed.Exception.InnerExceptions.Count -> 1   (the cancellation is gone)
```

Обе реализации promise хранят `canceledTask` в отдельной локальной переменной и вызывают `TrySetCanceled` только тогда, когда список исключений пуст, что совпадает с документированным правилом: сбой важнее отмены, а отмена важнее успеха. Если ничего не упало и хотя бы одна задача отменена, задача `WhenAll` завершается как `Canceled`, её свойство `Exception` равно `null`, а `await` выбрасывает `TaskCanceledException`. Код, который делает `whenAll.Exception!.InnerExceptions` без проверки `Status`, получит `NullReferenceException` именно в этом случае, поэтому защитите его:

```csharp
// .NET 11, C# 14
catch (Exception ex)
{
    if (whenAll.Exception is { } aggregate)
    {
        foreach (var inner in aggregate.InnerExceptions) _logger.LogError(inner, "Step failed");
    }
    else
    {
        _logger.LogWarning(ex, "Batch was canceled");
    }
    throw;
}
```

Отличить настоящую отмену от таймаута, притворяющегося отменой, -- отдельная ловушка, разобранная в [почему HttpClient выбрасывает TaskCanceledException](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Подводные камни и варианты

- **Вы ловите `AggregateException`, и это работает.** Значит, вы не используете `await`. `.Wait()`, `.Result` и `Task.WaitAll` выбрасывают обёртку как есть, и только поэтому имя типа вообще появляется в `catch`. Это же означает, что вы блокируете поток со всеми вытекающими: см. [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/ru/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/).

- **`Flatten()` здесь бесполезен.** `AggregateException.Flatten` существует для вложенных агрегаций, но `Task.WhenAll` уже разворачивает свои составляющие, поэтому даже `WhenAll` над `WhenAll` даёт плоский список. Проверено: три сбоя, вложенные на два уровня, дали три внутренних исключения и до, и после `Flatten()`. Оставьте `Flatten()` для `Parallel.ForEach` и PLINQ, где вложенность реальна.

- **Ленивый LINQ-запрос, перечисленный дважды, запускает работу дважды.** `Enumerable.Range(0, 3).Select(_ => DoAsync())` -- это запрос, а не список. `Task.WhenAll` перечисляет его один раз, но передача того же запроса во второй `WhenAll` (или в `.Count()` ради строки лога) запускает всё заново. Измерено: три задачи после первого `WhenAll`, шесть после второго. Вызывайте `.ToArray()` перед тем, как передавать проекцию в `WhenAll`.

- **`Task.WhenAll` не останавливается на первом сбое.** Каждая задача доходит до конца даже после того, как одна выбросила исключение, и именно поэтому исключений получается несколько. Если нужно, чтобы fan-out бросил остальное, потребуется `CancellationTokenSource`, который задачи уважают, подключённый как в [прокидывании CancellationToken через асинхронные методы](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **У `Task.WhenAll` нет ограничения параллелизма.** Если агрегация полна сокетных исключений и таймаутов, настоящая ошибка может быть в том, что вы запустили 5000 запросов сразу. Альтернативы с ограничением параллелизма сравниваются в [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/ru/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

- **Сбои приходят поздно.** `WhenAll` ничего не сообщает, пока не завершится самая медленная задача, поэтому быстрый сбой остаётся невидимым за медленным успехом. Если нужно реагировать на каждый результат по мере поступления, [Task.WhenEach](/ru/2026/01/streaming-tasks-with-net-9-task-wheneach/) даёт `IAsyncEnumerable<Task>` в порядке завершения.

- **Пустая коллекция завершается успешно.** `Task.WhenAll(Array.Empty<Task>())` сразу переходит в `RanToCompletion`. Пакетное задание, рапортующее об успехе на пустом входе, обычно означает ошибку фильтрации выше по потоку, а не ошибку `WhenAll`.

- **Ожидание задачи `WhenAll` наблюдает каждое внутреннее исключение.** Вы не получите `TaskScheduler.UnobservedTaskException` по сбоям, которых не увидели, потому что `WhenAll` уже наблюдал их за вас. Удобно, и это же объясняет, почему потери такие тихие.

Ментальная модель в одну строку: `Task.WhenAll` собирает каждый сбой честно, а `await` -- шаг с потерями. Дайте возвращённой задаче имя, и ничего не потеряется.

## Связанные материалы

- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll в C#](/ru/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) о выборе правильного примитива fan-out и ограничении параллелизма.
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await в C#](/ru/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) о том, почему именно блокировка обнажает сырое `AggregateException`.
- [Исправление: TaskCanceledException: A task was canceled в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) про случай отмены, который проглатывает упавший `WhenAll`.
- [Потоковая обработка задач с Task.WhenEach в .NET 9](/ru/2026/01/streaming-tasks-with-net-9-task-wheneach/) об обработке каждого результата по мере готовности вместо ожидания самого медленного.
- [Как прокинуть CancellationToken через асинхронные методы в .NET 11](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), чтобы fan-out бросал оставшуюся работу.

## Источники

- Microsoft Learn, [метод Task.WhenAll](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (процитированные выше правила для Faulted, Canceled и `RanToCompletion`).
- Microsoft Learn, [класс AggregateException](https://learn.microsoft.com/en-us/dotnet/api/system.aggregateexception) (`InnerExceptions`, `Flatten`, `Handle` и сообщение "One or more errors occurred").
- Microsoft Learn, [обработка исключений в Task](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) и [обработка исключений в TPL](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/exception-handling-task-parallel-library).
- dotnet/runtime, [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) (`WhenAllPromise` и `WhenAllPromise<T>`, разница между порядком завершения и порядком аргументов).
- dotnet/runtime, [Issue #93504: Awaiting nongeneric Task.WhenAll changes behavior in .NET 8](https://github.com/dotnet/runtime/issues/93504) (закрыт как "not planned", не задокументирован).
- dotnet/runtime, [Issue #31494: Task.WhenAll inner exceptions are lost](https://github.com/dotnet/runtime/issues/31494) и [Issue #47605: Configure an await to propagate all errors](https://github.com/dotnet/runtime/issues/47605).
