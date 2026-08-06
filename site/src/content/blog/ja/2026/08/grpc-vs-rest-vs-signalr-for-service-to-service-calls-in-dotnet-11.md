---
title: ".NET 11 のサービス間呼び出しにおける gRPC vs REST vs SignalR"
description: ".NET 11 の内部サービス間呼び出しでは、契約の両端を自分たちで所有していて呼び出しがポイントツーポイントであれば、既定で gRPC を選んでください。自分たちが管理していないものがそのサービスを呼び出す必要が出た時点で、JSON を使う REST に切り替えます。SignalR はサービス間の RPC トランスポートではありません。1 つの生産者が多数の長寿命な消費者へメッセージを配信する必要がある場合にのみ使ってください。"
pubDate: 2026-08-06
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "grpc"
  - "signalr"
  - "csharp"
lang: "ja"
translationOf: "2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-06
---

サービス A がサービス B を呼び出し、他に B を呼び出すものが存在しないなら、gRPC を使ってください。両端を自分たちで所有しているので、生成されたクライアントとバイナリ契約のコストは実質ゼロであり、JSON 相当のおよそ半分のサイズのペイロードと、本物のデッドライン伝播が手に入ります。自分たちが管理していないものがそのサービスを呼び出す必要が出た時点で、JSON を使う REST に切り替えてください。ブラウザー、取引先、運用手順書の中の curl コマンドなどです。SignalR はこの中で異質な存在であり、この比較で最も多い誤りは、SignalR を 3 つ目の RPC の選択肢として扱ってしまうことです。そうではありません。SignalR は接続管理と配信のレイヤーであり、1 つの生産者が多数の長寿命な消費者へプッシュする必要がある場合にのみ、その居場所を得ます。以下の内容はすべて .NET 11 (Preview 6、SDK `11.0.100-preview.6.26359.118`、GA は 2026 年 11 月予定) と C# 14、`Grpc.AspNetCore` 2.83.0 を対象としています。

## 判断を 1 つの表で

| 項目 | gRPC | JSON を使う REST | SignalR |
| --- | --- | --- | --- |
| 呼び出しの形 | ポイントツーポイントの RPC | ポイントツーポイントのリクエスト/レスポンス | 1 つの生産者、多数の消費者 |
| 契約 | 必須、`.proto` | 任意、OpenAPI | なし、メソッド名は文字列 |
| プロトコル | HTTP/2 (必須) | HTTP/1.1、HTTP/2、HTTP/3 | WebSockets、SSE、ロングポーリング |
| ペイロード | Protobuf、バイナリ | JSON、テキスト | JSON または MessagePack |
| クライアント | `.proto` から生成 | 手書きまたは OpenAPI から生成 | 手書き、メソッド名は文字列 |
| ストリーミング | クライアント、サーバー、双方向 | サーバー (chunked / SSE) | サーバー、クライアント、双方向 |
| 呼び出し側のキャンセルが呼び出され側に届くか | はい、加えてネイティブなデッドラインあり | 接続の中断としてのみ | .NET 11 以降ははい、ストリーミングでない呼び出しについて |
| ブラウザーから呼び出せるか | いいえ、gRPC-Web またはトランスコーディングが必要 | はい | はい、それが本来の用途 |
| L4 ロードバランサーの背後で動くか | うまく動かない | はい | スティッキーセッションまたはバックプレーンが必要 |
| 通信内容が人間に読めるか | いいえ | はい | JSON なら読める、MessagePack なら読めない |
| ASP.NET Core に同梱されるか | いいえ、別配布の NuGet パッケージ | はい | はい |

現実のケースのほとんどは 2 つの行で決まります。「呼び出しの形」が SignalR を他の 2 つから分け、「契約」が gRPC を REST から分けます。表の下のほうの行を天秤にかけているなら、おそらくすでに判断は済んでいて、後押しを探しているだけです。

## SignalR がこの比較に登場し続ける理由と、たいてい負ける理由

