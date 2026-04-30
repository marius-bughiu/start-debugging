---
title: ".NET 11 Minimal API からストリーミングで Claude API を呼び出す方法"
description: "ASP.NET Core 11 minimal API から Claude のレスポンスをエンドツーエンドでストリーミングします。公式 Anthropic .NET SDK、TypedResults.ServerSentEvents、SseItem、IAsyncEnumerable、キャンセルの流れ、そしてトークンを静かにバッファリングしてしまう落とし穴を扱います。Claude Sonnet 4.6 と Opus 4.7 の例付き。"
pubDate: 2026-04-30
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "aspnet-core"
  - "dotnet-11"
  - "streaming"
lang: "ja"
translationOf: "2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming"
translatedBy: "claude"
translationDate: 2026-04-30
---

ASP.NET Core 11 の minimal API に Claude を素直に組み込むと、「動作する」リクエストと、12 秒後に遅い 1 つの塊で到着する出力が得られます。Anthropic API はトークンを 1 つずつ生成しながらレスポンスをストリーミングしています。あなたのエンドポイントはそれらを集め、メッセージ全体を JSON シリアライズし、モデルが `message_stop` と言ったときにまとめて送信しています。Kestrel とユーザーの間にあるサーバー、プロキシ、ブラウザのすべてがそれをバッファリングしているのは、これがストリームであることが何にも伝わっていないからです。

このガイドは現在のスタックでの正しい配線を示します。ASP.NET Core 11 (2026 年 4 月時点では preview 3、RTM は今年後半)、公式 Anthropic .NET SDK (NuGet 上の `Anthropic`)、Claude Sonnet 4.6 (`claude-sonnet-4-6`) と Claude Opus 4.7 (`claude-opus-4-7`)、そして `Microsoft.AspNetCore.Http` の `TypedResults.ServerSentEvents` です。バッファリングする普通のエンドポイントから、チャンク化されたテキストをストリーミングする `IAsyncEnumerable<string>` エンドポイント、そしてブラウザの `EventSource` が読める適切な SSE イベントを発行する型付き `SseItem<T>` エンドポイントへと進みます。その後、キャンセル、エラー、ツール呼び出し、そして全体を静かに壊すプロキシを扱います。

## なぜ「ただレスポンスを await する」がここでは間違いなのか

非ストリーミングの Claude 呼び出しは、モデルが終了した後に完全な `Message` を返します。Sonnet 4.6 で 1,500 トークンのレスポンスの場合、それはおおよそ 6 秒から 12 秒の死んだ空気です。これはチャット UI では悪い UX で、遅い接続ではさらに悪化します。すべてが届くまでユーザーは何も見えないからです。また、ストリーミングしてもしなくても同じ入力トークン分のコストがかかるので、バッファリングする利点はありません。

[Anthropic ストリーミングリファレンス](https://platform.claude.com/docs/en/build-with-claude/streaming) に文書化されているストリーミングエンドポイントは、Server-Sent Events を使用します。各チャンクは名前付きイベント (`message_start`、`content_block_delta`、`message_stop` など) と JSON ペイロードを持つ SSE フレームです。.NET SDK はそれを `IAsyncEnumerable` でラップするので、Anthropic を呼び出す際に SSE を自分でパースする必要はありません。難しいのは*出力*側の半分です。フレームワークに親切にバッファリングされずに、それらのチャンクをどのようにブラウザに再送するか?

ASP.NET Core 8 は minimal API のためのネイティブな `IAsyncEnumerable<T>` ストリーミングを獲得しました。ASP.NET Core 10 は `TypedResults.ServerSentEvents` と `SseItem<T>` を追加し、`text/event-stream` を手で組み立てずに適切な SSE を返せるようにしました。両方とも 11 に含まれています。組み合わせると、実際に欲しい 2 つの形をカバーします。

## 出荷すべきでないバッファ版

ここに素朴なエンドポイントを示します。壊すための出発点を持つためだけのものです。

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha (NuGet: Anthropic)
using Anthropic;
using Anthropic.Models.Messages;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => new AnthropicClient());
var app = builder.Build();

app.MapPost("/chat", async (ChatRequest req, AnthropicClient client) =>
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = req.Prompt }]
    };

    var message = await client.Messages.Create(parameters);
    return Results.Ok(new { text = message.Content[0].Text });
});

