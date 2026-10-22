---
title: "Lazy<T> vs LazyInitializer.EnsureInitialized vs блокировка с двойной проверкой в C#"
description: "По умолчанию используйте Lazy<T>: он выполняет фабрику один раз, кеширует исключения, а чтение после инициализации слишком дёшево, чтобы его можно было измерить. LazyInitializer.EnsureInitialized подходит, когда вы лениво заполняете много полей или ячеек массива и не можете позволить себе лишний объект на каждое значение. Ручная блокировка с двойной проверкой на .NET 10 почти никогда не оправдана."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "ru"
translationOf: "2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-22
---

По умолчанию используйте `Lazy<T>`. С конструктором по умолчанию (режим `ExecutionAndPublication`) он гарантирует, что фабрика выполнится ровно один раз даже при конкуренции потоков, кеширует исключение фабрики, а когда значение уже создано, чтение сводится к одной проверке на null и загрузке поля, что слишком дёшево для BenchmarkDotNet. К `LazyInitializer.EnsureInitialized` стоит обратиться, когда у вас много лениво создаваемых значений (поле на каждое свойство часто создаваемого типа или ячейки массива), а лишний объект `Lazy<T>` на каждое значение как раз и есть та цена, которую вы хотите убрать. Ручная блокировка с двойной проверкой не даёт ничего, чего не давал бы `LazyInitializer.EnsureInitialized(ref field, ref syncLock, factory)`, поэтому пишите её, только когда нужно поведение, которого нет ни в одном из этих API.

Всё ниже измерено на .NET 10.0.10 (SDK 10.0.302), C# 14, BenchmarkDotNet 0.15.8, на Apple M4 (arm64). Сами API не меняли форму с .NET Core 3.0, поэтому рекомендации верны для .NET 8, 9, 10 и 11.

## Сравнение вкратце

| | `Lazy<T>` (по умолчанию) | `LazyInitializer.EnsureInitialized(ref t, f)` | `EnsureInitialized(ref t, ref sync, f)` | Блокировка с двойной проверкой |
| --- | --- | --- | --- | --- |
| Фабрика выполняется не более одного раза при конкуренции | Да | Нет, её может выполнить каждый конкурирующий поток | Да | Да, если написана правильно |
| Исключение из фабрики | Кешируется, выбрасывается снова и снова | Не кешируется, следующий вызов повторяет попытку | Не кешируется, следующий вызов повторяет попытку | Как вы напишете |
| Дополнительное выделение памяти на одно ленивое значение | Объект `Lazy<T>` плюс вспомогательный объект блокировки | Нет | Один объект блокировки, только при конкуренции или при первом вызове | Один объект блокировки (или общий) |
| Горячее чтение после инициализации (измерено) | менее 1 нс, не измеряется | менее 1 нс | менее 1 нс | менее 1 нс |
| Однократное создание и инициализация (измерено) | 13.96 нс, 96 Б | 6.19 нс, 48 Б | 14.03 нс, 80 Б | 8.96 нс, 72 Б |
| Работает с типами значений | Да | Нет (`where T : class`) | Нет, используйте перегрузку с `ref bool initialized` | Да, с отдельным флагом |
| Фабрика может вернуть `null` | Да | Нет, выбрасывается `InvalidOperationException` | Нет, выбрасывается `InvalidOperationException` | Да, с отдельным флагом |
| Повторный вход из фабрики | Выбрасывается `InvalidOperationException` | Переполнение стека | Переполнение стека (`Monitor` реентерабелен) | Зависит от типа блокировки |
| Строк кода, за которые отвечаете вы | 1 | 1 | 2 поля + 1 вызов | ~10 |

## Что на самом деле делает каждый вариант

### `Lazy<T>`

