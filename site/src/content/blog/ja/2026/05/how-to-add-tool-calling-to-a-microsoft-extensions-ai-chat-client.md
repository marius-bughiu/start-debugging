---
title: "Microsoft.Extensions.AI Chat Client にツール呼び出しを追加する方法"
description: "Microsoft.Extensions.AI 10.5 で AIFunctionFactory.Create、ChatOptions.Tools、ChatClientBuilder.UseFunctionInvocation を接続し、IChatClient から .NET メソッドを自動的に呼び出せるようにする方法を解説します。OpenAI と Azure OpenAI のプロバイダー、実際に効く FunctionInvokingChatClient のノブ (反復回数の上限、同時呼び出し、承認プロンプト、エラー処理)、そしてツール付きストリーミング応答までを扱います。"
pubDate: 2026-05-03
tags:
  - "llm"
  - "ai-agents"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "openai-sdk"
lang: "ja"
translationOf: "2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client"
translatedBy: "claude"
translationDate: 2026-06-02
---

.NET で LLM に自分のコードへのアクセスを与える最短経路は、もう「OpenAI SDK を選んでツールループを手書きする」ことではありません。**Microsoft.Extensions.AI 10.5.1** (2026 年 5 月 2 日リリース、.NET 8 / 9 / 10、.NET Standard 2.0、および .NET Framework 4.6.2+ をターゲット) を使えば、`ChatClientBuilder.UseFunctionInvocation()` で `IChatClient` パイプラインを組み立て、ツールは `AIFunctionFactory.Create` でラップしたただのデリゲートとして宣言するだけで、呼び出し/応答のループも JSON スキーマ生成も結果のマーシャリングもライブラリ側がやってくれます。同じパイプラインは OpenAI、Azure OpenAI、Ollama、その他 `IChatClient` アダプターを出荷するすべてのバックエンドで動きます。

この記事では、実際の `Program.cs` でツール呼び出しを接続するところから始め、本番でループを安全に保つために決め手となる `FunctionInvokingChatClient` の設定 (`MaximumIterationsPerRequest`、`AllowConcurrentInvocation`、`IncludeDetailedErrors`、`MaximumConsecutiveErrorsPerRequest`、`TerminateOnUnknownCalls`) を扱い、ストリーミングの追加方法と、`ApprovalRequiredAIFunction` で危険なツールを明示的な承認の後ろに置く方法を説明し、最後に金曜の午後にモデルがツール呼び出しを間違えてはじめて学ぶ類の落とし穴で締めくくります。

## なぜ今 `Microsoft.Extensions.AI` がツール呼び出しの正しい入口なのか

**2025 年初頭の 9.x プレビュー波** までは、どのプロバイダーも独自のツール呼び出しプリミティブを出荷していました。OpenAI .NET SDK には `ChatTool.CreateFunctionTool` があり、Anthropic のコミュニティ SDK には独自の `Tool` レコードがあり、Azure は OpenAI ライブラリの上にやや違う形を載せ、Semantic Kernel は `[KernelFunction]` でその上に薄皮を被せていました。それぞれが固有のループを必要としました。モデルを呼ぶ、応答を覗く、関数呼び出しを探す、引数をデシリアライズする、.NET メソッドを実行する、結果メッセージを追加する、もう一度呼ぶ。間違えやすく、詳細が漏れやすく、アプリケーションコードが最初に選んだプロバイダーに縛られました。

`Microsoft.Extensions.AI` はそれを 1 つの抽象にまとめます。`Microsoft.Extensions.AI.Abstractions` パッケージは `IChatClient` を定義し、どのプロバイダーライブラリもこれを実装できます。`Microsoft.Extensions.AI` パッケージはその上で動くミドルウェア (関数呼び出し、テレメトリ、キャッシング、分散トレーシング、構造化出力のパース) を追加します。今日 OpenAI 向けに組み立てた同じ `IChatClient` は、明日コンストラクター 1 つの変更で Azure OpenAI やローカルの Ollama インスタンスに差し替えられ、`UseFunctionInvocation()` のステップは動きません。

