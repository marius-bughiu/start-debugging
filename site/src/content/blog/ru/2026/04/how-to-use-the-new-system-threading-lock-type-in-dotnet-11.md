---
title: "Как использовать новый тип System.Threading.Lock в .NET 11"
description: "System.Threading.Lock появился в .NET 9 и стал стандартной примитивой синхронизации в .NET 11 и C# 14. Это руководство показывает, как мигрировать с lock(object), как работает EnterScope и какие подводные камни связаны с await, dynamic и поддержкой старых таргетов."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "ru"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

Самый короткий ответ: замените `private readonly object _gate = new();` на `private readonly Lock _gate = new();`, оставьте каждый `lock (_gate) { ... }` ровно таким, каким он был, и позвольте компилятору C# 14 связать ключевое слово `lock` с `Lock.EnterScope()` вместо `Monitor.Enter`. На .NET 11 результат — объект меньшего размера, отсутствие инфляции sync block и измеримый прирост пропускной способности на горячих путях с конкуренцией. Думать дольше нужно только там, где блок должен сделать `await`, где поле выставлено через `dynamic`, где есть `using static` для `System.Threading`, и где тот же код должен компилироваться под `netstandard2.0`.

Это руководство ориентировано на .NET 11 (preview 4) и C# 14. Сам `System.Threading.Lock` — это тип из .NET 9, поэтому всё описанное работает на .NET 9, .NET 10 и .NET 11. Распознавание паттерна на уровне компилятора, благодаря которому `lock` связывается с `Lock.EnterScope()`, появилось в C# 13 в .NET 9 и не изменилось в C# 14.

## Почему `lock(object)` всегда был обходным решением

Девятнадцать лет канонический паттерн C# для "сделать этот участок потокобезопасным" — это приватное поле `object` плюс инструкция `lock`. Компилятор раскрывал это в вызовы [`Monitor.Enter`](https://learn.microsoft.com/dotnet/api/system.threading.monitor.enter) и `Monitor.Exit` против identity объекта. Механизм работал, но имел три структурных издержки.

Во-первых, каждая залоченная область платит за слово заголовка объекта. Ссылочные типы в управляемой куче CLR несут `ObjHeader` плюс `MethodTable*`, всего 16 байт на x64 только для существования. `object`, который вы выделяете для блокировки, не имеет другого назначения, кроме identity. Он ничего не даёт вашей доменной модели, а GC всё равно должен его трассировать.

Во-вторых, как только два потока начинают конкурировать за лок, среда выполнения раздувает заголовок в [SyncBlock](https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/sync-block-table.md). Таблица SyncBlock — это процессно-уровневая таблица записей `SyncBlock`, каждая выделяется по требованию и не освобождается до завершения процесса. Долгоживущий сервис, который лочит миллионы разных объектов, получает таблицу SyncBlock, которая монотонно растёт. Это было редко, но реально, и диагностировалось только через `dotnet-dump` и `!syncblk`.

В-третьих, `Monitor.Enter` рекурсивен (один и тот же поток может войти дважды и освобождает лок только при совпадении счётчиков выходов) и поддерживает `Monitor.Wait` / `Pulse` / `PulseAll`. Большинству кода это всё не нужно. Ему нужно взаимное исключение. Вы платили за функции, которыми никогда не пользовались.

`System.Threading.Lock` — это тип, который Microsoft выпустила бы в 2002 году, если бы `Monitor` не выполнял заодно роль реализации, скрытой за `lock`. Предложение, которое его ввело ([dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), принято в 2024), описывает его как "более быстрый лок с меньшим следом и более чёткой семантикой". Это запечатанный ссылочный тип, который выставляет только то, что нужно для взаимного исключения: войти, попробовать войти, выйти и проверить, держит ли текущий поток лок. Никакого `Wait`. Никакого `Pulse`. Никакой магии заголовка объекта.

## Механическая миграция

Возьмём типичный legacy-кэш:

```csharp
// .NET Framework 4.x / .NET 8, C# 12 -- the old shape
public class LegacyCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Перенесите его на .NET 11, изменив ровно одну строку:

```csharp
// .NET 11, C# 14 -- the new shape, single-line diff
public class ModernCache
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Тело каждой инструкции `lock` остаётся неизменным. Компилятор видит, что `_gate` — это `Lock`, и переписывает `lock (_gate) { body }` в:

```csharp
// What the compiler emits, simplified
using (_gate.EnterScope())
{
    // body
}
```

`EnterScope()` возвращает структуру `Lock.Scope`, чей `Dispose()` отпускает лок. Поскольку `Scope` — это `ref struct`, его нельзя боксить, захватывать в итераторе, захватывать в async-методе или хранить в поле. Именно последнее ограничение делает новый лок дешёвым: ни аллокации, ни виртуального диспатча, только handle на стеке.

