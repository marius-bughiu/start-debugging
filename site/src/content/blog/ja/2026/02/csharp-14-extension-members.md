---
title: "C# 14 の拡張メンバー: 拡張プロパティ、演算子、静的拡張"
description: "C# 14 は拡張メンバーを導入し、新しい extension キーワードを使って既存の型に拡張プロパティ、演算子、静的メンバーを追加できるようにします。"
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "ja"
translationOf: "2026/02/csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 は .NET 10 とともに登場し、C# 3.0 での導入以来もっとも要望の多かった拡張メソッドの進化をもたらします。新しい `extension` キーワードを使って、拡張プロパティ、拡張演算子、静的拡張メンバーを定義できるようになりました。

## 拡張メソッドから拡張ブロックへ

これまでは、自分のものでない型に機能を追加するには、`this` 修飾子付きの静的メソッドを持つ静的クラスを作る必要がありました。このパターンはメソッドには有効でしたが、プロパティと演算子は手の届かないところに残っていました。

C# 14 は **拡張ブロック** を導入します。これは関連する拡張メンバーをまとめる専用の構文です。

```csharp
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsNullOrEmpty => string.IsNullOrEmpty(s);

        public int WordCount => s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

`extension(string s)` ブロックは、その中のすべてのメンバーが `string` を拡張することを宣言します。これらにはプロパティとしてアクセスできるようになります。

```csharp
string title = "Hello World";
Console.WriteLine(title.IsNullOrEmpty);  // False
Console.WriteLine(title.WordCount);       // 2
```

## 拡張演算子

演算子は、これまで自分が制御していない型に追加することは不可能でした。C# 14 はそれを変えます。

```csharp
public static class PointExtensions
{
    extension(Point p)
    {
        public static Point operator +(Point a, Point b)
            => new Point(a.X + b.X, a.Y + b.Y);

        public static Point operator -(Point a, Point b)
            => new Point(a.X - b.X, a.Y - b.Y);
    }
}
```

これで `Point` のインスタンスは、元の型がそれらを定義していなくても `+` と `-` を使えます。

## 静的拡張メンバー

拡張ブロックは、拡張対象の型の静的メンバーとして現れる静的メンバーもサポートします。

```csharp
public static class GuidExtensions
{
    extension(Guid)
    {
        public static Guid Empty2 => Guid.Empty;

        public static Guid CreateDeterministic(string input)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
            return new Guid(hash.AsSpan(0, 16));
        }
    }
}
```

`Guid` の静的メンバーであるかのように呼び出します。

```csharp
var id = Guid.CreateDeterministic("user@example.com");
```

## まだサポートされていないもの

C# 14 はメソッド、プロパティ、演算子に焦点を当てています。フィールド、イベント、インデクサー、ネストされた型、コンストラクターは拡張ブロックではサポートされていません。これらは将来の C# バージョンで導入される可能性があります。

## 拡張メンバーをいつ使うか

拡張プロパティは、ある型の自然なプロパティのように感じられる計算値があるときに真価を発揮します。`string.WordCount` の例は `string.GetWordCount()` より読みやすいです。拡張演算子は、演算子が意味的に妥当である数学的型やドメイン型に適しています。

この機能は現在 .NET 10 で利用可能です。プロジェクトを `<LangVersion>14</LangVersion>` または `<LangVersion>latest</LangVersion>` に更新して、拡張ブロックを使い始めてください。

完全なドキュメントは [Microsoft Learn の拡張メンバー](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members) を参照してください。
