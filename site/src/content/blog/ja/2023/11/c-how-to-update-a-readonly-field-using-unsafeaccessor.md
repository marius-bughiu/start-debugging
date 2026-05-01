---
title: "C# UnsafeAccessor で readonly フィールドを更新する方法"
description: "C# で UnsafeAccessor を使って readonly フィールドを更新する方法を解説します。リフレクションのパフォーマンスペナルティのない代替手段で、.NET 8 で利用できます。"
pubDate: 2023-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
unsafe accessor は、リフレクションと同じようにクラスのプライベートメンバーへアクセスするのに使えます。そして、readonly フィールドの値を変更する場合も同じことが言えます。

次のクラスを例に考えてみます。

```cs
class Foo
{
    public readonly int readonlyField = 3;
}
```

何らかの理由で、その読み取り専用フィールドの値を変更したいとします。もちろん、これまでもリフレクションを使えばできました。

```cs
var instance = new Foo();

typeof(Foo)
    .GetField("readonlyField", BindingFlags.Instance | BindingFlags.Public)
    .SetValue(instance, 42);

Console.WriteLine(instance.readonlyField); // 42
```

しかし、同じことを `UnsafeAccessorAttribute` を使って、リフレクションに伴うパフォーマンスペナルティなしで実現できます。unsafe accessor の観点では、readonly フィールドの変更も、ほかのフィールドを変更するのとまったく変わりません。

```cs
var instance = new Foo();

[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "readonlyField")]
extern static ref int ReadonlyField(Foo @this);

ReadonlyField(instance) = 42;

Console.WriteLine(instance.readonlyField); // 42
```

このコードは、試してみたい方のために [GitHub でも公開](https://github.com/Start-Debugging/dotnet-samples/blob/24d4273803c67824b2885b6f18cb8d535ec75657/unsafe-accessor/UnsafeAccessor/Program.cs#L74) されています。
