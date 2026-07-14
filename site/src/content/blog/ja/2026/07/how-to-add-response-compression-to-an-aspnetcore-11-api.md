---
title: "ASP.NET Core 11 の API にレスポンス圧縮を追加する方法"
description: "ASP.NET Core 11 におけるレスポンス圧縮の完全ガイド。AddResponseCompression と UseResponseCompression、Brotli と Gzip に加わった新しい組み込みの Zstandard プロバイダー、圧縮レベル、EnableForHttps と CRIME/BREACH のリスク、カスタム MIME タイプ、middleware の順序、そしてリバースプロキシに任せるべき場合を解説します。"
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
lang: "ja"
translationOf: "2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api"
translatedBy: "claude"
translationDate: 2026-07-14
---

ASP.NET Core 11 の API にレスポンス圧縮を追加するには、ちょうど 2 行が必要です。`builder.Services.AddResponseCompression()` で middleware を登録し、`app.UseResponseCompression()` でパイプラインに追加します。これで Brotli、Gzip、そして (.NET 11 で新しく登場した) Zstandard が使え、クライアントの `Accept-Encoding` ヘッダーから自動的にネゴシエートされます。落とし穴は、`EnableForHttps = true` でオプトインしない限り HTTPS 上では何もしないことで、このオプトインには切り替える前に理解しておくべき実際のセキュリティリスクが伴います。この記事では全体の道筋を扱います。2 行のセットアップ、.NET 11 での Zstandard の追加、圧縮レベル、MIME タイプ、HTTPS の落とし穴、そして圧縮をリバースプロキシに任せるべきケースです。

ここでの内容はすべて .NET 11 (執筆時点で Preview 5、一般提供は 2026 年 11 月) を対象とし、`Microsoft.NET.Sdk.Web` と C# 14 を用います。`Microsoft.AspNetCore.ResponseCompression` middleware は ASP.NET Core 2.1 以降で安定しているため、Brotli と Gzip の部分は .NET 8、9、10 でも変更なく動作します。Zstandard プロバイダーだけが .NET 11 以降専用の要素です。

## 2 つの可動パーツ

レスポンス圧縮は共有フレームワークに含まれているため、インストールする NuGet パッケージはありません。サービスを登録し、middleware を追加します。

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression();

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/data", () => Enumerable.Range(0, 1000)
    .Select(i => new { Id = i, Name = $"Item {i}", Note = "some repeated text" }));

