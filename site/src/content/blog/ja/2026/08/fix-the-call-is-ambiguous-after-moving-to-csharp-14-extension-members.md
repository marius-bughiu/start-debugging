---
title: "Fix: C# 14 の拡張メンバーへ移行した後の The call is ambiguous between the following methods or properties"
description: "拡張メソッドを C# 14 の extension ブロックへ移した後の CS0121。コンパイラーは今も古い静的形式を出力します。重複を削除するか、呼び出しを修飾してください。"
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "ja"
translationOf: "2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-08-18
---

`this` パラメーター形式の拡張メソッドを C# 14 の `extension` ブロックへ移し、元のものを「念のため」残したところ、すべての呼び出し箇所が CS0121 で失敗するようになりました。修正方法は 2 つの宣言のうち一方を削除することです。両者は別物ではないからです。コンパイラーは拡張ブロックのメソッドを、すでに存在していた `this` パラメーター付きの静的メソッドとまったく同じものへ落とし込みます。どちらも削除できない場合 (もう一方が NuGet パッケージ内にある場合) は、含んでいる静的クラスで呼び出しを修飾してください。`s.WordCount()` ではなく `MyExtensions.WordCount(s)` と書きます。

```
error CS0121: The call is ambiguous between the following methods or properties:
'New.StringExtensions2.extension(string).WordCount()' and 'Old.StringExtensions.WordCount(string)'
```

メッセージの形に注目してください。一方の候補は `extension(string).WordCount()` として、もう一方は `WordCount(string)` として出力されています。この非対称性が診断のすべてです。Roslyn は、一方の候補が拡張ブロック由来で、もう一方が従来の `this` パラメーター形式のメソッド由来であり、両者を選び分けられないと伝えています。以下の内容はすべて .NET SDK 10.0.201 と `<LangVersion>14.0</LangVersion>` で検証しました。

## 両方の構文がスコープにあると CS0121 が発生するのはなぜですか

C# 14 は拡張メンバー用に 2 つ目の独立した探索メカニズムを導入したわけではありません。拡張ブロックは宣言構文であり、コンパイラーはそれを `this string s` が生成するものと区別できない静的クラスのメンバーへ落とし込みます。2 つの `using` ディレクティブがそれぞれクラスをスコープに持ち込み、両方のクラスが適用可能性の同じ `WordCount(string)` 候補を提供すると、オーバーロード解決には決め手が残らないため CS0121 を報告します。

これは新しい規則ではありません。2 つのライブラリが同じ型に同じ拡張メソッドを定義したときには常に同じエラーが出ていました。新しいのは、自分のコードを移行することでこの衝突が生まれるようになった点です。中途半端な移行が両方の形式を同時に生かしたままにするからです。

## 拡張ブロックに対してコンパイラーが実際に出力するものは何ですか

ここが腹落ちさせる価値のある部分です。このページのあらゆる症状を説明してくれます。メソッド 1 つとプロパティ 1 つを持つブロックを見てみましょう。

```csharp
// .NET 10.0.201, C# 14
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
        public bool IsBlank => string.IsNullOrWhiteSpace(s);
    }
}
```

同じソリューション内でコンパイル済みの `Lib.StringExtensions` をリフレクションで調べると、次のように出力されます。

```
METHOD Int32 WordCount(String s) [Extension]
METHOD Boolean get_IsBlank(String s)
NESTED <G>$34505F560D9EACF86A87F3ED1F85E448 ext-attr=True
CLASS ext-attr=True
```

このダンプから 3 つのことが読み取れます。

1. `WordCount` はレシーバーを第 1 パラメーターに取る public な静的メソッドとして出力され、`[ExtensionAttribute]` を伴います。メタデータ上ではまさに従来の拡張メソッドです。だからこそ手書きの `this` メソッドと衝突しますし、両方を書くことが互換レイヤーではなく重複になるのです。
2. プロパティは `get_IsBlank(String s)` へ落とし込まれます。これは `[ExtensionAttribute]` を**持たない** public な静的メソッドです。プロパティは従来の拡張メソッドではないため別の探索経路で見つかり、別の診断で失敗します (後述)。
3. 入れ子の型 `<G>$<hash>` は、コンパイラーが拡張ブロックごとに生成する内容ベースのマーカー型です。ハッシュはブロックの内容から導出されるため、同じクラス内でレシーバーとメンバーが同一のブロックが 2 つあると CS9329 で衝突します。

