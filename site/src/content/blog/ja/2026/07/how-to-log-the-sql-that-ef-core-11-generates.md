---
title: "EF Core 11 が生成する SQL をログ出力する方法"
description: "Entity Framework Core 11 がデータベースに送信する正確な SQL を、パラメーター値とともに、LogTo、Microsoft.Extensions.Logging、ToQueryString で確認します。"
pubDate: 2026-07-19
tags:
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "logging"
lang: "ja"
translationOf: "2026/07/how-to-log-the-sql-that-ef-core-11-generates"
translatedBy: "claude"
translationDate: 2026-07-19
---

Entity Framework Core 11 が生成する SQL を確認する最速の方法は、`DbContextOptionsBuilder` で `LogTo(Console.WriteLine)` を呼び出すことです。これにより、EF Core がデータベースへ送信するすべてのコマンドが、`Information` レベルで、`Microsoft.EntityFrameworkCore.Database.Command` カテゴリのもとに出力されます。ASP.NET Core アプリでは、通常これすら必要ありません。`appsettings.json` で `Microsoft.EntityFrameworkCore.Database.Command` を `Information` に設定すれば、SQL は既存のログ出力を通じて流れます。`?` の代わりに実際のパラメーター値を確認するには、`EnableSensitiveDataLogging()` を追加します。単一のクエリの SQL を実行せずに取得するには、`.ToQueryString()` を呼び出します。

この記事では、これらすべてのオプションと、それぞれがどのような場面で正しいツールになるのか、そして人がつまずくポイントを扱います。デフォルトでは何も表示されない理由、パラメーターが伏せられる理由、そして `EnableSensitiveDataLogging` を決して本番へ持ち込むべきでない理由です。ここに書かれている内容はすべて、.NET 11 上の EF Core 11 と C# 14 に対応しています。

## デフォルトで SQL が表示されない理由

EF Core は、ログをどこへ送るかを指定しない限り、何も出力しません。これは意図的なものです。ログメッセージの構築にはコストがかかるため、EF Core はシンクが構成されていないときには、その作業を完全にスキップします。これは、`Database.Log` をいつでもアタッチできた EF6 からの考え方の変化です。EF Core では、ログ出力はコンテキストの初期化時に一度だけ構成され、フレームワークはシンクが存在するときにのみメッセージを生成します。

EF Core が実行するすべての SQL コマンドは、単一のイベントとしてログに記録されます。すなわち `RelationalEventId.CommandExecuted`、ID `20101` のイベントで、カテゴリは `Microsoft.EntityFrameworkCore.Database.Command`、レベルは `LogLevel.Information` です。この最後の点が重要です。ログ出力が `Warning` 以上にフィルタリングされている場合、これは本番でよくあるデフォルト設定ですが、SQL は内部で生成されるものの、シンクには決して届きません。SQL を確認するというのは、ほとんどの場合、その 1 つのカテゴリのレベルを下げることであって、何か特別なスイッチを入れることではありません。

## 一行版: LogTo

`LogTo` は EF Core に組み込まれた「シンプルログ出力」です。NuGet パッケージも依存性注入も必要ありません。これは `Action<string>` を受け取り、EF Core はログメッセージごとに一度そのデリゲートを呼び出します。

```csharp
// EF Core 11, C# 14, .NET 11
public sealed class AppDbContext : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=Shop;Trusted_Connection=True")
            .LogTo(Console.WriteLine);

    public DbSet<Order> Orders => Set<Order>();
}
```

クエリを実行すると、コマンド、そのパラメーター、実行時間、SQL テキストが得られます。

```output
info: RelationalEventId.CommandExecuted[20101] (Microsoft.EntityFrameworkCore.Database.Command)
      Executed DbCommand (3ms) [Parameters=[@__customerId_0='?' (DbType = Int32)], CommandType='Text', CommandTimeout='30']
      SELECT [o].[Id], [o].[CustomerId], [o].[Total]
      FROM [Orders] AS [o]
      WHERE [o].[CustomerId] = @__customerId_0
```

`OnConfiguring` は、`AddDbContext` を通じてコンテキストを構築する場合でも、あらかじめ構築した `DbContextOptions` を渡す場合でも、依然として呼び出されます。そのため、コンテキストがどのように構築されるかにかかわらず、ここがログ構成を置く唯一の場所になります。すでに `Program.cs` でオプションを登録している場合は、代わりにそこで `LogTo` を連結できます。

```csharp
// EF Core 11, .NET 11 - Program.cs
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .LogTo(Console.WriteLine, LogLevel.Information));
```

第 2 引数は最小レベルを引き上げます。デフォルトでは `LogTo` は `Debug` 以上のすべてを出力するため、ノイズが多くなります。`LogLevel.Information` を渡すと、データベースアクセスといくつかのハウスキーピングメッセージにまで絞られ、クエリを追いかけているときに実際に欲しいのは通常これです。

## 疑問符の代わりにパラメーター値を表示する

