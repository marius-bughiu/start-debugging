---
title: "C# Доступ к backing field приватного свойства с помощью Unsafe Accessor"
description: "Используйте UnsafeAccessorAttribute в .NET 8 для доступа к автоматически генерируемым backing field приватных авто-свойств в C# без рефлексии."
pubDate: 2023-11-08
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/c-access-private-property-backing-field-using-unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Менее известная возможность `UnsafeAccessorAttribute` заключается в том, что он также позволяет обращаться к автоматически генерируемым backing field авто-свойств, то есть к полям с непроизносимыми именами.

Способ доступа к ним очень похож на доступ к обычным полям, отличается лишь шаблон имени члена, который выглядит так:

```plaintext
<MyProperty>k__BackingField
```

Возьмём в качестве примера следующий класс:

```cs
class Foo
{
    private string InstanceProperty { get; set; } = "instance-property";
}
```

Ниже приведён unsafe accessor для backing field этого свойства, а также примеры того, как прочитать приватное backing field и как изменить его значение.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<InstanceProperty>k__BackingField")]
extern static ref string InstancePropertyBackingField(Foo @this);

var instance = new Foo();

// Read
_ = InstancePropertyBackingField(instance);

// Modify
InstancePropertyBackingField(instance) = Guid.NewGuid().ToString();
```
