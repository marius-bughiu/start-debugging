---
title: "ASP.NET Core 11 で Kestrel に HTTP/3 を配信させる設定方法"
description: "ASP.NET Core 11 で Kestrel の HTTP/3 を有効にするための完全ガイドです。HttpProtocols.Http1AndHttp2AndHttp3 によるエンドポイント設定、Windows / Linux / macOS における MsQuic のプラットフォーム要件、最初のリクエストが決して HTTP/3 にならない理由、HttpClient とミドルウェアによる確認方法、QuicTransportOptions のチューニング、そして黙ってフォールバックさせてしまうファイアウォールとプロキシの落とし穴を扱います。"
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "kestrel"
  - "http-3"
  - "performance"
lang: "ja"
translationOf: "2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Kestrel から HTTP/3 を配信するには、HTTPS エンドポイントに `listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3` を設定します。API としてはこれで全部です。その後に起きる問題はすべて環境側のものです。ホストに MsQuic がない、そのポートで UDP がブロックされている、QUIC が届く前にリバースプロキシが接続を終端している、あるいは HTTP/3 で開発用証明書を拒否するブラウザーでテストしている、といったものです。Kestrel はこれらのどれでも例外を投げません。HTTP/3 を無効にして HTTP/1.1 と HTTP/2 の配信を続けるので、`curl` の出力は設定を変える前とまったく同じに見えます。

この記事の内容はすべて .NET 11 (Preview 6、SDK `11.0.100-preview.6.26359.118` で検証) と `Microsoft.NET.Sdk.Web`、C# 14 を対象としています。Kestrel の HTTP/3 は .NET 7 以降で完全にサポートされているため、以下の設定は .NET 8、9、10 でもそのまま通用します。.NET 11 で本当に新しいのは、最後に扱う早期リクエスト処理だけです。

## 最初から最後までの 6 ステップ

1. HTTPS エンドポイントを設定し、`Protocols` に `HttpProtocols.Http1AndHttp2AndHttp3` を指定します。
2. ホストに MsQuic があることを確認します。つまり Windows 11 または Windows Server 2022 以降、あるいは Linux では `libmsquic` パッケージです。
3. 経路上のすべてのファイアウォールとセキュリティグループで、TLS ポートと同じ番号の UDP ポートを開けます。
4. `QuicListener.IsSupported` が false のときに目立つログを出す起動時チェックを追加し、依存関係の欠落が謎ではなくログ 1 行になるようにします。
5. ブラウザーではなく、バージョンを 3.0 に固定した `HttpClient` で確認します。
6. ミドルウェアで `HttpContext.Request.Protocol` をログ出力し、本番でクライアントが実際に何をネゴシエートしたかを確認できるようにします。

この記事の残りは、コードをコンパイルさせるだけでなく、各ステップを正しく行うための説明です。

## エンドポイントの設定

インストールする NuGet パッケージはありません。QUIC トランスポートである `Microsoft.AspNetCore.Server.Kestrel.Transport.Quic` は ASP.NET Core の共有フレームワークに含まれています。変更が必要なのはエンドポイントの宣言方法だけです。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.ListenAnyIP(5001, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listenOptions.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", (HttpContext ctx) => new { protocol = ctx.Request.Protocol });

app.Run();
```

このコードでは 2 つの点が実際の働きをしています。`UseHttps()` は省略できません。HTTP/3 は TLS 1.3 を必須とするため、TLS のないエンドポイントは h3 をネゴシエートできません。そして enum の値は `Http3` ではなく `Http1AndHttp2AndHttp3` です。Kestrel の既定値は `Http1AndHttp2` であり、本番で使いたいのは 3 プロトコルの値です。すべてのルーター、企業プロキシ、モバイルキャリアが QUIC をきれいに通すわけではないからです。`HttpProtocols.Http3` 単体ではフォールバック経路のないエンドポイントになります。MsQuic が利用できないホストでは Kestrel が HTTP/3 を無効にし、そのエンドポイントには配信できるものが何も残りません。

同じ設定は構成からも指定できます。再ビルドなしで環境ごとに HTTP/3 を有効にできるため、通常はこちらのほうが適した置き場所です。

```json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:5001",
        "Protocols": "Http1AndHttp2AndHttp3"
      }
    }
  }
}
```

すべてのエンドポイントに適用したい場合は `Kestrel:EndpointDefaults:Protocols` もあります。ここで多くの人がつまずく優先順位のルールに注意してください。`ConfigureKestrel` 内での明示的な `Listen` または `ListenAnyIP` の呼び出しは、`ASPNETCORE_URLS`、`--urls`、`launchSettings.json` の `applicationUrl` を上書きします。その際に Kestrel は警告 ("Overriding address(es)") をログに出しますが、見落とすとアプリがポート 7043 で動かなくなった理由を探して午後を丸ごと使うことになります。どちらか一方の仕組みだけを使ってください。

## プラットフォームごとの MsQuic の要件

ASP.NET Core は QUIC を自前で実装していません。`System.Net.Quic` は [MsQuic](https://github.com/microsoft/msquic) にバインドしており、対応プラットフォームの条件はこのネイティブライブラリからそのまま引き継がれます。

**Windows** では `msquic.dll` が .NET ランタイムの一部として配布されるためインストール作業はありませんが、OS は Windows 11 または Windows Server 2022 以降である必要があります。それより前の Windows には QUIC が必要とする暗号 API がなく、設定でどうにかすることはできません。これは Windows Server 2019 を使い続けている企業の配置先で HTTP/3 が有効にならない最も多い理由です。

**Linux** では `libmsquic` を自分でインストールする必要があります。Microsoft のパッケージリポジトリ `packages.microsoft.com` で公開されており、Alpine の community リポジトリにもあります。

```bash
# Debian / Ubuntu, after adding the packages.microsoft.com repo
sudo apt-get install libmsquic

