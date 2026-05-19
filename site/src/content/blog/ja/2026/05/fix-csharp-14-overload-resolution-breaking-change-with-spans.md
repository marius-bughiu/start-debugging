---
title: "修正: Span と ReadOnlySpan による C# 14 のオーバーロード解決の破壊的変更"
description: "C# 14 / .NET 10 にアップグレードした後、array.Contains、x.Reverse()、MemoryMarshal.Cast などの呼び出しが突然異なるオーバーロードにバインドされたり、コンパイルできなくなったりします。何が変わったのか、そして必要に応じて以前の動作を固定する方法を説明します。"
pubDate: 2026-05-19
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet-10"
  - "spans"
  - "breaking-changes"
lang: "ja"
translationOf: "2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans"
translatedBy: "claude"
translationDate: 2026-05-19
---

C# 14 (.NET 10、Roslyn 4.13、Visual Studio 17.13 に同梱) にプロジェクトをアップグレードすると、次の 3 つのうちのいずれかが起こります。以前はコンパイルされて実行できていた `Expression<Func<int[], int, bool>>` が実行時にスローするようになる、`MemoryMarshal.Cast(array)` の呼び出しが曖昧エラーでコンパイルできなくなる、または `xUnit` の `Assert.Equal([2], myArray)` が "成功" から "Assert.Equal オーバーロード間で曖昧な一致" に変わる、です。これらはすべて同じ破壊的変更です。C# 14 のファーストクラス Span 型により、オーバーロード解決、型推論、拡張メソッドのバインディング中に `T[]` が `Span<T>` と `ReadOnlySpan<T>` に暗黙的に変換できるようになり、以前は曖昧でなかったコードでもどのオーバーロードが選ばれるかが変わります。

この記事では、実際の .NET 10 アップグレードで遭遇した 4 つのシナリオを取り上げ、それぞれの最小再現コードと推奨される修正方法を示します。すべての例は、特に明記のない限り `<LangVersion>14.0</LangVersion>` と `<TargetFramework>net10.0</TargetFramework>` を対象とします。

## C# 14 が異なるオーバーロードを選ぶ理由

C# 13 以前では、`T[]` から `Span<T>` および `ReadOnlySpan<T>` へのユーザー定義の暗黙的変換 (ランタイムで `op_Implicit` として宣言) は、言語定義ではなくライブラリ定義として扱われていました。コンパイラはオーバーロード解決、型推論、拡張メソッドのバインディング中にこれらを考慮しませんでした。これが、.NET 10 より前では、`IEnumerable<T>` オーバーロードも持つメソッドの Span オーバーロードを呼びたいときに `myArray.AsSpan().BinarySearch(...)` と書く必要があった理由です。コンパイラはこの変換を認識できないため、暗黙のうちに非 Span オーバーロードを選んでいました。

C# 14 の [ファーストクラス Span 型の提案](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md) は、これらの変換を言語レベルに昇格させます。具体的には、アップグレード後、コンパイラはオーバーロード解決時に以下の変換を考慮するようになります。

- `T[]` から `Span<T>` へ
- `T[]` から `ReadOnlySpan<T>` へ
- `T[]` から `ReadOnlySpan<U>` へ (`T` が `U` への参照変換可能な場合)
- `Span<T>` から `ReadOnlySpan<T>` へ
- `string` から `ReadOnlySpan<char>` へ

タイブレーカーのルールも追加されています。同じ引数に対して `Span<T>` と `ReadOnlySpan<T>` の両方のオーバーロードが適用可能な場合、`ReadOnlySpan<T>` が優先されます。この優先順位の理由は後述しますが (共変配列)、頭に入れておいてください。

