---
title: ".NET 11 のレスポンス圧縮における Zstandard と Brotli と Gzip の比較"
description: ".NET 11 の動的な API レスポンスには Zstandard が正しい既定値ですが、ASP.NET Core のプロバイダーが出荷時に設定している品質のままではいけません。実際の JSON ペイロードを使ったベンチマークで、品質 1 が既定の品質 3 をサイズと CPU の両方で上回る理由、Brotli が今も勝つ場面、そして Gzip が互換性のためのフォールバックとしてのみ残る理由を示します。"
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "compression"
  - "performance"
lang: "ja"
translationOf: "2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

.NET 11 の動的な API レスポンスには、すでに既定になっている Zstandard を使ってください。ただしプロバイダーの既定値をそのまま受け入れるのではなく、`Quality = 1` を明示的に設定します。私が計測した JSON ペイロードでは、品質 1 の Zstandard が 7.37 倍まで圧縮したのに対し、プロバイダー既定の品質 3 は 6.66 倍にとどまり、しかも品質 1 はほぼ 2 倍のスループットでそれを達成しました。Brotli が勝つのは一度圧縮して何度も配信できる場合だけで、それでも品質 11 に限られ、3 MB のレスポンス 1 件あたり 3.2 秒かかります。Gzip は今や純粋に互換性のためのフォールバックです。

以下の内容はすべて .NET 11 (執筆時点では Preview 7、正式リリースは 2026 年 11 月) と C# 14 を対象としています。Zstandard プロバイダーは ASP.NET Core 11 で新しく追加されたものです。Brotli と Gzip は ASP.NET Core 2.1 からミドルウェアに含まれており、.NET 8、9、10 でも同じ動作をします。

## 比較表

