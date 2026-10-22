---
title: "C# の Lazy<T>、LazyInitializer.EnsureInitialized、ダブルチェックロッキングの比較"
description: "基本は Lazy<T> を使ってください。ファクトリを 1 回だけ実行し、例外をキャッシュし、初期化後の読み取りは計測できないほど軽量です。多数のフィールドや配列スロットを遅延初期化していて、値ごとの追加オブジェクトを避けたい場合は LazyInitializer.EnsureInitialized を使います。手書きのダブルチェックロッキングは、.NET 10 ではほとんど割に合いません。"
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "ja"
translationOf: "2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-22
---

基本は `Lazy<T>` を使ってください。デフォルトのコンストラクターモード (`ExecutionAndPublication`) では、競合下でもファクトリがちょうど 1 回だけ実行されることが保証され、ファクトリの例外はキャッシュされ、値が作られた後の読み取りは null チェック 1 回とフィールド読み込み 1 回だけなので、BenchmarkDotNet では計測できないほど軽量です。遅延作成される値が多数ある場合 (ホットな型でプロパティごとにフィールドがある場合や、配列のスロットの場合) で、値ごとの `Lazy<T>` オブジェクトが避けたいコストなら、`LazyInitializer.EnsureInitialized` を選びます。手書きのダブルチェックロッキングは、`LazyInitializer.EnsureInitialized(ref field, ref syncLock, factory)` が既に提供していないものを何も提供しません。どちらの API にもない動作が必要なときだけ書いてください。

以下はすべて、.NET 10.0.10 (SDK 10.0.302)、C# 14、BenchmarkDotNet 0.15.8、Apple M4 (arm64) で計測した結果です。API 自体の形は .NET Core 3.0 以降変わっていないため、この助言は .NET 8、9、10、11 でも当てはまります。

## 比較の概要

| | `Lazy<T>` (デフォルト) | `LazyInitializer.EnsureInitialized(ref t, f)` | `EnsureInitialized(ref t, ref sync, f)` | ダブルチェックロッキング |
| --- | --- | --- | --- | --- |
| 競合下でファクトリが実行される回数は最大 1 回か | はい | いいえ、競合したスレッドすべてが実行する可能性があります | はい | はい (正しく書いた場合) |
| ファクトリの例外 | キャッシュされ、以後ずっと再スローされます | キャッシュされず、次の呼び出しで再試行されます | キャッシュされず、次の呼び出しで再試行されます | 書き方次第です |
| 遅延値ごとの追加アロケーション | `Lazy<T>` オブジェクトとロック用ヘルパー | なし | ロックオブジェクト 1 つ (競合時または初回呼び出し時のみ) | ロックオブジェクト 1 つ (または共有) |
| 初期化後のホットな読み取り (計測値) | 1 ns 未満、計測不能 | 1 ns 未満 | 1 ns 未満 | 1 ns 未満 |
| 1 回限りの作成と初期化 (計測値) | 13.96 ns、96 B | 6.19 ns、48 B | 14.03 ns、80 B | 8.96 ns、72 B |
| 値型での利用 | はい | いいえ (`where T : class`) | いいえ、`ref bool initialized` を取るオーバーロードを使います | はい (別途フラグが必要) |
| ファクトリが `null` を返せるか | はい | いいえ、`InvalidOperationException` をスローします | いいえ、`InvalidOperationException` をスローします | はい (別途フラグが必要) |
| ファクトリからの再入 | `InvalidOperationException` をスローします | スタックオーバーフロー | スタックオーバーフロー (`Monitor` は再入可能です) | ロックの種類次第です |
| 自分で管理するコード行数 | 1 | 1 | フィールド 2 つ + 呼び出し 1 つ | 約 10 |

## 各選択肢が実際に行うこと

### `Lazy<T>`

`Lazy<T>` はファクトリとスロットをラップします。.NET 10 での `Value` プロパティは 1 行です。

