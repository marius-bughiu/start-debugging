---
title: "HttpClient vs HttpClientFactory vs Refit: .NET 11 ではどれを使うべきか"
description: "リクエストごとに HttpClient を new してはいけません。ライフタイム管理には IHttpClientFactory を使い、手書きのリクエストコードではなく型付きインターフェースが欲しいときに Refit を上に重ねます。素の singleton HttpClient は最も単純なケースでのみ妥当です。"
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "httpclient"
  - "httpclientfactory"
  - "refit"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/httpclient-vs-httpclientfactory-vs-refit"
translatedBy: "claude"
translationDate: 2026-05-23
---

まず理解すべきは、この三つは実際には競合関係にないということです。これらは同じスタックの三つの層です。`IHttpClientFactory` は `HttpClient` のライフタイムを管理し、Refit はそのファクトリの上で `HttpClient` の呼び出しを生成してくれます。ですから本当の問いは、スタックのどの高さに位置取りすべきかということです。2026 年の新しい .NET 11 コードでは、接続のライフタイムと DNS が正しく扱われるように、クライアントを **IHttpClientFactory** 経由で登録し、リクエスト構築コードを手書きするのではなく型付きインターフェースが欲しいときに **Refit** に手を伸ばしてください。素で長命な `HttpClient` の singleton は、最も単純な単一呼び出しのケースでのみ許容され、リクエストごとの `new HttpClient()` は常に誤りである唯一のパターンです。

ここでのすべての例は `<TargetFramework>net11.0</TargetFramework>` を対象とし、.NET 11 SDK と C# 14 を使用します。Refit はバージョン 10.1.6 (2026-03-21 リリース、NuGet の現行安定版) を指し、レジリエンスの部分は `Microsoft.Extensions.Http.Resilience` 10.6.0 を使用します。`IHttpClientFactory` は `Microsoft.Extensions.Http` にあり、これは ASP.NET Core と Worker の SDK に標準で付属します。

## 機能マトリクスを一目で

これがお目当ての表です。列はあなたが実際に HTTP 呼び出しを組み立てる三つの方法であり、行はどれを選ぶかを左右する判断材料です。

| 判断材料 | 素の HttpClient (singleton) | IHttpClientFactory | Refit (+ HttpClientFactory) |
| ------- | -------------------------- | ------------------ | --------------------------- |
| ソケット枯渇に対して安全 | はい、真の singleton であれば | はい | はい |
| DNS の変更を尊重する | `PooledConnectionLifetime` を使う場合のみ | はい、handler がローテーションする (既定で 2 分) | はい、ファクトリから継承 |
| DI 経由の handler パイプライン | 手動 | 第一級 (`AddHttpMessageHandler`) | 第一級、ファクトリから継承 |
| 組み込みのレジリエンス | 手作り | `AddStandardResilienceHandler` | `AddStandardResilienceHandler` |
| 名前付き / 型付きクライアント | いいえ | はい | はい、インターフェースがクライアントそのもの |
| あなたが書くリクエスト構築コード | すべて | すべて | なし、ビルド時に生成 |
| 強く型付けされたレスポンス | 手動でデシリアライズ | 手動でデシリアライズ | 自動 |
| Native AOT / trimming | はい | はい | はい、.NET 10+ では 9.0.2 以降 |
| 追加の NuGet 依存 | なし (標準) | ASP.NET Core ではなし | `Refit`, `Refit.HttpClientFactory` |
| 最適な用途 | 一つか二つの単純な呼び出し | ほとんどのサーバーサイドコード | 一つの API に対する多数の endpoint |

この表のパターンは、各列が左隣の列の安全性の保証を継承し、その上に使い勝手を重ねるというものです。右へ移動するコストは依存と少しの間接化であって、正しさではありません。

## 素の HttpClient が実際に問題ない場合

`HttpClient` を直接使ってはいけない、という根強い俗説があります。それは行き過ぎた修正です。アプリケーション全体で共有される単一の長命な `HttpClient` は、完全に妥当でよくサポートされたパターンです。危険だったのは `HttpClient` 自体ではなく、`using` ブロックの中でリクエストごとに新しいものを作ることであり、これは `TIME_WAIT` 状態のソケットをリークさせ、負荷の下でやがてポート範囲を枯渇させます。