app.Run();
```

これが最初から最後までの完全な手順です。

1. `builder.Services.AddResponseCompression()` を呼び出して、middleware とその既定のプロバイダー (.NET 11 では Brotli、Gzip、Zstandard) を登録します。
2. レスポンスボディを書き込むあらゆる middleware より前に、パイプラインの早い段階で `app.UseResponseCompression()` を呼び出します。
3. API が HTTPS 上で提供される場合 (ほぼ常にそうです)、下のセキュリティのセクションを読んだうえで、オプションで `EnableForHttps = true` を設定します。
4. 提供する既定外の MIME タイプ (例えば `image/svg+xml`) を `ResponseCompressionOptions.MimeTypes` に追加します。
5. 既定 (最速) が望むトレードオフでない場合は、プロバイダーごとに圧縮レベルを調整します。
6. `Accept-Encoding` を送信するクライアントで検証し、レスポンスヘッダー `Content-Encoding` と `Vary` を確認します。

これが機能のすべてです。この記事の残りは、単にコンパイルを通すのではなく、各ステップを正しく行うことについてです。

## .NET 11 で変わること：Zstandard が組み込みになった

古い .NET バージョンでレスポンス圧縮をセットアップしたことがあるなら、体が「Brotli と Gzip」と覚えているでしょう。.NET 11 ではそのリストが増えました。Zstandard (エンコーディングトークン `zstd`、[RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878)) は、NuGet パッケージなし、P/Invoke なし、サードパーティのバインディングなしで `System.IO.Compression` スタックに組み込まれた、第一級の圧縮プロバイダーになりました。明示的なプロバイダーなしで `AddResponseCompression()` を呼び出すと、ASP.NET Core 11 は 3 つすべてを登録します。`BrotliCompressionProvider`、`GzipCompressionProvider`、`ZstandardCompressionProvider` です。

ネゴシエーションの順序も変わりました。.NET 10 以前では、middleware は Brotli を優先し、次に Gzip にフォールバックしていました。.NET 11 では優先順位は Zstandard が最初、次に Brotli、次に Gzip です。したがって、モダンなブラウザが `Accept-Encoding: gzip, deflate, br, zstd` を送信すると、ASP.NET Core 11 の API は `Content-Encoding: zstd` で応答するようになります。並べ替えの理由は、Zstandard が動的な API レスポンスにおいて速度と圧縮率のカーブ上でより良い点に達するからです。既定レベルでは同等の圧縮率で Brotli よりも大幅に速く圧縮し、Brotli と Gzip の両方よりも速く展開します。これはクライアントがモバイルデバイスや別のサービスであるときに重要です。

重要な運用上の帰結として、.NET 11 にアップグレードした後、あなたの API は 1 行も変えずに、`zstd` をアドバタイズするあらゆるクライアントに `zstd` を出し始めます。これはブラウザやモダンな HTTP クライアントには問題ありませんが、`zstd` のサポートを主張しながら実際にはそれをデコードできない古い内部コンシューマー (まれですが、手書きのクライアントで起こります) がある場合、壊れたボディが見えます。修正は圧縮をグローバルに無効化することではなく、次のセクションが示すようにプロバイダーのリストを制限することです。

## プロバイダーを明示的に選ぶ

プロバイダーを 1 つでも手で追加した瞬間、自動の既定はオフになります。これが最も多い落とし穴です。`options.Providers.Add<BrotliCompressionProvider>()` と書いて、なぜ Gzip が動かなくなったのかと悩むのです。プロバイダーを明示的に追加すると、リストに挙げたものだけがアクティブになります。

そこで、3 つすべてを維持しつつ HTTPS 圧縮を有効にするには次のようにします。

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
```

プロバイダーを追加する順序は、クライアントが複数を受け入れる場合のサーバーの優先順位です。優先させたいなら Zstandard を最初に、普遍的なフォールバックとして Gzip を最後に置きます。(例えばレガシーな CDN の構成に合わせて) Gzip のみを強制したい場合は、`GzipCompressionProvider` だけを追加し他は追加しないでください。そうすれば middleware は決して Brotli や Zstandard を出しません。

## 圧縮レベルと、既定が「最速」である理由

各プロバイダーの既定は `Optimal` ではなく `CompressionLevel.Fastest` です。これは、最初から可能な限り小さいボディを期待する人を驚かせます。既定は意図的なものです。リクエストごとに計算される動的なレスポンスでは、圧縮に費やす CPU はすべてのレスポンスのホットパス上にあるため、フレームワークはサイズの最後の数パーセントよりもレイテンシを優先します。`Optimal` と `SmallestSize` は、すでに小さい JSON に対して一桁パーセントの追加縮小のために数倍の CPU を要することがあります。

レベルはプロバイダーごとにそのオプションクラスを通じて設定します。

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize;
});
```

`CompressionLevel` 列挙型には 4 つの値があります。`NoCompression`、`Fastest`、`Optimal`、`SmallestSize` です。インタラクティブな API では、Zstandard と Brotli は `Fastest` のままにしてください。`Optimal` や `SmallestSize` は、一度圧縮して何度も提供するレスポンスのために取っておきます。純粋な API では、これは通常、リクエストごとに最適な圧縮を支払うより、圧縮済みのバイトを自分でキャッシュするほうが得だということを意味します。静的アセットも提供する場合、静的ファイルの圧縮は別の関心事 (ビルド時または CDN) であり、この middleware がリクエスト時に行うべきものではないことに注意してください。

Zstandard には独自の、より細かいつまみがあります。品質は 1 から 22 の範囲で、既定はレベル 3 あたりにあり、`ZstandardCompressionProviderOptions` を通じて設定します。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 6 // 1 to 22; higher = smaller output, slower
    };
});
```

品質が高いほどボディは小さく、CPU は多くなります。レベル 6 は、レスポンスが大きく反復的で (数千の類似オブジェクトを返すリストエンドポイントを思い浮かべてください)、CPU に余裕があるときに、既定から一段階上げる妥当な選択です。

