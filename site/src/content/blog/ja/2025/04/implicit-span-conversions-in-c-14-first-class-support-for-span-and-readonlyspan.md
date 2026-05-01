---
title: "C# 14 における暗黙的な Span 変換: Span と ReadOnlySpan の第一級サポート"
description: "C# 14 では Span、ReadOnlySpan、配列、文字列の間で組み込みの暗黙的変換が追加され、より整然とした API、より優れた型推論、AsSpan() の手書き呼び出しの削減が可能になります。"
pubDate: 2025-04-06
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan"
translatedBy: "claude"
translationDate: 2026-05-01
---
**C# 14** は高パフォーマンスなコードに対する重要な強化を導入します。すなわち、span に対する第一級の言語サポートです。特に、**`Span<T>`**、**`ReadOnlySpan<T>`**、配列 (`T[]`) の間に新しい **暗黙的な変換** が追加されました。この変更により、追加のアロケーションなしに安全な連続メモリ片を表すこれらの型を扱うのが格段に容易になります。本記事では、span 変換とは何か、C# 14 でルールがどのように変わったか、そしてそれがあなたのコードにとってなぜ重要なのかを見ていきます。

## 背景: `Span<T>` と `ReadOnlySpan<T>` とは

`Span<T>` と `ReadOnlySpan<T>` は、スタック専用 (参照型) の構造体で、連続するメモリ領域 (たとえば配列、文字列、アンマネージドメモリの一部) を安全に参照できるようにします。これらは C# 7.2 で導入され、**高パフォーマンス・ゼロアロケーション** のシナリオで広く使われるようになりました。**`ref struct`** 型として実装されているため、span はスタック上 (または別の ref struct 内) にしか存在できず、これにより **指しているメモリよりも長く生存することがない** ことが保証され、安全性が保たれます。実際には、可変なメモリ片には `Span<T>` が、読み取り専用のメモリ片には `ReadOnlySpan<T>` が使われます。

**なぜ span を使うのか?** これらを使えば、サブ配列、サブ文字列、バッファーを **データを複製したり新たにメモリを確保したりすることなく** 扱えます。これにより、**型安全性と境界チェックを保ちながら** (生のポインターと違って) パフォーマンスが向上し、GC への圧力も低減されます。たとえば、巨大なテキストやバイナリバッファーの解析を span で行えば、たくさんの小さな文字列やバイト配列を作らずに済みます。.NET の多くの API (ファイル I/O、パーサー、シリアライザーなど) は効率のため span ベースのオーバーロードを提供するようになっています。しかし C# 14 までは、言語自体が span と配列の関係を完全には理解しておらず、コードに定型句を生む原因となっていました。

## C# 14 以前: 手動変換とオーバーロード

これまでの C# でも、span には配列との間でユーザー定義の変換演算子がありました。たとえば、配列 `T[]` は .NET ランタイム内で定義されたオーバーロードによって `Span<T>` や `ReadOnlySpan<T>` に **暗黙的に変換** できました。同様に、`Span<T>` から `ReadOnlySpan<T>` への暗黙変換も可能でした。_では、何が問題だったのでしょうか?_ 問題は、これらがライブラリ定義の変換であり、組み込みの言語変換ではなかった点にあります。C# コンパイラーは特定のシナリオで `Span<T>`、`ReadOnlySpan<T>`、`T[]` を関連型として扱い **ません** でした。そのため C# 14 までは開発者にとっていくつかの煩わしさがありました。