SignalR がサービス間通信の検索に現れるのは、ハブメソッドが RPC そのものに見えるからです。

```csharp
// .NET 11, C# 14 -- looks like RPC, is not built for it
public sealed class PricingHub : Hub
{
    public Task<decimal> GetPrice(string sku) => _pricing.LookupAsync(sku);
}
```

呼び出し側は別のサービスから `InvokeAsync<decimal>("GetPrice", sku)` を実行して答えを得ることが確かにできます。動きはします。しかしそこで作られたものは、来ては去るクライアントの接続ライフタイム管理を設計の中心にすえた技術の上に載せた RPC チャネルです。その設計の利点をまったく必要としないまま、コストだけを引き継ぐことになります。

具体的なコストは次のとおりです。メソッド名はディスパッチ時にリフレクションで解決される文字列なので、名前の変更はビルドエラーではなく実行時の失敗になります。スキーマがないため、クライアントを生成するものも、ペイロードの形を検証するものもありません。スケールアウトするにはプール内のすべてのサーバーがすべての接続に到達できる必要があり、Redis バックプレーンか Azure SignalR Service が必要になります。WebSockets を使っていない場合はさらにスティッキーセッションも必要です。そしてハブ接続はステートフルです。以前はステートレスなリクエストだったものについて、呼び出し側は再接続の状態機械を考慮しなければならなくなります。

トラフィックが本当に多数への配信であるとき、SignalR は正しい答えです。40 個のワーカープロセスに価格更新をプッシュしなければならない価格サービスは SignalR の問題です。SignalR にはグループ、ブロードキャスト、バックプレーンがあり、gRPC にはそのどれもないからです。Microsoft 自身の [gRPC と HTTP API の比較](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison)がこれを直接述べています。gRPC はストリーミングをサポートしますが、登録された接続へブロードキャストするという概念を持たないため、各 gRPC 呼び出しがそれぞれのクライアントへ個別にストリーミングする必要があります。

区別されるのは多数への配信であって、「リアルタイム」かどうかではありません。gRPC の双方向ストリーミングはリアルタイムです。ただポイントツーポイントであるだけです。

## それぞれが実際に通信路へ載せるもの

gRPC を推すパフォーマンスの主張は、たいてい数字を伴わずに「Protobuf は JSON より小さい」と語られます。典型的な内部レスポンスの形をしたメッセージについて、その数字を示します。

```protobuf
// proto3
message OrderStatus {
  string order_id   = 1;  // "8f14e45f-ceea-467a-9c1d-2b7f2f0c3a11"
  int32  status     = 2;  // 3
  int64  updated_at = 3;  // 1786060800
  double total      = 4;  // 129.95
  string currency   = 5;  // "EUR"
}
```

| エンコーディング | メッセージのバイト数 | フレーミング込みのバイト数 | JSON 比 |
| --- | --- | --- | --- |
| JSON (`System.Text.Json`、既定のオプション) | 116 | 116 | 100% |
| MessagePack (SignalR のバイナリハブプロトコル) | 66 | 該当なし | 56.9% |
| Protobuf (`Google.Protobuf` 3.35.1) | 60 | 65 | 51.7% |
| SignalR の JSON ハブプロトコルの呼び出し | 該当なし | 165 | 142% |

**測定方法**: 同じ 5 つのフィールドを各エンコーディングでシリアル化してバイト数を数えました。測定環境は Windows 11、.NET 10.0.5 ランタイム (SDK 10.0.201)、`Google.Protobuf` 3.35.1、`MessagePack` 3.1.8 です。通信フォーマットはランタイムのバージョンとは独立に仕様化されているため、.NET 11 でもバイト数は同一で、異なるのはエンコードを行うランタイムだけです。「フレーミング込みのバイト数」には、gRPC の 5 バイトの長さプレフィックス (圧縮フラグ 1 バイトとビッグエンディアンの長さ 4 バイト) を加え、SignalR については JSON の呼び出しエンベロープとレコード区切り文字 `0x1E` を加えています。