静的な singleton はソケット枯渇を回避しますが、二つめのより微妙な問題を持ち込みます。`HttpClient` は接続を開くときにのみ DNS を解決し、長命なコネクションプールは決して再解決しません。対象ホストが新しい IP にフェイルオーバーすると、あなたの singleton は古い IP を叩き続けます。.NET Core および .NET 5+ での修正は、handler 上で接続のライフタイムを制限することです。

```csharp
// .NET 11, C# 14 - a singleton that still picks up DNS changes
using System.Net;

var handler = new SocketsHttpHandler
{
    // Recycle pooled connections so DNS failover is respected
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    AutomaticDecompression = DecompressionMethods.All
};

// Construct once, reuse for the entire process lifetime
var http = new HttpClient(handler)
{
    BaseAddress = new Uri("https://api.example.com")
};
```

これは、コンソールツール、小さな worker、あるいは DI コンテナを持たないライブラリで、一つか二つの endpoint に呼び出しを行う場合に使ってください。DI コンテナと数個を超えるクライアントを持った時点で、あなたは `IHttpClientFactory` を手で再実装していることになるので、立ち止まって本物を使うべきです。

## IHttpClientFactory が正しい既定である場合

2026 年のほとんどすべてのサーバーサイドコードにとって、`IHttpClientFactory` が基準線です。これは上記で説明したライフタイム管理をカプセル化するので、`PooledConnectionLifetime` や DNS のローテーションについて考える必要がありません。ファクトリは `HttpMessageHandler` のインスタンスをプールし、設定可能な間隔 (既定で 2 分) でローテーションするので、ソケットの再利用と DNS の新鮮さを同時に得られます。

より大きな利点はメッセージ handler のパイプラインです。横断的関心事 (認証ヘッダー、ロギング、相関 ID、リトライ) を `DelegatingHandler` のインスタンスとして DI に登録でき、ファクトリが構築するすべてのクライアントがそれらを順番に組み合わせます。型付きクライアントは、設定された `HttpClient` を特定のサービスクラスに束ねます。

```csharp
// .NET 11, C# 14 - typed client registered through the factory
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // Polly-backed retries, timeout, circuit breaker

public sealed class GitHubService(HttpClient client)
{
    public async Task<Repo?> GetRepoAsync(string owner, string name, CancellationToken ct)
    {
        // You still hand-write the path, the verb, and the deserialize
        return await client.GetFromJsonAsync<Repo>($"/repos/{owner}/{name}", ct);
    }
}

public record Repo(long Id, string FullName, int StargazersCount);
```

`AddStandardResilienceHandler` (`Microsoft.Extensions.Http.Resilience` 10.6.0 より) は、レートリミッター、リクエスト全体のタイムアウト、リトライ、サーキットブレーカー、試行ごとのタイムアウトを、妥当な既定値とともに積み重ねます。これは Polly のポリシーを手で配線することに代わる現代的な方法であり、たった一行です。追加してもなおタイムアウトが見られる場合、原因は handler 自体ではなく、たいてい誤って設定された試行ごとのタイムアウトであり、これは [TaskCanceledException、タスクがキャンセルされた](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) のよくある原因です。

ファクトリが唯一やってくれないのは、あなたのリクエストコードを書くことです。あなたは依然として呼び出しごとにパス、HTTP 動詞、クエリ文字列、デシリアライズを記述します。一つか二つの endpoint ならそれで問題ありません。三十個の endpoint を持つ REST API なら、それはほぼ同一の定型コードが三十メソッドになり、まさにそこが Refit の埋める隙間です。

## Refit がその依存に見合う場合

Refit は C# のインターフェースを動作する REST クライアントに変えます。属性で API の形を宣言すると、Refit のソースジェネレーターがビルド時に実装を出力します。呼び出しごとのリクエスト構築も手動のデシリアライズもありません。

