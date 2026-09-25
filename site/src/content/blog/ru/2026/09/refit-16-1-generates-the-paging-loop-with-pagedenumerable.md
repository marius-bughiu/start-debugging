---
title: "Refit 16.1 сам пишет цикл пагинации: PagedEnumerable, [Paged] и [PageToken]"
description: "Refit 16.1.0 позволяет методу интерфейса возвращать PagedEnumerable<TPage, TItem>, а генератор исходного кода создает цикл с запросом на каждую страницу для курсоров, смещений, заголовков ответа и ссылок на следующую страницу. Здесь показано, как объявить такой метод, как ведет себя перечисление и какую ошибку сборки RF013 вы получите за опечатку в имени члена."
pubDate: 2026-09-25
tags:
  - "refit"
  - "httpclient"
  - "dotnet"
  - "csharp"
  - "source-generators"
lang: "ru"
translationOf: "2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable"
translatedBy: "claude"
translationDate: 2026-09-25
---

[Refit 16.1.0](https://github.com/reactiveui/refit/releases/tag/v16.1.0) вышел 21 сентября 2026 года, и его главная функция убирает шаблонный код, который написал почти каждый пользователь Refit: цикл `while (cursor != null)` вокруг эндпоинта со списком. Теперь метод Refit может возвращать `PagedEnumerable<TPage, TItem>`, а генератор исходного кода сам пишет цикл, отправляющий по одному запросу на страницу. Дизайн описан в [PR #2332](https://github.com/reactiveui/refit/pull/2332).

## Объявление метода с пагинацией

Форма страницы описывается двумя атрибутами. `[Paged]` называет член, который хранит токен продолжения, а `[PageToken]` помечает параметр, который отправляет его обратно:

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

`Items` здесь не обязателен: если тип страницы содержит ровно одну последовательность элементов нужного типа, генератор выбирает ее сам. Пустой или null-токен `NextCursor` завершает последовательность. Параметр токена привязывается как любой другой, поэтому `[Header]` или `[Query]` выносят его из строки запроса.

Вызов - это обычный `await foreach`, и запросы уходят только по мере того, как вы потребляете элементы. Я прогнал это на фейковом обработчике, отдающем семь заказов страницами по три:

```csharp
await foreach (var order in api.ListOrders(pageSize: 3))
    Console.WriteLine(order.Id);

// Requests sent:
//   /orders?limit=3
//   /orders?limit=3&cursor=3
//   /orders?limit=3&cursor=6
```

Ранняя остановка останавливает и запросы. `await api.ListOrders(3).FirstAsync(o => o.Id == 2)` на .NET 10 сделал ровно один запрос.

## Страницы, лимиты и предзагрузка

`PagedEnumerable<TPage, TItem>` - это `IAsyncEnumerable<TItem>` с несколькими дополнительными членами:

- `AsPages()` возвращает сами объекты страниц, когда вам нужны `IsTruncated` или итоговое количество наряду с элементами.
- `WithMaxPages(n)` ограничивает число запросов, которое может сделать одно перечисление.
- `WithPrefetch()` запрашивает следующую страницу, пока вы еще обрабатываете текущую.
- `ToObservable()` и `ToPageObservable()` для потребителей Rx.

```csharp
await foreach (var page in api.ListOrders(3).WithMaxPages(2).AsPages())
    Console.WriteLine($"{page.Items.Count} items, next={page.NextCursor}");
```

## Заголовки, смещения и ссылки на следующую страницу

`[Paged]` покрывает и другие стили пагинации:

- `NextHeader = "x-ms-continuation"` читает токен продолжения из заголовка ответа (в стиле Cosmos DB). Тип страницы должен быть `ApiResponse<T>`.
- `NextHeader = "Link"` читает отношение `rel="next"`, так пагинирует GitHub.
- `Total = nameof(Result.Total)` переключает на пагинацию по смещению с токеном типа `int`, для API вроде Jira.
- `Next`, указывающий на абсолютный URL, например `@odata.nextLink` в Graph, следует по ссылкам.

Переход по ссылкам сопровождается требованием безопасности: нужно указать, на какие источники может указывать ссылка, через `Origins = ["https://api.github.com"]`, `SameOrigin = true` или `AnyOrigin = true`. Ссылка на любой другой источник выбрасывает `InvalidOperationException` еще до того, как будет отправлен запрос, поэтому заголовок `Authorization` никогда не пересылается на хост, который назвал враждебный сервер.

## Ошибки ломают сборку

Имена членов разрешаются во время компиляции в прямой доступ к свойству, без использования рефлексии. Опечатка - это ошибка `RF013`:

```text
error RF013: Method 'ListOrders' cannot be generated as a paged method:
'NextCusor' is not a readable public or internal property or field of 'OrderPage'.
```

Метод с пагинацией также не может быть обобщенным или объявлять собственный `CancellationToken`, поскольку токен приходит из перечисления. Построитель запросов на основе рефлексии отклоняет пагинированные возвращаемые типы, поэтому это работает только с клиентом, сгенерированным из исходного кода, а метод с пагинацией, который генератор не может встроить, помечается ошибкой `RF007`.

Если вы выбирали между Refit и написанным вручную типизированным клиентом, см. [HttpClient vs HttpClientFactory vs Refit: что использовать в .NET 11?](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/). Пагинация была одним из мест, где написанный вручную клиент раньше выигрывал по контролю. Теперь Refit сам генерирует этот цикл, с ошибкой сборки, если форма страницы неверна.
