---
title: ".NET 9: lock(object) の終わり"
description: ".NET 9 では System.Threading.Lock が登場します。lock(object) を置き換える専用の軽量な同期プリミティブで、より高いパフォーマンスと明確な意図を提供します。"
pubDate: 2026-01-02
tags:
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/net-9-the-end-of-lockobject"
translatedBy: "claude"
translationDate: 2026-05-01
---
ほぼ 20 年にわたり、C# 開発者はスレッド同期のためにシンプルなパターンに頼ってきました。プライベートな `object` インスタンスを作成し、それを `lock` 文に渡すというものです。有効ではあるものの、このアプローチには隠れたパフォーマンスコストが伴います。.NET 9 はついに `System.Threading.Lock` の導入によってそれを解消します。

## `Monitor` の隠れたコスト

`lock (myObj)` と書くと、コンパイラはそれを `System.Threading.Monitor.Enter` と `Monitor.Exit` の呼び出しに変換します。このメカニズムは object header word に依存します。これはマネージドヒープ上のすべての参照型に付随するメタデータの一部です。

ロックのために通常の `object` を使うと、ランタイムは次のことを強いられます。

1.  識別のためだけにヒープ上にオブジェクトを割り当てる。
2.  競合時に同期情報 ("sync block") を格納するためにオブジェクトヘッダーを拡張する。
3.  オブジェクトがクラス外に漏れない場合でも、ガベージコレクション (GC) に圧力をかける。

スループットの高いシナリオでは、これらの小さな割り当てとヘッダー操作が積み重なります。

## `System.Threading.Lock` の登場

.NET 9 では専用型 `System.Threading.Lock` が導入されました。これは単なる `Monitor` のラッパーではなく、相互排他のために設計された軽量な同期プリミティブです。

C# 13 のコンパイラが `System.Threading.Lock` のインスタンスをターゲットにした `lock` 文を見つけると、異なるコードを生成します。`Monitor.Enter` の代わりに `Lock.EnterScope()` を呼び出し、`Lock.Scope` という構造体を返します。この構造体は `IDisposable` を実装してロックを解放し、例外が発生してもスレッド安全性を保証します。

### Before vs. After

次のコードは私たちが置き去りにする従来のアプローチです。

```cs
public class LegacyCache
{
    // The old way: allocating a heap object just for locking
    private readonly object _syncRoot = new();
    private int _count;

    public void Increment()
    {
        lock (_syncRoot) // Compiles to Monitor.Enter(_syncRoot)
        {
            _count++;
        }
    }
}
```

そして次のコードが .NET 9 におけるモダンなパターンです。

```cs
using System.Threading;

public class ModernCache
{
    // The new way: a dedicated lock instance
    private readonly Lock _sync = new();
    private int _count;

    public void Increment()
    {
        // C# 13 recognizes this type and optimizes the IL
        lock (_sync) 
        {
            _count++;
        }
    }
}
```

## なぜ重要なのか

改善は構造的なものです。

1.  **明確な意図**: 型名 `Lock` はその目的を明示的に示しており、汎用の `object` とは異なります。
2.  **パフォーマンス**: `System.Threading.Lock` は object header の sync block のオーバーヘッドを回避します。ロック取得・解放時の CPU サイクルを削減する、より効率的な内部実装を採用しています。
3.  **将来への備え**: 専用型を使うことで、`Monitor` のレガシーな動作を壊さずに、ランタイムがロックの仕組みをさらに最適化できる余地が生まれます。

## ベストプラクティス

この機能には **.NET 9** と **C# 13** の両方が必要です。既存のプロジェクトをアップグレードするなら、`private readonly object _lock = new();` を機械的に `private readonly Lock _lock = new();` に置き換えられます。残りはコンパイラが処理します。

`Lock` インスタンスを公開しないでください。古い `object` パターンと同様、外部のコードが内部の同期プリミティブをロックしてデッドロックを引き起こすのを防ぐためには、カプセル化が鍵となります。

高並行性システムを構築する開発者にとって、この小さな変更はランタイムのオーバーヘッドを削減する上で大きな前進を意味します。
