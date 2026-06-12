---
title: "LINQ получает FullJoin и join без селектора в .NET 11 Preview 5"
description: ".NET 11 Preview 5 добавляет в LINQ совершенно новый оператор FullJoin, а также перегрузки, возвращающие кортежи, для Join, LeftJoin, RightJoin и GroupJoin, которые полностью убирают селектор результата."
pubDate: 2026-06-12
tags:
  - "dotnet-11"
  - "csharp"
  - "linq"
  - "performance"
lang: "ru"
translationOf: "2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-12
---

[Заметки о библиотеках .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) завершают историю, начавшуюся в .NET 10. Та версия дала LINQ `LeftJoin` и `RightJoin`, так что больше не нужно было имитировать outer join через `GroupJoin` плюс `SelectMany` плюс `DefaultIfEmpty`. Preview 5 добавляет недостающий четвёртый угол, `FullJoin`, и заодно исправляет самую раздражающую часть любого join: селектор результата.

## Селектор результата всегда был шаблонным кодом

Каждая прежняя перегрузка join принимала четыре аргумента: внутреннюю последовательность, внешний ключ, внутренний ключ и селектор результата, который сообщал LINQ, как объединить совпавшую пару. В девяти случаях из десяти этот селектор просто склеивал два элемента в анонимный тип или кортеж:

```csharp
var pairs = catalog.Join(
    sales,
    p => p.Sku,
    s => s.Sku,
    (product, sale) => (product, sale));

foreach (var (product, sale) in pairs)
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

Эта последняя лямбда не несёт никакой логики. Она существует только чтобы удовлетворить сигнатуру. Preview 5 добавляет перегрузки, возвращающие кортежи, для `Join`, `LeftJoin`, `RightJoin` и `GroupJoin`, которые выводят очевидную форму и позволяют её убрать:

```csharp
foreach (var (product, sale) in catalog.Join(sales, p => p.Sku, s => s.Sku))
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

`Join` теперь возвращает `IEnumerable<(TOuter, TInner)>`. `GroupJoin` возвращает `IEnumerable<(TOuter, IEnumerable<TInner>)>`. Левый и правый варианты возвращают внешнюю или внутреннюю сторону как допускающую null, в точности как сделал бы SQL. Перегрузки есть в `Enumerable`, `Queryable` и `AsyncEnumerable`, так что та же форма вызова работает над коллекциями в памяти, деревьями запросов EF Core и асинхронными потоками.

## FullJoin завершает набор

По-настоящему новый оператор это `FullJoin` ([dotnet/runtime #127236](https://github.com/dotnet/runtime/pull/127236)). Full outer join возвращает каждый элемент из обеих последовательностей, объединяя те, у которых ключи совпадают, и оставляя несовпавшим партнёра `null`. Согласование двух списков, например каталога продуктов с лентой продаж, раньше означало два прохода или поиск по построенному вручную словарю. Теперь это один вызов:

```csharp
foreach (var (product, sale) in catalog.FullJoin(sales, p => p.Sku, s => s.Sku))
{
    if (product is null)
        Console.WriteLine($"Sale for unknown SKU {sale!.Sku}");
    else if (sale is null)
        Console.WriteLine($"No sales for {product.Name}");
    else
        Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
}
```

Здесь обе стороны кортежа допускают null, потому что любая может отсутствовать, и аннотации nullable-типов C# подталкивают компилятор к тому, чтобы вы обработали оба пропуска.

## Что стоит знать, прежде чем полагаться на это

Это дополнения только к синтаксису методов LINQ. Ключевого слова запроса `full join` нет, и существующие формы query-comprehension остаются нетронутыми. Для провайдеров EF Core то, переводится ли `FullJoin` в `FULL OUTER JOIN` или откатывается к вычислению на клиенте, зависит от того, догонит ли провайдер, поэтому проверьте сгенерированный SQL, прежде чем предполагать, что он выполняется в базе данных. Как и в остальной части Preview 5, включая новую [поддержку JSON Lines в System.Text.Json](/ru/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/), сигнатуры ещё могут измениться до стабильного релиза в ноябре. Но форма достаточно чистая, чтобы уже сегодня начать удалять лямбды-селекторы результата.