上記の出力にある `@__customerId_0='?'` に注目してください。EF Core はデフォルトでパラメーター値を伏せます。それらが個人情報や機微なデータであり、ログファイルに残してはならない可能性があるためです。ローカルでデバッグしていて、実際にどの値が送信されたのかを確認する必要がある場合は、機微データのログ出力を有効にします。

```csharp
// EF Core 11 - only ever do this in Development
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging();
```

これでパラメーターが具体化されます。

```output
Executed DbCommand (2ms) [Parameters=[@__customerId_0='42' (DbType = Int32)], ...]
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[CustomerId] = @__customerId_0
```

これを環境チェックの背後で保護し、本番で決して有効にならないようにしてください。実際のキー値を含むクエリログの漏洩は、本物のデータ露出リスクです。

```csharp
// EF Core 11, .NET 11
optionsBuilder.UseSqlServer(connectionString);
if (builder.Environment.IsDevelopment())
{
    optionsBuilder
        .LogTo(Console.WriteLine, LogLevel.Information)
        .EnableSensitiveDataLogging();
}
```

ついでに、`EnableDetailedErrors()` は便利な相棒です。EF Core はパフォーマンスのため、値ごとの try-catch ブロックをスキップします。そのため一部のエラー（たとえば null 許容でないプロパティに対してデータベースが `NULL` を返した場合など）は、特定のフィールドに結び付けるのが難しくなります。`EnableDetailedErrors()` はそれらのチェックを再導入し、問題のあるプロパティ名を含むメッセージを提供します。これはデバッグ用の補助であり、本番設定ではありません。

## ASP.NET Core 流のやり方: Microsoft.Extensions.Logging

ASP.NET Core アプリでは、`LogTo` はほとんど必要ありません。`AddDbContext` と `AddDbContextPool` は EF Core をアプリの `Microsoft.Extensions.Logging` パイプラインに自動的に組み込むため、EF Core の SQL はアプリの残りの部分と同じロガー、プロバイダー、フィルターを通じて流れます。コマンドカテゴリのレベルを設定することで、`appsettings.json` から完全に制御できます。

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

この 1 行がすべての仕掛けです。カテゴリは階層的なので、`Microsoft.EntityFrameworkCore.Database.Command` は実行済みコマンドのイベントだけを正確に狙い、それ以外は狙いません。これを `appsettings.Development.json` に置けば、本番を静かに保ちながらローカルで SQL を確認でき、実行中の環境で何かを診断する必要が生じたときには、再デプロイなしで切り替えられます。

すべてをコード内に保ちたい場合や、汎用ホストを使うコンソールアプリの場合は、`ILoggerFactory` を登録し、`UseLoggerFactory` で EF Core に渡します。ファクトリは単一の共有インスタンスとして保持してください。コンテキストごとに 1 つ作成すると、メモリリークを起こし、内部のキャッシュを台無しにします。

```csharp
// EF Core 11, .NET 11
public static readonly ILoggerFactory DbLoggerFactory =
    LoggerFactory.Create(b => b.AddConsole().AddFilter(
        "Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Information));

protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseLoggerFactory(DbLoggerFactory);
```

この経路は標準の `Microsoft.Extensions.Logging` なので、どのプロバイダーも同じように接続できます。ログを Serilog 経由でルーティングしている場合、EF Core の SQL は EF 固有の追加設定なしにシンクへ届きます。これは [Serilog と Seq による構造化ログ出力](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) で扱っているのと同じパイプラインです。EF Core はそれを供給するもう 1 つのカテゴリにすぎません。

## SQL だけに絞り込む

`LogTo` は、ストリームを自分が関心を持つコマンドだけに絞り込む 3 つの方法を提供します。もっとも読みやすいのはカテゴリによる方法です。文字列を手書きでハードコードしないよう、`DbLoggerCategory` の厳密に型付けされた名前を使ってください。

```csharp
// EF Core 11 - only database interactions
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { DbLoggerCategory.Database.Command.Name },
    LogLevel.Information);
```

厳密に 1 つのイベントだけが欲しく、それ以外は要らない場合は、イベント ID でフィルタリングすることもできます。生の SQL だけなら、それは `RelationalEventId.CommandExecuted` です。

```csharp
// EF Core 11 - only the executed-command event
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { RelationalEventId.CommandExecuted });
```

そして、組み込みのオプションでは表現できないものについては、`(eventId, logLevel)` を受け取る述語を渡します。これは EF Core のホットパスで、メッセージ文字列が構築される前にフィルタリングするため、デリゲート内でフィルタリングするよりも安価です。

```csharp
// EF Core 11 - custom filter
optionsBuilder.LogTo(
    Console.WriteLine,
    (eventId, level) => eventId == RelationalEventId.CommandExecuted);
```

ここでフィルタリングすることは、特定の問題を追っているときにクエリログを読みやすく保つ方法です。たとえば、遅延読み込みのループを示す、繰り返される同一の `SELECT` を見つけ出すような場合です。まさにそれを追っているのであれば、カテゴリフィルターと出力のざっと確認は、[EF Core 11 で N+1 クエリを検出する](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) の手動版そのものです。

## ログをファイルへ送る

