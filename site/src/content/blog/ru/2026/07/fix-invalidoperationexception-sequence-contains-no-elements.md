---
title: "Решение: System.InvalidOperationException: Sequence contains no elements"
description: "Это исключение означает, что вы вызвали .First() или .Single() на пустой последовательности. Используйте FirstOrDefault/SingleOrDefault с проверкой на null, защитите запрос или устраните причину пустоты источника."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "ef-core"
lang: "ru"
translationOf: "2026/07/fix-invalidoperationexception-sequence-contains-no-elements"
translatedBy: "claude"
translationDate: 2026-07-21
---

`System.InvalidOperationException: Sequence contains no elements` означает, что вы вызвали `.First()`, `.Single()`, `.Last()` или один из их агрегирующих родственников (`.Average()`, `.Max()`, `.Min()`) на последовательности, которая оказалась пустой. Оператор обещал вернуть элемент, а его не было, поэтому он выбросил исключение. Решение состоит в том, чтобы определить, что "пусто" должно означать для этого вызова: если пустота является нормальным исходом, переключитесь на `.FirstOrDefault()` / `.SingleOrDefault()` и обработайте `null` (или значение по умолчанию), которое вы получаете обратно; если пустота является ошибкой, исправьте запрос или данные, чтобы последовательность никогда не была пустой в этой точке. Это проверено на .NET 11, C# 14 и EF Core 11.0.0, но сообщение и поведение остаются стабильными с тех пор, как LINQ появился в .NET Framework 3.5, поэтому руководство применимо к любой версии.

## Ошибка в контексте

Полное исключение, выброшенное изнутри `System.Linq`, выглядит так:

```
System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)
   at MyApp.OrderService.GetLatest() in /src/OrderService.cs:line 42
```

Подсказка находится в верхнем кадре: `System.Linq.ThrowHelper.ThrowNoElementsException`. Если вы видите это в трассировке стека, значит, возвращающий элемент оператор LINQ отработал на пустом источнике. Точная формулировка важна для поиска, потому что LINQ выбрасывает из одного и того же класса четыре тесно связанных сообщения, и они означают разное:

- `Sequence contains no elements` -- `.First()`, `.Single()`, `.Last()` (без предиката) на пустом источнике.
- `Sequence contains no matching element` -- `.First(predicate)`, `.Single(predicate)`, `.Last(predicate)`, когда ничего не совпало.
- `Sequence contains more than one element` -- `.Single()` на источнике с двумя или более элементами.
- `Sequence contains more than one matching element` -- `.Single(predicate)`, когда совпало более одного элемента.

Эта статья про первое. Остальные рассмотрены в разделе о вариантах, потому что попасть не на то сообщение означает потратить время впустую.

## Почему это происходит

`.First()` и `.Single()` являются операторами с контрактом: их тип возврата это non-nullable `TSource`, поэтому у них нет способа просигнализировать "здесь ничего нет", кроме как выбросив исключение. Когда источник пуст, возвращать нечего, а вернуть `default(TSource)` было бы ложью для ссылочного типа (вы получили бы `null` там, где сигнатура обещала значение). Поэтому среда выполнения вместо этого выбрасывает `InvalidOperationException`. Это осознанное проектное решение, а не ошибка: варианты `*OrDefault` существуют именно для случая, когда пустота допустима.

Запутанная часть в том, что последовательность часто оказывается пустой по причинам, невидимым в месте вызова. Расположенный выше фильтр `Where` удалил все строки. В таблице базы данных пока нет ни одной подходящей записи. Коллекция была очищена или так и не заполнена, потому что более раннее `await` тихо завершилось неудачей. Исключение срабатывает на строке `.First()`, но настоящая причина находится на три строки (или на три вызова метода) раньше. Вот почему "просто оберни это в try/catch" редко бывает верным инстинктом: вы хотите знать, почему последовательность пуста, а не просто проглотить симптом.

## Минимальное воспроизведение

Наименьший код, который его выбрасывает:

```csharp
// .NET 11, C# 14
var numbers = new List<int>();     // empty
int first = numbers.First();       // System.InvalidOperationException: Sequence contains no elements
```

То же самое происходит, когда фильтр устраняет всё, и это гораздо более частая реальная форма:

```csharp
// .NET 11, C# 14
var orders = new List<Order>
{
    new(Id: 1, Status: "shipped"),
    new(Id: 2, Status: "shipped"),
};

// No pending orders exist, so the filtered sequence is empty.
Order next = orders.First(o => o.Status == "pending");
// System.InvalidOperationException: Sequence contains no matching element
```

Обратите внимание, что второе сообщение это вариант `no matching element`, потому что был передан предикат. Оба происходят из одного семейства ошибок: вы предположили, что хотя бы один элемент там будет, а его не было.

## Решение в деталях

Проработайте эти варианты по порядку. Первые два покрывают почти любой реальный случай.

