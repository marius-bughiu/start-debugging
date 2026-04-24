---
title: ".NET 11 でメモリ不足にならずに大きな CSV を読む方法"
description: ".NET 11 で複数ギガバイトの CSV を OutOfMemoryException なしでストリーミングする。File.ReadLines、CsvHelper、Sylvan、Pipelines をコードと計測値で比較。"
pubDate: 2026-04-24
tags:
  - "dotnet-11"
  - "csharp-14"
  - "performance"
  - "csv"
  - "streaming"
lang: "ja"
translationOf: "2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory"
translatedBy: "claude"
translationDate: 2026-04-24
---

CSV を読んでいる途中でプロセスが `OutOfMemoryException` で死ぬ場合、修正策はほぼ毎回同じ一文です: ファイルをマテリアライズするのをやめて、ストリーミングを始める。.NET 11 と C# 14 では、`File.ReadLines` が 80% のケースをカバーし、`CsvHelper.GetRecords<T>()` がバッファリングなしの型付きパースをカバーし、`Sylvan.Data.Csv` と `System.IO.Pipelines` がファイルが 5-50 GB の範囲のときに最後の桁を稼ぎ出してくれます。最悪の選択は、数 MB を超える何かに対して `File.ReadAllLines` や `File.ReadAllText` を呼ぶことです。両方ともペイロード全体を `string[]` に読み込み、それは GC が誰も触っていないと納得するまで Large Object Heap に居座らなければなりません。

この記事では 4 つの手法を複雑さの順に巡り、それぞれが実際に何をアロケートするかを示し、CSV にクオートされた複数行フィールドや BOM が含まれていたり、読み込みの途中でキャンセルが必要になったりしたときに噛みつく落とし穴を強調します。全体で使用したバージョン: .NET 11、C# 14、`CsvHelper 33.x`、`Sylvan.Data.Csv 1.4.x`。

## なぜ CSV リーダーがギガバイト級にアロケートしているのか

2 GB の UTF-8 CSV はメモリ上では概ね 4 GB の `string` になります。.NET の string が UTF-16 だからです。`File.ReadAllLines` はさらに進んで、行ごとに `string` を、それを保持する `string[]` 配列もアロケートします。2000 万行のファイルでは、ヒープ上に 2000 万のオブジェクト、Large Object Heap 上のトップレベル配列、そして圧力がついに収集を強制したときに数十秒の世代 2 GC ポーズに行き着きます。32 ビットプロセスや制約のあるコンテナでは、プロセスがそのまま死にます。

修正策は 1 レコードずつ読み、次のレコードがパースされる前にそれぞれのレコードをガベージコレクションの対象にすることです。それがストリーミングの定義であり、以下のすべての手法はエルゴノミクス対スループットの曲線上の異なる点です。

## 1 行のアップグレード: `File.ReadLines`

`File.ReadAllLines` は `string[]` を返します。`File.ReadLines` は `IEnumerable<string>` を返し、遅延読み込みします。一方を他方に置き換えるだけで十分なことが多いです。

```csharp
// .NET 11, C# 14
using System.Globalization;

int rowCount = 0;
decimal total = 0m;

foreach (string line in File.ReadLines("orders.csv"))
{
    if (rowCount++ == 0) continue; // header

    ReadOnlySpan<char> span = line;
    int firstComma = span.IndexOf(',');
    int secondComma = span[(firstComma + 1)..].IndexOf(',') + firstComma + 1;

    ReadOnlySpan<char> amountSlice = span[(secondComma + 1)..];
    total += decimal.Parse(amountSlice, CultureInfo.InvariantCulture);
}

Console.WriteLine($"{rowCount - 1} rows, total = {total}");
```

ここでの定常状態のアロケーションは、行ごとの `string` 1 つに加えて、`decimal.Parse` のオーバーロードが必要とするものだけです。ピークのワーキングセットはファイルサイズに関係なく数 MB で平らに保たれます。enumerator が裏で 4 KB の `StreamReader` バッファを通して読むからです。

実データに頼るときに噛んでくる注意点が 2 つあります。

第一に、`File.ReadLines` は CSV のクオートを認識しません。`"first line\r\nsecond line"` を含むセルは 2 つのレコードになります。データが Excel、Salesforce のエクスポート、人間が打ち込む場所から来ているなら、1 週間以内にこれに当たります。