もう 1 つ留めておく価値のある理由があります。このライブラリの関数呼び出しは単に「ツール定義を送って関数呼び出しをパースする」だけではありません。ミドルウェアは本物の `DelegatingChatClient` ([`FunctionInvokingChatClient`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.functioninvokingchatclient) を参照) で、保留中の呼び出しがなくなるか、設定した停止条件に達するまでループします。そのループは `CancellationToken` を尊重し、構造化エラーを表面化させ、呼び出し側が登録していない関数の実行を拒否します。安全なデフォルトは無料で手に入り、危険なノブはデフォルトでオフです。

## 具体的なシナリオ: OpenAI 上の注文照会ツール

この記事を通じて使う例は、`get_order_status(orderId)` というツールをモデルに公開し、「注文 1042 は出荷準備できてる?」のような質問をするコンソールアプリです。形はどんな内部 API や EF Core クエリにも一般化できます。

.NET 10 の新しいプロジェクトと最新安定版の Microsoft.Extensions.AI ビットから始めます。OpenAI プロバイダーパッケージは **Microsoft.Extensions.AI.OpenAI 10.5.1** で、公式 `OpenAI` SDK に依存し、`AsIChatClient()` アダプターを公開します。

```bash
# .NET 10, Microsoft.Extensions.AI 10.5.1, OpenAI 2.x
dotnet new console -o ToolCallingDemo
cd ToolCallingDemo
dotnet add package Microsoft.Extensions.AI --version 10.5.1
dotnet add package Microsoft.Extensions.AI.OpenAI --version 10.5.1
dotnet add package Microsoft.Extensions.Configuration
dotnet add package Microsoft.Extensions.Configuration.UserSecrets
dotnet user-secrets init
dotnet user-secrets set OpenAIKey sk-...
dotnet user-secrets set ModelName gpt-5
```

パイプラインは 3 行です。`OpenAIClient.GetChatClient(model).AsIChatClient()` が生の `IChatClient` を返します。これを `ChatClientBuilder` で包み `UseFunctionInvocation()` を呼ぶと、ループを処理する `IChatClient` が返ってきます。

```csharp
// Microsoft.Extensions.AI 10.5.1, .NET 10, OpenAI 2.x
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Configuration;
using OpenAI;

IConfigurationRoot config = new ConfigurationBuilder()
    .AddUserSecrets<Program>()
    .Build();

string model = config["ModelName"] ?? "gpt-5";
string apiKey = config["OpenAIKey"]!;

IChatClient client = new ChatClientBuilder(
        new OpenAIClient(apiKey).GetChatClient(model).AsIChatClient())
    .UseFunctionInvocation()
    .Build();
```

Azure OpenAI に切り替えるには内側のクライアントを変えるだけです。この行より下はまったく同じです。

```csharp
// Azure OpenAI バリアント。Microsoft.Extensions.AI.OpenAI 10.5.1 + Azure.AI.OpenAI 2.x。
using Azure;
using Azure.AI.OpenAI;

IChatClient client = new ChatClientBuilder(
        new AzureOpenAIClient(
            new Uri(config["AZURE_OPENAI_ENDPOINT"]!),
            new AzureKeyCredential(config["AZURE_OPENAI_API_KEY"]!))
        .GetChatClient(config["AZURE_OPENAI_GPT_NAME"]!).AsIChatClient())
    .UseFunctionInvocation()
    .Build();
```

## `AIFunctionFactory.Create` でツールを宣言する

`AIFunctionFactory.Create` は任意の `Delegate` を受け取り、そのパラメーターをリフレクションし、パラメーター型から JSON スキーマを生成し、`ChatOptions.Tools` に投入できる `AIFunction` を返します。スキーマはパラメーター名、型、`[Description]` 属性から構築されます。オプショナルパラメーターはスキーマでもオプショナルになります。Null 許容参照の注釈は Null 許容な JSON プロパティになります。