app.Run();

record ChatRequest(string Prompt);
```

これは動作します。また Claude が終了するまでレスポンス全体をブロックします。修正は 2 つの変更です。SDK の呼び出しを `CreateStreaming` に切り替え、ASP.NET に `Task<T>` の代わりに enumerator を渡すことです。

## IAsyncEnumerable<string> でテキストチャンクをストリーミングする

Anthropic .NET SDK は `client.Messages.CreateStreaming(parameters)` を公開しており、これはテキストデルタの非同期 enumerable を返します。それを `IAsyncEnumerable<string>` を返す minimal API エンドポイントと組み合わせると、ASP.NET Core はバッファリングなしで `application/json` (インクリメンタルに書き込まれる JSON 配列) としてストリーミングします。

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;

app.MapPost("/chat/stream", (ChatRequest req,
                              AnthropicClient client,
                              CancellationToken ct) =>
{
    return StreamChat(req.Prompt, client, ct);

    static async IAsyncEnumerable<string> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return chunk;
        }
    }
});
```

ここでは 3 つのディテールが重要です。

1. **ローカル関数**であり、ラムダではありません。C# コンパイラはラムダや匿名メソッドの中で `yield return` を許可しないので、minimal API のデリゲートはローカルの async イテレータメソッドを呼び出します。これは .NET 6 から minimal API を書いてきた誰もがつまずく点です。なぜなら他のすべてのエンドポイント形式はラムダとして動作するからです。
2. イテレータの `CancellationToken` パラメータに **`[EnumeratorCancellation]`** を付けます。これがないと、ASP.NET からのリクエスト中断トークンは enumerator に流れず、接続が閉じられても SDK は楽しくストリームを続け、出力トークンを燃やします。コンパイラはこれについて警告しません。属性を追加するか、タブを閉じることで実際にリクエストがキャンセルされるかをプロファイラで確認してください。
3. SDK の enumerable に **`.WithCancellation(ct)`** を付けます。念のためですが、気にしている境界でキャンセルを明示的にします。

このエンドポイントの線上のフォーマットは JSON 配列です。ブラウザは `EventSource` フレンドリーなストリームは得られませんが、`ReadableStream` リーダー付きの `fetch` は問題なく動作しますし、チャンク化された JSON 配列を扱える消費者ならどれでも動作します。クライアントが SignalR ハブやサーバー駆動の UI フレームワークなら、通常はこの形が欲しい形です。

## TypedResults.ServerSentEvents で適切な SSE をストリーミングする

クライアントが `EventSource` を使うブラウザや `text/event-stream` を期待するサードパーティツールなら、JSON ではなく SSE が欲しいです。ASP.NET Core 10 は `TypedResults.ServerSentEvents` を追加しました。これは `IAsyncEnumerable<SseItem<T>>` を取り、正しい content type、no-cache ヘッダー、正しいフレーミングを持つ実際の SSE レスポンスを書き込みます。

`SseItem<T>` は `System.Net.ServerSentEvents` にあります。各 item はイベントタイプ、オプションの ID、オプションの再接続間隔、そして `T` 型の `Data` ペイロードを持ちます。文字列を渡さない限り ASP.NET はペイロードを JSON としてシリアライズしますが、文字列なら verbatim で通ります。

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;
using Microsoft.AspNetCore.Http;

app.MapPost("/chat/sse", (ChatRequest req,
                           AnthropicClient client,
                           CancellationToken ct) =>
{
    return TypedResults.ServerSentEvents(StreamChat(req.Prompt, client, ct));

    static async IAsyncEnumerable<SseItem<string>> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return new SseItem<string>(chunk, eventType: "delta");
        }

        yield return new SseItem<string>("", eventType: "done");
    }
});
```

これでブラウザはこうできます。

```javascript
// Browser, native EventSource (still GET-only) or fetch-event-source for POST.
const es = new EventSource("/chat/sse?prompt=...");
es.addEventListener("delta", (e) => append(e.data));
es.addEventListener("done", () => es.close());
```

線上のフレーミングは標準的な SSE の形です。

```
event: delta
data: "Hello"

event: delta
data: " world"

event: done
data: ""

