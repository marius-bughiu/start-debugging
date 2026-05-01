---
title: "C# Cómo actualizar un campo readonly usando UnsafeAccessor"
description: "Aprende a actualizar un campo readonly en C# usando UnsafeAccessor, una alternativa a la reflexión sin la penalización de rendimiento. Disponible en .NET 8."
pubDate: 2023-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los unsafe accessors se pueden usar para acceder a miembros privados de una clase, igual que harías con reflexión. Y lo mismo se puede decir sobre cambiar el valor de un campo readonly.

Supongamos la siguiente clase:

```cs
class Foo
{
    public readonly int readonlyField = 3;
}
```

Imagina que por alguna razón quieres cambiar el valor de ese campo de solo lectura. Ya podías hacerlo con reflexión, por supuesto:

```cs
var instance = new Foo();

typeof(Foo)
    .GetField("readonlyField", BindingFlags.Instance | BindingFlags.Public)
    .SetValue(instance, 42);

Console.WriteLine(instance.readonlyField); // 42
```

Pero lo mismo se puede lograr usando `UnsafeAccessorAttribute` sin la penalización de rendimiento asociada a la reflexión. Modificar campos readonly no es diferente de modificar cualquier otro campo cuando se trata de unsafe accessors.

```cs
var instance = new Foo();

[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "readonlyField")]
extern static ref int ReadonlyField(Foo @this);

ReadonlyField(instance) = 42;

Console.WriteLine(instance.readonlyField); // 42
```

Este código también está [disponible en GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/24d4273803c67824b2885b6f18cb8d535ec75657/unsafe-accessor/UnsafeAccessor/Program.cs#L74) por si quieres probarlo.