この表を何かの根拠に使う前に、よく読んでください。Protobuf は 116 バイトのメッセージで 56 バイトを節約します。毎秒 1 万件の呼び出しを処理するサービスなら 560 KB/s の送信量であり、ゾーン間トラフィックに課金されているなら重要で、そうでなければ誤差です。興味深いのは SignalR の行です。JSON ハブプロトコルのエンベロープにより、1 回の呼び出しは素の REST 相当よりも*大きく*なります。ペイロードに加えて `type`、`target`、`arguments` の分を支払うからです。ハブを MessagePack に切り替えればその大半は取り戻せますが、そもそもテキストプロトコルを検討した理由であった人間可読性を失います。

シリアル化サイズは gRPC の利点の中で最も弱いものでもあります。より強いのは、生成されるクライアントとデッドラインです。

## gRPC を選ぶとき

- **内部のポイントツーポイントで、両方のリポジトリを所有している場合。** `.proto` ファイルが契約であり、両側がそこからコードを生成し、フィールド名を変えれば同じ pull request の中で両側のビルドが壊れます。これが議論のすべてであり、バイト数よりも価値があります。
- **呼び出され側まで届くデッドラインが必要な場合。** gRPC のデッドラインは呼び出しとともに伝わるため、サービス B はサービス A があとどれだけ待つ意思があるかを知り、自分のデータベースクエリを打ち切れます。HTTP に相当するものはありません。`HttpClient` のリクエストをキャンセルすると接続が中断され、サーバーは `HttpContext.RequestAborted` を観測しますが、元の時間予算をサーバーに伝えるものは何もありません。
- **複数言語の呼び出し側がいる場合。** あなたの `.proto` を利用する Go や Python のサービスは、本物のクライアントを無償で得られます。同じチームに OpenAPI ドキュメントを渡して幸運を祈るのは、より悪い体験です。
- **やり取りの多いホットパス。** 双方向ストリームがいったん開けば、メッセージは既存の HTTP/2 リクエストに乗るため、呼び出しごとに新しいリクエストの代価を払う必要がなくなります。Microsoft の [gRPC のパフォーマンスガイド](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance)は、これを高スループットなパス向けの高度な手法として明示的に推奨しつつ、`RequestStream.WriteAsync` はスレッドセーフではなく、書き込みを整列させるために `Channel<T>` が必要だと注意しています。

```csharp
// .NET 11, C# 14 -- Grpc.AspNetCore 2.83.0
// Server
builder.Services.AddGrpc();
app.MapGrpcService<OrderService>();

// Client: register through the factory so channels are reused.
builder.Services
    .AddGrpcClient<Orders.OrdersClient>(o => o.Address = new Uri("https://orders"))
    .AddStandardResilienceHandler();

// Call site: the deadline is the point.
var reply = await client.GetStatusAsync(
    new OrderRequest { OrderId = id },
    deadline: DateTime.UtcNow.AddSeconds(2),
    cancellationToken: ct);
```

アプリケーションコードでは `GrpcChannel.ForAddress` ではなく `AddGrpcClient` を使ってください。呼び出しごとにチャネルを作ると、そのたびに新しいソケット、TCP ハンドシェイク、TLS ネゴシエーション、HTTP/2 接続プリアンブルが強制されますが、ファクトリーはチャネルを再利用してくれます。リトライを重ねる場合も、[HttpClient をラップするのと同じレジリエンスハンドラー](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)がここでも使えます。gRPC チャネルの内部は `SocketsHttpHandler` だからです。

## JSON を使う REST を選ぶとき

