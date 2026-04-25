---
title: "Kestrel が .NET 11 で HTTP/1.1 パーサーから例外を捨てる"
description: ".NET 11 の Kestrel HTTP/1.1 リクエストパーサーは BadHttpRequestException を結果 struct に置き換え、不正リクエストのオーバーヘッドを最大 40% 削減します。"
pubDate: 2026-04-08
tags:
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "performance"
lang: "ja"
translationOf: "2026/04/kestrel-non-throwing-parser-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Kestrel に到達するすべての不正な HTTP/1.1 リクエストはかつて `BadHttpRequestException` をスローしていました。その例外はスタックトレースを割り当て、コールスタックを巻き戻し、上位のどこかでキャッチされていました。すべて、有効なレスポンスを生成することのないリクエストのためです。.NET 11 ではパーサーが [スローしないコードパスに切り替わり](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)、その差は計測可能です。不正トラフィックが頻繁なシナリオで **20-40 % 高いスループット** です。

## なぜ例外が高価だったか

.NET で例外をスローするのは無料ではありません。ランタイムはスタックトレースをキャプチャし、一致する `catch` を探してコールスタックを歩き、例外オブジェクトをヒープに割り当てます。整形式リクエストではこれが発火しないので、気づきません。しかし、ポートスキャナー、設定ミスのクライアント、悪意のあるトラフィックは毎秒数千の不正リクエストを押し込みます。それぞれが完全な例外税を払っていました。

```csharp
// Before (.NET 10 and earlier): every parse failure threw
try
{
    ParseRequestLine(buffer);
}
catch (BadHttpRequestException ex)
{
    Log.ConnectionBadRequest(logger, ex);
    return;
}
```

ホットパスでは、頻繁にスローする `try/catch` はスループットのボトルネックになります。

## 結果 struct のアプローチ

.NET 11 のパーサーは代わりに軽量な結果 struct を返します。

```csharp
// After (.NET 11): no exception on parse failure
var result = ParseRequestLine(buffer);

if (result.Status == ParseStatus.Error)
{
    Log.ConnectionBadRequest(logger, result.ErrorReason);
    return;
}
```

struct は `Status` フィールド (`Success`、`Incomplete`、または `Error`) と、関連する場合はエラー理由文字列を運びます。ヒープ割り当てなし、スタックの巻き戻しなし、`catch` ブロックのオーバーヘッドなしです。有効なリクエストはすでに成功パスを取っていたため、変化を感じません。

## いつ重要か

サーバーが生 TCP でヘルスチェックするロードバランサーの背後にいるか、Kestrel をインターネットに直接公開している場合、不正リクエストに常に叩かれています。ハニーポットデプロイメント、混合プロトコルを処理する API ゲートウェイ、ポートスキャンに晒されるあらゆるサービスはすべて恩恵を受けます。

改善は完全に Kestrel の内部です。API 変更も、設定フラグも、オプトインもありません。.NET 11 にアップグレードすると、デフォルトでパーサーが速くなります。

## .NET 11 のその他のパフォーマンス改善

これは .NET 11 Preview での唯一の割り当て削減ではありません。HTTP ロギングミドルウェアは `ResponseBufferingStream` インスタンスをプールするようになり、レスポンス本体ロギングが有効な場合のリクエスト毎の割り当てを減らします。パーサーの変更と組み合わせると、.NET 11 はランタイムチームのパターン -- 例外重視のホットパスを struct ベースの結果フローに変える -- を継続しています。

自身のワークロードへの影響を見たい場合は、[Bombardier](https://github.com/codesenberg/bombardier) または `wrk` で不正リクエストを一定割合注入しながら、ビフォー/アフターのベンチマークを実行してください。パーサーの変更は透過的ですが、数字が物語ります。