```csharp
// System.Private.CoreLib, release/10.0, src/System/Lazy.cs
public T Value => _state == null ? _value! : CreateValue();
```

`_state` は volatile な `LazyHelper` 参照で、モードを表し、`ExecutionAndPublication` ではロックオブジェクトも兼ねます。最初の呼び出しは `CreateValue` に入り、`lock (executionAndPublication)` を取得し、再チェックし、ファクトリを実行し、`_value` を格納してから、volatile な書き込みで `_state = null` を設定します。以後の呼び出しは `_state == null` を確認してフィールドを返すだけです。これはダブルチェックロッキングそのものであり、私たちの多くよりもメモリモデル仕様を丁寧に読んだ人たちが、一度だけ書いたものです。

スレッドセーフティモードはコンストラクターで選びます。

```csharp
// .NET 10, C# 14
var a = new Lazy<Config>(LoadConfig);                                          // ExecutionAndPublication
var b = new Lazy<Config>(LoadConfig, isThreadSafe: true);                      // ExecutionAndPublication
var c = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.PublicationOnly);    // threads race, first publish wins
var d = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.None);               // single-threaded only
```

### `LazyInitializer.EnsureInitialized`

`LazyInitializer` は静的クラスで、自分が所有するフィールドに対して `ref` 経由で動作します。ラッパーオブジェクトはありません。2 引数のオーバーロードは、全体で次のとおりです。

```csharp
// System.Private.CoreLib, release/10.0, src/System/Threading/LazyInitializer.cs
public static T EnsureInitialized<T>(ref T? target, Func<T> valueFactory) where T : class =>
    Volatile.Read(ref target!) ?? EnsureInitializedCore(ref target, valueFactory);

private static T EnsureInitializedCore<T>(ref T? target, Func<T> valueFactory) where T : class
{
    T value = valueFactory() ?? throw new InvalidOperationException(SR.Lazy_StaticInit_InvalidOperation);
    Interlocked.CompareExchange(ref target, value, null!);
    return target;
}
```

ロックはありません。`null` を見たスレッドはすべてファクトリを実行し、`CompareExchange` がどの結果を格納するかを決めます。負けたスレッドのオブジェクトは捨てられます (ドキュメントにも、このメソッドは "will not dispose of the objects that were not stored" と明記されています)。これはラッパーなしの `PublicationOnly` のセマンティクスです。

3 引数のオーバーロード `EnsureInitialized(ref target, ref syncLock, valueFactory)` はロックを追加します。`syncLock` に素の `object` を `CompareExchange` で遅延作成し、その後 `lock (syncLock) { if (Volatile.Read(ref target) == null) Volatile.Write(ref target, valueFactory()); }` を実行します。これは教科書どおりのダブルチェックロッキングで、ファクトリは 1 回だけ実行されます。

値型の場合や、`null` が正当な結果である場合には、追加の `ref bool initialized` フラグを持つオーバーロードがあります。これらは常にロックを使う経路を通ります。

### 手書きのダブルチェックロッキング

.NET 9 以降で `System.Threading.Lock` 型を使った、現在の正しい書き方です。

```csharp
// .NET 10, C# 14
public sealed class ReportCache
{
    private volatile Report? _report;
    private readonly Lock _lock = new();

    public Report Report
    {
        get
        {
            var r = _report;               // one volatile read on the fast path
            if (r is not null) return r;
            lock (_lock)
            {
                return _report ??= BuildReport();
            }
        }
    }

    private static Report BuildReport() => new();
}

public sealed class Report;
```

`volatile` は実際に意味のある働きをしています。.NET メモリモデル仕様 (dotnet/runtime の `docs/design/specs/Memory-model.md`) には、共有メモリへのオブジェクト参照の格納はリリースであり、それを介したデータ依存の読み取りは順序付けられると書かれているため、古典的な"構築途中のオブジェクト"バグは CoreCLR では起こりません。しかし同時に、参照代入の順序付けの副作用を一般的な順序付けの目的に使うべきではないとも明示的に警告されており、volatile でないフィールドでは JIT が `_report` の読み取りを巻き上げたり統合したりできます。`volatile` を付けるか `Volatile.Read` で読めば、このパターンは .NET が動作するすべてのアーキテクチャで正しく動作します。

