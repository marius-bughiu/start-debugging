---
title: ".NET 10 の Volatile.Read と Volatile.ReadBarrier の違い"
description: "Volatile.Read は 1 つの位置に対するアクワイア読み取りです。.NET 10 で追加された Volatile.ReadBarrier は、それ以前のすべての読み取りにアクワイアセマンティクスを与えるフェンスです。フラグや公開された参照には Volatile.Read を、seqlock のように通常の読み取りやアトミックでない読み取りをまとめて次のメモリアクセスの前に完了させたい場合には ReadBarrier を使います。"
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "ja"
translationOf: "2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-02
---

`Volatile.Read(ref x)` は 1 つの位置をアクワイアセマンティクスで読み取ります。つまり、コード上でその読み取りより後ろにあるものは、その読み取りより前に移動できません。.NET 10 で追加された `Volatile.ReadBarrier()` は、値を一切読み取りません。これは **自分より前のすべての読み取り** にアクワイアセマンティクスを与えるフェンスであり、通常の (アトミックでなくてもよい) 読み取りをまとめて、バリアより後ろのあらゆるメモリアクセスの前に完了させます。フラグ、カウンター、公開された参照といった一般的なケースには `Volatile.Read` を使います。複数の通常の読み取り、またはアトミックに読めないほど大きな 1 回の読み取りを、再チェックの前に完了させたい場合に `ReadBarrier` を使います。教科書的な例は seqlock のリーダー側です。

以下の内容はすべて、Apple M4 (arm64) 上の .NET 10.0.10 (SDK 10.0.302)、C# 14 で計測したものです。バリア API は .NET 10 以降の `System.Threading.Volatile` に存在します。.NET 9 以前では、`Interlocked.MemoryBarrier()` を除いて同等の公開 API はありません。

## 比較の概要

| | `Volatile.Read(ref x)` | `Volatile.ReadBarrier()` |
| --- | --- | --- |
| 利用可能になった時期 | .NET Framework 4.5 | .NET 10 |
| 値を読み取るか | はい、1 つの位置 | いいえ |
| アクワイアセマンティクスが付く対象 | その 1 回の読み取り | 呼び出し前のすべての読み取り |
| 後続の読み取りと書き込みが上に移動するのを防ぐか | はい | はい |
| 読み取りをアトミックにするか | はい、サポートされる型について (32 ビットの `long`/`double` を含む) | いいえ、アトミック性は自分で担保する必要があります |
| 任意の `T`、構造体、ネイティブメモリで使えるか | いいえ、オーバーロードは固定 | はい、先行するあらゆる読み取りを順序付けます |
| arm64 のコード生成 (計測、.NET 10.0.10) | `ldapur` (ロードアクワイア) | `dmb ishld` (ロードフェンス) |
| x64 のコード生成 | 通常の `mov`、コンパイラーによる順序付けのみ | 命令なし、コンパイラーによる順序付けのみ |
| 典型的な用途 | フラグ、ダブルチェックによる初期化、公開された参照 | seqlock、バージョン検証付きキャッシュ、まとめた読み取り |

## 2 つの API が保証すること

.NET のメモリモデル仕様 (dotnet/runtime の `docs/design/specs/Memory-model.md`) は、両方を "volatile reads have acquire semantics" の下に列挙しており、バリアについては "applies to all prior reads" という示唆的な注記が付いています。アクワイアとは、プログラム順で後ろにある読み取りや書き込みが、アクワイアする読み取りより先に実行されてはならないという意味です。

`Volatile.Read(ref _version)` では、アクワイアは `_version` のロードにだけ付きます。プログラム順でそれより *前* にあった読み取りには、まったく制約がありません。それらはその読み取りより後ろへ流れ込む可能性があります。

`Volatile.ReadBarrier()` では、アクワイアは呼び出しより前にあるすべてのロードに付きます。API 提案 ([dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837)) はこれを `Read-ReadWrite` バリアと呼んでいます。先行するすべての読み取りが、後続のあらゆるメモリ操作より前に完了しなければなりません。対となる `Volatile.WriteBarrier()` は `ReadWrite-Write` バリアで、先行するすべてのメモリ操作が、後続のあらゆる書き込みより前に完了しなければなりません。

つまり、この 2 つの API は同じものの強弱の違いではありません。答えている問いが違います。

- `Volatile.Read`: "この値を読み取り、それ以降のすべてが少なくともそれと同じ新しさのメモリを見ることを保証する。"
- `Volatile.ReadBarrier`: "すでに読み取ったものがすべて完了してから、再びメモリに触れることを保証する。"

