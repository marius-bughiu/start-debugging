---
title: ".NET 8 Properties aus Interface-Hierarchien serialisieren"
description: ".NET 8 unterstützt das Serialisieren von Properties aus Interface-Hierarchien, inklusive aller Properties aller Interfaces, abhängig vom deklarierten Variablentyp."
pubDate: 2023-09-25
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-serializing-properties-from-interface-hierarchies"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 unterstützt das Serialisieren von Properties aus Interface-Hierarchien. Das bedeutet, dass alle Properties aller Interfaces in der Hierarchie in die Serialisierung einbezogen werden. Entscheidend ist, wo Sie ansetzen.

Sehen wir uns die folgende Hierarchie als Beispiel an:

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

Übergeben Sie nun bei der Serialisierung eine Instanz von `Derived2Impl`, die in einer `IDerived2`-Variable gespeichert ist, werden alle 3 Properties der Hierarchie serialisiert.

```cs
IDerived2 value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived2":2,"Derived":1,"Base":0}
```

Definieren Sie die Variable hingegen als `IDerived`, werden nur 2 Properties serialisiert.

```cs
IDerived value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived":1,"Base":0}
```

Bei einer `IBase`-Variable wird wie erwartet nur eine Property serialisiert, obwohl das Objekt, das wir serialisieren, vom Typ `Derived2Impl` ist, alle 3 Interfaces implementiert und damit alle 3 Properties definiert sind.

```cs
IBase value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Base":0}
```