## 競合時の挙動を実証する

ドキュメントには "may run more than once" とあります。私は数字が欲しいと思いました。このプローブは `Barrier` 上で 16 個のスレッドを開始し、全員が同時に遅延値にアクセスするようにし、競合の窓を広げるために約 20,000 回スピンするファクトリを使い、これを 200 回繰り返して最悪のラウンドを記録します。

```csharp
// .NET 10.0.10, C# 14, Apple M4, 10 cores
static int Race(Func<Func<object>, Func<object>> makeAccessor)
{
    int maxCalls = 0;
    for (int r = 0; r < 200; r++)
    {
        int calls = 0;
        Func<object> factory = () =>
        {
            Interlocked.Increment(ref calls);
            Thread.SpinWait(20_000);
            return new object();
        };
        var access = makeAccessor(factory);
        using var barrier = new Barrier(16);
        var results = new object[16];
        var threads = Enumerable.Range(0, 16)
            .Select(i => new Thread(() => { barrier.SignalAndWait(); results[i] = access(); }))
            .ToArray();
        foreach (var t in threads) t.Start();
        foreach (var t in threads) t.Join();
        if (results.Distinct().Count() != 1) throw new Exception("different instances returned");
        maxCalls = Math.Max(maxCalls, calls);
    }
    return maxCalls;
}
```

結果 (200 ラウンド中の最悪のラウンド):

| 選択肢 | 1 ラウンドでのファクトリ呼び出し回数の最大値 |
| --- | --- |
| `Lazy<T>` デフォルト (`ExecutionAndPublication`) | 1 |
| `Lazy<T>` `PublicationOnly` | 11 |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 12 |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 1 |

どの選択肢も、すべてのラウンドで 16 スレッド全員に同じインスタンスを返したので、"安全でない"ものはありません。違いは無駄な作業です。ファクトリがソケットを開く、40 MB のファイルを読む、有料の API を呼ぶといった処理なら、公開された値が正しくても、12 並列の実行は本物のバグです。

## 例外キャッシュの落とし穴

これは本番環境で問題になる動作の違いです。同じファクトリで、最初の呼び出しは失敗し、2 回目は成功します。

```csharp
// .NET 10.0.10, C# 14
int attempts = 0;
Func<string> flaky = () => ++attempts == 1 ? throw new InvalidOperationException("transient") : "ok";

var lazy = new Lazy<string>(flaky);
// lazy.Value -> InvalidOperationException: transient
// lazy.Value -> InvalidOperationException: transient   (factory not called again)

string? field = null;
// LazyInitializer.EnsureInitialized(ref field, flaky) -> InvalidOperationException: transient
// LazyInitializer.EnsureInitialized(ref field, flaky) -> "ok"
```

プローブで確認できました。デフォルトの `Lazy<T>` はファクトリを 1 回だけ呼び出し、以後のアクセスでは毎回同じ例外をスローしました。`PublicationOnly` と `LazyInitializer` は 2 回呼び出し、回復しました。

MS Learn の例外の表にはルールが明記されています。`valueFactory` を取る `Lazy<T>` のコンストラクターはすべて例外をキャッシュします。ただしモードが `PublicationOnly` の場合は除きます。引数なしのコンストラクター (`Activator.CreateInstance` を使います) はキャッシュしません。したがって、起動時に存在しない設定値を読むファクトリを持つ `Lazy<HttpClient>` は、後から設定が現れても、プロセスの存続期間中ずっとスローし続けます。失敗が一時的なものになり得るなら、`PublicationOnly` を使うか、`LazyInitializer` を使うか、`catch` 内で `Lazy<T>` インスタンスを差し替えてください。

