---
title: "Microsoft.Extensions.AI 10.9 traz clientes de chat com roteamento e failover"
description: "O Microsoft.Extensions.AI 10.9.0 adiciona RoutingChatClient, OrderedFailoverChatClient e SemanticRoutingChatClient. Verificado contra o pacote real: o que faz failover, o que não faz, e por que o MEAI001 quebra a sua compilação."
pubDate: 2026-08-14
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "resilience"
  - "csharp"
lang: "pt-br"
translationOf: "2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients"
translatedBy: "claude"
translationDate: 2026-08-14
---

Em 2026-08-13 o time do .NET publicou [Routing and Failover for Microsoft.Extensions.AI](https://devblogs.microsoft.com/dotnet/routing-and-failover-for-microsoft-extensions-ai/). O ponto interessante é que os tipos já estão no NuGet dentro do `Microsoft.Extensions.AI` 10.9.0, então você pode usá-los hoje. Até agora, enviar uma requisição para um modelo barato e cair para um maior significava escrever na mão um wrapper `try`/`catch` em volta do `IChatClient`. Agora existem quatro tipos que fazem isso: `RoutingChatClient` e `RoutingContext` no `Microsoft.Extensions.AI.Abstractions`, mais `FailoverChatClient`, `OrderedFailoverChatClient` e `SemanticRoutingChatClient` no `Microsoft.Extensions.AI`.

## Uma lista ordenada de clientes agora são duas linhas

O `OrderedFailoverChatClient` percorre uma lista até que um deles funcione. O construtor é `(IReadOnlyList<IChatClient> clients, bool leaveOpen = false)`, então passe `leaveOpen: true` quando o contêiner for o dono dos clientes internos:

```csharp
using var failover = new OrderedFailoverChatClient(
    [primaryClient, backupClient, lastResortClient],
    leaveOpen: true);

ChatResponse response = await failover.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "hi")]);
```

Se todos os clientes lançarem exceção, você recebe a última, não uma agregada. Vale saber disso antes de escrever um bloco `catch` que espera `AggregateException`.

## A regra de streaming que vai te pegar

O failover não é de graça em chamadas de streaming. O laço de retentativa só seleciona outro cliente enquanto nada tiver sido entregue a quem chamou. Rodei três casos contra um cliente falso para confirmar:

- Cliente primário sem streaming lança exceção: o `SelectClientAsync` roda de novo, o cliente reserva responde e quem chamou nunca vê a falha.
- Cliente primário com streaming lança exceção antes do primeiro `ChatResponseUpdate`: mesma coisa, uma troca limpa para o reserva.
- Cliente primário com streaming lança exceção depois de já ter emitido duas atualizações: a exceção aparece no meio da enumeração e os dois trechos parciais ficam consumidos.

Esse terceiro caso é o que exige cuidado no design. Assim que `FailoverChatClientAttempt.OutputCommitted` for `true`, não existe recuperação no meio do stream, então uma interface que vai anexando tokens conforme eles chegam precisa do próprio tratamento de truncamento.

## Roteando por custo, ou por significado

Para qualquer coisa que não seja uma lista ordenada, o `RoutingChatClient.Create` recebe um callback:

```csharp
using var router = RoutingChatClient.Create((context, ct) =>
    new ValueTask<IChatClient>(
        context.Messages.Last().Text.Length > 20 ? powerfulClient : cheapClient));
```

O `RoutingContext` expõe apenas `Messages` e `ChatOptions`, o que já basta para rotear por `AdditionalProperties` em sessões fixas. Herde de `FailoverChatClient` se você também quiser o laço de retentativa, e defina `MaximumAttemptsPerRequest` (um `int?`) para limitá-lo.

O `SemanticRoutingChatClient` escolhe por similaridade de embeddings. A assinatura completa tem mais opções do que o artigo original mostra:

```csharp
SemanticRoutingChatClient(
    IEmbeddingGenerator<string, Embedding<float>> embeddingGenerator,
    IReadOnlyDictionary<IChatClient, IReadOnlyList<string>> clientProfiles,
    IChatClient defaultClient,
    float scoreThreshold = 0.3f,
    int topK = 1,
    ScoreAggregation scoreAggregation = ScoreAggregation.Mean,
    bool leaveOpen = false)
```

`ScoreAggregation` é `Mean` ou `Sum`, e tudo que ficar abaixo de `scoreThreshold` cai no `defaultClient`.

## MEAI001 é erro, não aviso

Todos esses tipos carregam `[Experimental("MEAI001")]`, e o compilador trata isso como erro por padrão:

```
error MEAI001: 'Microsoft.Extensions.AI.OrderedFailoverChatClient' is for evaluation
purposes only and is subject to change or removal in future updates.
```

Adicione `<NoWarn>MEAI001</NoWarn>` ao seu csproj para aceitar. Como o formato da API ainda está mudando, mantenha a decisão de roteamento atrás da sua própria interface. Se você ainda está no SDK bruto do provedor, a [migração para o Microsoft.Extensions.AI](https://startdebugging.net/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/) é o pré-requisito para tudo isso.