どちらも完全なフェンスではありません。`ReadBarrier` は、先行する *書き込み* が後続の読み取りと並べ替えられること (ストア-ロードのケース) を防ぎません。それが必要な場合は、依然として `Interlocked.MemoryBarrier()` か `Interlocked` 操作が必要です。

## JIT が実際に出力するもの

JIT は両方のメソッドを組み込み (intrinsic) として扱います。`Volatile.cs` のソースは `[Intrinsic] public static void ReadBarrier() => ReadBarrier();` だけで、インポーターが呼び出しをロード専用とマークされたメモリバリアノードに置き換えます ([PR #107843](https://github.com/dotnet/runtime/pull/107843))。それが実際に何になるかを見るため、小さなクラスをフル最適化でコンパイルし、`DOTNET_JitDisasm` でダンプしました。

```csharp
// .NET 10.0.10, C# 14
// DOTNET_TieredCompilation=0 DOTNET_JitDisasm='Codegen:*' dotnet vb.dll
sealed class Codegen
{
    private int _x;
    private long _a, _b, _c, _d;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long AcquireFour() =>
        Volatile.Read(ref _a) + Volatile.Read(ref _b) +
        Volatile.Read(ref _c) + Volatile.Read(ref _d);

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long PlainFourThenBarrier()
    {
        long sum = _a + _b + _c + _d;
        Volatile.ReadBarrier();
        return sum;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public void BarrierThenPlainFour(long v)
    {
        Volatile.WriteBarrier();
        _a = v; _b = v; _c = v; _d = v;
    }
}
```

M4 上で注目すべき命令は次のとおりです。

```text
; AcquireFour: four separate load-acquire instructions
ldapur  x1, [x0, #0x08]
ldapur  x2, [x0, #0x10]
ldapur  x2, [x0, #0x18]
ldapur  x0, [x0, #0x20]

; PlainFourThenBarrier: two paired loads, then one load fence
ldp     x1, x2, [x0, #0x08]
ldp     x2, x0, [x0, #0x18]
dmb     ishld

; BarrierThenPlainFour: a full fence, then two paired stores
dmb     ish
stp     x1, x1, [x0, #0x08]
stp     x1, x1, [x0, #0x18]
```

目を引く点が 3 つあります。

1 つ目は、`Volatile.Read` が RCpc のロードアクワイアである `ldapur` にコンパイルされることです (RCpc 拡張は ARMv8.3 と v8.4 で導入されました)。M4 はこれをサポートしています。RCpc のないコアでは、代わりに古い `ldar` が使われます。いずれの場合も、独立したフェンス命令はありません。

2 つ目は、`ReadBarrier` より前の通常の読み取りは通常のままなので、JIT がそれらを自由に `ldp` にペア化できることです (32 バイトの構造体コピーなら、128 ビットの `ldp q` ロード 2 つにもなります)。4 つのアクワイアロードでは、この自由が失われます。これが提案で示された効率の議論です。N 個の順序付き読み取りの代わりに、N 個の読み取りに対して 1 つのフェンスで済みます。

3 つ目は、arm64 では `Volatile.WriteBarrier()` が完全な `dmb ish` であり、`Interlocked.MemoryBarrier()` が出力するものと同じだということです。JIT には、arm64 では現状、ストア専用バリアを完全なバリアより良い形で出力できないというコメントがあります。そのため、arm64 では `WriteBarrier` が完全なフェンスより安価になると期待しないでください。

x64 では、どちらのバリアも命令をまったく出力しません。PR のコード生成コメントは明確で、ロード専用とストア専用のバリアは "are no-ops on xarch" です。x86 の TSO モデルがすでに、ロードを後続のロードとストアに対して順序付け、ストアを先行するメモリ操作に対して順序付けているためです。それでも x64 で意味があります。バリアをまたいで JIT 自身がメモリアクセスを並べ替えたり、キャッシュしたり、削除したりするのを防ぐからです。今回は x64 のマシンがなかったため、表の x64 の行は逆アセンブルではなく JIT のソースから得たものです。

## seqlock: ReadBarrier が想定したケース

最初の利用者はランタイム自身でした。CoreLib の `GenericCache` と `CastCache` は内部の `Interlocked.ReadMemoryBarrier()` を使っていましたが、同じ PR で `Volatile.ReadBarrier()` に切り替えられました。そのコメントがパターンを説明しています。"we must read in this order: version -> [entry parts] -> version"。

これが seqlock です。単一のライターがバージョンを奇数にし、データを書き込み、次の偶数にします。リーダーはバージョンを読み取り、通常のロードでデータをコピーし、もう一度バージョンを読み取ります。2 回の読み取りが一致し、かつ偶数であれば、コピーは一貫しています。データのサイズは問いません。32 バイトの構造体はどのプラットフォームでもアトミックではありませんが、バージョンチェックが破損したコピーを検出するので問題ありません。

両方のバリアを適切な場所に置いた最小版は次のとおりです。

```csharp
// .NET 10, C# 14
struct Snapshot { public long A, B, C, D; }

sealed class SeqLockBox
{
    private int _version;          // even = stable, odd = write in progress
    private Snapshot _data;

    // Single writer only.
    public void Write(long n)
    {
        int v = _version;
        _version = v + 1;          // mark "writing" (odd)
        Volatile.WriteBarrier();   // odd version is published before any data write below
        _data.A = n; _data.B = n; _data.C = n; _data.D = n;
        Volatile.Write(ref _version, v + 2); // release: data writes complete before the even version
    }

    public bool TryRead(out Snapshot snapshot)
    {
        int v1 = Volatile.Read(ref _version); // acquire: the data reads below cannot move above this
        snapshot = _data;                     // plain, non-atomic 32-byte copy
        Volatile.ReadBarrier();               // every read above completes before the re-check
        return (v1 & 1) == 0 && _version == v1;
    }
}
```

リーダーが両方の API をどう使っているかに注目してください。最初のバージョン読み取りは `Volatile.Read` です。データの読み取りをその *下* に留めておく必要があるからです。データのコピーは通常のロードです。そして `ReadBarrier` が、データの読み取りを 2 回目のバージョン読み取りの *上* に留めます。2 つ目の制約は、単一の `Volatile.Read` では表現できません。`Volatile.Read` が制約するのは、読み取る位置より後ろにあるものだけであり、ここで順序付けたいのは前にあったものだからです。

ライターはその鏡像です。最後の偶数バージョンへの `Volatile.Write` はリリースなので、データの書き込みがそれより下に沈むことはありません。しかしリリースは、データの書き込みが先の奇数バージョンのストアより上に浮き上がるのを防ぎません。`WriteBarrier` がその側を担います。

## 両方が必要であることの実証

リーダーとライターを 2 つのスレッドで、シナリオごとに 5 秒間実行し、受理されたスナップショットのうち `A`、`B`、`C`、`D` が食い違っていたものの数を数えました。各シナリオは、順序付けの一部を取り除いています。

```csharp
// .NET 10, C# 14: the reader variants in the stress test
public bool TryReadAcquireOnly(out Snapshot snapshot)   // no ReadBarrier
{
    int v1 = Volatile.Read(ref _version);
    snapshot = _data;
    return (v1 & 1) == 0 && _version == v1;
}

public bool TryReadBarrierOnly(out Snapshot snapshot)   // no acquire on the first read
{
    int v1 = _version;
    snapshot = _data;
    Volatile.ReadBarrier();
    return (v1 & 1) == 0 && _version == v1;
}
```

M4、.NET 10.0.10、Release ビルドでの 2 回分の結果です。

| シナリオ | 受理されたスナップショット (1 回目 / 2 回目) | 破損したのに受理されたもの (1 回目 / 2 回目) |
| --- | --- | --- |
| 順序付けなし (通常の読み取り) | 1,014,876,206 / 1,003,303,309 | 547,804 / 515,135 |
| `Volatile.Read` のみ、`ReadBarrier` なし | 164,358,676 / 152,032,561 | 99 / 357 |
| `ReadBarrier` のみ、最初の読み取りは通常 | 34,543,735 / 27,982,884 | 54 / 62 |
| `WriteBarrier` なしのライター、正しいリーダー | 354,942,744 / 384,287,324 | 66,155,404 / 54,597,163 |
| 両方のバリア (上記のコード) | 62,659,697 / 66,048,738 | 0 / 0 |

どの中途半端な対策でも、検証を通過する破損データが生じました。まれなものほど危険です。1 億 6,400 万回のうち 99 回の不正な読み取りというのは、あらゆるテスト実行をすり抜け、Graviton や Ampere のマシンで本番に現れるタイプのバグです。`WriteBarrier` の欠落が最も派手な失敗で、逆アセンブルを見ればその理由がわかります。2 つのライターメソッドは、1 つの `dmb ish` を除いて同一のコードにコンパイルされるので、5,400 万回以上の破損はすべて、arm64 のコアが奇数バージョンのストアより先にデータのストアを可視にしたことによるものです。

x64 では、ハードウェアがそれらの方向で並べ替えを行わないため、これらの行のほとんどで破損はおそらくゼロになるでしょう。だからこそ、こうしたバグは出荷されてしまいます。x64 でもコードは誤りです。JIT は通常のアクセスを並べ替えてよいからです。そして arm64 で動かした瞬間に、目に見える形で誤りになります。

## 並べ替えるのは CPU だけではなく JIT も

私のストレステスト用ハーネスの最初のバージョンは永久にハングしました。その理由は示す価値があります。壊れたリーダーは、偶数のバージョンを見るまでループしていました。

```csharp
// .NET 10, C# 14: do not do this
public void WaitForEvenBroken()
{
    while ((_version & 1) != 0) { }
}
```

JIT はこれを、1 回のロードと自分自身への分岐にコンパイルしました。

```text
ldr     w0, [x0, #0x08]
and     w0, w0, #1
G_M000_IG03:
cbnz    w0, G_M000_IG03
```

`_version` のロードはループの外に巻き上げられました。間に同期のない通常のフィールド読み取りなので、これは合法です。最初の読み取りがたまたま奇数のバージョンだった場合、スレッドは永久にスピンします。条件の中で `Volatile.Read(ref _version)` を使えば直りますし、ループ本体の中の `ReadBarrier` でも直ります。これは "volatile" のうち x64 の開発者も実際に経験する部分であり、命令を出力しない場合でもバリアが空の呼び出しではない理由です。

## Volatile.Read を選ぶ場合

- **フラグや停止シグナル。** `while (!Volatile.Read(ref _stop))` が典型例です。位置は 1 つ、値は 1 つで、ライターがそれを設定する前に公開したものを、後続の読み取りに見せたい場合です。
- **参照の公開。** ライターがオブジェクトを構築し、`Volatile.Write(ref _instance, obj)` を行います。リーダーは `Volatile.Read(ref _instance)` を行い、その参照を通してフィールドを読み取ります。参照の読み取りに対するアクワイアだけで十分です。
- **ダブルチェックによる遅延初期化。** 公開と同じ形で、`LazyInitializer` が内部で volatile の読み取りを使っている理由でもあります。
- **.NET 9 以前を対象にしている場合。** そこには `ReadBarrier` が存在しません。

これらすべてで、順序付けは 1 回の読み取りに固定されるため、`Volatile.Read` は意図をそのまま表現し、どちらのアーキテクチャでもフェンスを生成しません。

## Volatile.ReadBarrier を選ぶ場合

- **seqlock のリーダーとバージョン検証付きキャッシュ。** 上記のパターンで、CoreLib の `CastCache` と `GenericCache` が使っているものです。
- **アトミックに読み取れないデータ。** ポインターより大きい構造体、`Int128`、バイトのスパン、複数のフィールドを持つ構造体などです。これらには `Volatile.Read` のオーバーロードがなく、`ReadBarrier` を使えば通常のロードでコピーし、あとから検証できます。
- **ネイティブメモリからの読み取り、または `Unsafe` 経由の読み取り。** アンマネージドバッファーへのポインターや `ref` を通して読み取る場合、`Volatile.Read` に渡せるマネージドフィールドがないことがあります。バリアはそれらのロードも同様に順序付けます。
- **1 つの順序付けポイントが必要な多数の読み取り。** N 個のアクワイアロードの代わりに、N 個の通常のロードの後に 1 つの `dmb ishld` を置き、JIT が通常のロードをペア化できるようにします。

## コストの計測

`ReadBarrier` なしでシーケンスロックのリーダーを正しく書く方法は 2 つあります。すべてのデータ読み取りを `Volatile.Read` にするか、バリアを置く場所に完全な `Interlocked.MemoryBarrier()` を使うかです。BenchmarkDotNet 0.15.8 で、そのすべてを順序付けなし (壊れた) リーダーと比較しました。各呼び出しは 32 バイトのスナップショットのシングルスレッド読み取りを 1,024 回行い、表は 1 回の読み取りあたりのコストを示します。

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8, Apple M4 (arm64)
[Benchmark(OperationsPerInvoke = N)]
public long VolatileReadPlusReadBarrier()
{
    long sum = 0;
    for (int i = 0; i < N; i++)
    {
        int v1 = Volatile.Read(ref _version);
        Snapshot s = _data;
        Volatile.ReadBarrier();
        if ((v1 & 1) == 0 && _version == v1) sum += s.A + s.B + s.C + s.D;
    }
    return sum;
}
```

| リーダー (スナップショット 1 回の読み取りあたり) | 平均 | 比率 |
| --- | --- | --- |
| 順序付けなし (壊れている) | 0.916 ns | 1.00 |
| バージョンと 4 つのフィールドすべてに `Volatile.Read` | 1.135 ns | 1.24 |
| `Volatile.Read` + `Volatile.ReadBarrier` | 0.929 ns | 1.01 |
| `Volatile.Read` + `Interlocked.MemoryBarrier` | 0.930 ns | 1.02 |

バリア版のコストは、壊れた版とほぼ同じです。すべてを volatile で読む版は約 24% 遅く、その主な理由は、通常のコピーのようには 4 つの順序付き `ldapur` ロードを 2 つの幅広いロードに融合できないことです。これをより大きな構造体に拡大すると、差はフィールド数とともに広がりますが、バリアは 1 命令のままです。

正直な注意点が 2 つあります。これは競合のない、シングルスレッドのループです。コアに待つべき未処理のメモリトラフィックがなければ `dmb` は安価であり、そのため完全なフェンスもここでは無料に見えます。実際の書き込み競合下では、完全なフェンスは通常、ロード専用のものより高くつきますが、競合のあるベンチマークは実行していないので、その数値は示しません。そして、これらはすべて arm64 での結果です。x64 では両方のバリアが命令を出力しないため、比較できるのはそれらの周りで JIT に許されていることだけです。

## 落とし穴

**配置がすべてです。** `ReadBarrier` は、自分より *前* の読み取りを、*後* のアクセスに対して順序付けます。リーダーの先頭、つまり人が直感的に "volatile" な読み取りを置きたくなる場所に置いても、気にしている対象は何も順序付けられません。seqlock では、データのコピーの後、2 回目のバージョン読み取りの前に置きます。

**完全なフェンスではありません。** ストア、`ReadBarrier`、ロードの順に並べても、並べ替えられる可能性があります。各スレッドが自分のフラグを書き込んでから相手のフラグを読み取る、Dekker 方式のコードには、`Interlocked.MemoryBarrier()` か `Interlocked` 操作が必要です。

**何かをアトミックにするものではありません。** メモリモデル仕様は率直で、volatile セマンティクスはアトミック性を意味しません。バージョン検証を省略すると、バリアは破損した読み取りをそのまま順序付けてしまいます。

**ロックではありません。** 上で書いた seqlock がサポートするのは、ちょうど 1 つのライターです。2 つのライターには、バージョンに対する `Interlocked.CompareExchange` (`GenericCache` が行っていること) か、本物のロックによる直列化が必要です。ロックが遅く感じたためにバリアに手を伸ばすのであれば、先に計測してください。[lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) の記事は、競合のないロードがすでにどれだけ安価かを示しています。

**C# の `volatile` フィールドは同じ道具ではありません。** `volatile` フィールドは、C# コンパイラーにすべてのアクセスを `volatile.` IL プレフィックス付きで出力させるので、すべての読み取りがアクワイア、すべての書き込みがリリースになります。これはアクセスごとの `Volatile.Read`/`Volatile.Write` のセマンティクスであり、まとめた読み取りに対するバリアではなく、上で示したロードのペア化も無効にします。

## 結論

デフォルトは `Volatile.Read` にしてください。ロックフリーのフラグ、公開、遅延初期化のほぼすべてのパターンに適した道具で、x64 ではコストがかからず、最近の arm64 では 1 つのロードアクワイア命令です。`Volatile.ReadBarrier` (.NET 10 以降) は、順序付けたいものが先行する読み取りのまとまり、典型的にはあとから検証するアトミックでないコピーである場合にだけ使ってください。使うときは、ライター側では `Volatile.WriteBarrier` と組み合わせ、arm64 でテストし、arm64 では `WriteBarrier` が完全なフェンスと同じくらい高価であることを覚えておいてください。

## 関連記事

- [How to use the new System.Threading.Lock type](/ja/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)。ロックフリーのコードが実際には必要ない場合の正解です。
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)。同期プリミティブを選ぶための記事です。
- [How to cancel a long-running Task without deadlocking](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)。すべてのキャンセルチェックの裏に `Volatile.Read` があります。
- [record vs class vs struct in C#](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)。共有状態が、アトミックに読めない複数フィールドの構造体になったときに関係します。

## 参考資料

- MS Learn の [Volatile.ReadBarrier method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile.readbarrier?view=net-10.0) と [Volatile class](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile?view=net-10.0)。
- [API proposal: Volatile barrier APIs, dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837)。
- [Implement volatile barrier APIs, dotnet/runtime#107843](https://github.com/dotnet/runtime/pull/107843)。JIT のコード生成と CoreLib のキャッシュの変更を含みます。
- [.NET memory model specification](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md)。
- [GenericCache.cs on release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/GenericCache.cs)。`Volatile.ReadBarrier` を使う、本番環境の seqlock リーダーです。
