---
title: "C# Auf das Backing Field einer privaten Eigenschaft per Unsafe Accessor zugreifen"
description: "Mit UnsafeAccessorAttribute in .NET 8 auf die automatisch generierten Backing Fields privater Auto-Properties in C# zugreifen, ohne Reflection."
pubDate: 2023-11-08
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/c-access-private-property-backing-field-using-unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Eine weniger bekannte Funktion des `UnsafeAccessorAttribute` ist, dass es auch den Zugriff auf die automatisch generierten Backing Fields von Auto-Properties erlaubt, also Felder mit unaussprechlichen Namen.

Der Zugriff erfolgt sehr ähnlich wie auf gewöhnliche Felder. Der einzige Unterschied liegt im Muster des Mitgliedsnamens, der so aussieht:

```plaintext
<MyProperty>k__BackingField
```

Nehmen wir folgende Klasse als Beispiel:

```cs
class Foo
{
    private string InstanceProperty { get; set; } = "instance-property";
}
```

Unten sehen Sie den Unsafe Accessor für das Backing Field dieser Eigenschaft sowie Beispiele dafür, wie das private Backing Field gelesen und sein Wert geändert wird.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<InstanceProperty>k__BackingField")]
extern static ref string InstancePropertyBackingField(Foo @this);

var instance = new Foo();

// Read
_ = InstancePropertyBackingField(instance);

// Modify
InstancePropertyBackingField(instance) = Guid.NewGuid().ToString();
```
