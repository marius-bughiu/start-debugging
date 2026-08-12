---
title: "C# 15 suma break y continue con etiqueta en .NET 11 Preview 7"
description: "break y continue con etiqueta llegaron en la sección de C# de .NET 11 Preview 7. Ahora puedes poner una etiqueta en un bucle y saltar directo a él, lo que jubila los trucos con banderas booleanas y goto para bucles anidados."
pubDate: 2026-08-12
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "language-features"
lang: "es"
translationOf: "2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-12
---

.NET 11 Preview 7 salió el 2026-08-11, y la sección de C# trae una característica que la comunidad venía pidiendo desde hace muchísimo: `break` y `continue` ya pueden nombrar una etiqueta de un bucle o `switch` que los contenga. La propuesta apadrinada es [dotnet/csharplang#9875](https://github.com/dotnet/csharplang/issues/9875), y la lista de discusiones adjunta enlaza nueve hilos distintos de la comunidad que se remontan años atrás.

## Cómo se ve la sintaxis

La etiqueta va directamente sobre el bucle, y la instrucción de salto la nombra:

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

Una sola etiqueta sirve para ambos saltos. Sin etiqueta, `break` y `continue` se comportan exactamente igual que antes y apuntan a la instrucción aplicable más interna, así que esto es puramente aditivo.

## Los dos trucos que reemplaza

La versión con bandera booleana necesita estado que existe solo para propagar la salida hacia afuera, y hay que comprobarlo en cada nivel:

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

La versión con `goto` es peor para el caso de continue, porque la etiqueta tiene que quedar al final del cuerpo del bucle para que el incremento y la condición sigan ejecutándose:

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

Eso es frágil. Cualquier instrucción insertada por accidente entre la etiqueta y la llave de cierre cambia en silencio lo que hace el salto. Atar la etiqueta a la construcción del bucle elimina ese modo de fallo.

## Dos reglas que conviene conocer antes de refactorizar

Solo la instrucción **inmediatamente** anidada dentro de una instrucción etiquetada recibe la etiqueta. Dado `a: b: while (...) ...`, solo `b` etiqueta el bucle. `a` etiqueta la instrucción etiquetada interna, que en sí misma no es un bucle, así que `break a;` dentro de ese cuerpo es un error de compilación en lugar de un salto al `while`. La especificación rechaza explícitamente las etiquetas anidadas.

Además, `break` puede apuntar a un `switch` contenedor, pero `continue` no. `continue` siempre se resuelve a una instrucción de iteración, lo cual se deduce del significado de cada salto.

## El analizador que encuentra tus casos existentes

No tienes que buscar a mano el código que califica. [IDE0410](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0410) ("Use labeled jump statement") marca los tres patrones: un `goto` que salta más allá de un bucle anidado, un `goto` a una etiqueta vacía al final, y la cadena de propagación con bandera booleana. Está activo por defecto vía `csharp_style_prefer_labeled_jump_statements = true`, y aplica a C# 15 en adelante. Desactívalo por proyecto con:

```ini
[*.cs]
dotnet_diagnostic.IDE0410.severity = none
```

Necesitas el SDK preliminar de .NET 11 para probarlo, igual que con los [indexadores de extensión que llegaron en Preview 6](/es/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/). Todos los detalles están en la [especificación de la característica](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/labeled-break-continue) y en el [anuncio de Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/).
