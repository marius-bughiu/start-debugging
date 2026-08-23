---
title: "Как понять, что IEnumerable<T> в C# уже материализован"
description: "У IEnumerable<T> нет флага HasBeenEnumerated. Разбираем, что на самом деле проверяет TryGetNonEnumeratedCount, почему Enumerable.Range проходит проверку на ICollection<T> и какая проверка спасает от лишнего ToList()."
pubDate: 2026-08-23
tags:
  - "csharp"
  - "linq"
  - "dotnet"
  - "performance"
lang: "ru"
translationOf: "2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-23
---

В .NET нет API, который отвечает на вопрос "была ли эта последовательность `IEnumerable<T>` уже перечислена", и нет API, который отвечает на вопрос "лежит ли эта последовательность в памяти". У интерфейса ровно один член, `GetEnumerator()`, и контракт не требует от реализации помнить о том, что вы его вызывали. Что действительно доступно, так это `Enumerable.TryGetNonEnumeratedCount` (.NET 6 и новее), который сообщает, дёшево ли получить *количество* элементов, плюс набор проверок типа, которые вы можете выполнить сами. Эти два сигнала пересекаются с понятием "уже материализовано", но не совпадают с ним, и именно в зазорах между ними живут ошибки. Всё изложенное ниже измерено на .NET 10.0.201 с C# 14.

## Почему у вопроса нет прямого ответа

`IEnumerable<T>` это фабрика перечислителей, а не контейнер. Вызвать `GetEnumerator()` дважды допустимо, и каждый вызов вправе выдать новый независимый проход по данным. `List<int>` отдаёт вам структурный перечислитель над уже существующим массивом. Метод с `yield return` строит машину состояний, которая выполняет тело метода с самого начала. `DbSet<T>` открывает соединение и отправляет SQL. Все три удовлетворяют одному интерфейсу, и только первый держит элементы в памяти.

Так что вопрос "материализовано ли это" распадается на три отдельных вопроса, которые часто смешивают:

1. Лежат ли элементы уже в памяти, так что второй проход будет бесплатным?
2. Доступно ли количество без обхода последовательности?
3. Был ли *именно этот* объект последовательности уже пройден один раз?

BCL даёт частичный ответ на (1), хороший ответ на (2) и никакого ответа на (3).

## Что среда выполнения действительно отслеживает: машина состояний итератора

Итераторы, сгенерированные компилятором, всё же несут поле состояния, и в него можно заглянуть. Это средство отладки, а не API, но посмотреть на него один раз стоит, потому что оно объясняет наблюдаемое поведение:

```csharp
// .NET 10.0.201, C# 14
static IEnumerable<int> Lazy()
{
    yield return 1;
    yield return 2;
}

static string ReadState(object o)
{
    var f = o.GetType().GetField("<>1__state",
        BindingFlags.Instance | BindingFlags.NonPublic);
    return f is null ? "no state field" : $"{f.GetValue(o)}";
}

var seq = Lazy();
Console.WriteLine(ReadState(seq));      // -2  : constructed, never enumerated
var e = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, e)); // True : the first call returns "this"
e.MoveNext();
Console.WriteLine(ReadState(seq));      // 1   : mid-enumeration
```

Значение `-2` это быстрый путь компилятора: первый вызов `GetEnumerator()` в создавшем потоке переводит состояние в `0` и возвращает тот же самый объект вместо выделения клона. Каждый последующий вызов возвращает клон с собственным состоянием. Поэтому второй перечислитель начинает с начала, пока первый сохраняет свою позицию, и поэтому нет общего бита "уже перечислено", который можно было бы прочитать. Рефлексия по `<>1__state` рассказывает про один объект, на одном пути выполнения, для одного компилятора; в продакшен это отправлять не стоит.

## TryGetNonEnumeratedCount и что именно он проверяет

Добавленный в .NET 6 и сохранивший ту же форму в .NET 11, `Enumerable.TryGetNonEnumeratedCount` это единственный поддерживаемый примитив в духе "посмотреть, не трогая". [Реализация в среде выполнения](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs) состоит из трёх проверок типа по порядку:

```csharp
// System.Linq.Enumerable, .NET 10, abridged
public static bool TryGetNonEnumeratedCount<TSource>(
    this IEnumerable<TSource> source, out int count)
{
    if (source is ICollection<TSource> collectionoft) { count = collectionoft.Count; return true; }
    if (source is Iterator<TSource> iterator)
    {
        int c = iterator.GetCount(onlyIfCheap: true);
        if (c >= 0) { count = c; return true; }
    }
    if (source is ICollection collection) { count = collection.Count; return true; }
    count = 0;
    return false;
}
```

`Iterator<TSource>` это внутренний базовый класс собственных итераторов LINQ, поэтому средняя ветка и есть та часть, которую нельзя воспроизвести снаружи `System.Linq`. В [документации](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) сказано прямо: "серия проверок типа, выявляющих распространённые подтипы, количество элементов которых можно определить без перечисления".

Если прогнать через этот метод все распространённые формы последовательностей, добавив проверки типа, которые вы написали бы руками, на .NET 10.0.201 получается такая картина:

| Последовательность | `TryGetNonEnumeratedCount` | `is ICollection<T>` | `is IReadOnlyCollection<T>` | `is IQueryable` |
| --- | --- | --- | --- | --- |
| `int[]` | true, 3 | true | true | false |
| `List<int>` | true, 3 | true | true | false |
| `HashSet<int>` | true, 3 | true | true | false |
| `Queue<int>` | true, 3 | **false** | true | false |
| `Stack<int>` | true, 3 | **false** | true | false |
| `ReadOnlyCollection<int>` | true, 3 | true | true | false |
| `ImmutableArray<int>` | true, 3 | true | true | false |
| `Enumerable.Empty<int>()` | true, 0 | true | true | false |
| `Enumerable.Range(0, 1_000_000_000)` | **true, 1000000000** | **true** | true | false |
| `Enumerable.Repeat(7, 500)` | true, 500 | true | true | false |
| `list.Select(x => x)` | **true, 3** | false | false | false |
| `list.Where(x => true)` | false | false | false | false |
| `list.Take(2)` | true, 2 | **true** | true | false |
| `list.Skip(1)` | true, 2 | **true** | true | false |
| `list.OrderBy(x => x)` | true, 3 | false | false | false |
| `list.Distinct()` | false | false | false | false |
| `list.Concat(list)` | true, 6 | false | false | false |
| `((IEnumerable)list).Cast<int>()` | true, 3 | true | true | false |
| `list.DefaultIfEmpty()` | true, 3 | false | false | false |
| `Enumerable.Reverse(list)` | true, 3 | false | false | false |
| `list.GroupBy(x => x).SelectMany(g => g)` | false | false | false | false |
| метод-итератор с `yield return` | false | false | false | false |
| `list.AsQueryable()` | false | false | false | **true** |
| `list.ToList()` / `.ToArray()` | true, 3 | true | true | false |

## Три ловушки, спрятанные в этой таблице

**Дешёвое количество не означает материализованную последовательность.** `Enumerable.Range(0, 1_000_000_000)` за константное время сообщает о миллиарде элементов и проходит проверку `is ICollection<int>`, хотя ничего не было выделено. `RangeIterator` реализует `IList<T>` начиная с .NET 8; на .NET 6 и .NET 7 то же выражение проверку `ICollection<T>` не проходило, потому что итератор реализовывал только внутренний `IPartition<int>`. Если ваш код пишет `if (source is ICollection<T>) { /* safe to keep the reference */ }`, он заодно утверждает, что безопасно держать последовательность из миллиарда элементов и перечислять её дважды.

Та же ловушка проявляется на `Select`. `list.Select(x => x)` возвращает из `TryGetNonEnumeratedCount` значение `true` с количеством исходного списка, потому что количество элементов проекции равно количеству элементов источника. Селектор при этом не выполнился ни для одного элемента. Получение количества ничего не сказало о том, выполнена ли работа.

**`ICollection<T>` пропускает два очень распространённых типа.** `Queue<T>` и `Stack<T>` реализуют негенерический `ICollection` и генерический `IReadOnlyCollection<T>`, но не `ICollection<T>`. Проверка, написанная как `source as ICollection<T>`, тихо скатывается к защитному копированию в обоих случаях. `IReadOnlyCollection<T>` подходит лучше, если вам нужны только `Count` и повторное перечисление.

