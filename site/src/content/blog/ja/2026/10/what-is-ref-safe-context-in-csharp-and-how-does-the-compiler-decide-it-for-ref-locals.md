---
title: "C# の ref-safe-context とは何か、コンパイラーは ref ローカルのそれをどう決めるのか"
description: "ref-safe-context は、変数への参照が有効であり続けるスコープです。4 つのコンテキスト、ref ローカルのコンテキストが初期化子で固定されるというルール、ref 再代入がコンテキストを広げることも狭めることもできない理由、そこから生じる CS8157、CS8168、CS8374、CS9079 のエラーを、C# 14 と .NET 10、.NET 11 RC1 のコンパイラー出力とともに解説します。"
pubDate: 2026-10-15
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "ja"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---

結論から言うと、ref-safe-context (参照の安全コンテキスト) とは、ある変数への参照 (`ref` ローカル、`ref` 戻り値、`ref` フィールド) が生きたメモリを指していることが保証されるコード上の範囲です。C# コンパイラーはすべての変数に、狭い順に declaration-block、function-member、return-only、caller-context の 4 つのコンテキストのいずれかを割り当てます。`ref` ローカルは独自のコンテキストを持ちません。初期化に使われた式の ref-safe-context をそのままコピーし、そのコンテキストは以後ずっと固定され、後から行う `r = ref other;` はすべて、少なくとも同じ広さのコンテキストを持つものを指さなければなりません。この 1 つのルールで、スタックローカルから初期化した `ref` ローカルは、後で配列要素に再代入したとしても返せない理由が説明できます。

この記事のすべての結果は実際のビルドによるものです。.NET 10 SDK 10.0.302 に `<LangVersion>14</LangVersion>` を指定したものと、同じファイルを .NET 11 RC1 SDK (11.0.100-rc.1.26425.128) で再ビルドしたものです。診断は両方で同一で、言い換えではなくコンパイラー出力をそのまま貼っています。

## コンパイラーがそもそも"コンテキスト"を追跡する理由

C# の `ref` はマネージドポインターです。ヒープ (配列要素やクラスインスタンスのフィールド)、静的ストレージ、スタックフレーム (ローカルやパラメーター) のいずれかを指せます。ヒープと静的メモリはメソッド呼び出しより長く生きますが、スタックフレームはメソッドが戻ると消えます。もしメソッドが自分のローカルへの `ref` を返せるとすると、呼び出し元は破棄済みのフレームを指すポインターを持つことになります。これは `ref` が避けるよう設計された use-after-free バグそのものです。

C# はこれを実行時チェックではなく静的に解決します。各変数に、その参照がどこまで伝わってよいかを表す ref-safe-context が与えられ、参照を格納または返すすべての箇所で、参照先のコンテキストが参照自身のコンテキスト以上に広いことが検査されます。C# 標準は [section 9.7.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) でこれを 1 文で述べています。"The referent of a reference variable shall have a ref-safe-context that is at least as wide as the ref-safe-context of the reference variable itself."

関連する概念として safe-context があり、`Span<T>` のような `ref struct` 型の値に適用されます。ref-safe-context は"この変数への参照はいつまで有効か"に答え、safe-context は"この変数に格納された値 (それ自体が参照を含む) はいつまで有効か"に答えます。この記事の大部分は前者についてですが、両者は後述の `Span<T>` インデクサーで交わります。

## 4 つのコンテキスト (狭い順)

| コンテキスト | 対象 | ref で返せるか |
| --- | --- | --- |
| declaration-block | 宣言されたブロックにスコープされる通常のローカル | 不可 |
| function-member | 値パラメーター、`out` パラメーター、構造体メソッド内の `this`、`scoped ref` ローカルとパラメーター | 不可 |
| return-only | `ref` および `in` パラメーター | 可 (`return ref` のみ) |
| caller-context | 配列要素、クラスインスタンスのフィールド、静的フィールド、`ref` パラメーター経由で到達するフィールド | 可 |

見落としやすい点が 2 つあります。1 つ目は、declaration-block は本当にブロックごとだということです。`if` 本体の中で宣言されたローカルは、メソッドの先頭で宣言されたローカルよりも狭いコンテキストを持ちます。2 つ目は、return-only は `ref` パラメーターを返せる (`return ref p;` は合法) 一方で、呼び出し元から渡された `ref struct` の `ref` フィールドのような、呼び出しより長く生きる場所には格納できないようにするために存在する、という点です。このレベルは [low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements) の一部として C# 11 で追加されました。

基本となるコードを示します。すべてのメソッドは C# 14 でコンパイルしています。