## 見逃せない HTTPS のセキュリティの落とし穴

`EnableForHttps` は既定で `false` であり、この既定は見落としではなくセキュリティ上の決定です。攻撃者が影響を与えられる入力とシークレット (セッショントークン、CSRF トークン、口座番号) をボディで混ぜたレスポンスを TLS 上で圧縮することは、[CRIME](https://en.wikipedia.org/wiki/CRIME) と [BREACH](https://en.wikipedia.org/wiki/BREACH) 攻撃への扉を開きます。これらのサイドチャネル攻撃は、攻撃者が制御する入力を変化させたときに圧縮レスポンスのサイズがどう変わるかを観察して、シークレットを推測します。圧縮率はコンテンツに関する情報を漏らし、HTTPS 上でも暗号化されたボディのサイズは依然として観察可能です。

攻撃者が制御するクエリ値の隣にユーザーごとのシークレットを反映しない典型的な JSON API では、HTTPS 圧縮を有効にするのは普通で妥当なことであり、ほぼ誰もがそうしています。しかし、その判断は意図的に行うべきです。

- レスポンスがシークレットトークンを反映されたユーザー入力の隣にボディで埋め込むことが決してないなら、HTTPS 上で圧縮を有効にするのは低リスクです。
- 埋め込む可能性がある場合 (偽造防止トークンを含む HTML ページ、セッション識別子の隣に検索語を返すエンドポイント) は、有効にする前に緩和してください。偽造防止トークンを使い (ASP.NET Core での標準的な緩和策です)、信頼できない入力をシークレットを含むレスポンスに反映するのを避け、それら特定のエンドポイントでは圧縮を無効のままにすることを検討します。

`EnableForHttps` フラグはグローバルです。公開データのエンドポイントには圧縮が必要だが機密のものには不要な場合、最もきれいな分割は、パイプラインを分割して機密のエンドポイントを圧縮なしで実行するか、圧縮可能な MIME リストから意図的に外した `Content-Type` でそれらを提供することです。

もう 1 つの微妙な点として、`EnableForHttps = false` であっても、本番環境で `Content-Encoding` ヘッダーが見えることがあります。IIS、IIS Express、Azure App Service は、アプリとは独立に Web サーバー層で Gzip を適用できます。設定していない圧縮レスポンスが現れた場合は、middleware の不具合だと決めつける前に `Server` レスポンスヘッダーを確認してください。

## MIME タイプ：実際に圧縮されるもの

middleware は、`Content-Type` がそのリストに一致するレスポンスのみを圧縮します。既定は通常の API と Web のペイロードを網羅します。`application/json`、`application/javascript`、`application/xml`、`text/css`、`text/html`、`text/json`、`text/plain`、`text/xml` です。JSON API では `application/json` がリストにあるため、設定なしで圧縮が得られます。

既定の外にあるものを圧縮するには、`ResponseCompressionOptions.MimeTypes` に追加します。`text/*` のようなワイルドカードはサポートされていないため、各タイプを列挙します。

```csharp
// .NET 11, C# 14
using System.Linq;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "image/svg+xml", "application/manifest+json" });
});
```

PNG、JPEG、WebP、ZIP のようなすでに圧縮された形式を追加しないでください。これらはネイティブに圧縮されており、Brotli や Zstandard に通すと、同じサイズかわずかに大きいボディを生むために CPU を焼くだけです。同じことが非常に小さいレスポンスにも当てはまります。おおよそ 150 から 1000 バイト未満では、圧縮のオーバーヘッドが出力を入力より大きくすることがあるため、小さなレスポンスはタイプに関係なく圧縮する価値がありません。

## 順序：UseResponseCompression は早く置く

middleware の順序は、圧縮がそもそも機能するかどうかを決めます。圧縮はレスポンスストリームをラップすることで機能するため、`app.UseResponseCompression()` はレスポンスボディに書き込むあらゆる middleware より前に実行されなければなりません。別の middleware がすでに書き込みを始めていると、圧縮ラッパーはそれらのバイトを決して見ません。実際にはパイプラインの上のほうに置きます。

```csharp
// .NET 11, C# 14
var app = builder.Build();

app.UseResponseCompression();   // first, so it wraps everything below
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

圧縮が適用されるとき、middleware はキャッシュヘッダーについても自動的に正しい処理を行います。`Content-Length` を削除し (ボディの長さが変わったため)、`Content-MD5` を削除し (ハッシュがもはや有効でないため)、`Vary: Accept-Encoding` を追加して、キャッシュが圧縮版と非圧縮版を別々に保存するようにします。これらを手動で管理する必要はありません。

## middleware を完全に省くべき場合

レスポンス圧縮 middleware は、前段に何もない状態で Kestrel または HTTP.sys 上に直接ホストするときに正しいツールです。どちらのサーバーも組み込みの圧縮を提供しないからです。しかし API が IIS、Nginx、Apache、CDN の背後にある場合、リバースプロキシは通常、マネージドな middleware より速く圧縮でき、1 か所で行うほうが推論しやすくなります。Microsoft 自身のガイダンスは、利用可能ならサーバーベースの圧縮を優先することです。

プロキシが関わるときに注意すべき 2 つの罠があります。

- Nginx はリクエストを上流にプロキシするとき `Accept-Encoding` ヘッダーを削除し、ASP.NET Core の middleware が圧縮するのを静かに妨げます。middleware を Nginx の背後に置いたままにするなら、Nginx がヘッダーを保持するように構成するか、Nginx に圧縮を任せて middleware を外してください。
- 二重圧縮は無駄な作業であり、レスポンスを壊すことがあります。プロキシがすでに圧縮しているなら、同じコンテンツタイプに対して middleware を追加で実行しないでください。1 つの層を選びます。

サイドカープロキシのないコンテナ内で Kestrel から直接提供される minimal API では、middleware がまさに正解で、この記事の冒頭の 2 行のセットアップだけで十分です。成熟したプロキシや CDN の背後にあるものについては、まず計測してください。すでに設定していない圧縮が得られているかもしれません。

## カスタムプロバイダー、手短に

フレームワークが同梱していないエンコーディングが必要なら、`ICompressionProvider` を実装します。`EncodingName` プロパティは middleware が `Accept-Encoding` と照合するトークンで、`CreateStream` は圧縮するラッパーを返します。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

public sealed class CustomCompressionProvider : ICompressionProvider
{
    public string EncodingName => "mycustomcompression";
    public bool SupportsFlush => true;

    public Stream CreateStream(Stream outputStream)
    {
        // Wrap outputStream in your compression stream here.
        return outputStream;
    }
}
```

他のプロバイダーと同様に `options.Providers.Add<CustomCompressionProvider>()` で登録します。実際には、Zstandard が組み込みになった今、カスタムプロバイダーの必要性はほぼ蒸発しました。Zstandard、Brotli、Gzip の間で、.NET 11 は実際の HTTP クライアントが要求するあらゆるエンコーディングを網羅します。これこそ .NET 11 の変更の要点です。速くてモダンな選択肢が既定でオンになり、それを得るためにフレームワークの外へ手を伸ばす必要がもうなくなったのです。

## 関連記事

- [ASP.NET Core のエンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)：圧縮 middleware とストリーミングが競合しうる理由を説明します。
- [ASP.NET Core 11 の minimal API に出力キャッシュを追加する方法](/ja/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)：読み取りの多いエンドポイントで圧縮と好相性です。
- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)：一部のルートグループにだけ圧縮を効かせたいときに役立ちます。
- [ASP.NET Core 11 の minimal API エンドポイントから型付き Results 共用体を返す方法](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)：この middleware を通るレスポンス型を扱います。
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)：コールドスタート時の圧縮の CPU コストが気になるなら一読の価値があります。

## 出典

- [Response compression in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionOptions.EnableForHttps (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.responsecompression.responsecompressionoptions.enableforhttps)
- [CompressionLevel enum (API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.compressionlevel)
- [RFC 8878: Zstandard Compression](https://datatracker.ietf.org/doc/html/rfc8878)
- [CRIME attack (Wikipedia)](https://en.wikipedia.org/wiki/CRIME) / [BREACH attack (Wikipedia)](https://en.wikipedia.org/wiki/BREACH)
