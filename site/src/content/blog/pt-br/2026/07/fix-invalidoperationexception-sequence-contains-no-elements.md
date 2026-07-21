---
title: "Solução: System.InvalidOperationException: Sequence contains no elements"
description: "Essa exceção significa que você chamou .First() ou .Single() em uma sequência vazia. Use FirstOrDefault/SingleOrDefault e verifique o null, proteja a consulta ou corrija por que a fonte está vazia."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/07/fix-invalidoperationexception-sequence-contains-no-elements"
translatedBy: "claude"
translationDate: 2026-07-21
---

`System.InvalidOperationException: Sequence contains no elements` significa que você chamou `.First()`, `.Single()`, `.Last()` ou um de seus primos de agregação (`.Average()`, `.Max()`, `.Min()`) em uma sequência que acabou estando vazia. O operador prometeu retornar um elemento e não havia nenhum, então ele lançou a exceção. A solução é decidir o que "vazio" deve significar para aquela chamada: se vazio for um resultado normal, mude para `.FirstOrDefault()` / `.SingleOrDefault()` e trate o `null` (ou valor padrão) que você recebe de volta; se vazio for um bug, corrija a consulta ou os dados para que a sequência nunca fique vazia nesse ponto. Isso foi verificado com .NET 11, C# 14 e EF Core 11.0.0, mas a mensagem e o comportamento são estáveis desde que o LINQ chegou no .NET Framework 3.5, então o guia se aplica a qualquer versão.

## O erro em contexto

A exceção completa, lançada de dentro do `System.Linq`, se parece com isto:

```
System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)
   at MyApp.OrderService.GetLatest() in /src/OrderService.cs:line 42
```

A pista está no frame do topo: `System.Linq.ThrowHelper.ThrowNoElementsException`. Se você vê isso no stack trace, um operador LINQ que retorna elementos rodou contra uma fonte vazia. O texto exato importa para a busca, porque o LINQ lança quatro mensagens muito próximas a partir da mesma classe e elas significam coisas diferentes:

- `Sequence contains no elements` -- `.First()`, `.Single()`, `.Last()` (sem predicado) em uma fonte vazia.
- `Sequence contains no matching element` -- `.First(predicate)`, `.Single(predicate)`, `.Last(predicate)` em que nada correspondeu.
- `Sequence contains more than one element` -- `.Single()` em uma fonte com dois ou mais itens.
- `Sequence contains more than one matching element` -- `.Single(predicate)` em que mais de um item correspondeu.

Este post trata da primeira. As outras são cobertas na seção de variantes, porque cair na errada faz você perder tempo.

## Por que isso acontece

`.First()` e `.Single()` são operadores com contrato: o tipo de retorno deles é um `TSource` não anulável, então não têm como sinalizar "não há nada aqui" a não ser lançando uma exceção. Quando a fonte está vazia, não há elemento para devolver, e retornar `default(TSource)` seria uma mentira para um tipo de referência (você receberia `null` onde a assinatura prometia um valor). Por isso o runtime lança `InvalidOperationException` em vez disso. Essa é uma decisão de design deliberada, não um bug: as variantes `*OrDefault` existem justamente para o caso em que vazio é aceitável.

A parte confusa é que a sequência costuma estar vazia por razões invisíveis no ponto da chamada. Um filtro `Where` anterior removeu todas as linhas. Uma tabela do banco de dados ainda não tem nenhum registro correspondente. Uma coleção foi esvaziada, ou nunca foi populada porque um `await` anterior falhou em silêncio. A exceção dispara na linha do `.First()`, mas a causa real está três linhas (ou três chamadas de método) antes. É por isso que "é só envolver em try/catch" raramente é o instinto certo: você quer saber por que a sequência está vazia, não apenas engolir o sintoma.

## Reprodução mínima

O menor código que a lança:

```csharp
// .NET 11, C# 14
var numbers = new List<int>();     // empty
int first = numbers.First();       // System.InvalidOperationException: Sequence contains no elements
```

O mesmo acontece quando um filtro elimina tudo, que é a forma real muito mais comum:

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

Repare que a segunda mensagem é a variante `no matching element`, porque um predicado foi fornecido. Ambas vêm da mesma família de bugs: você assumiu que pelo menos um elemento estaria ali, e não estava.

## A solução, em detalhe

Percorra estas opções em ordem. As duas primeiras cobrem quase toda ocorrência real.

### 1. Use FirstOrDefault / SingleOrDefault e trate o caso vazio