`Lazy<Task<T>>` では、この罠は二重にたちが悪くなります。ファクトリはスローせず、失敗した `Task` を返し、その失敗した Task はどのモードでも成功した値としてキャッシュされます。非同期の処理をキャッシュするなら、`IsFaulted` を確認してインスタンスを差し替えるか、本物のキャッシュを使ってください。

## ベンチマーク

問いは 2 つです。値が作られた後の読み取りのコストはいくらか。そして、オーナーを作成して値に一度触れるとき、インスタンスごとのコストは選択肢ごとにいくらか。方法: BenchmarkDotNet 0.15.8、デフォルトのジョブ、`[MemoryDiagnoser]`、.NET 10.0.10 arm64 RyuJIT、Apple M4、macOS。各ホルダークラスは `Value` プロパティを公開します。`Expensive` は小さなクラスで、計測対象がファクトリではなく遅延処理の仕組みになるようにしています。完全なソースは下の `HotPath` と `ColdPath` クラスです。

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8
public sealed class LazyHolder
{
    private readonly Lazy<Expensive> _value = new(() => new Expensive());
    public Expensive Value => _value.Value;
}

public sealed class LazyInitHolder
{
    private Expensive? _value;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, static () => new Expensive());
}

public sealed class LazyInitLockHolder
{
    private Expensive? _value;
    private object? _sync;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, ref _sync, static () => new Expensive());
}

