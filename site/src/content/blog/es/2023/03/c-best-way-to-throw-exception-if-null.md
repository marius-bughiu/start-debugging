---
title: "C# lanzar excepción si es null: ArgumentNullException.ThrowIfNull (.NET 6+)"
description: "Usa ArgumentNullException.ThrowIfNull en .NET 6+ para comprobaciones de null concisas, o utiliza expresiones throw en C# 7+ para frameworks anteriores."
pubDate: 2023-03-11
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/03/c-best-way-to-throw-exception-if-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 6 introdujo varios métodos auxiliares nuevos para lanzar excepciones, y uno de ellos es **ThrowIfNull**. Su uso es sencillo:

```cs
ArgumentNullException.ThrowIfNull(myParam);
```

El método lanzará una **ArgumentNullException** cuando **myParam** sea **null**. En caso contrario, no hará nada.

ThrowIfNull puede recibir dos parámetros:

-   **object? argument** -- el objeto de tipo referencia que se va a comprobar si es null
-   Opcional: **string? paramName** -- el nombre del parámetro que se está comprobando.

**Nota:** paramName utiliza **CallerArgumentExpressionAttribute** para obtener automáticamente el nombre de tu parámetro, por lo que en la mayoría de los escenarios no tendrás que indicarlo, ya que el framework podrá determinar correctamente el nombre del argumento por sí mismo.

## Expresiones throw

Si todavía no estás en .NET 6 o superior, pero puedes usar C# 7+, puedes utilizar expresiones throw para hacer tu código más legible:

```cs
var myVar = myParam ?? throw new ArgumentNullException(nameof(myParam), "Parameter is required.");
```

Como alternativa, puedes optar por definir tu propia implementación de ThrowIfNull, así:

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