Se uma sequência vazia for um resultado legítimo (ainda sem linhas, uma busca opcional, uma consulta que pode não achar nada), mude para a sobrecarga `*OrDefault` e verifique o que você recebe:

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

`FirstOrDefault` retorna `default(TSource)` quando a sequência está vazia: `null` para um tipo de referência, `0` para `int`, `default` para um struct. Em uma base de código com anotações anuláveis (`<Nullable>enable</Nullable>`, o padrão nos novos templates do .NET 11), o compilador tipa o resultado como `Order?` e vai insistir até você verificar o null, que é exatamente a segurança que você quer. Não pule a verificação: trocar `First` por `FirstOrDefault` e então desreferenciar o resultado imediatamente apenas troca `InvalidOperationException` por um `NullReferenceException` uma linha depois. Se os avisos de anulabilidade parecerem barulho, é o compilador apontando o trabalho real, e isso se conecta diretamente com [CS8618 e propriedades não anuláveis](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/).

Desde o .NET 6 também existe uma sobrecarga que permite fornecer seu próprio valor padrão, mais limpa do que uma verificação de null separada quando você tem um fallback sensato:

```csharp
// .NET 11, C# 14 -- FirstOrDefault(predicate, defaultValue) added in .NET 6
Order next = orders.FirstOrDefault(o => o.Status == "pending", Order.None);
```

### 2. Proteja a sequência antes de chamar First

Quando você realmente precisa do primeiro elemento, mas só se ele existir, verifique se está vazia primeiro. Para uma coleção em memória, `Count` ou `Any()` basta:

```csharp
// .NET 11, C# 14
if (orders.Count > 0)
{
    Order first = orders.First();   // safe: we know it is non-empty
    Process(first);
}
```

Prefira `Count` (ou `Count > 0`) para qualquer coisa que implemente `ICollection<T>`, como `List<T>` ou um array, porque é O(1). Use `.Any()` para um `IEnumerable<T>` de avaliação preguiçosa em que você não consegue obter uma contagem de forma barata. Não escreva `if (orders.Count() > 0)` em uma sequência preguiçosa: `Count()` enumera a coisa toda, enquanto `Any()` para depois do primeiro elemento.

### 3. Corrija por que a sequência está vazia

Às vezes vazio é o bug, não um estado válido. Se `orders.First(o => o.Status == "pending")` deveria sempre achar uma linha e não acha, a correção real está a montante: um filtro rígido demais, uma diferença de maiúsculas e minúsculas (`"Pending"` vs `"pending"`), um join que descartou linhas, ou dados que nunca foram inseridos. Recorra aqui a um `*OrDefault` apenas depois de confirmar que a sequência tem permissão para estar vazia. Encobrir um caso de "isso nunca deveria estar vazio" com `FirstOrDefault` esconde um erro genuíno de dados ou de lógica e move a falha para um lugar mais difícil de diagnosticar.

### 4. Para agregações, use uma sobrecarga anulável ou DefaultIfEmpty

`.Average()`, `.Max()`, `.Min()` e `.Sum()` compartilham a mesma armadilha. `.Average()` e as versões de tipo de valor de `.Max()`/`.Min()` lançam `Sequence contains no elements` em uma fonte vazia (`.Sum()` retorna 0, que é a sua própria surpresa). Duas soluções limpas:

```csharp
// .NET 11, C# 14
var prices = new List<int>();

// Option A: project to a nullable so the aggregate returns null instead of throwing.
double? avg = prices.Average(p => (int?)p);   // null when empty, no exception

// Option B: supply a fallback element before aggregating.
int max = prices.DefaultIfEmpty(0).Max();     // 0 when empty
```

`DefaultIfEmpty` é a saída de emergência de uso geral: ele produz um único elemento padrão quando a fonte está vazia, de modo que qualquer operador posterior, incluindo `.First()`, vê pelo menos um item.

## Pegadinhas e variantes

Algumas situações produzem essa exceção, ou uma parente próxima, por razões que a mensagem não explicita:

- **`no matching element` é uma mensagem diferente com a mesma causa.** `.First()` em uma fonte vazia diz `Sequence contains no elements`; `.First(predicate)` que não corresponde a nada diz `Sequence contains no matching element`. Elas são lançadas por helpers diferentes, mas a correção é idêntica: `FirstOrDefault(predicate)` e uma verificação de null. Se a sua fonte tem linhas mas o predicado nunca corresponde, a sequência entregue ao `First` está efetivamente vazia.

