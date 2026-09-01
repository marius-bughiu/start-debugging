---
title: "Возврат Task напрямую против проброса через async/await в методе репозитория на C#: что выбрать?"
description: "Отказ от async/await в пробрасывающем методе репозитория экономит около 6 нс и 72 байта, а стоит вам кадра стека, семантики try/catch и безопасного освобождения ресурсов. Оставляйте return await, если метод не является чистым пробросом на измеренном горячем пути."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "performance"
lang: "ru"
translationOf: "2026/09/return-task-directly-vs-async-await-passthrough-in-a-csharp-repository-method"
translatedBy: "claude"
translationDate: 2026-09-01
---

У вас есть метод репозитория, который не делает ничего, кроме проброса вызова в EF Core, Dapper или `HttpClient`. Его можно написать как `public Task<Order> GetAsync(int id) => _db.Orders.FindAsync(id).AsTask();` и обойтись без машины состояний, либо как `public async Task<Order> GetAsync(int id) => await _db.Orders.FindAsync(id);` и сохранить её. **Оставьте `await`.** Отказ от него даёт примерно 6 наносекунд и 72 байта на вызов в .NET 10, что незаметно на фоне любого обращения к базе данных, а стоит кадра в каждой трассировке стека плюс трёх вариантов поведения, которые молча изменятся, если в методе когда-нибудь появится `using`, `try` или `lock`. Отказывайтесь от него только тогда, когда метод действительно является однострочным пробросом на пути, который вы профилировали. Все измерения ниже сделаны на .NET 10.0.10 с C# 14; история .NET 11 (Preview 7, финальный выпуск 2026-11-10) приведена в конце, и она ослабляет аргументы в пользу отказа, а не усиливает их.

## Две формы в сравнении

| Поведение                                                | `return await inner()` (async) | `return inner()` (без await) |
| -------------------------------------------------------- | ------------------------------ | ---------------------------- |
| Машина состояний генерируется                            | да                             | нет                          |
| Появляется в трассировке стека исключения                | да                             | **нет**                      |
| Накладные расходы, внутренний вызов завершается синхронно| 8.5 нс / 144 Б                 | 2.6 нс / 72 Б                |
| Накладные расходы, внутренний вызов реально приостанавливается | 1111 нс / 286 Б           | 1010 нс / 191 Б              |
| Безопасно внутри `using` / `await using`                 | да                             | **нет**                      |
| `try`/`catch` вокруг вызова действительно работает       | да                             | **нет**                      |
| Исключения проверки аргументов возникают                 | на `await`                     | в месте вызова               |
| Тип возврата может отличаться от внутреннего             | да (ковариантность, `ValueTask`)| нет (CS0029)                |
| Можно применить `ConfigureAwait(false)`                  | да                             | н/п (наследует внутренний)   |
| Вызывает CS1998, если убрать последний await             | да                             | н/п                          |

Две строки этой таблицы относятся к времени компиляции, а всё остальное - поведение во время выполнения, которое вы обнаружите только в продакшене. Эта асимметрия и есть весь аргумент в пользу значения по умолчанию.

## Что на самом деле генерирует компилятор

`async` - это не соглашение о вызовах, а переписывание. Когда вы помечаете метод как `async`, Roslyn превращает его в структуру, реализующую `IAsyncStateMachine`, поднимает каждую локальную переменную в поле этой структуры и заменяет тело на switch внутри `MoveNext()`. Сам метод становится заглушкой, которая создаёт `AsyncTaskMethodBuilder<T>`, запускает машину и возвращает `builder.Task`. Возвращаемый `Task<T>` - это **новая** задача, отличная от той, что произвёл внутренний вызов, и builder отвечает за её завершение, когда внутренняя задача закончится.

Уберите `async` - и ничего этого не произойдёт. Метод компилируется в обычный вызов плюс return, и вызывающий код получает *тот же самый* экземпляр `Task<T>`, который создал внутренний метод. Нет ни builder, ни машины состояний в куче, ни регистрации продолжения, ни второй задачи.

```csharp
// .NET 10, C# 14
public sealed class OrderRepository(AppDbContext db)
{
    // elided: the caller gets the exact Task instance EF Core created
    public Task<List<Order>> GetOpenAsync(CancellationToken ct) =>
        db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);

    // await passthrough: EF Core's task is awaited, and a second task is handed out
    public async Task<List<Order>> GetOpenAwaitedAsync(CancellationToken ct) =>
        await db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);
}
```

Обе версии компилируются. Обе корректны *для этого конкретного тела*. Различия начинаются в тот момент, когда тело перестаёт быть в точности таким.

## Во сколько на самом деле обходится лишний await

