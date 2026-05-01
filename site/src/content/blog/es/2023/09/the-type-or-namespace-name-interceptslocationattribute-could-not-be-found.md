---
title: "The type or namespace name InterceptsLocationAttribute could not be found"
description: "Cómo arreglar el error CS0246 para InterceptsLocationAttribute en los interceptors de C# definiendo tú mismo el atributo."
pubDate: 2023-09-14
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/the-type-or-namespace-name-interceptslocationattribute-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Si estás empezando con los interceptors, puede que te aparezca uno de los siguientes errores:

> Error CS0246 The type or namespace name 'InterceptsLocationAttribute' could not be found (are you missing a using directive or an assembly reference?)

> Error CS0246 The type or namespace name 'InterceptsLocation' could not be found (are you missing a using directive or an assembly reference?)

La razón es que el atributo aún no está definido en ningún sitio, así que tendrás que definirlo tú. No te preocupes: el compilador detectará correctamente tu atributo y aplicará el comportamiento esperado.

Aquí tienes una definición del atributo `InterceptsLocation` que puedes usar:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute(string filePath, int line, int character) : Attribute
    {
    }
}
```

### Error CS8652 The feature 'primary constructors' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Esto significa que estás usando .NET 8, pero aún no has cambiado a C# 12. Puedes [cambiar a C# 12](/2023/06/how-to-switch-to-c-12/) o definir el atributo sin usar primary constructors, así:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int character)
        {
            
        }
    }
}
```