- **クライアントを再生成できない相手が呼び出す場合。** ブラウザーは gRPC をまったく話せませんし、gRPC-Web も JSON トランスコーディングも、デプロイ構成への実質的な追加物です。「これを呼ぶのは誰か」の答えに自分たちのビルドの外の誰かが含まれるなら、JSON を提供してください。
- **呼び出しがまれな場合。** 1 つのエンドポイントを呼ぶ夜間の突合ジョブのために、`.proto` ファイル、CI でのコード生成ステップ、サービスメッシュ上の 2 つ目のプロトコルを持ち込む価値はありません。
- **すでに手元にあるツールでデバッグしたい場合。** 通信路上の Protobuf はスキーマなしでは不透明です。午前 3 時の 500 エラーは、curl でリクエストを再現できるほうが診断しやすくなります。
- **ロードバランサーが L4 の場合。** これは好みの問題ではなく、後述します。

```csharp
// .NET 11, C# 14 -- minimal API + typed client
app.MapGet("/orders/{id}", async (string id, IOrderStore store, CancellationToken ct)
    => await store.FindAsync(id, ct) is { } o
        ? Results.Ok(o)
        : Results.NotFound());

// Caller
builder.Services
    .AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders"))
    .AddStandardResilienceHandler();
```

これより構造化されたものが必要なら、[型付きの Results 共用体を返す](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)ことで、レスポンスの形のコンパイル時チェックと、手書きの属性なしでの正しい OpenAPI ドキュメントが得られます。これは gRPC を魅力的にしていた契約の厳密さの一部を取り戻すものです。

## SignalR が本当に正解であるとき

- **1 つの生産者と多数の長寿命な消費者がいて、すべての消費者が同じメッセージを必要とする場合。** 価格のティック、ジョブキューの状態、構成の無効化などです。買っているのはグループとブロードキャストという機能です。
- **消費者の集合が実行時に変化する場合。** SignalR は接続、切断、再接続を扱います。それを gRPC のストリームの上に作り直すのは、ひとつのプロジェクトです。
- **消費者の一部がブラウザーである場合。** ダッシュボードと一群のワーカーサービスが同じフィードを必要とするなら、1 つのハブが両方に対応できますし、プロキシなしでブラウザーに対応できる gRPC 構成は存在しません。

.NET 11 は長寿命な接続について SignalR を 2 つの点で明確に改善しています。`/refresh` エンドポイントと `EnableAuthenticationRefresh` により、ベアラートークンの期限切れでハブ接続が落ちなくなりました。これはトークン認証を使うデプロイにおける不要な再接続の最大の原因でした。さらに、[SignalR クライアントがついに実行中のハブメソッドをキャンセルできる](/ja/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/)ようになり、`InvokeAsync` に渡した `CancellationToken` をキャンセルすると実際にサーバーまで届きます。Preview 6 の時点でどちらも .NET クライアント限定であり、JavaScript クライアントと Azure SignalR Service のサポートは作業中です。

## あなたの代わりに判断を決めてしまう落とし穴

**L4 ロードバランサーは gRPC を壊します。** gRPC チャネルは 1 本の HTTP/2 接続であり、すべての呼び出しがその上で多重化されます。L4 バランサーは TCP 接続を分配するため、そのチャネルからのすべての呼び出しはずっと同じバックエンドに着地します。結果として、1 台が過負荷になり残りは遊びます。これを直すにはクライアントサイドのロードバランシングか、Envoy、Linkerd、YARP のような L7 プロキシが必要で、その判断はたいてい自分ではなくプラットフォームチームの領分です。その変更ができないなら比較は終わりで、REST の勝ちです。同種のインフラ上の摩擦は [gRPC をコンテナーで動かす](/ja/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)ときにも現れ、HTTP/1.1 しか話さないプロキシがプロトコル不一致にはまったく見えない障害を引き起こします。

