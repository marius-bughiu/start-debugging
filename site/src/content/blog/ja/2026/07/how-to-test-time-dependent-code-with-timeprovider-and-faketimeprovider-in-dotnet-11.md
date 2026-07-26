---
title: ".NET 11 で TimeProvider と FakeTimeProvider を使って時間依存コードをテストする方法"
description: "DateTime.UtcNow、Stopwatch、Task.Delay を System.TimeProvider に置き換えて、テストから時計を制御します。依存性注入への登録、FakeTimeProvider.Advance と SetUtcNow、タイムアウトや PeriodicTimer ベースの BackgroundService のテスト、そして Advance と継続処理の落とし穴と xUnit v2 の問題まで解説します。"
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "async"
  - "timeprovider"
lang: "ja"
translationOf: "2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

.NET 11 で時間依存のコードをテストするには、`DateTime.UtcNow`、`Stopwatch`、`Task.Delay(...)` を直接呼ぶのをやめ、コンストラクターで `System.TimeProvider` を受け取るようにします。本番では `TimeProvider.System` を singleton として登録し、テストでは `Microsoft.Extensions.TimeProvider.Testing` パッケージの `FakeTimeProvider` を渡して、`Advance(TimeSpan)` と `SetUtcNow(DateTimeOffset)` で自分で時計を進めます。以前は 14 日待たなければ確認できなかった試用期間の期限切れ判定が、2 行のテストになります。この記事では .NET 11 (執筆時点では Preview 6、正式版は 2026 年 11 月) と C# 14、`Microsoft.Extensions.TimeProvider.Testing` 10.8.0 を対象に、パターン全体を扱います。痛い部分、つまり 1 回の呼び出しで複数のタイマー周期を飛び越えてしまう挙動、`Advance` の後に走らない継続処理、xUnit v2 の同期コンテキストによるハングも含みます。

`TimeProvider` は .NET 8 で標準搭載されました (`System.Runtime.dll`)。したがってここに書いてあることは .NET 8、9、10 でもそのまま動きます。.NET Framework 4.6.2 以降、.NET 5-7、netstandard2.0 では `Microsoft.Bcl.TimeProvider` パッケージがあり、API に 1 点だけ違いがあります。これは最後に触れます。

## 静的な時計がテストを実行不能にする理由

どのコードベースにもどこかに必ずあるコードです。

```csharp
// .NET 11, C# 14 -- untestable
public sealed class TrialService
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        DateTimeOffset.UtcNow - user.SignedUpAt >= TrialLength;
}
```

`DateTimeOffset.UtcNow` は OS の時計に支えられた静的プロパティです。差し替えの継ぎ目がありません。期限切れの分岐を通すには、良くない選択肢が 3 つしかありません。2 週間待つか、`user.SignedUpAt` を過去にずらすか (これは引き算は検証できますが、遷移の瞬間は検証できません)、静的メンバーにパッチを当てるモックフレームワークを持ち込むかです。最後の選択肢はプロファイラーベースのインターセプターを引き連れてきて、テストスイート全体を遅くします。

バグは境界に住んでいます。14 日目は期限切れなのか、まだ有効なのか。ちょうど `SignedUpAt + 14 days` の時点では何が起きるのか。ユーザーのローカルタイムゾーンでの夏時間の切り替わりではどうか。時計がマシンのものである限り、これらの問いには答えられません。

## TimeProvider が実際に抽象化しているもの

`TimeProvider` は 5 つの機能を持つ抽象クラスです。多くの人は最初のひとつしか採用しないので、すべて知っておく価値があります。

- `GetUtcNow()` と `GetLocalNow()` は `DateTimeOffset` を返します。`DateTimeOffset.UtcNow` と `DateTime.Now` の代わりです。
- `GetTimestamp()` は高頻度のティック値を返し、`GetElapsedTime(long)` / `GetElapsedTime(long, long)` はその 2 つの値を `TimeSpan` に変換します。`Stopwatch` の代わりです。
- `CreateTimer(TimerCallback, object?, TimeSpan, TimeSpan)` は `ITimer` を返します。`System.Threading.Timer` の代わりです。
- `LocalTimeZone` は `TimeZoneInfo` を返します。`TimeZoneInfo.Local` の代わりです。
- `TimestampFrequency` は `GetTimestamp()` の背後にあるティックの周波数を返します。

