---
title: ".NET 11 で新しい System.Threading.Lock 型を使う方法"
description: "System.Threading.Lock は .NET 9 で登場し、.NET 11 と C# 14 では既定の同期プリミティブです。本ガイドでは lock(object) からの移行、EnterScope の動作、await・dynamic・ダウンレベル ターゲットにまつわる落とし穴を解説します。"
pubDate: 2026-04-30
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

最短の答え: `private readonly object _gate = new();` を `private readonly Lock _gate = new();` に置き換え、各 `lock (_gate) { ... }` 文はそのまま残し、C# 14 コンパイラに `lock` キーワードを `Monitor.Enter` ではなく `Lock.EnterScope()` へバインドさせます。.NET 11 では、より小さなオブジェクト、sync block の膨張なし、競合する fast path での測定可能なスループット向上が得られます。考慮が必要なのは、ブロックが `await` を必要とする場合、フィールドが `dynamic` 経由で公開される場合、`System.Threading` の `using static` を行っている場合、そして同じコードが `netstandard2.0` 向けにもコンパイルされる場合だけです。

本ガイドは .NET 11 (preview 4) と C# 14 を対象とします。`System.Threading.Lock` 自体は .NET 9 の型なので、ここで述べる内容は .NET 9、.NET 10、.NET 11 のいずれでも動作します。`lock` を `Lock.EnterScope()` にバインドさせるコンパイラ レベルのパターン認識は C# 13 (.NET 9) で導入され、C# 14 でも変わりません。

## なぜ `lock(object)` は常にワークアラウンドだったのか

19 年間、「このセクションをスレッド セーフにする」ための C# の標準パターンは、private な `object` フィールドと `lock` 文の組み合わせでした。コンパイラはこれを、オブジェクトの identity に対する [`Monitor.Enter`](https://learn.microsoft.com/dotnet/api/system.threading.monitor.enter) と `Monitor.Exit` の呼び出しへ変換します。仕組みは機能しましたが、構造的なコストが 3 つありました。

第一に、ロックされる各領域はオブジェクト ヘッダー ワード分のコストを支払います。CLR のマネージド ヒープ上の参照型は `ObjHeader` と `MethodTable*` を持ち、x64 で存在するだけで合計 16 バイトを消費します。ロック用に確保する `object` には identity 以外の用途がありません。ドメイン モデルには何も寄与しないにもかかわらず、GC は依然としてそれをトレースする必要があります。

第二に、2 つのスレッドがロックを奪い合った瞬間、ランタイムはヘッダーを [SyncBlock](https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/sync-block-table.md) へ膨張させます。SyncBlock テーブルはプロセス全体の `SyncBlock` エントリのテーブルで、各エントリは必要に応じて確保され、プロセス終了まで解放されません。長時間動作するサービスが何百万もの異なるオブジェクトをロックすると、SyncBlock テーブルは単調に増え続けます。稀ではありますが実在する事象で、診断には `dotnet-dump` と `!syncblk` しか手段がありませんでした。

第三に、`Monitor.Enter` は再入可能 (同じスレッドが二度入れ、退出回数が一致したときに初めて解放) で、`Monitor.Wait` / `Pulse` / `PulseAll` をサポートします。ほとんどのコードはどれも必要としません。必要なのは相互排他です。使ったこともない機能の代金を払っていたわけです。

`System.Threading.Lock` は、`Monitor` が `lock` の実装を兼ねていなければ Microsoft が 2002 年に出していたであろう型です。これを導入した提案 ([dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812)、2024 年に承認) は、これを「より高速で、フットプリントが小さく、セマンティクスがより明確なロック」と表現しています。シールされた参照型で、相互排他に必要なものだけを公開します: 入る、入ろうとする、出る、現在のスレッドがロックを保持しているか確認する。`Wait` はありません。`Pulse` もありません。オブジェクト ヘッダーの魔術もありません。

## 機械的な移行

典型的なレガシー キャッシュを取り上げます:

```csharp
// .NET Framework 4.x / .NET 8, C# 12 -- the old shape
public class LegacyCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

.NET 11 への移行は、たった 1 行を変えるだけです:

```csharp
// .NET 11, C# 14 -- the new shape, single-line diff
public class ModernCache
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

各 `lock` 文の本体は変更しません。コンパイラは `_gate` が `Lock` であることを認識し、`lock (_gate) { body }` を次のように展開します:

```csharp
// What the compiler emits, simplified
using (_gate.EnterScope())
{
    // body
}
```

`EnterScope()` は `Lock.Scope` 構造体を返し、その `Dispose()` がロックを解放します。`Scope` は `ref struct` のため、ボックス化されることも、イテレーターや async メソッドにキャプチャされることも、フィールドに格納されることもできません。この最後の制約こそが新しいロックを安価にしています: アロケーションなし、仮想ディスパッチなし、スタック ローカルのハンドルだけです。