-   **Span/配列に対する拡張メソッド:** `ReadOnlySpan<T>` を `this` パラメーターに取る拡張メソッドを書いた場合、それを配列や `Span<T>` 変数に直接呼び出すことはできませんでした。コンパイラーが拡張メソッドのレシーバーをバインドする際に、配列から span への変換を考慮しなかったためです。実際にはこのため、配列と span 用に **重複したオーバーロード** を提供したり、配列をあらかじめ手で変換してから拡張を呼び出したりする必要がありました。たとえば BCL (Base Class Library) は、`MemoryExtensions` のようなユーティリティメソッドを `ReadOnlySpan<T>` 用、`Span<T>` 用、`T[]` 用と複数の形で提供せざるを得ず、すべての場合で利用可能にしていました。
-   **ジェネリックメソッドと型推論:** ジェネリックメソッドにも同様の摩擦がありました。ジェネリックメソッド `Foo<T>(Span<T> data)` があり、そこに配列 (たとえば `int[]`) を渡そうとしても、コンパイラーは呼び出し位置で正確な `Span<T>` を見ていないため `T` を推論できませんでした。型パラメーターを明示するか、配列に `.AsSpan()` を呼び出すしかありません。`T[]` から `Span<T>` へのユーザー定義の暗黙変換は **型推論** の対象になっていなかったため、コードの利便性が損なわれていました。
-   **明示的な変換が必要:** 多くの場合、開発者は配列や文字列から span を取り出すために、`myArray.AsSpan()` や `new ReadOnlySpan<char>(myString)` のような手動変換を挿入する必要がありました。これらはそれほど複雑ではないものの、コードに雑音を加えますし、いつ変換すべきかは開発者の判断に依存します。型関係がコンパイラーの変換ルールに知られていなかったので、IDE が常にこれらを提案してくれるわけでもありませんでした。

## C# 14 における暗黙的な Span 変換

C# 14 では、**組み込みの暗黙的な span 変換** を言語レベルで導入することでこれらの問題に対処します。コンパイラーが配列と span 型の特定の変換を直接認識するようになり、これは **"第一級の span サポート"** とよく呼ばれます。実用的には、span を期待する API に配列や文字列を自由に渡したり、その逆を行ったりでき、明示的なキャストやオーバーロードは不要です。言語仕様では、新しい _暗黙的な span 変換_ により、`T[]`、`Span<T>`、`ReadOnlySpan<T>`、さらには `string` までもが特定の方法で互いに変換可能になると説明されています。サポートされる暗黙変換は次のとおりです。

