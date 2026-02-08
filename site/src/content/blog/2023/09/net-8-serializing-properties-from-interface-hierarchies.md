---
title: ".NET 8 – Serializing properties from interface hierarchies"
description: ".NET 8 adds support for serializing properties from interface hierarchies, including all properties from all interfaces depending on the declared variable type."
pubDate: 2023-09-25
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
.NET 8 adds support for serializing properties from interface hierarchies. This means that all the properties from all interfaces in the hierarchy will be included in the serialization. The most important thing is where you start.

Let’s take the following hierarchy as an example:

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

Now, during serialization, if you pass along a `Derived2Impl` instance stored in a `IDerived2` variable, all 3 properties from the hierarchy will be serialized.

```cs
IDerived2 value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived2":2,"Derived":1,"Base":0}
```

If instead you define your variable to be of type `IDerived`, only 2 properties will be serialized.

```cs
IDerived value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived":1,"Base":0}
```

And for an `IBase` variable, as expected, only one property will be serialized, despite the fact that the object we're serializing is of type `Derived2Impl` – has all 3 interfaces implemented, thus all 3 properties defined.

```cs
IBase value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Base":0}
```