```csharp
// .NET 10 SDK 10.0.302, C# 14 (same result on .NET 11 RC1)
class Contexts
{
    int[] _arr = new int[10];
    static int s_counter;

    // declaration-block: error CS8168
    static ref int FromLocal() { int v = 5; return ref v; }

    // function-member (value parameter): error CS8157 once aliased
    static ref int FromValueParam(int p) { ref int r = ref p; return ref r; }

    // return-only (ref parameter): OK
    static ref int FromRefParam(ref int p) { ref int r = ref p; return ref r; }

    // caller-context (array element): OK
    ref int FromArray() { ref int r = ref _arr[3]; return ref r; }

    // caller-context (static field): OK
    static ref int FromStatic() { ref int r = ref s_counter; return ref r; }
}
```

2 つのエラーは次のとおりです。

```text
error CS8168: Cannot return local 'v' by reference because it is not a ref local
error CS8157: Cannot return 'r' by reference because it was initialized to a value that cannot be returned by reference
```

CS8157 の文言をよく読んでください。"because it was initialized to" とあります。コンパイラーは `return` の時点で `r` が何を指しているかを見ているのではなく、`r` が何で初期化されたかを見ています。

## ref ローカルはどのようにコンテキストを得るのか

ローカルに関する標準のルール ([section 9.7.2.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9722-local-variable-ref-safe-context)) は 2 行です。

- `v` が参照変数の場合、その ref-safe-context は初期化式の ref-safe-context と同じです。
- それ以外の場合、その ref-safe-context は declaration-block です。

つまり、コンパイラーが `ref` ローカルのコンテキストを決めるのは宣言の 1 か所だけです。初期化式は次のルールでコンテキストが評価されます。

1. ローカルまたは値パラメーター: それ自身のコンテキスト (declaration-block または function-member)。
2. `ref` または `in` パラメーター: return-only。
3. クラスインスタンスのフィールド `e.F`、配列要素、静的フィールド: caller-context。
4. 構造体のフィールド `e.F`: `e` のコンテキスト。構造体ローカルのフィールドは declaration-block、構造体メソッド内の `this` のフィールドは function-member。
5. 条件式 `c ? ref a : ref b`: `a` と `b` のうち狭い方。
6. `ref` を返すメソッド、プロパティ、インデクサーの呼び出し: caller-context と、すべての `ref` 引数の ref-safe-context (さらにレシーバーを含むすべての引数の safe-context) のうち最も狭いもの。ただし `scoped` および `out` パラメーターに束縛される引数は除きます。

ルール 6 は驚かれやすい点で、何の問題もないヘルパーが `ref` ローカルを"汚染"できることを意味します。

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int Pick(ref int a) => ref a;

static ref int ThroughHelper()
{
    int v = 5;
    ref int r = ref Pick(ref v); // r inherits v's declaration-block context
    return ref r;                // error CS8157
}
```

`Pick` 自体には問題がなく、自分の `ref` パラメーターを返しているだけです。しかしコンパイラーは `Pick` の中身を見ません。見るのはシグネチャだけで、"自分の `ref` 引数のどれかを返しうる `ref` を返す"と解釈されるため、結果のコンテキストは最も狭い引数のコンテキストになり、その引数はローカルです。これが、メソッド呼び出しを経由してスタック参照を"洗浄"することを仕様が防ぐ仕組みです。

ヘルパーが実際にはその引数を返さない場合の解決策は、`scoped` でそれを明示することです。

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int PickSecond(scoped ref int a, ref int b) => ref b;

static ref int Fine(ref int b)
{
    int v = 5;
    ref int r = ref PickSecond(ref v, ref b); // only b contributes: return-only
    return ref r;                             // OK
}
```

`scoped ref` パラメーターは呼び出される側が返すことも捕捉することもできないため、結果のコンテキストには寄与しなくなります。条件演算子にはこのような抜け道はありません。

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Either(bool f)
{
    int v = 1;
    ref int r = ref f ? ref _arr[0] : ref v; // narrowest wins: declaration-block
    return ref r;                            // error CS8157
}
```

## ref 再代入はコンテキストを広げることも狭めることもできない

C# 7.3 以降、`ref` ローカルは `r = ref other;` で別の場所を指すようにできます。[section 9.7.2.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9729-limitations-on-reference-variables) のルールは次のとおりです。"For a ref reassignment `e1 = ref e2`, the ref-safe-context of `e2` shall be at least as wide a context as the ref-safe-context of `e1`." これによってローカルのコンテキストが変わることはありません。そのため、どちらの方向にも影響があります。

**狭めるのはエラーです。** 配列要素で初期化してから、ローカルを指そうとします。

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Narrowing()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    return ref r;
}
```

```text
error CS8374: Cannot ref-assign 'v' to 'r' because 'v' has a narrower escape scope than 'r'.
```

入れ子のブロック間でも同じことが起き、実際のループで遭遇するのはこちらの形です。

