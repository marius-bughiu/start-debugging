---
title: "C# でマイクロ秒レイテンシのデータベースエンジンを構築する"
description: "Loic Baumann の Typhon プロジェクトは、ref struct、ハードウェア組み込み関数、ピン留めメモリを使って 1-2 マイクロ秒の ACID コミットを目指し、C# がシステムプログラミングレベルで競争できることを証明しています。"
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "database"
lang: "ja"
translationOf: "2026/04/building-a-microsecond-database-engine-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

高性能データベースエンジンには C、C++、または Rust が必要であるという前提は深く根付いています。Loic Baumann の [Typhon プロジェクト](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) はそれに直接挑戦しています。1-2 マイクロ秒のトランザクションコミットを目指す、C# で書かれた組み込み ACID データベースエンジンです。プロジェクトは最近 [Hacker News のトップページに到達](https://news.ycombinator.com/item?id=47720060) し、現代の .NET が実際に何ができるかについて活発な議論を巻き起こしました。

## 現代 C# のパフォーマンスツールキット

Baumann の中心的な主張は、データベースエンジン設計のボトルネックは言語選択ではなくメモリレイアウトであるというものです。現代の C# は、10 年前には不可能だったレベルでメモリを制御するツールを提供します。

`ref struct` 型はスタック上にのみ存在し、ホットパスでのヒープアロケーションを排除します。

```csharp
ref struct TransactionContext
{
    public Span<byte> WriteBuffer;
    public int PageIndex;
    public bool IsDirty;
}
```

決して移動してはならないメモリ領域については、`GCHandleType.Pinned` を指定した `GCHandle.Alloc` がガベージコレクターをクリティカルセクションから遠ざけます。`[StructLayout(LayoutKind.Explicit)]` と組み合わせると、すべてのバイトオフセットに対する C レベルの制御が得られます。

```csharp
[StructLayout(LayoutKind.Explicit, Size = 64)]
struct PageHeader
{
    [FieldOffset(0)]  public long PageId;
    [FieldOffset(8)]  public long TransactionId;
    [FieldOffset(16)] public int RecordCount;
    [FieldOffset(20)] public PageFlags Flags;
}
```

## ホットパスのためのハードウェア組み込み関数

`System.Runtime.Intrinsics` 名前空間は SIMD 命令への直接アクセスを与えます。ページをスキャンしたりチェックサムを計算したりするデータベースエンジンにとって、これは「十分に速い」と「C と競争できる」の違いです。

```csharp
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

static unsafe uint Crc32Page(byte* data, int length)
{
    uint crc = 0;
    int i = 0;
    for (; i + 8 <= length; i += 8)
        crc = Sse42.Crc32(crc, *(ulong*)(data + i));
    for (; i < length; i++)
        crc = Sse42.Crc32(crc, data[i]);
    return crc;
}
```

## コンパイル時に規律を強制する

Typhon のアプローチでより興味深い側面の 1 つは、Roslyn アナライザーをセーフティレールとして使用することです。カスタムアナライザーは、コードレビューに依存する代わりに、コンパイル時にドメイン固有のルール (トランザクションコードでの偶発的なヒープアロケーションなし、承認済みモジュール外でのチェックされていないポインタ演算なし) を強制します。

`where T : unmanaged` による制約付きジェネリックは別のレイヤーを提供し、ジェネリックデータ構造が予測可能なメモリレイアウトを持つ blittable 型でのみ動作することを保証します。

## これが .NET にとって何を意味するか

Typhon はまだ本番のデータベースではありません。しかし、プロジェクトは C# と従来のシステム言語との間のギャップが大きく狭まったことを示しています。`Span<T>`、ハードウェア組み込み関数、`ref struct`、明示的なメモリレイアウト制御の間で、.NET 10 はマネージドエコシステムを離れることなくパフォーマンスクリティカルなシステム作業のための構成要素を提供します。

[全文](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) はアーキテクチャの詳細とベンチマークのために読む価値があります。
