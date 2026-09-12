---
title: "Lookup<TKey, TElement> или Dictionary<TKey, List<TValue>> для повторяющихся ключей в C#"
description: "Используйте ToLookup, когда группировка строится один раз и дальше только читается: она неизменяема, для отсутствующего ключа возвращает пустую последовательность, принимает ключ null и сохраняет порядок первого появления. Используйте Dictionary<TKey, List<TValue>>, когда группы меняются после создания или проходят через границу JSON."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "collections"
  - "performance"
lang: "ru"
translationOf: "2026/09/lookup-vs-dictionary-of-lists-for-duplicate-keys-in-csharp"
translatedBy: "claude"
translationDate: 2026-09-12
---

Когда в C# одному ключу должно соответствовать много значений, встроенных ответов два: `ILookup<TKey, TElement>` (его возвращает `Enumerable.ToLookup`) и написанный вручную `Dictionary<TKey, List<TValue>>`. **Выбирайте `ToLookup`, если группировка строится один раз из уже существующей последовательности и затем только читается**: это одна строка, результат неизменяем, для отсутствующего ключа возвращается пустая последовательность вместо исключения, ключ `null` допустим, а группы перечисляются в порядке первого появления. **Выбирайте `Dictionary<TKey, List<TValue>>`, если группы меняются после создания, если нужен `TryGetValue` или если результат должен проходить туда и обратно через JSON.** По производительности словарь немного впереди, но не настолько, чтобы это решало большинство случаев: на .NET 11 RC 1 написанный вручную словарь строится примерно на 30% быстрее, чем `ToLookup`, и читается на 3-13% быстрее, что для 100,000 элементов составляет меньше 2 ms. Всё описанное ниже запускалось на .NET 11 RC 1 (среда выполнения `11.0.0-rc.1.26425.128`, C# 15), а само поведение не менялось с момента появления `ToLookup` в .NET Framework 3.5.

## Две структуры рядом

| Поведение (.NET 11 RC 1)                    | `ILookup<TKey, TElement>` через `ToLookup` | `Dictionary<TKey, List<TValue>>`        |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Добавление или удаление после создания      | нет, неизменяем                          | да                                      |
| Индексатор по отсутствующему ключу          | пустая последовательность                | `KeyNotFoundException`                  |
| Ключ `null`                                 | допустим                                 | `ArgumentNullException`                 |
| Порядок перечисления групп                  | порядок первого появления ключа, по устройству типа | на практике порядок вставки, но без гарантий |
| Порядок элементов внутри группы             | порядок в источнике                      | тот порядок, в котором вы вызываете `Add` |
| `TryGetValue`                               | нет (`Contains` + индексатор)            | да                                      |
| Публичный конструктор                       | нет                                      | да                                      |
| Сериализация через `System.Text.Json`       | массив массивов, ключи теряются          | объект с ключами `TKey`                 |
| Десериализация через `System.Text.Json`     | `NotSupportedException`                  | да                                      |
| Построение из 100k элементов, 100 ключей    | 660 us, 1.91 MB                          | 477 us, 1.91 MB                         |
| Чтение 1,000 проб, 10,000 ключей            | 66.1 us, 29,344 B                        | 61.0 us, 0 B                            |

В большинстве реальных случаев решают первые две строки и строки про JSON. Остальное - детали, которые аукнутся позже, если выбор был сделан не по той оси.

## Что на самом деле строит ToLookup

У `Lookup<TKey, TElement>` нет публичного конструктора. `Enumerable.ToLookup` - единственный способ его получить, а исходный код в [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) показывает, что именно вы получаете:

- Тип во время выполнения - внутренний `CollectionLookup<TKey, TElement>`, наследник публичного `Lookup<TKey, TElement>`, который также реализует `ICollection<IGrouping<TKey, TElement>>`, причём каждый изменяющий член выбрасывает `NotSupportedException`.
- Это собственная небольшая хеш-таблица: массив корзин `Grouping<TKey, TElement>` простого размера, который увеличивается через `HashHelpers.ExpandPrime`, с цепочками через поле `_hashNext`. `Dictionary` внутри не используется.
- Каждая группа также является узлом кольцевого связного списка и добавляется в него при появлении нового ключа. Перечисление обходит этот список, поэтому группы возвращаются в порядке первого появления. Это структурное свойство типа, а не случайность раскладки хеш-таблицы.
- Каждый `Grouping` хранит элементы в `TElement[]`, который начинается с длины 1 и удваивается, как у `List<T>`, и реализует `IList<TElement>` только для чтения.
- Ключ `null` хешируется в `0` без вызова компаратора, поэтому `null` является допустимым ключом.
- Если источник - пустой массив, вы получаете общий синглтон `EmptyLookup<TKey, TElement>.Instance`, и ничего не выделяется.

Из этого следуют две вещи. Во-первых, `ToLookup` **энергичный**: он сразу обходит весь источник, в отличие от `GroupBy`, который отложен и строит тот же внутренний `Lookup` при каждом перечислении. Во-вторых, `lookup[key].Count()` работает за O(1), потому что `Enumerable.Count` видит реализацию `ICollection<T>` у `Grouping` и читает количество напрямую.

## Поведение, которое действительно отличается

Вот небольшая программа, которая проверяет каждую строку таблицы. Запустите её как консольное приложение на .NET 11:

```csharp
// .NET 11 RC 1 (11.0.0-rc.1.26425.128), C# 15
var orders = new List<Order>
{
    new("alice", 1), new("bob", 2), new("alice", 3), new(null, 4), new("carol", 5),
};

var lookup = orders.ToLookup(o => o.Customer);
Console.WriteLine(lookup.GetType());                     // System.Linq.CollectionLookup`2[...]
Console.WriteLine(lookup.Count);                         // 4 (keys, not orders)
Console.WriteLine(lookup["dave"].Count());               // 0, no exception
Console.WriteLine(string.Join(",", lookup[null].Select(o => o.Id)));            // 4
Console.WriteLine(string.Join(",", lookup.Select(g => g.Key ?? "<null>")));     // alice,bob,<null>,carol

try { ((IList<Order>)lookup["alice"]).Add(new("alice", 99)); }
catch (NotSupportedException) { Console.WriteLine("groups are read-only"); }

// Eager vs deferred
var source = new List<Order> { new("x", 1) };
var eager = source.ToLookup(o => o.Customer);
var deferred = source.GroupBy(o => o.Customer);
source.Add(new("x", 2));
Console.WriteLine(eager["x"].Count());       // 1, snapshot taken at ToLookup
Console.WriteLine(deferred.First().Count()); // 2, re-evaluated on enumeration

var map = new Dictionary<string, List<Order>>();
// map["dave"]      -> KeyNotFoundException
// map.Add(null!, []) -> ArgumentNullException

record Order(string? Customer, int Id);
```

Именно разница между энергичным и отложенным выполнением порождает настоящие ошибки. Если хранить результат `GroupBy` в поле и перечислять его дважды, вы дважды платите за группировку и каждый раз видите источник таким, каким он является в этот момент. `ToLookup` делает снимок. Если вы не уверены, была ли полученная последовательность уже материализована, [проверьте это перед группировкой](/ru/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/).

Вторая ловушка - `Count`: у lookup это количество **ключей**, а не элементов. Чтобы получить общее число элементов, нужен `lookup.Sum(g => g.Count())`.

## Словарь списков без двойного поиска

Если вы выбираете словарь, классический шаблон хеширует ключ дважды для каждого нового ключа (`TryGetValue`, затем `Add`):

```csharp
// .NET 11 RC 1, C# 15
var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    if (!map.TryGetValue(o.CustomerId, out var list))
    {
        list = new List<Order>();
        map.Add(o.CustomerId, list);
    }
    list.Add(o);
}
```

Начиная с .NET 6 это можно сделать одним обращением к хеш-таблице на элемент с помощью [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), который возвращает `ref` на ячейку значения и вставляет запись по умолчанию, если ключа нет:

```csharp
// .NET 11 RC 1, C# 15
using System.Runtime.InteropServices;

