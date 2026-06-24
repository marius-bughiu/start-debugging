---
title: "C# 14 で拡張プロパティを宣言する方法"
description: "拡張プロパティは新しい extension ブロックを通じて C# 14 で導入されます。読み取り専用、書き込み可能、静的、ジェネリックな拡張プロパティの宣言方法、自動プロパティが拒否される理由、そしてコンパイラーがそれらを get_/set_ アクセサーへ変換する仕組みを解説します。"
pubDate: 2026-06-24
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "extension-members"
lang: "ja"
translationOf: "2026/06/how-to-declare-extension-properties-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-06-24
---

手短に言うと、拡張プロパティは静的クラス内の `extension` ブロックの中で宣言します。レシーバーに名前を付けるとインスタンスプロパティを追加し（`extension(string s) { public int WordCount => ...; }`）、名前を省略すると静的プロパティを追加します（`extension(Point) { public static Point Origin => ...; }`）。プロパティ本体がゲッターであり、書き込み可能なプロパティには `set` アクセサーを追加します。誰もがつまずく唯一のルールがあります。拡張フィールドは存在しないため、`public int Count { get; set; }` のような自動プロパティはコンパイルできません。各アクセサーは値を計算するか、実際のストレージへ転送する必要があります。

この機能は C# 14 で導入され、.NET 10 SDK 以降が必要です（.NET 11 SDK でも同じように動作します）。`.csproj` に `<LangVersion>14</LangVersion>` または `<LangVersion>latest</LangVersion>` を設定してください。拡張プロパティは、より広範な拡張メンバー機能の一部です。この記事はプロパティの部分に焦点を当てたガイドです。演算子や静的メンバーも扱うより広範なツアーが必要なら、[C# 14 の拡張メンバーの概要](/ja/2026/02/csharp-14-extension-members/) をお読みください。

## C# 14 より前に `string.WordCount` を書けなかった理由

拡張メソッドは C# 3.0 から存在しますが、拡張できるメンバーの種類は 1 つだけ、メソッドでした。自分が所有していない型に計算値を追加したい場合は、メソッド呼び出しとして書く必要がありました。

```csharp
// Before C# 14 - the only option was a method
public static class StringExtensions
{
    public static int WordCount(this string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
}

// Call site reads like a function, not a property
int n = "hello there world".WordCount();
```

末尾のその `()` が手がかりです。`WordCount` は概念的には文字列のプロパティですが、言語がそれをメソッドの形に押し込んでいました。自分が制御していない型に対する自動プロパティ、計算プロパティ、インデクサーは、単純に手の届かないものでした。C# 14 はそのギャップを `extension` ブロックで埋めます。これは、従来の `this` スタイルのメソッドと並んでプロパティ、演算子、静的メンバーを保持できるコンテナーです。

## 3 つのステップで拡張プロパティを宣言する

1. 拡張を保持するための、ジェネリックでないトップレベルの静的クラスを作成します。これは従来の拡張メソッドと同じ格納ルールです。クラスはネストできず、ジェネリックにもできません。
2. `extension` ブロックを開き、レシーバーを宣言します。プロパティが拡張するインスタンスに名前を付けるには `extension(string s)` と書き、型そのものに対する静的プロパティには名前なしで `extension(string)` と書きます。
3. ブロック内でプロパティを式形式のゲッター（または完全な `get`/`set` 本体）とともに宣言します。ステップ 2 で付けた名前でレシーバーのパラメーターを参照します。

まとめると、`WordCount` の例は本物のプロパティになります。

```csharp
// .NET 11, C# 14 - an instance extension property
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(s);

        public int WordCount =>
            s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

これで呼び出し側は括弧を失い、組み込みメンバーとまったく同じように読めます。

```csharp
string title = "hello there world";
Console.WriteLine(title.WordCount);  // 3
Console.WriteLine(title.IsBlank);    // False
```

レシーバー名（ここでは `s`）はブロック内のすべてのメンバーのスコープ内にあるため、関連するプロパティは何を拡張するのかという宣言を 1 つ共有します。それがまさにこのブロックの目的です。すべてのシグネチャで `this string` を繰り返す代わりに、拡張する型ごとにメンバーをグループ化します。

## 書き込み可能な拡張プロパティには値を置く場所が必要

拡張プロパティは既定では読み取り専用ではありません。`set` アクセサーを追加できますが、ランタイムは拡張にデータを格納する場所を一切与えないため、セッターはレシーバーにすでに存在するストレージへ値を転送しなければなりません。きれいな例は、型がすでに保持しているフィールドに対する代替ビューを公開することです。

```csharp
// .NET 11, C# 14 - a get/set extension property over existing state
public class Sensor
{
    public double Celsius { get; set; }
}

