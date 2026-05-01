---
title: "C# lançar exceção se for null: ArgumentNullException.ThrowIfNull (.NET 6+)"
description: "Use ArgumentNullException.ThrowIfNull no .NET 6+ para checagens concisas de null, ou use expressões throw no C# 7+ para frameworks mais antigos."
pubDate: 2023-03-11
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/03/c-best-way-to-throw-exception-if-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 6 introduziu alguns novos métodos auxiliares para lançar exceções, e um deles é **ThrowIfNull**. O uso é simples:

```cs
ArgumentNullException.ThrowIfNull(myParam);
```

O método lançará uma **ArgumentNullException** quando **myParam** for **null**. Caso contrário, não fará nada.

ThrowIfNull pode receber dois parâmetros:

-   **object? argument** -- o objeto de tipo referência que precisa ser checado se é null
-   Opcional: **string? paramName** -- o nome do parâmetro que está sendo checado.

**Observação:** paramName usa **CallerArgumentExpressionAttribute** para recuperar o nome do seu parâmetro automaticamente, então na maioria dos cenários você não precisará informá-lo, pois o framework conseguirá determinar corretamente o nome do argumento sozinho.

## Expressões throw

Se você ainda não está no .NET 6 ou superior, mas pode usar o C# 7+, então você pode usar expressões throw para deixar seu código mais legível:

```cs
var myVar = myParam ?? throw new ArgumentNullException(nameof(myParam), "Parameter is required.");
```

Outra opção é definir sua própria implementação de ThrowIfNull, assim:

```cs
/// <summary>Throws an <see cref="ArgumentNullException"/> if <paramref name="argument"/> is null.</summary>
/// <param name="argument">The reference type argument to validate as non-null.</param>
/// <param name="paramName">The name of the parameter with which <paramref name="argument"/> corresponds.</param>
public static void ThrowIfNull([NotNull] object? argument, [CallerArgumentExpression("argument")] string? paramName = null)
{
    if (argument is null)
    {
        throw new ArgumentNullException(paramName);
    }
}
```
