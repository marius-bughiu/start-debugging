---
title: "Lookup<TKey, TElement> vs Dictionary<TKey, List<TValue>> para chaves duplicadas em C#"
description: "Use ToLookup quando você agrupa uma vez e só lê: é imutável, retorna uma sequência vazia para chaves ausentes, aceita chaves null e mantém a ordem em que as chaves aparecem pela primeira vez. Use Dictionary<TKey, List<TValue>> quando os grupos mudam depois da construção ou atravessam uma fronteira JSON."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "collections"
  - "performance"
lang: "pt-br"
translationOf: "2026/09/lookup-vs-dictionary-of-lists-for-duplicate-keys-in-csharp"
translatedBy: "claude"
translationDate: 2026-09-12
---

Quando uma chave precisa mapear para vários valores em C#, as duas respostas nativas são `ILookup<TKey, TElement>` (o que `Enumerable.ToLookup` retorna) e um `Dictionary<TKey, List<TValue>>` feito à mão. **Escolha `ToLookup` quando você monta o agrupamento uma única vez a partir de uma sequência existente e depois só o lê**: é uma linha, é imutável, retorna uma sequência vazia em vez de lançar exceção para uma chave ausente, aceita uma chave `null` e enumera os grupos na ordem em que as chaves aparecem pela primeira vez. **Escolha `Dictionary<TKey, List<TValue>>` quando os grupos mudam depois da construção, quando você precisa de `TryGetValue` ou quando o resultado precisa fazer o caminho de ida e volta por JSON.** O desempenho pende para o dicionário, mas não o suficiente para decidir a maioria dos casos: no .NET 11 RC 1, um dicionário feito à mão é montado cerca de 30% mais rápido que `ToLookup` e lê 3-13% mais rápido, o que para 100,000 itens fica abaixo de 2 ms. Tudo abaixo foi executado no .NET 11 RC 1 (runtime `11.0.0-rc.1.26425.128`, C# 15), e o comportamento descrito é estável desde que `ToLookup` chegou no .NET Framework 3.5.

## As duas formas lado a lado

| Comportamento (.NET 11 RC 1)                | `ILookup<TKey, TElement>` via `ToLookup` | `Dictionary<TKey, List<TValue>>`        |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Adicionar ou remover após a construção      | não, imutável                            | sim                                     |
| Indexador em uma chave ausente              | sequência vazia                          | `KeyNotFoundException`                  |
| Chave `null`                                | permitida                                | `ArgumentNullException`                 |
| Ordem de enumeração dos grupos              | ordem da primeira aparição da chave, por construção | ordem de inserção na prática, não garantida |
| Ordem dos elementos dentro de um grupo      | ordem da fonte                           | a ordem em que você chamar `Add`        |
| `TryGetValue`                               | não (`Contains` + indexador)             | sim                                     |
| Construtor público                          | não                                      | sim                                     |
| Serialização com `System.Text.Json`         | array de arrays, chaves perdidas         | objeto indexado por `TKey`              |
| Desserialização com `System.Text.Json`      | `NotSupportedException`                  | sim                                     |
| Montar 100k itens, 100 chaves               | 660 us, 1.91 MB                          | 477 us, 1.91 MB                         |
| Ler 1,000 sondagens, 10,000 chaves          | 66.1 us, 29,344 B                        | 61.0 us, 0 B                            |

As linhas que decidem a maioria dos casos reais são as duas primeiras e as de JSON. O resto são detalhes que mordem você mais tarde se escolheu pelo eixo errado.

## O que ToLookup realmente monta

`Lookup<TKey, TElement>` não tem construtor público. `Enumerable.ToLookup` é a única forma de obter um, e o código-fonte em [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) mostra exatamente o que você recebe de volta:

- O tipo em tempo de execução é um `CollectionLookup<TKey, TElement>` interno, uma subclasse do `Lookup<TKey, TElement>` público que também implementa `ICollection<IGrouping<TKey, TElement>>`, com todo membro de mutação lançando `NotSupportedException`.
- Ele é sua própria pequena tabela hash: um array de buckets `Grouping<TKey, TElement>`, dimensionado para um número primo e redimensionado com `HashHelpers.ExpandPrime`, com encadeamento por meio de um campo `_hashNext`. Ele não encapsula um `Dictionary`.
- Cada grupo também é um nó em uma lista ligada circular, anexado conforme cada nova chave aparece. A enumeração percorre essa lista, e é por isso que os grupos voltam na ordem da primeira aparição. Isso é uma propriedade estrutural do tipo, não um acaso do layout do hash.
- Cada `Grouping` armazena seus elementos em um `TElement[]` que começa com tamanho 1 e dobra, assim como `List<T>`, e implementa `IList<TElement>` somente leitura.
- Uma chave `null` gera hash `0` em vez de chamar o comparador, então `null` é uma chave válida.
- Se a fonte for um array vazio, você recebe um singleton compartilhado `EmptyLookup<TKey, TElement>.Instance` e nada é alocado.

Duas coisas decorrem disso. Primeiro, `ToLookup` é **eager**: ele percorre a fonte inteira imediatamente, ao contrário de `GroupBy`, que é adiado e monta o mesmo `Lookup` interno toda vez que você o enumera. Segundo, `lookup[key].Count()` é O(1), porque `Enumerable.Count` enxerga a implementação de `ICollection<T>` em `Grouping` e lê a contagem diretamente.

## Os comportamentos que realmente diferem

Aqui está um pequeno programa que exercita cada linha da tabela. Execute-o como um app de console no .NET 11:

```csharp
// .NET 11 RC 1 (11.0.0-rc.1.26425.128), C# 15
var orders = new List<Order>
{
    new("alice", 1), new("bob", 2), new("alice", 3), new(null, 4), new("carol", 5),
};

var lookup = orders.ToLookup(o => o.Customer);
Console.WriteLine(lookup.GetType());                     // System.Linq.CollectionLookup`2[...]
Console.WriteLine(lookup.Count);                         // 4 (keys, not orders)
Console.WriteLine(lookup["dave"].Count());               // 0, no exception
Console.WriteLine(string.Join(",", lookup[null].Select(o => o.Id)));            // 4
Console.WriteLine(string.Join(",", lookup.Select(g => g.Key ?? "<null>")));     // alice,bob,<null>,carol

try { ((IList<Order>)lookup["alice"]).Add(new("alice", 99)); }
catch (NotSupportedException) { Console.WriteLine("groups are read-only"); }

// Eager vs deferred
var source = new List<Order> { new("x", 1) };
var eager = source.ToLookup(o => o.Customer);
var deferred = source.GroupBy(o => o.Customer);
source.Add(new("x", 2));
Console.WriteLine(eager["x"].Count());       // 1, snapshot taken at ToLookup
Console.WriteLine(deferred.First().Count()); // 2, re-evaluated on enumeration

var map = new Dictionary<string, List<Order>>();
// map["dave"]      -> KeyNotFoundException
// map.Add(null!, []) -> ArgumentNullException

record Order(string? Customer, int Id);
```

A linha eager vs adiado é a que causa bugs reais. Se você guarda o resultado de um `GroupBy` em um campo e o enumera duas vezes, paga pelo agrupamento duas vezes e vê o estado da fonte naquele momento. `ToLookup` tira um snapshot. Se você não tem certeza se uma sequência que recebeu já foi materializada, [verifique antes de agrupá-la](/pt-br/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/).

`Count` é a outra armadilha: em um lookup, ele é o número de **chaves**, não o número de elementos. Para obter o total de elementos, você precisa de `lookup.Sum(g => g.Count())`.

## Montando um Dictionary de listas sem a busca dupla

Se você seguir o caminho do dicionário, o padrão clássico calcula o hash da chave duas vezes para cada nova chave (`TryGetValue`, depois `Add`):

```csharp
// .NET 11 RC 1, C# 15
var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    if (!map.TryGetValue(o.CustomerId, out var list))
    {
        list = new List<Order>();
        map.Add(o.CustomerId, list);
    }
    list.Add(o);
}
```

Desde o .NET 6 você pode fazer isso com uma única sondagem de hash por item usando [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), que retorna um `ref` para o slot do valor e insere uma entrada padrão quando a chave está ausente:

```csharp
// .NET 11 RC 1, C# 15
using System.Runtime.InteropServices;