**gRPC は .NET とは別サイクルで出荷され、TFM の一覧がそれを証明しています。** 2026-08-03 に公開された `Grpc.AspNetCore` 2.83.0 は `net8.0`、`net9.0`、`net10.0` を対象としています。`net11.0` のターゲットフレームワークは存在せず、リリースノート [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11) には gRPC のセクションがそもそもありません。これはサポートの欠落ではありません。`net10.0` のアセンブリは .NET 11 上で読み込まれ動作します。これはリリース周期の違いです。.NET 上の gRPC は `grpc/grpc-dotnet` で独自のリリーススケジュールに沿って保守されているため、gRPC にとって有益な .NET 11 の機能は 11 月ではなく grpc-dotnet が出荷したときに届きます。アップグレードの計画はそれを前提に立ててください。

**HTTP/2 は gRPC には必須で、それ以外にとっては任意です。** これは、中間経路を自分で管理できない区間では実際の制約になります。同時に、gRPC は今日 HTTP/3 の恩恵を受けられない一方、REST エンドポイントは受けられるということでもあります。[Kestrel で HTTP/3 を提供する設定](/ja/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/)はエンドポイントの 1 行の変更で済み、.NET 11 の Kestrel は制御ストリームと SETTINGS フレームを待たずに HTTP/3 リクエストの処理を開始するようになり、新規接続の初回リクエストのレイテンシが短くなりました。

**SignalR のスケールアウトは設定ではなく依存関係です。** サーバーインスタンスが 2 つ以上なら Redis バックプレーンか Azure SignalR Service が必要で、WebSocket 以外のトランスポートではさらにスティッキーセッションが必要です。多数への配信に見合うかを判断する前に、ラウンドロビンのバランサーの背後に置いたステートレスな REST エンドポイントと比べてみてください。

**可観測性は同等ではありません。** 3 つとも OpenTelemetry を通る `ActivitySource` のトレースを出力するので、[トレースを無料のバックエンドに接続する](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)ことですべてを扱えます。違うのはネットワークキャプチャで何が見えるかです。JSON は読めますが、Protobuf と MessagePack にはスキーマとツールが要ります。

## 推奨、あらためて

まず多数への配信かどうかで線を引いてください。1 つのサービスが多数の長寿命な消費者へ通知しなければならないなら、それは SignalR であり、他の 2 つにはグループとバックプレーンの代替はありません。それ以外はすべてポイントツーポイントであり、そこでの問いは契約を誰が所有しているかです。両端を自分たちで所有していて、スキーマを変更する pull request の中でクライアントを再生成できるなら、生成されたクライアントと伝播されるデッドラインによって gRPC は元が取れます。ペイロードが小さいことは理由ではなくおまけです。自分たちのビルドの外の誰かがそのサービスを呼ぶなら、JSON を使う REST を提供し、支払ってもいないバイト数の最適化はやめましょう。

避けるべき失敗の形は、ベンチマークがペイロードサイズ 51.7% を示したという理由で毎分 3 件しか呼ばれないサービスに gRPC を選び、その後で L4 ロードバランサーがすべての呼び出しを 1 つの Pod に固定していると気づくことです。メッセージあたり 56 バイトは、プラットフォーム移行に見合いません。

## 関連記事

- [gRPC をコンテナーで動かすのが .NET 9 と .NET 10 で難しく感じる: 修正できる 4 つの落とし穴](/ja/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- [SignalR クライアントが .NET 11 Preview 6 でついに実行中のハブメソッドをキャンセルできるようになりました](/ja/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/)
- [ASP.NET Core 11 で Kestrel が HTTP/3 を提供するように設定する方法](/ja/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/)
- [.NET 11 における Polly vs レジリエンスハンドラー: どちらを使うべきか](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)
- [ASP.NET Core 11 における Minimal API vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [.NET 11 と無料のバックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)

## 参考資料

- [Compare gRPC services with HTTP APIs](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison), Microsoft Learn
- [Performance best practices with gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance), Microsoft Learn
- [Overview of ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), Microsoft Learn
- [Grpc.AspNetCore 2.83.0](https://www.nuget.org/packages/Grpc.AspNetCore), NuGet
- [SignalR Hub Protocol specification](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md), dotnet/aspnetcore
- [gRPC over HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md), grpc/grpc
