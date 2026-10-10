---
title: "透過的な構造体レイアウトとは何か、そして単一フィールドのラッパー構造体が .NET の呼び出し規約を変えるのはなぜか"
description: "透過的な構造体とは、ABI が唯一のフィールドとまったく同じように扱う構造体のことです。.NET 11 にはその保証がありません。double をラップした構造体は、Windows x64 では RCX で渡されますが、Linux と macOS では XMM0 で渡されます。本記事では、3 つの ABI での .NET 11 JIT の逆アセンブル結果、それが引き起こす P/Invoke のバグ、そしてあらゆる境界で安全なラッパー型の書き方を示します。"
pubDate: 2026-10-10
tags:
  - "dotnet-11"
  - "csharp"
  - "interop"
  - "jit"
  - "performance"
lang: "ja"
translationOf: "2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-10
---

結論から言うと、"透過的レイアウト" とは、フィールドがちょうど 1 つの構造体が、そのフィールドとまったく同じようにレイアウトされ、*かつ呼び出し間で渡される* ことを保証するものです。Rust では `#[repr(transparent)]` と書きます。.NET 11 にはこれがありません。`readonly record struct Meters(double Value)` のような C# の構造体は `double` と同じ 8 バイトのメモリレイアウトを持ちますが、呼び出し境界では JIT がこれを集成体として分類し、集成体をどう渡すかは各プラットフォームの ABI が決めます。Linux x64、macOS x64、およびすべての ARM64 ターゲットでは、ラッパーは引き続き浮動小数点レジスタで渡されるため、違いに気づくことはありません。Windows x64 では整数レジスタの `RCX` で渡され、戻り値も `XMM0` ではなく `RAX` で返されます。これはマネージドコードではレジスタ移動が数回増えるだけですが、ネイティブ側が素の `double` を受け取る P/Invoke シグネチャにこのラッパーを使うと、値が黙って壊れます。

以下はすべて .NET 11 RC1 (ランタイム 11.0.0-rc.1.26425.128、SDK 11.0.100-rc.1.26425.128) と C# 15 で実行しました。Windows x64 と Linux x64 のマネージド逆アセンブルは、RC1 の `crossgen2` クロスコンパイラーと `JitDisasm` で取得し、macOS のリストは arm64 でネイティブ実行したものと x64 を Rosetta 上で実行したものから取得し、ネイティブ側のリストは各 ABI を対象にした Apple clang 21 で取得しています。

## メモリレイアウトと呼び出し規約は別々の契約です

単一フィールドの構造体は "ただ同然" だと言うとき、たいていはメモリレイアウトのことを指しています。その点は正しいです。`Meters` は `double` と同じく 8 バイトで、8 バイト境界にアラインされます。`Unsafe.SizeOf<Meters>()` は 8 を返し、`Meters` の配列は `double` の配列とビット互換で、`MemoryMarshal.Cast<Meters, double>` も動作します。

呼び出し規約は別の契約です。これは、この値が引数または戻り値であるとき、どのレジスタまたはスタックスロットに入るのか、という問いに答えるものです。ABI はその型を *分類* することで判断しますが、多くの ABI はまず "スカラーか集成体か" で分類し、その後で中身を見ます。フィールドが 1 つでも、構造体は集成体です。ABI が内側の `double` まで見通すかどうかは、完全にプラットフォーム次第です。

- **System V AMD64 (Linux x64、macOS x64)** は集成体を eightbyte に分割し、それぞれを含まれるフィールドで分類します。`double` フィールドが 1 つなら eightbyte は SSE クラスになり、構造体は素の `double` と同じく `XMM0` で渡されます。
- **AAPCS64 (Linux、macOS、Windows on ARM64)** には、同種浮動小数点集成体 (HFA) の規則があります。同じ浮動小数点型のフィールドを 1 から 4 個持つ構造体は、連続した SIMD レジスタで渡されます。`double` が 1 つなら サイズ 1 の HFA なので、素の `double` と同じく `D0` に入ります。
- **Windows x64** は中身をまったく見ません。[x64 呼び出し規約のドキュメント](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention)には、サイズが 8、16、32、64 ビットの構造体は "同じサイズの整数であるかのように渡される" とあります。`double` を 1 つ含む構造体は 64 ビットなので `RCX` に入ります。戻り値については、適切なサイズのユーザー定義型は `RAX` で返され、float と double は `XMM0` で返されます。