# Alpine 3.21 and later
sudo apk add libmsquic
```

.NET 7 以降は libmsquic 2.2 以上が必要です。.NET 6 が固定していた 1.9.x 系には互換性がないため、.NET 6 プロジェクトから古い Dockerfile を引き継いでいる場合は取得しているバージョンを確認してください。これは、素の `mcr.microsoft.com/dotnet/aspnet` コンテナーイメージが標準では HTTP/3 を話**さない**ことも意味します。自分のイメージレイヤーにパッケージを追加する必要があります。`dotnet publish /t:PublishContainer` でイメージをビルドしている場合、これは SDK のコンテナープロパティだけでは表現できない追加の `RUN` であり、Dockerfile が必要になります。

**macOS** でのサポートは部分的かつ非公式です。`brew install libmsquic` は実行できますが、動的ローダーに Homebrew のプレフィックスを指定しないとランタイムはライブラリを見つけられません。

```bash
DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH:$(brew --prefix)/lib dotnet run
```

これはローカル開発のための便宜であって、サポートされた本番構成ではないと考えてください。

## 静かなフォールバックを騒がしくする

Kestrel のフォールバック動作は、Web サーバーの既定としては正しく、デバッグにとっては最悪です。MsQuic がなければ HTTP/3 は無効になり、アプリは普通に起動します。`Information` レベルの既定のログ出力では何も知らせてくれません。

対策は、`System.Net.Quic` が公開しているのと同じ `IsSupported` プロパティに対する 3 行の起動時チェックです。

```csharp
// .NET 11, C# 14
using System.Net.Quic;

var app = builder.Build();

if (!QuicListener.IsSupported)
{
    app.Logger.LogWarning(
        "QUIC is not supported on this host. HTTP/3 is disabled and Kestrel " +
        "will serve HTTP/1.1 and HTTP/2 only. Check for libmsquic and TLS 1.3 support.");
}
```

`QuicListener.IsSupported` は重要な 2 つの理由で false を返します。ネイティブライブラリが存在しない場合と、TLS 1.3 が使えない場合です。サーバー側では `QuicListener.IsSupported` を、クライアント側では `QuicConnection.IsSupported` を使ってください。現時点では同じ値を返しますが、自分の役割に合うほうを確認するのがドキュメントの推奨です。

さらに詳しく見たい場合は、Kestrel のカテゴリを `Debug` に上げてバインドの様子を観察します。

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Server.Kestrel": "Debug"
    }
  }
}
```

## 最初のリクエストが決して HTTP/3 にならない理由

ここは、設定が完璧に動いているのに壊れていると思わせてしまう部分です。

クライアントは接続前にサーバーが HTTP/3 を話すかどうかを知る手段がありません。それを広告する DNS レコードも TLS 拡張もないからです。検出はレスポンスヘッダー [`alt-svc`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Alt-Svc) を通じて行われます。クライアントは最初のリクエストを HTTP/1.1 または HTTP/2 で送り、h3 エンドポイントを示すヘッダーを見て、そのオリジンへの以降のリクエストで QUIC を使います。エンドポイントで HTTP/3 が有効なら Kestrel はこのヘッダーを自動的に付けるため、最初のレスポンスは次のようになります。

```text
HTTP/2 200
alt-svc: h3=":5001"
```