落とし込まれたメソッドが本当に通常の拡張メソッドであるため、`<LangVersion>13.0</LangVersion>` に固定したプロジェクトからも利用できます。C# 13 のアプリから C# 14 のライブラリへプロジェクト参照を張って検証しました。`"a b c".WordCount()` と `StringExtensions.WordCount("a b c")` はどちらもコンパイルでき、`3` を出力します。同じファイルに `"a b c".IsBlank` を加えると `error CS9260: Feature 'extensions' is not available in C# 13.0` で失敗します。ブロック内で宣言した拡張*メソッド*は古い言語バージョンから利用できますが、拡張*プロパティ*は利用できません。

## 最小再現: 2 つの静的クラス、1 つのメソッド名

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class StringExtensions
{
    public static int WordCount(this string s) => s.Split(' ').Length;
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class StringExtensions2
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("a b c".WordCount()); // CS0121
```

`dotnet build` はどちらの宣言でもなく呼び出し箇所で失敗します。これは重要です。宣言は個別には合法なので、エラーは両方の名前空間をインポートしているファイルにだけ現れます。したがって部分的に移行したソリューションは、あるプロジェクトではビルドでき、別のプロジェクトでは失敗します。`using` の一覧を見るまでは不安定なビルドのように見えるはずです。

同じことはアセンブリをまたいでも起こり、実際に多くの人が遭遇するのはこちらです。ライブラリが拡張ブロックを出荷し、あなたはアップグレード前に書いた `this` メソッドのローカルなシムを残しており、両方の名前空間をインポートするファイルが壊れます。

```
error CS0121: The call is ambiguous between the following methods or properties:
'Lib.StringExtensions.extension(string).WordCount()' and 'App.Compat.MyStringExtensions.WordCount(string)'
```

## 両方の宣言が自分のものである場合、CS0121 はどう直しますか

`this` パラメーター版を削除してください。それが修正のすべてであり、妥協でもありません。上で示したとおり、拡張ブロックは同一シグネチャの `[ExtensionAttribute]` 付き静的メソッドを今も出力するので、完全修飾形式の `MyExtensions.WordCount(s)` も、古い言語バージョンの呼び出し元も含め、既存の呼び出し箇所はすべて動き続けます。

```csharp
// .NET 10.0.201, C# 14 -- one declaration, both call shapes still work
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}

// both of these compile:
// "a b c".WordCount()
// StringExtensions.WordCount("a b c")
```

ホワイトボードに書いておくべき移行の規則はこれです。**拡張ブロックは古いメソッドを置き換えるものであり、並べて置くものではありません。** 「互換性のために古い方を残す」という直感はここではすべて誤りです。バイナリ互換性もソース互換性も、落とし込みによってすでに保たれているからです。

## 重複が NuGet パッケージ内にある場合、どう曖昧さを解消しますか

自分のものでない宣言は削除できないので、次のいずれかを推奨順に選んでください。

**静的メソッドを直接呼び出す。** どちらの候補も静的形式を公開しているので、使いたいクラスを名指しします。

```csharp
// .NET 10.0.201, C# 14
System.Console.WriteLine(New.StringExtensions2.WordCount("a b c")); // extension block version
System.Console.WriteLine(Old.StringExtensions.WordCount("a b c"));  // this-parameter version
```

これはきれいにコンパイルできます。呼び出し箇所は冗長になりますが、曖昧さがなく、grep で見つけられ、将来のパッケージ更新にも耐えます。

**`using` をやめて名前空間エイリアスに切り替える。** 拡張メンバーは名前空間の素の `using` によってのみスコープに入ります。名前空間エイリアスは拡張候補を提供せずに*名前*だけをインポートします。

```csharp
// .NET 10.0.201, C# 14
using OldAlias = Old; // types reachable as OldAlias.StringExtensions, but no extension candidates
using New;