Если вы поменяете порядок (`Lock _gate`, но какой-то инструмент в другом месте делает `Monitor.Enter(_gate)`), компилятор C# выдаёт CS9216 начиная с C# 13: "A value of type `System.Threading.Lock` converted to a different type will use likely unintended monitor-based locking in `lock` statement". Конверсия разрешена (`Lock` всё ещё `object`), но компилятор предупреждает, потому что вы только что отказались от всех преимуществ нового типа.

## Что на самом деле возвращает `EnterScope`

Можно использовать новый тип без ключевого слова `lock`, если это нужно:

```csharp
// .NET 11, C# 14
public byte[] GetOrCompute(string key, Func<string, byte[]> factory)
{
    using (_gate.EnterScope())
    {
        if (_store.TryGetValue(key, out var existing))
            return existing;

        var fresh = factory(key);
        _store[key] = fresh;
        return fresh;
    }
}
```

`EnterScope()` блокируется, пока лок не будет получен. Также есть `TryEnter()` (возвращает `bool`, без `Scope`) и `TryEnter(TimeSpan)` для захвата с таймаутом. Если вы вызвали `TryEnter` и он вернул `true`, нужно вызвать `Exit()` самостоятельно, ровно один раз, в том же потоке. Пропустите `Exit` — лок утёк; следующий желающий заблокируется навсегда.

```csharp
// .NET 11, C# 14 -- TryEnter idiom for non-blocking back-pressure
if (_gate.TryEnter())
{
    try
    {
        DoWork();
    }
    finally
    {
        _gate.Exit();
    }
}
else
{
    // back off, reschedule, drop the message, etc.
}
```

`Lock.IsHeldByCurrentThread` — это свойство `bool`, которое возвращает `true` только если вызывающий поток в данный момент держит лок. Оно предназначено для `Debug.Assert` в инвариантах; не используйте его как механизм управления потоком. Оно `O(1)`, но имеет acquire-release семантику, поэтому вызов в горячем цикле обойдётся вам дорого.

## Ловушка с await, теперь хуже

Сделать `await` внутри `lock` на основе `Monitor` было нельзя никогда. Компилятор отказывал прямо с [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996): "Cannot await in the body of a lock statement". Причина в том, что `Monitor` отслеживает владение по managed thread id, поэтому возобновление `await` на другом потоке отпустило бы лок от лица не того владельца.

У `Lock` ровно то же ограничение, и компилятор обеспечивает его тем же способом. Попробуйте:

```csharp
// .NET 11, C# 14 -- DOES NOT COMPILE
public async Task DoIt()
{
    lock (_gate)
    {
        await Task.Delay(100); // CS1996
    }
}
```

Вы снова получаете `CS1996`. Хорошо. Большая ловушка — это `using (_gate.EnterScope())`, потому что компилятор не знает, что `Scope` пришёл от `Lock`. На .NET 11 SDK 11.0.100-preview.4 такой код компилируется:

```csharp
// .NET 11, C# 14 -- COMPILES, but is broken at runtime
public async Task Broken()
{
    using (_gate.EnterScope())
    {
        await Task.Delay(100);
        // Resumes on a thread-pool thread, which does NOT hold _gate.
        // Disposing the Scope here calls Lock.Exit on a thread that
        // never entered, throwing SynchronizationLockException.
    }
}
```

Решение остаётся тем же: поднимите лок так, чтобы он оборачивал только синхронную критическую секцию, а для настоящего взаимного исключения через `await` используйте `SemaphoreSlim` (он async-aware). `Lock` — быстрая синхронная примитива. Это не async-лок, и он им быть не пытается.

## Производительность: что изменилось на самом деле

Release notes .NET 9 утверждают, что захват с конкуренцией примерно в 2-3 раза быстрее эквивалентного пути `Monitor.Enter`, а захват без конкуренции определяется одним interlocked compare-exchange. Пост Стивена Тоуба [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) включает микробенчмарки, которые показывают именно это, и они воспроизводятся на .NET 11.

Экономия, которую вы сможете измерить в собственном сервисе, меньше, чем намекают синтетические числа, потому что реальные сервисы редко проводят большую часть времени внутри `lock`. Места, где разница будет заметна:

- **Working set**: каждый gate переходит из "object плюс sync block при конкуренции" в "Lock, размером примерно с object плюс 8 байт состояния". Если у вас тысячи gate (по одному на запись кэша, скажем), таблица sync block перестаёт расти под конкуренцией.
- **Обход GC2**: `Lock` всё ещё ссылочный тип, но он никогда не раздувает внешнюю таблицу, которую GC должен был бы обойти отдельно.
- **Горячий путь при конкуренции**: новый горячий путь — это один `CMPXCHG` плюс барьер памяти. Старый путь шёл через `Monitor`, в котором перед барьером несколько условных ветвлений.