### 1. Используйте FirstOrDefault / SingleOrDefault и обработайте пустой случай

Если пустая последовательность является допустимым исходом (строк пока нет, необязательный поиск, запрос, который может ничего не найти), переключитесь на перегрузку `*OrDefault` и проверьте то, что получаете:

```csharp
// .NET 11, C# 14
Order? next = orders.FirstOrDefault(o => o.Status == "pending");
if (next is null)
{
    // No pending order. Handle it: return early, use a fallback, log, whatever fits.
    return;
}
Process(next);
```

`FirstOrDefault` возвращает `default(TSource)`, когда последовательность пуста: `null` для ссылочного типа, `0` для `int`, `default` для структуры. В кодовой базе с nullable-аннотациями (`<Nullable>enable</Nullable>`, значение по умолчанию в новых шаблонах .NET 11) компилятор типизирует результат как `Order?` и будет напоминать вам, пока вы не проверите на null, а это именно та безопасность, которая вам нужна. Не пропускайте проверку: замена `First` на `FirstOrDefault` и последующее немедленное разыменование результата просто меняет `InvalidOperationException` на `NullReferenceException` строкой позже. Если предупреждения о nullable кажутся шумом, это компилятор указывает на настоящую работу, и это напрямую связано с [CS8618 и non-nullable свойствами](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/).

Начиная с .NET 6 также есть перегрузка, позволяющая указать собственное значение по умолчанию, что чище отдельной проверки на null, когда у вас есть разумный запасной вариант:

```csharp
// .NET 11, C# 14 -- FirstOrDefault(predicate, defaultValue) added in .NET 6
Order next = orders.FirstOrDefault(o => o.Status == "pending", Order.None);
```

### 2. Защитите последовательность перед вызовом First

Когда вам действительно нужен первый элемент, но только если он существует, сначала проверьте на пустоту. Для коллекции в памяти достаточно `Count` или `Any()`:

```csharp
// .NET 11, C# 14
if (orders.Count > 0)
{
    Order first = orders.First();   // safe: we know it is non-empty
    Process(first);
}
```

Предпочитайте `Count` (или `Count > 0`) для всего, что реализует `ICollection<T>`, например `List<T>` или массива, потому что это O(1). Используйте `.Any()` для лениво вычисляемого `IEnumerable<T>`, где вы не можете дёшево получить количество. Не пишите `if (orders.Count() > 0)` на ленивой последовательности: `Count()` перечисляет её целиком, тогда как `Any()` останавливается после первого элемента.

### 3. Устраните причину пустоты последовательности

Иногда пустота это ошибка, а не допустимое состояние. Если `orders.First(o => o.Status == "pending")` всегда должен находить строку, но не находит, настоящее исправление находится выше по потоку: слишком строгий фильтр, несовпадение регистра (`"Pending"` против `"pending"`), соединение, отбросившее строки, или данные, которые так и не были вставлены. Прибегайте здесь к `*OrDefault` только после того, как подтвердите, что последовательности разрешено быть пустой. Сокрытие случая "это никогда не должно быть пустым" с помощью `FirstOrDefault` прячет настоящую ошибку данных или логики и переносит сбой туда, где его труднее диагностировать.

### 4. Для агрегатов используйте nullable-перегрузку или DefaultIfEmpty

`.Average()`, `.Max()`, `.Min()` и `.Sum()` разделяют ту же ловушку. `.Average()` и версии `.Max()`/`.Min()` для типов-значений выбрасывают `Sequence contains no elements` на пустом источнике (`.Sum()` возвращает 0, что является отдельным сюрпризом). Два чистых решения:

```csharp
// .NET 11, C# 14
var prices = new List<int>();

// Option A: project to a nullable so the aggregate returns null instead of throwing.
double? avg = prices.Average(p => (int?)p);   // null when empty, no exception

// Option B: supply a fallback element before aggregating.
int max = prices.DefaultIfEmpty(0).Max();     // 0 when empty
```

`DefaultIfEmpty` это универсальный аварийный люк: он выдаёт единственный элемент по умолчанию, когда источник пуст, так что любой последующий оператор, включая `.First()`, видит хотя бы один элемент.

## Подводные камни и варианты

Некоторые ситуации порождают это исключение или его близкого родственника по причинам, которые сообщение не проговаривает:

- **`no matching element` это другое сообщение с той же причиной.** `.First()` на пустом источнике говорит `Sequence contains no elements`; `.First(predicate)`, не совпадающий ни с чем, говорит `Sequence contains no matching element`. Их выбрасывают разные вспомогательные методы, но исправление идентично: `FirstOrDefault(predicate)` и проверка на null. Если у вашего источника есть строки, но предикат никогда не совпадает, переданная в `First` последовательность фактически пуста.

