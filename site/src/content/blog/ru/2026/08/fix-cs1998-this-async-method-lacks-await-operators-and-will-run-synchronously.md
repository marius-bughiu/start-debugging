---
title: "Решение: CS1998 \"This async method lacks 'await' operators and will run synchronously\" в C#"
description: "CS1998 означает, что в async-методе нет await, поэтому он выполняется синхронно. Уберите модификатор async и верните Task.FromResult или добавьте забытый await."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "async"
lang: "ru"
translationOf: "2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously"
translatedBy: "claude"
translationDate: 2026-08-05
---

`CS1998` появляется, когда метод помечен модификатором `async`, но в его теле нет ни одного выражения `await`. В этом случае метод целиком выполняется синхронно, и вы платите за асинхронную машинерию, ничего не получая взамен. Решение почти всегда одно: убрать `async` и вернуть уже завершённую задачу, то есть `Task.CompletedTask`, `Task.FromResult(value)` или `ValueTask.FromResult(value)`. Если метод должен был чего-то ожидать, добавьте пропущенный `await`. Не заглушайте предупреждение через `await Task.CompletedTask`: так сохраняются все издержки, на которые оно жалуется. Одна деталь изменилась, и большинство результатов поиска её ещё не учитывают: начиная с SDK .NET 10 компилятор C# вообще не выдаёт `CS1998`. Всё изложенное ниже проверено на SDK 10.0.201 (Roslyn 5.3.0) и .NET 10.0.5.

## Предупреждение в контексте

```
warning CS1998: This async method lacks 'await' operators and will run synchronously. Consider using the 'await' operator to await non-blocking API calls, or 'await Task.Run(...)' to do CPU-bound work on a background thread.
```

Это предупреждение, а не ошибка, поэтому сборка проходит успешно, если в `.csproj` не указано `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`. Microsoft документирует его как `WRN_AsyncLacksAwaits` в [справочнике сообщений компилятора по async и await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors); официальная рекомендация звучит так: добавьте в тело метода хотя бы одно выражение `await` либо уберите модификатор `async` и возвращайте задачу напрямую.

## Почему компилятор об этом сообщает

Метод `async` без `await` никогда не приостанавливается. Тело выполняется от начала до конца в вызывающем потоке, ровно как у синхронного метода, а затем сгенерированный компилятором конечный автомат отдаёт вызывающему коду задачу, уже находящуюся в состоянии `RanToCompletion`. Ничего не ушло в фоновый поток, ничего ни с чем не совместилось. Ключевое слово `async` не сделало метод асинхронным, оно лишь изменило способ упаковки результата и исключений.

Такая упаковка не бесплатна. Вот её стоимость, измеренная на .NET 10.0.5, x64, Release, простым циклом со `Stopwatch` на двух миллионах вызовов и `GC.GetAllocatedBytesForCurrentThread` для выделений памяти. Это не цифры BenchmarkDotNet, поэтому воспринимайте их как порядок величины, а не как точные значения:

| Форма | Байт на вызов | нс на вызов |
| --- | --- | --- |
| `async Task` без `await` | 0 | 12.1 |
| `Task.CompletedTask` | 0 | 2.3 |
| `async Task<string>` без `await` | 72 | 27.9 |
| `Task.FromResult("ok")` | 72 | 16.0 |
| `async ValueTask<int>` без `await` | 0 | 15.6 |
| `ValueTask.FromResult(42)` | 0 | 3.0 |

Обращают на себя внимание две вещи. Столбец выделений одинаков в каждой паре, потому что асинхронный метод, завершающийся синхронно, никогда не упаковывает свой конечный автомат (структура остаётся на стеке, если приостановки нет), а неуниверсальный `AsyncTaskMethodBuilder` возвращает закешированную завершённую задачу. Так что народная мудрость "async выделяет память" здесь не работает. Реально вы платите примерно 10-15 наносекунд обвязки builder на вызов. В методе, который ходит в базу данных, это несущественно, а в горячем цикле уже заметно; именно поэтому это было предупреждение, а не ошибка.

## Минимальное воспроизведение

Наименьший код, вызывающий предупреждение на любом SDK вплоть до .NET 9 включительно:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
public class UserService
{
    private readonly Dictionary<int, User> _cache = new();

