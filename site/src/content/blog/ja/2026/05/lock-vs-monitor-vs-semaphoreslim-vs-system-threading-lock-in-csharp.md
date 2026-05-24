---
title: "C# における lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock"
description: "C# でクリティカルセクションを保護する 4 つの方法と、その選択のための判断マトリックス。.NET 9+ での同期的な相互排他には System.Threading.Lock を、セクションが await をまたぐ場合は SemaphoreSlim を、Wait/Pulse が必要な場合のみ Monitor を使います。"
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "ja"
translationOf: "2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-24
---

.NET 9 以降の新しいコードでの同期的な相互排他には、`System.Threading.Lock` を使い、それを `lock` キーワードで記述します。クリティカルセクションが何かを待機する (`await`) 必要がある場合、同期プリミティブはどれも使えませんので、`SemaphoreSlim(1, 1)` と `await WaitAsync()` に頼ります。純粋な `Monitor` は、他のどれもまったく扱えない唯一のケース、すなわち条件変数 (`Monitor.Wait` / `Pulse` / `PulseAll`) のために取っておきます。古典的なイディオム `lock (object)` は間違いではありませんが、`Lock` よりもわずかに重い `Monitor` の経路にコンパイルされるだけなので、.NET 9+ では新しいゲートを素の `object` で始める理由はありません。

この記事は .NET 11 (preview 4)、C# 14、および net11.0 における `System.Threading` の状態の BCL を対象としています。`System.Threading.Lock` は .NET 9 の型ですので、この推奨は .NET 9、.NET 10、.NET 11 に等しく当てはまります。`Monitor` と `lock` キーワードは .NET 1.1 と C# 1.0 まで遡ります。`SemaphoreSlim` は .NET Framework 4.0 で登場しました。

## 4 つの候補は実際には対等ではありません

この比較が人を混乱させる理由は、4 つの名前が異なるレイヤーに位置しているからです。

`lock` は C# の言語ステートメントです。それ自体は何も実装しません。コンパイラーは `x` の静的な型に応じて、`lock (x) { body }` を 2 つの形のいずれかに展開します。`x` が `System.Threading.Lock` であれば、それは `using (x.EnterScope()) { body }` になります。それ以外の参照型に対しては、`try` / `finally` で包まれた `Monitor.Enter` / `Monitor.Exit` のペアになります。ですから「`lock` を使うべきか `Monitor` を使うべきか」は、ほとんどの場合、誤った選択です。`lock (someObject)` は、より安全に書かれた `Monitor` *そのもの* なのです。

`Monitor` は古典的なイディオムの背後にある静的 API です。相互排他を行いますが、他にはない 2 つの機能も備えています。再帰 (同じスレッドが 2 回入れる) と、`Wait`、`Pulse`、`PulseAll` による条件変数です。これらの条件変数メソッドは、この比較全体の中で、他の 3 つに代替がない唯一の機能です。

`System.Threading.Lock` は .NET 9 で導入された相互排他専用の型です。これは、`Monitor` が `lock (object)` のバッキング実装も兼ねていなければそうなっていたであろう型です。ミューテックスが必要とするものをちょうど公開し、それ以上は何も公開しません。[System.Threading.Lock の仕組みと移行方法](/ja/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)の詳細な解説で、その仕組みを詳しく扱っています。

`SemaphoreSlim` はミューテックスではなくカウントセマフォですが、カウントを 1 で構築するとミューテックスになります。他の 3 つと一線を画すのは `WaitAsync` です。これはここで唯一、`await` をまたいで正当に保持できるプリミティブです。

## 判断マトリックス

このテーブルの各行は、特に注記のない限り .NET 9+ / C# 13+ の挙動を示します。

| 機能                                    | `lock (object)`        | `Monitor`              | `SemaphoreSlim`             | `System.Threading.Lock`   |
| --------------------------------------- | ---------------------- | ---------------------- | --------------------------- | ------------------------- |
| 相互排他 (保持者は 1 つ)                | はい                   | はい                   | はい、`new(1, 1)` のとき    | はい                      |
| N > 1 の同時保持者に制限                | いいえ                 | いいえ                 | はい、`new(N, N)`           | いいえ                    |
| 保持領域内での `await` が合法           | いいえ (CS1996)        | いいえ (CS1996)        | はい、`WaitAsync` 経由      | いいえ (CS1996)           |
| 条件変数 (`Wait`/`Pulse`)              | いいえ                 | はい                   | いいえ                      | いいえ                    |
| 同一スレッドで再入可能                  | はい                   | はい                   | いいえ (デッドロック)       | はい                      |
| スレッド/保持者の同一性を強制           | はい                   | はい                   | いいえ                      | はい                      |
| 展開先                                  | `Monitor.Enter`/`Exit` | (それ自体)             | `Wait`/`Release`            | `Lock.EnterScope()`       |
| 競合時の sync block インフレーション    | はい                   | はい                   | いいえ                      | いいえ                    |
| タイムアウト付きの取得試行              | `Monitor.TryEnter`     | `TryEnter(TimeSpan)`   | `Wait(TimeSpan)`            | `TryEnter(TimeSpan)`      |
| キャンセル可能な取得                    | いいえ                 | いいえ                 | はい (`CancellationToken`)  | いいえ                    |
| プロセス間                              | いいえ                 | いいえ                 | いいえ (`Semaphore` を使用) | いいえ                    |
| `IDisposable`                           | いいえ                 | いいえ                 | はい                        | いいえ                    |
| 初出                                    | C# 1.0                 | .NET 1.1               | .NET Framework 4.0          | .NET 9                    |

