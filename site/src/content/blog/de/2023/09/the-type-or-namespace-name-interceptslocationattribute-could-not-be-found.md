---
title: "The type or namespace name InterceptsLocationAttribute could not be found"
description: "So beheben Sie den Fehler CS0246 für InterceptsLocationAttribute bei C#-Interceptors, indem Sie das Attribut selbst definieren."
pubDate: 2023-09-14
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/the-type-or-namespace-name-interceptslocationattribute-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Wer mit Interceptors gerade erst beginnt, sieht eventuell einen der folgenden Fehler:

> Error CS0246 The type or namespace name 'InterceptsLocationAttribute' could not be found (are you missing a using directive or an assembly reference?)

> Error CS0246 The type or namespace name 'InterceptsLocation' could not be found (are you missing a using directive or an assembly reference?)

Der Grund: Das Attribut ist noch nirgendwo definiert, deshalb müssen Sie es selbst anlegen. Keine Sorge, der Compiler erkennt Ihr Attribut korrekt und wendet das erwartete Verhalten an.

Hier eine Definition für das `InterceptsLocation`-Attribut, die Sie verwenden können:

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

Das bedeutet, dass Sie zwar .NET 8 verwenden, aber noch nicht auf C# 12 umgestellt haben. Sie können entweder [auf C# 12 umstellen](/2023/06/how-to-switch-to-c-12/) oder das Attribut ohne Primary Constructors definieren, etwa so:

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
