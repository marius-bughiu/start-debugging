---
title: "Microsoft.Extensions.AI 10.10 reprova métricas de avaliação que o juiz nunca pontuou"
description: "Microsoft.Extensions.AI.Evaluation.Quality 10.10.0 agora marca como falha as pontuações de qualidade que não podem ser interpretadas ou estão fora da faixa, e Microsoft.Extensions.AI.OpenAI 10.10.0 remove o adaptador de Assistants. Medido antes e depois, a partir do 10.9.0."
pubDate: 2026-09-15
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "testing"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics"
translatedBy: "claude"
translationDate: 2026-09-15
---

As [notas de versão do v10.10.0](https://github.com/dotnet/extensions/releases/tag/v10.10.0) do `dotnet/extensions` saíram em 14 de setembro de 2026 (os pacotes chegaram ao NuGet em 9 de setembro). A maior parte é infraestrutura, mas duas mudanças podem alterar o que o seu build faz: os avaliadores de qualidade agora falham de forma fechada, e o adaptador de Assistants da OpenAI foi removido. Se você condiciona o CI aos resultados de avaliação de IA, a primeira mudança pode deixar vermelho um pipeline verde, e esse é o resultado correto.

## Um juiz que não diz nada não conta mais como aprovação

`CoherenceEvaluator`, `FluencyEvaluator`, `RelevanceEvaluator` e o restante de `Microsoft.Extensions.AI.Evaluation.Quality` pedem a um LLM juiz uma pontuação de 1 a 5 e fazem a interpretação por conta própria. Até a 10.9.0, a interpretação só reprovava uma métrica quando o valor era convertido em um número abaixo de 4,0. Quando o juiz retornava texto sem pontuação, `metric.Value` era `null`, a classificação virava `Inconclusive` e `Failed` continuava `false`. Uma pontuação 6 seguia o mesmo caminho. Qualquer pipeline que verifica "algo falhou?" lia como verde uma métrica que nunca foi pontuada.

O [PR #7735](https://github.com/dotnet/extensions/pull/7735) (que corrige a [issue #7665](https://github.com/dotnet/extensions/issues/7665)) fecha essa brecha. Rodei o mesmo teste contra as duas versões, com um `IChatClient` de resposta fixa como juiz:

```csharp
var result = await new CoherenceEvaluator().EvaluateAsync(
    new ChatMessage(ChatRole.User, "What is 2+2?"),
    new ChatResponse(new ChatMessage(ChatRole.Assistant, "4")),
    new ChatConfiguration(new CannedJudge(reply)));

var m = result.Get<NumericMetric>(CoherenceEvaluator.CoherenceMetricName);
Console.WriteLine($"value={m.Value} rating={m.Interpretation?.Rating} failed={m.Interpretation?.Failed}");
```

| Resposta do juiz | 10.9.0 | 10.10.0 |
| --- | --- | --- |
| `<S2>5</S2>` | Exceptional, não falhou | Exceptional, não falhou |
| `<S2>3</S2>` | Average, falhou | Average, falhou |
| `<S2>6</S2>` | Inconclusive, **não falhou** | Inconclusive, falhou: "Coherence is outside the valid range." |
| "I am unable to evaluate this response." | Inconclusive, **não falhou** | Inconclusive, falhou: "Coherence has no score." |

Pontuações dentro da escala se comportam exatamente como antes, incluindo o limite de 4,0. O que muda é que um juiz instável, limitado por rate limit ou mal configurado agora aparece como falha em vez de se esconder atrás de uma aprovação. Se a sua execução noturna de repente reportar falhas depois da atualização, olhe primeiro o texto de `Reason`: "has no score" aponta para o modelo juiz, não para o seu app.

A correção se limita ao pacote Quality. O PR observa que `InterpretContentSafetyScore` e `InterpretContentHarmScore` do pacote Safety e a interpretação de pontuação do pacote NLP têm o mesmo formato e não foram alterados, então não presuma que esses já falham de forma fechada.

## O adaptador de Assistants foi removido, não descontinuado

A OpenAI desativou a Assistants API em 26 de agosto de 2026, e o [PR #7724](https://github.com/dotnet/extensions/pull/7724) removeu a superfície experimental correspondente de `Microsoft.Extensions.AI.OpenAI`: as duas sobrecargas de `AssistantClient.AsIChatClient(...)`, `OpenAIAssistantsChatClient` e `AsOpenAIAssistantsFunctionToolDefinition`. O pacote `OpenAI` 2.13.0 ainda inclui `AssistantClient`, então a atualização falha em tempo de compilação, e não no restore:

```text
error CS1929: 'AssistantClient' does not contain a definition for 'AsIChatClient' and the best extension method overload 'OpenAIClientExtensions.AsIChatClient(ResponsesClient, string?)' requires a receiver of type 'OpenAI.Responses.ResponsesClient'
```

O substituto é o cliente de Responses, com as instruções passando para `ChatOptions` e o id da conversa assumindo o lugar do id da thread. Isto compila contra a 10.10.0:

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

Como os endpoints já retornam erros, qualquer código que ainda seguia esse caminho estava quebrado em produção havia duas semanas. O erro de compilação só torna isso visível.

O restante da 10.10.0 é menor: `OpenAI` passa para a 2.13.0, valores de `detail` de imagem não suportados deixam de lançar `ArgumentNullException`, e o armazenamento de resultados no Azure Storage valida os segmentos de caminho. Se você adotou os clientes de roteamento do [Microsoft.Extensions.AI 10.9](/pt-br/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/), esta é uma atualização segura, desde que você esteja pronto para o gate de avaliação começar a dizer a verdade.