.NET の JIT は、P/Invoke だけでなくマネージド間の呼び出しでもプラットフォームの ABI に従います。したがって、これは相互運用だけの珍しい話ではなく、通常の C# コードでも現れます。

## コンパイラーが出力するネイティブ ABI

違いが分かる最小の C ファイルを示します。3 つのターゲット向けに `clang -O2 -S` でコンパイルすると、各 ABI が期待するものが分かります。

```c
// abi.c, Apple clang 21, -O2
typedef struct { double value; } Meters;
typedef struct { float x, y; } Vec2;

double take_double(double d) { return d * 2.0; }
double take_meters(Meters m) { return m.value * 2.0; }
Meters ret_meters(double d) { Meters m = { d }; return m; }
float  take_vec2(Vec2 v) { return v.x + v.y; }
float  take_two_floats(float x, float y) { return x + y; }
```

`x86_64-pc-windows-msvc` の場合:

```asm
; Windows x64
take_double:
    addsd   %xmm0, %xmm0      ; double arrives in xmm0
    retq
take_meters:
    movq    %rcx, %xmm0       ; Meters arrives in rcx, moved to xmm0 first
    addsd   %xmm0, %xmm0
    retq
ret_meters:
    movq    %xmm0, %rax       ; Meters is returned in rax, not xmm0
    retq
```

`x86_64-apple-macos` (System V) と `arm64-apple-macos` (AAPCS64) では、`take_meters` は `take_double` とまったく同じ命令 (それぞれ `addsd %xmm0, %xmm0` と `fadd d0, d0, d0`) にコンパイルされ、`ret_meters` は値がすでに戻りレジスタにあるため、単なる `ret` になります。

つまり、このラッパーは 3 つの ABI のうち 2 つでは、分類規則の副産物として透過的になり、Windows x64 では不透明になります。

## ラッパー構造体に対して .NET 11 の JIT が出力するコード

次にマネージド側です。ラッパー以外は同一の 2 つのメソッドを用意します。

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.CompilerServices;

public readonly record struct Meters(double Value);

static class Managed
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static double ScaleDouble(double d) => d * 2.0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Meters ScaleMeters(Meters m) => new(m.Value * 2.0);
}
```

Linux x64 (crossgen2 `--targetos:linux --targetarch:x64`) では、どちらのメソッドも同じ 5 バイトにコンパイルされます。

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, linux-x64
       vaddsd   xmm0, xmm0, xmm0
       ret
; Total bytes of code 5
```

macOS arm64 で `DOTNET_JitDisasm` を使ってネイティブ実行した場合も、どちらも同じ 20 バイトで、実質的な処理は `fadd d0, d0, d0` だけです。

Windows x64 (crossgen2 `--targetos:windows --targetarch:x64`) では、`ScaleDouble` は依然として 5 バイトですが、`ScaleMeters` は次のようになります。

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, win-x64
       vmovq    xmm0, rcx          ; argument arrives in an integer register
       vaddsd   xmm0, xmm0, xmm0
       vmovq    rax, xmm0          ; result leaves in an integer register
       ret
