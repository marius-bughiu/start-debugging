---
title: "C# 12 expressões de coleção"
description: "O C# 12 traz uma nova sintaxe simplificada para criar arrays. Fica assim: É importante notar que o tipo do array precisa ser especificado explicitamente, então você não pode usar var para declarar a variável. De forma parecida, se você quiser criar um Span<int>: Arrays multidimensionais As vantagens dessa sintaxe enxuta..."
pubDate: 2023-08-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/08/c-12-collection-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
O C# 12 traz uma nova sintaxe simplificada para criar arrays. Fica assim:

```cs
int[] foo = [1, 2, 3];
```

É importante notar que o tipo do array precisa ser especificado explicitamente, então você não pode usar `var` para declarar a variável.

De forma parecida, se você quiser criar um `Span<int>`:

```cs
Span<int> bar = [1, 2, 3];
```

## Arrays multidimensionais

As vantagens dessa sintaxe enxuta ficam ainda mais evidentes na definição de arrays multidimensionais. Vamos a um array de duas dimensões. Sem a nova sintaxe seria:

```cs
int[][] _2d = new int[][] { new int[] { 1, 2, 3 }, new int[] { 4, 5, 6 }, new int[] { 7, 8, 9 } };
```

Com a nova sintaxe:

```cs
int[][] _2d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
```

Bem mais simples e intuitivo, não é?

## Mesclando arrays com o operador spread

Com a nova sintaxe vem também um novo operador spread, `..`, que substitui o argumento em que é aplicado pelos elementos dele, permitindo mesclar coleções. Vamos a alguns exemplos.

Começando pelo mais simples, juntar vários arrays em um:

```cs
int[] a1 = [1, 2, 3];
int[] a2 = [4, 5, 6];
int[] a3 = [7, 8, 9];

int[] merged = [..a1, ..a2, ..a3];
```

O operador spread funciona em qualquer `IEnumerable` e pode ser usado para combinar diferentes `IEnumerable` em uma única coleção.

```cs
int[] a1 = [1, 2, 3];
List<int> a2 = [4, 5, 6];
Span<int> a3 = [7, 8, 9];

Collection<int> merged = [..a1, ..a2, ..a3];
```

Também dá para combinar o operador spread com elementos individuais, criando uma nova coleção com itens adicionais em qualquer extremidade de uma coleção existente.

```cs
int[] merged = [1, 2, 3, ..a2, 10, 11, 12];
```

### Error CS9176

> Error CS9176 There is no target type for the collection expression.

Com expressões de coleção não dá para usar `var`. Você precisa especificar explicitamente o tipo da variável. Veja:

```cs
// Wrong - triggers CS9176
var foo = [1, 2, 3];

// Correct
int[] foo = [1, 2, 3];
```

### Error CS0029

> Error CS0029 Cannot implicitly convert type 'int\[\]' to 'System.Index'

Esse erro pode acontecer quando você tenta usar o operador spread com a sintaxe antiga de inicializador de coleção, que não tem suporte. Em vez disso, use a sintaxe simplificada quando for usar o operador spread.

```cs
// Wrong - triggers CS0029
var a = new List<int> { 1, 2, 3, ..a1, 4, 5 };

// Correct
List<int> a = [1, 2, 3, .. a1, 4, 5];
```

### Error CS8652

> Error CS8652 The feature 'collection expressions' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

> Error CS8652 The feature 'collection literals' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Esses erros indicam que o seu projeto ainda não está no C# 12, então você não pode usar os novos recursos da linguagem. Se quiser migrar para o C# 12 e não sabe como, dá uma olhada no [nosso guia para migrar o projeto para C# 12](/2023/06/how-to-switch-to-c-12/).