順序を逆にして (`Lock _gate` だが、別の場所のツールが `Monitor.Enter(_gate)` を呼ぶ) と、C# コンパイラは C# 13 から CS9216 を出します: "A value of type `System.Threading.Lock` converted to a different type will use likely unintended monitor-based locking in `lock` statement"。変換自体は許可されています (`Lock` は依然として `object` です) が、コンパイラは新しい型のメリットをすべて捨てたことを警告します。

## `EnterScope` が実際に返すもの

必要なら `lock` キーワードを使わずに新しい型を使えます:

```csharp
// .NET 11, C# 14
public byte[] GetOrCompute(string key, Func<string, byte[]> factory)
{
    using (_gate.EnterScope())
    {
        if (_store.TryGetValue(key, out var existing))
            return existing;

        var fresh = factory(key);
        _store[key] = fresh;
        return fresh;
    }
}
```

`EnterScope()` はロックを取得するまでブロックします。タイムアウトなしの `TryEnter()` (`bool` を返し、`Scope` なし) と、時間制限付き取得用の `TryEnter(TimeSpan)` もあります。`TryEnter` を呼んで `true` が返ったら、同じスレッドで `Exit()` を 1 回だけ自分で呼ぶ必要があります。`Exit` を忘れるとロックがリークし、次の取得者は永遠にブロックされます。

```csharp
// .NET 11, C# 14 -- TryEnter idiom for non-blocking back-pressure
if (_gate.TryEnter())
{
    try
    {
        DoWork();
    }
    finally
    {
        _gate.Exit();
    }
}
else
{
    // back off, reschedule, drop the message, etc.
}
```

`Lock.IsHeldByCurrentThread` は `bool` プロパティで、呼び出し元のスレッドが現在ロックを保持している場合にだけ `true` を返します。これは不変条件の `Debug.Assert` 呼び出し向けで、フロー制御の手段として使うべきではありません。`O(1)` ですが acquire-release セマンティクスを伴うため、ホット ループで呼べばコストがかかります。

## await の罠、いっそう悪化

`Monitor` ベースの `lock` 文の中で `await` することは元々できませんでした。コンパイラは [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996) で正面から拒否します: "Cannot await in the body of a lock statement"。理由は、`Monitor` がオーナーシップをマネージド スレッド ID で追跡するため、`await` を別のスレッドで再開すると誤ったオーナーから解放してしまうからです。

`Lock` にも同じ制約があり、コンパイラは同じ方法で強制します。試してみてください:

```csharp
// .NET 11, C# 14 -- DOES NOT COMPILE
public async Task DoIt()
{
    lock (_gate)
    {
        await Task.Delay(100); // CS1996
    }
}
```

再び `CS1996` が出ます。良いことです。より大きな罠は `using (_gate.EnterScope())` です。コンパイラは `Scope` が `Lock` 由来であることを知らないからです。.NET 11 SDK 11.0.100-preview.4 時点では、次のコードはコンパイルが通ります:

```csharp
// .NET 11, C# 14 -- COMPILES, but is broken at runtime
public async Task Broken()
{
    using (_gate.EnterScope())
    {
        await Task.Delay(100);
        // Resumes on a thread-pool thread, which does NOT hold _gate.
        // Disposing the Scope here calls Lock.Exit on a thread that
        // never entered, throwing SynchronizationLockException.
    }
}
```

修正は昔からのお決まりです: ロックを引き上げて同期的なクリティカル セクションだけを囲むようにし、`await` をまたぐ相互排他が本当に必要なら `SemaphoreSlim` (async 対応) を使います。`Lock` は高速な同期プリミティブです。async ロックではなく、async ロックを目指してもいません。

## パフォーマンス: 実際に何が変わったのか

.NET 9 のリリース ノートは、競合下の取得が `Monitor.Enter` 相当の経路に比べておよそ 2-3 倍速く、競合なしの取得は単一の interlocked compare-exchange に支配される、と述べています。Stephen Toub の [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) には、まさにこれを示すマイクロベンチマークが含まれており、.NET 11 でも再現します。

実サービスで測れる節約は、合成の数値から想像するよりも小さくなります。実サービスは大半の時間を `lock` の中で過ごすことが少ないからです。違いが見えるのは次のような場面です:

- **ワーキング セット**: 各 gate は「`object` プラス競合時の sync block」から「`Lock` (おおむね `object` サイズに 8 バイトの状態を加えたもの)」へ変わります。たとえばキャッシュ エントリごとに数千の gate がある場合、競合下でも sync block テーブルは増えなくなります。
- **GC2 のトラバーサル**: `Lock` も参照型ですが、GC が別途辿らねばならない外部テーブルを膨らませることがありません。
- **競合下の fast path**: 新しい fast path は単一の `CMPXCHG` とメモリ フェンスです。古い経路は `Monitor` を経由し、フェンス前に複数の条件分岐がありました。