```csharp
// AIFunction はモデルが見る実行時の表現です。
// AIFunctionFactory.Create がスキーマ生成と呼び出し契約を処理します。
using System.ComponentModel;

ChatOptions chatOptions = new()
{
    Tools =
    [
        AIFunctionFactory.Create(
            ([Description("数値の注文 id、例: 1042")] int orderId,
             CancellationToken ct) => GetOrderStatus(orderId, ct),
            name: "get_order_status",
            description: "ある注文の現在の出荷状況を照会します。")
    ]
};

static async Task<string> GetOrderStatus(int orderId, CancellationToken ct)
{
    // EF Core、内部 API などを呼び出す。
    await Task.Delay(20, ct);
    return orderId == 1042
        ? "{\"status\":\"packed\",\"carrier\":\"UPS\",\"eta\":\"2026-05-05\"}"
        : "{\"status\":\"unknown\"}";
}
```

ここで起こっている見落としやすい点が 3 つあります。第一に、`CancellationToken` パラメーターは認識され、モデルに送られる JSON スキーマには決して現れません。ミドルウェアが呼び出し時にアクティブなトークンを注入するので、リクエストがキャンセルされると進行中のツール作業も実際にキャンセルされます。第二に、`[Description]` はスキーマのプロパティ上の `description` フィールドまで流れていきます。これはモデルが見るもので、ツールの選び方を左右します。第三に、JSON 文字列を返すのは問題ありませんが必須ではありません。ミドルウェアは任意の `Task<T>` の戻り値を、`ChatClientBuilder` で設定したオプションに従って `System.Text.Json` でシリアライズします。

複数の関連メソッドを持つクラスがある場合は、`Create` をインスタンスメソッドに向けるか、`MethodInfo` とターゲットオブジェクトを取るオーバーロードを使います。これによりスキーマ生成を失わずに構築を DI に置けます。

```csharp
public sealed class OrderTools(IOrderRepository repo)
{
    [Description("ある注文の現在の出荷状況を照会します。")]
    public Task<OrderStatus> GetOrderStatusAsync(
        [Description("数値の注文 id、例: 1042")] int orderId,
        CancellationToken ct) => repo.GetStatusAsync(orderId, ct);
}

OrderTools tools = serviceProvider.GetRequiredService<OrderTools>();

ChatOptions chatOptions = new()
{
    Tools = [AIFunctionFactory.Create(tools.GetOrderStatusAsync)]
};
```

会話を実行すると、ループは自分で回ります。

```csharp
List<ChatMessage> history =
[
    new(ChatRole.System, "あなたは内部運用アシスタントです。注文ツールを使って答えてください。"),
    new(ChatRole.User, "注文 1042 は出荷準備できてる?")
];

ChatResponse response = await client.GetResponseAsync(history, chatOptions);
Console.WriteLine(response.Text);
```

ユーザーが目にするのはただの普通の答えです。裏でミドルウェアがやったこと: リクエストを内側の OpenAI クライアントに転送し、応答中の `FunctionCallContent` を観測し、名前で一致する `AIFunction` を探し、引数をデシリアライズし、.NET メソッドを実行し、戻り値を `FunctionResultContent` にパッケージし、追加された履歴で内側のクライアントを再度呼び出します。そのループは、モデルがそれ以上呼び出しを行わないアシスタントメッセージを生成するまで繰り返されます。`ChatResponse.Messages` コレクションには、関数呼び出しとその結果を含む完全な中間履歴が入っており、次のターンをきれいに続けたいならこれを永続化するべきです。

Anthropic SDK を直接使って同様のループを駆動した経験があれば、これは [Claude API ストリーミングガイド](/ja/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) で説明されているのと同じ制御フローですが、ループはあなたのコードではなくライブラリのコードです。