System.Console.WriteLine("x".WordCount()); // binds to New, prints 2
```

このファイルをそのまま実行したところ `2` を出力しました。ファイルが名前空間の型は必要とするが拡張は必要としない場合、これが最もきれいな選択肢です。`GlobalUsings.cs` の `global using` ディレクティブや csproj の `<Using Include="..."/>` 項目には注意してください。これらはプロジェクト内のすべてのファイルへ拡張をインポートするため、そのファイル自身の `using` 一覧が無害に見えるのに曖昧さが現れる、よくある原因になります。

**2 つのメンバーに別々の名前を付ける。** 新しい方が自分のもので、まだ公開していないなら、チーム全体に曖昧さ解消の規則を教えるより名前を変えるほうが安上がりです。

## 古いメソッドに `[Obsolete]` を付ければ決着しますか

いいえ。廃止予定であることはオーバーロード解決の決め手になりません。候補は適用可能なままで、エラーも同一です。

```csharp
// .NET 10.0.201, C# 14 -- still CS0121
[System.Obsolete("Use Lib")]
public static int WordCount(this string s) => 1;
```

`[Obsolete]` は利用者に呼び出しをやめるよう伝えるには有用ですが、コンパイラーの候補集合には何の影響も与えません。メンバーを IntelliSense から隠すだけの `[EditorBrowsable(EditorBrowsableState.Never)]` も同様です。

## CS0121 ではなく CS0111 が出るのはどんなときですか

両方の宣言が*同じ*静的クラスにあるからです。その場合は曖昧な呼び出しではなく、重複したメンバーになります。

```csharp
// .NET 10.0.201, C# 14
namespace A;

public static class E1
{
    public static int WordCount(this string s) => 1;

    extension(string s)
    {
        public int WordCount() => 2; // CS0111
    }
}
```

```
error CS0111: Type 'E1' already defines a member called 'WordCount' with the same parameter types
```

CS0111 は呼び出し箇所が存在する前に、宣言の位置で報告されます。2 つのエラーのうち親切なのはこちらです。等価性を直接証明してくれるからです。コンパイラーは `WordCount(this string)` とブロックの `WordCount()` を同じパラメーター型を持つものとみなしています。クラスを 1 メソッドずつ移行しているなら、最初に目にするのはこのエラーです。

## 曖昧さが拡張プロパティで起きた場合はどうですか (CS9339)

拡張プロパティには専用の診断があります。メタデータ上で `[ExtensionAttribute]` 付きのメソッドではなく、通常のオーバーロード解決ではなく拡張メンバー探索によって解決されるからです。

```csharp
// N1.cs -- .NET 10.0.201, C# 14
namespace N1;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// N2.cs -- .NET 10.0.201, C# 14
namespace N2;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using N1;
using N2;

var sb = new System.Text.StringBuilder();
sb.Cap = 64; // CS9339
```

```
error CS9339: The extension resolution is ambiguous between the following members:
'N1.E.extension(System.Text.StringBuilder).Cap' and 'N2.E.extension(System.Text.StringBuilder).Cap'
```

修正の形は同じですが、クラス名を伴うプロパティ構文が存在しないため、アクセサーを名指しする必要があります。

```csharp
// .NET 10.0.201, C# 14 -- disambiguated, prints 64
N1.E.set_Cap(sb, 64);
System.Console.WriteLine(N1.E.get_Cap(sb));
```

`get_` と `set_` のアクセサーメソッドはブロックが落とし込まれる先そのものなので、これらを呼ぶのは裏技ではなく本物のメンバーを呼ぶ行為です。ただし十分に不格好なので、重複の一方を取り除くまでの一時的な回避策として扱うべきです。これらの宣言をどう形づくるか検討中なら、[C# 14 で拡張プロパティを宣言する方法](/ja/2026/06/how-to-declare-extension-properties-in-csharp-14/)が、自動プロパティが拒否される理由とアクセサーにできることを解説しています。

## より具体的なレシーバー型なら決着しますか

はい。だからこそ壊れるのが一部の呼び出し箇所だけなのです。オーバーロード解決は今もレシーバーからのより良い変換を優先し、その比較は両方の構文をまたいで行われます。`string` に対する拡張ブロックは `IEnumerable<char>` に対する `this` パラメーター形式のメソッドに勝ちます。

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class E
{
    public static string Describe(this System.Collections.Generic.IEnumerable<char> s) => "IEnumerable<char>";
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class E
{
    extension(string s)
    {
        public string Describe() => "string";
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("x".Describe()); // prints: string
```

ジェネリックな `this` パラメーター形式のメソッドは、同じレシーバーに対する具体的な拡張ブロックには負けますが、それ以外のレシーバー型に対しては引き続き勝ちます。

```csharp
// .NET 10.0.201, C# 14
// G1.E: public static string Kind<T>(this T value) => "generic this-method";
// G2.E: extension(string s) { public string Kind() => "extension block on string"; }

System.Console.WriteLine("x".Kind()); // extension block on string
System.Console.WriteLine(42.Kind());  // generic this-method
```

