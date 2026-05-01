---
title: "C# 12 - Valores por defecto para parámetros en expresiones lambda"
description: "C# 12 te permite especificar valores por defecto para los parámetros y arrays params en expresiones lambda, igual que en métodos y funciones locales."
pubDate: 2023-05-09
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/05/c-12-default-values-for-parameters-in-lambda-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de la versión 12 de C#, puedes especificar valores por defecto para los parámetros en expresiones lambda. La sintaxis y las restricciones sobre los valores por defecto de los parámetros son las mismas que para los métodos y las funciones locales.

Veamos un ejemplo:

```cs
var incrementBy = (int source, int increment = 1) => source + increment;
```

Esta lambda ahora se puede consumir así:

```cs
Console.WriteLine(incrementBy(3)); 
Console.WriteLine(incrementBy(3, 2));
```

## Array params en expresiones lambda

También puedes declarar expresiones lambda con un array **params** como parámetro:

```cs
var sum = (params int[] values) =>
{
    int sum = 0;
    foreach (var value in values) 
    {
        sum += value;
    }

    return sum;
};
```

Y consumirlas como cualquier otra función:

```cs
var empty = sum();
Console.WriteLine(empty); // 0

var sequence = new[] { 1, 2, 3, 4, 5 };
var total = sum(sequence);

Console.WriteLine(total); // 15
```

## Error CS8652

> The feature 'lambda optional parameters' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Tu proyecto necesita tener como target .NET 8 y C# 12 o más reciente para usar la característica de parámetros opcionales en lambdas. Si no estás seguro de cómo cambiar a C# 12, consulta este artículo: [Cómo cambiar a C# 12](/es/2023/06/how-to-switch-to-c-12/).