var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    ref var list = ref CollectionsMarshal.GetValueRefOrAddDefault(map, o.CustomerId, out _);
    (list ??= []).Add(o);
}
```

В документации есть одно правило, которое нужно соблюдать: не добавляйте и не удаляйте записи словаря, пока держите этот `ref`. В цикле выше `ref` перестаёт существовать до следующей итерации, так что это безопасно.

Если вам ближе однострочник на LINQ, `GroupBy(...).ToDictionary(g => g.Key, g => g.ToList())` работает, но выделяет промежуточные группировки, а затем копирует каждый элемент в новый список. А если вы тянетесь к `AggregateBy` из .NET 9, используйте перегрузку с `seedSelector`. Перегрузка с `seed` отдаёт **один и тот же** экземпляр каждому ключу:

```csharp
// .NET 11 RC 1, C# 15
var orders = new[] { new Order("alice", 1), new Order("bob", 2), new Order("alice", 3) };

var broken = orders.AggregateBy(o => o.Customer, seed: new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,2,3   bob: 1,2,3   <- one shared List

var correct = orders.AggregateBy(o => o.Customer, seedSelector: _ => new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,3     bob: 2
```

`AggregateBy` и родственный ему `CountBy` отлично подходят, когда нужен один агрегат на ключ; случай с подсчётом я разбирал в статье [подсчёт частот с LINQ CountBy](/ru/2026/01/optimizing-frequency-counting-with-linq-countby/). Для задачи "все значения по ключу" это неподходящий инструмент.

## Бенчмарк

BenchmarkDotNet 0.15.8 пока не умеет распознавать моникер `net11.0` (выбрасывает `NotImplementedException` из `GetRuntimeVersion`), поэтому замеры проводились с `--inProcess` на .NET 11 RC 1, Arm64 RyuJIT, на Apple M4 (10 ядер, 16 GB) под macOS 26.6. Источник - 100,000 записей `Order` с ключом `int` `CustomerId` и 100 либо 10,000 различных ключей. Бенчмарк чтения запрашивает 1,000 случайных ключей, 10% из которых отсутствуют, и суммирует поле `decimal` по каждой группе.

Построение группировки из 100,000 заказов:

| Метод (.NET 11 RC 1)                           | Ключи  | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `ToLookup`                                     | 100    | 660.1 us | 1.00  | 1.91 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 100    | 883.0 us | 1.34  | 2.69 MB   |
| Цикл `TryGetValue` + `Add`                     | 100    | 476.7 us | 0.72  | 1.91 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 100    | 485.8 us | 0.74  | 1.91 MB   |
| `ToLookup`                                     | 10,000 | 5,934 us | 1.00  | 3.86 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 10,000 | 7,537 us | 1.27  | 6.06 MB   |
| Цикл `TryGetValue` + `Add`                     | 10,000 | 4,070 us | 0.69  | 3.59 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 10,000 | 4,384 us | 0.74  | 3.59 MB   |

Чтение 1,000 случайных ключей с суммированием каждой группы:

| Метод (.NET 11 RC 1)                           | Ключи  | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `foreach (var o in lookup[k])`                 | 100    | 3,736 us | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` по `List<T>`         | 100    | 3,617 us | 0.97  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 100    | 3,299 us | 0.88  | 0 B       |
| `foreach (var o in lookup[k])`                 | 10,000 | 66.1 us  | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` по `List<T>`         | 10,000 | 61.0 us  | 0.92  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 10,000 | 57.8 us  | 0.87  | 0 B       |

Несколько моментов бросаются в глаза.

**Lookup строится примерно в 1.4x медленнее простого цикла при одинаковых выделениях памяти.** В обоих случаях при 100 ключах выходит 1.91 MB, так что разрыв объясняется работой на каждый элемент, а не памятью. `ToLookup` вызывает делегат `keySelector` и для каждого элемента обращается к `IEqualityComparer<TKey>.GetHashCode` и `Equals` через интерфейс. `Dictionary<TKey, TValue>` отдельно обрабатывает ключи-значимые типы без пользовательского компаратора и вызывает `EqualityComparer<TKey>.Default` напрямую, а JIT девиртуализирует и встраивает этот вызов. С ключами `string` это преимущество сокращается, потому что словарь тоже работает через объект компаратора.

**`GroupBy(...).ToDictionary(...)` сочетает худшее из обоих вариантов.** Он строит тот же внутренний lookup, что и `ToLookup`, а затем копирует каждую группу в новый `List<T>`: на 27-34% медленнее `ToLookup` и до 57% больше памяти. Если нужен словарь, напишите цикл.

**`CollectionsMarshal` здесь не обогнал `TryGetValue`.** Двойное хеширование происходит только при первом появлении ключа, то есть 100 или 10,000 раз на 100,000 элементов. Вариант с одним обращением окупается, когда большинство элементов приносят новый ключ, и он никогда не бывает заметно медленнее, поэтому для цикла я по-прежнему использую его по умолчанию.

**Каждое чтение из lookup выделяет память.** Индексатор возвращает `IEnumerable<TElement>`, а `Grouping.GetEnumerator` отдаёт размещённый в куче `PartialArrayEnumerator<TElement>`: 29,344 байт примерно на 917 попаданий, по 32 байта на каждое. У `List<T>` есть перечислитель-структура, которую `foreach` использует без упаковки, а `CollectionsMarshal.AsSpan` полностью убирает перечислитель и даёт ещё 5-9%. При 100 ключах чтение определяется суммированием примерно 1,000 значений `decimal` на группу, поэтому соотношения сближаются.

Честный вывод: ни одна из этих цифр не должна выбирать тип за вас. Если группировка стоит на пути настолько горячем, что разница в 10% при чтении и 32 байта на пробу имеют значение, вам, вероятно, лучше подойдёт [`FrozenDictionary`](/ru/2024/04/net-8-performance-dictionary-vs-frozendictionary/), построенный один раз поверх массивов, или перебор span вместо `IEnumerable<T>`; это тот же компромисс, который я разбирал в [List vs Span vs ReadOnlySpan](/ru/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Подводные камни, которые решают за вас

**Нельзя бесплатно выставить `Dictionary<TKey, List<TValue>>` наружу как multimap только для чтения.** `IReadOnlyDictionary<TKey, TValue>` инвариантен по `TValue`, поэтому следующий код не компилируется:

```csharp
// .NET 11 RC 1, C# 15
Dictionary<string, List<int>> map = new() { ["a"] = [1] };
IReadOnlyDictionary<string, IReadOnlyList<int>> ro = map;
// error CS0266: Cannot implicitly convert type 'Dictionary<string, List<int>>'
// to 'IReadOnlyDictionary<string, IReadOnlyList<int>>'
```

Явное приведение, которое предлагает компилятор, выбрасывает `InvalidCastException` во время выполнения. Варианты такие: с самого начала объявить словарь как `Dictionary<string, IReadOnlyList<int>>` (и потерять `Add` у значений без приведения), скопировать его или вернуть `ILookup`, который только для чтения по своему устройству. Если требование "вызывающий код не должен это изменять" обязательно, одного этого достаточно, чтобы выбрать lookup.

**`ILookup` не переживает JSON.** `System.Text.Json` сериализует его как `IEnumerable<IGrouping<...>>`, поэтому вы получаете `[[{...},{...}],[{...}]]` без ключей, а десериализация в `ILookup<TKey, TElement>` выбрасывает `NotSupportedException`, потому что экземпляр интерфейса создать нельзя. `Dictionary<string, List<T>>` сериализуется как `{"alice":[...],"bob":[...]}` и корректно восстанавливается. Для ответов API и кешируемых данных преобразуйте его на границе через `lookup.ToDictionary(g => g.Key, g => g.ToList())` или сразу стройте словарь.

**У `ILookup` нет `TryGetValue`.** `if (lookup.Contains(k)) use(lookup[k]);` хеширует ключ дважды. Раз отсутствующий ключ и так возвращает пустую последовательность, просто вызовите индексатор и дайте пустому случаю пройти насквозь. `Contains` нужен только тогда, когда "нет значений" и "нет ключа" нужно обрабатывать по-разному, а в lookup это никогда не так (ключ не может существовать без элементов).

**Компаратор задаётся при создании.** Оба типа принимают `IEqualityComparer<TKey>`. Для строковых ключей передайте `StringComparer.OrdinalIgnoreCase` в `ToLookup` или в конструктор словаря; позже изменить его нельзя ни у одного из типов.

**Порядок перечисления словаря - деталь реализации.** `Dictionary`, в который только добавляли, по совпадению перечисляется в порядке вставки, но документация говорит, что порядок не определён, а один `Remove` с последующим `Add` переиспользует освободившуюся ячейку: на .NET 11 RC 1 ключи `a, b, c` после `Remove("a")` и `Add("d")` перечисляются как `d, b, c`. Если вы выводите группы в порядке их первого появления, lookup гарантирует это структурно.

**Ни один из типов не потокобезопасен для записи.** Lookup неизменяем, поэтому параллельное чтение безопасно. Словарю списков нужна блокировка и вокруг словаря, и вокруг каждого списка, и `ConcurrentDictionary<TKey, List<T>>` проблему не решает, потому что списки внутри остаются обычными `List<T>`. Если нужны параллельные добавления, используйте `ConcurrentDictionary<TKey, ConcurrentQueue<T>>` или неизменяемую коллекцию с атомарной заменой.

**Готового `MultiValueDictionary` нет.** Microsoft сделала прототип в `Microsoft.Experimental.Collections` в 2014 году, но он так и не попал в среду выполнения, а репозиторий corefxlab теперь в архиве. Для изменяемого multimap словарь списков по-прежнему остаётся стандартным ответом.

## Что выбрать

По умолчанию берите `ToLookup`, если группировка является индексом только для чтения над уже имеющимися данными: соединение двух наборов в памяти, раскладка строк по корзинам для отчёта, предварительный расчёт дочерних элементов по родителю для дерева. Он короче, его нельзя изменить у вас за спиной, а поведение для отсутствующего ключа и ключа null убирает целый класс защитного кода. Переходите на `Dictionary<TKey, List<TValue>>`, построенный через `CollectionsMarshal.GetValueRefOrAddDefault`, когда группы меняются за время жизни объекта, когда результат сериализуется или когда вы пишете тот единственный горячий цикл, где измерения показали, что разница при чтении важна. Если вы колеблетесь, вернуть ли из метода, отдающего эти группы, `IEnumerable<T>` или что-то более богатое, работает та же логика, что и в [IEnumerable vs IAsyncEnumerable vs IQueryable](/ru/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/): возвращайте самый узкий тип, который удерживает вызывающий код в рамках, а для готовой группировки это `ILookup`.

### Связанные материалы

- [Как узнать, был ли IEnumerable уже материализован в C#](/ru/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [Оптимизация подсчёта частот с LINQ CountBy](/ru/2026/01/optimizing-frequency-counting-with-linq-countby/)
- [Dictionary vs FrozenDictionary в .NET 8](/ru/2024/04/net-8-performance-dictionary-vs-frozendictionary/)
- [List vs Span vs ReadOnlySpan в C#](/ru/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable в C#](/ru/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

### Источники

- [Класс `Lookup<TKey, TElement>`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.lookup-2), MS Learn
- [`Enumerable.ToLookup`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.tolookup), MS Learn
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), MS Learn
- [`Enumerable.AggregateBy`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.aggregateby), MS Learn
- [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) и [`Grouping.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Grouping.cs) на теге `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [MultiDictionary becomes MultiValueDictionary](https://devblogs.microsoft.com/dotnet/multidictionary-becomes-multivaluedictionary/), .NET Blog
- [Release the Microsoft.Experimental.Collections.MultiValueDictionary](https://github.com/dotnet/runtime/issues/14406), dotnet/runtime issue
