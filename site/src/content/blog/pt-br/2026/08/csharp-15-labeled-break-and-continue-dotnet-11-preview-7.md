---
title: "C# 15 ganha break e continue com rótulo no .NET 11 Preview 7"
description: "break e continue com rótulo chegaram na seção de C# do .NET 11 Preview 7. Agora você pode colocar um rótulo em um laço e saltar direto para ele, o que aposenta as gambiarras com flag booleana e goto em laços aninhados."
pubDate: 2026-08-12
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "language-features"
lang: "pt-br"
translationOf: "2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-12
---

O .NET 11 Preview 7 saiu em 2026-08-11, e a seção de C# traz um recurso que a comunidade pede há muito tempo: `break` e `continue` agora podem nomear um rótulo em um laço ou `switch` que os contenha. A proposta apadrinhada é a [dotnet/csharplang#9875](https://github.com/dotnet/csharplang/issues/9875), e a lista de discussões anexada a ela liga nove tópicos distintos da comunidade que remontam a anos atrás.

## Como a sintaxe se parece

O rótulo fica diretamente no laço, e a instrução de salto o nomeia:

```csharp
outer: for (int row = 0; row < grid.Height; row++)
{
    for (int column = 0; column < grid.Width; column++)
    {
        if (grid[row, column].IsBlocked)
        {
            continue outer;
        }

        if (grid[row, column].IsGoal)
        {
            break outer;
        }
    }
}
```

Um único rótulo serve para os dois saltos. Sem rótulo, `break` e `continue` se comportam exatamente como antes e miram a instrução aplicável mais interna, então isso é puramente aditivo.

## As duas gambiarras que ele substitui

A versão com flag booleana precisa de estado que existe só para propagar a saída para fora, e ele tem que ser verificado em cada nível:

```csharp
bool found = false;
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (i * j > 20)
        {
            found = true;
            break;
        }
    }

    if (found)
        break;
}
```

A versão com `goto` é pior no caso do continue, porque o rótulo precisa ficar no fim do corpo do laço para que o incremento e a condição ainda rodem:

```csharp
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (j == 5)
            goto next;
    }

    next: ; // The empty statement is required.
}
```

Isso é frágil. Qualquer instrução inserida sem querer entre o rótulo e a chave de fechamento muda silenciosamente o que o salto faz. Amarrar o rótulo à própria construção do laço elimina esse modo de falha.

## Duas regras que vale conhecer antes de refatorar

Somente a instrução **imediatamente** aninhada dentro de uma instrução rotulada recebe o rótulo. Dado `a: b: while (...) ...`, apenas `b` rotula o laço. `a` rotula a instrução rotulada interna, que não é ela própria um laço, então `break a;` dentro daquele corpo é um erro de compilação em vez de um salto para o `while`. A especificação rejeita explicitamente rótulos aninhados.

Além disso, `break` pode mirar um `switch` que o contenha, mas `continue` não. `continue` sempre se resolve para uma instrução de iteração, o que decorre do significado de cada um dos saltos.

## O analisador que encontra seus casos existentes

Você não precisa caçar manualmente o código que se qualifica. O [IDE0410](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0410) ("Use labeled jump statement") sinaliza os três padrões: um `goto` que pula para além de um laço aninhado, um `goto` para um rótulo vazio no fim, e a cadeia de propagação com flag booleana. Ele vem ligado por padrão via `csharp_style_prefer_labeled_jump_statements = true` e vale para C# 15 em diante. Desligue por projeto com:

```ini
[*.cs]
dotnet_diagnostic.IDE0410.severity = none
```

Você precisa do SDK de prévia do .NET 11 para testar, igual aos [indexadores de extensão que chegaram no Preview 6](/pt-br/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/). Os detalhes completos estão na [especificação do recurso](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/labeled-break-continue) e no [anúncio do Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/).