```

2 つのエンドポイントの選択についての注意点を 2 つ。クライアントが `EventSource` を使うブラウザなら、SSE が欲しいです。それ以外、自分自身の `fetch` リーダー付きフロントエンドを含むなら、`IAsyncEnumerable<string>` エンドポイントの方がシンプルで、CDN 設定でキャッシュしやすく、ボディの形が明白なままです。`TypedResults.ServerSentEvents` API は [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) に文書化されています。

## モデル ID の固定とコスト

チャットスタイルのストリーミングでは、2026 年 4 月の正しいデフォルトは:

- 一般的なチャットには **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**。$3 / 100 万入力トークン、$15 / 100 万出力トークン。`us-east-1` での最初のバイトまでのレイテンシは約 400-600 ms。コンテキストウィンドウは 200k。
- 難しい推論には **Claude Opus 4.7 (`claude-opus-4-7`)**。$15 / $75。最初のバイトはより遅く、800 ms-1.2 s。コンテキストウィンドウは 200k、長文コンテキストベータで 1M。
- 高スループットの安価な呼び出しには **Claude Haiku 4.5 (`claude-haiku-4-5`)**。$1 / $5。最初のバイトは 300 ms 未満。

モデル ID はコードで宣言してください。フロントエンドが上書きできる設定文字列経由ではなくです。SDK 定数 (`Model.ClaudeSonnet4_6`、`Model.ClaudeOpus4_7`、`Model.ClaudeHaiku4_5`) はタイプミスのリスクをコンパイル時に取り除きます。価格は [Claude API 価格ページ](https://www.anthropic.com/pricing) にあります。請求する前に再確認してください。

各リクエストの前に長いシステム prompt やツールカタログを置こうとしているなら、prompt caching もオンにしたくなります。ストリーミングとキャッシュは綺麗に組み合わさるからです。詳細は [Anthropic SDK アプリに prompt caching を追加してヒット率を測定する方法](/ja/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) にあります。

## SDK があなたから隠していること

`CreateStreaming` から出てくる文字列チャンクは、生の SSE イベントストリームに対する SDK のフレンドリーなビューです。線上を自分でパースした場合に見える実際のイベントは:

- `message_start`: 空の `content` を持つ `Message` エンベロープ。メッセージ ID と初期の `usage` を運びます。
- `content_block_start`: コンテンツブロック (text、tool_use、または thinking) を開きます。
- `content_block_delta`: インクリメンタルな更新。`delta.type` は `text_delta`、`input_json_delta`、`thinking_delta`、`signature_delta` のいずれかです。
- `content_block_stop`: 現在のブロックを閉じます。
- `message_delta`: `stop_reason` と累積出力トークン使用量を含むトップレベルの更新。
- `message_stop`: ストリームの終わり。
- `ping`: フィラー、プロキシがアイドル接続を切るのを防ぐために送られます。無視。

SDK はそのすべてを、あなたが見るイテレータ出力に折りたたみますが、頼めばよりリッチなビューを得られます。生のイベントを返す SDK のオーバーロードを確認するか、ループの後に `.GetFinalMessage()` で蓄積された `Message` を保持して、本物の `usage` (`message_delta` で累積、`message_stop` で最終) を読めるようにします。エージェントループではほぼ常に最終メッセージが欲しいです。そこで SDK は `stop_reason`、組み立てられたツール呼び出し、課金に必要な入力/出力トークン数を渡すからです。

## 実際にキャンセルするキャンセル

これは dev で誰も捕まえず本番で全員が捕まえるバグです。ユーザーがタブを閉じます。ASP.NET はリクエスト中断トークンをトリップします。エンドポイントの `IAsyncEnumerable` は止まるはずで、SDK は止まるはずで、Anthropic への基底の HTTP ストリームは閉じるはずです。そのチェーンのすべてのリンクがトークンを尊重しなければならず、どれか 1 つでも壊れると、誰も読んでいないトークンを生成し続けることになります。

確認すべき 3 つの場所:

1. イテレータのトークンパラメータの `[EnumeratorCancellation]` 属性。これがないと、`WithCancellation` で ASP.NET から渡されたトークンはイテレータの `ct` になりません。
2. `CreateStreaming` 呼び出しはトークンを必要とします。`.WithCancellation(ct)` 経由で渡すか、トークンを直接受け付けるバージョンの SDK ならその呼び出しごとのオプション経由で渡してください。
3. ブラウザ側は実際に閉じる必要があります。`EventSource` はデフォルトで再接続します。クライアントから `es.close()` を呼ばないと、別ページへのナビゲーションが数秒後に新しいリクエストを発火させることがあります。長い completion では、これは本当のお金がかかることがあります。

最もきれいなテストは `curl` でエンドポイントを呼び出し、ストリームの途中で Ctrl-C で殺し、Anthropic ダッシュボードや自分のリクエストログを観察することです。Anthropic への接続はクライアントの切断から 1 秒以内に閉じるはずです。そうでない場合、トークンがどこかで流れていません。

IO ループ全般のキャンセルのより長い扱いについては、[デッドロックなしで C# の長時間タスクをキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) を参照してください。

## ストリーム中のエラー

すでに開始したストリーミングレスポンスは 500 を返せません。Kestrel が最初のバイトをフラッシュした瞬間に 200 にコミットしました。それ以降のエラーは HTTP ステータスではなくデータとして流れる必要があります。クライアントを正気に保つパターン:

```csharp
static async IAsyncEnumerable<SseItem<string>> StreamChat(
    string prompt,
    AnthropicClient client,
    [EnumeratorCancellation] CancellationToken ct)
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = prompt }]
    };

    IAsyncEnumerator<string>? enumerator = null;
    try
    {
        enumerator = client.Messages.CreateStreaming(parameters)
                                     .WithCancellation(ct)
                                     .GetAsyncEnumerator();
    }
    catch (Exception ex)
    {
        yield return new SseItem<string>(ex.Message, eventType: "error");
        yield break;
    }

    while (true)
    {
        bool moved;
        try
        {
            moved = await enumerator.MoveNextAsync();
        }
        catch (OperationCanceledException) { yield break; }
        catch (Exception ex)
        {
            yield return new SseItem<string>(ex.Message, eventType: "error");
            yield break;
        }

        if (!moved) break;
        yield return new SseItem<string>(enumerator.Current, eventType: "delta");
    }

    yield return new SseItem<string>("", eventType: "done");
}
```

これはハッピーパスより醜いですが、正しい形です。`try` は `yield return` を包めないので、イテレーションを手動の `MoveNextAsync` ループに分割します。ストリーム中の障害 (rate limits、モデル過負荷、ネットワークの引っ掛かり) はクライアントがレンダーできる `error` イベントになります。きれいなシャットダウンは `done` イベントになります。リクエストはすでに去っているので、キャンセルは静かに終了します。

2 つの特定の Anthropic エラーは独自のクライアントサイドハンドリングに値します。`overloaded_error` (モデルが一時的にキャパシティ外、バックオフでリトライ) と `rate_limit_error` (組織の分単位または日単位の上限に達した) です。両方とも .NET 側で SDK からの例外として届き、パターンマッチング可能な型付き `AnthropicException` を持ちます。

## ストリームでのツール呼び出し

エンドポイントが `tool_use` コンテンツブロックを生成できる場合、SDK は依然としてテキストデルタ用に文字列型のイテレータを渡しますが、それを運ぶイベントを購読しなければツール呼び出しのペイロードを失います。低レベルの `Messages.CreateStreamingRaw` (または SDK バージョンの同等品) は型付きイベントを公開します。パターン: `text_delta` を SSE デルタチャネルにルーティングし、`input_json_delta` (ツール呼び出しの引数フラグメント) を別の `tool` チャネルにルーティングし、何をレンダーするかをクライアントに決めさせます。

実際には、ほとんどのチャット UI はストリーミング中に JSON 引数をレンダーする必要はありません。ツールブロックの `content_block_stop` を待ち、それから "Calling get_weather..." と結果を表示します。ツール引数をトークンごとにストリーミングするのは主にデバッグの助けです。

すでにツール呼び出しを配線しているなら、おそらく Claude にサービスを MCP ツールとして公開もしています。.NET 側のサーバーパターンは [.NET 11 上で C# でカスタム MCP サーバーを構築する方法](/ja/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) にあります。ここのストリーミングエンドポイントはそれらのツールの*クライアント*であり、サーバーではありません。

## すべてを壊すプロキシバッファリング

これらすべてを正しく配線します。`localhost` から叩きます。ストリームします。nginx、Cloudflare、Azure Front Door の背後にデプロイすると、レスポンスは大きなバッファされた塊で戻ってきます。優先順位順に知っておくべき 3 つの設定:

- **nginx**: SSE のロケーションに `proxy_buffering off;` を設定するか、エンドポイントからのレスポンスヘッダーとして `X-Accel-Buffering: no` を追加します。ヘッダーのトリックは移植可能で、リバースプロキシの変更を生き残ります。`text/event-stream` または `IAsyncEnumerable` 付きの `application/json` を返す任意のエンドポイント用にミドルウェアで追加します。
- **Cloudflare**: 該当のルートで [Streaming responses](https://developers.cloudflare.com/) を有効にします。デフォルトの動作はほとんどのプランでチャンクを保持しますが、エンタープライズ WAF ルールはバッファリングすることがあります。最初にレスポンスヘッダーのトリックでテストしてください。
- **圧縮**: レスポンス圧縮ミドルウェアはチャンクを集めて、より大きなブロックで圧縮することがあります。`text/event-stream` の圧縮を無効にするか、chunked transfer 付きの `application/json` を使用してください。ASP.NET のレスポンス圧縮は両方を知っていますが、ストリーミングエンドポイントの前に順序付けされたカスタムミドルウェアはそれを打ち負かす可能性があります。

ヘッダーが存在することを確実にするため、ストリーミングエンドポイントにこのフィルタを追加してください:

```csharp
app.MapPost("/chat/sse", ...)
   .AddEndpointFilter(async (ctx, next) =>
   {
       ctx.HttpContext.Response.Headers["X-Accel-Buffering"] = "no";
       return await next(ctx);
   });
