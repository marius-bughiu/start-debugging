---
title: "Cómo cambiar a C# 12"
description: "Resuelve los errores de versión de lenguaje C# 12 actualizando tu target framework a .NET 8 o configurando LangVersion en tu archivo .csproj."
pubDate: 2023-06-10
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/06/how-to-switch-to-c-12"
translatedBy: "claude"
translationDate: 2026-05-01
---
Al probar funciones de C# 12, es posible que te encuentres con errores parecidos a estos:

> Feature is not available in C# 11.0. Please use language version 12.0 or later.

o

> Error CS8652: The feature '<feature name>' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Hay dos formas de resolver este error:

-   cambia el target framework de tu proyecto a .NET 8 o superior. La versión del lenguaje debería actualizarse automáticamente.
-   edita tu archivo **.csproj** y especifica el **<LangVersion>** deseado, como en el ejemplo siguiente:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## La versión del lenguaje aparece en gris y no se puede modificar

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

La versión del lenguaje no se puede cambiar desde la ventana de **Propiedades** del proyecto. La versión está ligada a la versión del target .NET framework de tu proyecto y se actualizará en consecuencia según esta.

Si necesitas sobrescribir la versión del lenguaje, debes hacerlo como se indica arriba: modificando el archivo **.csproj** y especificando **LangVersion**.

Recuerda que cada versión del lenguaje C# tiene una versión mínima de .NET soportada. C# 12 solo se admite en .NET 8 y versiones más nuevas. C# 11 solo se admite en .NET 7 y versiones más nuevas. C# 10 solo se admite en .NET 6 y versiones más nuevas. Y así sucesivamente.

## Opciones de LangVersion en C#

Además de los números de versión, existen ciertas palabras clave que se pueden usar para especificar la versión del lenguaje de tu proyecto:

-   **preview** -- se refiere a la última versión preliminar
-   **latest** -- la última versión publicada (incluyendo la versión menor)
-   **latestMajor** o **default** -- la última versión mayor publicada
