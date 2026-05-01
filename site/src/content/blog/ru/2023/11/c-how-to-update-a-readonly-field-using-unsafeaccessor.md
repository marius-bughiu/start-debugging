---
title: "C# Как обновить readonly-поле с помощью UnsafeAccessor"
description: "Узнайте, как в C# обновить readonly-поле с помощью UnsafeAccessor — альтернативы рефлексии без потерь производительности. Доступно в .NET 8."
pubDate: 2023-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Unsafe accessors можно использовать для доступа к приватным членам класса так же, как это делается через рефлексию. То же самое касается и изменения значения readonly-поля.

Рассмотрим следующий класс:

```cs
class Foo
{
    public readonly int readonlyField = 3;
}
```

Допустим, по какой-то причине вы хотите изменить значение этого поля только для чтения. С помощью рефлексии это, конечно, уже было возможно:

```cs
var instance = new Foo();

typeof(Foo)
    .GetField("readonlyField", BindingFlags.Instance | BindingFlags.Public)
    .SetValue(instance, 42);

Console.WriteLine(instance.readonlyField); // 42
```

Но того же самого можно добиться с помощью `UnsafeAccessorAttribute`, без потерь производительности, связанных с рефлексией. С точки зрения unsafe accessors изменение readonly-полей ничем не отличается от изменения любого другого поля.

```cs
var instance = new Foo();

[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "readonlyField")]
extern static ref int ReadonlyField(Foo @this);

ReadonlyField(instance) = 42;

Console.WriteLine(instance.readonlyField); // 42
```

Этот код также [доступен на GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/24d4273803c67824b2885b6f18cb8d535ec75657/unsafe-accessor/UnsafeAccessor/Program.cs#L74), если вы хотите попробовать его в деле.
