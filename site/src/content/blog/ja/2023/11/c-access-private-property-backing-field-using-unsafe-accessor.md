---
title: "C# Unsafe Accessor を使ってプライベートプロパティのバッキングフィールドにアクセスする"
description: ".NET 8 の UnsafeAccessorAttribute を使って、C# のプライベート自動プロパティの自動生成されたバッキングフィールドにリフレクションなしでアクセスします。"
pubDate: 2023-11-08
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/c-access-private-property-backing-field-using-unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
`UnsafeAccessorAttribute` のあまり知られていない機能の1つに、自動プロパティの自動生成されたバッキングフィールド、つまり発音できない名前を持つフィールドへのアクセスを可能にする点があります。

アクセス方法はフィールドへのアクセスとほぼ同じで、唯一の違いはメンバー名のパターンで、次のような形になります。

```plaintext
<MyProperty>k__BackingField
```

例として、次のクラスを取り上げてみましょう。

```cs
class Foo
{
    private string InstanceProperty { get; set; } = "instance-property";
}
```

下に示すのは、このプロパティのバッキングフィールド用の unsafe accessor と、プライベートなバッキングフィールドを読み取る例、および値を書き換える例です。

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<InstanceProperty>k__BackingField")]
extern static ref string InstancePropertyBackingField(Foo @this);

var instance = new Foo();

// Read
_ = InstancePropertyBackingField(instance);

// Modify
InstancePropertyBackingField(instance) = Guid.NewGuid().ToString();
```