第二に、enumerator はファイルを開き、enumerator を破棄するか最後まで反復するまでハンドルを保持します。早めにループを break すると、enumerator がファイナライズされたときにハンドルが解放されますが、これは非決定的です。シナリオ的に重要なら、明示的な `IEnumerator<string>` を `using` でラップしてください。

## `StreamReader.ReadLineAsync` での非同期ストリーミング

ネットワーク共有、S3 バケット、レイテンシのある場所から読む場合、同期 `foreach` はファイルごとに 1 スレッドをブロックします。`StreamReader.ReadLineAsync` (.NET 7+ で `ValueTask<string?>` を返すように追加オーバーロード) と `IAsyncEnumerable<string>` が正しいプリミティブです。

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var stream = new FileStream(
        path,
        new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    using var reader = new StreamReader(stream);

    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

ここでは本番に関連する 2 つのつまみを設定しています。`FileOptions.SequentialScan` は OS に積極的な read-ahead を使うよう伝え、通り過ぎた後はページを捨てます。これによりファイルが RAM より大きいときにページキャッシュが追い回されません。`BufferSize = 64 * 1024` はデフォルトの 4 倍で、NVMe ストレージ上で syscall 数を計測可能なほど減らします。64 KB を超えても効果はめったにありません。

キャンセルを決定的に尊重したいなら、これを timeout 付きの `CancellationTokenSource` と組み合わせてください。デッドロックなしで非同期パイプラインにキャンセルを通す方法のより長い議論は、[デッドロックせずに C# の長時間 Task をキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) を参照してください。

## バッファリングなしの型付きパース: CsvHelper の `GetRecords<T>()`

生の行は形が単純なデータには十分です。null 許容カラム、クオートされた区切り、POCO にマップしたいヘッダーがあるものには、CsvHelper がデフォルトです。重要なのは、`GetRecords<T>()` が `IEnumerable<T>` を返し、列挙の間 1 つのレコードインスタンスを再利用するという点です。その enumerable を `.ToList()` でマテリアライズすると、ライブラリ全体の意味を打ち消します。

```csharp
// .NET 11, C# 14, CsvHelper 33.x
using System.Globalization;
using CsvHelper;
using CsvHelper.Configuration;

public sealed record Order(int Id, string Sku, decimal Amount, DateTime PlacedAt);

static async Task ProcessAsync(string path, CancellationToken ct)
{
    var config = new CsvConfiguration(CultureInfo.InvariantCulture)
    {
        HasHeaderRecord = true,
        MissingFieldFound = null,   // tolerate missing optional columns
        BadDataFound = null,        // silently skip malformed quotes; log these in prod
    };

    using var reader = new StreamReader(path);
    using var csv = new CsvReader(reader, config);

    await foreach (Order order in csv.GetRecordsAsync<Order>(ct))
    {
        // process one record; do NOT cache `order`, it is reused under synchronous mode
    }
}
```

`GetRecordsAsync<T>` は `IAsyncEnumerable<T>` を返し、内部では `ReadAsync` を使うため、遅いディスクやネットワークストリームでもスレッドプールが飢えません。型は明示コンストラクター付きの `record` なので、CsvHelper は reflection でカラムごとのセッターを 1 度生成し、その後すべての行で同じパスを再利用します。12 カラムの 1 GB 注文ファイルでは、現代のラップトップで毎秒約 60 万行をパースし、ワーキングセットは 30 MB 以下に固定されます。

`DataTable` から来た人を引っ掛ける注意点: ループ内で受け取るオブジェクトは、CsvHelper が再利用パスを使っているとき、各イテレーションで同じインスタンスです。下流のキューに行を取り込む必要があるなら、明示的にクローンするか、`with` 式で新しいレコードに射影してください。

## 最大スループット: Sylvan.Data.Csv と `DbDataReader`

CsvHelper は便利ですが、最速ではありません。1 コアで 100 MB/s を押し通す必要があるなら、`Sylvan.Data.Csv` がセル単位のアロケーションをほぼゼロにして CSV の上に `DbDataReader` を出すライブラリです。`GetFieldSpan` を露出することでフィールド単位の `string` を回避し、内部の `char` バッファから直接数値をパースします。

```csharp
// .NET 11, C# 14, Sylvan.Data.Csv 1.4.x
using Sylvan.Data.Csv;

using var reader = CsvDataReader.Create(
    "orders.csv",
    new CsvDataReaderOptions
    {
        HasHeaders = true,
        BufferSize = 0x10000, // 64 KB
    });

int idOrd     = reader.GetOrdinal("id");
int skuOrd    = reader.GetOrdinal("sku");
int amountOrd = reader.GetOrdinal("amount");

long rows = 0;
decimal total = 0m;

while (reader.Read())
{
    rows++;
    // GetFieldSpan avoids allocating a string for fields you never need as a string
    ReadOnlySpan<char> amountSpan = reader.GetFieldSpan(amountOrd);
    total += decimal.Parse(amountSpan, provider: CultureInfo.InvariantCulture);

    // GetString only when you actually need the managed string
    string sku = reader.GetString(skuOrd);
    _ = sku;
}
```

同じ 1 GB ファイルで毎秒約 250 万行を達成し、実行全体で 1 MB 未満をアロケートします。アロケーションはバッファ自体が支配的です。トリックは `GetFieldSpan` と、中間の string を必要としない `decimal.Parse(ReadOnlySpan<char>, ...)` のようなオーバーロードです。.NET 11 のパーシングプリミティブはこのパターンを中心に設計されており、span を直接露出するリーダーと組み合わせると、セル単位のアロケーションが完全に消えます。

`CsvDataReader` は `DbDataReader` を継承しているため、`SqlBulkCopy`、Dapper の `Execute`、EF Core の `ExecuteSqlRaw` にもそのまま流し込めます。これが、10 GB の CSV を SQL Server に移すときに、マネージドメモリにマテリアライズせずに済む方法です。最終状態がデータベースなら、パースループ自体をスキップできることがしばしばあります。

## 最後の 10%: UTF-8 パースの `System.IO.Pipelines`

ボトルネックが UTF-16 変換そのものになったら、`System.IO.Pipelines` を使ってバイトレベルのパースに降りてください。考え方は、ファイルのバイトを最後まで UTF-8 のまま保ち、バッファを `,` と `\n` の境界でスライスし、`Utf8Parser.TryParse` または `int.TryParse(ReadOnlySpan<byte>, ...)` (.NET 7 で追加され、.NET 11 でさらに調整) を使って値をアロケーションなしでパースすることです。

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Buffers.Text;
using System.IO.Pipelines;

static async Task<decimal> SumAmountsAsync(Stream source, CancellationToken ct)
{
    var reader = PipeReader.Create(source);
    decimal total = 0m;
    bool headerSkipped = false;

    while (true)
    {
        ReadResult result = await reader.ReadAsync(ct);
        ReadOnlySequence<byte> buffer = result.Buffer;

        while (TryReadLine(ref buffer, out ReadOnlySequence<byte> line))
        {
            if (!headerSkipped) { headerSkipped = true; continue; }
            total += ParseAmount(line);
        }

        reader.AdvanceTo(buffer.Start, buffer.End);

        if (result.IsCompleted) break;
    }

    await reader.CompleteAsync();
    return total;
}

static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
{
    SequencePosition? position = buffer.PositionOf((byte)'\n');
    if (position is null) { line = default; return false; }

    line = buffer.Slice(0, position.Value);
    buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
    return true;
}

static decimal ParseAmount(ReadOnlySequence<byte> line)
{
    ReadOnlySpan<byte> span = line.IsSingleSegment ? line.FirstSpan : line.ToArray();
    int c1 = span.IndexOf((byte)',');
    int c2 = span[(c1 + 1)..].IndexOf((byte)',') + c1 + 1;
    ReadOnlySpan<byte> amount = span[(c2 + 1)..];

    Utf8Parser.TryParse(amount, out decimal value, out _);
    return value;
}
```

これは冗長で、クオートされたフィールドを扱わず、実際のボトルネックを計測していない限り手を伸ばすべきではありません。引き換えに得られるのは、下のストレージが提供できる範囲の 10% 以内のスループットです。マネージドコードがコンマ探し以上のことをほぼしないからです。ホットパスに小さな区切りやセンチネルバイトの集合があるときに役立つ関連トリックは、[.NET 10 で導入された `SearchValues<T>`](/2026/01/net-10-performance-searchvalues/) で、集合内の任意のバイトのスキャンをベクトル化します。

## 本番で噛みつく落とし穴

複数行のクオートされたフィールドは、行ベースのあらゆるアプローチを破壊します。正しい CSV パーサーは、行境界をまたいで「クオート内かどうか」の状態を追跡します。`File.ReadLines`、`StreamReader.ReadLine`、上の手書き `Pipelines` サンプルはどれもこれを誤ります。CsvHelper と Sylvan は扱います。性能のために自分のパーサーを書いているなら、RFC 4180 を自分で実装することにもサインアップしていることになります。

UTF-8 BOM (`0xEF 0xBB 0xBF`) は、Excel や多くの Windows ツールが生成するファイルの先頭に現れます。`StreamReader` はデフォルトでこれを取り除きますが、`PipeReader.Create(FileStream)` は取り除きません。最初のフィールドパースの前に明示的にチェックしないと、最初のヘッダー名が `\uFEFFid` のように見え、序数ルックアップが投げます。

`File.ReadLines` と上の CsvHelper のフローは、enumerator の生存期間中ファイルハンドルを開いたまま保持します。呼び出し側が反復している間にファイルを削除またはリネームする必要があるなら (例: 監視している inbox ディレクトリ)、`FileStream` を手動で開くときに `FileShare.ReadWrite | FileShare.Delete` を渡してください。

CSV 行の並列処理は誘惑的で、行ごとの仕事が本当に CPU バウンドでない限りたいてい間違っています。パースは I/O バウンドで、パーサー自体はスレッドセーフではありません。正しいパターンは、単一スレッドでパースし、行を `Channel<T>` に publish してワーカーにファンアウトすることです。[EF Core 11 のための `IAsyncEnumerable<T>` ウォークスルー](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) は、データベースソースに対する同じ単一プロデューサー・複数コンシューマーパターンを示しており、形はそのまま転送できます。

ファイルが圧縮されている場合、先にディスクに展開しないでください。展開ストリームをパーサーに連結してください:

```csharp
// .NET 11, C# 14
using var file = File.OpenRead("orders.csv.zst");
using var zstd = new ZstandardStream(file, CompressionMode.Decompress);
using var reader = new StreamReader(zstd);
// feed `reader` to CsvReader or parse lines directly
```

新しい組み込み Zstandard サポートのコンテキストは、[.NET 11 のネイティブ Zstandard 圧縮](/2026/04/dotnet-11-zstandard-compression-system-io/) を参照してください。.NET 11 より前は `ZstdNet` NuGet パッケージが必要でしたが、System.IO.Compression 版は大幅に高速で P/Invoke の依存も避けます。

キャンセルは思っているより重要です。20 GB の CSV パースは数分のオペレーションです。呼び出し側が諦めたら、enumerator は次のレコードでそれに気づき `OperationCanceledException` を投げてほしい、最後まで走ってほしくありません。上の async バリアントはすべて `CancellationToken` を通します。同期の `File.ReadLines` ループでは、ループ本体で適切な間隔で `ct.ThrowIfCancellationRequested()` をチェックしてください (1000 行ごと、毎行ではなく)。

## 適切なツールを選ぶ

CSV が 100 MB 未満で形が単純なら、`File.ReadLines` と `string.Split` または `ReadOnlySpan<char>` のスライスを使ってください。クオート、null 許容、または型付きレコードが欲しいなら、CsvHelper の `GetRecordsAsync<T>` を使ってください。スループットが支配的でデータが整形されているなら、Sylvan の `CsvDataReader` を使い、span から直接パースしてください。`System.IO.Pipelines` に降りるのは、UTF-16 変換における特定のボトルネックを計測し、カスタムパーサーをメンテナンスする予算があるときだけです。

4 つに共通する糸: ファイル全体をバッファしないこと。`ToList`、`ReadAllLines`、または `ReadAllText` を呼んだ瞬間に、ストリーミング性質を放棄したことになり、メモリフットプリントは入力に比例して増えます。4 GB のコンテナで 20 GB のファイルにこれをやると、終わり方は 1 つです。

## 参考資料

- [File.ReadLines on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.readlines)
- [FileStreamOptions on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions)
- [CsvHelper documentation](https://joshclose.github.io/CsvHelper/)
- [Sylvan.Data.Csv on GitHub](https://github.com/MarkPflug/Sylvan)
- [System.IO.Pipelines in .NET](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [Utf8Parser on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.text.utf8parser)