public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        public double Fahrenheit
        {
            get => sensor.Celsius * 9 / 5 + 32;
            set => sensor.Celsius = (value - 32) * 5 / 9;
        }
    }
}
```

セッターは他のプロパティセッターと同様に `value` を読み取り、実際の `Celsius` フィールドを通じて書き込みます。

```csharp
var s = new Sensor { Celsius = 20 };
Console.WriteLine(s.Fahrenheit);  // 68
s.Fahrenheit = 212;
Console.WriteLine(s.Celsius);     // 100
```

できないのは、コンパイラーに代わりにストレージを発明してもらうことです。これは人々が遭遇する最も一般的なコンパイルエラーです。

```csharp
public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        // ERROR: an extension property cannot be an auto-property,
        // because there is no backing field to generate.
        public string Label { get; set; }
    }
}
```

C# 14 には拡張フィールドがないため、生成するバッキングフィールドもありません。各アクセサーは、値を計算するか、レシーバーがすでに所有しているメンバーを通じて値をルーティングする本体を持つ必要があります。自分が制御していない型のインスタンスに本当に新しい状態を付加する必要がある場合、拡張プロパティは適切なツールではありません。インスタンスをキーとする `ConditionalWeakTable<TKey, TValue>` に頼り、それをゲッターとセッターを通じて公開してください。

## 構造体を変更するには `ref` レシーバーが必要

`Sensor` の例が機能するのは `Sensor` がクラスであり、セッターが全員で共有するオブジェクトを変更するためです。値型では、レシーバーは既定でコピーされ、セッターはその使い捨てのコピーを変更してしまいます。元のものへ書き戻すには、変更を行う拡張メソッドで `this ref` が機能したのとまったく同じように、レシーバーを `ref` で宣言します。

```csharp
// .NET 11, C# 14 - ref receiver so the setter mutates the caller's struct
public static class PointExtensions
{
    extension(ref System.Drawing.Point p)
    {
        public int ManhattanLength
        {
            get => Math.Abs(p.X) + Math.Abs(p.Y);
        }
    }
}
```

`ref` レシーバーはまた、プロパティがメソッド呼び出しの結果のような一時的な値ではなく、アドレス可能な変数に対してのみ使用できることを意味します。その制約は `ref` 拡張メソッドが常に伴ってきたものと同じであり、変更を安全に保つものです。

## 静的拡張プロパティはレシーバー名を省く

パラメーター名を省略すると、ブロックはインスタンスではなく型そのものを拡張します。これは、自分が所有していない型の静的メンバーのように読める、名前付き定数やファクトリー的な値を追加する方法です。

```csharp
// .NET 11, C# 14 - a static extension property on a type you don't own
using System.Drawing;