var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    ref var list = ref CollectionsMarshal.GetValueRefOrAddDefault(map, o.CustomerId, out _);
    (list ??= []).Add(o);
}
```

A documentação traz uma regra que você precisa respeitar: não adicione nem remova entradas do dicionário enquanto estiver segurando esse `ref`. No loop acima, o `ref` morre antes da próxima iteração, então é seguro.

Se você prefere uma linha só de LINQ, `GroupBy(...).ToDictionary(g => g.Key, g => g.ToList())` funciona, mas aloca os agrupamentos intermediários e depois copia cada elemento para uma nova lista. E se você recorrer ao `AggregateBy` do .NET 9, use a sobrecarga `seedSelector`. A sobrecarga `seed` entrega a **mesma** instância para todas as chaves:

```csharp
// .NET 11 RC 1, C# 15
var orders = new[] { new Order("alice", 1), new Order("bob", 2), new Order("alice", 3) };

var broken = orders.AggregateBy(o => o.Customer, seed: new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,2,3   bob: 1,2,3   <- one shared List

var correct = orders.AggregateBy(o => o.Customer, seedSelector: _ => new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,3     bob: 2
```

`AggregateBy` e seu irmão `CountBy` são ótimos quando você quer um único agregado por chave; eu cobri o caso de contagem em [contagem de frequência com LINQ CountBy](/pt-br/2026/01/optimizing-frequency-counting-with-linq-countby/). Para "todos os valores por chave", eles são a ferramenta errada.

## O benchmark

O BenchmarkDotNet 0.15.8 ainda não consegue resolver o moniker `net11.0` (ele lança `NotImplementedException` a partir de `GetRuntimeVersion`), então estes testes rodaram com `--inProcess` no .NET 11 RC 1, Arm64 RyuJIT, em um Apple M4 (10 núcleos, 16 GB) no macOS 26.6. A fonte são 100,000 records `Order` indexados por um `CustomerId` do tipo `int`, com 100 ou 10,000 chaves distintas. O benchmark de leitura sonda 1,000 chaves aleatórias, 10% das quais estão ausentes, e soma um campo `decimal` em cada grupo.

Montando o agrupamento a partir de 100,000 pedidos:

| Método (.NET 11 RC 1)                          | Chaves | Média    | Razão | Alocado   |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `ToLookup`                                     | 100    | 660.1 us | 1.00  | 1.91 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 100    | 883.0 us | 1.34  | 2.69 MB   |
| Loop `TryGetValue` + `Add`                     | 100    | 476.7 us | 0.72  | 1.91 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 100    | 485.8 us | 0.74  | 1.91 MB   |
| `ToLookup`                                     | 10,000 | 5,934 us | 1.00  | 3.86 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 10,000 | 7,537 us | 1.27  | 6.06 MB   |
| Loop `TryGetValue` + `Add`                     | 10,000 | 4,070 us | 0.69  | 3.59 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 10,000 | 4,384 us | 0.74  | 3.59 MB   |

Lendo 1,000 chaves aleatórias e somando cada grupo:

| Método (.NET 11 RC 1)                          | Chaves | Média    | Razão | Alocado   |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `foreach (var o in lookup[k])`                 | 100    | 3,736 us | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` sobre `List<T>`      | 100    | 3,617 us | 0.97  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 100    | 3,299 us | 0.88  | 0 B       |
| `foreach (var o in lookup[k])`                 | 10,000 | 66.1 us  | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` sobre `List<T>`      | 10,000 | 61.0 us  | 0.92  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 10,000 | 57.8 us  | 0.87  | 0 B       |

Algumas coisas se destacam.

**O lookup é cerca de 1.4x mais lento para montar do que um loop simples, com alocações idênticas.** Ambos terminam com 1.91 MB em 100 chaves, então a diferença é trabalho por item, não memória. `ToLookup` invoca o delegate `keySelector` e chama `IEqualityComparer<TKey>.GetHashCode` e `Equals` pela interface para cada item. `Dictionary<TKey, TValue>` trata de forma especial chaves de tipo de valor sem comparador personalizado e chama `EqualityComparer<TKey>.Default` diretamente, que o JIT desvirtualiza e faz inline. Com chaves `string` essa vantagem diminui, porque o dicionário também passa por um objeto comparador.

**`GroupBy(...).ToDictionary(...)` é o pior dos dois mundos.** Ele monta o mesmo lookup interno que `ToLookup` monta e depois copia cada grupo para um `List<T>` novo: 27-34% mais lento que `ToLookup` e até 57% mais memória. Se você quer um dicionário, escreva o loop.

**`CollectionsMarshal` não superou `TryGetValue` aqui.** O hash duplo só acontece quando uma chave aparece pela primeira vez, o que ocorre 100 ou 10,000 vezes em 100,000 itens. A versão de sondagem única compensa quando a maioria dos itens introduz uma chave nova, e ela nunca é mais lenta de um jeito que importe, então continua sendo meu padrão para o loop.

**Toda leitura de lookup aloca.** O indexador retorna `IEnumerable<TElement>`, e `Grouping.GetEnumerator` devolve um `PartialArrayEnumerator<TElement>` alocado no heap: 29,344 bytes para aproximadamente 917 acertos, 32 bytes cada. `List<T>` tem um enumerador struct que o `foreach` usa sem boxing, e `CollectionsMarshal.AsSpan` elimina o enumerador por completo, ganhando mais 5-9%. Em 100 chaves a leitura é dominada pela soma de cerca de 1,000 valores `decimal` por grupo, e é por isso que as razões convergem.

A conclusão honesta é que nenhum desses números deveria escolher o tipo por você. Se um agrupamento está em um caminho quente o bastante para que uma diferença de 10% na leitura e 32 bytes por sondagem importem, provavelmente você será mais bem servido por um [`FrozenDictionary`](/pt-br/2024/04/net-8-performance-dictionary-vs-frozendictionary/) montado uma vez sobre arrays, ou iterando spans em vez de `IEnumerable<T>`, que é o mesmo trade-off que analisei em [List vs Span vs ReadOnlySpan](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Armadilhas que decidem por você

**Você não consegue expor um `Dictionary<TKey, List<TValue>>` como um multimap somente leitura de graça.** `IReadOnlyDictionary<TKey, TValue>` é invariante em `TValue`, então isto não compila:

```csharp
// .NET 11 RC 1, C# 15
Dictionary<string, List<int>> map = new() { ["a"] = [1] };
IReadOnlyDictionary<string, IReadOnlyList<int>> ro = map;
// error CS0266: Cannot implicitly convert type 'Dictionary<string, List<int>>'
// to 'IReadOnlyDictionary<string, IReadOnlyList<int>>'
```

O cast explícito que o compilador sugere lança `InvalidCastException` em tempo de execução. Suas opções são declarar o dicionário como `Dictionary<string, IReadOnlyList<int>>` desde o início (e perder o `Add` nos valores sem um cast), copiá-lo ou retornar um `ILookup`, que é somente leitura por construção. Se "quem chama não pode modificar isto" é um requisito, isso por si só já é um bom motivo para escolher o lookup.

**`ILookup` não sobrevive ao JSON.** `System.Text.Json` o serializa como um `IEnumerable<IGrouping<...>>`, então você obtém `[[{...},{...}],[{...}]]` sem as chaves, e desserializar para `ILookup<TKey, TElement>` lança `NotSupportedException` porque a interface não pode ser instanciada. Um `Dictionary<string, List<T>>` é serializado como `{"alice":[...],"bob":[...]}` e faz o caminho de ida e volta. Para respostas de API e payloads em cache, converta com `lookup.ToDictionary(g => g.Key, g => g.ToList())` na fronteira, ou monte o dicionário desde o início.

**Não existe `TryGetValue` em `ILookup`.** `if (lookup.Contains(k)) use(lookup[k]);` calcula o hash da chave duas vezes. Como uma chave ausente já retorna uma sequência vazia, basta chamar o indexador e deixar o caso vazio seguir adiante. Só use `Contains` quando "sem valores" e "chave ausente" precisarem ser tratados de forma diferente, o que com um lookup nunca acontece (uma chave não pode existir com zero elementos).

**O comparador é fixado na construção.** Os dois tipos aceitam um `IEqualityComparer<TKey>`. Para chaves string, passe `StringComparer.OrdinalIgnoreCase` para `ToLookup` ou para o construtor do dicionário; você não pode alterá-lo depois em nenhum dos dois tipos.

**A ordem de enumeração do Dictionary é um detalhe de implementação.** Um `Dictionary` que só recebeu adições acaba enumerando na ordem de inserção, mas a documentação diz que a ordem é indefinida, e um único `Remove` seguido de um `Add` reutiliza o slot liberado: no .NET 11 RC 1, as chaves `a, b, c` seguidas de `Remove("a")` e `Add("d")` são enumeradas como `d, b, c`. Se você renderiza os grupos na ordem em que apareceram pela primeira vez, o lookup lhe dá essa garantia estruturalmente.

**Nenhum dos dois tipos é thread-safe para escritores.** Lookups são imutáveis, então leituras concorrentes não têm problema. Um dicionário de listas precisa de um lock em volta tanto do dicionário quanto de cada lista, e `ConcurrentDictionary<TKey, List<T>>` não resolve, porque as listas internas continuam sendo `List<T>` comuns. Se você precisa de anexações concorrentes, use `ConcurrentDictionary<TKey, ConcurrentQueue<T>>` ou uma coleção imutável trocada atomicamente.

**Não existe `MultiValueDictionary` pronto na caixa.** A Microsoft prototipou um em `Microsoft.Experimental.Collections` em 2014, mas ele nunca foi incorporado ao runtime e o repositório corefxlab está arquivado. Para um multimap mutável, o dicionário de listas continua sendo a resposta padrão.

## Qual escolher

Use `ToLookup` como padrão sempre que o agrupamento for um índice somente leitura sobre dados que você já tem: juntar dois conjuntos em memória, separar linhas em buckets para um relatório, pré-calcular filhos por pai para uma árvore. É mais curto, não pode ser modificado pelas suas costas, e o comportamento com chave ausente e chave null elimina toda uma classe de código defensivo. Mude para `Dictionary<TKey, List<TValue>>`, montado com `CollectionsMarshal.GetValueRefOrAddDefault`, quando os grupos mudam ao longo da vida do objeto, quando você serializa o resultado ou quando está escrevendo aquele único loop quente em que mediu que a diferença de leitura importa. Se você está dividido entre expor `IEnumerable<T>` ou algo mais rico no método que retorna esses grupos, vale o mesmo raciocínio de [IEnumerable vs IAsyncEnumerable vs IQueryable](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/): retorne o tipo mais restrito que mantém quem chama honesto, que para um agrupamento finalizado é `ILookup`.

### Relacionados

- [Como saber se um IEnumerable já foi materializado em C#](/pt-br/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [Otimizando a contagem de frequência com LINQ CountBy](/pt-br/2026/01/optimizing-frequency-counting-with-linq-countby/)
- [Dictionary vs FrozenDictionary no .NET 8](/pt-br/2024/04/net-8-performance-dictionary-vs-frozendictionary/)
- [List vs Span vs ReadOnlySpan em C#](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable em C#](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

### Fontes

- [Classe `Lookup<TKey, TElement>`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.lookup-2), MS Learn
- [`Enumerable.ToLookup`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.tolookup), MS Learn
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), MS Learn
- [`Enumerable.AggregateBy`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.aggregateby), MS Learn
- [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) e [`Grouping.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Grouping.cs) na tag `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [MultiDictionary becomes MultiValueDictionary](https://devblogs.microsoft.com/dotnet/multidictionary-becomes-multivaluedictionary/), .NET Blog
- [Release the Microsoft.Experimental.Collections.MultiValueDictionary](https://github.com/dotnet/runtime/issues/14406), issue do dotnet/runtime
