---
title: "C# 11 - ジェネリック属性"
description: "C# 11 でジェネリック属性を定義して使用する方法と、型引数の制約や代表的なエラーメッセージについて学びます。"
pubDate: 2023-03-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/03/c-sharp-11-generic-attributes"
translatedBy: "claude"
translationDate: 2026-05-01
---
皆さん、ジェネリック属性がついに C# にやってきました！🥳

通常のジェネリッククラスと同じように定義できます。

```cs
public class GenericAttribute<T> : Attribute { }
```

そして、他の属性と同じように使用できます。

```cs
[GenericAttribute<string>]
public class MyClass { }
```

## ジェネリック属性の制約

属性を適用する際には、すべてのジェネリック型引数を指定する必要があります。つまり、ジェネリック属性は完全に構築されている必要があります。

例えば、次のコードは動作しません。

```cs
public class MyGenericType<T>
{
    [GenericAttribute<T>()]
    public string Foo { get; set; }
}
```

メタデータの注釈を必要とする型は、ジェネリック属性の型引数として使用できません。許可されないものとその代替例を見てみましょう。

-   `dynamic` は許可されません。代わりに `object` を使用してください
-   null 許容参照型は許可されません。`string?` の代わりに単に `string` を使えます
-   C# のタプル構文を用いたタプル型は許可されません。代わりに `ValueTuple` を使用できます (例えば `(string foo, int bar)` の代わりに `ValueTuple<string, int>`)

## エラー

> CS8968 'T': an attribute type argument cannot use type parameters

このエラーは、属性に対してすべての型引数を指定していないことを意味します。ジェネリック属性は完全に構築されている必要があり、適用時に **T** パラメーターを使用できません (上記の例を参照)。

> CS8970 Type 'string' cannot be used in this context because it cannot be represented in metadata.

null 許容参照型は、ジェネリック属性の型パラメーターとして使用できません。`string?` ではなく `string` を使用してください。

> CS8970 Type 'dynamic' cannot be used in this context because it cannot be represented in metadata.

`dynamic` はジェネリック属性の型引数として使用できません。代わりに `object` を使用してください。

> CS8970 Type '(string foo, int bar)' cannot be used in this context because it cannot be represented in metadata.

タプルはジェネリック属性の型パラメーターとして使用できません。代わりに同等の `ValueTuple` を使用してください。
