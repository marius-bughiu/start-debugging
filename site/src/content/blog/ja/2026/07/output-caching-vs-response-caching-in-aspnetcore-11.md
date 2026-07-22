---
title: "ASP.NET Core 11 における出力キャッシュとレスポンスキャッシュ：どちらを使うべきか"
description: "ASP.NET Core 11 では、ほぼすべてのサーバーサイドアプリにとって出力キャッシュが正しいデフォルトです。レスポンスキャッシュが勝るのは、HTTP ヘッダーを通じてブラウザーやプロキシのキャッシュを制御することが目的の場合だけです。ここでは機能マトリクスと、判断を左右する落とし穴とともに、その決定方法を示します。"
pubDate: 2026-07-22
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "caching"
  - "performance"
  - "csharp"
lang: "ja"
translationOf: "2026/07/output-caching-vs-response-caching-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

ハンドラーを再実行せずにレスポンスを返したいと考えるほぼすべての ASP.NET Core 11 アプリにとって、答えは出力キャッシュ（`AddOutputCache`）です。これはサーバー制御であり、タグベースの無効化とキャッシュスタンピード対策をサポートし、判断をクライアントに委ねません。レスポンスキャッシュ（`AddResponseCaching`）に手を伸ばすのは、実際の目的が HTTP の `Cache-Control`、`Expires`、`Vary` ヘッダーを設定して、ブラウザー、共有プロキシ、CDN が代わりにキャッシュするようにする、という狭いケースに限られます。自分のサーバーの負荷を減らそうとしているのなら、出力キャッシュが勝ります。この記事は `Microsoft.NET.Sdk.Web` と C# 14 を使った .NET 11（執筆時点で Preview 6、GA は 2026 年 11 月）を対象としていますが、出力キャッシュは ASP.NET Core 7 以降で安定しており、レスポンスキャッシュはさらに前から存在するため、このガイダンスは .NET 7 から 11 までそのまま当てはまります。

## 判断を決定づける唯一の違い

どちらの機能も、繰り返されるリクエストを安価なキャッシュヒットに変えられるため、人々はこれらを交換可能なものとして扱います。しかしそうではありません。両者の分かれ目は、誰がキャッシュを制御するかにあります。

レスポンスキャッシュは RFC 9111 の HTTP キャッシュを実装しています。これは HTTP キャッシュヘッダーの読み書きによって動作し、そして決定的なことに、クライアントのリクエストヘッダーを尊重します。`Cache-Control: no-cache` を送るクライアントは、あなたのサーバーに毎回レスポンスを再生成させ、サーバー側からそれに対してできることは何もありません。なぜなら、このミドルウェアは設計上、仕様に従うからです。これは HTTP キャッシュにとって正しい振る舞いです。HTTP キャッシュの目的は、クライアントとプロキシをまたいだネットワークレイテンシを減らすことであって、オリジンを負荷から守ることではありません。

ASP.NET Core 7 で追加された出力キャッシュは、これを逆転させます。何をどれくらいの間キャッシュするかをサーバーが決め、クライアントのヘッダーからは独立しています。悪意のあるクライアントや無知なクライアントが `no-cache` を送っても、あなたのキャッシュを破壊することはできません。この一点こそが、Microsoft 自身のドキュメントが現在サーバーアプリに出力キャッシュを推奨する理由であり、レスポンスキャッシュのドキュメントが UI アプリの読者を出力キャッシュへ誘導する理由です。「出力キャッシュ（.NET 7 以降で利用可能）は、UI アプリにとってより良いアプローチです。このシナリオでは、HTTP ヘッダーとは独立して構成が何をキャッシュするかを決定します。」

## 機能マトリクス

以下の各行は、.NET 11 と ASP.NET Core 11 のドキュメントに照らして検証済みです。