```csharp
// .NET 11, C# 14, Refit 10.1.6 - the interface IS the client
using Refit;

public interface IGitHubApi
{
    [Get("/repos/{owner}/{name}")]
    Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default);

    [Get("/users/{user}/repos")]
    Task<IReadOnlyList<Repo>> GetUserReposAsync(string user, [Query] string sort = "updated");

    [Post("/repos/{owner}/{name}/issues")]
    Task<Issue> CreateIssueAsync(string owner, string name, [Body] NewIssue issue);
}

public record Repo(long Id, string FullName, int StargazersCount);
public record Issue(long Number, string Title);
public record NewIssue(string Title, string Body);
```

`Refit.HttpClientFactory` で同じファクトリのインフラに対して登録すれば、下の層のライフタイム、DNS、レジリエンスのすべての保証を保てます。

```csharp
// .NET 11, C# 14, Refit.HttpClientFactory 10.1.6
using Refit;
using Microsoft.Extensions.DependencyInjection;

builder.Services
    .AddRefitClient<IGitHubApi>()
    .ConfigureHttpClient(c =>
    {
        c.BaseAddress = new Uri("https://api.github.com");
        c.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
    })
    .AddStandardResilienceHandler(); // same resilience stack as a typed client
```

これがクライアントのすべてです。三つのインターフェースメソッドが、手書きの三メソッドにそのリクエスト構築とパースのロジックを加えたものを置き換えます。大きなサードパーティ API と話すコードベースにとって、読んで保守しなければならないコードの削減こそが、すべての論拠です。Refit は厄介な部分もうまく扱います。クエリ文字列には `[Query]`、シリアライズ付きの `[Body]`、認証には `[Header]` と `[Authorize]`、multipart アップロード、そしてデシリアライズされた本文だけでなくステータスコードとヘッダーが必要なときの `ApiResponse<T>` です。

2026 年向けの実務的な注意が二つあります。第一に、Refit 9.0.2 (2025 年 11 月) は .NET 10 以降に対して Native AOT と trimming のサポートを追加したので、Refit はもはや、リフレクション依存の重いクライアントのようには、trimming されたコンテナや scale-to-zero の関数から除外されません。AOT の経路では、シリアライザーがリフレクションフリーであり続けるように、`JsonSerializerContext` 経由でソース生成された `System.Text.Json` のメタデータを供給してください。これは [Native AOT vs ReadyToRun vs JIT in .NET 11](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) で扱われているのと同じ規律です。第二に、あなたの API が OpenAPI ドキュメントで記述されているなら、インターフェースを手書きする必要すらありません。ツールが仕様から Refit のインターフェースを出力でき、これは [OpenAPI 仕様から強く型付けされたクライアントを生成する](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) と重なります。

## オーバーヘッドは実際どれほどか

パフォーマンスについての正直な答えは、HTTP 呼び出しではネットワークが支配的であり、この三つの間の選択はノイズに埋もれる、ということです。実際の API への往復はミリ秒から数百ミリ秒で測られますが、リクエスト構築のオーバーヘッドはマイクロ秒で測られます。CPU を節約するために型付きクライアントより Refit を選ぶのは、間違った層を最適化することです。

とはいえ、オーバーヘッドはゼロではなく、それがどこに存在するかを知っておく価値はあります。

| 観点 | 素の / 型付きクライアント | Refit |
| ------ | ------------------ | ----- |
| 呼び出しごとのリクエスト構築 | 直接的、手書き | 生成、.NET 8+ ではほぼ直接的 |
| 実行時のリフレクション | なし | ソースジェネレーターによりなし |
| 起動コスト | なし | 生成されたスタブの一度きりの登録 |
| 呼び出しごとのアロケーション | ベースライン | 同等、属性のパースはビルド時 |

方法論上の要点は、Refit が Roslyn のソースジェネレーター (`InterfaceStubGenerator`) に移行したことで、インターフェースの解析が呼び出しごとではなくコンパイル時に行われるようになった、ということです。AOT が許容できなかった、かつてのリフレクションと `Reflection.Emit` のコストはなくなりました。自分自身のオブジェクトの形について実際の数値が欲しいなら、汎用的な数字を信じるのではなく、あなたの DTO に対して BenchmarkDotNet を走らせてください。ただし、型付きクライアントと Refit クライアントの差は、ミリ秒かかるネットワーク呼び出しに対して数十ナノ秒程度だと見込んでください。この判断は、あなたが保守するコードについてのものであって、あなたが費やすサイクルについてではありません。