2 つの行がほぼすべての実際のケースを決定します。「内部での `await` が合法」と「条件変数」です。前者が必要なら `SemaphoreSlim` です。後者が必要なら `Monitor` です。それ以外はすべて `System.Threading.Lock` を指し示します。

## System.Threading.Lock を選ぶとき

これは .NET 9+ での新しい同期コードのデフォルトです。

- 短い CPU バウンドのクリティカルセクションを保護している場合: インメモリキャッシュの更新、カウンター、`Dictionary` の変更、遅延初期化フィールドなど。本体は何も待機 (`await`) しません。これは典型的なサービスにおけるロックの 90% です。
- 既存の `lock (object)` ゲートを移行していて、本体が同期的な場合。変更は 1 行です。`private readonly object _gate = new();` が `private readonly Lock _gate = new();` になります。すべての `lock (_gate) { ... }` ステートメントはバイト単位で同じままで、コンパイラーがそれを `Monitor.Enter` から `Lock.EnterScope()` に再バインドします。
- より小さなフットプリントが欲しい場合。`Lock` は競合時にプロセス全体の sync block をインフレーションさせることが決してないため、数千のゲート (たとえばキャッシュエントリーごとに 1 つ) を保持するサービスは、`Monitor` のように sync block テーブルを増大させません。

```csharp
// .NET 11, C# 14 -- the default gate for synchronous critical sections
public sealed class Counter
{
    private readonly Lock _gate = new();
    private long _value;

    public void Increment()
    {
        lock (_gate) // lowers to using (_gate.EnterScope())
        {
            _value++;
        }
    }

    public long Read()
    {
        lock (_gate)
        {
            return _value;
        }
    }
}
```

まだ .NET 9 に移行できない場合、フォールバックは古典的な `lock (object)` です。セマンティクスは同じで、わずかに重いだけです。ロックするためだけに `Monitor` を明示的に使わないでください。`lock` キーワードはすでに `Monitor.Enter` / `Exit` を正しい `try` / `finally` で包んでいるため、本体が例外をスローしてもロックは解放されます。`finally` のない手書きの `Monitor.Enter` は、孤立したロックの古典的な発生源です。

## SemaphoreSlim を選ぶとき

`SemaphoreSlim` は、同期プリミティブが答えられない唯一の問いへの答えです。すなわち、`await` を含むセクションをどうやって直列化するか、です。

- クリティカルセクションが `await` をまたぐ場合。非同期 API (`HttpClient` のリクエスト、EF Core のクエリ、ファイル書き込み) を呼び出していて、一度に領域内の呼び出し元を 1 つだけにする必要がある場合。`lock`、`Monitor`、`Lock` はすべて保持領域内での `await` を禁止します。`SemaphoreSlim` は禁止しません。
- 並行性を 1 より大きい N に制限したい場合。3 つの同時送信呼び出しを許可するスロットルは `new SemaphoreSlim(3, 3)` です。いかなるミューテックスもこれを表現できません。
- 非同期パスでキャンセル可能またはタイムアウト付きの取得が必要な場合。`WaitAsync(CancellationToken)` と `WaitAsync(TimeSpan)` は、残りのキャンセルの仕組みと統合されます。

```csharp
// .NET 11, C# 14 -- async-safe mutual exclusion across an await
public sealed class AsyncCache : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1); // count 1 == mutex
    private readonly Dictionary<string, byte[]> _store = new();

    public async Task<byte[]> GetOrAddAsync(string key, Func<string, Task<byte[]>> factory)
    {
        await _gate.WaitAsync();
        try
        {
            if (_store.TryGetValue(key, out var existing))
                return existing;

            var fresh = await factory(key); // legal: we are holding a semaphore, not a lock
            _store[key] = fresh;
            return fresh;
        }
        finally
        {
            _gate.Release(); // ALWAYS in finally
        }
    }

    public void Dispose() => _gate.Dispose();
}
```