## 本番で意味のある `FunctionInvokingChatClient` の設定

デフォルトは妥当ですが、障害モードは興味深いです。`UseFunctionInvocation()` が返す `IChatClient` は `FunctionInvokingChatClient` で、インスタンスを公開するオーバーロードで設定できます。

```csharp
IChatClient client = new ChatClientBuilder(
        new OpenAIClient(apiKey).GetChatClient(model).AsIChatClient())
    .UseFunctionInvocation(loggerFactory: null, configure: f =>
    {
        f.MaximumIterationsPerRequest = 5;
        f.MaximumConsecutiveErrorsPerRequest = 2;
        f.AllowConcurrentInvocation = false;
        f.IncludeDetailedErrors = false;
        f.TerminateOnUnknownCalls = true;
    })
    .Build();
```

`MaximumIterationsPerRequest` は、1 回の `GetResponseAsync` 呼び出しの中でモデルがツールと往復できる回数のハードキャップです。デフォルトは寛大すぎて、ふるまいの悪いモデルが諦めるまでに本物のお金を使い果たせます。5 はほとんどの内部ツールにとって妥当な上限です。10 を超えるならほぼ間違いなくプロンプトを設計し直すべきです。

`MaximumConsecutiveErrorsPerRequest` は、モデルがスローし続けるツールでループすることがあるために存在します。このキャップなしだと、バグのある DB 呼び出しが何でもないことのためにトークンを食いつぶせます。2 は安全な上限、最大でも 3 です。

`AllowConcurrentInvocation` はデフォルト `false` で、ツールがスレッドセーフであることを証明していない限りそのままにしておくべきです。この設定が制御するのは同じリクエスト内での同時呼び出しだけで、同じ `FunctionInvokingChatClient` インスタンスに対する並行リクエストは依然として同時にツールに当たり得るため、内部のメソッドは関係なくスレッドセーフにしてください。

`IncludeDetailedErrors` のデフォルトは `false` で、これは本番で正しい設定です。ツールがスローすると、ミドルウェアはサニタイズされたエラーをモデルに送り、どうするか決めさせます。開発のためにこれを `true` に切り替えるのは構いません。本番でオンのままにすると、スタックトレースをプロンプトに、そしてプロバイダーによってはプロバイダーのログに漏らします。

`TerminateOnUnknownCalls` は通常 `true` にすべきです。デフォルトの動作は不明な関数呼び出しをモデルにフィードバックするエラーとして扱い、これがモデルに自信を持って他の不明な呼び出しをでっちあげさせかねません。ループを終了させると会話の主導権が手元に戻ります。

## ツールが発火する中でのストリーミング応答

`UseFunctionInvocation()` は `GetStreamingResponseAsync` でも同じように動きます。ミドルウェアはストリームの関数呼び出し部分をバッファし、ツールを実行し、アシスタントのテキストのストリーミングを再開します。あなたはユーザー可視のチャンクだけを見ます。

```csharp
await foreach (ChatResponseUpdate chunk in
    client.GetStreamingResponseAsync(history, chatOptions))
{
    if (chunk.Text is { Length: > 0 } text)
    {
        Console.Write(text);
    }
}
```

知っておくべき運用上の詳細が 2 つあります。ミドルウェアはトークンの途中でツール結果を割り込ませません。呼び出しペイロード全体を待ってからツールを実行するので、ツール呼び出し中の遅延は短い停止に見えます。そして、複数のツール呼び出しが同時に飛んでいるストリーミングには `ChatOptions.AllowMultipleToolCalls` を明示的に設定する必要があります。これを `false` にすると、モデルは一度に 1 つのツールしか呼べなくなり、これらのツールが共有状態に触れる場合に正しいトレードオフになります。

## `ApprovalRequiredAIFunction` による人間関与