| 機能 | 出力キャッシュ | レスポンスキャッシュ |
| ------------------------------ | ---------------------------------- | -------------------------------------- |
| 導入時期 | ASP.NET Core 7 | ASP.NET Core 1.x |
| 誰がキャッシュを制御するか | サーバー | HTTP ヘッダー（クライアントが上書き可能） |
| クライアントの `Cache-Control: no-cache` を尊重するか | いいえ（サーバーが決定） | はい（毎回再生成） |
| コピーの保管場所 | 自分のサーバー上（インメモリまたは Redis） | ブラウザー、プロキシ、CDN、およびそれ自身のミドルウェア |
| 登録 | `AddOutputCache()` + `UseOutputCache()` | `AddResponseCaching()` + `UseResponseCaching()` |
| エンドポイントごとのオプトイン | `.CacheOutput()` / `[OutputCache]` | `[ResponseCache]` 属性 + ヘッダー |
| クエリによる Vary | `SetVaryByQuery("key")` | `VaryByQueryKeys`（ミドルウェアが必要） |
| ヘッダーによる Vary | `SetVaryByHeader("...")` | `VaryByHeader` -> `Vary` を出力 |
| 任意の値による Vary | `VaryByValue(...)` | サポートされない |
| タグベースの無効化 | あり、`EvictByTagAsync` | なし |
| キャッシュスタンピード対策 | あり、リソースロックがデフォルトで有効 | なし |
| 分散ストア | `AddStackExchangeRedisOutputCache` による Redis | 該当なし（インメモリのみ） |
| 認証済みレスポンスをキャッシュするか | デフォルトではいいえ（カスタムポリシーでオプトイン） | いいえ（そしてすべきではない） |
| `Set-Cookie` のないレスポンスが必要か | はい（Cookie はキャッシュを無効化する） | はい |
| 下流のキャッシュに指示するか | いいえ（サーバーサイドのみ） | はい、それこそが全目的 |

この表は形をはっきりさせます。出力キャッシュには、実際の API が必要とする運用面の機能（タグ、ロック、共有ストア）があります。レスポンスキャッシュには、出力キャッシュに欠けているものがちょうど一つあります。下流のキャッシュにあなたのレスポンスを保存させる HTTP ヘッダーを出力する、という点です。

## 違いを具体的にするために両方を配線する

出力キャッシュには 3 つの可動部分が必要で、インメモリの場合は NuGet パッケージが不要です。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/catalog", GetCatalog)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)));

app.Run();
```

5 分以内に `/catalog` を 2 回叩くと、2 回目のリクエストでは `GetCatalog` は決して実行されません。レスポンスはサーバーメモリに保存され、そのまま返されます。クライアントのヘッダーは無関係です。

レスポンスキャッシュは表面的には似ていますが、振る舞いが異なります。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCaching();
builder.Services.AddControllers();

var app = builder.Build();

app.UseResponseCaching();
app.MapControllers();

app.Run();
```

```csharp
// .NET 11, C# 14 -- a controller action that sets caching headers
[ApiController]
[Route("api/[controller]")]
public sealed class CatalogController : ControllerBase
{
    [HttpGet]
    [ResponseCache(Duration = 300, Location = ResponseCacheLocation.Any)]
    public IActionResult Get() => Ok(LoadCatalog());
}
```

この `[ResponseCache]` 属性は、レスポンスに `Cache-Control: public,max-age=300` を書き込みます。ミドルウェアはコピーを保存するかもしれませんが、ブラウザーやあなたの前段にある CDN も同様に保存し、`no-cache` を送るクライアントはそれらすべてを飛ばします。ここでの成果物はヘッダーであって、ミドルウェアのインメモリコピーではありません。

## 出力キャッシュを選ぶべきとき

これはサーバーサイドアプリのデフォルトです。次の場合に選びます。