Я измерил обе формы с помощью BenchmarkDotNet 0.15.8 на Apple M4 (10 ядер), macOS 26.6.2, .NET SDK 10.0.302, хост-среда выполнения .NET 10.0.10, Arm64 RyuJIT, с включённым `MemoryDiagnoser` и рабочим станционным GC. Два сценария: внутренний метод, завершающийся синхронно (`Task.FromResult`, случай попадания в кэш первого уровня EF Core), и метод, который реально приостанавливается (`await Task.Yield()`, случай настоящего ввода-вывода).

| Метод               | Среднее    | Ratio | Выделено  | Ratio выд. |
| ------------------- | ---------- | ----- | --------- | ---------- |
| `Elided_Completed`  | 2.63 нс    | 1.00  | 72 Б      | 1.00       |
| `Awaited_Completed` | 8.47 нс    | 3.22  | 144 Б     | 2.00       |
| `Elided_Suspends`   | 1009.95 нс | 383.5 | 191 Б     | 2.65       |
| `Awaited_Suspends`  | 1110.81 нс | 421.8 | 286 Б     | 3.97       |

Если смотреть на отношения, отказ от await выглядит как выигрыш в 3 раза. Если смотреть на абсолютные числа, это 5.8 наносекунды и 72 байта на синхронном пути и 101 наносекунда и 95 байт на пути с приостановкой. 72 байта на быстром пути - это вторая `Task<int>`, которую выделяет builder; 95 байт на медленном пути - это машина состояний в куче плюс та же задача.

Теперь сопоставьте это с тем, что метод репозитория делает на самом деле. Обращение к локальному PostgreSQL занимает от 200 до 500 микросекунд. Обращение между зонами доступности - несколько миллисекунд. 101 наносекунда составляет от 0.002% до 0.05% одного запроса. Понадобится порядка десяти тысяч пробросов без await, чтобы отыграть время одного запроса. Случай синхронного завершения - единственный, где отношение не поглощается целиком, и он важен ровно там, где этого и ждёшь: плотный цикл по уже закэшированному значению, быстрый путь `ValueTask`, горячий цикл сериализации. Но не `GetOrderByIdAsync`.

## Где отказ от await молча меняет поведение

### Кадр стека исчезает

Это цена, которую вы платите каждый день и замечаете только в три часа ночи. Метод, возвращающий задачу без ожидания, завершается в тот же миг, когда возвращает управление; к моменту выброса исключения его кадра давно нет. Трассировки стека в асинхронном коде - это запись отложенных продолжений, а не того, кто кого вызвал.

```csharp
// .NET 10, C# 14
static Task ElidedPassthroughAsync() => ThrowAsync();
static async Task AwaitedPassthroughAsync() => await ThrowAsync();

static async Task ThrowAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}
```

Если поймать исключение наверху и вывести `ex.StackTrace`, получаются две разные картины:

```text
=== ELIDED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<Main>$(String[] args) in Program.cs:line 4

=== AWAITED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<<Main>$>g__AwaitedPassthroughAsync|0_1() in Program.cs:line 11
   at Program.<Main>$(String[] args) in Program.cs:line 7
```

`ElidedPassthroughAsync` в трассировке вообще отсутствует. На примере из двух методов это любопытный факт. В реальном сервисе, где аналог `ThrowAsync` (`SqlException` из `ToListAsync`) достигается из одиннадцати разных методов репозитория, именно пропущенные кадры сказали бы вам, какая функциональность сломалась. Если вы уже читали о том, как [Runtime Async в .NET 11 приводит в порядок асинхронные трассировки стека](/ru/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), учтите: он делает гораздо читаемее те кадры, которые у вас *есть*, но не может воскресить кадр, который никогда не регистрировал продолжение.

### `using` освобождает ресурс до завершения работы

Это уже ошибка, а не компромисс. `using var` компилируется в `try`/`finally` вокруг остатка области видимости, и `finally` выполняется, когда метод возвращает управление. Метод без await возвращает управление сразу, как только внутренний вызов отдаёт незавершённую задачу.

```csharp
// .NET 10, C# 14 -- broken: the resource is disposed while the task is still running
static Task<int> BadAsync()
{
    using var res = new Resource();
    return res.UseAsync();
}

// correct: the finally runs after the awaited work completes
static async Task<int> GoodAsync()
{
    using var res = new Resource();
    return await res.UseAsync();
}
```