変わらないもの: 保護対象セクション自体のスループット、フェアネス (新しい `Lock` も unfair で、starvation 防止が薄く乗っているだけ)、再入 (`Lock` も同一スレッドで再入可能、`Monitor` と同じ)。

## 噛みついてくる落とし穴

**`using static System.Threading;`** -- プロジェクト内のいずれかのファイルがこれを行っていると、修飾なしの名前 `Lock` は自前の `Lock` クラスと曖昧になります。修正は `using static` を消すか、型を明示的に修飾する (`System.Threading.Lock`) ことです。コンパイラは [CS0104](https://learn.microsoft.com/dotnet/csharp/misc/cs0104) を出しますが、エラー位置は `Lock` を使用した場所であって、衝突を導入した場所ではありません。

**`dynamic`** -- `dynamic` 型の式に対する `lock` 文は、バインドが実行時に行われるため `Lock.EnterScope()` に解決できません。コンパイラは CS9216 を出して `Monitor` にフォールバックします。稀な `dynamic` を使うコードベースを抱えているなら、`lock` の前に `Lock` へキャストしてください:

```csharp
// .NET 11, C# 14
dynamic d = GetGate();
lock ((Lock)d) { /* ... */ } // cast is required
```

**`object` への ボックス化** -- `Lock` は `object` から派生しているため、`Monitor.Enter` を含む `object` を取る任意の API に渡せます。それは新しい経路を台無しにします。CS9216 は味方です。`Directory.Build.props` でエラーに昇格しましょう:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);CS9216</WarningsAsErrors>
</PropertyGroup>
```

**`netstandard2.0` ライブラリ** -- ライブラリが `netstandard2.0` と `net11.0` をマルチターゲットしている場合、`netstandard2.0` 側には `Lock` は存在しません。選択肢は 2 つ。きれいな方法は、`netstandard2.0` では `object` フィールド、`net11.0` では `Lock` フィールドを `#if NET9_0_OR_GREATER` で保護して保持することです:

```csharp
// .NET 11, C# 14 -- multi-target gate
#if NET9_0_OR_GREATER
private readonly System.Threading.Lock _gate = new();
#else
private readonly object _gate = new();
#endif
```

汚い方法は polyfill パッケージから `Lock` を type-forward することです。やめてください、polyfill が本物の型のセマンティクスとずれた途端に泣きを見ます。

**WPF と WinForms の `Dispatcher`** -- ディスパッチャの内部キューは依然として `Monitor` を使います。そのロックを差し替えることはできません。アプリケーション側のロックは移行できますが、フレームワーク側はできません。

**`lock(object)` を生成する Source Generator** -- 再生成してください。CommunityToolkit.Mvvm 9 ほかいくつかは 2024 年末に `Lock` へ切り替わりました。生成ファイルで `private readonly object` を確認し、まだあればパッケージを更新してください。

## `Lock` を使うべきでないとき

答えが「ロックなし」のときは `Lock` (やその他の短命なミューテックス) を使わないでください。`ConcurrentDictionary<TKey, TValue>` に外部 gate は不要です。`ImmutableArray.Builder` も不要です。`Channel<T>` も不要です。最も速い同期は、書かない同期です。

保護対象セクションが `await` をまたぐときは `Lock` を使わないでください。`SemaphoreSlim(1, 1)` と `await semaphore.WaitAsync()` を使います。1 回あたりのオーバーヘッドは大きくなりますが、それが唯一の正しい選択です。

プロセス間やマシン間の調整に `Lock` を使わないでください。プロセス内専用です。それには [`Mutex`](https://learn.microsoft.com/dotnet/api/system.threading.mutex) (名前付き、カーネルベース)、データベースの行ロック、Redis の `SETNX` を使います。

## 関連

- [C# で BlockingCollection の代わりに Channels を使う方法](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) はロックを丸ごと置き換えがちな producer/consumer パターンを扱います。
- [C# で長時間実行する Task をデッドロックなく取り消す方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は本記事のキャンセル コンパニオンです。
- [.NET 9: lock(object) の終焉](/2026/01/net-9-the-end-of-lockobject/) は .NET 9 リリース時に書かれたニュース調の型紹介です。
- [INotifyPropertyChanged 用の Source Generator を書く方法](/ja/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) は `Lock` 対応で更新が必要になりがちなジェネレーター像を示します。

## 出典

- [`System.Threading.Lock` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.lock) (Microsoft Learn)。
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812) -- 提案と設計議論。
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) (Stephen Toub)。
- [What's new in C# 13](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13) はコンパイラ レベルのパターン認識を扱います。