既定の実装は静的プロパティ `TimeProvider.System` です。UTC は `DateTimeOffset.UtcNow` から、タイムゾーンは `TimeZoneInfo.Local` から、タイムスタンプは `Stopwatch` から、タイマーは `System.Threading.Timer` から取得されます。まさにこれらの呼び出しへの薄い転送層なので、生の API と比べて追加のコストはありません。

`CreateTimer` が重要なのは、BCL が非同期プリミティブにも `TimeProvider` を組み込んだからです。次のオーバーロードはいずれも `TimeProvider` を受け取り、内部のタイマーをそれ経由で動かします。

- `Task.Delay(TimeSpan, TimeProvider)` と `Task.Delay(TimeSpan, TimeProvider, CancellationToken)`
- `Task.WaitAsync(TimeSpan, TimeProvider)` と `CancellationToken` を取るオーバーロード
- `new CancellationTokenSource(TimeSpan, TimeProvider)`
- `new PeriodicTimer(TimeSpan, TimeProvider)`

つまり、バックオフ付きのリトライループ、リクエストの期限、ポーリングするバックグラウンドサービスのいずれも、`Thread.Sleep` を 1 つも使わずにテストから制御できます。

## 時間依存クラスをテスト可能にする手順

1. 時計を読むクラスのコンストラクターに `TimeProvider` パラメーターを追加します。既定値として `TimeProvider.System` を与えてはいけません。与えると、テスト不能な経路がうっかり残ります。
2. そのクラス内の `DateTime.UtcNow`、`DateTimeOffset.Now`、`Stopwatch.StartNew()`、`new Timer(...)`、素の `Task.Delay(...)` をすべて `TimeProvider` の同等物に置き換えます。
3. コンポジションルートで本物の時計を登録します。`builder.Services.AddSingleton(TimeProvider.System);` です。
4. テストプロジェクトに `Microsoft.Extensions.TimeProvider.Testing` を追加します。
5. 各テストで `FakeTimeProvider` を生成し、開始時刻を固定し、アサーションの合間に `Advance` または `SetUtcNow` で時計を動かします。

記事の残りでは、この各手順を動くコードに展開していきます。

## 時計を受け取るようにサービスを書き直す

```csharp
// .NET 11, C# 14
public sealed class TrialService(TimeProvider timeProvider)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        timeProvider.GetUtcNow() - user.SignedUpAt >= TrialLength;
}
```

本番側の変更はこれだけです。プライマリコンストラクターがプロバイダーを保持し、呼び出し箇所の違いは `DateTimeOffset.UtcNow` が `timeProvider.GetUtcNow()` になっただけです。

登録は 1 行です。`TimeProvider.System` はアプリケーション全体で共有しても安全な singleton だからです。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<TrialService>();

var app = builder.Build();
```

ASP.NET Core 自身のコンポーネントも、すでにこの登録を探しています。.NET 8 以降、認証と Identity のスタック全体で `ISystemClock` は非推奨になり、オプションクラスは代わりに設定可能な `TimeProvider` プロパティを公開しています。これはコンテナーに登録があればそこから解決されます。したがって `TimeProvider.System` を登録すると、トークンの有効期間検証や cookie の期限切れもテスト可能になります。

## FakeTimeProvider を使った最初のテスト

```
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

2026 年 7 月時点の最新は 10.8.0 です。.NET 8.0 以降と .NET Framework 4.6.2 以降を対象とし、モダンな .NET では依存関係を持ちません。

```csharp
// .NET 11, C# 14, xUnit v3, Microsoft.Extensions.TimeProvider.Testing 10.8.0
using Microsoft.Extensions.Time.Testing;

public class TrialServiceTests
{
    [Fact]
    public void Trial_is_active_on_day_13_and_expired_on_day_14()
    {
        var time = new FakeTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 0, 0, TimeSpan.Zero));

        var user = new User(SignedUpAt: time.GetUtcNow());
        var sut = new TrialService(time);

        time.Advance(TimeSpan.FromDays(13));
        Assert.False(sut.IsTrialExpired(user));

        time.Advance(TimeSpan.FromDays(1));
        Assert.True(sut.IsTrialExpired(user));
    }
}
```

