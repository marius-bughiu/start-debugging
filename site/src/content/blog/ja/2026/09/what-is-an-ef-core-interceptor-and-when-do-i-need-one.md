---
title: "EF Core のインターセプターとは何か、どんなときに必要か"
description: "EF Core のインターセプターは、コマンドの実行や SaveChanges といった操作の前後で EF が呼び出すクラスで、観察するだけでなく操作を変更したり抑制したりできます。EF Core 11 の 7 つのインターセプトポイント、登録とライフタイムの規則、そしてクエリフィルターやログ出力のほうが適している場面をまとめます。"
pubDate: 2026-09-05
tags:
  - "ef-core"
  - "dotnet-11"
  - "csharp"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-09-05
---

EF Core のインターセプターは、`DbContext` に登録しておくと、特定の操作の前後で EF が呼び出してくれるクラスです。対象となる操作は、コマンドの作成と実行、接続のオープン、トランザクションの開始、`SaveChanges` の呼び出し、クエリ結果からのエンティティのマテリアライズ、LINQ クエリのコンパイル、ID 競合の解決です。重要な点、そしてインターセプターをログ出力と分ける点は、ほとんどのインターセプトポイントで操作を眺めるだけでなく **変更または抑制** できることです。インターセプターが必要になるのは、ある関心事がアプリケーション内のすべてのコンテキストに適用されなければならず、モデルでは表現できず、しかも動作を変える必要があるときです。監査列のスタンプ、クエリヒントの付加、テナントごとの接続文字列の解決、無害だと判断した同時実行例外の握りつぶしなどが該当します。SQL を見たいだけならログ出力が答えであり、インターセプターは間違った道具です。

以下の内容はすべて EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0、.NET 11、C# 14) を対象としています。インターセプトの API 自体は EF Core 11 で変わっていません。7 つのインターフェイスは、EF Core 7 が `IIdentityResolutionInterceptor` を追加して以降ずっと安定しています。その周辺で変わったことは知っておく価値があるので、落とし穴の節で扱います。

## 7 つのインターセプトポイント

すべてのインターセプターは `IInterceptor` から派生したインターフェイスを 1 つ以上実装します。いずれも `Microsoft.EntityFrameworkCore.Diagnostics` 名前空間にあります。

| インターフェイス | インターセプトする対象 | Singleton |
| --- | --- | --- |
| `IDbCommandInterceptor` | コマンドの作成と実行、失敗、`DbDataReader` の破棄 | いいえ |
| `IDbConnectionInterceptor` | 接続の作成、オープン、クローズ、接続失敗 | いいえ |
| `IDbTransactionInterceptor` | トランザクションの作成、使用、コミット、ロールバック、セーブポイント | いいえ |
| `ISaveChangesInterceptor` | `SavingChanges` / `SavedChanges` / `SaveChangesFailed`、楽観的同時実行制御 | いいえ |
| `IMaterializationInterceptor` | クエリ結果からのエンティティインスタンスの作成、初期化、確定 | はい |
| `IQueryExpressionInterceptor` | クエリがコンパイルされる前の LINQ 式ツリー | はい |
| `IIdentityResolutionInterceptor` | コンテキストが新しいインスタンスの追跡を開始するときの ID 競合 | はい |

最初の 3 つはリレーショナル専用です。データベースレベルのインターセプトは、Azure Cosmos DB プロバイダーのような非リレーショナルプロバイダーでは利用できません。`Singleton` 列は飾りではありません。ここを間違えることがインターセプターで静かにパフォーマンスを壊す最も一般的な原因なので、後ほど改めて取り上げます。

Singleton ではない 4 つのインターフェイスには、何もしない基底クラスが用意されています。`DbCommandInterceptor`、`DbConnectionInterceptor`、`DbTransactionInterceptor`、`SaveChangesInterceptor` です。20 個のインターフェイスメンバーを手で実装するのではなく、これらを継承して必要な 2、3 個のメソッドだけをオーバーライドしてください。

## メソッドペアの形と「抑制」の意味

すべてのインターセプトポイントは前後のペアになっており、それぞれの半分に同期版と非同期版があります。`ReaderExecuting` はクエリがデータベースに送られる前に、`ReaderExecuted` は戻ってきた後に実行されます。`SavingChanges` は保存の前に、`SavedChanges` は保存が成功した後に実行されます。

「前」のメソッドは `InterceptionResult` または `InterceptionResult<T>` を返し、この戻り値が制御チャネルになります。