    public async Task<User> GetUserAsync(int id)   // CS1998
    {
        return _cache[id];
    }
}
```

Самая частая форма в реальном коде это та, что начиналась правильной и постепенно испортилась:

```csharp
// C# 14
public async Task<Report> BuildReportAsync(int id)
{
    // var rows = await _db.QueryAsync(id);   <- deleted during a refactor
    var rows = _cachedRows[id];
    return new Report(rows);                  // CS1998, and the method is now
}                                             // async for no reason at all
```

Первый вариант никто не пишет намеренно. Второй встречается постоянно, и в этом весь аргумент в пользу предупреждения: это детектор деградации кода, а не правило стиля.

## Решение 1: убрать async и вернуть завершённую задачу

Это правильное решение в подавляющем большинстве случаев. Уберите модификатор, сохраните сигнатуру, возвращающую `Task`, и оберните значение:

```csharp
// C# 14, .NET 10
public Task<User> GetUserAsync(int id)
{
    return Task.FromResult(_cache[id]);
}

public Task SaveAsync(User user)
{
    _cache[user.Id] = user;
    return Task.CompletedTask;          // the Task equivalent of FromResult
}

public ValueTask<int> CountAsync()
{
    return ValueTask.FromResult(_cache.Count);   // no Task allocation at all
}
```

Сигнатура не меняется, поэтому трогать вызывающий код не нужно, а конечный автомат исчезает. Если метод находится на горячем пути и его результат обычно доступен синхронно, `ValueTask<T>` убирает ещё и выделение 72 байт под `Task<T>`; компромиссы разобраны в статье [что такое ValueTask и когда он оправдан](/ru/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

Есть одно изменение поведения, которое нужно учесть, и именно поэтому такая замена не является чисто механической. В методе `async` исключение, брошенное в теле, перехватывается и помещается в возвращаемую задачу. Уберите `async`, и исключение будет брошено синхронно, в точке вызова, до того как вызывающий код вообще получит задачу для ожидания. Это легко показать:

```csharp
// C# 14, .NET 10.0.5
static async Task ThrowsFromTaskAsync() => throw new InvalidOperationException("boom");
static Task ThrowsAtCallSiteAsync() => throw new InvalidOperationException("boom");

var t1 = ThrowsFromTaskAsync();   // returns a faulted task, no exception here
await t1;                          // InvalidOperationException surfaces here

var t2 = ThrowsAtCallSiteAsync();  // throws right here, before any await
```

В большинстве кода эта разница незаметна, потому что вызывающий код сразу же ожидает задачу. Она проявляется, когда вызов не ожидается сразу: при сборе задач в список и передаче их в `Task.WhenAll`, при сохранении задачи в поле или при обёртывании вызова в `try`/`catch`, охватывающий только `await`. Если ваш метод может бросить исключение до того, как выдаст значение, оставьте исключение внутри задачи:

```csharp
// C# 14, .NET 10
public Task<Stream> OpenAsync(string path)
{
    try
    {
        return Task.FromResult<Stream>(new FileStream(path, FileMode.Open));
    }
    catch (Exception ex)
    {
        return Task.FromException<Stream>(ex);   // same shape as async would produce
    }
}
```

Именно этот сценарий Stephen Toub привёл в [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001), доказывая, что наивная замена на `Task.FromResult` часто некорректна.

## Решение 2: добавить забытый await

Если предупреждение появилось после рефакторинга, честное решение обычно состоит в том, чтобы вернуть вызов, который должен был ожидаться:

```csharp
// C# 14, .NET 10
public async Task<Report> BuildReportAsync(int id, CancellationToken ct)
{
    var rows = await _db.QueryAsync(id, ct);
    return new Report(rows);
}
```

Поищите в том же файле соседнее [CS4014 "because this call is not awaited"](/ru/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/). Два предупреждения вместе, одно про отсутствие await, другое про потерянную задачу, почти наверняка означают, что `await` пропал, а не что метод никогда не был асинхронным.

## Решение 3: Task.Run и почему совет из самого сообщения обычно неверен

Текст предупреждения предлагает `await Task.Run(...)` для нагрузки на процессор. Для настольного клиента этот совет верен: там задача в том, чтобы снять работу с потока интерфейса:

```csharp
// C# 14, .NET 10, WPF or MAUI
private async void OnCalculateClicked(object sender, EventArgs e)
{
    var result = await Task.Run(() => CrunchNumbers(_input));   // UI stays responsive
    ResultLabel.Text = result.ToString();
}
```

Внутри ASP.NET Core этот же совет неверен. Освобождать поток интерфейса не нужно, а запрос и так выполняется на потоке из пула; `Task.Run` лишь передаёт работу другому потоку того же пула, добавляя переключение контекста и выделение задачи, и одновременно сокращает пул, доступный для обслуживания других запросов. В серверном приложении синхронный метод должен оставаться синхронным либо становиться по-настоящему асинхронным за счёт ожидания реального ввода-вывода.

## Решение 4: реализации интерфейсов и переопределения, которые нельзя изменить

Хуже всего предупреждение справлялось со случаем члена интерфейса или виртуального метода, который обязан возвращать `Task`, хотя конкретной реализации нечего ожидать:

```csharp
// C# 14, .NET 10
public interface INotifier
{
    Task NotifyAsync(string message);
}