`Lazy<T>` оборачивает фабрику и ячейку для значения. Его свойство `Value` в .NET 10 состоит из одной строки:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Lazy.cs
public T Value => _state == null ? _value! : CreateValue();
```

`_state` это volatile-ссылка на `LazyHelper`, которая описывает режим и для `ExecutionAndPublication` служит заодно объектом блокировки. Первый вызов попадает в `CreateValue`, который берёт `lock (executionAndPublication)`, повторно проверяет состояние, выполняет вашу фабрику, сохраняет `_value`, а затем volatile-записью выставляет `_state = null`. Каждый следующий вызов видит `_state == null` и возвращает поле. Это и есть блокировка с двойной проверкой, написанная один раз людьми, которые читали спецификацию модели памяти внимательнее большинства из нас.

Режим потокобезопасности выбирается конструктором:

```csharp
// .NET 10, C# 14
var a = new Lazy<Config>(LoadConfig);                                          // ExecutionAndPublication
var b = new Lazy<Config>(LoadConfig, isThreadSafe: true);                      // ExecutionAndPublication
var c = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.PublicationOnly);    // threads race, first publish wins
var d = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.None);               // single-threaded only
```

### `LazyInitializer.EnsureInitialized`

`LazyInitializer` это статический класс, который работает с принадлежащим вам полем через `ref`. Объекта-обёртки нет. Двухаргументная перегрузка целиком выглядит так:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Threading/LazyInitializer.cs
public static T EnsureInitialized<T>(ref T? target, Func<T> valueFactory) where T : class =>
    Volatile.Read(ref target!) ?? EnsureInitializedCore(ref target, valueFactory);

private static T EnsureInitializedCore<T>(ref T? target, Func<T> valueFactory) where T : class
{
    T value = valueFactory() ?? throw new InvalidOperationException(SR.Lazy_StaticInit_InvalidOperation);
    Interlocked.CompareExchange(ref target, value, null!);
    return target;
}
```

Блокировки нет. Каждый поток, увидевший `null`, выполняет фабрику, а `CompareExchange` решает, чей результат будет сохранён. Объекты проигравших отбрасываются (и в документации отмечено, что метод "will not dispose of the objects that were not stored"). Это семантика `PublicationOnly` без обёртки.

Трёхаргументная перегрузка, `EnsureInitialized(ref target, ref syncLock, valueFactory)`, добавляет блокировку. Она лениво создаёт обычный `object` в `syncLock` через `CompareExchange`, а затем выполняет `lock (syncLock) { if (Volatile.Read(ref target) == null) Volatile.Write(ref target, valueFactory()); }`. Это классическая блокировка с двойной проверкой, и фабрика выполняется один раз.

Для типов значений, а также когда `null` является допустимым результатом, есть перегрузки с дополнительным флагом `ref bool initialized`. Они всегда идут по пути с блокировкой.

### Ручная блокировка с двойной проверкой

Правильная современная версия для .NET 9 и новее, с типом `System.Threading.Lock`:

```csharp
// .NET 10, C# 14
public sealed class ReportCache
{
    private volatile Report? _report;
    private readonly Lock _lock = new();

    public Report Report
    {
        get
        {
            var r = _report;               // one volatile read on the fast path
            if (r is not null) return r;
            lock (_lock)
            {
                return _report ??= BuildReport();
            }
        }
    }

    private static Report BuildReport() => new();
}

public sealed class Report;
```

`volatile` здесь действительно нужен. Спецификация модели памяти .NET (`docs/design/specs/Memory-model.md` в dotnet/runtime) говорит, что запись ссылки на объект в разделяемую память является release-операцией, а чтения, зависимые по данным, через неё упорядочены, поэтому классической ошибки "наполовину сконструированного объекта" в CoreCLR не бывает. Но там же прямо предупреждается, что побочные эффекты упорядочивания при присваивании ссылки не следует использовать для общих целей упорядочивания, а поле без `volatile` позволяет JIT поднимать или объединять чтения `_report`. Пометьте поле `volatile` или читайте его через `Volatile.Read`, и шаблон будет корректен на любой архитектуре, на которой работает .NET.

## Проверка поведения при конкуренции

В документации сказано "may run more than once". Мне нужно было число. Этот тест запускает 16 потоков на `Barrier`, заставляет их одновременно обратиться к ленивому значению, использует фабрику, которая крутится около 20 000 итераций, чтобы расширить окно гонки, и повторяет всё 200 раз, записывая худший раунд:

```csharp
// .NET 10.0.10, C# 14, Apple M4, 10 cores
static int Race(Func<Func<object>, Func<object>> makeAccessor)
{
    int maxCalls = 0;
    for (int r = 0; r < 200; r++)
    {
        int calls = 0;
        Func<object> factory = () =>
        {
            Interlocked.Increment(ref calls);
            Thread.SpinWait(20_000);
            return new object();
        };
        var access = makeAccessor(factory);
        using var barrier = new Barrier(16);
        var results = new object[16];
        var threads = Enumerable.Range(0, 16)
            .Select(i => new Thread(() => { barrier.SignalAndWait(); results[i] = access(); }))
            .ToArray();
        foreach (var t in threads) t.Start();
        foreach (var t in threads) t.Join();
        if (results.Distinct().Count() != 1) throw new Exception("different instances returned");
        maxCalls = Math.Max(maxCalls, calls);
    }
    return maxCalls;
}
```

Результаты, худший раунд из 200:

| Вариант | Максимум вызовов фабрики за один раунд |
| --- | --- |
| `Lazy<T>` по умолчанию (`ExecutionAndPublication`) | 1 |
| `Lazy<T>` `PublicationOnly` | 11 |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 12 |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 1 |

Каждый вариант во всех раундах вернул один и тот же экземпляр всем 16 потокам, так что небезопасных среди них нет. Разница в напрасной работе. Если ваша фабрика открывает сокет, читает файл на 40 МБ или вызывает платный API, 12 параллельных выполнений это реальная ошибка, даже если опубликованное значение корректно.

## Ловушка кеширования исключений

Это различие в поведении, которое бьёт в продакшене. Одна и та же фабрика, падает при первом вызове и успешно отрабатывает при втором:

```csharp
// .NET 10.0.10, C# 14
int attempts = 0;
Func<string> flaky = () => ++attempts == 1 ? throw new InvalidOperationException("transient") : "ok";

var lazy = new Lazy<string>(flaky);
// lazy.Value -> InvalidOperationException: transient
// lazy.Value -> InvalidOperationException: transient   (factory not called again)

string? field = null;
// LazyInitializer.EnsureInitialized(ref field, flaky) -> InvalidOperationException: transient
// LazyInitializer.EnsureInitialized(ref field, flaky) -> "ok"
```

Тест это подтвердил: `Lazy<T>` по умолчанию вызвал фабрику один раз и при каждом последующем обращении выбрасывал то же самое исключение. `PublicationOnly` и `LazyInitializer` вызвали её дважды и восстановились.

Таблица исключений в MS Learn формулирует правило так: любой конструктор `Lazy<T>`, принимающий `valueFactory`, кеширует исключения, если только режим не `PublicationOnly`. Конструктор без параметров (который использует `Activator.CreateInstance`) не кеширует. Поэтому `Lazy<HttpClient>`, фабрика которого читает значение конфигурации, отсутствующее при запуске, будет выбрасывать исключение всё время жизни процесса, даже когда конфигурация появится. Если сбой может быть временным, используйте `PublicationOnly`, используйте `LazyInitializer` или заменяйте экземпляр `Lazy<T>` в `catch`.

С `Lazy<Task<T>>` ловушка вдвое коварнее: фабрика не выбрасывает исключение, а возвращает `Task` в состоянии ошибки, и эта задача с ошибкой кешируется как успешное значение в любом режиме. Если вы кешируете асинхронную работу, проверяйте `IsFaulted` и подменяйте экземпляр или используйте настоящий кеш.

## Бенчмарк

Два вопроса: сколько стоит чтение, когда значение уже создано, и сколько стоит каждый вариант на экземпляр, когда вы создаёте владельца и один раз обращаетесь к значению. Методика: BenchmarkDotNet 0.15.8, задание по умолчанию, `[MemoryDiagnoser]`, .NET 10.0.10 arm64 RyuJIT, Apple M4, macOS. У каждого класса-держателя есть свойство `Value`; `Expensive` это крошечный класс, чтобы измерялась именно ленивая механика, а не фабрика. Полный исходный код это классы `HotPath` и `ColdPath` ниже.

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8
public sealed class LazyHolder
{
    private readonly Lazy<Expensive> _value = new(() => new Expensive());
    public Expensive Value => _value.Value;
}

public sealed class LazyInitHolder
{
    private Expensive? _value;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, static () => new Expensive());
}

public sealed class LazyInitLockHolder
{
    private Expensive? _value;
    private object? _sync;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, ref _sync, static () => new Expensive());
}