スリープもなく、日付を過去にずらすこともなく、14 日目の境界を明示的にアサートしています。`FakeTimeProvider` について、ここで押さえておきたい点が 3 つあります。

**引数なしのコンストラクターは 2000 年 1 月 1 日 UTC の午前 0 時から始まります。** これは意図的です。固定された、明らかに人工的な時刻であり、偶然「今日」と一致することがありません。うるう日や月末のまたぎのように、日付そのものがテスト対象の振る舞いに関わる場合は、コンストラクターに `DateTimeOffset` を渡してください。

**`LocalTimeZone` の既定値はマシンのタイムゾーンではなく `TimeZoneInfo.Utc` です。** そのため `SetLocalTimeZone(...)` を呼ぶまで `GetLocalNow()` は `GetUtcNow()` と一致します。これにより、自分のマシンとは別のリージョンにあるビルドエージェント上でも、タイムゾーンに依存するテストが決定的になります。

```csharp
// .NET 11, C# 14 -- pin the zone so a CI agent in UTC behaves like a user in Bucharest
var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 3, 30, 0, TimeSpan.Zero));
time.SetLocalTimeZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Bucharest"));

Assert.Equal(new TimeSpan(2, 0, 0), time.GetLocalNow().Offset); // after the DST fall-back
```

**`SetUtcNow` は前にしか進みません。** 現在時刻より前の値を渡すと、"Cannot go back in time." というメッセージの `ArgumentOutOfRangeException` がスローされます。運用担当者や NTP デーモンが時計を巻き戻す状況を本当に再現したい場合は `AdjustTime(DateTimeOffset)` を使います。`AdjustTime` は保留中のタイマーを発火させずに現在時刻をずらし、保留中の各タイマーの起床時刻も同じ差分だけずらします。これは実際のシステム時計の変更で起きることと同じです。

## タイムアウトを待つのではなくテストする

面白いのはタイムスタンプではなく待ち時間です。指数バックオフ付きのリトライポリシーは、通常テストするのに実時間で数秒かかります。その待機をプロバイダー経由にすれば、マイクロ秒で済みます。

```csharp
// .NET 11, C# 14
public sealed class RetryingFetcher(HttpClient http, TimeProvider timeProvider)
{
    public async Task<string> FetchAsync(string url, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await http.GetStringAsync(url, ct);
            }
            catch (HttpRequestException) when (attempt < 3)
            {
                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt));
                await Task.Delay(backoff, timeProvider, ct);
            }
        }
    }
}
```

期限も同じ仕組みです。`new CancellationTokenSource(TimeSpan, TimeProvider)` は内部タイマーが偽の時計で駆動されるトークンソースを返すので、非同期の期限を強制する `CancelAfter` パターン全体がアサート可能になります。

```csharp
// .NET 11, C# 14
[Fact]
public async Task Deadline_fires_after_five_seconds()
{
    var time = new FakeTimeProvider();
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);

    Assert.False(cts.IsCancellationRequested);

    time.Advance(TimeSpan.FromSeconds(5));

    Assert.True(cts.IsCancellationRequested);
}
```

## タイマーでポーリングする BackgroundService をテストする

`PeriodicTimer` の上に組んだポーリングワーカーは、「これはユニットテストしない」と言われがちな典型的コンポーネントです。`TimeProvider` を受け取るオーバーロードを使えば、ごく普通のコードになります。

```csharp
// .NET 11, C# 14
public sealed class ExpiryWorker(IExpiryStore store, TimeProvider timeProvider)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await store.PurgeExpiredAsync(timeProvider.GetUtcNow(), stoppingToken);
        }
    }
}
```

テストには 1 点だけ細かい注意があります。時間を進める前に、ワーカーが `WaitForNextTickAsync` に到達してタイマーを登録し終えている必要があります。そうでないと、そもそもスケジュールされていないティックを飛び越えてしまいます。これを `Thread.Sleep` で解決してはいけません。まず制御を譲り、次に時間を進め、そのあとで処理が実際に走ったというシグナルを待ちます。