- **`.Single()` lança duas mensagens diferentes.** `.Single()` garante *exatamente um* elemento, então pode falhar de duas formas: `Sequence contains no elements` quando há zero, e `Sequence contains more than one element` quando há dois ou mais. Se você está vendo a variante "more than one", `FirstOrDefault` não é a correção; ou sua suposição de unicidade está errada (uma cláusula `WHERE` faltando, uma chave duplicada) ou você deveria usar `First` porque só quer um entre vários. Use `Single` apenas quando uma segunda correspondência for, em si, um bug que mereça lançar exceção.

- **EF Core lança a mesma coisa a partir de `First`/`Single`, e as versões assíncronas também.** `dbContext.Orders.First(o => o.Id == id)` traduz para `SELECT TOP(1)` e lança `Sequence contains no elements` quando nenhuma linha corresponde. `FirstAsync` e `SingleAsync` lançam de forma idêntica. A correção é `FirstOrDefaultAsync` / `SingleOrDefaultAsync` mais uma verificação de null. Como estas rodam contra o banco de dados, um resultado vazio costuma ser normal (a linha foi excluída, o id está errado), então as sobrecargas assíncronas `*OrDefault` geralmente são o que você quer. Veja [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) para entender por que o operador LINQ se comporta igual, quer rode em memória, quer como SQL.

- **`FirstOrDefault` em uma sequência de tipo de valor retorna 0, não null.** Para `List<int>`, `FirstOrDefault()` em uma lista vazia retorna `0`, que é um `int` válido e indistinguível de um primeiro elemento real igual a `0`. Se você precisa diferenciar "vazio" de "o primeiro valor por acaso é o padrão", projete para um anulável (`.Select(x => (int?)x).FirstOrDefault()`) ou proteja com `.Any()` em vez de confiar no valor sentinela padrão.

- **A sequência vazia pode vir de uma consulta mal traduzida, não de dados faltando.** No EF Core, uma consulta que avalia parte de um filtro no cliente silenciosamente, ou uma que não pôde ser traduzida de forma alguma, pode retornar um conjunto de resultados diferente (muitas vezes vazio) do que você espera. Se um `First` contra o banco de dados lança a exceção e você tem certeza de que a linha existe, verifique se a consulta foi traduzida como você pretendia. Esse modo de falha é coberto em [a expressão LINQ não pôde ser traduzida](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

- **Envolver em try/catch esconde a verdadeira pergunta.** Capturar `InvalidOperationException` em volta de uma chamada `First` tecnicamente para o crash, mas também captura outras `InvalidOperationException` não relacionadas (um erro de coleção-modificada-durante-a-enumeração, por exemplo) e não te diz nada sobre por que a sequência estava vazia. Prefira `*OrDefault` mais um ramo explícito: é mais rápido (sem maquinaria de exceções), mais estreito e autodocumentado.

O modelo mental a manter: `.First()` e `.Single()` são afirmações de que um elemento existe. `Sequence contains no elements` é essa afirmação falhando. Decida se o caso vazio é legítimo. Se for, expresse isso com `FirstOrDefault`/`SingleOrDefault` e trate o valor padrão que você recebe. Se não for, corrija a consulta ou os dados a montante para que a sequência nunca fique vazia nesse ponto, em vez de disfarçar no ponto da chamada.

## Relacionados

- [Solução: a expressão LINQ não pôde ser traduzida no EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) para quando o resultado vazio vem de uma consulta que não rodou como você esperava.
- [IEnumerable vs IAsyncEnumerable vs IQueryable em C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) para entender por que `First` se comporta igual em memória e contra um banco de dados, e quando a consulta realmente executa.
- [Solução: CS8618 a propriedade não anulável deve conter um valor não nulo](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) para tratar o resultado anulável que `FirstOrDefault` devolve.
- [LINQ FullJoin e joins que retornam tuplas no .NET 11](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/) para moldar resultados de joins sem descartar linhas que deixariam uma sequência vazia.

## Fontes

- Microsoft Learn, [Enumerable.First Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.first) (lança `InvalidOperationException` quando a sequência fonte está vazia ou nenhum elemento corresponde ao predicado; use `FirstOrDefault` para retornar um valor padrão em vez disso).
- Microsoft Learn, [Enumerable.Single Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.single) (lança quando a sequência está vazia, contém mais de um elemento ou nenhum elemento corresponde).
- Microsoft Learn, [Enumerable.FirstOrDefault Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.firstordefault) (retorna `default(TSource)` para uma sequência vazia, além da sobrecarga do .NET 6 que aceita um valor padrão explícito).
- Microsoft Learn, [Enumerable.DefaultIfEmpty Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.defaultifempty) (produz um único elemento padrão quando a fonte está vazia).