; Total bytes of code 15
```

呼び出しごとにドメインをまたぐ移動が 2 回増え、コードサイズは 3 倍になります。メソッド本体の内部では、JIT が構造体を唯一のフィールドへ昇格させ、素の `double` レジスタとして処理するため、コストは境界だけに存在します。呼び出しがインライン化されれば境界は消え、コストも消えます。実際にはこのオーバーヘッドがほとんど問題にならず、インライン化されないホットパス (仮想呼び出し、インターフェースディスパッチ、デリゲート、`NoInlining` メソッド、インライン化するには大きすぎるメソッド) でしか見えないのはそのためです。

整数や参照をラップした場合は、これらの ABI のどれでもこの問題は起きません。`readonly record struct UserId(int Value)` は、Windows x64 では `ECX`、System V では `EDI`、ARM64 では `W0` で渡され、素の `int` とまったく同じです。オブジェクト参照をラップした構造体はポインターと同様に渡されます。違いが出るのは浮動小数点フィールド (および後述の複数フィールドの構造体) に限られます。ABI が飛ばすことを選べる独立したレジスタファイルを持つのは、浮動小数点値だけだからです。

## 本当のバグは P/Invoke シグネチャ内のラッパー型です

パフォーマンスの差は付け足しにすぎません。正しさの差はそうではありません。ネイティブ側が基になるプリミティブを受け取る `LibraryImport` や `DllImport` のシグネチャに、強く型付けされたラッパーを使うと、そのラッパーが透過的であると主張していることになります。構造体は blittable でそのまま渡されるため、マーシャラーはこれを検証しません。

上の `abi.c` ライブラリに対する再現コードを示します。

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.ProcessArchitecture} / {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"take_double(Meters 21)  = {Native.TakeDoubleAsMeters(new Meters(21)).Value}");
Console.WriteLine($"take_two_floats(Vec2)   = {Native.TakeTwoFloatsAsVec2(new Vec2(1f, 2f))}");
Console.WriteLine($"take_two_floats(f, f)   = {Native.TakeTwoFloats(1f, 2f)}");

public readonly record struct Meters(double Value);
public readonly record struct Vec2(float X, float Y);

static partial class Native
{
    // Wrong on purpose: the C side is double take_double(double)
    [LibraryImport("libabi", EntryPoint = "take_double")]
    public static partial Meters TakeDoubleAsMeters(Meters m);

    // Wrong on purpose: the C side is float take_two_floats(float, float)
    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloatsAsVec2(Vec2 v);

    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloats(float x, float y);
}
```

macOS arm64 では次のようになります。

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 3
take_two_floats(f, f)   = 3
```

すべて "動き" ます。`Meters` は `double` 1 つの HFA、`Vec2` は `float` 2 つの HFA で、AAPCS64 はそれぞれを `D0` と `S0`/`S1` に入れるため、ネイティブコードが読む場所とまさに一致します。

macOS x64 (System V) では、同じバイナリ、同じライブラリで次のようになります。

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 1
take_two_floats(f, f)   = 3
```

`Meters` は、単一の SSE eightbyte が `XMM0` に入るため、引き続き動作します。`Vec2` は動作しません。System V は 2 つの float を 1 つの eightbyte に詰めるため、構造体全体が `XMM0` の下位 64 ビットに届きます。ネイティブ関数は `x` を `XMM0` から、`y` を `XMM1` から読みますが、`XMM1` にはそこに残っていた値が入っています。この実行ではたまたまゼロだったので答えは `1` になりました。別の実行では何が入っているか分かりません。

Windows x64 では、間違った宣言が両方とも壊れます。`Meters` は `RCX` に入りますが `take_double` は `XMM0` を読み、結果はネイティブコードが `XMM0` に書いたのに `RAX` から読み戻されます。`Vec2` (8 バイト) も `RCX` に入ります。ネイティブ側については上の `x86_64-pc-windows-msvc` のリストで確認でき、マネージド側は `ScaleMeters` の逆アセンブルが示すのと同じ規則に従います。

これは "Mac では動くのに Windows のビルドエージェントではゴミが出る" という典型的なバグです。ARM64 のノート PC でレビューとテストを行ったコードは通りますが、最初の Windows x64 での実行で、無意味な値やわずかにずれた値が出ます。

