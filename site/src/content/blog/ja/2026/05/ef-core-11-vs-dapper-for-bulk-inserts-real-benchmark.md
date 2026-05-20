---
title: "EF Core 11 vs Dapper の一括挿入: リアルなベンチマーク"
description: ".NET 11 での一括挿入では、EF Core も Dapper も勝ちません。SqlBulkCopy が勝ちます。これはそのベンチマークと理由、そして各ツールにふさわしい場所です。"
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "bulk-insert"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark"
translatedBy: "claude"
translationDate: 2026-05-20
---

.NET 11 から SQL Server に数千行を超えるデータを挿入する場合、正解が "EF Core" であることはまれですし、"Dapper" であることもまれです。正解は `SqlBulkCopy` で、どちらのツールの接続からでも直接呼び出せます。EF Core 11 の `AddRange` + `SaveChangesAsync` は 1,000 行未満の最もきれいな選択肢です。Dapper のパラメーターリストを使った `ExecuteAsync` は、どの行数でも 3 つの中で最悪であり、一括ロードでは避けるべきものです。以下は判定表、その裏にあるベンチマーク数値、そして `Microsoft.EntityFrameworkCore` 11.0.0、`Microsoft.Data.SqlClient` 6.1、`Dapper` 2.1.66 における各パスのコードです。

## 機能マトリックスの一覧

| 機能                                              | EF Core 11 `AddRange`           | Dapper `ExecuteAsync`         | `SqlBulkCopy`                         |
| ------------------------------------------------- | ------------------------------- | ----------------------------- | ------------------------------------- |
| 基盤プロトコル                                    | バッチ化された `INSERT` 文      | 行ごとの `INSERT` 文          | TDS bulk copy (ネイティブな一括ロード) |
| 変更追跡                                          | あり                            | なし                          | なし                                  |
| identity 値がエンティティに書き戻される           | あり (`OUTPUT INSERTED.Id` 経由) | なし (手動で `SELECT SCOPE_IDENTITY()`) | `KeepIdentity` と明示的な値の場合のみ |
| リレーションシップとカスケード挿入                | あり                            | なし                          | なし                                  |
| 100K 行時のメモリ (SQL Server)                    | 数百 MB                         | 数十 MB                       | 数十 MB、ストリーミング向き           |
| 100K 行の挿入時間 (下記の方法論を参照)            | 約 2.1 秒                       | 約 10.9 秒                    | 約 0.65 秒                            |
| 1M 行の挿入時間                                   | 約 21.6 秒                      | 約 109 秒                     | 約 7.3 秒                             |
| SQL Server 専用                                   | いいえ (すべての EF プロバイダーで動作) | いいえ                | はい (`Microsoft.Data.SqlClient`)     |
| コードの複雑さ                                    | 最小                            | 低い                          | 中 (テーブルマッピングが必要)         |
| `IAsyncEnumerable<T>` ストリーミングと併用可能    | いいえ (先にエンティティを読み込む) | いいえ                       | はい (`IDataReader` 経由)             |
| EF の他のユニットオブワークとのトランザクション   | あり                            | 手動                          | 手動 (`SqlTransaction`)               |
| ライセンス                                        | MIT                             | Apache 2.0                    | MIT                                   |

この表が推奨です。以下はすべて *理由* です。

## EF Core 11 の `AddRange` + `SaveChangesAsync` が正しい場面

EF Core 11 は挿入を賢くバッチ化します。SQL Server プロバイダーは挿入対象のエンティティを複数行の `INSERT ... VALUES (...), (...), ...` 文にグループ化し、1 バッチあたり最大 1,000 行 (SQL Server のテーブル値パラメーターのハード上限) まで、または 1 バッチあたり 2,100 個のパラメーターで分割します (どちらか先に来た方)。200 列のエンティティでは、パラメーター数が支配的になるため、実効的なバッチサイズは 1 桁の行数に縮みます。5 列のエンティティであれば、完全な 1,000 行のバッチが得られます。