つまりレシーバーを `IEnumerable<T>` から具体的な型へ変える移行は、エラーをまったく出さずに一部の呼び出し箇所を新しい実装へ静かに移してしまいます。構文のリファクタリングに見えるものの中に振る舞いの変更が隠れているわけで、コンパイルではなくテストで確かめる価値があります。

## インスタンスメソッドなら決着しますか

インスタンスメンバーは、どちらの構文であれ常に拡張メンバーに勝ち、診断も出ません。依存関係の後のバージョンでその型が一致するシグネチャのインスタンスメソッドを獲得すると、あなたの拡張宣言は両方とも到達不能になり、何も警告してくれません。

```csharp
// .NET 10.0.201, C# 14
public class Order { public decimal Total() => 10m; }
public static class E1 { public static decimal Total(this Order o) => 20m; }
public static class E2 { extension(Order o) { public decimal Total() => 30m; } }

// new Order().Total() prints 10
```

このプログラムは警告なしにコンパイルでき、`10` を出力します。CS0121 の鏡像です。曖昧な拡張メンバー 2 つは騒がしく、隠された 2 つは静かです。これは[Span を伴う C# 14 のオーバーロード解決の破壊的変更](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)と同じ種類のアップグレード時の落とし穴で、あちらでは新しい暗黙の変換が既存の呼び出しを静かに結び直します。

## このエラーを完全に避ける移行順序は何ですか

1. 宣言はコピーせず移動してください。静的クラスから `this` メソッドを切り取り、本体を同じクラスの `extension` ブロックへ貼り付けます。この手順をしくじれば CS0111 がすぐ捕まえてくれます。だからこそ新しいクラスを起こすより、1 つのクラスの中で移行するほうが安全です。
2. 静的クラス 1 つを丸ごと単位に移行してください。半分だけ移行したクラスは問題ありません。並行する「V2」クラスを持つ半分だけ移行した*名前空間*こそが CS0121 の出どころです。
3. 古いクラスの隣に `New` や `V2` の拡張クラスを決して作らないでください。互換性を保つ相手など存在しないので、並行クラスが買えるのは曖昧さだけです。
4. 移動が終わったら、呼び出し箇所に手を付ける前に `dotnet build` でソリューションをビルドしてください。まだコンパイルできる呼び出し箇所は、落とし込みが一致した証拠です。
5. コンパイラーだけでなくテストも走らせてください。上のレシーバー特定性の規則は、移行がビルドを壊さずに実行される実装を変えうることを意味します。

より大きな移行の一部としてこれを行うなら、[.NET 8 から .NET 11 への移行チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)が言語バージョンの引き上げをランタイムやパッケージの更新に対してどう並べるかを示しています。このエラーが他の 20 個と一緒に押し寄せるのを防ぐ順序です。

## 関連記事

- [C# 14 の拡張メンバー: 拡張プロパティ、演算子、静的拡張](/ja/2026/02/csharp-14-extension-members/) は、この記事が扱っていない演算子形式や静的メンバー形式も含めた機能の全体像です。
- [C# 14 で拡張プロパティを宣言する方法](/ja/2026/06/how-to-declare-extension-properties-in-csharp-14/) は、`get_` と `set_` による曖昧さ解消の背後にあるアクセサーの規則です。
- [.NET 11 Preview 6 の C# 15 拡張インデクサー](/ja/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/) は、拡張ブロック構文の行き先です。
- [Fix: Span と ReadOnlySpan を伴う C# 14 のオーバーロード解決の破壊的変更](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) は、既存の呼び出し箇所を結び直すもう 1 つの C# 14 の変更です。
- [.NET 8 から .NET 11 への移行: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) は、言語バージョンの引き上げを並べる順序です。

## 出典

- [Resolve errors and warnings related to extension declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/extension-declarations) (MS Learn)。CS9339 と拡張ブロックの CS93xx 系診断が一覧されています。
- [Extension methods](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) (MS Learn)。2 つの宣言構文と曖昧さ解消の指針が書かれています。
- [C# 14: exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) (.NET Blog)。`get_` 接頭辞付き静的メソッドへの落とし込みを記述し、拡張メソッドを新構文へ変換しても利用者を壊さないという設計目標を確認しています。
- [Extensions discussion](https://github.com/dotnet/csharplang/discussions/8696) (dotnet/csharplang)。この機能の設計スレッドです。
