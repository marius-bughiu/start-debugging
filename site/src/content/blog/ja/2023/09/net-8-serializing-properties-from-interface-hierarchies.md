---
title: ".NET 8 インターフェース階層のプロパティをシリアライズする"
description: ".NET 8 ではインターフェース階層からのプロパティのシリアライズに対応し、宣言された変数の型に応じて、階層内のすべてのインターフェースのすべてのプロパティを含められるようになりました。"
pubDate: 2023-09-25
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-serializing-properties-from-interface-hierarchies"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 では、インターフェース階層からのプロパティのシリアライズがサポートされるようになりました。つまり、階層内のすべてのインターフェースに含まれるすべてのプロパティがシリアライズの対象になります。重要なのは、どこから出発するかです。

例として、次の階層を見てみましょう。

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

シリアライズの際、`Derived2Impl` のインスタンスを `IDerived2` の変数に格納したものを渡すと、階層内の 3 つのプロパティすべてがシリアライズされます。

```cs
IDerived2 value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived2":2,"Derived":1,"Base":0}
```

代わりに変数の型を `IDerived` にすると、シリアライズされるのは 2 つのプロパティだけになります。

```cs
IDerived value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Derived":1,"Base":0}
```

そして `IBase` 変数では、想定どおり 1 つのプロパティだけがシリアライズされます。シリアライズしているオブジェクトは `Derived2Impl` 型で、3 つのインターフェースをすべて実装しており、したがって 3 つのプロパティが定義されているにもかかわらず、です。

```cs
IBase value = new Derived2Impl { Base = 0, Derived = 1, Derived2 = 2 };

JsonSerializer.Serialize(value);
// Output: {"Base":0}
```
