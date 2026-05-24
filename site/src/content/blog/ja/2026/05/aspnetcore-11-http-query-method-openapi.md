---
title: ".NET 11 Preview 4 の ASP.NET Core が OpenAPI に HTTP QUERY メソッドを教える"
description: ".NET 11 Preview 4 により、ASP.NET Core の OpenAPI 生成は HTTP QUERY を OpenAPI 3.2 の第一級の操作として認識するようになり、3.0 と 3.1 のドキュメントには適切なフォールバックが用意されます。"
pubDate: 2026-05-24
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "http"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/05/aspnetcore-11-http-query-method-openapi"
translatedBy: "claude"
translationDate: 2026-05-24
---

2026-05-12 にリリースされた [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/) は、ASP.NET Core に小さいながらも先を見据えた変更を加えました。OpenAPI ドキュメント生成が `QUERY` を既知の HTTP 操作タイプとして認識するようになったのです。QUERY メソッドを聞いたことがなくても問題ありません。それこそがこの記事の主題です。これは提案中の標準メソッドで、検索 endpoint を何年も悩ませてきた現実的な緊張を解消します。

## なぜ検索のための新しい動詞が必要なのか

検索リクエストは、既存の動詞では同時に満たせない 2 つのことを求めます。1 つは `GET` のように安全かつ冪等であること。これにより、キャッシュやプロキシが妥当に扱い、再試行が何も変更しないようになります。もう 1 つは `POST` のように構造化されたリクエストボディを運べること。本格的なフィルタ (ネストしたブール句、地理的な境界、ベクトルとメタデータ述語の組み合わせ) はクエリ文字列にきれいに収まらず、URL の長さ制限にぶつかるからです。

チームはこれを 10 年間、`POST /search` を JSON ボディとともに送信し、それが冪等であるかのように暗黙のうちに振る舞うことでごまかしてきました。それは動作しますが、経路上のあらゆるキャッシュや中継者に嘘をついています。IETF の `QUERY` メソッドは正直なバージョンです。`GET` のセマンティクス (安全、冪等、キャッシュ可能) にリクエストボディを加えたものです。Preview 4 はこのメソッドを発明するのではなく、OpenAPI パイプラインにそれを正しく記述する方法を教えます。

## QUERY endpoint をマッピングする

ルーティングはすでに任意の動詞をサポートしていたため、新しく覚える属性はありません。既存の `MapMethods` オーバーロードで QUERY endpoint をマッピングします。

```csharp
app.MapMethods("/search", ["QUERY"], (SearchRequest request) =>
    SearchService.Run(request));
```

新しいのは、OpenAPI ドキュメントジェネレーターから出力される内容です。QUERY が第一級の概念になったのは OpenAPI 3.2 からなので、その仕様バージョンを明示的に選択する必要があります。

```csharp
builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_2;
});
```

3.2 を選択すると、上記の endpoint は path item 上の適切な `query` 操作として出力されます。このメソッドより前の OpenAPI 3.0 や 3.1 に固定されたままの場合でも、ジェネレーターは endpoint を黙って破棄しません。`x-oai-additionalOperations` 拡張にフォールバックするため、この拡張を理解するツールは操作を認識でき、理解しないツールも少なくともつまずくことはありません。

## 本番投入の前に知っておくべきこと

QUERY はまだ提案中のメソッドであるため、ブラウザー、HTTP クライアント、CDN、企業プロキシ間でのサポートにはばらつきがあります。この変更は endpoint を正確に記述することが目的であり、すべての中継者がそれをルーティングするという保証ではありません。両端を制御できる内部のサービス間検索 API であれば、今日でもきれいに適合します。公開 API では、将来への備えとして扱い、エコシステムが追いつくまで `POST` の経路を維持してください。

この作業は [dotnet/aspnetcore #65714](https://github.com/dotnet/aspnetcore/pull/65714) で取り込まれました。静かな preview の中の静かな 1 行ですが、QUERY が本当に普及するのか、それとも永遠にドラフトのままになるのかを左右する種類の配管工事です。