`SemaphoreSlim` には 3 つの落とし穴があり、3 つとも同じ根に遡ります。すなわち、誰が保持しているかを追跡しないことです。[SemaphoreSlim のドキュメント](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim)によれば、このクラスは「Wait、WaitAsync、Release の各メソッドの呼び出しにおいてスレッドまたはタスクの同一性を強制しません」。

1. **再入なし。** セマフォを保持しているメソッドが、同じセマフォを待機する別のメソッドを呼び出すと、デッドロックします。`Monitor` と `Lock` は同じスレッドの再入を許可しますが、`SemaphoreSlim` は比較すべき所有スレッドという概念を持たないため、許可できません。
2. **Release は保護されない。** `Wait` を呼び出した回数より多く `Release` を呼び出すことを妨げるものは何もなく、それは静かに `CurrentCount` を初期カウントより上に押し上げ、不変条件を壊します。常に `Wait` / `WaitAsync` を `finally` 内の `Release` と対にしてください。
3. **`IDisposable` である。** 他の 3 つと異なり、`SemaphoreSlim` は遅延割り当てされる `WaitHandle` を所有し、破棄する必要があります。フィールドレベルのセマフォは、あなたのクラスも今や `IDisposable` であることを意味します。

取得ごとのオーバーヘッドは `Lock` より高くなります。それが非同期サポートの代償です。すでにスコープ内にあるからというだけの理由で、純粋に同期的な高速パスに `SemaphoreSlim` を使わないでください。

## Monitor を明示的に選ぶとき

ほとんど決してありませんが、1 つの本当の例外があります。条件変数が必要な場合です。

`Monitor.Wait`、`Monitor.Pulse`、`Monitor.PulseAll` は、スレッドがロックを解放し、別のスレッドが状態変化をシグナルするまで眠り、目覚めたときに再取得することを可能にします。これは古典的な有界バッファー / プロデューサー・コンシューマーの調整プリミティブです。この比較の中で、これを公開する型は他にありません。`System.Threading.Lock` は意図的にそれを外しました。`SemaphoreSlim` はそれを持っていたことがありません。

```csharp
// .NET 11, C# 14 -- the one job only Monitor can do: condition variables
public sealed class BoundedBuffer<T>
{
    private readonly object _gate = new();
    private readonly Queue<T> _items = new();
    private readonly int _capacity;

    public BoundedBuffer(int capacity) => _capacity = capacity;

    public void Add(T item)
    {
        lock (_gate)
        {
            while (_items.Count == _capacity)
                Monitor.Wait(_gate);     // release + sleep until pulsed

            _items.Enqueue(item);
            Monitor.PulseAll(_gate);     // wake any waiting consumers
        }
    }

    public T Take()
    {
        lock (_gate)
        {
            while (_items.Count == 0)
                Monitor.Wait(_gate);

            var item = _items.Dequeue();
            Monitor.PulseAll(_gate);
            return item;
        }
    }
}
```

ここでのゲートが `Lock` ではなく素の `object` であることに注目してください。`Monitor.Wait`/`Pulse` はオブジェクトの sync block 上で動作し、`System.Threading.Lock` では利用できません。それがトレードオフです。2026 年にこのパターンをゼロから書いていることに気づいたら、立ち止まって、[`Channel<T>` がこのすべてを置き換えられないか](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)を確認してください。`System.Threading.Channels` は、バックプレッシャーを組み込んだ、有界で非同期に優しいプロデューサー/コンシューマーキューを提供し、二度と `Monitor.Wait` に触れることはありません。手作りの有界バッファーは、今ではほぼ歴史的・教育的な関心の対象です。

`Monitor` を直接呼び出すかもしれないもう 1 つの場所は、非ブロッキングの試行のための `Monitor.TryEnter` ですが、`System.Threading.Lock` にも `TryEnter` があるため、.NET 9+ ではその理由は消えてなくなります。

## ベンチマーク: Lock が Monitor に対して実際に節約するもの

パフォーマンスの主張は具体的に、`System.Threading.Lock` が、競合のない高速パスと競合パスの両方で、`Monitor` に支えられた `lock (object)` より速いというものです。Stephen Toub の記事 [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) は、これを BenchmarkDotNet で測定しています。競合のない取得は、単一のインターロックされた compare-exchange とフェンスに収束します。競合する取得は `Monitor.Enter` の経路よりおよそ 2-3 倍速く、これは `Monitor` がフェンスの前に複数の条件分岐を通過するためです。

合成的な数値が教えてくれないのは、それが実際のサービスでいかに重要でないかです。なぜなら、実際のサービスは `lock` の内部で実時間のほとんどを費やすことがないからです。本番での測定可能な利得は、スループットではなく構造的なものです。

- **ワーキングセット。** 各ゲートは「`object` に競合時の sync block を加えたもの」から「`Lock`、おおよそオブジェクトサイズに数バイトの状態を加えたもの」へと変わります。数千のゲートがあると、sync block テーブルは負荷の下で増大しなくなります。
- **GC の走査。** `Lock` は依然として GC が追跡する参照型ですが、GC が別途走査しなければならないプロセス全体の別テーブルを決してインフレーションさせません。

