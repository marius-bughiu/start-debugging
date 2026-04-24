---
title: ".NET 11 Preview 3 で Kestrel が SETTINGS フレーム前に HTTP/3 リクエストの処理を開始"
description: ".NET 11 Preview 3 では、Kestrel がピアの control stream と SETTINGS フレームの到着を待たずに HTTP/3 リクエストを処理できるようになり、新しい QUIC 接続のたびに最初のリクエストの handshake レイテンシが削減されます。"
pubDate: 2026-04-20
tags:
  - "dotnet-11"
  - "aspnet-core"
  - "kestrel"
  - "http-3"
  - "performance"
lang: "ja"
translationOf: "2026/04/aspnetcore-11-kestrel-http3-early-request-processing"
translatedBy: "claude"
translationDate: 2026-04-24
---

[.NET 11 Preview 3 のアナウンス](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) の小さくも目立つ勝利のひとつが、HTTP/3 に対する Kestrel の変更です: サーバーはもはやクライアントの control stream と SETTINGS フレームが届くのを待ってからリクエスト処理を始めることはありません。変更は [dotnet/aspnetcore #65399](https://github.com/dotnet/aspnetcore/pull/65399) で着地し、新規の QUIC 接続でのファーストリクエストのレイテンシを狙っています。これはまさに HTTP/3 がすでにウォームアップした HTTP/2 接続に対して負けていた場所です。

## 以前の HTTP/3 handshake のコスト

HTTP/3 は QUIC 上で動くので、トランスポートの handshake (TLS 1.3 + QUIC) はすでに接続セットアップに畳み込まれています。その上で、プロトコルは単方向の control stream を定義し、各サイドはまずそこに `SETTINGS` フレームを送ります。これらの設定は `SETTINGS_QPACK_MAX_TABLE_CAPACITY`、`SETTINGS_QPACK_BLOCKED_STREAMS`、`SETTINGS_MAX_FIELD_SECTION_SIZE` のようなものを通知します。Kestrel は以前、この最初のピアフレームでリクエスト処理パイプラインをブロックしていました。実際には、新しい接続は QUIC handshake の後、`Map*` ハンドラーが走る前に余分な論理ラウンドトリップを 1 回待つ必要がありました - クライアントがすでにリクエストストリームに `HEADERS` フレームを 0-RTT で送っていたとしてもです。

`Logging__LogLevel__Microsoft.AspNetCore.Server.Kestrel=Trace` で接続トレースをダンプすると症状が見えます:

```text
Connection id "0HN7..." accepted (HTTP/3).
Stream id "0" started (control).
Waiting for SETTINGS frame from peer.
Stream id "4" started (request).  <-- request arrived, but not dispatched yet
SETTINGS frame received.
Dispatching request on stream id "4".
```

`Waiting for SETTINGS frame` のギャップはピアの RTT に比例し、サーバーの作業量には比例しません。

## Preview 3 が変えること

Preview 3 では、Kestrel はリクエストストリームが到着するや否やディスパッチし、control stream が追いついたときにピアの設定を適用します。仕様もこれを許可しています: RFC 9114 の 6.2.1 節は、実装が control stream の handshake と並行してリクエストストリームのフレーム処理を始めることを許し、線上の決定をまだコミットしていないものに対しては設定を遡及的に強制すれば良いとしています。

ハンドラーレベルでは何も変わりません。同じ minimal API がそのまま動きます:

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(o =>
{
    o.ListenAnyIP(5001, listen =>
    {
        listen.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listen.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", () => Results.Ok(new { ok = true, proto = "h3" }));

app.Run();
```

Preview 3 の効果は線上にあります: 上のストリーム 4 の `HEADERS` フレームは即座にディスパッチされ、`SETTINGS` フレームはまだデコードされていない QPACK エンコードのフィールドに適用されます。動的テーブル参照を送らない単純な `GET /ping` の場合、リクエストは control stream を待つことなく完了します。

## あなた側で確認すべきこと

新しい挙動に頼り始める前に、2 つの注意点を確認しておく価値があります。

第一に、大きなレスポンスヘッダーを送信する場合、Kestrel は依然としてピアの最終的な `SETTINGS_MAX_FIELD_SECTION_SIZE` を尊重してから `HEADERS` フレームをシリアライズして返します。ピアが SETTINGS をまだ送っていない場合、[RFC 9114](https://www.rfc-editor.org/rfc/rfc9114#name-settings) のデフォルト (無制限) が適用されます。つまり、ピアの実際の設定が小さければ、レスポンスは後から拒否される可能性があります。接続の最初のリクエストではレスポンスヘッダーを小さく保ってください。

第二に、新しい QUIC セッションで time-to-first-byte として測定されるものはすべて目に見えて減少するはずです。50ms の人工的なピア遅延を伴うループバック上のタイトなローカルベンチマークでは、最初のリクエストがおよそ `2 * RTT + server_time` から `1 * RTT + server_time` に下がりました。同じ接続上の後続のリクエストは Preview 3 以前から影響を受けておらず、今も影響を受けません。

YARP や API gateway の背後で HTTP/3 を運用している場合は、エンドツーエンドで .NET 11 Preview 3 ビルドにアップグレードしていることを確認してください; 勝利は QUIC ホップの Kestrel 側にあるので、リバースプロキシがそれを目にする場所です。この preview の HTTP/3 と Kestrel に関する完全なノートのセットは [ASP.NET Core release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md) にあります。