public static class PointExtensions
{
    extension(Point)
    {
        public static Point Origin => Point.Empty;
    }
}
```

呼び出し側は、最初からそこにあった静的メンバーのように見えます。

```csharp
Point start = Point.Origin;
```

静的メンバーとインスタンスメンバーは、同じクラス内の別々のブロックに置けます。インスタンスメンバーには名前付きレシーバーのブロックを、静的メンバーには型のみのブロックを使ってください。コンパイラーは 1 つの静的クラス内で両方のスタイルが並んでいても問題ありません。

## ジェネリックな拡張プロパティ: すべての型パラメーターはレシーバーに到達しなければならない

型パラメーターを `extension` キーワードに置くと、ブロック内のすべてのメンバーに流れます。これにより、`IReadOnlyList<T>` のようなオープンジェネリック型にプロパティを追加できます。

```csharp
// .NET 11, C# 14 - generic extension properties
public static class ListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public bool IsEmpty => list.Count == 0;

        public T? LastOrDefaultValue =>
            list.Count > 0 ? list[^1] : default;
    }
}
```

コンパイラーが強制する 1 つの厳格な制約があります。ブロックで宣言されたすべての型パラメーターは、レシーバー型によって使用されなければなりません。`extension<T>(IReadOnlyList<T> list)` は `T` が `IReadOnlyList<T>` に現れるため合法です。`T` を宣言してもレシーバーで決して使わない `extension<T>(string s)` のようなブロックはコンパイルエラーです。コンパイラーは呼び出し側で `T` を推論するための材料を持たないからです。制約もブロックに付けます。

```csharp
public static class ComparableExtensions
{
    extension<T>(IReadOnlyList<T> list) where T : IComparable<T>
    {
        public T Max
        {
            get
            {
                var max = list[0];
                for (int i = 1; i < list.Count; i++)
                    if (list[i].CompareTo(max) > 0) max = list[i];
                return max;
            }
        }
    }
}
```

## コンパイラーが拡張プロパティを変換する仕組みと、曖昧さの解消方法

拡張プロパティは純粋にコンパイル時のシュガーです。コンパイラーはブロックを、隠れたネストされた型の中の通常の静的アクセサーメソッドに変えます。`get_PropertyName` という名前のゲッターと、存在する場合は `set_PropertyName` という名前のセッターで、それぞれレシーバーを第 1 引数として取ります。`title.WordCount` と書くと、コンパイラーはそれを生成された `get_WordCount` アクセサーの呼び出しに書き換えます。変換された形での型パラメーターの順序は、まずレシーバーのパラメーター、次にメソッドのパラメーターであり、これは生成されたメタデータを調べる場合にのみ重要です。

ここから 2 つの帰結が導かれます。第 1 に、解決は拡張メソッドと同じスコープ規則を使います。最も近い囲んでいる名前空間または `using` の候補が勝ち、同じ名前の 2 つの拡張プロパティが等しくスコープ内にある場合は、暗黙的な選択ではなく曖昧さのエラーになります。これは `using` ディレクティブを絞り込むか、静的クラスを通じて修飾してコンパイラーにどのアクセサーを意味するかを伝えることで解決します。第 2 に、プロパティは呼び出し側にのみ存在するため、拡張された型に対する実行時リフレクションには決して現れません。`typeof(string).GetProperty("WordCount")` は `null` を返します。拡張プロパティは言語の便宜であり、型の実行時の変更ではないため、実際のメンバーをリフレクションするもの（シリアライザー、データバインディング、ORM）はそれらを認識しません。

## null 許容はあなたが宣言する

レシーバーのパラメーターを自分で書くため、プロパティが null のレシーバーを受け入れるかどうかはあなたが決めます。null 参照に対して安全に呼び出せるプロパティを書くには、レシーバーを null 許容として注釈します。これは通常のインスタンスプロパティには決してできないことです。

```csharp
// .NET 11, C# 14 - a null-tolerant extension property
public static class StringExtensions
{
    extension(string? s)
    {
        public bool HasText => !string.IsNullOrWhiteSpace(s);
    }
}

string? maybe = null;
Console.WriteLine(maybe.HasText);  // False, no NullReferenceException
```

これは同時に登場した呼び出し側の null 処理とよく組み合わさります。代入の左辺での `?.` と `?[]` の改善については [C# 14 の null 条件付き代入](/ja/2026/02/csharp-14-null-conditional-assignment/) を参照してください。

## 出荷前に知っておく価値のあるエッジケース

いくつかのルールと制限が、混乱を招くコンパイラーエラーから救ってくれます。

- **フィールドなし、自動プロパティなし、イベントなし、コンストラクターなし。** C# 14 の `extension` ブロックは、メソッド、プロパティ、インデクサー、演算子をサポートします。フィールドは明示的に除外されており、それがまさに自動プロパティが拒否される理由です。
- **コンテナーはジェネリックでない、ネストされていない静的クラスでなければならない。** 型パラメーターはクラスではなく `extension` ブロックに置いてください。
- **実際のメンバーとの名前衝突は負ける。** 拡張された型がすでに `WordCount` プロパティを持っている場合、実際のものが常に勝ち、あなたの拡張プロパティは決して考慮されません。拡張はギャップを埋めるだけで、決してオーバーライドしません。
- **インデクサーは同じ形に従う。** インスタンスの `extension` ブロック内で `public T this[int i] => ...` を宣言でき、それを欠いている型に拡張インデクサーを与えられます。

拡張プロパティは拡張メンバーの作業の中で最も人間工学的な部分であり、C# 14 の残りの部分ときれいに組み合わさります。自分が制御している型と制御していない型に計算メンバーを追加する場合は、このリリースの他の整形ツールと比較検討してください。[複数の値を返すための拡張メンバーのトリック](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) も [ユーザー定義の複合代入演算子](/ja/2026/04/csharp-14-user-defined-compound-assignment-operators/) も、どちらも同じ構文ファミリーに依拠しています。

## 出典

- [Explore extension members in C# 14 (Microsoft Learn チュートリアル)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members)
- [C# 14: Exploring extension members (.NET Blog)](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/)
- [Andrew Lock: C# 14 extension members, AKA extension everything](https://andrewlock.net/exploring-dotnet-10-preview-features-3-csharp-14-extensions-members/)
