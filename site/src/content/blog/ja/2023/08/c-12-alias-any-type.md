---
title: "C# 12 任意の型に alias を付ける"
description: "C# 12 では using alias ディレクティブの制限が緩和され、名前付きの型だけでなく任意の型に alias を付けられるようになりました。これにより、タプル、ポインター、配列型、ジェネリック型などにも alias を付けられます。タプルの完全な構造的な形を書く代わりに、短くて分かりやすい alias を..."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/08/c-12-alias-any-type"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 12 では using alias ディレクティブの制限が緩和され、名前付きの型だけでなく任意の型に alias を付けられるようになりました。つまり、タプル、ポインター、配列型、ジェネリック型などにも alias を付けられます。タプルの完全な構造的な形を毎回書く代わりに、短くて分かりやすい alias を付けて、どこでも使えるようになります。

タプルに alias を付ける簡単な例を見てみましょう。まずは alias の宣言。

```cs
using Point = (int x, int y);
```

あとは普通の型と同じように使うだけです。メソッドの戻り値の型として、メソッドのパラメーターリストとして、あるいは新しいインスタンスの生成にも使えます。事実上、制限はほとんどありません。

上で宣言したタプル alias を使う例はこちら。

```cs
Point Copy(Point source)
{
    return new Point(source.x, source.y);
}
```

これまでと同様、型 alias は宣言したファイル内でのみ有効です。

### 制限事項

少なくとも現時点では、プリミティブ以外の型については完全修飾型名を指定する必要があります。たとえば次のとおりです。

```cs
using CarDictionary = System.Collections.Generic.Dictionary<string, ConsoleApp8.Car<System.Guid>>;
```

省略できる範囲はせいぜい、自身の namespace の中で alias を宣言することで、自分のアプリの namespace 部分を省くことくらいです。

```cs
namespace ConsoleApp8
{
    using CarDictionary = System.Collections.Generic.Dictionary<string, Car<System.Guid>>;
}
```

### Error CS8652

> The feature 'using type alias' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

このエラーは、プロジェクトがまだ C# 12 を使っておらず、新しい言語機能を利用できないことを意味します。C# 12 への切り替え方がわからない場合は、[プロジェクトを C# 12 に切り替えるガイド](/2023/06/how-to-switch-to-c-12/) をご覧ください。
