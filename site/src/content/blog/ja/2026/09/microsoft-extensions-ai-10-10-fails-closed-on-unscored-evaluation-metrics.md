---
title: "Microsoft.Extensions.AI 10.10 はジャッジが採点しなかった評価メトリクスを失敗扱いにします"
description: "Microsoft.Extensions.AI.Evaluation.Quality 10.10.0 は解析できない品質スコアや範囲外の品質スコアを失敗としてマークするようになり、Microsoft.Extensions.AI.OpenAI 10.10.0 では Assistants アダプターが削除されました。10.9.0 との比較を実測しています。"
pubDate: 2026-09-15
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "testing"
  - "csharp"
lang: "ja"
translationOf: "2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics"
translatedBy: "claude"
translationDate: 2026-09-15
---

`dotnet/extensions` の [v10.10.0 リリースノート](https://github.com/dotnet/extensions/releases/tag/v10.10.0)が 2026 年 9 月 14 日に公開されました (パッケージ自体は 9 月 9 日に NuGet に登場しています)。大半は内部的な整備ですが、ビルドの挙動を変えうる変更が 2 つあります。品質エバリュエーターがフェイルクローズになったことと、OpenAI Assistants アダプターが削除されたことです。AI 評価の結果で CI をゲートしている場合、1 つ目の変更によって緑だったパイプラインが赤に変わることがありますが、それが正しい結果です。

## 何も答えないジャッジは合格として扱われなくなりました

`CoherenceEvaluator`、`FluencyEvaluator`、`RelevanceEvaluator` をはじめとする `Microsoft.Extensions.AI.Evaluation.Quality` のエバリュエーターは、LLM ジャッジに 1 から 5 のスコアを求め、その解釈を自分で行います。10.9.0 までは、値が 4.0 未満の数値として解析できた場合にしかメトリクスは失敗になりませんでした。ジャッジがスコアを含まないテキストを返すと、`metric.Value` は `null` になり、評価は `Inconclusive` となり、`Failed` は `false` のままでした。スコア 6 も同じ経路をたどりました。「何か失敗したか?」を確認するパイプラインは、一度も採点されていないメトリクスを緑として読み取っていたわけです。

[PR #7735](https://github.com/dotnet/extensions/pull/7735) ([issue #7665](https://github.com/dotnet/extensions/issues/7665) の修正) がこの穴を塞ぎます。固定の応答を返す `IChatClient` をジャッジにして、同じ検証コードを両方のバージョンで実行しました。

```csharp
var result = await new CoherenceEvaluator().EvaluateAsync(
    new ChatMessage(ChatRole.User, "What is 2+2?"),
    new ChatResponse(new ChatMessage(ChatRole.Assistant, "4")),
    new ChatConfiguration(new CannedJudge(reply)));

var m = result.Get<NumericMetric>(CoherenceEvaluator.CoherenceMetricName);
Console.WriteLine($"value={m.Value} rating={m.Interpretation?.Rating} failed={m.Interpretation?.Failed}");
```

| ジャッジの応答 | 10.9.0 | 10.10.0 |
| --- | --- | --- |
| `<S2>5</S2>` | Exceptional、失敗なし | Exceptional、失敗なし |
| `<S2>3</S2>` | Average、失敗 | Average、失敗 |
| `<S2>6</S2>` | Inconclusive、**失敗なし** | Inconclusive、失敗: "Coherence is outside the valid range." |
| "I am unable to evaluate this response." | Inconclusive、**失敗なし** | Inconclusive、失敗: "Coherence has no score." |

スケール内のスコアは、4.0 の境界も含めて以前とまったく同じように動作します。変わるのは、不安定なジャッジ、レート制限を受けたジャッジ、設定を誤ったジャッジが、合格の陰に隠れるのではなく失敗として表面化するようになる点です。アップグレード後に夜間実行で突然失敗が報告されるようになったら、まず `Reason` のテキストを確認してください。"has no score" はアプリではなくジャッジモデルに問題があることを示しています。

この修正は Quality パッケージに限定されています。PR には、Safety パッケージの `InterpretContentSafetyScore` と `InterpretContentHarmScore`、および NLP パッケージのスコア解釈も同じ構造を持っているものの手を付けていないと記載されているため、これらがすでにフェイルクローズになっているとは考えないでください。

## Assistants アダプターは非推奨ではなく削除されました

OpenAI は 2026 年 8 月 26 日に Assistants API を終了し、[PR #7724](https://github.com/dotnet/extensions/pull/7724) は `Microsoft.Extensions.AI.OpenAI` から対応する実験的な API を削除しました。削除されたのは `AssistantClient.AsIChatClient(...)` の 2 つのオーバーロード、`OpenAIAssistantsChatClient`、`AsOpenAIAssistantsFunctionToolDefinition` です。`OpenAI` 2.13.0 パッケージには引き続き `AssistantClient` が含まれているため、アップグレードは restore 時ではなくコンパイル時に失敗します。

```text
error CS1929: 'AssistantClient' does not contain a definition for 'AsIChatClient' and the best extension method overload 'OpenAIClientExtensions.AsIChatClient(ResponsesClient, string?)' requires a receiver of type 'OpenAI.Responses.ResponsesClient'
```

代わりに使うのは Responses クライアントで、指示は `ChatOptions` に移り、スレッド ID の役割は会話 ID が引き継ぎます。次のコードは 10.10.0 でコンパイルできます。

```csharp
IChatClient chat = new OpenAIClient(apiKey)
    .GetResponsesClient()
    .AsIChatClient("gpt-5-mini");

var options = new ChatOptions
{
    Instructions = "You are the support assistant for Contoso.",
    ConversationId = conversationId, // previous response id, replaces the thread id
};

ChatResponse response = await chat.GetResponseAsync("Where is my order?", options);
```

エンドポイントはすでにエラーを返しているので、まだその経路を使っているコードは 2 週間前から本番環境で壊れていたことになります。コンパイルエラーはそれを目に見えるようにするだけです。

10.10.0 のその他の変更は小規模です。`OpenAI` が 2.13.0 に上がり、サポートされていない画像の `detail` 値で `ArgumentNullException` がスローされなくなり、Azure ストレージの結果ストアがパスセグメントを検証するようになりました。[Microsoft.Extensions.AI 10.9](/ja/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/) のルーティングクライアントを導入済みであれば、評価ゲートが正直な結果を報告し始めることへの備えさえできていれば、安全にバージョンを上げられます。