`Monitor` と `Lock` の間で *変わらない* もの: 保護されたセクション自体のスループット、公平性 (どちらも軽い飢餓防止つきで不公平)、再帰の挙動 (どちらも同じスレッドで再入可能) です。

`SemaphoreSlim` はまったく別のクラスにあり、比較は同等ではありません。同期的に完了する `WaitAsync` でも `Lock.EnterScope` より著しく高価であり、非同期に完了するものはメモリを割り当ててスレッドプールを往復します。速度のために `SemaphoreSlim` を選ぶのではありません。`await` をまたぐ唯一の正しい選択肢だから選ぶのであり、正しさは毎回サイクル数に勝ります。

## あなたの代わりに決めてしまう落とし穴

3 つの制約は好みを完全に上書きします。

**クリティカルセクション内の `await` は `SemaphoreSlim` を強制します。** これはスタイルの選択ではありません。`lock`、`Monitor`、`Lock` は所有権をマネージドスレッドで追跡し、`await` は別のスレッドで再開しうるため、間違った所有者からロックを解放してしまいます。C# コンパイラーは `lock` 内の `await` を [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996) で拒否します。狡猾なバリエーションは `await` を囲む `using (_gate.EnterScope())` です。これはコンパイルされるかもしれませんが、継続が一度も入っていないスレッドで scope を破棄しようとすると、実行時に `SynchronizationLockException` をスローします。本体が待機するなら、あなたは `SemaphoreSlim` です。以上です。これは、内部で [async void と async Task がなぜこれほど異なる挙動をするのか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)の背後にある推論と同じです。

**条件変数は `Monitor` を強制します。** あなたの調整が本当に「シグナルされるまで眠る」セマンティクスを必要とし、`Channel<T>` が合わないなら、それを行えるのは `Monitor.Wait` / `Pulse` だけです。

**.NET 9 より前のターゲットは `Lock` を除外します。** ライブラリが `netstandard2.0` を含む複数のターゲットを対象とする場合、`System.Threading.Lock` はその側には存在しません。`#if NET9_0_OR_GREATER` でそれを保護し、ダウンレベルの経路には `object` ゲートを残してください。`Lock` 型をポリフィルから型フォワードしないでください。セマンティクスが本物の型から乖離します。

## 推奨、改めて

.NET 9+ での同期的な相互排他には、デフォルトで `System.Threading.Lock` を使い、コンパイラーが `try` / `finally` をあなたの代わりに管理するように `lock` キーワードを通じて記述してください。素の `object` ゲートに下げるのは、.NET 9 より古いランタイムを対象としなければならない場合だけにし、そこでは `lock (object)` がわずかに高いコストで同一のセマンティクスを提供します。保護領域が `await` を含む瞬間に `SemaphoreSlim(1, 1)` に切り替え、並行性を 1 より上に制限したいときは `SemaphoreSlim(N, N)` を使ってください。`Monitor` を直接触るのは `Wait` / `Pulse` 条件変数のためだけにし、まず `Channel<T>` が手作りの調整全体を消し去らないかを問うてください。最短の正しい判断: 同期的かつ短いなら `Lock`、非同期なら `SemaphoreSlim`、シグナリングなら `Monitor`。

## 関連

- [.NET 11 で新しい System.Threading.Lock 型を使う方法](/ja/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) は、新しい型への移行と使用に関する詳細な解説です。
- [.NET 9: lock(object) の終わり](/ja/2026/01/net-9-the-end-of-lockobject/) は、`System.Threading.Lock` への元のニュース形式の導入です。
- [C# で BlockingCollection の代わりに Channels を使う方法](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は、手作りの `Monitor.Wait` 調整を置き換えるプロデューサー/コンシューマーパターンを示します。
- [C# における async void vs async Task: それぞれが正しいのはいつか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) は、lock 内で await を使わないというルールの背後にあるスレッド再開の挙動を説明します。
- [C# で長時間実行される Task をデッドロックなしでキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は、キャンセル可能な `WaitAsync` オーバーロードと対になります。

## ソースリンク

- [`System.Threading.Lock` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.lock)、Microsoft Learn より。
- [`SemaphoreSlim` クラスリファレンス](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim)、Microsoft Learn より、スレッド同一性に関する注記を含む。
- [`Monitor` クラスリファレンス](https://learn.microsoft.com/dotnet/api/system.threading.monitor)、`Wait`、`Pulse`、`PulseAll` を扱う。
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading)、Stephen Toub による、`Lock` vs `Monitor` のマイクロベンチマークを含む。
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812)、`System.Threading.Lock` を導入した提案。
