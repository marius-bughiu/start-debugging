---
title: ".NET 8 serializar propiedades de jerarquías de interfaces"
description: ".NET 8 añade soporte para serializar propiedades de jerarquías de interfaces, incluyendo todas las propiedades de todas las interfaces según el tipo de la variable declarada."
pubDate: 2023-09-25
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-serializing-properties-from-interface-hierarchies"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 añade soporte para serializar propiedades de jerarquías de interfaces. Esto significa que todas las propiedades de todas las interfaces de la jerarquía se incluirán en la serialización. Lo más importante es desde dónde empiezas.

Tomemos como ejemplo la siguiente jerarquía:

```cs
public interface IBase
{
    public int Base { get; set; }
}

public interface IDerived : IBase
{
    public int Derived { get; set; }
}

public interface IDerived2 : IDerived
{
    public int Derived2 { get; set; }
}

public class Derived2Impl : IDerived2
{
    public int Base { get; set; }
    public int Derived { get; set; }
    public int Derived2 { get; set; }
}
```

Ahora, durante la serialización, si pasas una instancia de `Derived2Impl` almacenada en una variable `IDerived2`, se serializarán las 3 propiedades de la jerarquía.

```cs
IDerived2 value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived2":2,"Derived":1,"Base":0}
```

Si en cambio defines la variable como de tipo `IDerived`, solo se serializarán 2 propiedades.

```cs
IDerived value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived":1,"Base":0}
```

Y para una variable `IBase`, como cabría esperar, solo se serializará una propiedad, a pesar de que el objeto que estamos serializando es de tipo `Derived2Impl`, tiene las 3 interfaces implementadas y, por tanto, las 3 propiedades definidas.

```cs
IBase value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Base":0}
```