Что не меняется: пропускная способность самой защищаемой секции, fairness (новый `Lock` тоже несправедливый, с тонким слоем предотвращения starvation) и рекурсия (`Lock` рекурсивен на одном потоке, идентично `Monitor`).

## Грабли, на которые вы наступите

**`using static System.Threading;`** -- если какой-то файл в вашем проекте делает это, неквалифицированное имя `Lock` становится неоднозначным с любым вашим классом `Lock`. Решение — убрать `using static` или явно квалифицировать тип: `System.Threading.Lock`. Компилятор сообщит [CS0104](https://learn.microsoft.com/dotnet/csharp/misc/cs0104), но место ошибки — там, где вы использовали `Lock`, а не там, где конфликт был введён.

**`dynamic`** -- инструкция `lock` над выражением типа `dynamic` не может разрешиться в `Lock.EnterScope()`, потому что binding происходит во время выполнения. Компилятор выдаёт CS9216 и откатывается к `Monitor`. Если у вас одна из тех редких codebase с `dynamic`, приведите к `Lock` перед `lock`:

```csharp
// .NET 11, C# 14
dynamic d = GetGate();
lock ((Lock)d) { /* ... */ } // cast is required
```

**Бокс в `object`** -- поскольку `Lock` наследуется от `object`, вы можете передать его в любой API, принимающий `object`, включая `Monitor.Enter`. Это сводит на нет новый путь. CS9216 — ваш друг; превратите его в ошибку в `Directory.Build.props`:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);CS9216</WarningsAsErrors>
</PropertyGroup>
```

**Библиотеки `netstandard2.0`** -- если ваша библиотека мульти-таргетит `netstandard2.0` и `net11.0`, `Lock` на стороне `netstandard2.0` не существует. У вас два варианта. Чистый — держать поле `object` на `netstandard2.0` и поле `Lock` на `net11.0`, защитив через `#if NET9_0_OR_GREATER`:

```csharp
// .NET 11, C# 14 -- multi-target gate
#if NET9_0_OR_GREATER
private readonly System.Threading.Lock _gate = new();
#else
private readonly object _gate = new();
#endif
```

Грязный — type-forwarding `Lock` из polyfill-пакета; не делайте этого, всё кончится плохо, когда polyfill разойдётся с семантикой реального типа.

**`Dispatcher` в WPF и WinForms** -- внутренняя очередь dispatcher всё ещё использует `Monitor`. Заменить его лок вы не можете. Локи вашего приложения переехать могут; локи фреймворка — нет.

**Source generator, генерирующие `lock(object)`** -- перегенерируйте. CommunityToolkit.Mvvm 9 и несколько других перешли на `Lock` в конце 2024. Проверьте сгенерированный файл на `private readonly object`; если оно ещё там, обновите пакет.

## Когда `Lock` использовать не стоит

Не используйте `Lock` (или любой короткоживущий мьютекс), когда правильный ответ — "никакого лока". `ConcurrentDictionary<TKey, TValue>` не нуждается во внешнем gate. `ImmutableArray.Builder` тоже. `Channel<T>` тоже. Самая быстрая синхронизация — та, которую вы не пишете.

Не используйте `Lock`, когда защищаемая секция пересекает `await`. Используйте `SemaphoreSlim(1, 1)` и `await semaphore.WaitAsync()`. Накладные расходы на захват выше, но это единственный корректный вариант.

Не используйте `Lock` для межпроцессной или межмашинной координации. Он только intra-процессный. Для этого используйте [`Mutex`](https://learn.microsoft.com/dotnet/api/system.threading.mutex) (именованный, kernel-backed), row lock в БД или Redis `SETNX`.

## Связанное

- [Как использовать Channels вместо BlockingCollection в C#](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) разбирает паттерн producer/consumer, который часто заменяет локи целиком.
- [Как отменить долго работающую Task в C# без deadlock](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) — это компаньон по отмене для этого поста.
- [.NET 9: конец lock(object)](/2026/01/net-9-the-end-of-lockobject/) — это новостная вводная по типу, написанная на релиз .NET 9.
- [Как написать source generator для INotifyPropertyChanged](/ru/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) показывает, какой генератор вам, возможно, придётся обновить под `Lock`.

## Источники

- [Справочник API `System.Threading.Lock`](https://learn.microsoft.com/dotnet/api/system.threading.lock) на Microsoft Learn.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812) -- предложение и обсуждение дизайна.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) Стивена Тоуба.
- [Что нового в C# 13](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13) описывает распознавание паттерна на уровне компилятора.