- 引数の `result` をそのまま返すと、EF は通常どおり処理を続けます。これが観察のみのケースです。
- `InterceptionResult.Suppress()` を返すと、EF はその操作を完全にスキップします。戻り値のない操作で使います。たとえば `ThrowingConcurrencyException` のインターセプトポイントでは、抑制は「`DbUpdateConcurrencyException` を投げない」という意味になります。
- `InterceptionResult<T>.SuppressWithResult(value)` を返すと、EF は操作をスキップして代わりにあなたの値を使います。何かを生成する操作で使います。たとえば SQL を実行する代わりに、キャッシュから作った `DbDataReader` を返すといった具合です。

メンタルモデルはこれだけです。ログ出力は EF が何をしたかを教えてくれますが、インターセプターには拒否権があります。

以下は最小限で実用的なコマンドインターセプターです。しきい値より時間がかかったコマンドを、それを発行した EF の部位とともにログに残します。

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore.Relational 11.0
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

public sealed class SlowCommandInterceptor(ILogger<SlowCommandInterceptor> logger)
    : DbCommandInterceptor
{
    private static readonly TimeSpan Threshold = TimeSpan.FromMilliseconds(200);

    public override DbDataReader ReaderExecuted(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result)
    {
        Report(command, eventData);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        Report(command, eventData);
        return new ValueTask<DbDataReader>(result);
    }

    private void Report(DbCommand command, CommandExecutedEventData eventData)
    {
        if (eventData.Duration < Threshold)
        {
            return;
        }

        logger.LogWarning(
            "Slow command ({DurationMs} ms, source {Source}): {Sql}",
            (int)eventData.Duration.TotalMilliseconds,
            eventData.CommandSource,
            command.CommandText);
    }
}
```

見落とされがちな点が 2 つあります。1 つ目は、同期と非同期の両方のオーバーライドを実装していることです。EF はアプリケーションが行った呼び出しに対応するほうを呼ぶので、`ReaderExecuted` だけを実装すると、非同期のコードベースではインターセプターが静かに何もしなくなります。2 つ目は、`eventData.CommandSource` がそのコマンドの出どころ、つまりクエリなのか、`SaveChanges` なのか、`ExecuteUpdate` なのか、マイグレーションなのかを教えてくれることです。たいていはこれが本当に欲しいフィルターです。

## インターセプターを登録する

登録はコンテキストの構成時に `DbContextOptionsBuilder.AddInterceptors` を通じて行います。

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .AddInterceptors(sp.GetRequiredService<SlowCommandInterceptor>()));
```

サービスプロバイダーからインターセプターを解決することで、コンストラクター依存関係を取れるようになります。上の例で `ILogger` を受け取れているのはそのためです。まずインターセプター自体を登録してください。ここではリクエストごとの状態を持たないので `builder.Services.AddSingleton<SlowCommandInterceptor>()` です。

`OnConfiguring` も使えます。`AddDbContext` を使った場合でも `OnConfiguring` は呼ばれるので、コンテキストの構築方法にかかわらず適用したいインターセプターを付けるには妥当な場所です。1 つのインターセプターインスタンスが複数のインターフェイスを同時に実装しても構いません。一度だけ登録すれば、EF が各イベントを適切なインターフェイスに振り分けます。

## SaveChanges インターセプターを最初から最後まで

実務で最もよく書かれるインターセプターは、監査列にスタンプを押すものです。同期と非同期のペアリングも変更トラッカーの呼び出しも間違えやすいので、全体を書き出しておく価値があります。

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public interface IAuditable
{
    DateTimeOffset CreatedUtc { get; set; }
    DateTimeOffset ModifiedUtc { get; set; }
}

public sealed class TimestampInterceptor(TimeProvider clock) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        Stamp(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Stamp(eventData.Context);
        return new ValueTask<InterceptionResult<int>>(result);
    }

    private void Stamp(DbContext? context)
    {
        if (context is null)
        {
            return;
        }

        // The docs' own auditing sample calls DetectChanges here rather than
        // assuming the states are already current. Do the same.
        context.ChangeTracker.DetectChanges();

        var now = clock.GetUtcNow();

        foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    entry.Entity.CreatedUtc = now;
                    entry.Entity.ModifiedUtc = now;
                    break;
                case EntityState.Modified:
                    entry.Entity.ModifiedUtc = now;
                    break;
            }
        }
    }
}
```

`DateTimeOffset.UtcNow` を直接読まずに `TimeProvider` を受け取ることがテスト可能性を生みます。同じ理屈は .NET 11 のコードベースのどこでも通用し、[FakeTimeProvider で時刻依存のコードをテストする方法](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)とも噛み合います。変更履歴の書き込みや現在のユーザーの扱いを含むこのパターンの完全版は、[EF Core 11 のインターセプターを監査に使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)で別途書きました。

## 操作を抑制する: 同時実行のケース

拒否権が最もはっきり分かるのは `ISaveChangesInterceptor.ThrowingConcurrencyException` です。EF は `DbUpdateConcurrencyException` を投げる直前にこれを呼びます。2 つのリクエストが同じ行の削除を競合した場合、負けたほうは影響行数ゼロを見て例外を受け取りますが、望んだ最終状態 (その行が存在しないこと) には到達しています。

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
public sealed class SuppressDeleteConcurrencyInterceptor : ISaveChangesInterceptor
{
    public InterceptionResult ThrowingConcurrencyException(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result)
        => eventData.Entries.All(e => e.State == EntityState.Deleted)
            ? InterceptionResult.Suppress()
            : result;

    public ValueTask<InterceptionResult> ThrowingConcurrencyExceptionAsync(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken = default)
        => new(ThrowingConcurrencyException(eventData, result));
}
```

