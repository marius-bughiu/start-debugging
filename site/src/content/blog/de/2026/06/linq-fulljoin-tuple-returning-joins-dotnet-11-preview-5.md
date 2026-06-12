---
title: "LINQ bekommt FullJoin und selektorfreie Joins in .NET 11 Preview 5"
description: ".NET 11 Preview 5 fügt LINQ einen brandneuen FullJoin-Operator hinzu sowie Tupel-zurückgebende Overloads für Join, LeftJoin, RightJoin und GroupJoin, die den Ergebnisselektor komplett überflüssig machen."
pubDate: 2026-06-12
tags:
  - "dotnet-11"
  - "csharp"
  - "linq"
  - "performance"
lang: "de"
translationOf: "2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-12
---

Die [Bibliotheks-Notizen zu .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) runden eine Geschichte ab, die in .NET 10 begann. Diese Version brachte LINQ `LeftJoin` und `RightJoin`, sodass Sie einen Outer Join nicht mehr mit `GroupJoin` plus `SelectMany` plus `DefaultIfEmpty` nachbauen mussten. Preview 5 ergänzt die fehlende vierte Ecke, `FullJoin`, und behebt nebenbei den lästigsten Teil jedes Joins: den Ergebnisselektor.

## Der Ergebnisselektor war immer nur Boilerplate

Jede bisherige Join-Overload nahm vier Argumente: die innere Sequenz, den äußeren Schlüssel, den inneren Schlüssel und einen Ergebnisselektor, der LINQ mitteilte, wie ein passendes Paar zu kombinieren ist. Neun von zehn Mal klebte dieser Selektor die beiden Elemente nur in einen anonymen Typ oder ein Tupel zusammen:

```csharp
var pairs = catalog.Join(
    sales,
    p => p.Sku,
    s => s.Sku,
    (product, sale) => (product, sale));

foreach (var (product, sale) in pairs)
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

Diese letzte Lambda trägt keinerlei Logik. Sie existiert nur, um die Signatur zu erfüllen. Preview 5 fügt Tupel-zurückgebende Overloads für `Join`, `LeftJoin`, `RightJoin` und `GroupJoin` hinzu, die die naheliegende Form ableiten und Ihnen erlauben, sie wegzulassen:

```csharp
foreach (var (product, sale) in catalog.Join(sales, p => p.Sku, s => s.Sku))
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

`Join` gibt jetzt `IEnumerable<(TOuter, TInner)>` zurück. `GroupJoin` gibt `IEnumerable<(TOuter, IEnumerable<TInner>)>` zurück. Die linke und rechte Variante geben die äußere oder innere Seite als nullbar zurück, genau wie SQL es täte. Die Overloads existieren auf `Enumerable`, `Queryable` und `AsyncEnumerable`, sodass dieselbe Aufrufform auf In-Memory-Sammlungen, EF-Core-Abfragebäumen und asynchronen Streams funktioniert.

## FullJoin vervollständigt das Set

Der wirklich neue Operator ist `FullJoin` ([dotnet/runtime #127236](https://github.com/dotnet/runtime/pull/127236)). Ein Full Outer Join gibt jedes Element aus beiden Sequenzen zurück, paart die mit übereinstimmenden Schlüsseln und lässt die nicht passenden mit einem `null`-Partner. Zwei Listen abzugleichen, etwa einen Produktkatalog gegen einen Verkaufs-Feed, bedeutete bisher zwei Durchläufe oder eine handgebaute Dictionary-Suche. Jetzt ist es ein einziger Aufruf:

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

Hier sind beide Seiten des Tupels nullbar, weil jede fehlen kann, und die nullbaren Typannotationen von C# schubsen den Compiler dazu, beide Lücken zu behandeln.

## Was Sie wissen sollten, bevor Sie sich darauf verlassen

Dies sind ausschließlich Ergänzungen der LINQ-Methodensyntax. Es gibt kein `full join`-Abfrageschlüsselwort, und die bestehenden Query-Comprehension-Formen bleiben unangetastet. Bei den EF-Core-Providern hängt es vom Nachziehen des Providers ab, ob `FullJoin` zu einem `FULL OUTER JOIN` übersetzt wird oder auf Client-Auswertung zurückfällt, prüfen Sie also Ihr generiertes SQL, bevor Sie annehmen, dass es in der Datenbank läuft. Wie beim Rest von Preview 5, einschließlich der neuen [JSON-Lines-Unterstützung in System.Text.Json](/de/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/), können sich die Signaturen vor dem stabilen Release im November noch ändern. Aber die Form ist sauber genug, dass Sie schon heute damit anfangen können, Ergebnisselektor-Lambdas zu löschen.