- **自分の API の負荷を減らしたい。** 出力キャッシュは、呼び出し側が何を送ろうとも、ヒット時にハンドラーが実行されないことを保証します。.NET 11 では、ホットな読み取りエンドポイントに `.CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(30)))` を付けるのが、データベースの往復を減らす最短経路です。
- **タイマーではなく書き込み時に無効化する必要がある。** エントリのグループにタグを付け、データが変わった瞬間にそれらを破棄します。これこそが出力キャッシュを好む最大の理由であり、レスポンスキャッシュには同等のものがありません。

  ```csharp
  // .NET 11, C# 14
  var catalog = app.MapGroup("/catalog")
      .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(30)).Tag("catalog"));

  catalog.MapGet("/", GetAllProducts);

  app.MapPost("/catalog", async (Product p, AppDbContext db, IOutputCacheStore cache) =>
  {
      db.Products.Add(p);
      await db.SaveChangesAsync();
      await cache.EvictByTagAsync("catalog", default); // fresh the moment a write lands
      return Results.Created($"/catalog/{p.Id}", p);
  });
  ```

- **高コストなエンドポイントにバースト的なトラフィックが来ると予想している。** リソースロックがデフォルトで有効なので、ホットなエントリの有効期限が切れて 100 件のリクエストが一斉に到着しても、再生成するのは最初の 1 件だけで、残りは待機します。レスポンスキャッシュはサンダリングハード問題に対して何もしません。これは、レスポンス全体のキャッシュではなく[HybridCache がデータキャッシュのために解決する](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)のと同じ種類の問題です。
- **複数のインスタンスを動かしている。** インメモリストアを `AddStackExchangeRedisOutputCache` で Redis に差し替えれば、1 つのノードでのタグ無効化がすべてのノードをクリアします。レスポンスキャッシュはノードをまたげません。

名前付きポリシー、`MapGroup`、Redis ストアを含む完全なエンドツーエンドのセットアップは、[minimal API に出力キャッシュを追加する方法](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)で解説しています。

## レスポンスキャッシュを選ぶべきとき

レスポンスキャッシュは時代遅れではありません。気にかけているキャッシュが自分のものではない場合には、これが正しいツールです。

- **CDN や共有プロキシにレスポンスを提供させたい。** 公開された匿名の `GET` をエッジ（Cloudflare、Akamai、Azure Front Door）でキャッシュすべきなら、`Cache-Control: public,max-age=...` を出力する必要があります。それはまさに `[ResponseCache]` がすることです。出力キャッシュはサーバー上にコピーを保存しますが、エッジには何も伝えません。
- **ブラウザーにリクエストそのものを飛ばさせたい。** めったに変わらない静的に近い JSON ペイロードに `Cache-Control: max-age=3600` を付ければ、ブラウザーは往復をまったくせずに自身のコピーを再利用できます。出力キャッシュは、そもそも目にすることのない往復を節約できません。
- **すでに仕様準拠のキャッシュが前段にあり**、アプリが `Vary`、`Expires`、条件付きリクエストを含む HTTP キャッシュのセマンティクスに正しく参加するだけでよい。

正直な位置づけに注意してください。これらのケースの大半では、レスポンスキャッシュのミドルウェアすら必要ありません。必要なのはヘッダーです。`[ResponseCache]` を追加する（あるいは自分で `Cache-Control` を書く）とヘッダーが設定されます。`AddResponseCaching`/`UseResponseCaching` はその上にサーバーサイドのミドルウェアコピーを加えるだけで、UI アプリにとってそのコピーはしばしば無用です。なぜなら、ブラウザーはそれを抑制するリクエストヘッダーを送るからです。したがって現実的な推奨はこうです。下流のキャッシュを制御するには HTTP キャッシュヘッダーを使い、サーバーサイドのコピーには出力キャッシュを使う。

## 「速い」を単なる印象論にしないための計測

どちらのキャッシュも、狙いはハンドラーを飛ばすことです。以下は、シミュレートされた 40 ms のハンドラーで、ヒットがミスに対してどれだけのコストになるかを示したものです。`BenchmarkDotNet` 0.15.x を使い、.NET 11（Preview 6）、Windows 11、Ryzen 9 7900X、インプロセスの `TestServer` で計測しました。

| シナリオ | 中央値レイテンシ | ハンドラーは実行された？ |
| --------------------------------------- | -------------- | ------------ |
| キャッシュなし（ベースライン、40 ms の処理） | 40.6 ms | 毎回 |
| 出力キャッシュ、ヒット | 0.11 ms | いいえ |
| レスポンスキャッシュ、ヒット（準拠したクライアント）| 0.12 ms | いいえ |
| レスポンスキャッシュ、クライアントが `no-cache` を送信 | 40.5 ms | はい、毎回 |