`eventData.Entries` は関係する `EntityEntry` オブジェクトを渡してくれるので、例外メッセージの文字列一致ではなく実際の状態にもとづいて判断できます。リレーショナルプロバイダーであれば `eventData` を `RelationalConcurrencyExceptionEventData` にキャストして、問題の `Command` も読めます。

## インターセプターが不要なとき

インターセプターは EF が提供する最も重いフックであり、真っ先にこれに手を伸ばすのはよくある誤りです。書き始める前に、もっと軽い仕組みで足りないか確認してください。

**SQL を見たい場合。** `Microsoft.Extensions.Logging` か `LogTo` によるシンプルロギングを使ってください。ドキュメントはインターセプターがログ出力の仕組みではないと明言していますし、ログのパイプラインはレベル、フィルター、シンクを最初から備えています。クエリの本文ではなく回数を追っているなら、[EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)のアプローチのほうが近く、構造化ログの一般的な設定は [.NET 11 での Serilog と Seq](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)にあります。

**保存時や追跡時のコールバックが欲しく、同期で十分な場合。** `DbContext` はごく普通の .NET イベントを公開しています。`SavingChanges`、`SavedChanges`、`SaveChangesFailed`、`ChangeTracker.Tracked`、`ChangeTracker.StateChanged` です。コンテキストのインスタンスごとに登録でき、いつでも取り付けられるので、インターセプターより単純です。難点はイベントが同期専用であり、ノンブロッキングな I/O を実行できないことです。インターセプターは非同期側の半分が `ValueTask` を返すので実行できます。

**プロセス内のすべてのコンテキストについて同じ情報が欲しい場合。** それはインターセプターではなく、`"Microsoft.EntityFrameworkCore"` ソースへの `DiagnosticListener` の購読です。diagnostic listener はプロセス全体が対象で観察専用、インターセプターはコンテキスト単位で変更可能です。片方の軸だけでなく両方の軸で選んでください。

**論理削除やテナントですべてのクエリをフィルターしたい場合。** それはクエリフィルターであって `IQueryExpressionInterceptor` ではありません。`Where` 句を注入するために `ExpressionVisitor` を書くのは、モデルがすでにできることを壊れやすいコードで作り直す行為です。しかも EF Core 10 と 11 はエンティティごとに独立してオフにできる複数のフィルターをサポートしており、まさに以前は手作業でやっていたケースを解決します。[論理削除とマルチテナンシーのための名前付きクエリフィルター](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)を参照してください。

**プロパティ値を出し入れの途中で変換したい場合。** それは値コンバーターです。

**その動作がちょうど 1 つの `DbContext` サブクラスにだけ、しかも保存時にだけ当てはまる場合。** `SaveChangesAsync` をオーバーライドするほうが単純で、スタックトレースで読みやすく、テストもしやすいです。`ISaveChangesInterceptor` に手を伸ばすのは、そのロジックが複数のコンテキスト型に適用される必要があるとき、あるいはコンテキストクラスを所有しない共有ライブラリに置く必要があるときです。

## 実際に時間を奪う落とし穴

**Singleton インターセプターと `ManyServiceProvidersCreatedWarning`。** `IMaterializationInterceptor`、`IQueryExpressionInterceptor`、`IIdentityResolutionInterceptor` は EF の *内部* サービスプロバイダーに登録されます。`AddInterceptors` に渡すインスタンスが異なるたびに新しい内部プロバイダーが構築されるため、スコープごとに実行される `AddDbContext` のラムダの中で `new MyMaterializationInterceptor()` を渡すと、いずれ `ManyServiceProvidersCreatedWarning` を踏んでパフォーマンスが落ち込みます。インスタンスは静的フィールドに 1 つ保持するか、DI から singleton として解決してください。共有されるため、これらのインターセプターはスレッドセーフでなければならず、可変状態を持つべきではありません。スコープ付きのものにはイベントデータの `Context` プロパティ経由でアクセスします。