自動的に実行されてはならないツールもあります。書き込み、送信、課金を行うものはすべて明示的な承認の後ろに置くべきです。`AIFunction` を `ApprovalRequiredAIFunction` でラップすると、ミドルウェアはモデルの呼び出しを `ToolApprovalRequestContent` に置き換え、制御をあなたのコードに戻します。

```csharp
// Microsoft.Extensions.AI 10.5.1
AIFunction refundTool = AIFunctionFactory.Create(
    (string orderId, decimal amount) => IssueRefundAsync(orderId, amount),
    name: "issue_refund",
    description: "指定された注文に対して `amount` の返金を行います。");

ChatOptions chatOptions = new()
{
    Tools = [new ApprovalRequiredAIFunction(refundTool)]
};

ChatResponse response = await client.GetResponseAsync(history, chatOptions);

foreach (ChatMessage msg in response.Messages)
{
    foreach (AIContent c in msg.Contents)
    {
        if (c is ToolApprovalRequestContent approval)
        {
            // 人間に出して、次のリクエストで ToolApprovalResponseContent を
            // 返します。それまでループは一時停止します。
        }
    }
}
```

承認は単一の応答の範囲で粘着します。1 つのモデル応答内の任意の呼び出しが承認を必要とする場合、同じ応答からの他のすべてのツール呼び出しも、基となるツールが承認ゲートされていなくても承認リクエストとして表面化します。それが粗すぎる場合は、`ChatOptions.AllowMultipleToolCalls = false` を設定してモデルが一度に 1 つのツールしか呼べないようにし、承認を 1 つのツールにスコープしましょう。

## `AdditionalTools` によるパイプライン単位のツール

`ChatOptions.Tools` は呼び出し単位です。`FunctionInvokingChatClient.AdditionalTools` はパイプライン単位です。`get_current_time` ヘルパーやログ専用ツールのように、呼び出し側が渡す `ChatOptions` に関わらず常に利用可能であるべきツールには、後者を使ってください。

```csharp
IChatClient client = new ChatClientBuilder(...)
    .UseFunctionInvocation(configure: f =>
    {
        f.AdditionalTools =
        [
            AIFunctionFactory.Create(
                () => DateTimeOffset.UtcNow.ToString("O"),
                "get_current_time_utc",
                "現在の UTC 時刻を ISO 8601 で返します。")
        ];
    })
    .Build();
```

呼び出し単位のツールと追加ツールは両方ともリクエストに乗り、ミドルウェアは `FunctionCallContent` をどちらにも振り分けられます。アンビエントツールは小さく保ってください。登録されたすべてのツールのスキーマはリクエストごとに送られ、プロンプト予算に対してカウントされます。

## ミドルウェアの層: ロギング、キャッシュ、OpenTelemetry

`ChatClientBuilder` の要点は、ミドルウェアの順序が重要だということです。関数呼び出しは通常パイプラインの中間に座り、ロギングとトレーシングは外側、キャッシュは内側のクライアントに近い位置にあります。

```csharp
IChatClient client = new ChatClientBuilder(
        new OpenAIClient(apiKey).GetChatClient(model).AsIChatClient())
    .UseOpenTelemetry(loggerFactory, sourceName: "ToolCallingDemo")
    .UseFunctionInvocation()
    .UseDistributedCache(cache) // オプション。ツール呼び出しでない応答だけがキャッシュされる
    .Build();
```

`UseDistributedCache` はツール呼び出しを含む応答をキャッシュしません。これは唯一妥当な動作で、`FunctionCallContent` をキャッシュしてしまうとツールが短絡してしまうからです。モデルがテキストだけを返す素の Q&A ターンはキャッシュされ、繰り返しクエリで節約が効くのはまさにそこです。

トレーシングのセットアップをまだ選んでいない場合、`UseOpenTelemetry` ミドルウェアは標準の GenAI セマンティック規約を出力します。[.NET 11 のネイティブ OpenTelemetry トレーシング記事](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/) と同じ形なので、既存のダッシュボードは設定なしで拾います。