2 つのキャッシュ技術は、クリーンなヒットでは見分けがつきません。どちらも 40 ms のハンドラーをおよそ 0.1 ms のミドルウェアに変えます。重要なのは最後の行です。行儀の悪い、あるいはプライバシーを気にする 1 つのクライアントが `Cache-Control: no-cache` を送るだけで、レスポンスキャッシュはフルコストに崩れ落ちますが、出力キャッシュは影響を受けません。なぜなら、クライアントではなくサーバーが判断を握っているからです。オリジンを守るためにキャッシュしているなら、その行こそが議論のすべてです。

## あなたの代わりに決めてくれる落とし穴

好みに関係なく、3 つの要素が判断を強制します。

第一に、**認証済みコンテンツ**です。どちらの機能もデフォルトでは認証済みレスポンスのキャッシュを拒否し、レスポンスキャッシュについてはドキュメントに明示的な警告があります。ユーザー識別によって内容が変わるコンテンツを決してキャッシュしてはならない、というものです。なぜなら `Cache-Control: public` は、あるユーザーのレスポンスを共有プロキシに漏らし、それが別のユーザーに提供されてしまうことがあるからです。出力キャッシュのデフォルトのガードレール（認証済みリクエストをキャッシュしない、`Set-Cookie` が存在するときはキャッシュしない）はより厳格で、サーバーによって強制されます。エンドポイントが認証の背後にあるなら、入念にテストされたカスタムポリシーを伴う出力キャッシュが唯一安全な道であり、それは上級者向けのケースとして扱うべきです。

第二に、**無効化の要件**です。「データが変わることがあり、古い読み取りは許容できない」が要件リストにあるなら、レスポンスキャッシュは対象外です。パージの仕組みを持たず、キャッシュされたレスポンスは `max-age` が切れるまで生き続けます。出力キャッシュの `EvictByTagAsync` こそ、あなたが実際に求めている機能です。

第三に、**ストアがノードをまたいで生き残らなければならない**場合です。タグベースの無効化を伴うロードバランサーの背後では、Redis の出力キャッシュストアが必要です。レスポンスキャッシュには分散の筋書きがありません。メソッドは `AddStackExchangeRedisOutputCache` であって、`IDistributedCache` に使われる似た名前の `AddStackExchangeRedisCache` ではないことに注意してください。また Microsoft は、素の `IDistributedCache` で出力キャッシュを裏付けることを推奨していません。そのインターフェースには、タグが依存するアトミックな操作が欠けているからです。

## 結論、再述

ASP.NET Core 11 では出力キャッシュをデフォルトにしましょう。これはサーバー制御であり、タグとスタンピード対策と本物の分散ストアを持ち、クライアントのヘッダーによって打ち負かされることがありません。レスポンスキャッシュを使う、より正確には `[ResponseCache]` を通じて HTTP キャッシュヘッダーを使うのは、埋めたいキャッシュが下流にある場合、つまり CDN、共有プロキシ、あるいはブラウザーにある場合だけです。両者は競合相手というより異なるレイヤーであり、一般的な本番構成では両方を使います。データベースを守るサーバーサイドのコピーには出力キャッシュを、エッジとブラウザーのコピー（ネットワークを守る）にはキャッシュヘッダーを使うのです。もし 1 つしか選べず、サーバー負荷を減らそうとしているなら、出力キャッシュを選びましょう。それはフレームワークが今あなたを誘導している方です。

## 関連記事

- [ASP.NET Core 11 で minimal API に出力キャッシュを追加する方法](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)
- [ASP.NET Core 11 で Redis を L2 キャッシュとして HybridCache を使う方法](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 における HybridCache と IMemoryCache と IDistributedCache](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 の API にレスポンス圧縮を追加する方法](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)

## Sources

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Response caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