```

ASP.NET Core からボディを安全にストリーミングすることについての詳細は、[ASP.NET Core エンドポイントからバッファリングなしでファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) を参照してください。「ミドルウェアにチャンクを集めさせない」という教訓は LLM ストリームに同様に適用されます。

## ストリーミングエンドポイントの可観測性

ストリーミング Claude 呼び出しには追跡する価値のある 2 つのレイテンシ数字があります。最初のトークンまでの時間 (ユーザーが感じるレイテンシ) と完了までの総時間です。両方ともトレースに着地すべきです。ASP.NET Core 11 のネイティブ OpenTelemetry サポートは、`Diagnostics.Otel` パッケージへの依存を取らずにこれを簡単にします。セットアップは [ASP.NET Core 11 のネイティブ OpenTelemetry トレーシング](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/) にあります。

リクエストスパンに 3 つのカスタム属性をキャプチャします: モデル ID、入力トークン数 (SDK の最終 `Message` から)、出力トークン数。ログだけからのコスト再構成は他の方法では苦痛です。モデルでグループ化されたレイテンシヒストグラムは、ルーチントラフィックで Opus 4.7 から Sonnet 4.6 にフォールバックすべき時を明らかにします。

## Microsoft.Extensions.AI について

プロバイダー中立な抽象に対してコーディングしたいなら、Microsoft.Extensions.AI の `IChatClient.GetStreamingResponseAsync` は `IAsyncEnumerable<ChatResponseUpdate>` を返し、HTTP 境界で同じように動作します。Anthropic の `IChatClient` アダプターをラップし、更新をテキストや `SseItem<T>` に投影すれば、この記事の残りはそのまま適用されます。トレードオフは、後で OpenAI やローカルモデルにスワップするオプションのために抽象の 1 層を加えることです。エージェントコードにはフレームワークバージョンも欲しいです。同じ抽象の上に構築される [Microsoft Agent Framework 1.0: C# での AI エージェント](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) を参照してください。

BYOK の角度 (この同じ Anthropic キーを VS Code の GitHub Copilot に渡す) では、セットアップはここで行うことを反映します: 同じモデル ID、同じキー、別の消費者です。[GitHub Copilot in VS Code: BYOK with Anthropic, Ollama, and Foundry Local](/ja/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/) を参照してください。

## ソース

- [Streaming Messages, Claude API docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic/)
- [Create responses in Minimal API applications, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- [System.Net.ServerSentEvents.SseItem<T>](https://learn.microsoft.com/en-us/dotnet/api/system.net.serversentevents.sseitem-1)
- [Claude API pricing](https://www.anthropic.com/pricing)
