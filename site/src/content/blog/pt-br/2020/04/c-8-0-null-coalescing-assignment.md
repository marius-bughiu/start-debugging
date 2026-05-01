---
title: "Atribuição de coalescência nula ??= no C# 8.0"
description: "Aprenda como funciona o operador de atribuição de coalescência nula (??=) do C# 8.0, com exemplos práticos como cache e atribuição condicional."
pubDate: 2020-04-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2020/04/c-8-0-null-coalescing-assignment"
translatedBy: "claude"
translationDate: 2026-05-01
---
O operador permite atribuir o valor do operando à direita ao operando à esquerda apenas se o valor do operando da esquerda for avaliado como null.

Vamos a um exemplo bem básico:

```cs
int? i = null;

i ??= 1;
i ??= 2;
```

No exemplo acima, declaramos uma variável `int` anulável `i` e fazemos duas atribuições de coalescência nula sobre ela. Na primeira atribuição, `i` será avaliado como `null`, ou seja, `i` receberá o valor `1`. Na atribuição seguinte, `i` será `1` -- que não é `null` -- então a atribuição será ignorada.

Como esperado, o valor do operando à direita só é avaliado se o operando à esquerda for `null`.

```cs
int? i = null;

i ??= Method1();
i ??= Method2(); // Method2 is never called because i != null
```

## Casos de uso

O operador ajuda a simplificar o código e a deixá-lo mais legível em situações em que você normalmente passaria por várias ramificações `if` até que o valor de uma certa variável fosse definido.

Um exemplo é o cache. No exemplo abaixo, a chamada a `GetUserFromServer` só seria feita quando `user` ainda for null depois de tentar recuperá-lo do cache.

```cs
var user = GetUserFromCache(userId);
user ??= GetUserFromServer(userId);
```
