---
title: "StackExchange.Redis 3.3 sai de um nó Redis antes que o servidor derrube você"
description: "O StackExchange.Redis 3.3.0 adiciona notificações de manutenção opcionais (smart client handoffs) para Redis Enterprise, Redis Cloud e Azure Managed Redis: timeouts relaxados durante migrações, releitura da topologia e uma troca proativa antes que um endpoint desapareça. Veja como ativar o recurso e o erro SER010 que você vai encontrar primeiro."
pubDate: 2026-09-23
tags:
  - "redis"
  - "stackexchange-redis"
  - "dotnet"
  - "resilience"
lang: "pt-br"
translationOf: "2026/09/stackexchange-redis-3-3-smart-client-handoffs"
translatedBy: "claude"
translationDate: 2026-09-23
---

O [StackExchange.Redis 3.3.0](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.0) foi lançado em 18 de setembro de 2026, seguido pelo [3.3.1](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.1) em 22 de setembro. O recurso principal são as notificações de manutenção nativas do servidor, que outros clientes Redis chamam de "smart client handoffs" ou "hitless upgrades". Redis Enterprise e Redis Cloud agora conseguem avisar o cliente .NET de que um shard está migrando, de que um nó está passando por failover ou de que o endpoint ao qual ele está conectado está prestes a ser substituído, e o cliente reage a isso em vez de esperar um socket morrer.

Se você já viu uma rajada de `RedisTimeoutException` durante uma janela de manutenção de um Redis gerenciado, esta é a correção para essa classe de problema.

## O que o cliente faz com cada notificação

As notificações chegam como frames push do RESP3 na mesma conexão que transporta seus comandos. Segundo as [notas de design no PR #3191](https://github.com/StackExchange/StackExchange.Redis/pull/3191), o cliente reage sem nenhum código da sua parte:

- `MIGRATING`, `FAILING_OVER`, `SMIGRATING`: os timeouts de comando naquele servidor são relaxados (10 segundos por padrão, `maintRelaxedTimeout`).
- `MIGRATED`, `FAILED_OVER`: a janela se fecha, com uma breve cauda relaxada enquanto as coisas se estabilizam.
- `SMIGRATED`: a topologia do cluster é relida e as assinaturas fragmentadas cujos slots mudaram de lugar são refeitas.
- `MOVING`: o cliente pede o endereço substituto, drena o trabalho em andamento e troca a conexão antes que o servidor a feche.

Esta última é a mais importante. O autor mediu que o DNS fica de 4 a 19 segundos atrás de uma notificação `MOVING`, enquanto o servidor fecha o socket antigo por volta de 16 a 19 segundos. Ao pedir que o servidor informe o endpoint substituto (`maintMovingEndpointType=Auto`, o padrão), o handoff vira uma troca direta que termina em menos de um segundo.

## Ativando o recurso no 3.3

Por enquanto o recurso é opcional, mesmo quando você se conecta a um hostname reconhecido de Redis Cloud ou Azure Managed Redis. A [documentação](https://seredis.dev/ServerMaintenanceEvent) diz que a ativação automática para esses provedores está planejada para uma versão futura. O caminho pela connection string é o mais simples:

```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync(
    "my-redis.example.com:6379,maintNotifications=Auto,maintRelaxedTimeout=15");
```

A API fortemente tipada está marcada como experimental, e no 3.3.1 isso é um erro de compilação, não um aviso:

```text
error SER010: 'StackExchange.Redis.ConfigurationOptions.MaintenanceNotifications' is for
evaluation purposes only and is subject to change or removal in future updates.
```

Suprima o erro explicitamente se você quiser a propriedade e os tipos de evento:

```csharp
#pragma warning disable SER010
using StackExchange.Redis;
using StackExchange.Redis.Maintenance;

var options = ConfigurationOptions.Parse("my-redis.example.com:6379");
options.MaintenanceNotifications = MaintenanceNotificationMode.Auto;

var muxer = await ConnectionMultiplexer.ConnectAsync(options);
muxer.ServerMaintenanceEvent += (_, e) =>
{
    if (e is PushMaintenanceEvent m)
        Console.WriteLine($"{m.NotificationType} seq {m.SequenceId} from {m.EndPoint}");
};
```

`MaintenanceNotificationMode` tem três valores. `Disabled` é o padrão atual. `Auto` faz a solicitação durante o handshake e segue em frente se o servidor recusar. `Enabled` rejeita a conexão se as notificações não puderem ser entregues, inclusive quando a conexão cai em RESP2, o que o torna uma forma útil de provar que o recurso está ativo em staging.

## Duas coisas para verificar antes de colocar em produção

O RESP3 é obrigatório. `protocol=resp2`, um `defaultVersion` abaixo de 6.0 ou desativar `HELLO` no command map desligam o recurso silenciosamente no modo `Auto`.

Um handoff deliberado também aparece como um evento `ConnectionFailed` com `FailureType == ConnectionFailureType.MaintenanceHandoff`. Se você tem alertas em `ConnectionFailed`, filtre esse valor ou seu pager vai disparar a cada manutenção planejada.

Uma mudança não é opcional: o 3.3.0 adiciona `topologyRefreshSeconds`, que relê a topologia a cada 30 minutos por padrão (com jitter, `0` desativa). Ela existe para endpoints que ainda respondem a um handshake, mas não pertencem mais ao deployment.

Se o Redis já fica atrás do seu `HybridCache`, veja [como usar HybridCache no ASP.NET Core 11 com Redis como cache L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/). Adicionar `maintNotifications=Auto` a essa connection string é o upgrade de resiliência mais barato que você vai fazer este mês.
