---
title: "Refit 16.1 escreve seu loop de paginação: PagedEnumerable, [Paged] e [PageToken]"
description: "O Refit 16.1.0 permite que um método de interface retorne PagedEnumerable<TPage, TItem>, e o gerador de código-fonte emite o loop de uma requisição por página para cursores, offsets, cabeçalhos de resposta e links de próxima página. Veja como declará-lo, como a enumeração se comporta, e o erro de build RF013 que você recebe para um membro com nome errado."
pubDate: 2026-09-25
tags:
  - "refit"
  - "httpclient"
  - "dotnet"
  - "csharp"
  - "source-generators"
lang: "pt-br"
translationOf: "2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable"
translatedBy: "claude"
translationDate: 2026-09-25
---

O [Refit 16.1.0](https://github.com/reactiveui/refit/releases/tag/v16.1.0) foi lançado em 21 de setembro de 2026, e sua principal novidade remove um trecho de boilerplate que quase todo usuário do Refit já escreveu: o loop `while (cursor != null)` em volta de um endpoint de lista. Um método do Refit agora pode retornar `PagedEnumerable<TPage, TItem>`, e o gerador de código-fonte escreve o loop que envia uma requisição por página. O design está no [PR #2332](https://github.com/reactiveui/refit/pull/2332).

## Declarando um método paginado

Você descreve o formato da página com dois atributos. `[Paged]` nomeia o membro que guarda a continuação, e `[PageToken]` marca o parâmetro que a envia de volta:

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

`Items` é opcional aqui: quando o tipo de página tem exatamente uma sequência do tipo do item, o gerador a escolhe automaticamente. Um `NextCursor` nulo ou vazio encerra a sequência. O parâmetro do token se vincula como qualquer outro, então `[Header]` ou `[Query]` o tiram da query string.

Chamá-lo é um simples `await foreach`, e as requisições só saem à medida que você consome os itens. Rodei isso contra um handler falso servindo sete pedidos em páginas de três:

```csharp
await foreach (var order in api.ListOrders(pageSize: 3))
    Console.WriteLine(order.Id);

// Requests sent:
//   /orders?limit=3
//   /orders?limit=3&cursor=3
//   /orders?limit=3&cursor=6
```

Parar antes do tempo interrompe as requisições. `await api.ListOrders(3).FirstAsync(o => o.Id == 2)` no .NET 10 fez exatamente uma requisição.

## Páginas, limites e prefetch

`PagedEnumerable<TPage, TItem>` é um `IAsyncEnumerable<TItem>` com alguns membros extras:

- `AsPages()` produz os próprios objetos de página, para quando você precisa de `IsTruncated` ou de um total junto com os itens.
- `WithMaxPages(n)` limita quantas requisições uma enumeração pode fazer.
- `WithPrefetch()` solicita a próxima página enquanto você ainda está processando a atual.
- `ToObservable()` e `ToPageObservable()` para consumidores de Rx.

```csharp
await foreach (var page in api.ListOrders(3).WithMaxPages(2).AsPages())
    Console.WriteLine($"{page.Items.Count} items, next={page.NextCursor}");
```

## Cabeçalhos, offsets e links de próxima página

`[Paged]` também cobre os outros estilos de paginação:

- `NextHeader = "x-ms-continuation"` lê a continuação de um cabeçalho de resposta (estilo Cosmos DB). O tipo de página precisa ser `ApiResponse<T>`.
- `NextHeader = "Link"` lê a relação `rel="next"`, que é como o GitHub pagina.
- `Total = nameof(Result.Total)` muda para paginação por offset com um token `int`, para APIs como a do Jira.
- `Next` apontando para uma URL absoluta, como o `@odata.nextLink` do Graph, segue links.

Seguir links vem com uma exigência de segurança: você precisa declarar para quais origens um link pode apontar, com `Origins = ["https://api.github.com"]`, `SameOrigin = true`, ou `AnyOrigin = true`. Um link para qualquer outra origem lança `InvalidOperationException` sem sequer ser requisitado, então seu cabeçalho `Authorization` nunca é encaminhado para um host que um servidor mal-intencionado indique.

## Erros quebram o build

Nomes de membros são resolvidos em tempo de compilação para acesso direto a propriedades, sem reflection. Um erro de digitação é o erro `RF013`:

```text
error RF013: Method 'ListOrders' cannot be generated as a paged method:
'NextCusor' is not a readable public or internal property or field of 'OrderPage'.
```

Um método paginado também não pode ser genérico nem declarar seu próprio `CancellationToken`, já que o token vem da enumeração. O construtor de requisições baseado em reflection rejeita retornos paginados, então isso só funciona com o cliente gerado por código-fonte, e um método paginado que o gerador não consegue emitir inline é reportado como `RF007`.

Se você estava pesando o Refit contra um cliente tipado escrito à mão, veja [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/). A paginação era um dos pontos em que o cliente escrito à mão costumava vencer em controle. O Refit agora gera esse loop para você, com um erro de build quando o formato da página está errado.