## あなたの代わりに選んでくれる落とし穴

いくつかの制約が、好みが入り込む前に選択を片付けます。

**リクエストごとの `new HttpClient()` は決して答えではありません。** これは唯一の本当に誤ったパターンであり、三つの列すべてにとって誤りです。`HttpClient` が `IDisposable` で `using` を求めているように見えても、負荷の下でソケットを枯渇させます。一つだけ持ち帰るなら、これを持ち帰ってください。`HttpClient` は一度だけ構築するか、ファクトリに構築させるかであり、呼び出しごとには決して作らない。

**型付きクライアントを取り込む singleton はファクトリを台無しにします。** 型付きクライアントや Refit クライアントを登録してから singleton の中に取り込むと、一つの handler を永久に固定してしまい、ローテーションが止まり DNS の変更を見なくなります。これはまさにファクトリが解決するために存在する問題です。クライアントは使う場所で注入するか、`IHttpClientFactory` を注入してオンデマンドで作成してください。静的フィールドにしまい込んではいけません。

**Refit はレスポンスが契約に一致することを必要とします。** デシリアライズが自動なので、あなたの record に一致しないレスポンス (包んだエンベロープ、異なる大文字小文字、200 で返されたエラー本文) は、その場で扱うものではなくデシリアライズの失敗として表面化します。ステータスとヘッダーを調べる必要があるときは `ApiResponse<T>` を使い、シリアライザーは他の場所と同じように設定してください。これらのクライアントのテストも少し異なります。モックすべきメソッド本体がないからです。あなたは `HttpMessageHandler` をモックします。これは [HttpClient を使うコードをユニットテストする](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) のと同じ手法です。

**ライセンスはここでは要因になりません。** 2026 年の mapper や mediator をめぐる議論のいくつかとは異なり、三つの選択肢はすべて無償で寛容なライセンスです。`HttpClient` と `IHttpClientFactory` は .NET に付属し、Refit は MIT です。どれかへ、あるいはどれかから遠ざける商用の関門はありません。

## 結論を一行で

2026 年の新しい .NET 11 コードでは、ライフタイム、DNS、レジリエンスを任せられるように `IHttpClientFactory` を既定とし、一つの API に対して多数の endpoint を呼び出していてリクエストコードを手書きではなく生成させたいときに Refit を上に重ねてください。素の `HttpClient` は本当に単純なケース (`PooledConnectionLifetime` 付きの singleton、一つか二つの呼び出し、DI なし) のために取っておき、リクエストごとには決して作らないこと。これらは選び合う三つの競合ライブラリではありません。一つのはしごの三つの段であり、あなたは、HTTP の配管のうちどれだけを自分で書くのをやめたいかに合った段まで登るのです。

## 関連記事

- [.NET 11 で OpenAPI 仕様から強く型付けされたクライアントを生成する方法](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [HttpClient を使うコードをユニットテストする方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: HttpClient で TaskCanceledException、タスクがキャンセルされた](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [System.Text.Json vs Newtonsoft.Json (2026 年)](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## 参照元

- [Use IHttpClientFactory to implement resilient HTTP requests](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) - 名前付きおよび型付きクライアント、handler のライフタイム、メッセージ handler のパイプライン。
- [HttpClient guidelines for .NET](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) - ソケット枯渇、DNS、singleton 向けの `PooledConnectionLifetime` パターン。
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler` と標準レジリエンススタック。
- [Refit on GitHub](https://github.com/reactiveui/refit) - ソースジェネレーター、属性リファレンス、`Refit.HttpClientFactory` の統合。
- [Refit.HttpClientFactory 10.1.6 on NuGet](https://www.nuget.org/packages/refit.httpclientfactory) - 現行安定版と対象フレームワーク。
