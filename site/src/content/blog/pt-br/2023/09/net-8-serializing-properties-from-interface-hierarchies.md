---
title: ".NET 8 serializando propriedades de hierarquias de interfaces"
description: "O .NET 8 passa a suportar a serialização de propriedades de hierarquias de interfaces, incluindo todas as propriedades de todas as interfaces conforme o tipo declarado da variável."
pubDate: 2023-09-25
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-serializing-properties-from-interface-hierarchies"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 8 traz suporte para serializar propriedades de hierarquias de interfaces. Ou seja, todas as propriedades de todas as interfaces da hierarquia entram na serialização. O mais importante é por onde você começa.

Considere a seguinte hierarquia:

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

Agora, na serialização, se você passar uma instância de `Derived2Impl` armazenada em uma variável `IDerived2`, todas as 3 propriedades da hierarquia serão serializadas.

```cs
IDerived2 value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived2":2,"Derived":1,"Base":0}
```

Se, em vez disso, você definir a variável como `IDerived`, apenas 2 propriedades serão serializadas.

```cs
IDerived value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived":1,"Base":0}
```

E para uma variável `IBase`, como esperado, apenas uma propriedade é serializada, mesmo que o objeto sendo serializado seja do tipo `Derived2Impl` (com todas as 3 interfaces implementadas e, portanto, todas as 3 propriedades definidas).

```cs
IBase value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Base":0}
```