## 落とし穴を優先順位順に

ツール名は会話内の呼び出し間で安定していなければなりません。モデルは `FunctionCallContent` を `FunctionResultContent` にバインドするのに名前を使います。ターンの間にツールをリネームすると、保存された履歴のリプレイが壊れます。名前は snake_case、ASCII、短く保ちましょう。

JSON スキーマのドリフトは静かに噛みます。パラメーターを `int` から `int?` に変えると、スキーマが required から optional に切り替わり、モデルがそれを提供しなくなるかもしれません。シグネチャ変更の後は、生成されたスキーマを一度ログに記録し、前のバージョンと差分を取ってください。`AIFunction.JsonSchema` が現在の形を公開します。

`AIFunctionFactory.Create` はパラメーター型を eager にリフレクションします。キャプチャされた変数を閉じ込めたデリゲートを渡すと、スキーマは一度だけ構築されます。リクエストごとに `AIFunction` を再作成するのは安価ですが、キャッシュするならキャプチャされた状態がまだ有効か確かめてください。

DI 注入されたサービスを期待するツールメソッドは、クロージャ内ではなくメソッド内で解決すべきです。ミドルウェアはリクエスト間で再利用されることがあり、誤ったスコープからキャプチャされたスコープ付きサービスは古い `DbContext` や破棄された `HttpClient` として表面化します。DI で組み立てる `IChatClient` は、どう登録するかによって `ITransient` または `IScoped` です。基となる `FunctionInvokingChatClient` はスレッドセーフですが、あなたのツール依存を所有していません。

ツールが `null` を返したり例外を投げたりすると、モデルは例外ではなくエラーメッセージを含む構造化ツール結果を見ます。それで望ましいのですが、ツールが有用なエラーテキストを返すようにしてください。「Order not found」は `NullReferenceException` より良い。

プロバイダー固有のふるまいについては、レート制限に注意しましょう。`FunctionInvokingChatClient` はツール往復ごとにプロバイダー呼び出しを 1 回行うので、5 反復の制限は 1 つのユーザーメッセージに対して最大 5 回の受信リクエストになります。Anthropic と OpenAI のレートリミッターはそれを個別にカウントします。

## 関連記事

- [.NET 11 Minimal API から Claude API をストリーミングで呼び出す方法](/ja/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) - ループを自分で駆動したいときに有用な、低レベルなストリーミングパターン。
- [Microsoft Agent Framework 1.0: 純粋な C# で AI エージェントを構築する](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) - `IChatClient` の上に座り、メモリ、プランナー、マルチエージェントオーケストレーションを追加するエージェント SDK。
- [.NET 11 で C# によるカスタム MCP サーバーを構築する方法](/ja/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) - 同じ種類のツールを MCP 経由で公開し、.NET 以外のクライアントから呼べるようにします。
- [Generative AI for Beginners .NET v2: Microsoft.Extensions.AI で .NET 10 向けに再構築](/ja/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) - 完全なパイプラインを行使するエンドツーエンドのチュートリアル。
- [How to Migrate a Semantic Kernel Plugin to an MCP Server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/) - 既存のツールが `[KernelFunction]` クラスに住んでいる場合の移行経路。

## ソース

- [Microsoft.Extensions.AI ライブラリ概要、Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai)
- [クイックスタート: 関数を使って OpenAI を拡張し、.NET でローカル関数を実行する](https://learn.microsoft.com/en-us/dotnet/ai/quickstarts/use-function-calling)
- [`FunctionInvokingChatClient` API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.functioninvokingchatclient)
- [`AIFunctionFactory` API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.aifunctionfactory)
- [NuGet 上の Microsoft.Extensions.AI 10.5.1](https://www.nuget.org/packages/Microsoft.Extensions.AI/)