```csharp
// .NET 10 SDK 10.0.302, C# 14
static void NestedBlock()
{
    int outer = 1;
    ref int r = ref outer;   // declaration-block of the method body
    {
        int inner = 2;
        r = ref inner;       // error CS8374: inner's block is narrower
    }
}
```

**広げるのは許可されますが、役に立ちません。** ローカルで初期化してから、配列要素を指します。再代入はコンパイルできますが、return はできません。

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Widening()
{
    int v = 1;
    ref int r = ref v;   // declaration-block, fixed forever
    r = ref _arr[0];     // OK: caller-context is wider
    return ref r;        // error CS8157: r was *initialized* to a local
}
```

これは意図的にフロー非依存になっています。コンパイラーは `r` がたまたま今ヒープを指していることを追跡せず、宣言されたコンテキストである declaration-block だけを知っています。

**return-only の罠。** `ref` パラメーターは return-only で、caller-context より狭いコンテキストです。そのため次は、別のエラーコードで失敗します。

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int FieldThenParam(ref int p)
{
    ref int r = ref _arr[0]; // caller-context
    r = ref p;               // error CS9079
    return ref r;
}
```

```text
error CS9079: Cannot ref-assign 'p' to 'r' because 'p' can only escape the current method through a return statement.
```

`_arr[0]` も `p` も単独では返せるのに、組み合わせは拒否されます。これらすべてのケースで解決策は同じです。`ref` ローカルを、それが保持しうる最も狭い参照先で初期化し、その後でより広いものに再代入します。

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ParamThenField(ref int p, bool useField)
{
    ref int r = ref p;               // return-only
    if (useField) r = ref _arr[0];   // caller-context is wider: OK
    return ref r;                    // OK: return-only is returnable
}
```

## `scoped ref` ローカル: より狭いコンテキストを選ぶ

`ref` ローカルを意図的に狭くすることもできます。`scoped ref` と宣言すると、初期化子に関係なく function-member コンテキストになります。

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ScopedLocal()
{
    scoped ref int r = ref _arr[0]; // function-member, despite caller-context initializer
    return ref r;                   // error CS8157
}
```

単独では無意味に見えますが、そのローカルを後でより狭いものに再代入するときに効果を発揮します。`scoped` キーワードだけが違う次の 2 つのメソッドを比べてください。

```csharp
// .NET 10 SDK 10.0.302, C# 14
void Unscoped()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    r = 5;
}

void Scoped()
{
    scoped ref int r = ref _arr[0]; // function-member
    int v = 1;
    r = ref v;                      // OK: v's block is the method body
    r = 5;
}
```

`scoped` は"この参照はメソッドから出ない"と宣言する文書化された方法であり、推論されたコンテキストでは禁止される再代入を可能にするもの、と考えてください。`ref struct` のローカルに同じキーワード (`scoped Span<int> s`) を付けると、代わりに safe-context が狭まり、その内容が外へ漏れなくなります。

## 構造体、`this`、`[UnscopedRef]`

構造体のインスタンスメソッド内では、`this` は暗黙の `scoped ref` パラメーターなので、そのコンテキストは function-member であり、そのすべてのフィールドも同様です (ルール 4)。構造体が自身のフィールドを ref で返せないのはこのためです。

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

struct Counter
{
    int _n;

    public ref int Bad() => ref _n;                 // error CS8170
    [UnscopedRef] public ref int Good() => ref _n;  // OK: this widened to return-only

    static ref int UseGood()
    {
        Counter c = default;
        ref int r = ref c.Good(); // receiver c is a local: declaration-block
        return ref r;             // error CS8157
    }
}
```

```text
error CS8170: Struct members cannot return 'this' or other instance members by reference
```

`[UnscopedRef]` は `this` を function-member から return-only へ 1 段階広げるので、`return ref _n` には十分です。しかし結果がヒープで安全になるわけではありません。呼び出し側では、`c.Good()` はレシーバーが `ref` で渡される `ref` を返す呼び出しなので、ルール 6 が適用され、結果はローカル `c` の declaration-block コンテキストを引き継ぎます。返された参照は、それが指す構造体と同じ長さしか生きられず、これはまさに正しい挙動です。

## Span: ref-safe-context と safe-context が出会う場所

`Span<T>` には `ref` を返すインデクサーがあるので、`ref span[i]` もルール 6 に従います。レシーバーは自身の **safe-context** を提供し、span の safe-context はそのメモリの出どころによって決まります。

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int FromStackSpan()
{
    Span<int> local = stackalloc int[4]; // safe-context: function-member
    ref int r = ref local[0];
    return ref r;                        // error CS8157
}

static ref int FromHeapSpan()
{
    Span<int> local = new int[4];        // safe-context: caller-context
    ref int r = ref local[0];
    return ref r;                        // OK
}
```

