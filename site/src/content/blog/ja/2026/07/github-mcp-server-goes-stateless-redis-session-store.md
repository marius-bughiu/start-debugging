---
title: "GitHub の MCP サーバーがステートレス化し、Redis のセッションストアを削除しました"
description: "2026-07-23 に GitHub は仕様の日付より前に MCP のリビジョン 2026-07-28 を出荷しました。注目すべきは引き算です。initialize ハンドシェイクなし、Mcp-Session-Id なし、Redis なしです。"
pubDate: 2026-07-28
tags:
  - "mcp"
  - "ai-agents"
  - "http"
  - "architecture"
lang: "ja"
translationOf: "2026/07/github-mcp-server-goes-stateless-redis-session-store"
translatedBy: "claude"
translationDate: 2026-07-28
---

2026-07-23 に GitHub は、[GitHub の MCP サーバーが次の MCP 仕様に対応した](https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/)ことを発表しました。対象は `2026-07-28` の日付を持つリビジョンで、その日付が来る数日前の出荷です。まだ公開されていないリビジョンを本番トラフィックの前段に置くのは賭けです。この発表が読む価値を持つのは、主要な変更がすべて引き算だからです。Redis のセッションストア、プロキシ層でのパケット検査、そしてクライアント接続ごとのデータベース書き込みが消えました。

## ハンドシェイクとセッションヘッダーが消えた

リビジョン `2026-07-28` は `initialize` と `notifications/initialized` のハンドシェイクを削除し、Streamable HTTP から `Mcp-Session-Id` ヘッダーを削除します。これまでハンドシェイクが確立していた内容は、すべて個々のリクエストの `_meta` に載って運ばれ、ロードバランサーがボディを解析せずにルーティングできるよう HTTP ヘッダーにミラーされます。

```http
POST /mcp HTTP/1.1
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "Seattle, WA" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

正となるのは引き続きボディです。ヘッダーがボディと食い違う場合、サーバーは `400 Bad Request` と JSON-RPC エラー `-32020` (`HeaderMismatch`) を返さなければなりません。これにより、ゲートウェイが一方の値でルーティングし、サーバーがもう一方の値で実行するという事態を防げます。

この一点の変更こそが、Redis への依存を外せた理由です。セッションストアは、クライアントの 2 回目のリクエストが 1 回目で作られた状態を見つけられるようにするためだけに存在していました。ハンドシェイクがなければ探すべき状態もないので、どのリクエストがどのインスタンスに届いても構わず、初期化がデータベースに書き込むこともなくなります。

## 実作業が発生する 2 つの変更

サーバー起点のリクエストはなくなりました。sampling、roots、elicitation は、これまでサーバーから送られる JSON-RPC リクエストとして届いていました。Multi Round-Trip Requests (SEP-2322) では、サーバーは代わりに `resultType: "input_required"` と `inputRequests` 配列を返し、クライアントは `inputResponses` を載せて元の呼び出しを再試行します。GitHub は古いクライアントを壊すのではなく、Go SDK のラッパーで両方の世代を扱いました。

再開可能性もなくなりました。`Last-Event-ID` ヘッダーと SSE のイベント ID が削除されたため、レスポンスストリームが切断されると実行中のリクエストは失われ、クライアントは新しいリクエスト ID で再送しなければなりません。再接続時の再送信を前提にしていたサーバーでは、その前提は自分で処理する必要があります。

マイグレーションを計画する前に押さえておきたい点がもう 1 つあります。Tasks はコアから拡張 `io.modelcontextprotocol/tasks` へ移り、`tasks/list` は削除されました。また Roots、Sampling、Logging は 12 か月の猶予期間つきで正式に非推奨となりました。

## 自分のサーバーはどうなるか

セッション ID ジェネレーターなしで Streamable HTTP をすでに運用しているなら、道のりのほとんどは終わっています。これはネットワーク越しに動くものについて [stdio や旧来の SSE トランスポートではなく Streamable HTTP を選ぶ](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/)実務上の根拠でもあります。tier 1 の SDK は後方互換性を保ったままベータ対応を出荷したので、既存のデプロイは動き続けるために何もする必要はありません。それが自分のコードにも当てはまると決めつける前に、[変更の全一覧](https://modelcontextprotocol.io/specification/draft/changelog)を読んでください。