Roslyn チームはこれを [動作上の破壊的変更](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution) として、また [C# 13 以降のコンパイラの破壊的変更](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010) の一覧に記載しています。"この解決が変わりました" という単一のコンパイラ エラーコードは存在しません。一部のシナリオでは依然としてサイレントにコンパイルされますが異なるバインディングになり、一部では `CS0121` "呼び出しが曖昧です" を出力し、一部では実行時にスローします。修正方法はどのバケットに該当するかによって異なります。

## バケット 1: 式ラムダが `Enumerable` ではなく `MemoryExtensions` を呼ぶ

これは一番厄介です。コンパイルは問題なく通り、式ツリーが IL にコンパイルされる代わりに解釈されるときにのみ実行時に壊れるからです。

```csharp
// C# 14, .NET 10
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;

Expression<Func<int[], int, bool>> e = (array, num) => array.Contains(num);
var fn = e.Compile(preferInterpretation: true);
fn(new[] { 1, 2, 3 }, 2); // throws at runtime
```

C# 13 では、式ツリー内の `array.Contains(num)` は `System.Linq.Enumerable.Contains<T>(IEnumerable<T>, T)` にバインドされていました。C# 14 では、コンパイラは `int[]` が `ReadOnlySpan<int>` に暗黙的に変換できることを認識するため、より一致するオーバーロードは `System.MemoryExtensions.Contains<T>(ReadOnlySpan<T>, T)` になります。式ツリーは `MemoryExtensions.Contains` を中心に構築されます。解釈 (`preferInterpretation: true`) を要求すると、LINQ 式インタプリタは任意のメソッド呼び出しにおける `ReadOnlySpan<T>` パラメーターを処理できないため、`NotSupportedException` をスローするか、ツリーを変換する一部の EF Core プロバイダーではサポートされていないメソッドに関する `System.InvalidOperationException` をスローします。

修正方法は、ラムダ内で明示的に非 Span オーバーロードにバインドさせることです。動作する 3 つのイディオムがあります。

```csharp
// .NET 10, C# 14
M((array, num) => ((IEnumerable<int>)array).Contains(num)); // cast forces Enumerable.Contains
M((array, num) => array.AsEnumerable().Contains(num));      // ditto, slightly less ugly
M((array, num) => Enumerable.Contains(array, num));         // explicit static call, no extension lookup

void M(Expression<Func<int[], int, bool>> e) => e.Compile(preferInterpretation: true);
```

3 つすべてが、`MemoryExtensions.Contains` ではなく `Enumerable.Contains` にバインドするようコンパイラを強制します。キャスト版は実行時コストが最も低く (式ツリーにはキャスト ノードが含まれるだけ)、私が最初に手を伸ばすのはこれです。

呼び出し元のために式ツリーを構築するライブラリを保守している場合は、`IQueryable.Provider.Execute` パスと `Compile(preferInterpretation: true)` を使用するコードを監査してください。EF Core 9 以降は IL にコンパイルするため、ほとんどの EF Core クエリは影響を受けませんが、サードパーティの式インタプリタは影響を受けます。

## バケット 2: `xUnit` Assert.Equal が曖昧になる

xUnit テストでこのようなコードを書いたことがあるなら、トリップワイヤーが仕掛けられています。

```csharp
// .NET 10, C# 14, xUnit 2.9+
var x = new long[] { 1 };
Assert.Equal([2], x);
// CS0121: The call is ambiguous between the following methods or properties:
// 'Assert.Equal<T>(T[], T[])' and 'Assert.Equal<T>(ReadOnlySpan<T>, Span<T>)'
```

両方のオーバーロードが適用可能です。コレクション式 `[2]` は `long[]` または `Span<long>` をターゲット型にできます。変数 `x` は `long[]` で、`T[]` または `Span<T>` のいずれにも暗黙的に変換可能です。単一の最適なオーバーロードが存在しないため、`CS0121` が発生します。

推奨される回避策は、いずれかの引数を明確化することです。

```csharp
// .NET 10, C# 14
var x = new long[] { 1 };
Assert.Equal([2], x.AsSpan());   // binds to (ReadOnlySpan<T>, Span<T>)
// or
Assert.Equal<long>([2], x);      // generic argument disambiguates to (T[], T[]) when no Span overload matches T
```

`T[]` と `ArraySegment<T>` を混在させる場合の、より微妙な変種もあります。

```csharp
// .NET 10, C# 14
var y = new int[] { 1, 2 };
var s = new ArraySegment<int>(y, 1, 1);
Assert.Equal(y, s); // previously bound to Assert.Equal<T>(T, T), now ambiguous with Assert.Equal<T>(Span<T>, Span<T>)
Assert.Equal(y.AsSpan(), s); // workaround
```

`ArraySegment<int>` は `Span<int>` と `ReadOnlySpan<int>` の両方への暗黙的変換を持ち、`int[]` も今やそれを持つため、Span オーバーロードが適用可能となり、ジェネリックな `T, T` のものと競合します。

API のサーフェスを所有している (`Assert.Equal` を書いた) 場合、正しい修正は解決にバイアスをかけるために、いずれかのオーバーロードに [`OverloadResolutionPriorityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute) を適用することです。xUnit はまさにこの理由で 2.9.x にこれを出荷しました。API を再コンパイルできない場合は、呼び出し側で明確化する必要があります。

## バケット 3: 共変配列が `ArrayTypeMismatchException` をスローする

これは実際にデータを破壊するバグであり、言語委員会が C# 14 のタイブレークで `ReadOnlySpan<T>` を `Span<T>` より優先させた理由です。

```csharp
// .NET 10, C# 14
using System;
using System.Collections.Generic;
using System.Linq;

string[] s = new[] { "a" };
object[] o = s; // array variance: legal since C# 1

C.R(o);             // C# 13: prints 1 (IEnumerable overload). C# 14: ArrayTypeMismatchException
C.R(o.AsEnumerable()); // workaround

static class C
{
    public static void R<T>(IEnumerable<T> e) => Console.Write(1);
    public static void R<T>(Span<T> s)        => Console.Write(2);
}
```

何が起きているか。`object[] o` は実体としては `string[]` です。C# 13 では、適用可能な唯一のオーバーロードは `R<T>(IEnumerable<T>)` だったため、`1` を出力していました。C# 14 では、`T[]` が `Span<T>` に暗黙的に変換できるため、`R<T>(Span<T>)` も適用可能になります。コンパイラは Span オーバーロード ("より具体的") を選び、`Span<object>(o)` コンストラクター呼び出しを挿入しますが、コンストラクターは `string[]` バッキングに `object` を書き込めないため、実行時に `System.ArrayTypeMismatchException` をスローします。

これが C# 14 のタイブレーク ルールが `Span<T>` より `ReadOnlySpan<T>` を優先する理由です。`ReadOnlySpan<T>` はバッキング配列に書き込めないため、共変配列でも安全です。API を制御している場合の推奨される修正は、`ReadOnlySpan<T>` オーバーロードを追加することです。

```csharp
// .NET 10, C# 14
static class C
{
    public static void R<T>(IEnumerable<T> e)    => Console.Write(1);
    public static void R<T>(Span<T> s)           => Console.Write(2);
    public static void R<T>(ReadOnlySpan<T> s)   => Console.Write(3); // wins over Span<T> in C# 14
}
```

これで `C.R(o)` は `3` を出力します (例外なし)。オーバーロードを追加できない場合、呼び出し側の修正は `o.AsEnumerable()` または `((IEnumerable<object>)o)` です。

## バケット 4: `MemoryMarshal.Cast` と ReadOnlySpan のタイブレーク

`ReadOnlySpan<T>` の優先順位は、`Span<T>` を渡すことで呼び出し側がどちらかのオーバーロードを選ぶことを意図したライブラリ パターンの一部も壊します。

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

double[] x = new double[0];
Span<ulong> y = MemoryMarshal.Cast<double, ulong>(x);
// CS0029: Cannot implicitly convert type 'ReadOnlySpan<ulong>' to 'Span<ulong>'
Span<ulong> z = MemoryMarshal.Cast<double, ulong>(x.AsSpan()); // workaround
```

`MemoryMarshal.Cast` には `Cast<TFrom, TTo>(Span<TFrom>)` と `Cast<TFrom, TTo>(ReadOnlySpan<TFrom>)` の両方があります。C# 13 では、`double[]` を渡すと `Span<TFrom>` へのユーザー定義変換を経由して解決されました。タイブレークがなく、`Span<T>` が "直接的な" ターゲットだったからです。C# 14 では、新しい組み込み変換により両方のオーバーロードが適用可能になり、`ReadOnlySpan<T>` オーバーロードがタイブレークに勝ち、結果として `Span<ulong>` ローカルに代入できなくなります。明示的に `.AsSpan()` を呼んで配列から Span への変換をスキップする (これは直接 `Span<double>` を生成し、`Span` オーバーロードのみに一致します) か、可変性が不要であればローカルの型を `ReadOnlySpan<ulong>` に変更します。

## ダウンレベル ターゲット向けの `Enumerable.Reverse` のコーナー ケース

サポートされていない構成にしか影響しませんが、レガシー移行プロジェクトで現れるため、フラグを立てておく価値のあるもう 1 つの落とし穴があります。`<LangVersion>14.0</LangVersion>` を設定しつつ、`System.Memory` 参照を持つ `net8.0` のような古い TFM をターゲットにすると、次のことが起こります。

```csharp
// LangVersion 14, TargetFramework net8.0 (unsupported)
int[] x = new[] { 1, 2, 3 };
var y = x.Reverse(); // C# 13: Enumerable.Reverse, returns IEnumerable<int>
                     // C# 14: MemoryExtensions.Reverse, void in-place reverse
```

`MemoryExtensions.Reverse(Span<T>)` は in-place で逆順化し `void` を返しますが、`Enumerable.Reverse(IEnumerable<T>)` は逆順化されたシーケンスを返します。セマンティクスが反転し、`y` は反復可能でなくなります。`net10.0` ではこれは優先される新しい `Enumerable.Reverse(this T[])` オーバーロードによってパッチされているため、新しいコンパイラと古い BCL を混在させた場合にのみこの破壊が表面化します。正しい修正は TFM をアップグレードすることですが、それができない場合は明示的に `Enumerable.Reverse(x)` を呼ぶか、自分の名前空間に `Reverse(this T[])` 拡張を定義してください。

## 実行時より前に検出する

進行中のアップグレードのための実用的な軽減策をいくつか紹介します。

- トリアージ中は個々のプロジェクトに `<LangVersion>13.0</LangVersion>` を設定してください。Span に関連しない C# 14 の機能 (ラムダ パラメーター修飾子、部分コンストラクター、`field` キーワード) は無効になりますが、解決は予測可能なままです。
- Roslyn アナライザー [CA1872](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1872) と ReSharper/Rider の検査 ["C# 14 breaking change in overload resolution with span parameters"](https://www.jetbrains.com/help/resharper/CSharp14OverloadResolutionWithSpanBreakingChange.html) をオンにしてください。Rider の検査は、新しい変換によって選択されるオーバーロードが変わる呼び出しサイトを具体的にハイライトします。
- `Compile(preferInterpretation: true)` と、サードパーティの式ツリー コンシューマー (古い EF6 プロバイダー、Marten 6.x、Linq2DB pre-5.x など) を監査してください。これらは変更がコンパイル時にサイレントである、最もリスクの高い場所です。
- テスト スイートで `Assert.Equal(`、`Assert.Contains(`、および類似のコレクション型アサーションを検索してください。`OverloadResolutionPriorityAttribute` アノテーションを持つバージョン (xUnit 2.9.x 以降) に xUnit をアップグレードしてください。

API 作者であれば、最もクリーンな長期的修正は既存の `Span<T>` の隣に `ReadOnlySpan<T>` オーバーロードを追加し、呼び出し元にバインドさせたい方に `[OverloadResolutionPriority(1)]` を適用することです。この属性は C# 13 および C# 14 のコンパイラで尊重されます (古い `LangVersion` 設定では無視されるという 1 つの注意点はありますが)、ほとんどの移行シナリオをカバーします。

## 関連記事

これらの変換がそもそもなぜ存在するのかの背景については、[C# 14 における暗黙的な Span 変換と Span / ReadOnlySpan のファーストクラス サポート](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) の詳細解説が完全な変換テーブルと動機をカバーしています。より広範な [C# 14 の新機能](/ja/2024/12/csharp-14/) の記事には、同じアップグレードで予期すべき他の破壊的変更 (`scoped` ラムダ パラメーター修飾子や `field` コンテキスト キーワードなど) が一覧にされています。今後の言語のプレビューとしては、[C# 15 のコレクション式の引数](/ja/2026/04/csharp-15-collection-expression-arguments/) がこれらの Span ルールの上に構築されており、コンパイラが Span ターゲットと非 Span ターゲットの間でどのように選択するかに慣れたら読む価値があります。

## ソース

- [Breaking change: C# 14 overload resolution with span parameters (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [C# compiler breaking changes since C# 13 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010)
- [First-class span types proposal (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [Issue dotnet/docs#43952: covariant array overload selection](https://github.com/dotnet/docs/issues/43952)
- [OverloadResolutionPriorityAttribute (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [Rider inspection: C# 14 overload resolution with span parameters (JetBrains)](https://www.jetbrains.com/help/rider/CSharp14OverloadResolutionWithSpanBreakingChange.html)
