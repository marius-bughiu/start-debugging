---
title: "SQLite-net No parameterless constructor defined for this object no ExecuteQuery"
description: "Como corrigir o erro 'no parameterless constructor defined' no SQLite-net ao usar ExecuteQuery com tipos primitivos como string ou int."
pubDate: 2023-09-01
updatedDate: 2023-11-05
tags:
  - "sqlite"
lang: "pt-br"
translationOf: "2023/09/sqllitenet-no-parameterless-constructor-defined-for-this-object-on-executequery"
translatedBy: "claude"
translationDate: 2026-05-01
---
Provavelmente você está tentando recuperar uma única coluna de uma tabela do seu banco de dados passando algo como `SELECT <column_name> FROM <table_name>` para `ExecuteQuery<string>` ou `ExecuteQuery<int>`.

O problema é que `ExecuteQuery<string>` espera um tipo com construtor sem parâmetros, e `string` não se encaixa nesse critério.

Existem duas soluções possíveis:

## Solução 1: use o tipo da tabela

Mantenha sua consulta SQL como está, selecionando uma única coluna, mas, ao chamar `ExecuteQuery`, informe o tipo associado à sua tabela. Não se preocupe muito com o desempenho da consulta nesse caso: apenas aquela coluna específica é trazida e preenchida nos seus objetos; o resto das propriedades é ignorado.

Depois, você usa LINQ para selecionar sua `string`.

```cs
cmd.ExecuteQuery<MyTableType>().Select(t => t.MyColumnName).ToArray();
```

## Solução 2: use um DTO específico para a consulta

Se você não gosta de usar o tipo da tabela, sempre pode definir um DTO próprio para essa consulta e usá-lo. Lembre que ele precisa ter um construtor público sem parâmetros.

```cs
public class MyQueryDto
{
    public string MyColumnName { get; set; }
}
```

Em seguida, passe-o para o método `ExecuteQuery` e, opcionalmente, selecione sua coluna em um array de strings depois.

```cs
cmd.ExecuteQuery<MyQueryDto>().Select(t => t.MyColumnName).ToArray();
```