[MemoryDiagnoser]
public class ColdPath
{
    [Benchmark(Baseline = true)] public int Plain() => new PlainHolder().Value.Id;
    [Benchmark] public int Lazy_ExecutionAndPublication() => new LazyHolder().Value.Id;
    [Benchmark] public int LazyInitializer_Factory() => new LazyInitHolder().Value.Id;
    [Benchmark] public int LazyInitializer_SyncLock() => new LazyInitLockHolder().Value.Id;
    [Benchmark] public int DoubleChecked_Lock() => new DoubleCheckedHolder().Value.Id;
    [Benchmark] public int Lazy_NeverTouched() => new LazyHolder() is null ? 0 : 1;
}
```

ホットパス (値は作成済み、読み取り 1 回):

| メソッド (.NET 10.0.10、arm64) | 平均 | アロケーション |
| --- | --- | --- |
| 通常のフィールド (`??=`、スレッドセーフではありません) | 0.000 ns | 0 B |
| `Lazy<T>` `ExecutionAndPublication` | 0.000 ns | 0 B |
| `Lazy<T>` `PublicationOnly` | 0.000 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 0.495 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 0.289 ns | 0 B |
| ダブルチェックロッキング (`volatile` + `Lock`) | 0.314 ns | 0 B |

コールドパス (オーナーを割り当て、値を 1 回読み取る):

| メソッド (.NET 10.0.10、arm64) | 平均 | 比率 | アロケーション |
| --- | --- | --- | --- |
| 通常のフィールド (`??=`、スレッドセーフではありません) | 1.53 ns | 1.00 | 24 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 6.19 ns | 4.04 | 48 B |
| ダブルチェックロッキング (`volatile` + `Lock`) | 8.96 ns | 5.85 | 72 B |
| `Lazy<T>` `PublicationOnly` | 9.68 ns | 6.32 | 64 B |
| `Lazy<T>` `ExecutionAndPublication` | 13.96 ns | 9.12 | 96 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 14.03 ns | 9.16 | 80 B |
| `Lazy<T>` を作成、`Value` は未読 | 6.17 ns | 4.03 | 72 B |

ホットパスは差がありません。値が作られた後は、どの選択肢も BenchmarkDotNet の分解能を下回ります。tier-1 JIT が `Lazy<T>.Value` を `_state` の null チェックとフィールド読み込みにまでインライン化し、BenchmarkDotNet は空のメソッドと区別できないものとして報告します。他の行のサブナノ秒の数値はノイズの範囲内です。誰かが"読み取り性能のために"`Lazy<T>` を手書きのコードに置き換えるよう勧めても、計測結果では得られるものは何もありません。

選択肢ごとの違いが出るのはコールドパスで、その大部分はアロケーションです。`Lazy<T>` の行がそれを物語っています。`Lazy<T>` は誰も読む前から 72 バイトを消費し (`Lazy<T>` オブジェクト自体と、`ExecutionAndPublication` がロック用にコンストラクターで割り当てる `LazyHelper`)、一度作成して初期化するのに約 14 ns かかります。`PublicationOnly` はヘルパーを省略するため、8 バイトと 4 ns 安くなります。ロックを使わない `LazyInitializer` のオーバーロードは、値以外に何も割り当てないため、スレッドセーフな選択肢の中で最も安い 6.2 ns です。`ref syncLock` のオーバーロードは、初回呼び出しで作成するロックオブジェクトの分を支払うため、1 回限りのコストは `Lazy<T>` に近くなります。

`Allocated` 列について 1 点注意があります。.NET 10 のエスケープ解析は、エスケープしないと証明できるホルダーオブジェクトをスタックに割り当てるため、通常のベースラインが 24 バイトしか示していません。この列は絶対的なオブジェクトサイズとしてではなく、ベースラインとの相対で読んでください。

絶対値で見ると、値ごとの 8 ns と 48 バイトが問題になるのは、数百万のオーナーを作成する場合だけです。起動時に一度だけ構築される `Lazy<T>` フィールドを持つサービスでは、まず目にすることはありません。

## `Lazy<T>` を選ぶ場合

- **クラス内のシングルトン的な依存関係**: パース済みの設定、コンパイル済みの `Regex`、オプションから構築したクライアントなど。`Lazy<T>` フィールド 1 つ、1 行で、ファクトリは 1 回だけ実行されます。
- **高コストまたは副作用のあるファクトリ**: 接続を開いたり API を呼んだりするもの。デフォルトモードは、手間なく 1 回だけの実行を保証する唯一の選択肢です。
- **値型や `null` の結果**: `Lazy<int>` と `Lazy<string?>` はそのまま動作します。プローブで、`new Lazy<string?>(() => null).Value` が `null` を返し、`IsValueCreated == true` になることを確認しました。
- **再帰時に明確なエラーが欲しい場合**: 自分自身の `Value` に触れるファクトリは、スタックオーバーフローではなく `InvalidOperationException: ValueFactory attempted to access the Value property of this instance.` を受け取ります。

## `LazyInitializer.EnsureInitialized` を選ぶ場合

- **インスタンス数が多い型に遅延フィールドが多数ある場合**: `Lazy<T>` のラッパーは値ごとに 1 オブジェクトで、誰も読まなくても作成されます (コールドパスの表の"未読"行では 72 バイト)。これは MS Learn のガイダンスが `LazyInitializer` の用途として挙げているケースで、"クラスのオーバーヘッドなし"での遅延初期化です。
- **遅延構築されるエントリの配列**: `LazyInitializer.EnsureInitialized(ref _slots[i], () => Build(i))` は、配列要素が `ref` で渡せるため動作します。スロットごとにラッパーを先に 1 つずつ割り当てずに済む `Lazy<T>[]` 相当のものはありません。
- **安価で副作用のないファクトリ**: 競合時にファクトリを 2 回実行してもコストがかからないなら、ロックを使わない 2 引数のオーバーロードが最も安価で正しい選択肢です。
- **失敗後に再試行したい場合**: どのオーバーロードも例外をキャッシュしません。

ファクトリを 1 回だけ実行する必要があるときは、`ref syncLock` のオーバーロードを使ってください。`null` で始まる `object?` 型のフィールドを渡します。これは、低速パスに到達した最初の呼び出しでのみ割り当てられます。

## 手書きのダブルチェックロッキングが今も正当化される場合

まれです。私が実際に必要だったのは次の 2 つのケースです。

- **値をリセットまたは差し替える必要がある場合**: `Lazy<T>` も `LazyInitializer` も値を無効化できません。シグナルで再構築するキャッシュには、独自のロックと volatile フィールドが必要です。
- **低速パスにファクトリ以上のものが必要な場合**: 2 つのフィールドをアトミックに初期化する場合や、`SemaphoreSlim` の下で非同期 API を呼ぶ場合。そうなると、もはや遅延初期化ではなく小さなステートマシンなので、明示的に書くべきです。

書くなら、.NET 9 以降では `System.Threading.Lock` を使い、フィールドは `volatile` にし、高速パスではローカル変数に一度だけ読み込み、`this` に対してロックしないでください。

## 選択を決めてしまう落とし穴

**静的**な遅延値なら、この 3 つのどれも必要ないことが多いでしょう。型初期化子で初期化される `static readonly` フィールドは遅延的であり (ランタイムがフィールドへの最初のアクセスの前に実行します)、スレッドセーフで、ホットパスでは無料です。tier-1 JIT は、初期化済みのクラスの `static readonly` フィールドを定数として扱うためです。

```csharp
// .NET 10, C# 14
public static class Pricing
{
    public static readonly FrozenDictionary<string, decimal> Table = LoadTable();
    private static FrozenDictionary<string, decimal> LoadTable() => /* ... */ FrozenDictionary<string, decimal>.Empty;
}
```

注意点があります。`LoadTable` がスローすると、その型はプロセスの存続期間中壊れたままになり、以後のアクセスはすべて `TypeInitializationException` をスローします。これは `Lazy<T>` と同じキャッシュ動作ですが、回復はより困難です。`PublicationOnly` の再試行セマンティクスが必要な場合や、ロードが失敗しても使えるようにしたい他の静的メンバーが型にある場合は、静的な `Lazy<T>` を使ってください。

## 改めて、推奨事項

`Lazy<T>` とデフォルトモードから始めてください。ファクトリは 1 回だけ実行され、ホットパスは null チェック 1 回で済み、唯一の本当の欠点 (例外のキャッシュ) は `PublicationOnly` で回避できます。プロファイリングでラッパーのアロケーションが問題だと分かったとき、実際には、遅延フィールドを複数持つインスタンスが多数あるときに、`LazyInitializer.EnsureInitialized` に切り替えてください。ファクトリを 1 回だけ実行する必要があるなら、`ref syncLock` のオーバーロードを使います。ダブルチェックロッキングを自分で書くのは、値をリセットする必要があるときか、複数のものをアトミックに初期化する必要があるときだけにしてください。

## 関連記事

- ロックを使う低速パスを自分で書く場合は、[lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) でどのプリミティブを選ぶべきかを解説しています。
- [System.Threading.Lock 型の解説](/ja/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) では、`Lock` フィールドに対する `lock` が、`object` をロックするより速い理由を説明しています。
- `volatile` と `Volatile.Read` が arm64 で実際に何を出力するかについては、[Volatile.Read vs Volatile.ReadBarrier in .NET 10](/ja/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/) をご覧ください。
- 遅延値が実際には期限切れになるべき、または非同期であるべきキャッシュエントリなら、[HybridCache vs IMemoryCache vs IDistributedCache](/ja/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) のほうが適切なツールです。
- スコープ付きサービスをキャプチャするシングルトン内の `Lazy<T>` は、[fixing "Cannot consume scoped service from singleton"](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) で説明されているキャプティブ依存関係のバグと同じものです。

## 参考資料

- [Lazy initialization](https://learn.microsoft.com/en-us/dotnet/framework/performance/lazy-initialization) (MS Learn)。例外キャッシュの表を含みます。
- [`LazyInitializer.EnsureInitialized`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized) の API リファレンス。
- [`LazyThreadSafetyMode`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazythreadsafetymode) の API リファレンス。
- dotnet/runtime `release/10.0` の [`Lazy.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Lazy.cs) と [`LazyInitializer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Threading/LazyInitializer.cs)。
- [.NET memory model spec](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md) の "Object assignment" と "Data-dependent reads are ordered" の節。