```csharp
// .NET 11, C# 14, xUnit v3
[Fact]
public async Task Worker_purges_once_per_five_minute_tick()
{
    var time = new FakeTimeProvider();
    var store = new RecordingExpiryStore(); // sets a TaskCompletionSource on each call
    var worker = new ExpiryWorker(store, time);

    await worker.StartAsync(CancellationToken.None);
    await Task.Yield(); // let ExecuteAsync reach WaitForNextTickAsync

    time.Advance(TimeSpan.FromMinutes(5));
    await store.NextPurge; // completes when PurgeExpiredAsync is entered

    Assert.Equal(1, store.PurgeCount);

    await worker.StopAsync(CancellationToken.None);
}
```

実時間ではなく、本番コードが上げるシグナルを待つこと。これが、負荷の高い CI エージェント上でこのテストが不安定にならない理由です。テスト対象のワーカーが [BackgroundService の中でスコープ付きサービスを使う](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)場合も、同じ規律が当てはまります。ループの内側でスコープを解決し、そのスコープが生み出したものに対してアサートします。

## Advance は経過した周期の回数だけ周期タイマーを発火させる

これが最も多くの人を驚かせる挙動です。`FakeTimeProvider.Advance` は待機リストをたどり、起床時刻を過ぎたコールバックをすべて呼び出します。周期タイマーであれば起床時刻に周期を足して、もう一度判定します。したがって 1 回の呼び出しで、5 分周期のタイマーは 12 回発火します。

```csharp
// .NET 11, C# 14 -- twelve ticks, not one
time.Advance(TimeSpan.FromHours(1)); // PeriodicTimer period = 5 minutes
```

`PeriodicTimer` に限れば、これはループが 12 回まわることを意味しません。`WaitForNextTickAsync` は、誰も待っていない間に届いたティックをまとめてしまうからです。しかし `CreateTimer` から得た素の `ITimer` で周期が無限でない場合は、`Advance` を呼んだスレッド上で同期的にコールバックが 12 回呼ばれます。ティックをちょうど 1 回にしたいなら、ちょうど 1 周期だけ進めてください。

同期的である点は 2 つ目の理由でも重要です。タイマーのコールバック内でスローされた例外は、握りつぶされるバックグラウンドスレッドではなく、あなたの `Advance` 呼び出しから外に飛び出します。たいていはありがたい性質ですが、`Advance` の 1 行が、何層も離れたコードに由来するアサーション失敗をスローすることがある、ということでもあります。

## Advance の後に走らない継続処理

