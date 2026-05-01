---
title: "C# 11 - modificador de acceso file y tipos con ámbito de archivo"
description: "Aprende cómo el modificador file de C# 11 restringe el ámbito de un tipo al archivo en el que se declara, ayudando a evitar colisiones de nombres con los source generators."
pubDate: 2023-03-18
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/03/c-11-file-access-modifier"
translatedBy: "claude"
translationDate: 2026-05-01
---
El modificador **file** restringe el ámbito y la visibilidad de un tipo al archivo en el que se declara. Esto es especialmente útil en situaciones donde quieres evitar colisiones de nombres entre tipos, como en el caso de los tipos generados por los source generators.

Un ejemplo rápido:

```cs
file class MyLocalType { }
```

En cuanto a restricciones, tenemos lo siguiente:

-   los tipos anidados dentro de un tipo con ámbito de archivo solo serán visibles dentro del archivo en el que se declaran
-   otros tipos del ensamblado pueden usar el mismo nombre totalmente cualificado que el tipo con ámbito de archivo sin crear una colisión de nombres
-   los tipos locales al archivo no pueden usarse como tipo de retorno o parámetro de ningún miembro que tenga mayor visibilidad que el ámbito `file`
-   de forma similar, un tipo con ámbito de archivo no puede ser un campo miembro de un tipo que tenga mayor visibilidad que el ámbito `file`

Por otro lado:

-   Un tipo con mayor visibilidad puede implementar implícitamente una interfaz con ámbito de archivo
-   Un tipo con mayor visibilidad también puede implementar explícitamente una interfaz con ámbito de archivo, con la condición de que las implementaciones explícitas solo pueden usarse dentro del ámbito del archivo

## Implementar implícitamente una interfaz con ámbito de archivo

Una clase pública puede implementar una interfaz con ámbito de archivo siempre que se definan en el mismo archivo. En el ejemplo siguiente tienes la interfaz con ámbito de archivo `ICalculator`, implementada por una clase pública `Calculator`.

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
