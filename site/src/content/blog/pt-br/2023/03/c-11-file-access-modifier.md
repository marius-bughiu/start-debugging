---
title: "C# 11 - modificador de acesso file e tipos com escopo de arquivo"
description: "Aprenda como o modificador file do C# 11 restringe o escopo de um tipo ao arquivo em que é declarado, ajudando a evitar colisões de nomes com source generators."
pubDate: 2023-03-18
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/03/c-11-file-access-modifier"
translatedBy: "claude"
translationDate: 2026-05-01
---
O modificador **file** restringe o escopo e a visibilidade de um tipo ao arquivo em que ele é declarado. Isso é especialmente útil quando você quer evitar colisões de nomes entre tipos, como no caso de tipos gerados por source generators.

Um exemplo rápido:

```cs
file class MyLocalType { }
```

Em termos de restrições, temos o seguinte:

-   tipos aninhados dentro de um tipo com escopo de arquivo só serão visíveis no arquivo em que foram declarados
-   outros tipos no assembly podem usar o mesmo nome totalmente qualificado do tipo com escopo de arquivo sem criar uma colisão de nomes
-   tipos locais ao arquivo não podem ser usados como tipo de retorno ou parâmetro de qualquer membro com visibilidade maior que o escopo `file`
-   de forma semelhante, um tipo com escopo de arquivo não pode ser membro de campo de um tipo com visibilidade maior que o escopo `file`

Por outro lado:

-   Um tipo com maior visibilidade pode implementar implicitamente uma interface com escopo de arquivo
-   Um tipo com maior visibilidade também pode implementar explicitamente uma interface com escopo de arquivo, desde que as implementações explícitas só sejam usadas dentro do escopo do arquivo

## Implementando implicitamente uma interface com escopo de arquivo

Uma classe pública pode implementar uma interface com escopo de arquivo desde que ambas estejam definidas no mesmo arquivo. No exemplo abaixo, você tem a interface com escopo de arquivo `ICalculator` implementada pela classe pública `Calculator`.

```cs
file interface ICalculator
{
    int Sum(int x, int y);
}

public class Calculator : ICalculator
{
    public int Sum(int x, int y) => x + y;
}
```
