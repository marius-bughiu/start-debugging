---
title: "Refit 16.1 schreibt Ihre Paging-Schleife: PagedEnumerable, [Paged] und [PageToken]"
description: "Refit 16.1.0 erlaubt es einer Interface-Methode, PagedEnumerable<TPage, TItem> zurückzugeben, und der Source Generator erzeugt die Request-pro-Seite-Schleife für Cursor, Offsets, Response-Header und Next-Links. Hier erfahren Sie, wie Sie das deklarieren, wie die Enumeration sich verhält, und welchen RF013-Build-Fehler Sie bei einem falsch geschriebenen Member erhalten."
pubDate: 2026-09-25
tags:
  - "refit"
  - "httpclient"
  - "dotnet"
  - "csharp"
  - "source-generators"
lang: "de"
translationOf: "2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable"
translatedBy: "claude"
translationDate: 2026-09-25
---

[Refit 16.1.0](https://github.com/reactiveui/refit/releases/tag/v16.1.0) erschien am 21. September 2026, und das Hauptfeature entfernt ein Stück Boilerplate, das fast jeder Refit-Nutzer schon geschrieben hat: die `while (cursor != null)`-Schleife um einen Listen-Endpunkt. Eine Refit-Methode kann jetzt `PagedEnumerable<TPage, TItem>` zurückgeben, und der Source Generator schreibt die Schleife, die eine Anfrage pro Seite sendet. Das Design steht in [PR #2332](https://github.com/reactiveui/refit/pull/2332).

## Eine paginierte Methode deklarieren

Sie beschreiben die Form der Seite mit zwei Attributen. `[Paged]` benennt den Member, der die Fortsetzung enthält, und `[PageToken]` markiert den Parameter, der sie zurücksendet:

```csharp
public interface IOrdersApi
{
    [Get("/orders")]
    [Paged(Next = nameof(OrderPage.NextCursor))]
    PagedEnumerable<OrderPage, Order> ListOrders(
        [AliasAs("limit")] int pageSize,
        [PageToken] string? cursor = null);
}

public sealed class OrderPage
{
    public List<Order> Items { get; set; } = [];
    public string? NextCursor { get; set; }
}
```

`Items` ist hier optional: Wenn der Seitentyp genau eine Sequenz vom Item-Typ hat, wählt der Generator sie aus. Ein null- oder leerer `NextCursor` beendet die Sequenz. Der Token-Parameter bindet wie jeder andere, sodass `[Header]` oder `[Query]` ihn aus dem Query-String herausnehmen.

Der Aufruf ist ein einfaches `await foreach`, und Anfragen gehen erst raus, während Sie Items konsumieren. Ich habe das gegen einen Fake-Handler laufen lassen, der sieben Orders in Seiten von drei ausliefert:

```csharp
await foreach (var order in api.ListOrders(pageSize: 3))
    Console.WriteLine(order.Id);

// Requests sent:
//   /orders?limit=3
//   /orders?limit=3&cursor=3
//   /orders?limit=3&cursor=6
```

Frühzeitiges Abbrechen stoppt die Anfragen. `await api.ListOrders(3).FirstAsync(o => o.Id == 2)` hat unter .NET 10 genau eine Anfrage ausgelöst.

## Seiten, Limits und Prefetch

`PagedEnumerable<TPage, TItem>` ist ein `IAsyncEnumerable<TItem>` mit ein paar zusätzlichen Membern:

- `AsPages()` liefert die Seitenobjekte selbst, wenn Sie `IsTruncated` oder eine Gesamtzahl neben den Items brauchen.
- `WithMaxPages(n)` begrenzt, wie viele Anfragen eine Enumeration auslösen kann.
- `WithPrefetch()` fordert die nächste Seite an, während Sie die aktuelle noch verarbeiten.
- `ToObservable()` und `ToPageObservable()` für Rx-Konsumenten.

```csharp
await foreach (var page in api.ListOrders(3).WithMaxPages(2).AsPages())
    Console.WriteLine($"{page.Items.Count} items, next={page.NextCursor}");
```

## Header, Offsets und Next-Links

`[Paged]` deckt auch die anderen Paging-Stile ab:

- `NextHeader = "x-ms-continuation"` liest die Fortsetzung aus einem Response-Header (Cosmos-DB-Stil). Der Seitentyp muss `ApiResponse<T>` sein.
- `NextHeader = "Link"` liest die `rel="next"`-Relation, so wie GitHub paginiert.
- `Total = nameof(Result.Total)` wechselt zu Offset-Paging mit einem `int`-Token, für APIs wie Jira.
- `Next`, das auf eine absolute URL zeigt, wie Graphs `@odata.nextLink`, folgt Links.

Das Folgen von Links bringt eine Sicherheitsanforderung mit sich: Sie müssen mit `Origins = ["https://api.github.com"]`, `SameOrigin = true` oder `AnyOrigin = true` angeben, auf welche Origins ein Link zeigen darf. Ein Link zu jeder anderen Origin wirft `InvalidOperationException`, ohne angefragt zu werden, sodass Ihr `Authorization`-Header niemals an einen Host weitergeleitet wird, den ein feindlicher Server nennt.

## Fehler lassen den Build scheitern

Member-Namen werden zur Kompilierzeit in direkten Property-Zugriff aufgelöst, ganz ohne Reflection. Ein Tippfehler ist der Fehler `RF013`:

```text
error RF013: Method 'ListOrders' cannot be generated as a paged method:
'NextCusor' is not a readable public or internal property or field of 'OrderPage'.
```

Eine paginierte Methode darf außerdem nicht generisch sein oder ihr eigenes `CancellationToken` deklarieren, da das Token aus der Enumeration kommt. Der Reflection-basierte Request-Builder lehnt paginierte Rückgabewerte ab, sodass das nur mit dem source-generierten Client funktioniert, und eine paginierte Methode, die der Generator nicht inline erzeugen kann, wird als `RF007` gemeldet.

Wenn Sie Refit gegen einen handgeschriebenen typisierten Client abgewogen haben, siehe [HttpClient vs HttpClientFactory vs Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/). Paging war einer der Punkte, an denen der handgeschriebene Client früher bei der Kontrolle gewann. Refit generiert diese Schleife jetzt für Sie, mit einem Build-Fehler, wenn die Seitenform falsch ist.
