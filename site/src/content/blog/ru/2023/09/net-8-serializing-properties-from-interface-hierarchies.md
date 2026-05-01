---
title: ".NET 8 сериализация свойств из иерархий интерфейсов"
description: ".NET 8 добавляет поддержку сериализации свойств из иерархий интерфейсов, включая все свойства всех интерфейсов в зависимости от объявленного типа переменной."
pubDate: 2023-09-25
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-serializing-properties-from-interface-hierarchies"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 добавляет поддержку сериализации свойств из иерархий интерфейсов. Это означает, что в сериализацию будут включены все свойства всех интерфейсов в иерархии. Самое важное здесь — с чего вы начинаете.

Возьмём для примера такую иерархию:

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

Теперь при сериализации, если передать экземпляр `Derived2Impl`, хранящийся в переменной типа `IDerived2`, будут сериализованы все 3 свойства иерархии.

```cs
IDerived2 value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived2":2,"Derived":1,"Base":0}
```

Если же объявить переменную типа `IDerived`, сериализуются только 2 свойства.

```cs
IDerived value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived":1,"Base":0}
```

Для переменной `IBase`, как и ожидалось, будет сериализовано только одно свойство, несмотря на то что объект, который мы сериализуем, имеет тип `Derived2Impl` — реализует все 3 интерфейса и, соответственно, все 3 свойства.

```cs
IBase value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Base":0}
```