`BadAsync` каждый раз выбрасывает `ObjectDisposedException: Cannot access a disposed object. Object name: 'Resource'`; `GoodAsync` завершается успешно. То же самое относится к `await using` над `IAsyncDisposable`, к `SemaphoreSlim`, освобождаемому в `finally`, и к любой транзакционной области. Если ваш репозиторий открывает соединение, начинает транзакцию или берёт объект из пула, отказ от await - это не оптимизация, а обращение к освобождённому ресурсу. Правила порядка освобождения подробно разобраны в статье [реализация и использование IAsyncDisposable с await using](/ru/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

### `try`/`catch` перестаёт ловить

Тот же механизм, другой симптом. Блок `catch` ловит только исключения, выброшенные, пока кадр находится в стеке. Исключение, выброшенное после того, как внутренний метод приостановился, доставляется через возвращённую задачу, задолго после выхода из вашего блока `try`.

```csharp
// .NET 10, C# 14
static Task<string> ElidedTryAsync()
{
    try { return ThrowAsync(); }                              // catch never runs
    catch (InvalidOperationException) { return Task.FromResult("caught"); }
}

static async Task<string> AwaitedTryAsync()
{
    try { return await ThrowAsync(); }                        // catch runs
    catch (InvalidOperationException) { return "caught"; }
}
```

Версия без await выпускает `InvalidOperationException` наружу к вызывающему коду; версия с await возвращает `"caught"`. Это тот вариант ошибки, который переживает код-ревью, потому что `try`/`catch` находится *прямо здесь* и выглядит так, будто он что-то делает.

### Исключения проверки аргументов переезжают в место вызова

Метод `async` никогда не выбрасывает исключение синхронно. Любое исключение, в том числе из первой строки, перехватывается и помещается в возвращённую задачу. У метода без async нет builder, куда перехватывать, поэтому охранное условие выбрасывает исключение немедленно, прямо в выражении вызова, ещё до того, как у вызывающего кода появится задача для ожидания.

```csharp
// .NET 10, C# 14
static Task<int> ElidedValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws at the call site
    return Task.FromResult(id.Length);
}

static async Task<int> AsyncValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws when the task is awaited
    await Task.Yield();
    return id.Length;
}
```

Вызывающий код вида `var t = repo.GetAsync(null); /* ... */ await t;` или передающий метод в `Task.WhenAll` внутри `Select` ведёт себя по-разному в этих двух вариантах. В форме без await `Select(x => repo.GetAsync(x)).ToList()` может выбросить исключение *во время материализации*, ещё до того, как дело дойдёт до `WhenAll`, и ни одна из уже запущенных задач не будет обработана. Само по себе ни одно из этих поведений не является неправильным, но переключаться между ними, добавляя или убирая `await`, - это не тот рефакторинг, которого ожидают читатели.

## Случаи, когда отказ от await вообще не компилируется

`Task<T>` - это класс, а значит, инвариантен. `Task<Dog>` не является `Task<Animal>`, и компилятор вам об этом сообщит:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.Task<Dog>'
              to 'System.Threading.Tasks.Task<Animal>'
```

Та же стена возникает, когда внутренний метод возвращает `ValueTask<int>`, а ваш контракт - `Task<int>`, что обычно происходит, как только вы касаетесь `FindAsync` или любого моста к `IAsyncEnumerable`:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.ValueTask<int>'
              to 'System.Threading.Tasks.Task<int>'
```

`await` выполняет это преобразование бесплатно. Без него нужен `.AsTask()` (выделение памяти, которое стирает всю экономию) или явное приведение, которого не существует. Поскольку интерфейс репозитория почти всегда выставляет абстракцию (`Task<IReadOnlyList<Order>>`), а не конкретный тип возврата провайдера (`Task<List<Order>>`), это не краевой случай, а большая часть интерфейса. А если вы подумывали протащить `ValueTask` вверх по слоям, сначала прочитайте, [когда ValueTask оправдан](/ru/2026/06/what-is-valuetask-and-when-is-it-worth-it/): ограничения обходятся дороже, чем выделение памяти.

Отказ от await также убирает шов, куда вы поставили бы `ConfigureAwait(false)`. В библиотеке, которая всё ещё рассчитана на хост с `SynchronizationContext`, проброс без await наследует то, что настроил внутренний метод, а он мог не настроить ничего. Это на одно место меньше для аннотации, но и на одно место меньше для исправления. Нужен ли этот шов в 2026 году, разбирается в статье [ConfigureAwait(false) против значения по умолчанию в .NET 11](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Что runtime async в .NET 11 меняет в этом компромиссе

Runtime async, который для проектов `net11.0` больше не требует `<EnablePreviewFeatures>`, переносит приостановку из машин состояний, генерируемых компилятором, в CLR. В Preview 7 добавились две вещи, напрямую влияющие на это сравнение. Асинхронные методы теперь проходят через многоуровневую компиляцию вместо постоянного выполнения кода tier0, а JIT получил **оптимизацию tail-await**: когда последнее действие асинхронного метода - ожидание вызова, возвращаемая задача которого совпадает с типом возврата самого метода, среда выполнения может выдать неявный хвостовой вызов, "значительно уменьшая размер кода и количество инструкций". Эта оптимизация описывает ровно `async Task<T> M() => await Inner();`. Это тот же отказ от await, но применённый средой выполнения, причём ваш исходный код не отказывается от семантики кадров.

В тех же заметках о выпуске сообщается, что работа над tail-await в tier0 снизила максимальную скорость выделения памяти во время прогрева TechEmpower `platform-json` с 110 580 952 Б/с до 8 030 616 Б/с. Направление однозначно: среда выполнения закрывает тот самый разрыв, который вы оптимизировали бы вручную. Писать `return inner()` сегодня ради экономии 72 байт - значит списывать оптимизацию компилятора, выходящую в ноябре, и при этом навсегда сохранять все риски поведения.

## Анализаторы, которые подталкивают вас не в ту сторону

Два популярных анализатора помечают `return await` как избыточный. **RCS1174 "Remove redundant async/await"** от Roslynator - первый, с которым вы столкнётесь, и существует давняя просьба отключить его по умолчанию именно потому, что Stephen Cleary и команда .NET считают это преобразование небезопасным в качестве общего правила. **AsyncFixer01 "Unnecessary async/await usage"** даёт ту же рекомендацию. Ни один из них не видит, появится ли в вашем методе `using` в следующем спринте, и ни один не знает, что вы полагаетесь на этот кадр в продакшен-трассировках.

Практичная настройка - отключить оба или выставить им уровень `suggestion` и никогда не применять автоисправление по всему решению. Массовое "применить RCS1174 ко всем документам" - один из немногих рефакторингов, способных внести `ObjectDisposedException` в рабочую кодовую базу. Обратите внимание, что это противоположное направление по сравнению с CS1998: то предупреждение срабатывает, когда в методе `async` *вообще нет* `await`, и там правильное исправление действительно состоит в удалении модификатора, как описано в статье [как исправить CS1998, не сломав метод](/ru/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/).

## Правило, которым я пользуюсь в коде репозиториев

- **По умолчанию `return await`.** Шести наносекунд не существует на практике; отсутствующий кадр стека и риск преждевременного освобождения - вполне реальны.
- **Отказывайтесь от await, только когда выполнены все четыре условия**: тело метода состоит ровно из одного `return`, в нём нигде нет `using`, `try`, `lock` или `finally`, тип возврата совпадает с типом внутреннего вызова, и у вас есть профиль, показывающий этот проброс на горячем пути. Три условия проверяются чтением; четвёртое как раз и пропускают.
- **Никогда не применяйте RCS1174 или AsyncFixer01 массово.** Подавляйте их на уровне проекта, а не исправляйте метод за методом.
- **На .NET 11 откажитесь от этой практики полностью.** Оптимизация tail-await даёт вам ту же генерацию кода бесплатно, а форма без await лишает вас кадров, которые среда выполнения сохранила бы.

Неприятная часть этого сравнения в том, что форма без await не медленнее, не уродливее и не ошибочна. Она действительно быстрее - на величину, которую ни один репозиторий никогда не заметит, в обмен на метод, семантика которого изменится, если кто-нибудь его отредактирует. Это плохая сделка при любом курсе, а .NET 11 вот-вот обнулит числитель.

## Связанные статьи

- [Runtime Async в .NET 11 заменяет машины состояний и даёт чистые трассировки стека](/ru/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)
- [Как исправить CS1998 "This async method lacks 'await' operators and will run synchronously"](/ru/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)
- [ConfigureAwait(false) против значения по умолчанию в .NET 11: имеет ли это ещё значение?](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Что такое ValueTask и когда он оправдан?](/ru/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [Как реализовать и использовать IAsyncDisposable с await using в C#](/ru/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [.Result против .Wait() против GetAwaiter().GetResult() против await в C#](/ru/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

## Источники

- [Eliding Async and Await](https://blog.stephencleary.com/2016/12/eliding-async-await.html) -- Stephen Cleary
- [Заметки о выпуске среды выполнения .NET 11 Preview 7: runtime-async tiering and tail-await optimizations](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/runtime.md) -- dotnet/core
- [.NET 11 Preview 7 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) -- .NET Blog
- [RCS1174: Remove redundant async/await](https://josefpihrt.github.io/docs/roslynator/analyzers/RCS1174/) -- Roslynator
- [Disable by default RCS1174 (issue #429)](https://github.com/JosefPihrt/Roslynator/issues/429) -- dotnet/roslynator
- [AsyncFixer: async/await analyzers and code fixes](https://github.com/semihokur/AsyncFixer) -- semihokur
- [Справочник сообщений компилятора по async и await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) -- Microsoft Learn
