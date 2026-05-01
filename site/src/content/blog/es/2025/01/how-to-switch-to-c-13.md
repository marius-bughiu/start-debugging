---
title: "Cómo cambiar a C# 13"
description: "Cómo arreglar 'Feature is not available in C# 12.0' y cambiar tu proyecto a C# 13 modificando el target framework o configurando LangVersion en tu archivo .csproj."
pubDate: 2025-01-01
updatedDate: 2025-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "es"
translationOf: "2025/01/how-to-switch-to-c-13"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mientras pruebas las características de C# 13, es posible que te encuentres con errores similares a estos:

> Feature is not available in C# 12.0. Please use language version 13.0 or later.

o

> Error CS8652: The feature ‘<feature name>’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

Hay dos formas de resolver este error:

-   cambia el target framework de tu proyecto a .NET 9 o superior. La versión del lenguaje debería actualizarse automáticamente.
-   edita tu archivo **.csproj** y especifica el **<LangVersion>** deseado como en el ejemplo de abajo:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## La versión del lenguaje aparece atenuada y no se puede modificar

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

La versión del lenguaje no se puede cambiar desde la ventana **Properties** del proyecto. La versión está vinculada a la versión del target .NET framework de tu proyecto y se actualizará en consecuencia según ese.

Si debes anular la versión del lenguaje, tienes que hacerlo como se especificó arriba, modificando el archivo **.csproj** y especificando el **LangVersion**.

Recuerda que cada versión del lenguaje C# tiene una versión mínima soportada de .NET. C# 13 solo está soportado en .NET 9 y versiones más nuevas. C# 12 solo está soportado en .NET 8 y versiones más nuevas.

## Opciones de LangVersion de C#

Además de los números de versión, hay ciertas palabras clave que pueden usarse para especificar la versión del lenguaje de tu proyecto:

-   **preview** – se refiere a la última versión preliminar
-   **latest** – la última versión publicada (incluyendo versión menor)
-   **latestMajor** o **default** – la última versión mayor publicada

## ¿No es lo que estás buscando?

Quizás estás buscando cambiar a una versión diferente de C#, en ese caso:

-   [Cómo cambiar a C# 12](/2023/06/how-to-switch-to-c-12/)
-   [Cómo cambiar a C# 11](/2023/03/how-to-switch-to-c-11/)