つまり単発のリクエストによるテストは必ず HTTP/2 を報告します。計測を行うなら、同じクライアントインスタンスで少なくとも 2 回リクエストを送る必要があり、そのクライアントは `alt-svc` を尊重するものでなければなりません。

IIS は知っておくべき例外です。IIS の背後でホストする場合、HTTP/3 は in-process モデルでサポートされますが、IIS は `alt-svc` を付けてくれません。パイプラインの早い段階で自分で付けます。

```csharp
// .NET 11, C# 14 - only needed when hosting behind IIS
app.Use((context, next) =>
{
    context.Response.Headers.AltSvc = "h3=\":443\"";
    return next(context);
});
```

IIS ではさらに Windows Server 2022 または Windows 11、`https` バインド、そして `EnableHttp3` レジストリキーの設定が必要です。また out-of-process ホスティングでは、HTTP/3 接続であっても `HttpRequest.Protocol` は `HTTP/1.1` を返します。IIS が Kestrel へリクエストをプロキシする際のプロトコルがそれだからです。`HTTP/3` を返すのは in-process モデルだけです。

## 実際に動いていることを確認する

ブラウザーは使わないでください。ブラウザーは HTTP/3 で自己署名証明書を拒否し、これには ASP.NET Core の開発用証明書も含まれます。したがってローカルのブラウザーテストは永遠に HTTP/2 を報告し、何の情報も与えてくれません。

バージョンを固定した `HttpClient` を使います。テストでは `RequestVersionExact` が適切です。黙ってダウングレードするのではなく、はっきり失敗するからです。

```csharp
// .NET 11, C# 14
using System.Net;

using var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version30,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
};

var response = await client.GetAsync("https://localhost:5001/ping");

Console.WriteLine($"status: {response.StatusCode}, version: {response.Version}");
// status: OK, version: 3.0
```

アプリケーションのコードでは逆のポリシーが必要です。バージョンを 1.1 にして `HttpVersionPolicy.RequestVersionOrHigher` を指定すれば、サーバーが広告したときにクライアントは HTTP/3 に上がり、広告しないときは穏やかに下がります。本番で `RequestVersionExact` に固定すると、ネットワークの一時的な不調が致命的な失敗になります。これは [「The SSL connection could not be established」として現れる TLS ハンドシェイクの失敗](/ja/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)と近い関係にあります。

サーバー側での確実な情報源は、ミドルウェア 1 行です。

```csharp
// .NET 11, C# 14
app.Use(async (context, next) =>
{
    app.Logger.LogInformation("Request served over {Protocol}", context.Request.Protocol);
    await next(context);
});
```

QUIC 接続では `HttpContext.Request.Protocol` は文字列 `"HTTP/3"` になります。これで分岐したい場合は、`Microsoft.AspNetCore.Http` の `HttpProtocol.IsHttp3(context.Request.Protocol)` を使えばリテラルをハードコードせずに済みます。ロールアウト後の 1 週間、この値をメトリクスのディメンションとして出力することが、トラフィックのどれだけが実際に h3 に乗ったかを知る唯一の誠実な方法であり、その割合はたいてい予想より低くなります。

## QuicTransportOptions のチューニング

トランスポートには独自のオプションオブジェクトがあり、`ConfigureKestrel` ではなく web host builder の `UseQuic` から設定します。

```csharp
// .NET 11, C# 14
builder.WebHost.UseQuic(options =>
{
    options.MaxBidirectionalStreamCount = 200;
    options.MaxUnidirectionalStreamCount = 20;
});
```

既定値は `MaxBidirectionalStreamCount` が 100、`MaxUnidirectionalStreamCount` が 10、`MaxReadBufferSize` が 1 MB、`MaxWriteBufferSize` が 64 KB、`Backlog` が 512 です。見直す価値があるのは双方向ストリーム数です。これは 1 接続あたりの同時リクエスト数の上限であり、QUIC にはヘッドオブラインブロッキングがないため、以前なら HTTP/2 接続を複数開いていたクライアントが、今はすべてを 1 本に流し込む可能性があります。おしゃべりなシングルページアプリケーションや gRPC クライアントを相手にしているなら、100 が天井になり得ます。

このブロックを `#pragma warning disable CA2252` で囲んだサンプルをコピーした場合、それは `System.Net.Quic` がプレビュー機能として出荷されていた時代の名残です。これらの API は .NET 9 で安定版になったため、通常はプラグマを外して構いません。

## 最も時間を奪う落とし穴