-   **配列から Span へ:** 任意の 1 次元配列 `T[]` は `Span<T>` に暗黙変換できます。たとえば `int[]` は `Span<int>` が期待される場所で追加の構文なしに受け入れられます。
-   **配列から ReadOnlySpan へ:** 任意の `T[]` は `ReadOnlySpan<T>` (または `T` が `U` に変換可能なら共変な相当物 `ReadOnlySpan<U>`) にも暗黙変換できます。これにより、同じ要素型の読み取り専用 span を求めるメソッドに配列を渡せます。(ここでの共変性は配列の共変性に似ています。たとえば `string` は `object` の一種なので `String[]` は `ReadOnlySpan<object>` に変換できます。ただしこれはより高度なシナリオです。)
-   **Span から ReadOnlySpan へ:** `Span<T>` は暗黙的に `ReadOnlySpan<T>` (互換性のある参照型では `ReadOnlySpan<U>`) として扱えます。言い換えると、可変な span を、それを読み取るだけの何かに渡せます。この変換は以前から可能でしたが、今ではユーザー定義演算子を介すだけでなく、コンパイラーが多くの文脈で考慮する標準変換になりました。
-   **String から ReadOnlySpan へ:** `string` は `ReadOnlySpan<char>` に暗黙変換できるようになりました。これは文字列データを読み取り専用の文字 span として扱うのに非常に便利です。(内部的には、span が文字列の内部メモリを指しており、C# では文字列が不変であるため安全です。) 以前は文字列に対して `.AsSpan()` を呼ぶか `MemoryExtensions` を使う必要がありましたが、今では必要に応じて自動的に行われます。

これらの変換は言語仕様の _標準暗黙変換_ の一部として **コンパイラーの組み込み変換ルール** に追加されました。決定的に重要なのは、コンパイラーがこれらの関係を理解しているため、**オーバーロード解決**、**拡張メソッドの束縛**、**型推論** において、これらを考慮するということです。要するに、C# 14 は `T[]`、`Span<T>`、`ReadOnlySpan<T>` がある程度互換であることを "知っている" ため、より直感的なコードになります。公式ドキュメントの言葉を借りれば、C# 14 はこれらの型の関係を認識し、span 型を拡張メソッドのレシーバーとして使えるようにしたり、ジェネリック推論を改善したりすることで、これらをより自然に扱えるようにしている、ということです。

## C# 14 の前と後

暗黙的な span 変換によってコードがどれほどすっきりするかを、以前の C# と比較して見てみましょう。

### 1\. Span vs 配列に対する拡張メソッド

`ReadOnlySpan<T>` 用に定義された拡張メソッド (たとえば、span が指定の要素で始まるかをチェックする簡単なもの) を考えます。C# 13 以前ではコンパイラーが拡張のレシーバーに対して変換を適用しなかったため、配列を span として見なせるにもかかわらず、その拡張を配列に直接 **呼び出すことはできません** でした。`.AsSpan()` を呼ぶか、別のオーバーロードを書く必要がありました。C# 14 では自然に動作します。

```cs
// Extension method defined on ReadOnlySpan<T>
public static class SpanExtensions {
    public static bool StartsWith<T>(this ReadOnlySpan<T> span, T value) 
        where T : IEquatable<T>
    {
        return span.Length != 0 && EqualityComparer<T>.Default.Equals(span[0], value);
    }
}

int[] arr = { 1, 2, 3 };
Span<int> span = arr;        // Array to Span<T> (always allowed)
// C# 13 and earlier:
// bool result1 = arr.StartsWith(1);    // Compile-time error (not recognized)
// bool result2 = span.StartsWith(1);   // Compile-time error for Span<T> receiver
// (Had to call arr.AsSpan() or define another overload for arrays/spans)
bool result = arr.StartsWith(1);       // C# 14: OK - arr converts to ReadOnlySpan<int> implicitly
Console.WriteLine(result);            // True, since 1 is the first element
```

上のスニペットでは、拡張メソッドが `ReadOnlySpan<int>` の **レシーバー** を期待するため、古い C# では `arr.StartsWith(1)` はコンパイルできません (CS8773 エラー)。C# 14 では、コンパイラーが `int[]` (`arr`) を拡張のレシーバーパラメーターに合うように暗黙で `ReadOnlySpan<int>` に変換します。同じことが、`ReadOnlySpan<T>` 用の拡張を呼ぶ `Span<int>` 変数についても言えます。`Span<T>` は実行時に `ReadOnlySpan<T>` に変換できます。つまり、(`T[]` 用、`Span<T>` 用などの) 重複した拡張メソッドを書いたり、呼び出すために手で変換したりする必要はもうありません。コードはより明瞭で簡潔になります。

### 2\. Span を使ったジェネリックメソッドの型推論

暗黙的な span 変換は **ジェネリックメソッド** にも役立ちます。任意の型の span を扱うジェネリックメソッドがあるとします。

```cs
// A generic method that prints the first element of a span
void PrintFirstElement<T>(Span<T> data) {
    if (data.Length > 0)
        Console.WriteLine($"First: {data[0]}");
}

// Before C# 14:
int[] numbers = { 10, 20, 30 };
// PrintFirstElement(numbers);        // ❌ Cannot infer T in C# 13 (array isn't Span<T>)
PrintFirstElement<int>(numbers);      // ✅ Had to explicitly specify <int>, or do PrintFirstElement(numbers.AsSpan())

// In C# 14:
PrintFirstElement(numbers);           // ✅ Implicit conversion allows T to be inferred as int
```

C# 14 以前では、呼び出し `PrintFirstElement(numbers)` はコンパイルできませんでした。型引数 `T` が推論できないからです。パラメーターは `Span<T>` で、`int[]` は直接 `Span<T>` ではありません。型パラメーター `<int>` を指定するか、自分で配列を `Span<int>` に変換する必要がありました。C# 14 では、コンパイラーが `int[]` を `Span<int>` に変換できることを認識し、自動的に `T` = `int` と推論します。これにより、span を扱うジェネリックなユーティリティを、特に配列を入力として与えるときに、ずっと使いやすくなります。

### 3\. Span API へ文字列を渡す

もう一つよくあるシナリオが、文字列を読み取り専用の文字 span として扱うことです。多くの解析・テキスト処理 API は効率のため `ReadOnlySpan<char>` を使います。これまでの C# では、こうした API に `string` を渡すには文字列に対して `.AsSpan()` を呼ぶ必要がありました。C# 14 ではその必要がなくなります。

```cs
void ProcessText(ReadOnlySpan<char> text)
{
    // Imagine this method parses or examines the text without allocating.
    Console.WriteLine(text.Length);
}

string title = "Hello, World!";
// Before C# 14:
ProcessText(title.AsSpan());   // Had to convert explicitly.
// C# 14 and later:
ProcessText(title);            // Now implicit: string -> ReadOnlySpan<char>

ReadOnlySpan<char> span = title;         // Implicit conversion on assignment
ReadOnlySpan<char> subSpan = title[7..]; // Slicing still yields a ReadOnlySpan<char>
Console.WriteLine(span[0]);   // 'H'
```

`string` を `ReadOnlySpan<char>` として暗黙的に扱える機能は、新しい span 変換サポートの一部です。これは実世界のコードで特に役立ちます。たとえば、`int.TryParse(ReadOnlySpan<char>, ...)` や `Span<char>.IndexOf` のようなメソッドを文字列引数で直接呼び出せるようになります。`AsSpan()` の呼び出しといった雑音を取り除いてコードの可読性を向上させ、不要な文字列のアロケーションやコピーが発生しないことも保証します。変換はゼロコストで行われ、元の文字列のメモリへの窓を提供するに過ぎません。

## Span 変換から恩恵を受ける現実のユースケース

C# 14 における暗黙の span 変換は、単なる言語の理論的な調整ではなく、さまざまなプログラミングシナリオに実用的な影響を及ぼします。

-   **高パフォーマンスなパースとテキスト処理:** テキスト (CSV/JSON パーサー、コンパイラーなど) を解析するライブラリやアプリケーションでは、サブ文字列を作らないために `ReadOnlySpan<char>` を使うことがよくあります。暗黙変換のおかげで、こうした API はシームレスに `string` 入力を受け取れます。たとえば、JSON パーサーが `Parse(ReadOnlySpan<char> json)` という単一のメソッドを持っていれば、呼び出し側は追加のオーバーロードやコピーなしに、`string` でも `char[]` でも、より大きなバッファーのスライスでも与えられます。
-   **メモリ効率の良い API:** .NET では、ファイルやネットワークからバッファーへ読み込むなど、データをチャンク単位で処理する API がよく見られます。これらは入出力に `Span<byte>` を使ってアロケーションを避けることがあります。C# 14 のおかげで、既存のデータが `byte[]` にあれば、それを直接 span ベースの API に渡せます。逆に、API が `Span<T>` や `ReadOnlySpan<T>` を返せば、それを配列や読み取り専用 span を期待する別のコンポーネントに簡単に渡せます。**エルゴノミクス** が span の利用を後押しし、メモリのやり取りが減ります。要するに、配列や文字列と自然に連携する span 中心の API を一本設計でき、コードベースが整然と保てます。
-   **相互運用と unsafe シナリオ:** アンマネージドコードやハードウェアインターフェースとやり取りする際は、生のバッファーを扱うことがよくあります。span はそうしたバッファーを C# で安全に表現する方法です。たとえば、バイト配列を埋めるネイティブメソッドを呼び出すとき、暗黙変換のおかげで P/Invoke のシグネチャを `Span<byte>` にしつつ、通常の `byte[]` で呼び出すことができます。これは span の安全性 (バッファーオーバーランの回避など) を提供しつつ、利便性も保ちます。低レベルなシナリオ (バイナリプロトコルや画像データの解析など) では、異なるメモリソースを span として一様に扱えることでコードが簡潔になります。
-   **.NET ライブラリ全般の利用:** .NET BCL 自体も恩恵を受けます。チームは span を扱うメソッドについて、配列、span、読み取り専用 span のための複数オーバーロードではなく、単一のオーバーロードを提供できるようになります。たとえば、span 用の `.StartsWith()` 拡張 (上で見たもの) や `System.MemoryExtensions` のメソッドは、`ReadOnlySpan<T>` 上に一度定義すれば、`T[]` や `Span<T>` 入力に対して自動的に動作します。これは API のサーフェスを縮小し、不整合の余地も減らします。`public void Foo(ReadOnlySpan<byte> data)` のようなシグネチャを見たときに、配列版の `Foo` があるかどうか悩む必要はもうありません。C# 14 では `byte[]` を渡せばそのまま動きます。

## 暗黙的な Span 変換のメリット

**読みやすさの向上:** この機能の最も直接的なメリットは、コードがすっきりすることです。span を消費する API に配列や文字列を渡すという、自然に感じられる書き方をするだけで、ちゃんと動きます。変換ヘルパーを呼ぶことや複数のオーバーロードを用意することを覚えておく必要がないため、認知的負荷が減ります。拡張メソッドのチェーンも直感的になります。全体として、span を使うコードは読み書きしやすくなり、より "普通の" C# コードに見えるようになります。これは摩擦を減らすことで、(パフォーマンスのために span を使う) ベストプラクティスを後押しします。

**ミスの減少:** 変換をコンパイラーに任せることで、エラーの余地が減ります。たとえば、開発者が `.AsSpan()` を呼び忘れて、つい効率の悪いオーバーロードを呼んでしまうことがあるかもしれませんが、C# 14 ではあてはまる場面で意図した span のオーバーロードが自動的に選ばれます。一貫した挙動でもあります。変換は安全であることが保証されています (データのコピーなし、適切な場合を除き null の問題なし)。型が互換になったため、ツールや IDE は span ベースのオーバーロードを適切に提案できるようになります。すべての暗黙変換は無害になるよう設計されています。データを変えたり実行時コストを生んだりせず、既存のメモリバッファーを span のラッパーで再解釈するだけです。

**安全性とパフォーマンス:** span は **安全に** パフォーマンスを向上させるために作られたものであり、C# 14 のアップデートはその哲学を引き継ぎます。暗黙変換は型安全性を損ないません。互換性のない型 (たとえば `int[]` から `Span<long>`) は、実際の再解釈が必要となるため、許されたとしても明示変換のみです。span 型自体が、読み取り専用であるべきものを誤って変更できないようにします (配列を `ReadOnlySpan<T>` に変換すれば、呼び出した API は配列を変更できません)。さらに、span はスタック専用なので、コンパイラーはデータより長く生きうる長寿命の変数 (フィールドなど) に span を保存しないことを強制します。span を使いやすくすることで、C# 14 は unsafe ポインターに頼らずとも高パフォーマンスなコードを書くことを実質的に推奨し、C# 開発者が期待するメモリ安全性の保証を維持します。

**拡張メソッドとジェネリック:** 強調したように、span は拡張メソッドの解決とジェネリック型推論に完全に参加できるようになりました。これは、拡張メソッドを使う流暢な API や LINQ ライクなパターンが、span/配列を交換可能に直接扱えることを意味します。ジェネリックなアルゴリズム (ソート、検索など) を span で書きつつ、配列引数で問題なく呼び出せます。最終的に、コードのパスを統一できます。配列用と span 用に別々のパスを持つ必要はありません。1 つの span ベースの実装ですべてをカバーでき、より安全で (誤りが入り込みうるコードが減り)、より速い (最適化された 1 本のコードパスになる) です。

## あなたのコードに何が変わるか

C# 14 における暗黙の span 変換の導入は、パフォーマンスに敏感なコードを書く開発者にとって朗報です。コンパイラーに型同士の関係を理解させることで、配列、文字列、span 型の間の **隔たりを埋めます**。以前のバージョンと違って、コードに手書きの `.AsSpan()` を散りばめたり、span と配列のために並行する複数のメソッドオーバーロードを保守したりする必要はもうありません。代わりに、明確な単一の API を書き、異なるデータ型を渡されたときに言語が正しいことをしてくれることを信頼します。

実用上は、メモリ片を扱う際により表現力豊かで簡潔なコードになります。テキストの解析でも、バイナリデータの処理でも、日常的なコードで不要なアロケーションを避けようとしているときでも、C# 14 の第一級の span サポートは Span ベースのプログラミングをより _自然_ に感じさせます。これは、開発者の生産性とランタイムのパフォーマンスをともに改善し、しかもコードを安全で堅牢に保つ言語機能の優れた例です。span が配列や文字列からシームレスに変換できるようになった今、これまで以上に少ない摩擦で、こうした高パフォーマンス型をコードベース全体で活用できます。

**参考資料:**

-   [C# 14 Feature Specification – _First-class Span types_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/first-class-span-types#:~:text=recognize%20the%20relationship%20between%20%60ReadOnlySpan,a%20lot%20of%20duplicate%20surface)
-   [_What's new in C# 14: More implicit conversions for Span<T>_](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#implicit-span-conversions#:~:text=%60Span,with%20generic%20type%20inference%20scenarios)
-   [What's new in C# 14](/2024/12/csharp-14/)
