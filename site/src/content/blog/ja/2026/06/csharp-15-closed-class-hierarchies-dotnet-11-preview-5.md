---
title: "C# 15 の閉じたクラス階層: .NET 11 Preview 5 の closed キーワード"
description: ".NET 11 Preview 5 で C# 15 は closed 修飾子を追加し、クラス階層に switch 式でのコンパイル時の網羅性をもたらします。その仕組みと唯一の注意点を解説します。"
pubDate: 2026-06-21
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-21
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) は 2026 年 6 月 9 日にリリースされ、C# 15 の言語作業の中に、型システムで最も古い欠落の一つを静かに修正する機能が紛れ込んでいます。これまでコンパイラーに「この基底クラスにはちょうどこれらのサブタイプがある」と伝える方法はありませんでした。今はあります。新しい `closed` 修飾子は閉じたクラス階層を宣言し、それに対する switch 式はコンパイル時に完全な網羅性チェックを受けます。

これは[型ユニオン](/ja/2026/04/csharp-15-union-types-dotnet-11-preview-2/)の対となる要素です。ユニオンは無関係な型を組み合わせます。閉じた階層は、すでに自分が所有している継承ツリーを固定します。両者を合わせることで、C# は完全な網羅性のストーリーを得ます。

## closed が実際に行うこと

基底クラスを `closed` としてマークすると、コンパイラーは同じアセンブリ内にある直接のサブタイプのみを許可します。サブタイプの集合が既知かつ有限になったため、コンパイラーは `switch` が到達可能なすべてのケースを処理しているかを検証できます。

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

static string Describe(GateState state) => state switch
{
    Closed => "closed",
    Open(var percent) => $"{percent}% open"
};
```

`default` の分岐も、破棄パターンも、`throw new InvalidOperationException("unreachable")` もありません。コンパイラーは `Closed` と `Open` が唯一の選択肢であることをすでに知っています。後で 3 つ目のサブタイプを追加すると、網羅的でないすべての switch が警告で点灯します。これはまさに、シールクラスと visitor の組み合わせパターンが決して与えてくれなかったリファクタリングの安全網です。

## 噛みついてくるルール

いくつかの制約は覚えておく価値があります。

- `closed` クラスは**暗黙的に抽象**です。基底を直接インスタンス化することはできず、`closed` を `sealed`、`static`、または明示的な `abstract` 修飾子と組み合わせることもできません。
- 直接のサブタイプは**同じアセンブリ**で宣言しなければなりません。アセンブリをまたぐ継承はブロックされており、これが閉じた集合を認識可能にしています。
- これはクラスと `record class` に適用されますが、**構造体には適用されません**。

## Preview 5 における唯一の注意点

ここがつまずくところです。コンパイラーは `System.Runtime.CompilerServices.ClosedAttribute` というマーカーを出力しますが、Preview 5 のランタイムはまだその属性を同梱していません。同梱されるまで、`closed` を使うすべてのプロジェクトは属性を自分で宣言する必要があります。

```csharp
namespace System.Runtime.CompilerServices;

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class ClosedAttribute : Attribute { }
```

これをプロジェクト内の任意のファイルに入れれば、この機能はコンパイルされます。BCL がこの型を持つようになれば、後のプレビューで消えると見込んでください。これは通常のプレビュー税なので、公開する予定の共有ライブラリにこの応急処置を組み込まないでください。

閉じた階層、閉じた列挙型、型ユニオンは、今日の C# 15 ではすべて `<LangVersion>preview</LangVersion>` の背後にあり、2026 年 11 月の .NET 11 で一般提供へ向かっています。コンパイラーを満足させるためだけに到達不能な default を持つ switch を書いたことがあるなら、これはついにそれを削除する機能です。詳細はすべて [Preview 5 の C# リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/csharp.md)にあります。
