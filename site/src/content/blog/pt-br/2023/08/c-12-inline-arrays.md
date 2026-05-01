---
title: "C# 12 Inline arrays"
description: "Inline arrays permitem criar um array de tamanho fixo dentro de uma struct. Uma struct desse tipo, com um buffer inline, deve entregar desempenho comparável a um buffer unsafe de tamanho fixo. Inline arrays são pensados principalmente para o time do runtime e alguns autores de bibliotecas, para melhorar o desempenho em certos cenários. Provavelmente..."
pubDate: 2023-08-31
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/08/c-12-inline-arrays"
translatedBy: "claude"
translationDate: 2026-05-01
---
Inline arrays permitem criar um array de tamanho fixo dentro de um tipo `struct`. Essa struct, com um buffer inline, deve entregar desempenho comparável ao de um buffer unsafe de tamanho fixo.

Inline arrays são pensados principalmente para o time do runtime e para alguns autores de bibliotecas, com o objetivo de melhorar o desempenho em certos cenários. Provavelmente você não vai declarar seus próprios inline arrays, mas vai usá-los de forma transparente quando o runtime os expuser como `Span<T>` ou `ReadOnlySpan<T>`.

## Como declarar um inline array

Você declara um inline array criando uma struct e decorando-a com o atributo `InlineArray`, que recebe o tamanho do array como parâmetro do construtor.

```cs
[System.Runtime.CompilerServices.InlineArray(10)]
public struct MyInlineArray
{
    private int _element;
}
```

Observação: o nome do membro privado é irrelevante. Você pode usar `private int _abracadabra`; se quiser. O que importa é o tipo, pois ele determina o tipo do array.

## Uso de InlineArray

Você usa um inline array de forma parecida com qualquer outro array, mas com algumas pequenas diferenças. Vamos a um exemplo:

```cs
var arr = new MyInlineArray();

for (int i = 0; i < 10; i++)
{
    arr[i] = i;
}

foreach (var item in arr)
{
    Console.WriteLine(item);
}
```

A primeira coisa a notar: na inicialização não especificamos o tamanho. Inline arrays têm tamanho fixo e o comprimento é definido pelo atributo `InlineArray` aplicado à `struct`. Tirando isso, parece um array normal, mas tem mais detalhes.

### InlineArray não tem propriedade Length

Alguns devem ter notado que no `for` acima iteramos até `10` em vez de até `arr.Length`. Isso porque inline arrays não expõem uma propriedade `Length` como os arrays normais.

E fica mais estranho...

### InlineArray não implementa IEnumerable

Como consequência, não dá para chamar `GetEnumerator` em um inline array. O principal prejuízo é que você não consegue usar LINQ com inline arrays, pelo menos por enquanto. Isso pode mudar no futuro.

Apesar de não implementar `IEnumerable`, ainda dá para usar dentro de um `foreach`.

```cs
foreach (var item in arr) { }
```

De forma parecida, também é possível usar o operador spread em combinação com inline arrays.

```cs
int[] m = [1, 2, 3, ..arr];
```