`LogTo` は任意の `Action<string>` を受け取るため、ファイルへの書き込みは、それを `StreamWriter` に向けるだけの話です。ファイルがきれいに閉じられるよう、コンテキストが破棄されるときに writer を破棄してください。

```csharp
// EF Core 11, .NET 11
public sealed class AppDbContext : DbContext
{
    private readonly StreamWriter _log = new("ef-sql.log", append: true);

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer(connectionString)
            .LogTo(_log.WriteLine, LogLevel.Information);

    public override void Dispose()
    {
        base.Dispose();
        _log.Dispose();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _log.DisposeAsync();
    }
}
```

よりすっきりしたファイルにするには、`DbContextLoggerOptions` を通じて 1 行出力と UTC タイムスタンプを要求します。

```csharp
// EF Core 11 - compact one-line-per-message format
optionsBuilder.LogTo(
    _log.WriteLine,
    LogLevel.Information,
    DbContextLoggerOptions.UtcTime | DbContextLoggerOptions.SingleLine);
```

使い捨てのデバッグファイルを超えるものについては、`Microsoft.Extensions.Logging` と本物のファイルシンクを経由してルーティングすることをおすすめします。`StreamWriter` への `LogTo` はざっと見るには問題ありませんが、本番のログ出力戦略ではありません。

## クエリを実行せずにその SQL を取得する

ときには、すべてのコマンドが流れ込む放水ホースは要りません。1 つの LINQ クエリがあって、それが生成する SQL を確認したいだけです。`ToQueryString()` は、`IQueryable` の SQL を、データベースに対して実行せずにレンダリングします。

```csharp
// EF Core 11, C# 14
var query = db.Orders
    .Where(o => o.Total > 100)
    .OrderByDescending(o => o.Total);

Console.WriteLine(query.ToQueryString());
```

```output
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[Total] > 100.0
ORDER BY [o].[Total] DESC
```

これは、テストや使い捨てのエンドポイントでクエリを練り上げているときに手を伸ばすツールです。準備すべきログ構成も、その他のノイズもないからです。これはクエリ（`IQueryable`）に対してのみ機能し、`SaveChanges`、`ExecuteUpdate`、`ExecuteDelete` には機能しません。それらについては、`LogTo` またはコマンドカテゴリに戻ってください。一括操作が発行する SQL について考えているのであれば、[一括書き込みのための ExecuteUpdate と ExecuteDelete](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) で示された形が、コマンドログで目にするものです。

## 知っておく価値のある注意点

**`CommandExecuted` はラウンドトリップの後に発火します。** `20101` イベントは実行時間を運ぶため、コマンドが返ってきた時点でログに記録されます。クエリがハングした場合、それは完了しないため、実行ログにその SQL は表示されません。実行前の SQL が必要な場合は `CommandExecuting`（`20100`）に注意するか、`ToQueryString()` を使って静的に検査してください。

**構成は初期化時に固定されます。** コンテキストが構築された後に、`LogTo` をアタッチしたりデタッチしたりはできません。実行時の切り替えが欲しい場合は、デリゲートをキャプチャして null チェックします。すなわち `optionsBuilder.LogTo(s => _sink?.Invoke(s))` とし、その後 `_sink` を必要に応じて設定します。これは EF6 の古い `Database.Log` の挙動を反映しています。

**シンクを追加するつもりで `LogTo` を 2 回呼び出さないでください。** 2 回目の呼び出しは、構成に追加するのではなく、置き換えます。複数の宛先へ分配するには、それぞれへ転送するデリゲートを書いてください。

**機微データのログ出力と詳細エラーは、どちらも開発専用です。** `EnableSensitiveDataLogging` は、キーや個人情報を含む実際のパラメーター値をログに入れます。`EnableDetailedErrors` は読み取りごとのオーバーヘッドを追加します。両方を環境チェックの背後で保護してください。ここもまた、予想外にノイズの多いログが意図以上のものを漏らしかねない箇所なので、シンクが何を保持するかを確認してください。

**スイッチではなくカテゴリが、あなたの本番制御です。** デプロイ済みのアプリでは、EF Core を `Microsoft.Extensions.Logging` に組み込んだままにし、可視性を純粋に `Microsoft.EntityFrameworkCore.Database.Command` のレベルを通じて制御します。単一の構成値を変更するだけで必要に応じて SQL が得られ、削除し忘れた `LogTo(Console.WriteLine)` を出荷することは決してありません。

生成された SQL を読むことは、EF Core のほぼすべてのパフォーマンス調査における最初の一手です。クライアント側で静かに評価されるクエリから、予想以上のものを発行するマイグレーションまで。それが見えるようになれば、[LINQ 式を変換できませんでした](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) の修正や、[EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) の破壊的変更に関するメモが、はるかに適用しやすくなります。推測ではなく、実際の SQL をデバッグしているからです。

## 出典

- [EF Core simple logging (LogTo) - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)
- [Using Microsoft.Extensions.Logging with EF Core - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/extensions-logging)
- [ToQueryString / viewing generated SQL - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/#viewing-generated-sql)
- [RelationalEventId.CommandExecuted - .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationaleventid.commandexecuted)