`FakeTimeProvider` で最も多く報告されている問題は、`Advance` の後にテストがハングする、またはアサートが早すぎるというもので、[dotnet/extensions#5326](https://github.com/dotnet/extensions/issues/5326) として記録されています。形はこうです。

```csharp
// .NET 11, C# 14 -- flaky: the continuation may not have run yet
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
Assert.True(delayTask.IsCompleted); // not guaranteed
```

`Advance` は下層のタスクを完了させますが、別の場所の `await` が付けた継続処理はスケジュールされるだけで、その場では実行されません。修正方法は、フラグをポーリングするのではなく、関心のある対象を待機することです。

```csharp
// .NET 11, C# 14 -- deterministic
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
await delayTask; // returns immediately, and orders the continuation
```

サンプルコードでは `Advance` の後に `await Task.Delay(1)` を置いているものを多く見かけます。スケジューラーに実際の順番を回すので動きはしますが、実時間への依存を取り除くことが目的だったテストに、実時間への依存を持ち込み直してしまいます。代わりに操作そのものを待つか、本番コードが完了させる `TaskCompletionSource` を待ってください。

関連する罠が `AutoAdvanceAmount` です。これを設定すると、`GetUtcNow()` や `GetTimestamp()` を*読むたび*に時計が進みます。2 回の読み取りの間の経過時間を測るコードには便利です。

```csharp
// .NET 11, C# 14 -- every clock read advances by 100ms
var time = new FakeTimeProvider { AutoAdvanceAmount = TimeSpan.FromMilliseconds(100) };

long start = time.GetTimestamp();
long end = time.GetTimestamp();

Assert.Equal(TimeSpan.FromMilliseconds(100), time.GetElapsedTime(start, end));
```

ただし自動前進はタイマーを駆動しません。タイマーの代わりに時計を読むものが存在しないからです。`Task.Delay(TimeSpan, TimeProvider)` は自動前進だけでは決して完了せず、明示的な `Advance` が必要です。この区別は、半日を溶かす前に覚えておく価値があります。

## xUnit v2 の同期コンテキストによるハング

テストプロジェクトがまだ xUnit v2 で、テスト対象のコードが `ConfigureAwait(false)` を使っている場合、`FakeTimeProvider` のテストがデッドロックすることがあります。xUnit v2 は各テストの間 `AsyncTestSyncContext` をインストールし、このコンテキストとその場で実行されるタイマーコールバックとの相互作用によって、テストが永久に止まります。パッケージの README に回避策が記載されています。

```csharp
// .NET 11, C# 14 -- xUnit v2 only
SynchronizationContext.SetSynchronizationContext(null);
```

該当するテストの先頭か、フィクスチャーのコンストラクターに置いてください。xUnit v3 は `AsyncTestSyncContext` を完全に削除したので、この問題は起きません。新規プロジェクトでテストフレームワークを選ぶなら、これも v3 を選ぶ小さな理由のひとつです。

## 置き換えなくてよいもの

`TimeProvider` は差し替えの継ぎ目であって、宗教ではありません。広がりすぎを防ぐルールが 2 つあります。

時間に基づいて*判断*を下すクラスに注入してください。たまたまタイムスタンプを受け渡すだけのすべてのクラスに注入する必要はありません。`CreatedAt` を運ぶ DTO に時計は不要ですが、それを刻むファクトリーには必要です。

同じメソッド内で時計を 2 回読んで同じ値を期待してはいけません。`timeProvider.GetUtcNow()` はキャッシュされたプロパティではなくメソッド呼び出しであり、`AutoAdvanceAmount` を設定していれば意図的に毎回異なる値を返します。1 回だけローカル変数に読み込み、そのローカル変数を使ってください。これは `DateTime.UtcNow` でも良い習慣ですが、ここでは正しさの要件になります。

最後に、`Microsoft.Bcl.TimeProvider` を経由する .NET Framework と netstandard2.0 では、非同期のオーバーロードはインスタンスメソッドとしては存在しません。代わりに `System.Threading.Tasks.TimeProviderTaskExtensions` の拡張メソッドを使います。`timeProvider.Delay(...)`、`timeProvider.CreateCancellationTokenSource(...)`、`task.WaitAsync(timeout, timeProvider, ct)` です。振る舞いは同じで、呼び出しの形だけが違うため、マルチターゲットのライブラリには小さな `#if` か共通のヘルパーが必要になります。

## 関連記事

- この記事がテスト可能にしたタイムアウトの仕組みは、[CancellationTokenSource.CancelAfter で非同期の期限を強制する](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)ガイドで詳しく解説しています。
- ここで挙げたテストはいずれもトークンが操作まで届くことに依存しており、それは[非同期メソッド間で CancellationToken を伝播させる](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)記事の主題です。
- テスト対象が偽の時計ではなく本物のデータベースを必要とする場合は、[Testcontainers で本物の SQL Server に対して統合テストを書く](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)を参照してください。
- そもそもポーリングループをどこに置くかという選択は、[BackgroundService と IHostedService と Hangfire の比較](/ja/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)で扱っています。
- 非同期呼び出しをブロックして待つのは、時計とは無関係の理由で `FakeTimeProvider` のテストをハングさせる最短の道です。[.Result や .Wait() の呼び出しによるデッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)を参照してください。

## 参考資料

- Microsoft Learn の [TimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider)
- .NET の基礎ドキュメントの [What is the TimeProvider class](https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview)
- [FakeTimeProvider の API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.time.testing.faketimeprovider)
- dotnet/extensions の [Microsoft.Extensions.TimeProvider.Testing の README](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/README.md)
- [FakeTimeProvider.cs のソースコード](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/FakeTimeProvider.cs)
- [dotnet/extensions#5326: Advance を呼んでも Task.Delay の継続処理が実行されない](https://github.com/dotnet/extensions/issues/5326)
- [破壊的変更: ISystemClock は非推奨](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/8.0/isystemclock-obsolete)
