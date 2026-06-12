---
title: "LINQ ganha FullJoin e joins sem seletor no .NET 11 Preview 5"
description: "O .NET 11 Preview 5 adiciona um operador FullJoin totalmente novo ao LINQ, além de sobrecargas que retornam tuplas para Join, LeftJoin, RightJoin e GroupJoin que dispensam por completo o seletor de resultado."
pubDate: 2026-06-12
tags:
  - "dotnet-11"
  - "csharp"
  - "linq"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-12
---

As [notas das bibliotecas do .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) fecham uma história que começou no .NET 10. Aquela versão deu ao LINQ o `LeftJoin` e o `RightJoin`, então você não precisava mais simular um outer join com `GroupJoin` mais `SelectMany` mais `DefaultIfEmpty`. O Preview 5 adiciona o quarto canto que faltava, o `FullJoin`, e de quebra corrige a parte mais irritante de todo join: o seletor de resultado.

## O seletor de resultado sempre foi código de preenchimento

Cada sobrecarga de join anterior recebia quatro argumentos: a sequência interna, a chave externa, a chave interna e um seletor de resultado que dizia ao LINQ como combinar um par correspondente. Nove vezes em dez, esse seletor apenas colava os dois itens em um tipo anônimo ou em uma tupla:

```csharp
var pairs = catalog.Join(
    sales,
    p => p.Sku,
    s => s.Sku,
    (product, sale) => (product, sale));

foreach (var (product, sale) in pairs)
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

Essa última lambda não carrega lógica alguma. Ela existe só para satisfazer a assinatura. O Preview 5 adiciona sobrecargas que retornam tuplas para `Join`, `LeftJoin`, `RightJoin` e `GroupJoin` que inferem a forma óbvia e deixam você removê-la:

```csharp
foreach (var (product, sale) in catalog.Join(sales, p => p.Sku, s => s.Sku))
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

O `Join` agora retorna `IEnumerable<(TOuter, TInner)>`. O `GroupJoin` retorna `IEnumerable<(TOuter, IEnumerable<TInner>)>`. As variantes esquerda e direita retornam o lado externo ou interno como anulável, exatamente como o SQL faria. As sobrecargas existem em `Enumerable`, `Queryable` e `AsyncEnumerable`, então a mesma forma de chamada funciona em coleções em memória, árvores de consulta do EF Core e fluxos assíncronos.

## FullJoin completa o conjunto

O operador genuinamente novo é o `FullJoin` ([dotnet/runtime #127236](https://github.com/dotnet/runtime/pull/127236)). Um full outer join retorna cada elemento de ambas as sequências, emparelhando os que têm chaves correspondentes e deixando os não correspondentes com um par `null`. Reconciliar duas listas, por exemplo um catálogo de produtos contra um feed de vendas, antes exigia duas passagens ou uma busca em um dicionário montado à mão. Agora é uma única chamada:

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

Aqui os dois lados da tupla são anuláveis porque qualquer um pode estar ausente, e as anotações de tipos anuláveis do C# fazem o compilador te empurrar a tratar as duas lacunas.

## O que vale saber antes de depender disso

Essas são adições apenas à sintaxe de métodos do LINQ. Não existe uma palavra-chave `full join` de consulta, e as formas existentes de compreensão de consultas continuam intocadas. Para os provedores do EF Core, se o `FullJoin` se traduz em um `FULL OUTER JOIN` ou recai em avaliação no cliente depende de o provedor se atualizar, então confira o SQL gerado antes de presumir que ele roda no banco de dados. Como no restante do Preview 5, incluindo o novo [suporte do System.Text.Json a JSON Lines](/pt-br/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/), as assinaturas ainda podem mudar antes da versão estável de novembro. Mas a forma é limpa o bastante para você começar a apagar lambdas de seletor de resultado hoje.
