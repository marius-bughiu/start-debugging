---
title: "The type or namespace name InterceptsLocationAttribute could not be found"
description: "C# interceptors の InterceptsLocationAttribute に関する CS0246 エラーを、自分で属性を定義することで解消する方法を解説します。"
pubDate: 2023-09-14
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/the-type-or-namespace-name-interceptslocationattribute-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
interceptors を試し始めたばかりだと、次のようなエラーに遭遇するかもしれません。

> Error CS0246 The type or namespace name 'InterceptsLocationAttribute' could not be found (are you missing a using directive or an assembly reference?)

> Error CS0246 The type or namespace name 'InterceptsLocation' could not be found (are you missing a using directive or an assembly reference?)

理由は、この属性がまだどこにも定義されていないからで、自分で定義する必要があります。ご心配なく。コンパイラーはあなたが定義した属性を正しく検出し、想定された動作を適用してくれます。

以下に、利用できる `InterceptsLocation` 属性の定義例を示します。

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

これは、.NET 8 を使っているものの、C# 12 にまだ切り替えていない状態を意味します。[C# 12 に切り替える](/2023/06/how-to-switch-to-c-12/) か、もしくはプライマリコンストラクターを使わずに、次のように属性を定義してください。

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