## あらゆる境界で安全なラッパー型の書き方

.NET 11 には、構造体を透過的にする属性はありません。`[StructLayout(LayoutKind.Sequential)]`、`Pack`、`Size` はいずれもメモリレイアウトを制御するもので、レジスタの分類は制御しません。したがって、解決策はラッパーを境界のマネージド側にとどめることです。

1. **ネイティブシグネチャは、ネイティブの型そのままで宣言します。** C が `double` を受け取るなら、P/Invoke も `double` を受け取ります。薄いマネージドメソッドでラップとアンラップを行います。

    ```csharp
    // .NET 11 RC1, C# 15
    static partial class Native
    {
        [LibraryImport("libabi", EntryPoint = "take_double")]
        private static partial double TakeDouble(double d);

        public static Meters Scale(Meters m) => new(TakeDouble(m.Value));
    }
    ```

    ラッパーメソッドはインライン化されるため、型安全性のためのコストはかかりません。

2. **P/Invoke で構造体を使うのは、ネイティブ側が同じフィールドの構造体を使う場合だけにします。** C のヘッダーが `Vec2 v` と宣言しているなら、同じフィールドを同じ順序で持つ C# の `Vec2` は、あらゆる ABI で正しく動作します。両側が同じ分類を適用するからです。バグになるのは、片側が構造体で、もう片側がばらばらのスカラーである場合だけです。

3. **関数ポインターと `UnmanagedCallersOnly` も同様に扱います。** `delegate* unmanaged<Meters, Meters>` は `LibraryImport` と同じ問題を抱えており、ネイティブホストが `double` で呼び出す `[UnmanagedCallersOnly]` のエクスポートも同様です。[.NET Native AOT による Node.js アドオンの作成](/ja/2026/04/nodejs-addons-dotnet-native-aot/)のようにして Node アドオンやプラグインホストを作る場合は、エクスポートするシグネチャをプリミティブにしてください。

4. **Windows x64 のホットなマネージドパスでは、心配する前に呼び出しがインライン化されているかを確認します。** プロファイラーが、浮動小数点ラッパーを受け取るか返す、インライン化されていないメソッドを指しているなら、逆アセンブルを確認してください。Rider の [JIT と Native AOT の逆アセンブルを表示する ASM ビューアー](/ja/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)や `DOTNET_JitDisasm` を使うと、`vmovq` のペアが見えます。そのうえで、ホットな境界ではプリミティブを渡すか、呼び出しがインライン化されるように再構成できます。

## 落とし穴とエッジケース

- **float 2 つは double 1 つではありません。** "8 バイトは 8 バイト" と思い込む人が多くいます。`Vec2(float, float)` は 8 バイトですが、System V では 1 つの SSE eightbyte、ARM64 では 2 要素の HFA、Windows x64 では整数サイズの塊です。3 つの ABI で 3 通りの答えになります。クロスプラットフォームのゲームやグラフィックスのコードで最も頻繁に問題になるのがこのケースです。
- **フィールドが混在すると分類がまた変わります。** `struct { int Id; float Weight; }` は 8 バイトです。System V では 1 つの INTEGER クラスの eightbyte になり (1 つの eightbyte にクラスが混在する場合は整数が優先されます)、`RDI` に入ります。ARM64 では HFA ではないため `X0` に入ります。Windows x64 では `RCX` です。いずれも、`int` と `float` を別々に渡す場合とは一致しません。
- **Windows x64 ではサイズが重要です。** 値渡しでレジスタに入るのは、サイズが 1、2、4、8 バイトの構造体だけです。12 バイトや 16 バイトの構造体は、呼び出し元が確保したコピーへの参照で渡されます。これは各フィールドを個別に渡す場合から大きく変わります。System V と ARM64 では、16 バイトまでの構造体は引き続きレジスタに入ります。
- **C++ クラスのインスタンスメソッドはまた別です。** MSVC は、静的でないメンバー関数からユーザー定義型を返すとき、`RAX` に収まる場合でも隠しポインター経由で返します。`System.Runtime.CompilerServices` に `CallConvMemberFunction` が存在するのはこのためであり、小さな構造体を返す COM メソッドが既知の落とし穴であるのもこのためです。
- **構造体の昇格はコストを隠しますが、なくしはしません。** メソッド内部では、JIT が昇格した構造体をそのフィールドに置き換えるため、`Meters` に対するローカルな演算は `double` と同じ速度です。昇格は、値が呼び出しをまたぐ方法を変えません。値オブジェクトで構造体とクラスのどちらにするか検討しているなら、[record、class、struct の判断マトリクス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)で、サイズとコピーの面でのトレードオフを扱っています。
- **ReadyToRun と Native AOT も同じ規則を使います。** 事前コンパイルされたコードもプラットフォームの ABI に合致する必要があるため、[Native AOT や ReadyToRun](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) で発行してもラッパーは透過的になりません。本記事の crossgen2 の出力は ReadyToRun コードです。

