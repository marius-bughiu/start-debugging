---
title: "The type or namespace name InterceptsLocationAttribute could not be found"
description: "Como corrigir o erro CS0246 do InterceptsLocationAttribute nos interceptors do C# definindo o atributo você mesmo."
pubDate: 2023-09-14
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/the-type-or-namespace-name-interceptslocationattribute-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Se você está começando com interceptors, talvez encontre um dos seguintes erros:

> Error CS0246 The type or namespace name 'InterceptsLocationAttribute' could not be found (are you missing a using directive or an assembly reference?)

> Error CS0246 The type or namespace name 'InterceptsLocation' could not be found (are you missing a using directive or an assembly reference?)

O motivo é que o atributo ainda não está definido em lugar nenhum, então você precisa defini-lo. Sem stress: o compilador vai detectar seu atributo direitinho e aplicar o comportamento esperado.

Veja uma definição do atributo `InterceptsLocation` que você pode usar:

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

Isso significa que você está no .NET 8, mas ainda não migrou para o C# 12. Você pode [migrar para o C# 12](/2023/06/how-to-switch-to-c-12/) ou definir o atributo sem primary constructors, assim:

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