**Отложенное не значит неисчислимое, а исчислимое не значит дешёвое для обхода.** `Where` и `Distinct` возвращают `false` даже когда источник это `List<int>`, потому что количество определяется предикатом. `OrderBy` возвращает `true` с количеством источника, но его перечисление всё равно выполняет полную сортировку. Не воспринимайте результат `true` как разрешение перечислять сколько угодно раз.

## Ленивая ICollection<T> обманывает любую проверку

Любой приём здесь это проверка типа, а проверку типа может удовлетворить реализация, которая делает дорогую работу при каждом `GetEnumerator()`. Это не гипотетический случай: навигационное свойство-коллекция в Entity Framework Core под прокси ленивой загрузки представляет собой `ICollection<T>`, перечисление которой может уйти в базу данных.

```csharp
// .NET 10.0.201, C# 14
sealed class LazyCollection : ICollection<int>
{
    public static int WorkDone;
    public int Count => 3;              // cheap, known up front
    public bool IsReadOnly => true;
    public IEnumerator<int> GetEnumerator()
    {
        WorkDone++;                     // expensive, runs on every pass
        return Enumerable.Range(0, 3).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    // mutating members omitted
}
```

Этот тип сообщает `is ICollection<int> == true` и `TryGetNonEnumeratedCount == true` с количеством 3, не выполнив никакой работы. После одного `foreach` значение `WorkDone` равно 1, и оно растёт с каждым следующим проходом. Ни один API не отличит это от `List<int>`. Если граница принадлежит вам, решение состоит в том, чтобы перестать передавать `IEnumerable<T>` и начать передавать `IReadOnlyList<T>` или конкретный тип, превращая догадку во время выполнения в гарантию во время компиляции. Это тот же аргумент, что и при [выборе правильного возвращаемого типа между IEnumerable, IAsyncEnumerable и IQueryable](/ru/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/).

## Проверка, которую стоит написать

На практике никому не нужен флаг `HasBeenEnumerated`. Нужно знать, окажется ли защитный `ToList()` напрасным. Отвечайте прямо на этот вопрос:

```csharp
// .NET 10.0.201, C# 14
public static IReadOnlyCollection<T> Materialize<T>(this IEnumerable<T> source)
{
    ArgumentNullException.ThrowIfNull(source);

    return source switch
    {
        // Deferred against a remote store: always pull it in, once.
        IQueryable<T> q => q.ToList(),

        // Known in-memory BCL types: reuse the reference, no copy.
        T[] a => a,
        List<T> l => l,
        IReadOnlyCollection<T> c when c.GetType().Assembly == typeof(List<T>).Assembly => c,

        _ => source.ToList(),
    };
}
```

Ветка `IQueryable<T>` идёт первой, потому что запрос это единственный случай, когда второе перечисление однозначно означает второй обход к серверу, и когда проверки типа LINQ всё равно возвращают `false`. Проверка сборки в третьей ветке намеренно консервативна: она принимает `Queue<T>`, `Stack<T>`, `ReadOnlyCollection<T>` и подобные типы, отвергая приведённый выше `LazyCollection` и любой навигационный тип ORM. Если в вашей кодовой базе нет коллекций с ленивой подложкой, сократите эту ветку до простого `IReadOnlyCollection<T> c => c` и оставьте однострочный вариант.

Обратите внимание, чего в этой проверке *нет*: `TryGetNonEnumeratedCount`. Он отвечает на другой вопрос. Применяйте его, когда вам действительно нужно количество и вы готовы к запасному варианту, то есть в том сценарии, для которого он и создавался:

```csharp
// .NET 10.0.201, C# 14
int capacity = source.TryGetNonEnumeratedCount(out int known) ? known : 16;
var buffer = new List<T>(capacity);
```

## Что экономит эта проверка

Измерено с помощью `Stopwatch` и `GC.GetAllocatedBytesForCurrentThread`, 100 итераций, на `List<int>` из 1 000 000 элементов, переданном как `IEnumerable<int>`, .NET 10.0.201 в конфигурации Release:

| Подход | Время | Выделено |
| --- | --- | --- |
| `input.ToList()` | 793.93 us/op | 4 000 056 байт/op |
| `input as IReadOnlyCollection<int> ?? input.ToList()` | 1.09 us/op | 0 байт/op |

