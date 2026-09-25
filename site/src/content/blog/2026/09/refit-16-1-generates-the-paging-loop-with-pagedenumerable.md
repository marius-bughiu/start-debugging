---
title: "Refit 16.1 Writes Your Paging Loop: PagedEnumerable, [Paged] and [PageToken]"
description: "Refit 16.1.0 lets an interface method return PagedEnumerable<TPage, TItem>, and the source generator emits the request-per-page loop for cursors, offsets, response headers and next links. Here is how to declare it, how enumeration behaves, and the RF013 build error you get for a misspelled member."
pubDate: 2026-09-25
tags:
  - "refit"
  - "httpclient"
  - "dotnet"
  - "csharp"
  - "source-generators"
---

[Refit 16.1.0](https://github.com/reactiveui/refit/releases/tag/v16.1.0) shipped on September 21, 2026, and its main feature removes a piece of boilerplate almost every Refit user has written: the `while (cursor != null)` loop around a list endpoint. A Refit method can now return `PagedEnumerable<TPage, TItem>`, and the source generator writes the loop that sends one request per page. The design is in [PR #2332](https://github.com/reactiveui/refit/pull/2332).

## Declaring a paged method

You describe the page shape with two attributes. `[Paged]` names the member that holds the continuation, and `[PageToken]` marks the parameter that sends it back:

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

`Items` is optional here: when the page type has exactly one sequence of the item type, the generator picks it. A null or empty `NextCursor` ends the sequence. The token parameter binds like any other, so `[Header]` or `[Query]` move it out of the query string.

Calling it is a plain `await foreach`, and requests only go out as you consume items. I ran this against a fake handler serving seven orders in pages of three:

```csharp
await foreach (var order in api.ListOrders(pageSize: 3))
    Console.WriteLine(order.Id);

// Requests sent:
//   /orders?limit=3
//   /orders?limit=3&cursor=3
//   /orders?limit=3&cursor=6
```

Stopping early stops the requests. `await api.ListOrders(3).FirstAsync(o => o.Id == 2)` on .NET 10 made exactly one request.

## Pages, limits and prefetch

`PagedEnumerable<TPage, TItem>` is an `IAsyncEnumerable<TItem>` with a few extra members:

- `AsPages()` yields the page objects themselves, when you need `IsTruncated` or a total alongside the items.
- `WithMaxPages(n)` caps how many requests one enumeration can make.
- `WithPrefetch()` requests the next page while you are still processing the current one.
- `ToObservable()` and `ToPageObservable()` for Rx consumers.

```csharp
await foreach (var page in api.ListOrders(3).WithMaxPages(2).AsPages())
    Console.WriteLine($"{page.Items.Count} items, next={page.NextCursor}");
```

## Headers, offsets and next links

`[Paged]` also covers the other paging styles:

- `NextHeader = "x-ms-continuation"` reads the continuation from a response header (Cosmos DB style). The page type must be `ApiResponse<T>`.
- `NextHeader = "Link"` reads the `rel="next"` relation, which is how GitHub pages.
- `Total = nameof(Result.Total)` switches to offset paging with an `int` token, for APIs like Jira.
- `Next` pointing at an absolute URL, such as Graph's `@odata.nextLink`, follows links.

Following links comes with a security requirement: you must state which origins a link may point at with `Origins = ["https://api.github.com"]`, `SameOrigin = true`, or `AnyOrigin = true`. A link to any other origin throws `InvalidOperationException` without being requested, so your `Authorization` header is never forwarded to a host a hostile server names.

## Mistakes fail the build

Member names are resolved at compile time into direct property access, with no reflection. A typo is error `RF013`:

```text
error RF013: Method 'ListOrders' cannot be generated as a paged method:
'NextCusor' is not a readable public or internal property or field of 'OrderPage'.
```

A paged method also cannot be generic or declare its own `CancellationToken`, since the token comes from the enumeration. The reflection-based request builder rejects paged returns, so this only works with the source-generated client, and a paged method the generator cannot emit inline is reported as `RF007`.

If you were weighing Refit against a hand-written typed client, see [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/). Paging was one of the places the hand-written client used to win on control. Refit now generates that loop for you, with a build error when the page shape is wrong.
