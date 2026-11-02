---
title: ".NET で System.Threading.Lock を使う方法"
description: ".NET 9 以降の同期クリティカルセクションで System.Threading.Lock を使います。コンパイラの動作、await の制限、Monitor との違いを説明します。"
pubDate: 2026-04-30
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "ja"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

`System.Threading.Lock` は .NET 9 で導入されました。C# 13 以降では、式の静的な型がこの型である `lock` 文は、`Monitor` ではなく `EnterScope()` を使います。これは同じプロセス内の同期処理を相互排他にする選択肢であり、既存の `lock(object)` が自動的に置き換わるわけではありません。

**訂正 — 2026 年 11 月 2 日：** 旧版の「SyncBlock は回収されない」「`EnterScope()` は `await` をまたげる」という説明は誤りでした。メモリと性能の利点も過大に述べていました。以下のコンパイラ例は SDK 10.0.302、C# 14 で確認しました。.NET 11 での実行確認を意味しません。

## 型を明示した private なロック

```csharp
using System.Threading;

public sealed class Counter
{
    private readonly Lock _gate = new();
    private int _value;

    public int Next()
    {
        lock (_gate)
        {
            return ++_value;
        }
    }
}
```

コンパイラは、本体で例外が発生してもロックを解放するスコープに変換します。`Lock.Scope` は `ref struct` であり、ヒープ上の破棄可能なラッパーではありません。`Lock` 自体は参照型で、所有スレッドからの再入を許可します。成功した `Enter()` または `TryEnter()` ごとに、同じスレッドで `Exit()` が必要です。これらの手動 API では `try/finally` を使ってください。

## Lock と Monitor を混在させない

`lock (_gate)` と `Monitor.Enter(_gate)` は別の同期機構です。式の型が `object` または `dynamic` なら、明示的に `Lock` にキャストしない限り、`lock` は Monitor を使います。両方を混ぜると、共有データを保護できない可能性があります。

CS9216 は `lock ((object)gate)` など、一部の静的に検出できる変換に警告します。間接的なアクセスや明示的な `Monitor` 呼び出しをすべて検出する保証はありません。ロックを private に保ち、型を明確にしてください。`using System.Threading;` または完全修飾名を使います。`System.Threading` は名前空間なので、`using static System.Threading;` は無効です。

## await には別の方法が必要

`lock` 内の `await` は拒否されます。`Lock.Scope` も `await` をまたいで保持できません。`using` に書き換えても、この制限は回避できません。

```csharp
// Does not compile: CS4007 on .NET SDK 10.0.302, C# 14.
using System.Threading;
using System.Threading.Tasks;

public static class InvalidExample
{
    public static async Task InvalidAsync()
    {
        Lock gate = new();
        using (gate.EnterScope())
        {
            await Task.Delay(10);
        }
    }
}
```

同期クリティカルセクションは短く保ちます。非同期処理を直列化する必要があるなら、共有の `SemaphoreSlim(1, 1)` が選択肢になります。

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;

public static class AsyncOperations
{
    public static async Task RunExclusiveAsync(
        SemaphoreSlim gate, Func<Task> work, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await work();
        }
        finally
        {
            gate.Release();
        }
    }
}
// Share a SemaphoreSlim(1, 1) between callers of this operation.
```

手動の `Lock.Enter()`/`Exit()` でも `await` をまたがないでください。ロックはスレッドが所有し、継続処理は別スレッドで動く可能性があります。今回確認した C# 14 の例では、後続の await より前に完結する同期ロックブロックはコンパイルできました。

## SyncBlock と性能

Monitor はオブジェクトヘッダーと、必要に応じて関連する SyncBlock を利用します。競合が起きるたびに、すべてのオブジェクトへ永続的な SyncBlock が直ちに割り当てられるわけではありません。CoreCLR にはクリーンアップ処理、空き SyncBlock のプール、テーブルエントリの空きリストがあります。エントリの再利用と、テーブル容量をすべて OS に返すことは別です。

`Lock` 自身の取得処理は同じオブジェクト Monitor 機構を使いませんが、一定のオブジェクトサイズ削減や普遍的な高速化倍率を保証するものではありません。実際のランタイム、競合、保護する処理で測定してください。どちらも再入可能で、一般的な公平性の保証はありません。

`System.Threading.Lock` のない古いターゲットでは `object` を使うか、.NET 9 以降向けに条件付きコンパイルします。`Lock` もプロセス内のセマフォも、別プロセスの同期には使えません。また、`ImmutableArray<T>.Builder` のような可変ビルダーは、結果が不変だからといって同時変更が安全になるわけではありません。

非同期の producer/consumer 処理については、[Channels と BlockingCollection](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) を参照してください。

## 出典

- [System.Threading.Lock API](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/lock)
- [CoreCLR SyncBlock implementation, .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/syncblk.cpp)
- [C# 13 lock-object proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/lock-object.md)