| | Zstandard | Brotli | Gzip |
| --- | --- | --- | --- |
| `Accept-Encoding` のトークン | `zstd` | `br` | `gzip` |
| 仕様 | [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878) | [RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932) | [RFC 1952](https://www.ietf.org/rfc/rfc1952.txt) |
| `System.IO.Compression` への同梱開始 | .NET 11 | .NET Core 2.1 | .NET Framework 2.0 |
| ASP.NET Core 11 で既定登録されるか | はい、1 番目 | はい、2 番目 | はい、3 番目 |
| プロバイダーの既定レベル | 品質 3 | `CompressionLevel.Fastest` | `CompressionLevel.Fastest` |
| レベルの範囲 | `MinQuality` (負の値) から 22 | 0 から 11 | 0 から 9 |
| 292 KB の JSON での圧縮率 (妥当な最良レベル) | 7.26x | 7.01x | 6.55x |
| そのレベルでの圧縮スループット | 572 MB/s | 215 MB/s | 208 MB/s |
| 展開スループット | 3103 MB/s | 1134 MB/s | 1575 MB/s |
| Blazor WebAssembly で動作するか | いいえ | はい | はい |
| 辞書のサポート | 学習可能 (`ZstandardDictionary`) | 組み込みの静的辞書のみ | なし |

議論の大半を決めるのは、展開スループットの行と WebAssembly の行です。それ以外はコイントスで決めても構わない程度の差しかありません。

## .NET 11 が実際に登録するものと、その順序

プロバイダーを指定せずに `AddResponseCompression()` を呼ぶと、ASP.NET Core 11 は 3 つを登録します。[`ResponseCompressionProvider`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs) 内のこの順序が、サーバー側の優先順位です。

```csharp
// ASP.NET Core 11, from ResponseCompressionProvider.cs
_providers = new ICompressionProvider[]
{
    new CompressionProviderFactory(typeof(ZstandardCompressionProvider)),
    new CompressionProviderFactory(typeof(BrotliCompressionProvider)),
    new CompressionProviderFactory(typeof(GzipCompressionProvider)),
};
```

したがって `Accept-Encoding: gzip, deflate, br, zstd` を送るブラウザーは、あなたが一度も設定していない ASP.NET Core 11 アプリから `Content-Encoding: zstd` を受け取ります。.NET 10 では同じリクエストが `br` を受け取っていました。ユーザーから見える変更はこれがすべてで、アップグレード時にコードを 1 行も編集せずに発生します。

プロバイダーを 1 つでも手動で追加した瞬間、既定値は完全に無効になり、あなたのリストだけが有効になります。HTTPS 圧縮を有効にしているだけのつもりで、うっかり Zstandard を無効にしてしまう最も多いパターンがこれです。

## 既定の品質は適切ではない

ここからがリリースノートに載っていない部分です。`BrotliCompressionProviderOptions` と `GzipCompressionProviderOptions` はどちらも既定で `CompressionLevel.Fastest` を使います。Zstandard プロバイダーには `Level` プロパティ自体がありません。あるのはこれです。

```csharp
// ASP.NET Core 11, from ZstandardCompressionProviderOptions.cs
public ZstandardCompressionOptions CompressionOptions { get; set; } = new();
```

新しく生成された `ZstandardCompressionOptions` は `Quality` を `0` のままにします。そして `0` は「実装が定める既定値」を意味し、libzstd はこれをレベル 3 に解決します。つまり Brotli と Gzip のプロバイダーはレイテンシ重視で調整されているのに、Zstandard プロバイダーは libzstd のバランス型の既定値で出荷されているわけです。この非対称性はどこにも明記されていませんが、ソースコードはそう述べています。

品質 3 が単に「遅くて小さい」選択肢であれば、これは些細な指摘で済みました。しかしそうではありません。私が計測した JSON ペイロードでは、品質 3 は **両方の** 軸で品質 1 に劣ります。

| zstd の品質 | 2.88 MB の JSON のサイズ | 圧縮率 | 圧縮スループット |
| --- | --- | --- | --- |
| 1 | 409,809 B | 7.37x | 806 MB/s |
| 2 | 427,111 B | 7.07x | - |
| 3 (プロバイダー既定) | 453,130 B | 6.66x | 425 MB/s |
| 4 | 460,813 B | 6.55x | - |
| 5 | 449,750 B | 6.71x | - |
| 6 | 436,263 B | 6.92x | 159 MB/s |
| 9 | 422,148 B | 7.15x | - |
| 12 | 416,795 B | 7.24x | 54 MB/s |
| 19 | 362,100 B | 8.34x | - |

この列をもう一度見てください。圧縮率はレベル 1 からレベル 4 にかけて下がり、その後また上がり、レベル 9 になるまでレベル 1 を上回りません。1.9 倍の CPU を払って 11% 大きいボディを得るのは、どの方向から見ても割に合いません。

これはバグではなく、.NET 固有の話でもありません。Zstandard のレベルは単一のつまみではなく、各レベルが異なるマッチ探索の戦略と、それぞれ固有のウィンドウ、チェーン、ハッシュ、最小マッチ長のパラメーターを選択します。libzstd に使用パラメーターを直接問い合わせると、その不連続性が見えます。

```
level  1: strategy=1 (fast)   windowLog=19 chainLog=13 hashLog=14 minMatch=7
level  2: strategy=1 (fast)   windowLog=20 chainLog=15 hashLog=16 minMatch=6
level  3: strategy=2 (dfast)  windowLog=21 chainLog=16 hashLog=17 minMatch=5
level  4: strategy=2 (dfast)  windowLog=21 chainLog=18 hashLog=18 minMatch=5
level  5: strategy=3 (greedy) windowLog=21 chainLog=18 hashLog=19 minMatch=5
level  6: strategy=4 (lazy)   windowLog=21 chainLog=18 hashLog=19 minMatch=5
```

レベル 2 からレベル 3 への移行で `minMatch` が 6 から 5 に下がり、戦略も切り替わります。長くて反復性の高いテキスト (配列要素ごとに 1 回繰り返される JSON のキー、全レコードで同一の `notes` 文字列) では、レベル 1 の構成のほうが数は少なくても長いマッチを見つけ、エントロピー符号化でより小さくなります。これらのレベル表は一般的なコーパスに対して調整されたものなので、順序が成り立つのは平均的にであって、あなたのペイロードに対してではありません。

実務上の原則はこうです。どのコーデックであれ既定レベルは、見たことのないデータについての推測にすぎません。自分のエンドポイントの実際の 2 つか 3 つの形を計測し、品質を固定してください。

## ベンチマーク

ペイロード: 顧客レコードの JSON 配列で、一覧エンドポイントが実際に返す形です。再現できるよう決定的にしてあります。

```csharp
// .NET 10 / .NET 11, C# 14
static Guid NextGuid(Random rnd)
{
    var b = new byte[16];
    rnd.NextBytes(b);
    return new Guid(b);
}

static byte[] MakeListPayload(int count, int seed)
{
    var rnd = new Random(seed);
    string[] cities = ["Bucharest", "Berlin", "Lisbon", "Warsaw", "Dublin", "Madrid", "Helsinki"];
    string[] statuses = ["active", "pending", "suspended", "closed"];
    var items = Enumerable.Range(1, count).Select(i => new
    {
        id = i,
        externalId = NextGuid(rnd).ToString(),
        name = $"Customer {i}",
        email = $"user{i}@example.com",
        city = cities[rnd.Next(cities.Length)],
        status = statuses[rnd.Next(statuses.Length)],
        balance = Math.Round(rnd.NextDouble() * 10000, 2),
        createdAt = new DateTime(2024, 1, 1).AddMinutes(i * 7).ToString("O"),
        tags = new[] { "vip", "eu", "newsletter" }.Take(rnd.Next(1, 4)).ToArray(),
        notes = "Imported from the legacy CRM during the 2024 migration."
    });
    return JsonSerializer.SerializeToUtf8Bytes(items);
}
```

方法: 各コーデックは、レスポンス圧縮ミドルウェアがレスポンスボディを包むのとまったく同じように `MemoryStream` を包みます。そのためレスポンスごとのエンコーダー準備も計測に含まれます。ウォームアップを 3 回行った後、292 KB のペイロードでは 60 回、2.88 MB のペイロードでは 15 回を計測し、中央値を報告します。マシン: Intel Core Ultra 7 265KF、Windows 11、.NET 10.0.5 x64。

環境について正直な但し書きがあります。私のマシンには SDK 10.0.201 しか入っておらず、`System.IO.Compression.ZstandardStream` に対してコンパイルできませんでした。Zstandard の行は、参照実装のマネージドポートである [ZstdSharp.Port](https://www.nuget.org/packages/ZstdSharp.Port) 0.8.8 によるものです。この代用が妥当だといえる理由は 2 つあります。第一に、.NET 11 は [libzstd 1.5.7](https://github.com/dotnet/runtime/blob/main/src/native/external/zstd/lib/zstd.h) を同梱しており、私は ZstdSharp の出力サイズすべてを、同一のバイト列に対するネイティブの libzstd 1.5.7 と照合しました。両者は 0.05% 以内で一致します (品質 1 で 41,132 対 41,135 バイト、品質 3 で 43,644 対 43,647)。したがって圧縮後のサイズは .NET 11 が生成するものと同じです。第二に、転用できない数値はスループットです。このハードウェアではネイティブの libzstd が品質 1 で 1092 MB/s を出したのに対し、マネージドポートは 806 MB/s でした。Zstandard の速度の列は上限ではなく下限として扱ってください。

**292 KB の JSON (1,000 レコード)、元データ 298,727 バイト:**

| コーデック | レベル | 圧縮後 | 圧縮率 | 圧縮 MB/s | 展開 MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 69,832 | 4.28x | 743 | 1488 |
| gzip | Optimal | 45,586 | 6.55x | 208 | 1575 |
| brotli | Fastest | 44,606 | 6.70x | 564 | 808 |
| brotli | Optimal | 42,610 | 7.01x | 215 | 1134 |
| brotli | q11 (SmallestSize) | 34,025 | 8.78x | 1 | 728 |
| zstd | q1 | 41,132 | 7.26x | 572 | 3103 |
| zstd | q3 (プロバイダー既定) | 43,644 | 6.84x | 276 | 1796 |
| zstd | q6 | 41,009 | 7.28x | 112 | 1735 |
| zstd | q12 | 38,881 | 7.68x | 20 | 1320 |

**2.88 MB の JSON (10,000 レコード)、元データ 3,018,756 バイト:**

| コーデック | レベル | 圧縮後 | 圧縮率 | 圧縮 MB/s | 展開 MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 697,252 | 4.33x | 712 | 1443 |
| gzip | Optimal | 452,661 | 6.67x | 204 | 1620 |
| brotli | Fastest | 447,954 | 6.74x | 786 | 726 |
| brotli | Optimal | 429,060 | 7.04x | 186 | 1088 |
| brotli | q11 (SmallestSize) | 341,338 | 8.84x | 1 | 842 |
| zstd | q1 | 409,805 | 7.37x | 806 | 3158 |
| zstd | q3 (プロバイダー既定) | 454,007 | 6.65x | 425 | 1914 |
| zstd | q6 | 436,263 | 6.92x | 159 | 1846 |
| zstd | q12 | 416,792 | 7.24x | 54 | 1891 |

この比較全体を支えている結果は 3 つです。

**品質 1 の Zstandard は Brotli の `Fastest` を全面的に上回ります。** 出力はより小さく (41,132 対 44,606 バイト)、圧縮スループットは同等 (572 対 564 MB/s)、展開スループットは 3.8 倍です。動的なレスポンスにおいて Brotli の高速設定のほうが良い選択になる軸は存在しません。

**Gzip の `Fastest` はサイズで勝負になりません。** Zstandard の 41,132 バイトに対して 69,832 バイトは、スループット面の利点なしにボディが 70% 大きいということです。今も現代的なクライアントに `gzip` を返しているなら、その分を帯域で払っています。

**Brotli q11 はリクエストパス上の罠です。** 確かに表の中で最も小さい出力 8.78x を出しており、品質 1 の Zstandard より約 17% 優秀です。しかし 292 KB のペイロードで 272 ミリ秒、2.88 MB のペイロードで 3.2 秒かかりました。しかもレスポンス 1 件あたりです。「Brotli が最もよく圧縮する」と計測して本番 API に `SmallestSize` を設定した人は、大きなレスポンスすべてに CPU 律速の遅延を 3 秒追加したことになります。

## それぞれをいつ選ぶか

**Zstandard、品質 1** はリクエストごとに計算されるものすべてに。JSON の一覧エンドポイント、GraphQL のレスポンス、サーバーでレンダリングした HTML、ログ取り込みのレスポンスなどです。これが .NET 11 の既定であり、必要な変更は品質を固定することだけです。

**Zstandard、品質 12 から 19** は一度圧縮してキャッシュするコンテンツに。圧縮済みバイト列を保存して繰り返し配信する場合です。品質 19 は大きいペイロードで 8.34x に達し、Brotli q11 との差の大半をわずかなコストで埋めました。[出力キャッシュ](/ja/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) と組み合わせて、CPU コストをリクエストごとではなくキャッシュエントリごとに 1 回だけ払うようにしてください。

**Brotli、品質 11** はビルド時に圧縮する静的アセットに。JS バンドル、CSS、WASM ペイロードなどです。CI で行うなら圧縮時間は問題になりませんし、Brotli の組み込み静的辞書はまさにこの種のコンテンツ向けに調整されています。これをレスポンス圧縮ミドルウェアでやってはいけません。事前に圧縮して `.br` ファイルを配信してください。

**Brotli、`Optimal`** は幅広いクライアント対応が必要で Zstandard を使えない場合に。特に Blazor WebAssembly が該当します。後述します。

**Gzip** はプロバイダーリストの最後の項目としてのみ、他に何も宣言しないクライアントのために。登録は残しておき、優先させることは決してしないでください。

## 判断を左右する落とし穴

**Zstandard はブラウザーにも WASI にも存在しません。** ランタイムはこの型ファミリー全体に `[UnsupportedOSPlatform("browser")]` と `[UnsupportedOSPlatform("wasi")]` を付けています。クライアントが自前で展開を行う Blazor WebAssembly アプリである場合や、`wasi-wasm` 上で動かしている場合、Zstandard は選択肢になりませんし、アナライザーがビルド時に指摘します。ブラウザー向けのサーバー側圧縮には影響しません。ブラウザー自身の `zstd` サポートが `Content-Encoding: zstd` をネイティブに処理し、それは Chrome、Edge、Firefox でしばらく前から利用できます。影響を受けるのは WASM ランタイム内で `ZstandardStream` を呼ぶコードだけです。

**Zstandard では `CompressionLevel.NoCompression` は無圧縮を意味しません。** ランタイムはこの列挙型を zstd の品質に次のようにマッピングします。

```csharp
// .NET 11, from ZstandardUtils.cs
CompressionLevel.NoCompression => Quality_Min,   // ZSTD_minCLevel(), a large negative number
CompressionLevel.Fastest       => 1,
CompressionLevel.Optimal       => Quality_Default,  // 3
CompressionLevel.SmallestSize  => Quality_Max,      // 22
```

`NoCompression` は *最小品質* にマッピングされますが、これは依然として圧縮を行う構成であり、極端に高速で弱いというだけです。Gzip と Brotli では `NoCompression` は本当に無圧縮ブロックを意味します。同じ列挙値を 3 つのコーデックに渡すと、3 通りの異なる挙動になります。

**負の品質値は有効ですが、ASP.NET Core のドキュメントはそれに触れていません。** [レスポンス圧縮のページ](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0) は品質レベルが「1 から 22 の範囲」だと記しています。ランタイムのソースはより広く、`Quality` は `MinQuality` から `MaxQuality` までの任意の値を受け付け、負の値は速度と圧縮率のトレードオフ範囲を拡張するものとして文書化されています。JSON でこれが欲しくなることはまずありません。品質 -5 は圧縮を 1635 MB/s まで引き上げましたが、圧縮率は 7.37x から 3.81x に崩れました。3 MB のレスポンスでは、CPU を 1 ミリ秒節約するために約 375 KB 多くネットワークに流すことになります。負の値ではなく品質 1 を選んでください。

**HTTPS 上での圧縮を有効にすることは、依然として実際のリスクを伴うオプトインです。** `EnableForHttps` の既定が `false` なのは、秘密情報と攻撃者が影響を与えられる入力が混在したレスポンスを圧縮すると、圧縮後のサイズを通じてその秘密情報が漏れるからです ([CRIME](https://en.wikipedia.org/wiki/CRIME) と [BREACH](https://en.wikipedia.org/wiki/BREACH))。コーデックを変えてもこれは変わりません。Zstandard は Gzip とまったく同じだけ脆弱です。その理由と緩和策のチェックリストは [レスポンス圧縮の設定ガイド全編](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) が扱っています。

**小さなレスポンスはどのコーデックでも損をします。** 私のテストセットの単一レコードのレスポンスは 179 バイトです。Gzip の `Fastest` はこれを入力より大きい 188 バイトにし、品質 1 の Zstandard は 157 バイトにしました。この 1.14x という「利得」は、フレーミングのオーバーヘッドとレスポンスごとのエンコーダー準備で完全に相殺されます。フレームワーク自身の指針はおよそ 150 から 1,000 バイト未満は圧縮しないことであり、コーデックの選択でこのしきい値は動きません。

## 設定方法

品質を固定した JSON API 向けの完全な設定です。

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 1
    };
});

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/customers", () => Results.Ok(GetCustomers()));

app.Run();
```

3 つのプロバイダーを明示的に追加するのは既定値と重複していますが、次に読む人に優先順位を伝えられますし、後から誰かが 4 つ目のプロバイダーを追加しても壊れません。

ストリーミングレスポンスでは `ZstandardCompressionOptions` のもう 2 つのつまみも知っておく価値があります。`TargetBlockSize` (有効範囲は 1,340 から 131,072 バイト) はエンコーダーがブロックを出力する頻度のヒントで、値を小さくすると少しずつ流れるレスポンスのレイテンシが下がりますが、圧縮率は多少犠牲になります。`EnableLongDistanceMatching` はメモリと引き換えに大きなボディの圧縮率を改善します。どちらも、品質を固定して計測するまでは触る価値がありません。

レスポンスが小さく、均質で、反復的であるなら、本当に調べる価値がある機能は `ZstandardDictionary` です。代表的なサンプルで辞書を学習させると、単体では有用なウィンドウを構築できないほど小さいペイロードでも Zstandard が圧縮できるようになります。上に挙げた 179 バイトのレスポンスが圧縮可能になるのは、まさにこのケースだけです。Brotli と Gzip には、自分で学習させられる同等の仕組みはありません。

## 結論をもう一度

.NET 11 の既定値を採用し、プロパティを 1 つ固定してください。品質 1 の Zstandard は、リクエストパスで使える速度のレベルの中で最良の圧縮率を出し、圧縮スループットでは Brotli の最速設定と並び、展開は表の他のどれよりも約 3 倍高速でした。これはモバイルクライアントが体感する数値です。Brotli と Gzip はその下に登録したままにして、古いクライアントにも何かが届くようにしておきましょう。

プロバイダー既定の品質 3 を受け入れてはいけません。この比較の中で唯一、サイズと速度の両方で同時に負けている構成であり、何も変えなければそれが適用されます。

## 関連記事

- [ASP.NET Core 11 の API にレスポンス圧縮を追加する方法](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) はミドルウェアの設定、MIME タイプ、HTTPS のセキュリティ判断を網羅しています。
- [.NET 11 が System.IO.Compression にネイティブの Zstandard 圧縮を追加](/ja/2026/04/dotnet-11-zstandard-compression-system-io/) は HTTP の文脈を離れて `ZstandardStream` API を紹介しています。
- [ASP.NET Core 11 における出力キャッシュとレスポンスキャッシュの比較](/ja/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) は高い圧縮レベルを現実的なコストに収める方法です。
- [.NET 11 の span ベース Deflate および Gzip 圧縮](/ja/2026/05/dotnet-11-span-based-deflate-gzip-compression/) は古いコーデック向けのアロケーションなしのワンショット API を扱っています。
- [ASP.NET Core のエンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) は圧縮とストリーミングが噛み合わない箇所を説明しています。

## 参考資料

- [ASP.NET Core 11 のレスポンス圧縮 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionProvider.cs、既定のプロバイダー順序 (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs)
- [ZstandardCompressionProviderOptions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ZstandardCompressionProviderOptions.cs)
- [ZstandardCompressionOptions.cs、品質とウィンドウの意味 (dotnet/dotnet)](https://github.com/dotnet/dotnet/blob/main/src/runtime/src/libraries/System.IO.Compression.Zstandard/src/System/IO/Compression/ZstandardCompressionOptions.cs)
- [ZstandardCompressionOptions クラスリファレンス (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardcompressionoptions?view=net-11.0)
- [Support zstd Content-Encoding (dotnet/aspnetcore issue 50643)](https://github.com/dotnet/aspnetcore/issues/50643)
- [RFC 8878: Zstandard Compression and the application/zstd Media Type](https://datatracker.ietf.org/doc/html/rfc8878)
- [Zstandard の参照実装](https://github.com/facebook/zstd)