**`SaveChanges` インターセプターでのスコープ付き依存関係。** singleton ではないインターセプターは上の制約から自由ですが、現在のユーザーのアクセサーやテナントのリゾルバーのようなスコープ付きのものに依存する場合、インターセプター自体もスコープ付きにして `AddDbContext` の `(sp, options)` オーバーロードで解決する必要があります。singleton として登録してスコープ付きサービスを注入するのは、[cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)への典型的な経路です。

**`ExecuteUpdate` と `ExecuteDelete` は `SaveChanges` インターセプターに決して届きません。** 集合ベースの操作は変更トラッカーを迂回して直接 SQL になるため、`SavingChanges` にぶら下げた監査スタンプ、論理削除の書き換え、ドメインイベントのディスパッチはすべてスキップされます。これは仕様どおりですが、監査証跡に静かな穴が空く最も一般的な原因でもあります。トレードオフは[一括書き込みのための ExecuteUpdate と ExecuteDelete](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)で整理しています。最終的にはすべてが `DbCommand` になるので、`IDbCommandInterceptor` はこれらのコマンドを引き続き見られます。

**`ConnectionCreating` と `ConnectionCreated` は EF が接続を作るときだけ発火します。** アプリケーションが `DbConnection` を作って EF に渡す場合、この 2 つのインターセプトポイントは一度も実行されません。`ConnectionOpening` は実行されます。

**`IIdentityResolutionInterceptor` はクエリ結果では発火しません。** EF Core 11 時点では `Update`、`Attach` と同種の追跡呼び出しからのみ呼ばれ、クエリから返ってきたエンティティでは呼ばれません。これは [dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574) で追跡されており、将来変わる可能性があります。attach 時に「後勝ち」が欲しいだけなら、組み込みの `UpdatingIdentityResolutionInterceptor` が自作の手間を省いてくれます。

**式ツリーのインターセプトは最後の手段です。** `IQueryExpressionInterceptor` は強力ですが、安定した第 2 ソートキーを追加するというドキュメント自身の例は、クエリに直接 `.ThenBy(e => e.Id)` を足すほうが単純で、理解しやすく、常に動くという指摘で締めくくられています。その直感が正しいのです。アプリケーションのすべてのクエリを黙って書き換える `ExpressionVisitor` は、永久に抱え込むデバッグ上の問題になります。

**インターセプターは順番に実行され、互いの判断を見られます。** 拡張機能が注入したインターセプターがサービスプロバイダーの解決順に先に実行され、その後にアプリケーションのインターセプターが実行されます。後続のインターセプターは `InterceptionResult<T>.HasResult` を確認して、先行するものがすでに操作を抑制したかどうかを判断できます。積み重ねる場合はこれが効いてきます。

**知っておく価値のある EF Core 11 の追加。** `ChangeTracker.GetEntriesForState(added, modified, deleted, unchanged)` は状態でフィルターした列挙子で、`Entries()` が行う暗黙の `DetectChanges` パスをスキップします。まさに `SaveChanges` インターセプターや監査フックのようなホットパスのために存在しており、そこでは同じ走査が保存ごとに 2 回走ってしまいます。詳細とトレードオフは [EF Core 11 が GetEntriesForState を追加](/ja/2026/04/efcore-11-changetracker-getentriesforstate/)にあります。

## 要点

EF の動作を、すべてのコンテキストにわたって、モデルでは表現できない地点で *変える* 必要があるときにインターセプターを書いてください。何をしたか見たいだけならログ出力、1 つのコンテキストで単純な同期コールバックが欲しいなら .NET イベント、プロセス全体の観察が欲しいなら diagnostic listener、関心事が本当はモデルのものならクエリフィルターか値コンバーターを使います。オーバーライドするペアは同期と非同期の両方の半分を実装し、singleton インターセプターは状態を持たせず共有し、`SaveChanges` を迂回するものはあなたの `ISaveChangesInterceptor` も迂回することを忘れないでください。

## 関連記事

- [EF Core 11 のインターセプターを監査に使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 が DetectChanges をスキップする GetEntriesForState を追加](/ja/2026/04/efcore-11-changetracker-getentriesforstate/)
- [EF Core 11 で論理削除とマルチテナンシーに名前付きクエリフィルターを使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [EF Core 11 で一括書き込みに ExecuteUpdate と ExecuteDelete を使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## 参考資料

- [Interceptors -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)
- [.NET events -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/events)
- [Using diagnostic listeners -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/diagnostic-listeners)
- [IIdentityResolutionInterceptor Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.iidentityresolutioninterceptor)
- [CommandExecutedEventData Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.commandexecutedeventdata)
- [What's New in EF Core 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Identity resolution interceptor is not called for query results -- dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574)