- **`.Single()` выбрасывает два разных сообщения.** `.Single()` гарантирует *ровно один* элемент, поэтому может дать сбой двумя способами: `Sequence contains no elements`, когда их ноль, и `Sequence contains more than one element`, когда их два или больше. Если вы видите вариант "more than one", `FirstOrDefault` не является исправлением; либо ваше предположение об уникальности неверно (пропущенное условие `WHERE`, дублирующийся ключ), либо вам следует использовать `First`, потому что вам нужен только один из нескольких. Используйте `Single`, только когда второе совпадение само по себе является ошибкой, ради которой стоит выбросить исключение.

- **EF Core выбрасывает то же самое из `First`/`Single`, и их асинхронные версии тоже.** `dbContext.Orders.First(o => o.Id == id)` транслируется в `SELECT TOP(1)` и выбрасывает `Sequence contains no elements`, когда ни одна строка не совпадает. `FirstAsync` и `SingleAsync` выбрасывают идентично. Исправление это `FirstOrDefaultAsync` / `SingleOrDefaultAsync` плюс проверка на null. Поскольку они выполняются против базы данных, пустой результат часто нормален (строка была удалена, id неверен), так что асинхронные перегрузки `*OrDefault` обычно и есть то, что вам нужно. См. [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), чтобы понять, почему оператор LINQ ведёт себя одинаково, выполняется ли он в памяти или как SQL.

- **`FirstOrDefault` на последовательности типов-значений возвращает 0, а не null.** Для `List<int>` `FirstOrDefault()` на пустом списке возвращает `0`, который является допустимым `int` и неотличим от реального первого элемента, равного `0`. Если вам нужно отличить "пусто" от "первое значение случайно равно значению по умолчанию", спроецируйте на nullable (`.Select(x => (int?)x).FirstOrDefault()`) или защититесь с помощью `.Any()` вместо того, чтобы полагаться на сигнальное значение по умолчанию.

- **Пустая последовательность может происходить из неправильно транслированного запроса, а не из отсутствующих данных.** В EF Core запрос, который тихо вычисляет часть фильтра на стороне клиента, или запрос, который вовсе не удалось транслировать, может вернуть иной (часто пустой) набор результатов, чем вы ожидаете. Если `First` против базы данных выбрасывает исключение, а вы уверены, что строка существует, проверьте, транслировался ли запрос так, как вы задумали. Этот режим сбоя рассмотрен в [выражение LINQ не удалось транслировать](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

- **Оборачивание в try/catch скрывает настоящий вопрос.** Перехват `InvalidOperationException` вокруг вызова `First` технически останавливает сбой, но также перехватывает несвязанные `InvalidOperationException` (например, ошибку "коллекция изменена во время перечисления") и ничего не говорит о том, почему последовательность была пуста. Предпочитайте `*OrDefault` плюс явную ветвь: это быстрее (без механики исключений), уже по охвату и самодокументируемо.

Ментальная модель, которую стоит запомнить: `.First()` и `.Single()` это утверждения, что элемент существует. `Sequence contains no elements` это данное утверждение, потерпевшее неудачу. Решите, законен ли пустой случай. Если да, выразите это через `FirstOrDefault`/`SingleOrDefault` и обработайте значение по умолчанию, которое получаете. Если нет, исправьте запрос или данные выше по потоку, чтобы последовательность никогда не была пустой в этой точке, вместо того чтобы замазывать это в месте вызова.

## Похожее

- [Решение: выражение LINQ не удалось транслировать в EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) для случая, когда пустой результат приходит из запроса, который отработал не так, как вы ожидали.
- [IEnumerable vs IAsyncEnumerable vs IQueryable в C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), чтобы понять, почему `First` ведёт себя одинаково в памяти и против базы данных и когда запрос действительно выполняется.
- [Решение: CS8618 non-nullable свойство должно содержать значение, отличное от null](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) для обработки nullable-результата, который возвращает `FirstOrDefault`.
- [LINQ FullJoin и возвращающие кортежи соединения в .NET 11](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/) для формирования результатов соединений без отбрасывания строк, которые оставили бы последовательность пустой.

## Источники

- Microsoft Learn, [Enumerable.First Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.first) (выбрасывает `InvalidOperationException`, когда исходная последовательность пуста или ни один элемент не совпадает с предикатом; используйте `FirstOrDefault`, чтобы вместо этого вернуть значение по умолчанию).
- Microsoft Learn, [Enumerable.Single Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.single) (выбрасывает, когда последовательность пуста, содержит более одного элемента или ни один элемент не совпадает).
- Microsoft Learn, [Enumerable.FirstOrDefault Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.firstordefault) (возвращает `default(TSource)` для пустой последовательности, плюс перегрузка .NET 6, принимающая явное значение по умолчанию).
- Microsoft Learn, [Enumerable.DefaultIfEmpty Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.defaultifempty) (выдаёт единственный элемент по умолчанию, когда источник пуст).