2 つのメソッドは `local` の初期化子以外は同一ですが、コンパイルできるのは片方だけです。span パラメーターの safe-context は caller-context なので、"要素を参照で見つける"という定番のパターンが注釈なしで合法になります。

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int MaxRef(Span<int> values)
{
    ref int best = ref values[0];        // caller-context via the span parameter
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i]; // same context: OK
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

ループ内のすべての再代入は同じ span からのものなので、コンテキストが衝突することはありません。これが目指すべき形です。参照元は 1 つ、コンテキストは 1 つにして、自由に再代入します。

## エラーコードの読み方

これらのいずれかに遭遇したとき、コードを見ればルールのどちら側が破られたかが分かります。

1. **CS8168** ("not a ref local"): 通常のローカルや値パラメーターに `return ref` を使おうとしました。値を返すか、ストレージをヒープに移してください。
2. **CS8157** ("was initialized to a value that cannot be returned"): `ref` ローカルの初期化子のコンテキストが return-only より狭いものでした。最新の再代入ではなく、初期化子を見てください。ヘルパー呼び出しにローカルの `ref` 引数がないか確認し、外へ出ないパラメーターには `scoped` を付けてください。
3. **CS8374** ("narrower escape scope"): 再代入がローカルのコンテキストを狭めようとしました。最も狭い参照先で先に初期化するか、参照先と同じブロックでローカルを宣言してください。
4. **CS9079** ("can only escape the current method through a return statement"): CS8374 の特殊なケースで、新しい参照先が `ref` または `in` パラメーター (return-only) で、ローカルが caller-context だった場合です。代わりにそのパラメーターで初期化してください。
5. **CS8170**: 構造体が自身のフィールドへの ref を返しています。結果が構造体自身の寿命に結び付くことを呼び出し側が許容できるなら、`[UnscopedRef]` を追加してください。

## 知っておくべき注意点

- `ref` ローカルはラムダやローカル関数に捕捉できず、`await` や `yield return` をまたいで生存することもできません。これは section 9.7.2.9 にある別の制限でコンテキストのエラーではありませんが、同じリファクタリングでよく一緒に現れます。
- `out` パラメーターは C# 11 の ref 安全性ルールでは暗黙的に `scoped ref` なので、`return ref outParam;` は `error CS9075: Cannot return a parameter by reference 'o' because it is scoped to the current method` で失敗します。一方 `return ref refParam;` は動作します。`<LangVersion>` を下げても以前の挙動には戻りません。`net10.0` プロジェクトで `<LangVersion>10</LangVersion>` を指定しても同じ CS9075 になりました。ターゲットランタイムが `ref` フィールドをサポートしていれば、コンパイラーは新しいルールを適用するためです。どうしても必要なら、パラメーターを `[UnscopedRef] out int o` としてください。
- `in` パラメーターは `ref` パラメーターと同様に return-only ですが、`ref readonly` としてのみです。それぞれをいつ選ぶべきかは [`ref readonly` パラメーターの記事](/ja/2023/10/csharp-ref-readonly-parameters/)で扱っています。
- コンパイラーは保守的です。ルール 6 は、`ref` を返すメソッドが自分の `ref` 引数のどれでも返しうると仮定します。あなたのメソッドがそうでないなら、`scoped` は回避策ではなく、正しい文書化された契約です。
- unsafe コードは対象外です。`unsafe` ブロック内ではローカルへのポインターを取得でき、コンパイラーはその寿命を追跡しません。[`unsafe` を呼び出し側の契約として再設計する C# 16 の変更](/ja/2026/05/csharp-16-unsafe-keyword-caller-contract/)は、この境界を明示的にするためのものです。

## 関連記事

- span 自体が初めての方は、まず [`Span<T>` とは何か、どんなときに実際にコードが速くなるのか](/ja/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)から始めてください。
- 寿命を気にする前にコレクションの形を選びたい場合は、[C# における List、Span、ReadOnlySpan の比較](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)を参照してください。
- C# 14 では span のバインドの仕方も変わりました。[span に関するオーバーロード解決の破壊的変更](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)では、`MemoryExtensions` で起きる意外な挙動を説明しています。
- [C# 14 の暗黙的な span 変換](/ja/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/)では、拡張メソッドのレシーバーを含め、上の `MaxRef` のような span パラメーターに配列をより多くの場面で渡せるようにする、言語レベルの新しい変換を扱っています。

## 参考資料

- [C# standard, section 9.7.2 Ref safe contexts](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) (9.7.2.2 (ローカル)、9.7.2.6 (関数呼び出し)、9.7.2.9 (ref 再代入) を含む)。
- [C# standard, section 9.7.3 The scoped modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#973-the-scoped-modifier)。
- [Low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements)。return-only、`scoped`、`[UnscopedRef]` を導入した C# 11 の提案です。
- C# 言語リファレンスの [Reference variables](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables) と [`ref` structure types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct)。
