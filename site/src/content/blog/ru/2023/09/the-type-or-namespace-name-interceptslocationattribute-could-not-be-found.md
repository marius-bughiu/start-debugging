---
title: "The type or namespace name InterceptsLocationAttribute could not be found"
description: "Как исправить ошибку CS0246 для InterceptsLocationAttribute в interceptors C#, объявив атрибут самостоятельно."
pubDate: 2023-09-14
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/the-type-or-namespace-name-interceptslocationattribute-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Если вы только начинаете работать с interceptors, то, возможно, столкнётесь с одной из таких ошибок:

> Error CS0246 The type or namespace name 'InterceptsLocationAttribute' could not be found (are you missing a using directive or an assembly reference?)

> Error CS0246 The type or namespace name 'InterceptsLocation' could not be found (are you missing a using directive or an assembly reference?)

Причина в том, что атрибут пока нигде не определён, поэтому вам нужно объявить его самостоятельно. Не волнуйтесь, компилятор корректно увидит ваш атрибут и применит ожидаемое поведение.

Вот определение атрибута `InterceptsLocation`, которое можно использовать:

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

Это значит, что вы используете .NET 8, но ещё не перешли на C# 12. Можно либо [перейти на C# 12](/2023/06/how-to-switch-to-c-12/), либо определить атрибут без primary constructors, например так:

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
