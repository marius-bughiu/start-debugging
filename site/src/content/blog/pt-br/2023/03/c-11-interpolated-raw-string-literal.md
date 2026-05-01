---
title: "C# 11 - Literais raw string interpolados"
description: "Aprenda a usar literais raw string interpolados no C# 11, incluindo escape de chaves, vários caracteres $ e operadores condicionais."
pubDate: 2023-03-17
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/03/c-11-interpolated-raw-string-literal"
translatedBy: "claude"
translationDate: 2026-05-01
---
O C# 11 introduz no idioma o conceito de [literais raw string](/2023/03/c-raw-string-literals/) e, com isso, chega também um conjunto de novos recursos para interpolação de strings.

Antes de mais nada, você pode continuar usando a sintaxe de interpolação que já conhece em conjunto com literais raw string, assim:

```cs
var x = 5, y = 4;
var interpolatedRaw = $"""The sum of "{x}" and "{y}" is "{ x + y }".""";
```

A saída será:

```plaintext
The sum of "5" and "4" is "9".
```

## Escape de chaves { e }

Você pode escapar chaves duplicando-as. Se pegarmos o exemplo acima e duplicarmos as chaves:

```cs
var interpolatedRaw= $"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
```

A saída será:

```plaintext
The sum of "{x}" and "{y}" is "{ x + y }".
```

Como você pode ver, as chaves não desempenham mais o papel de interpolação, e cada par de chaves duplas resulta em uma única chave na saída.

## Vários caracteres $ em literais raw string interpolados

Você pode usar vários caracteres **$** em um literal raw string interpolado de forma semelhante à sequência **"""**. A quantidade de caracteres $ que você usa no início da string determina quantos { e } são necessários para a interpolação.

Por exemplo, as duas strings abaixo produzirão exatamente o mesmo resultado do exemplo inicial:

```cs
var interpolatedRaw2 = $$"""The sum of "{{x}}" and "{{y}}" is "{{ x + y }}".""";
var interpolatedRaw3 = $$$"""The sum of "{{{x}}}" and "{{{y}}}" is "{{{ x + y }}}".""";
```

## Operador condicional em string interpolada

Os dois pontos (:) têm significado especial em strings interpoladas e, por isso, expressões condicionais precisam de um par adicional de parênteses ( ) para funcionar. Por exemplo:

```cs
var conditionalInterpolated = $"I am {x} year{(x == 1 ? "" : "s")} old.";
```

## Erros

> Error CS9006 The interpolated raw string literal does not start with enough '$' characters to allow this many consecutive opening braces as content.

Esse erro do compilador ocorre quando sua string contém uma sequência de chaves igual ou maior que o dobro do comprimento da sequência de caracteres $ encontrada no início da string.
