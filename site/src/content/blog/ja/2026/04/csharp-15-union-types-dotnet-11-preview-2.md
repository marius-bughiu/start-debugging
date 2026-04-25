---
title: "C# 15 の union 型がここに: 型ユニオンが .NET 11 Preview 2 で出荷"
description: "C# 15 は網羅的なパターンマッチングと暗黙の変換を伴う型ユニオン用の union キーワードを導入します。.NET 11 Preview 2 で今すぐ利用可能です。"
pubDate: 2026-04-08
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/04/csharp-15-union-types-dotnet-11-preview-2"
translatedBy: "claude"
translationDate: 2026-04-25
---

何年もの提案、回避策、`OneOf` のようなサードパーティライブラリの後、C# 15 は [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/csharp-15-union-types/) で `union` キーワードを出荷します。これらは **型ユニオン** です。既存の型を 1 つの閉じた型に合成し、コンパイラが網羅的なパターンマッチングを強制します。基底クラスなし、visitor パターンなし、ランタイムでの推測なしです。

## 型ユニオンはどう見えるか

ユニオンは値が固定された型のセットのうち厳密に 1 つであると宣言します。

```csharp
public union Shape(Circle, Rectangle, Triangle);
```

`Shape` は `Circle`、`Rectangle`、または `Triangle` を保持でき、それ以外は何も保持できません。コンパイラは各ケース型からの暗黙の変換を生成するので、代入は単純です。

```csharp
Shape shape = new Circle(Radius: 5.0);
```

明示的なキャストなし、ファクトリメソッドなしです。変換は単に動作します。

## 網羅的なパターンマッチング

本当の見返りは消費時に来ます。ユニオンに対する `switch` 式はすべてのケースを処理しなければならず、そうでなければコンパイラがエラーを出します。

```csharp
double Area(Shape shape) => shape switch
{
    Circle c    => Math.PI * c.Radius * c.Radius,
    Rectangle r => r.Width * r.Height,
    Triangle t  => 0.5 * t.Base * t.Height,
};
```

default ブランチは不要です。後で `Polygon` をユニオンに追加すると、それを処理しないすべての `switch` はコンパイル時に壊れます。これがクラス階層や `OneOf<T1, T2>` が言語レベルで提供できない安全性の保証です。

## ユニオンはロジックを運べる

1 行の宣言に限定されません。ユニオンはメソッド、プロパティ、ジェネリックをサポートします。

```csharp
public union Result<T>(T, ErrorInfo)
{
    public string Describe() => Value switch
    {
        T val       => $"Success: {val}",
        ErrorInfo e => $"Error {e.Code}: {e.Message}",
    };
}
```

`Value` プロパティは基底のインスタンスへのアクセスを提供します。ジェネリックと組み合わせると、これは `Result<T>` パターンを外部依存なしでファーストクラスにします。

## これは以前の提案とどう違うか

2026 年 1 月、ユニオン自体の中にメンバーを定義する [discriminated union 提案](/2026/01/csharp-proposal-discriminated-unions/) (F# や Rust の enum に近い) を取り上げました。出荷された C# 15 のデザインは異なる方向を取ります。**型ユニオンは新しいものをインラインで宣言するのではなく、既存の型を合成する** のです。これはあなたの `Circle`、`Rectangle`、`Triangle` がすでに持っている通常のクラスまたは record であることを意味します。ユニオンは単にそれらをグループ化します。

## はじめに

[.NET 11 Preview 2 SDK](https://dotnet.microsoft.com/download/dotnet/11.0) をインストールし、`net11.0` をターゲットにし、プロジェクトファイルに `<LangVersion>preview</LangVersion>` を設定します。Preview 2 では、`UnionAttribute` と `IUnion<T>` インターフェースはまだランタイムにないことに注意してください。プロジェクトで宣言する必要があります。後の preview にはそのまま含まれます。

型ユニオンは null 許容参照型以来、C# の型システムへの最大の追加です。継承ツリーやタプルのハックで「one-of」関係をモデル化していた場合、今が本物でプロトタイプを作る良い時期です。
