---
title: "MudBlazor 9.12: buscas lentas de ServerData e Autocomplete não sobrescrevem mais resultados mais novos"
description: "O MudBlazor 9.12.0 corrige uma condição de corrida antiga em MudAutocomplete, MudDataGrid e MudTable: o resultado da busca que terminava por último vencia, e não o da busca iniciada por último. Veja como a correção funciona e o que muda no seu código de ServerData e SearchFunc."
pubDate: 2026-10-29
tags:
  - "blazor"
  - "mudblazor"
  - "aspnet-core"
  - "dotnet"
  - "async"
lang: "pt-br"
translationOf: "2026/10/mudblazor-9-12-ignores-stale-serverdata-and-autocomplete-results"
translatedBy: "claude"
translationDate: 2026-10-29
---

O [MudBlazor 9.12.0](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0) foi lançado em 29 de outubro de 2026, e a mudança que justifica a atualização é uma condição de corrida que existe, de uma forma ou de outra, desde a [issue #3722](https://github.com/MudBlazor/MudBlazor/issues/3722). `MudAutocomplete`, `MudDataGrid` com `ServerData` e `MudTable` com `ServerData` mantinham o resultado da requisição que *terminou* por último, e não o da que o usuário *iniciou* por último.

## Por que a busca mais ampla costuma vencer

Digite "App" em um autocomplete, espere passar o debounce e continue digitando "le Pie". Agora há duas buscas em andamento. A consulta curta retorna mais linhas, então normalmente é a mais lenta. No 9.11 e anteriores, os resultados de "Apple Pie" aparecem primeiro e depois os de "App" chegam e os substituem. O usuário vê uma lista que não corresponde mais ao texto da caixa.

O mesmo acontecia com filtros e paginação do grid: mude um filtro duas vezes rapidamente e a chamada mais antiga e mais lenta de `ServerData` podia sobrescrever a página mais nova.

## Como o 9.12 decide qual resultado está obsoleto

O [PR #13944](https://github.com/MudBlazor/MudBlazor/pull/13944) usa duas estratégias diferentes. No `MudAutocomplete`, cada busca recebe um número de versão, e uma busca que foi substituída por outra mais nova sai antes de tocar nos itens, na contagem de itens retornados ou no popover:

```csharp
var searchVersion = ++_searchVersion;
// ... await SearchFunc(text, token) ...
if (searchVersion != _searchVersion)
{
    return;
}
```

A verificação roda duas vezes, a segunda depois de `ReturnedItemsCountChanged`, porque o seu handler pode ceder a execução e deixar uma busca mais nova terminar nesse intervalo. Isso importa porque muitas implementações de `SearchFunc` ignoram o `CancellationToken` por completo, então só o cancelamento nunca teria resolvido o problema.

O `MudDataGrid` usa o token que já passava para `ServerData`. Se um carregamento mais novo o cancelou, o carregamento antigo retorna sem atribuir dados nem limpar `Loading`, mesmo que tenha lançado uma exceção:

```csharp
catch (Exception) when (token.IsCancellationRequested)
{
    // A newer load cancelled this one, and it owns the data and the loading state.
    return;
}
```

O tipo da exceção é ignorado de propósito, porque fontes de dados costumam reportar uma requisição cancelada como uma falha própria (uma `HttpRequestException`, uma `DbException` específica do provider, e assim por diante). O [PR #14053](https://github.com/MudBlazor/MudBlazor/pull/14053) aplica a mesma regra ao `MudTable`, e correções posteriores mantêm o indicador de carregamento ativo durante um reset de página e impedem que uma busca tardia reabra o menu de um autocomplete que já havia sido fechado, selecionado ou limpo.

## O que muda no seu código

O PR destaca duas mudanças de comportamento:

- Uma busca de autocomplete que foi substituída não dispara mais `ReturnedItemsCountChanged`.
- `ReloadServerData()` não lança mais exceção quando um carregamento mais novo o substitui.

Se você envolveu `ReloadServerData()` em um `try/catch` para engolir `TaskCanceledException`, esse código agora é morto. Você ainda deve repassar o token, pois uma requisição cancelada que realmente para é mais barata do que uma que o MudBlazor descarta silenciosamente:

```csharp
private async Task<GridData<Order>> LoadOrders(GridState<Order> state, CancellationToken ct)
{
    var page = await Http.GetFromJsonAsync<PagedResult<Order>>(
        $"api/orders?page={state.Page}&size={state.PageSize}", ct);
    return new GridData<Order> { Items = page!.Items, TotalItems = page.Total };
}
```

Os caminhos de `VirtualizeServerData` não são cobertos por esta correção, já que cada requisição virtualizada já tem seu próprio token.

## Outras notas de atualização no 9.12.0

As colunas de enum no `MudDataGrid` agora oferecem um filtro "is any of" cujo `Value` é uma coleção, então um handler de `ServerData` que faz switch sobre os operadores precisa de um novo case ou de `Column.FilterOperators` para ocultá-lo. Ler `MudStep.Title`, `MudDatePicker.MinDate` e alguns outros por meio de uma referência de componente agora gera o diagnóstico de analyzer `MUD0012`; use `GetState(x => x.Title)` no lugar. A lista completa, incluindo pontos nulos em gráficos de linha e `MudText.Truncate`, está nas [notas da versão](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0).

```bash
dotnet add package MudBlazor --version 9.12.0
```
