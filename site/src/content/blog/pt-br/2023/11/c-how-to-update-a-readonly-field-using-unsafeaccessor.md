---
title: "C# como atualizar um campo readonly usando UnsafeAccessor"
description: "Aprenda a atualizar um campo readonly em C# usando UnsafeAccessor, uma alternativa à reflexão sem a penalidade de desempenho. Disponível no .NET 8."
pubDate: 2023-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Os unsafe accessors podem ser usados para acessar membros privados de uma classe, exatamente como você faria com reflexão. O mesmo vale para alterar o valor de um campo readonly.

Vamos supor a seguinte classe:

```cs
class Foo
{
    public readonly int readonlyField = 3;
}
```

Imagine que por algum motivo você queira alterar o valor desse campo somente leitura. Já era possível fazer isso com reflexão, claro:

```cs
var instance = new Foo();

typeof(Foo)
    .GetField("readonlyField", BindingFlags.Instance | BindingFlags.Public)
    .SetValue(instance, 42);

Console.WriteLine(instance.readonlyField); // 42
```

Mas a mesma coisa pode ser feita usando `UnsafeAccessorAttribute`, sem a penalidade de desempenho associada à reflexão. Modificar campos readonly não é diferente de modificar qualquer outro campo quando se fala em unsafe accessors.

```cs
var instance = new Foo();

[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "readonlyField")]
extern static ref int ReadonlyField(Foo @this);

ReadonlyField(instance) = 42;

Console.WriteLine(instance.readonlyField); // 42
```

Esse código também está [disponível no GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/24d4273803c67824b2885b6f18cb8d535ec75657/unsafe-accessor/UnsafeAccessor/Program.cs#L74), caso você queira testá-lo.