**UDP が開いていない。** QUIC は TLS エンドポイントと同じポート番号の UDP 上で動きます。経路上のすべてのファイアウォール、セキュリティグループ、ロードバランサーがそのポートの受信 UDP を許可している必要がありますが、既定のテンプレートの多くは TCP しか開きません。これが「自分のマシンでは動くのに Azure では動かない」の第 1 位の原因です。

**手前の何かが接続を終端している。** レイヤー 7 のロードバランサー、ingress コントローラー、CDN がクライアントと Kestrel の間にいる場合、HTTP/3 は*そちら*で有効にする必要があり、そのプロキシから Kestrel への区間はどのみち HTTP/1.1 であることが多いです。QUIC を転送しないプロキシの背後で Kestrel の h3 を有効にしても、何も変わりません。

**`UseHttps` の一部のオーバーロードは互換性がない。** HTTP/3 が絡むと、`HttpsConnectionAdapterOptions` の `HandshakeTimeout` と `OnAuthenticate` は何もしなくなり、ハンドシェイクタイムアウト付きの `ServerOptionsSelectionCallback` を受け取る `UseHttps` オーバーロードや `TlsHandshakeCallbackOptions` を受け取るオーバーロードは例外を投げます。ホスト名ごとに証明書を動的に選択している場合は、h3 を有効にする前にその経路を検証してください。

**測っているものが違う。** HTTP/3 の利点は、ハンドシェイクのラウンドトリップが少ないことと、パケットロス下でヘッドオブラインブロッキングが起きないことです。同じデータセンター内の 2 台のマシン間のような低レイテンシかつ無損失の接続では HTTP/2 と同じに見えますし、ループバックで走らせたベンチマークは何も示しません。実際のモバイル網や損失のある回線で測るか、そうでなければ測らないことです。ほとんどの API のレイテンシ予算はいまだにレスポンスサイズに支配されており、だからこそ[レスポンス圧縮](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)のほうがプロトコルのアップグレードより大きく安上がりな改善になるのが普通です。

## .NET 11 での変更点

.NET 11 より前の Kestrel は、リクエストストリームをディスパッチする前に、相手側の QUIC 制御ストリームと最初の `SETTINGS` フレームの受信を待っていました。これは新規接続のたびにおよそ 1 回分の論理ラウンドトリップを余分に消費するもので、まさに HTTP/3 が温まり済みの HTTP/2 接続に勝つべき場面でした。.NET 11 の Kestrel はリクエストストリームが届いた時点でディスパッチし、制御ストリームが追いついた時点で相手側の設定を適用します。設定する項目はなく、ハンドラーレベルのコード変更も不要です。アップグレードするだけで得られるワイヤーレベルの動作変更であり、[Kestrel の早期 HTTP/3 リクエスト処理](/ja/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)の記事でより詳しく扱っています。

覚えておくべき点が 1 つあります。Kestrel はレスポンスヘッダーをシリアライズする前に、相手側の最終的な `SETTINGS_MAX_FIELD_SECTION_SIZE` を依然として尊重します。最初のリクエストのレスポンスヘッダーを小さく保てば、効果を最大限に得られます。

新しいサービスを立ち上げていて、ホストのどこまでを明示的に設定するかを検討している場合、プロトコル設定は既定のホストではなく手組みのホストへ寄せる数少ないつまみの 1 つです。そのトレードオフは [CreateBuilder、CreateSlimBuilder、CreateEmptyBuilder の比較](/ja/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)で整理しています。

## 関連記事

- [.NET 11 で Kestrel が SETTINGS フレームより前に HTTP/3 リクエストの処理を開始する](/ja/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)
- [ASP.NET Core 11 の API にレスポンス圧縮を追加する方法](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Fix: HttpClient で The SSL connection could not be established](/ja/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)
- [dotnet publish /t:PublishContainer で .NET 11 アプリをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [ASP.NET Core 11 における WebApplication.CreateBuilder と CreateSlimBuilder と CreateEmptyBuilder](/ja/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## 参考資料

- [Use HTTP/3 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http3), Microsoft Learn
- [Configure endpoints for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints), Microsoft Learn
- [QUIC support in .NET, platform dependencies](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview#platform-dependencies), Microsoft Learn
- [Use HTTP/3 with HttpClient](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-http3), Microsoft Learn
- [Use ASP.NET Core with HTTP/3 on IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/http3), Microsoft Learn
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114), IETF
- [RFC 9000: QUIC, a UDP-based multiplexed and secure transport](https://www.rfc-editor.org/rfc/rfc9000), IETF
- [microsoft/msquic](https://github.com/microsoft/msquic), GitHub
