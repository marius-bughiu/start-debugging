---
title: "C# Wie Sie ein readonly-Feld mit UnsafeAccessor aktualisieren"
description: "Erfahren Sie, wie Sie in C# ein readonly-Feld mit UnsafeAccessor aktualisieren, einer Alternative zu Reflection ohne deren Performance-Nachteil. Verfügbar in .NET 8."
pubDate: 2023-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Unsafe Accessors können verwendet werden, um auf private Member einer Klasse zuzugreifen, genauso wie Sie es mit Reflection tun würden. Dasselbe gilt für das Ändern des Werts eines readonly-Feldes.

Nehmen wir die folgende Klasse an:

```cs
class Foo
{
    public readonly int readonlyField = 3;
}
```

Angenommen, Sie möchten aus irgendeinem Grund den Wert dieses Read-Only-Feldes ändern. Mit Reflection war das natürlich schon vorher möglich:

```cs
var instance = new Foo();

typeof(Foo)
    .GetField("readonlyField", BindingFlags.Instance | BindingFlags.Public)
    .SetValue(instance, 42);

Console.WriteLine(instance.readonlyField); // 42
```

Dasselbe lässt sich aber auch mit `UnsafeAccessorAttribute` erreichen, ohne den Performance-Nachteil von Reflection. Das Modifizieren von readonly-Feldern unterscheidet sich bei Unsafe Accessors nicht vom Modifizieren eines anderen Feldes.

```cs
var instance = new Foo();

[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "readonlyField")]
extern static ref int ReadonlyField(Foo @this);

ReadonlyField(instance) = 42;

Console.WriteLine(instance.readonlyField); // 42
```

Dieser Code ist auch [auf GitHub verfügbar](https://github.com/Start-Debugging/dotnet-samples/blob/24d4273803c67824b2885b6f18cb8d535ec75657/unsafe-accessor/UnsafeAccessor/Program.cs#L74), falls Sie ihn ausprobieren möchten.
