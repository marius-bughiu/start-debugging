---
title: "Orleans 10.4: assinaturas de stream agora podem começar pela mensagem mais antiga em cache"
description: "O Orleans 10.4.0 adiciona StreamSubscriptionStartPosition.EarliestAvailable, para que um novo assinante de stream possa reprocessar o que ainda está no cache da fila do pulling agent. A versão também muda os IDs de argumentos RPC no wire, as métricas de latência de requisições e os scripts de persistência do SQLite."
pubDate: 2026-10-05
tags:
  - "orleans"
  - "dotnet"
  - "streaming"
  - "distributed-systems"
lang: "pt-br"
translationOf: "2026/10/orleans-10-4-stream-subscriptions-can-start-from-earliest-available"
translatedBy: "claude"
translationDate: 2026-10-05
---

O Orleans [v10.4.0](https://github.com/dotnet/orleans/releases/tag/v10.4.0) foi lançado em 3 de outubro de 2026. As notas da versão cobrem muita coisa (consistência de membership em todos os providers de clustering, cancellation tokens nas APIs do framework, codecs mais amigáveis a NativeAOT, Hot Reload opcional de serializadores), mas a mudança que a maior parte do código de aplicação vai tocar está em streaming: finalmente é possível dizer a uma assinatura sem token onde ela deve começar.

## O que um novo assinante costumava perder

Assinantes de streams persistentes no Orleans sempre tiveram dois modos. Passe um `StreamSequenceToken` e um provider rebobinável reprocessa a partir daquele ponto. Não passe nada e você recebe entrega ao vivo: o que chegar depois do handshake da assinatura. Tudo o que o pulling agent já tinha no cache da fila para aquele stream ficava invisível para você.

Essa lacuna pega num cenário comum: um grain é ativado em resposta ao primeiro evento de um stream, assina, e perde esse mesmo evento e qualquer outro que tenha chegado durante a ativação. A solução alternativa era rastrear os sequence tokens por conta própria, o que só funciona se você chegou a ver um token.

## Assinando com EarliestAvailable

O [PR #10936](https://github.com/dotnet/orleans/pull/10936) adiciona o enum `StreamSubscriptionStartPosition` com dois valores, `Latest` (o padrão, igual ao comportamento anterior) e `EarliestAvailable`, além de sobrecargas de `SubscribeAsync` para observers de item e de lote:

```csharp
using Orleans.Streams;

public sealed class OrderProjectionGrain : Grain, IOrderProjectionGrain, IAsyncObserver<OrderEvent>
{
    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var stream = this.GetStreamProvider("orders")
            .GetStream<OrderEvent>(StreamId.Create("orders", this.GetPrimaryKeyString()));

        await stream.SubscribeAsync(this, StreamSubscriptionStartPosition.EarliestAvailable);
    }

    public Task OnNextAsync(OrderEvent item, StreamSequenceToken? token = null) => Task.CompletedTask;
    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

`EarliestAvailable` começa, de forma inclusiva, na mensagem mais antiga que o cache local da fila ainda mantém para aquele `StreamId`. Se nada estiver retido, ele espera pela próxima mensagem. Ele não volta até o Event Hubs, o SQS ou as Azure Queues: o reprocessamento fica restrito ao cache, e os checkpoints dos receivers não são alterados.

A precedência é explícita: um sequence token concreto vence, depois a posição que você passar, depois o padrão do provider, e por fim `Latest`. O padrão do provider fica em `StreamPullingAgentOptions`, o que importa para código legado que assina sem nenhum argumento:

```csharp
siloBuilder.AddMemoryStreams("orders", streams =>
    streams.ConfigurePullingAgent(ob => ob.Configure(options =>
        options.InitialSubscriptionStartPosition =
            StreamSubscriptionStartPosition.EarliestAvailable)));
```

Os caches integrados pooled, simple e do Event Hubs oferecem suporte. Um `IQueueCache` personalizado sem suporte faz a assinatura falhar de forma determinística, em vez de recorrer silenciosamente à entrega ao vivo. Durante uma atualização gradual (rolling upgrade), só habilite isso depois que todos os silos que hospedam pulling agents estiverem na versão 10.4.0.

## Três notas de atualização que você não deve ignorar

A versão sinaliza estas mudanças de compatibilidade:

- **IDs de argumentos RPC**: atributos `[Id]` no nível de parâmetro agora controlam os IDs de argumentos serializados, e os IDs automáticos contam apenas parâmetros serializados. Se uma interface de grain usa `[Id]` em parâmetros ou coloca `CancellationToken` em qualquer posição que não seja a última, o formato no wire difere do 10.3.1. Atualize clientes e silos juntos ou versione o contrato.
- **Métricas**: a latência de requisições agora é um único `Histogram<double>` chamado `orleans-app-requests-latency`, em milissegundos fracionários, substituindo os instrumentos `-bucket`, `-count` e `-sum`. O `orleans-grains` usa a dimensão `grain_type` no lugar de `type`. Dashboards e alertas precisam ser atualizados.
- **Persistência SQLite**: execute novamente os scripts `Sqlite-Main.sql` e `Sqlite-Persistence.sql` da versão 10.4.0 em bancos de dados existentes. Eles são idempotentes e corrigem a atomicidade sob contenção de escrita.

A [documentação de posições iniciais de assinatura](https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/streaming/subscription-start-positions.md) traz a semântica completa, e as notas da versão listam as mudanças de journaling e Durable Jobs em preview que são publicadas como `10.4.0-alpha.1`.
