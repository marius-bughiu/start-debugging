---
title: "C# Acceder al campo de respaldo de una propiedad privada usando Unsafe Accessor"
description: "Usa UnsafeAccessorAttribute en .NET 8 para acceder a los campos de respaldo autogenerados de propiedades automáticas privadas en C# sin reflexión."
pubDate: 2023-11-08
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/c-access-private-property-backing-field-using-unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una característica poco conocida de `UnsafeAccessorAttribute` es que también permite acceder a los campos de respaldo autogenerados de propiedades automáticas, campos con nombres impronunciables.

La forma de acceder a ellos es muy similar a la de acceder a los campos, con la única diferencia del patrón del nombre del miembro, que se ve así:

```plaintext
<MyProperty>k__BackingField
```

Tomemos la siguiente clase como ejemplo:

```cs
class Foo
{
    private string InstanceProperty { get; set; } = "instance-property";
}
```

A continuación tienes el unsafe accessor para el campo de respaldo de esta propiedad y ejemplos de cómo leer el campo de respaldo privado y cómo modificar su valor.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<InstanceProperty>k__BackingField")]
extern static ref string InstancePropertyBackingField(Foo @this);

var instance = new Foo();

// Read
_ = InstancePropertyBackingField(instance);

// Modify
InstancePropertyBackingField(instance) = Guid.NewGuid().ToString();
```