## .NET に本物の透過的レイアウトは入るのか

.NET 11 では入りません。ロードマップ上で最も近いのは、[dotnet/runtime#100896 の相互運用向け構造体レイアウトの提案](https://github.com/dotnet/runtime/issues/100896)で、C スタイルの構造体、共用体、Swift 型のためのレイアウト種別を持つ `CustomLayoutAttribute` が承認されました。この issue では Rust の `repr(transparent)` のような仕組みを求める要望にも明示的に触れていますが、承認された形にはそれが含まれておらず、issue は 2026 年 7 月に 11.0.0 マイルストーンから 12.0.0 へ移されました。透過的な種別がいつか提供されれば、JIT とマーシャラーは、単一フィールドのラッパーをあらゆる ABI でそのフィールドとして分類できるようになります。これはまさに、[Rust の RFC 1758](https://rust-lang.github.io/rfcs/1758-repr-transparent.html) がニュータイプに対して行っていることです。

それまでの規則は短いものです。ラッパーはメモリ上ではただ同然で、インライン化後もただ同然ですが、ABI の境界では集成体であり、それが問題になるかどうかはプラットフォームが決めます。ネイティブシグネチャには使わないでください。Windows x64 でインライン化されないホットな呼び出しをまたいで渡す必要がある場合は、先に逆アセンブルを読んでください。

## 関連記事

- [C# における record、class、struct の比較: 判断マトリクス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/): そもそも値型の形をどう選ぶかについて。
- [Rider 2026.1 の JIT と Native AOT 逆アセンブル用 ASM ビューアー](/ja/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/): `vmovq` のペアを自分で確認する最も簡単な方法です。
- [.NET 11 における Native AOT、ReadyToRun、JIT の比較](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/): 3 つのコード生成モードの違いと、違わない部分について。
- [Polars.NET と LibraryImport](/ja/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/): これらのシグネチャを正しく書く必要がある、Rust ベースの実在のライブラリについて。
- [.NET Native AOT による Node.js アドオン](/ja/2026/04/nodejs-addons-dotnet-native-aot/): `UnmanagedCallersOnly` のエクスポートが、逆方向で同じ規則に直面します。

## 参考資料

- [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention) (Microsoft C++ ドキュメント): Windows x64 の集成体と戻り値の規則について。
- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI) の 3.2.3 節: eightbyte の分類について。
- [Procedure Call Standard for the Arm 64-bit Architecture (AAPCS64)](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst): HFA の規則について。
- [dotnet/runtime#100896: New attribute for interop-specific struct concerns](https://github.com/dotnet/runtime/issues/100896)
- [dotnet/runtime#43867: Keep structs in registers](https://github.com/dotnet/runtime/issues/43867): 単一フィールド構造体の扱いに関する JIT のトラッキング issue です。
- [Rust RFC 1758: repr(transparent)](https://rust-lang.github.io/rfcs/1758-repr-transparent.html)
