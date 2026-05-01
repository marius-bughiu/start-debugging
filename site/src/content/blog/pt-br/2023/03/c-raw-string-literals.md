---
title: "Literais raw string no C# 11 (sintaxe de aspas triplas)"
description: "Use os literais raw string do C# 11 (sintaxe de aspas triplas `\"\"\"`) para incorporar espaços em branco, quebras de linha e aspas sem sequências de escape. Regras e exemplos."
pubDate: 2023-03-15
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/03/c-raw-string-literals"
translatedBy: "claude"
translationDate: 2026-05-01
---
Os literais raw string são um novo formato que permite incluir espaços em branco, quebras de linha, aspas embutidas e outros caracteres especiais na sua string, sem precisar de sequências de escape.

Como funciona:

-   um literal raw string começa com três ou mais caracteres de aspas duplas (**"""**). Você decide quantas aspas duplas usar para envolver o literal.
-   ele termina com a mesma quantidade de aspas duplas que você usou no início
-   literais raw string multilinhas exigem que as sequências de abertura e fechamento estejam em linhas separadas. As quebras de linha após as aspas de abertura e antes das aspas de fechamento não são incluídas no conteúdo final.
-   qualquer espaço em branco à esquerda das aspas duplas de fechamento será removido do literal de string (de todas as linhas; falamos disso em mais detalhes logo abaixo)
-   as linhas precisam começar com a mesma quantidade de espaços em branco (ou mais) que a sequência de fechamento
-   em literais raw multilinhas, espaços em branco que vêm depois da sequência de abertura, na mesma linha, são ignorados

Um exemplo rápido:

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
    """;
```

A saída será a seguinte:

```plaintext
Lorem ipsum "dolor" sit amet,
    consectetur adipiscing elit.
```

## Espaços em branco antes da sequência de fechamento

Os espaços em branco antes das aspas duplas de fechamento controlam quais espaços são removidos da sua expressão raw string. No exemplo acima, havia 4 espaços em branco antes da sequência **"""**, portanto quatro espaços foram removidos de cada linha da expressão. Se houvesse apenas 2 espaços em branco antes da sequência final, somente 2 espaços teriam sido removidos de cada linha do raw string.

### Exemplo: sem espaços em branco antes da sequência final

No exemplo anterior, se não especificássemos nenhum espaço antes da sequência de fechamento, a string resultante manteria a indentação exatamente como estava.

**Expressão:**

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
""";
```

**Saída:**

```plaintext
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
```

## Usar mais de 3 aspas duplas na sequência de abertura / fechamento

Isso é útil quando você tem uma sequência de 3 aspas duplas dentro do próprio raw string. No exemplo abaixo usamos uma sequência de 5 aspas duplas para começar e terminar o literal raw string, então conseguimos incluir no conteúdo sequências de 3 e 4 aspas duplas.

```cs
string rawString = """""
    3 double-quotes: """
    4 double-quotes: """"
    """"";
```

**Saída:**

```plaintext
3 double-quotes: """
4 double-quotes: """"
```

## Erros associados

> CS8997: Unterminated raw string literal.

```cs
string rawString = """Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit. 
    """;
```

> CS9000: Raw string literal delimiter must be on its own line.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.""";
```

> CS8999: Line does not start with the same whitespace as the closing line of the raw string literal.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
consectetur adipiscing elit.
    """;
```