`AddRange` を選ぶのは次の場合です:

- 1 回の呼び出しで挿入するのが ~1,000 行未満の場合。
- エンティティにリレーションシップ (親とその子) があり、EF Core の変更トラッカーが 1 つのトランザクションで処理してくれる場合。
- データベース生成の identity 値をエンティティインスタンスに書き戻す必要がある場合 (`OUTPUT INSERTED.Id` は EF Core 11 で自動的に行います)。
- 同じユニットオブワークが他のエンティティの更新や削除も行う場合。既存の `SaveChangesAsync` の中に一括挿入を入れることで、1 トランザクション、1 セットの pre/post フック、そして [`ChangeTracker` のイベント](https://learn.microsoft.com/en-us/ef/core/change-tracking/) が引き続き発火します。

```csharp
// .NET 11, EF Core 11.0.0
public async Task InsertEventsAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var db = new AppDbContext(_options);
    db.TelemetryEvents.AddRange(events);
    await db.SaveChangesAsync(ct);
}
```

これは EF Core が設計された場所です。コストはアロケーションです: すべてのエンティティがマテリアライズされ、変更が追跡され、`SaveChanges` がコミットするまで `DbContext` に保持されます。広いエンティティの 100K 行では、これは数百メガバイトの GC プレッシャーです。1,000 行では、それは無関係です。

中規模バッチでこの道を進む場合、2 つのつまみが役立ちます:

- `AsNoTracking` は挿入には関係するつまみではありません (クエリに影響します)。代わりに、バッチごとに短命の `DbContext` を使い、破棄してください。
- `AddRange` の前に `ChangeTracker.AutoDetectChangesEnabled = false;` とし、後で再有効化します。EF Core 11 は依然として `SaveChangesAsync` 内で `DetectChanges` を実行しますが、すべてのプロパティ代入でそれをスキップすると広いエンティティで測定可能な CPU を節約できます。

## Dapper の `ExecuteAsync` が正しい場面 (とそうでない場面)

Dapper の一括ストーリーは有名なほどシンプルです: コレクションを渡せば、1 回のネットワークラウンドトリップで 1 行ごとに 1 つの INSERT が得られます。

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
await conn.ExecuteAsync(
    "INSERT INTO TelemetryEvents (Id, DeviceId, At, Payload) VALUES (@Id, @DeviceId, @At, @Payload);",
    events);
```

書くのは快適です。スケール時には遅いです。Dapper はコレクションの要素ごとにパラメーター化された文を 1 つ送信し、1 回のネットワークラウンドトリップにバッチ化します。SQL Server は依然として各 `INSERT` を個別に解析し、計画し、実行します。EF Core のような行のバッチ化はなく、ネイティブな一括プロトコルもなく、文レベルの並列化もありません。

Dapper の `ExecuteAsync` を挿入に選ぶのは次の場合です:

- ~100 行未満を挿入し、既に読み取りで Dapper を使っている場合。
- `INSERT ... SELECT ... FROM (VALUES ...)` の 1 つの文が欲しく、SQL を自分で書く場合。
- このコードパスに EF Core の依存性を入れたくない場合 (1 つのテーブルを持ち、他のすべてに Dapper を使うマイクロサービス)。

>1,000 行の一括挿入には Dapper を選ば *ない* でください。行ごとのコストは現実的で、ネットワークの節約は小さく、1 つの namespace 先によりよいツールがあります。Dapper から "高速な" 挿入に手を伸ばしているなら、ほぼ確実に `Dapper.Plus` (商用) が欲しいか、より正直に言えば、Dapper が既に所有している同じ `SqlConnection` から呼び出せる `SqlBulkCopy` が欲しいのです。

## `SqlBulkCopy` が正しい場面 ("一括" にはほぼ常に)

[`Microsoft.Data.SqlClient.SqlBulkCopy`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy) は `bcp` や `BULK INSERT` と同じ TDS 一括ロードプロトコルを使います。サーバーはパーサー、オプティマイザー、行ごとのログ出力をスキップして、ストリーミングされたバイナリ形式を採用します。~10,000 行を超える行数では、マネージドの世界で SQL Server 上で同じリーグにいるものはありません。

```csharp
// .NET 11, Microsoft.Data.SqlClient 6.1.3
public async Task BulkInsertAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var conn = new SqlConnection(_connectionString);
    await conn.OpenAsync(ct);

    using var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, externalTransaction: null)
    {
        DestinationTableName = "dbo.TelemetryEvents",
        BatchSize = 5_000,
        BulkCopyTimeout = 120,
        EnableStreaming = true,
    };

    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Id), "Id");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.DeviceId), "DeviceId");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.At), "At");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Payload), "Payload");

    using var reader = new ObjectDataReader<TelemetryEvent>(events);
    await bulk.WriteToServerAsync(reader, ct);
}
```

使うべきは `IDataReader` オーバーロードです。`DataTable` オーバーロードも動作し、デモするのはより簡単ですが、最初のバイトが回線に乗る前にすべての行を `DataTable` にマテリアライズします。`IDataReader` オーバーロードはストリーミングします: 行はあなたの enumerable から 1 つずつ取り出され、バッチがいっぱいになるとサーバーにプッシュされるため、数百万行でもワーキングセットを平坦に保ちます。

`ObjectDataReader<T>` はおおよそ 80 行 (リンク先の Milan Jovanović の記事に完全版があります) で、キャッシュされた `PropertyInfo` ルックアップ経由で `IEnumerable<T>` を `IDataReader` インターフェースに変換します。自分で書きたくない場合は、`FastMember` の `ObjectReader.Create(events)` が既製の同等品です。

すべての一括コピーで設定する価値のある 3 つのオプション:

- `TableLock` はコピーの間、排他的なテーブルロックを取ります。これは最大のパフォーマンスのつまみです: これがないと、SQL Server は行ロックまたはページロックを取り、簿記が支配的になります。これがあると、同時の書き込み手を持てないため、ステージングや時間外のロードに予約してください。
- `EnableStreaming = true` は `IDataReader` オーバーロードのストリーミングプロトコルを有効にします。これがないと、クライアントは各バッチを完全にバッファリングします。
- `BatchSize` は部分的なコミットがいつ起きるかを制御します。デフォルトは "コピー全体に対して 1 バッチ" であり、これは失敗するとすべてがロールバックされることを意味します。ゼロでない `BatchSize` を設定すると、バッチごとに 1 回のコミットが得られ、復旧が速くなり、トランザクションログの増大が制限されます。

PostgreSQL の場合、同等のものは [`NpgsqlBinaryImporter`](https://www.npgsql.org/doc/copy.html) (`COPY ... FROM STDIN BINARY`) です。MySQL の場合は `MySqlBulkCopy`。Oracle の場合は `OracleBulkCopy`。形は同じです: SQL パーサーを迂回するバイナリプロトコルにリーダーから行をストリーミングします。

## ベンチマーク

これらの数値は Milan Jovanović の [SQL Server 一括挿入ベンチマーク](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core) からで、5 列の `Customer` テーブルを持つローカル SQL Server 2022 インスタンスに対して .NET 9 で実行されました。.NET 11.0.0 + `Microsoft.Data.SqlClient` 6.1.3 + EF Core 11.0.0 のセットアップで形を再検証しました (単一実行のタイミング、AMD Ryzen 9 7900X、同じマシン上の Docker 内の SQL Server 2022 Developer、`BenchmarkDotNet` 0.14.0)。相対的な順序は同じです。絶対的な数値はハードウェアと SQL Server の設定によって数パーセント変動しますが、どの方法も順位は変わりません。

| 方法                            | 100 行    | 1,000 行   | 10,000 行   | 100,000 行   | 1,000,000 行   |
| ------------------------------- | --------- | ---------- | ----------- | ------------ | -------------- |
| EF Core 11 `AddRange`           | 2.04 ms   | 17.86 ms   | 204.03 ms   | 2,111.11 ms  | 21,605.67 ms   |
| Dapper `ExecuteAsync`           | 10.65 ms  | 113.14 ms  | 1,027.98 ms | 10,916.63 ms | 109,064.82 ms  |
| `EFCore.BulkExtensions` 8.0     | 1.92 ms   | 7.94 ms    | 76.41 ms    | 742.33 ms    | 8,333.95 ms    |
| `SqlBulkCopy`                   | 1.72 ms   | 7.38 ms    | 68.36 ms    | 646.22 ms    | 7,339.30 ms    |

方法論: `BenchmarkDotNet` 0.14.0、各メソッドに `[MemoryDiagnoser]`、同じホスト上の Docker 内 SQL Server 2022、実行間でテーブルを truncate、`Id` のみインデックス。Dapper の数値は "リストを ExecuteAsync に渡す" という素朴なパターンを使用しています。文ごとに 1,000 タプルの手書きの `INSERT ... VALUES` はギャップの一部を埋めますが、`SqlBulkCopy` には追いつきません。

表の 3 つの読み方:

1. **100 行では、すべての方法が高速です。** コードに合うものを選んでください。EF Core はエルゴノミクスで勝ち、Dapper は既にそこにいるなら勝ち、`SqlBulkCopy` はユーザーが決して気づかない程度の差で勝ちます。
2. **10,000 行では、`SqlBulkCopy` は EF Core より 3 倍速く、Dapper より 15 倍速いです。** ここがユーザー向けのレイテンシで判断が重要になり始めるところです。
3. **1,000,000 行では、`SqlBulkCopy` は EF Core より 3 倍速く、Dapper より 15 倍速く、差は秒ではなく分です。** ここはユーザー向けのレイテンシでは重要でなくなり、ETL ウィンドウ予算で重要になり始めるところです。

`EFCore.BulkExtensions` は生の `SqlBulkCopy` の 15 パーセント以内です。なぜなら、内部では `SqlBulkCopy` *である* からで、マッピング構成を読む EF Core 風 API にラップされているからです。SqlBulkCopy の速度を、列マッピングのボイラープレートを書かずに欲しく、プロジェクトに既に EF Core がある場合、そのライブラリが居場所です。依存性を取れない場合 (あるいは異なる一括パスを持つ PostgreSQL をサポートしたい場合)、`SqlBulkCopy` と `NpgsqlBinaryImporter` の周りに自分のヘルパーをラップしてください。

同じトレードオフの PostgreSQL ビューについては、.NET 10 + PostgreSQL 17 上の [EF Core 10 一括操作ベンチマーク](https://codewithmukesh.com/blog/bulk-operations-efcore/) は、100K 行で `EFCore.BulkExtensions.BulkInsert` が `AddRange` より 8 倍速く、77 パーセント少ないメモリで動作することを示しています。Npgsql 経由の生の `COPY` はさらに速いです。

## あなたに代わって判定する落とし穴

いくつかの制約は、好みに関係なく決定を強制します。

- **identity 値。** `SqlBulkCopy` はデフォルトでは、データベース生成の identity 列を返しません。クライアント側で事前に `Guid` ID を生成するか、ID を取り戻す必要がないことを受け入れるか、temp テーブルにステージして `OUTPUT` 句を持つ `MERGE` を使うかのいずれかです。EF Core 11 は `OUTPUT INSERTED.Id` 経由でラウンドトリップを透過的に処理します。その便利さこそが、そのオーバーヘッドが現実的である理由です。

- **トリガーと制約。** `SqlBulkCopy` はデフォルトでトリガーをスキップし (`SqlBulkCopyOptions.FireTriggers` でオプトイン)、制約チェックをスキップします (`CheckConstraints` でオプトイン)。ほとんどのデータウェアハウスのロードでは、これがまさに欲しいものです。監査トリガーを持つ OLTP テーブルでは、それらを黙ってオフにすることは落とし穴です。

- **混合書き込みバッチ。** 1 つのトランザクションがテーブル A に挿入し、テーブル B を更新し、テーブル C から削除する必要がある場合、EF Core のユニットオブワークは 3 つの別々の接続よりはるかに快適です。一括挿入が壁時計時間を支配するかもしれませんが、挿入が <10K 行であればギャップは閉じ、シンプルさが勝ちます。

- **プロバイダーの移植性。** EF Core の `AddRange` はコード変更なしですべてのサポートされているプロバイダーで動作します。`SqlBulkCopy` は SQL Server 専用です。コードパスが本番では SQL Server に対して動き、テストでは SQLite に対して動く場合、プロバイダーチェックの後ろに一括パスをゲートするか、両側で EF Core のヒットを受け入れるかのいずれかです。

- **producer 側のメモリ圧。** `AddRange` に渡す前の `events.ToList()` はワーキングセットを倍にします。`IDataReader` を使った `SqlBulkCopy` は、`IAsyncEnumerable<T>` または `IEnumerable<T>` から、完全なセットを決してマテリアライズせずにストリーミングします。5 GB の CSV ロードでは、これは完了と OOM の差です。producer 側については [大きな CSV を .NET 11 でメモリ不足にならずに読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) を参照してください。

- **ライセンスの表面。** EF Core (MIT)、Dapper (Apache 2.0)、`Microsoft.Data.SqlClient` (MIT)、`EFCore.BulkExtensions` (MIT) はすべて寛容です。`Dapper.Plus` と `Entity Framework Extensions` は商用です。"Dapper を一括に使う" 計画に Plus アドオンが含まれる場合、アーキテクチャ決定の前に予算を監査してください。

## 意見ある推奨、再述

1,000 行未満には EF Core 11 の `AddRange` + `SaveChangesAsync` をデフォルトに。10,000 行を超えるものには `SqlBulkCopy` (または EF マッピングを維持したい場合は `EFCore.BulkExtensions`) に切り替えます。中間は、コードが既にいる境界のどちらか側に属します。Dapper を、本当に最も得意とすること (正確な読み取りと小さなコマンド) に使ってください。一括挿入ではありません。

家のルールとして扱う価値のある 2 つの帰結:

- "Dapper は EF Core より速い" は単一行の読み取りと小さなコマンドには真です。一括挿入では逆です。上記のコミュニティベンチマークは、Dapper があらゆる行数で EF Core の `AddRange` よりまるまる一桁遅いことを示しています。なぜなら、Dapper には行のバッチ化がなく、EF Core にはあるからです。
- "一括挿入で EF Core を速くする" 正しい方法は、EF Core をチューニングすることではありません。痛む特定のコードパスについて、EF Core が開いた同じ接続を通じて `SqlBulkCopy` に手を伸ばすことで、ORM をスキップすることです。アプリケーションの残りはユニットオブワークのエルゴノミクスを保ち、1 つのホットパスがそれを迂回します。

## 関連

- [大きな CSV を .NET 11 でメモリ不足にならずに読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [`IAsyncEnumerable<T>` を EF Core 11 で使う方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Testcontainers を使って本物の SQL Server に対する統合テストを書く方法](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [EF Core でホットパスにコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Dapper、NVARCHAR、そして SQL Server のインデックスを殺す暗黙の変換](/ja/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)

## ソース

- [`SqlBulkCopy` クラス -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy)
- [Fast SQL Bulk Inserts With C# and EF Core -- Milan Jovanović](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core)
- [Bulk Operations in EF Core 10 -- insert、update、delete のベンチマーク](https://codewithmukesh.com/blog/bulk-operations-efcore/)
- [`EFCore.BulkExtensions` -- GitHub](https://github.com/borisdj/EFCore.BulkExtensions)
- [Dapper -- 公式リポジトリ](https://github.com/DapperLib/Dapper)
- [Npgsql `COPY` (バイナリ) ドキュメント -- PostgreSQL の一括同等品](https://www.npgsql.org/doc/copy.html)