[MemoryDiagnoser]
public class ColdPath
{
    [Benchmark(Baseline = true)] public int Plain() => new PlainHolder().Value.Id;
    [Benchmark] public int Lazy_ExecutionAndPublication() => new LazyHolder().Value.Id;
    [Benchmark] public int LazyInitializer_Factory() => new LazyInitHolder().Value.Id;
    [Benchmark] public int LazyInitializer_SyncLock() => new LazyInitLockHolder().Value.Id;
    [Benchmark] public int DoubleChecked_Lock() => new DoubleCheckedHolder().Value.Id;
    [Benchmark] public int Lazy_NeverTouched() => new LazyHolder() is null ? 0 : 1;
}
```

Горячий путь (значение уже создано, одно чтение):

| Метод (.NET 10.0.10, arm64) | Среднее | Выделено |
| --- | --- | --- |
| Обычное поле (`??=`, не потокобезопасно) | 0.000 нс | 0 Б |
| `Lazy<T>` `ExecutionAndPublication` | 0.000 нс | 0 Б |
| `Lazy<T>` `PublicationOnly` | 0.000 нс | 0 Б |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 0.495 нс | 0 Б |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 0.289 нс | 0 Б |
| Блокировка с двойной проверкой (`volatile` + `Lock`) | 0.314 нс | 0 Б |

Холодный путь (создать владельца, один раз прочитать значение):

| Метод (.NET 10.0.10, arm64) | Среднее | Отношение | Выделено |
| --- | --- | --- | --- |
| Обычное поле (`??=`, не потокобезопасно) | 1.53 нс | 1.00 | 24 Б |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 6.19 нс | 4.04 | 48 Б |
| Блокировка с двойной проверкой (`volatile` + `Lock`) | 8.96 нс | 5.85 | 72 Б |
| `Lazy<T>` `PublicationOnly` | 9.68 нс | 6.32 | 64 Б |
| `Lazy<T>` `ExecutionAndPublication` | 13.96 нс | 9.12 | 96 Б |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 14.03 нс | 9.16 | 80 Б |
| `Lazy<T>` создан, `Value` не читался | 6.17 нс | 4.03 | 72 Б |

Горячий путь не даёт разницы. Когда значение уже существует, каждый вариант оказывается ниже разрешающей способности BenchmarkDotNet: JIT первого уровня (tier-1) встраивает `Lazy<T>.Value` до проверки `_state` на null и загрузки поля, и BenchmarkDotNet показывает это неотличимым от пустого метода. Субнаносекундные значения в остальных строках лежат в пределах шума. Если вам говорят заменить `Lazy<T>` самописным кодом "ради скорости чтения", измерения показывают, что выигрывать там нечего.

Различаются варианты на холодном пути, и в основном из-за выделения памяти. Строки `Lazy<T>` говорят сами за себя: `Lazy<T>` стоит 72 байта ещё до того, как его кто-либо прочитал (сам объект `Lazy<T>` плюс `LazyHelper`, который `ExecutionAndPublication` выделяет в конструкторе, чтобы блокироваться на нём), и около 14 нс на однократное создание и инициализацию. `PublicationOnly` обходится без helper, поэтому он дешевле на 8 байт и 4 нс. Перегрузка `LazyInitializer` без блокировки это самый дешёвый потокобезопасный вариант с 6.2 нс, потому что не выделяет ничего, кроме самого значения. Перегрузка с `ref syncLock` платит за объект блокировки, который создаёт при первом вызове, поэтому её однократная стоимость оказывается рядом с `Lazy<T>`.

Одна оговорка про столбец `Allocated`: escape-анализ в .NET 10 размещает на стеке объекты-держатели, которые заведомо не покидают метод, поэтому у обычного базового варианта всего 24 байта. Читайте этот столбец относительно базового варианта, а не как абсолютные размеры объектов.

В абсолютных величинах 8 нс и 48 байт на ленивое значение имеют значение, только когда вы создаёте миллионы владельцев. Сервис с полем `Lazy<T>`, которое создаётся один раз при запуске, этого никогда не заметит.

## Когда выбирать `Lazy<T>`

- **Зависимость типа "почти синглтон" внутри класса**: разобранная конфигурация, скомпилированный `Regex`, клиент, построенный из настроек. Одно поле `Lazy<T>`, одна строка, фабрика выполняется один раз.
- **Дорогие фабрики или фабрики с побочными эффектами**: всё, что открывает соединение или вызывает API. Режим по умолчанию единственный вариант без усилий, который гарантирует одно выполнение.
- **Типы значений или результат `null`**: `Lazy<int>` и `Lazy<string?>` просто работают. Тест подтвердил, что `new Lazy<string?>(() => null).Value` возвращает `null` при `IsValueCreated == true`.
- **Нужна понятная ошибка при рекурсии**: фабрика, обращающаяся к собственному `Value`, получает `InvalidOperationException: ValueFactory attempted to access the Value property of this instance.` вместо переполнения стека.

## Когда выбирать `LazyInitializer.EnsureInitialized`

- **Много ленивых полей в типе с большим числом экземпляров**: обёртка `Lazy<T>` это один объект на значение, и он создаётся, даже если значение никто не прочитает (72 байта в строке "не читался" таблицы холодного пути). Именно этот случай в рекомендациях MS Learn назван причиной использовать `LazyInitializer`: ленивая инициализация "without the overhead of a class".
- **Массивы лениво создаваемых элементов**: `LazyInitializer.EnsureInitialized(ref _slots[i], () => Build(i))` работает с элементами массива, потому что на них можно взять `ref`. Эквивалента `Lazy<T>[]`, который не выделяет по обёртке на каждую ячейку заранее, нет.
- **Дешёвые чистые фабрики**: если двойное выполнение фабрики при гонке ничего не стоит, двухаргументная перегрузка без блокировки это самый дешёвый корректный вариант.
- **Нужна повторная попытка после сбоя**: ни одна перегрузка не кеширует исключения.

Используйте перегрузку с `ref syncLock`, когда фабрика должна выполниться один раз. Передайте поле типа `object?`, которое изначально равно `null`: оно выделяется только при первом вызове, дошедшем до медленного пути.

## Когда ручная блокировка с двойной проверкой всё ещё оправдана

Редко. Два случая, в которых она реально понадобилась мне:

- **Нужно сбросить или подменить значение**. Ни `Lazy<T>`, ни `LazyInitializer` не позволяют инвалидировать значение. Кешу, который перестраивается по сигналу, нужны собственная блокировка и volatile-поле.
- **Медленному пути нужно больше, чем фабрика**: атомарная инициализация двух полей или вызов асинхронного API под `SemaphoreSlim`. В этот момент это уже не совсем ленивая инициализация, а небольшой конечный автомат, и писать его стоит явно.

Если вы пишете её сами, используйте `System.Threading.Lock` на .NET 9+, держите поле `volatile`, на быстром пути читайте его в локальную переменную один раз и никогда не блокируйтесь на `this`.

## Нюанс, который выбирает за вас

Для **статических** ленивых значений, скорее всего, не нужен ни один из трёх вариантов. Поле `static readonly`, инициализируемое инициализатором типа, ленивое (среда выполнения запускает его перед первым обращением к полю), потокобезопасное и бесплатное на горячем пути, потому что JIT первого уровня (tier-1) трактует поля `static readonly` уже инициализированного класса как константы:

```csharp
// .NET 10, C# 14
public static class Pricing
{
    public static readonly FrozenDictionary<string, decimal> Table = LoadTable();
    private static FrozenDictionary<string, decimal> LoadTable() => /* ... */ FrozenDictionary<string, decimal>.Empty;
}
```

Подвох: если `LoadTable` выбросит исключение, тип остаётся сломанным на всё время жизни процесса, и каждое обращение выбрасывает `TypeInitializationException`. Это то же поведение кеширования, что у `Lazy<T>`, только восстановиться ещё сложнее. Используйте статический `Lazy<T>`, когда нужна семантика повторной попытки `PublicationOnly` или когда у типа есть другие статические члены, которые должны оставаться пригодными, даже если загрузка не удалась.

## Рекомендация ещё раз

Начинайте с `Lazy<T>` и режима по умолчанию. Он выполняет фабрику один раз, на горячем пути это одна проверка на null, а его единственный настоящий недостаток (кешируемые исключения) можно отключить через `PublicationOnly`. Переходите на `LazyInitializer.EnsureInitialized`, когда профилирование показывает, что выделения под обёртки существенны, а на практике это означает много экземпляров с несколькими ленивыми полями у каждого. Используйте перегрузку с `ref syncLock`, если фабрика должна выполниться один раз. Блокировку с двойной проверкой пишите сами, только когда нужно сбрасывать значение или атомарно инициализировать больше одного объекта.

## Связанные материалы

- Если вы сами пишете медленный путь под блокировкой, статья [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ru/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) поможет выбрать примитив.
- [Разбор типа System.Threading.Lock](/ru/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) объясняет, почему `lock` на поле типа `Lock` быстрее, чем блокировка на `object`.
- Что на самом деле генерируют `volatile` и `Volatile.Read` на arm64, смотрите в [Volatile.Read vs Volatile.ReadBarrier in .NET 10](/ru/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/).
- Когда ленивое значение на самом деле является записью кеша, которая должна истекать или быть асинхронной, лучше подойдёт [HybridCache vs IMemoryCache vs IDistributedCache](/ru/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/).
- `Lazy<T>` внутри синглтона, захватывающий scoped-сервис, это та же ошибка захваченной зависимости, что описана в [fixing "Cannot consume scoped service from singleton"](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

## Источники

- [Lazy initialization](https://learn.microsoft.com/en-us/dotnet/framework/performance/lazy-initialization) на MS Learn, включая таблицу кеширования исключений.
- Справочник API [`LazyInitializer.EnsureInitialized`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized).
- Справочник API [`LazyThreadSafetyMode`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazythreadsafetymode).
- [`Lazy.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Lazy.cs) и [`LazyInitializer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Threading/LazyInitializer.cs) в dotnet/runtime `release/10.0`.
- [Спецификация модели памяти .NET](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md), разделы "Object assignment" и "Data-dependent reads are ordered".