public sealed class NullNotifier : INotifier
{
    public Task NotifyAsync(string message) => Task.CompletedTask;   // no async, no warning
}
```

Ответ всё тот же: убрать `async`. Там, где это действительно невозможно, подавляйте предупреждение точечно, а не глобально:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
#pragma warning disable CS1998 // required by INotifier, nothing to await here
public async Task NotifyAsync(string message) { _log.Info(message); }
#pragma warning restore CS1998
```

Предпочитайте `#pragma` с поясняющим комментарием, а не `<NoWarn>$(NoWarn);CS1998</NoWarn>` в файле проекта. Подавление на уровне проекта скрывает все будущие случаи, включая ту самую деградацию после рефакторинга, которую предупреждение действительно хорошо ловит.

## Куда предупреждение делось в .NET 10

Если вы читаете это потому, что предупреждение перестало появляться, а не потому, что оно появилось, ответ такой: его удалили из компилятора. [dotnet/roslyn#80144](https://github.com/dotnet/roslyn/pull/80144), влитый 2025-09-19 в рамках вехи 18.0 P2, полностью убрал `WRN_AsyncLacksAwaits` вместе с провайдерами исправлений кода C# "Remove async modifier" и "Make method synchronous". Обоснование из [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) таково: предупреждение подталкивало людей к худшему коду. Вынужденные соблюдать контракт с возвратом `Task`, разработчики писали `await Task.FromResult(result)`, чтобы его заглушить, а это сохраняет конечный автомат, добавляет await и делает метод строго дороже, не делая его безопаснее. Итоговое решение в обсуждении было прямым: после дискуссии, и особенно с учётом runtime async, это предупреждение решили убрать целиком.

Удаление проверяется одной сборкой. Этот проект компилируется без предупреждений на SDK 10.0.201:

```csharp
// C# 14, .NET SDK 10.0.201 -> 0 warnings
public class C
{
    public async Task Empty() { }
    public async Task<int> Value() { return 42; }
    public async void VoidMethod() { }
    public async IAsyncEnumerable<int> Stream() { yield return 1; }
}
```

Ни один из этих методов не даёт диагностики, и ни `-warnaserror:CS1998`, ни `dotnet_diagnostic.CS1998.severity = error` в `.editorconfig` её не возвращают, потому что повышать уже нечего. `CS4014` тот же компилятор по-прежнему выдаёт, так что речь именно о `CS1998`, а не об общей потере предупреждений про async.

Возможность вернулась в виде подключаемых по желанию анализаторов IDE в [dotnet/roslyn#81835](https://github.com/dotnet/roslyn/pull/81835), влитом 2026-01-07 в рамках вехи 18.4 и намеренно разделённом на два идентификатора диагностики, чтобы случай реализации интерфейса настраивался отдельно:

- `IDE0390` (`RemoveUnnecessaryAsyncModifier`): обычные методы и лямбда-выражения.
- `IDE0391` (`RemoveUnnecessaryAsyncModifierInterfaceImplementationOrOverride`): методы, реализующие член интерфейса или переопределяющие базовый метод.

Оба отображаются как "Make method synchronous" с сообщением "Method can be made synchronous", и ни один не включён по умолчанию. Чтобы вернуть прежнее поведение там, где оно вам нужно:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0390.severity = warning
dotnet_diagnostic.IDE0391.severity = suggestion
```

```xml
<!-- .csproj: required to see IDE rules in dotnet build, not just in the IDE -->
<PropertyGroup>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

Одна оговорка по итогам проверки: в SDK 10.0.201 этих двух анализаторов ещё нет. Приведённая конфигурация не даёт ничего, тогда как контрольное правило вроде `IDE0161`, настроенное так же, отрабатывает нормально, то есть механизм исправен, а сами правила просто не попали в эту линейку SDK. Они нацелены на веху 18.4, поэтому нужен более новый SDK или обновление Visual Studio 2026.

## Подводные камни и варианты

- **CI падает, локальная сборка проходит.** `global.json`, закрепляющий SDK 9 на агенте сборки, по-прежнему выдаёт `CS1998`, и при `TreatWarningsAsErrors` это красная сборка для кода, который на машине разработчика с SDK 10 компилируется чисто. Сначала согласуйте линейку SDK, а уже потом ищите что-то более экзотическое.

- **ReSharper и Rider продолжают об этом сообщать.** Анализ JetBrains не зависит от Roslyn, поэтому инспекция может оставаться в редакторе после того, как компилятор перестал выдавать диагностику. Отключите её в настройках инспекций ReSharper, а не ждите, что на это повлияет ключ компилятора.

- **`await Task.CompletedTask` это худший способ заглушить предупреждение.** Он убирает его добавлением настоящего `await`, а значит вы сохраняете конечный автомат, сохраняете издержки builder и сверху добавляете обход через awaiter. Это строго дороже кода, который вызвал предупреждение. То же самое относится к `await Task.FromResult(value)`.

- **`async void` без await.** Убрать `async` из `async void SomeHandler()` это чистый выигрыш: ожидать нечего, значит от конечного автомата никакой пользы, и вы избавляетесь от [поведения исключений в async void](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), при котором ошибка перебрасывается в контекст синхронизации и способна уронить процесс.

- **Это никогда не означало "метод блокирует".** `CS1998` говорит, что нет `await`, а не что тело блокируется. Метод, вызывающий `.Result` или `.Wait()` внутри тела `async`, заглушает предупреждение, только если есть какой-то другой `await`, и это куда более серьёзная проблема: см. [взаимную блокировку при вызове .Result или .Wait()](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **Асинхронные итераторы.** Метод `async IAsyncEnumerable<T>` с `yield return` и без `await` остаётся полноценным асинхронным потоком, и здесь удаление предупреждения только облегчает жизнь. Если вы такой поток потребляете, учтите: `await foreach` по потоку, который на деле ничего не ожидает, не даёт параллелизма, а даёт лишь интерфейс.

Ментальная модель, которая переживает удаление предупреждения: `async` это стратегия компиляции, а не контракт API. Контракт задаётся сигнатурой, возвращающей `Task`. Когда ожидать нечего, сохраните контракт и откажитесь от стратегии, проследив, чтобы всё, что может бросить исключение, по-прежнему переводило задачу в состояние сбоя, а не бросало исключение в точке вызова. Это был правильный ответ, когда `CS1998` на вас кричало, и он остаётся правильным теперь, когда оно замолчало.

## Похожие статьи

- [Решение: CS4014 "Because this call is not awaited, execution of the current method continues" в C#](/ru/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) о предупреждении, которое обычно появляется рядом с пропущенным `await`.
- [async void против async Task в C#: когда что уместно](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) о том, почему метод `async void` без await стоит исправить в первую очередь.
- [Что такое ValueTask и когда он оправдан?](/ru/2026/06/what-is-valuetask-and-when-is-it-worth-it/) о случае синхронного завершения, где `ValueTask.FromResult` выигрывает у `Task.FromResult`.
- [Решение: взаимная блокировка при вызове .Result или .Wait() у async-метода в C#](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) о по-настоящему опасном варианте "этот async-метод на самом деле не асинхронный".
- [.NET 11 runtime async больше не требует флага EnablePreviewFeatures](/ru/2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures/) об изменении на уровне среды выполнения, которое позволило команде компилятора спокойно убрать это предупреждение.

## Источники

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) (точный текст `CS1998` и официальная рекомендация добавить await или убрать async).
- dotnet/roslyn, [PR #80144: Remove CS1998 warning entirely and remove dependent C# code fix providers](https://github.com/dotnet/roslyn/pull/80144) (влит 2025-09-19, веха 18.0 P2).
- dotnet/roslyn, [Issue #77001: Consider not emitting CS1998 for interface implementations / method overrides](https://github.com/dotnet/roslyn/issues/77001) (антипаттерн `await Task.FromResult` и решение убрать предупреждение).
- dotnet/roslyn, [PR #81835: Add back async fixers](https://github.com/dotnet/roslyn/pull/81835) (подключаемые анализаторы `IDE0390` и `IDE0391`, влиты 2026-01-07, веха 18.4).
- dotnet/roslyn, [Issue #82692: Warnings (at least CS1998) are not showing with SDK 10 compared to SDK 9](https://github.com/dotnet/roslyn/issues/82692) (подтверждение, что изменение поведения приходит вместе с SDK, а не с целевой платформой).
- Microsoft Learn, [Task.FromException method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.fromexception) (как получить задачу в состоянии сбоя без метода `async`).
