---
title: "C# Access private property backing field using Unsafe Accessor"
description: "Use UnsafeAccessorAttribute in .NET 8 to access auto-generated backing fields of private auto-properties in C# without reflection."
pubDate: 2023-11-08
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
One less-known feature of the `UnsafeAccessorAttribute` is that it also allows you to access auto-generated backing fields of auto-properties – fields with unspeakable names.

The way to access them is very similar to accessing fields, the only difference being the member name pattern, which looks like this:

```plaintext
<MyProperty>k__BackingField
```

Let’s take the following class as an example:

```cs
class Foo
{
    private string InstanceProperty { get; set; } = "instance-property";
}
```

Below you have the unsafe accessor for the backing field of this property and examples on how to read the private backing field and how to modify its value.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<InstanceProperty>k__BackingField")]
extern static ref string InstancePropertyBackingField(Foo @this);

var instance = new Foo();

// Read
_ = InstancePropertyBackingField(instance);

// Modify
InstancePropertyBackingField(instance) = Guid.NewGuid().ToString();
```