Это грубые замеры в цикле, а не числа BenchmarkDotNet, но колонка выделений точна, и в ней вся суть: слепое копирование при каждом вызове выделяет второй четырёхмегабайтный массив в куче больших объектов, а проверка не выделяет ничего. На горячем пути, который получает уже материализованный список, защитное копирование составляет всю стоимость метода. Те же рассуждения применимы, когда вы пытаетесь [прочитать большой файл, не исчерпав память](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

## Пусть анализатор сам найдёт места вызова

Проверять это вручную не нужно. Правило CA1851, "Possible multiple enumerations of 'IEnumerable' collection", появилось в .NET 7 и в .NET 10 **по-прежнему не включено по умолчанию**. Включите его:

```ini
# .editorconfig
[*.{cs,vb}]
dotnet_diagnostic.CA1851.severity = warning
```

При `EnableNETAnalyzers` и `AnalysisLevel` со значением `latest` этот код выдаёт на .NET 10.0.201 две диагностики:

```csharp
public static void Twice(IEnumerable<int> input)
{
    var count = input.Count();              // CA1851
    foreach (var i in input) { _ = i; }     // CA1851
}
```

```text
warning CA1851: Possible multiple enumerations of 'IEnumerable' collection.
Consider using an implementation that avoids multiple enumerations.
```

Переписывание тела так, чтобы оно сначала связывалось через проверку, снимает оба предупреждения:

```csharp
public static void Guarded(IEnumerable<int> input)
{
    var list = input as IReadOnlyCollection<int> ?? input.ToList();
    var count = list.Count;
    foreach (var i in list) { _ = i; }
}
```

Для реальных кодовых баз важны две настройки. `enumeration_methods` позволяет зарегистрировать ваши собственные методы, потребляющие аргумент `IEnumerable`, а `assume_method_enumerates_parameters` меняет предположение по умолчанию, согласно которому пользовательский метод *не* перечисляет то, что ему передали. Именно из-за этого умолчания CA1851 молчит, когда вы передаёте одну и ту же последовательность в два своих вспомогательных метода.

## Для IQueryable и IAsyncEnumerable нужны отдельные правила

Для `IQueryable<T>` ничего из перечисленного не работает: любая проверка типа возвращает `false`, а каждое перечисление это новая трансляция провайдером и новый обход к серверу. Нужный вам сигнал это статический тип, а решение состоит в однократном вызове `ToListAsync()` на границе. Повторное перечисление запроса внутри цикла это одна из форм [проблемы N+1 запросов в EF Core](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), а запрос, который вообще не транслируется, даёт [ошибку "The LINQ expression could not be translated"](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), а не тихий двойной обход.

Для `IAsyncEnumerable<T>` нет ни `TryGetNonEnumeratedCount`, ни аналога `ICollection<T>`, ни дешёвого количества. Единственный способ узнать, сколько элементов содержит асинхронная последовательность, это дождаться их всех, чего [IAsyncEnumerable как раз и позволяет избежать](/ru/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/). Материализуйте один раз через `await source.ToListAsync()` и передавайте список дальше либо перестройте код так, чтобы хватило одного прохода.

Честный итог таков: вопрос "материализовано ли это" ответа не имеет, а вопрос "будет ли второй проход дешёвым" в большинстве случаев имеет. Проверяйте сначала `IQueryable<T>`, затем `IReadOnlyCollection<T>` вместо `ICollection<T>`, воспринимайте `TryGetNonEnumeratedCount` как подсказку о ёмкости, а не как проверку материализации, и позвольте CA1851 показать, где вы об этом забыли.

## Связанные материалы

- [IEnumerable vs IAsyncEnumerable vs IQueryable в C#: что должен возвращать метод?](/ru/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [Что такое IAsyncEnumerable&lt;T&gt; и когда его использовать?](/ru/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [Как обнаружить N+1 запросы в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Как прочитать большой CSV в .NET 11, не исчерпав память](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Решение: "The LINQ expression could not be translated" в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Источники

- [Enumerable.TryGetNonEnumeratedCount&lt;TSource&gt; Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) на MS Learn
- [Count.cs в dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs), реализация проверок типа
- [Range.SpeedOpt.cs в dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Range.SpeedOpt.cs), где `RangeIterator` объявляет `IList<T>`
- [CA1851: Possible multiple enumerations of 'IEnumerable' collection](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1851) на MS Learn
- [Отложенное выполнение и ленивые вычисления в LINQ](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation) на MS Learn
