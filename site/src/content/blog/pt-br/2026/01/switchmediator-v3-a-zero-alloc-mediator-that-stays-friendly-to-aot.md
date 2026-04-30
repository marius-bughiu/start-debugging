---
title: "SwitchMediator v3: um mediator com zero alocações que continua amigável a AOT"
description: "O SwitchMediator v3 mira em dispatch sem alocações e amigável a AOT para serviços CQRS em .NET 9 e .NET 10. Veja o que isso significa e como medir o seu próprio mediator."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot"
translatedBy: "claude"
translationDate: 2026-04-30
---
Se você já fez profile de uma base de código CQRS "limpa" e descobriu morte por mil alocações na camada do mediator, vale a pena olhar o lançamento de hoje do **SwitchMediator v3**. O autor menciona explicitamente comportamento **sem alocações** e **amigável a AOT**, que é exatamente a combinação que você quer em serviços .NET 9 e .NET 10 que se importam com latência.

## Onde implementações típicas de mediator vazam alocações

Existem alguns padrões comuns que alocam silenciosamente:

-   **Boxing e dispatch via interface**: especialmente quando os handlers são guardados como `object` e convertidos a cada requisição.
-   **Listas de pipeline behaviors**: alocando enumeradores, closures e listas intermediárias.
-   **Descoberta de handlers por reflexão**: prática, mas combina mal com trimming e native AOT.

Um mediator amigável a AOT geralmente faz o oposto: torna o registro de handlers explícito e mantém a lógica de dispatch baseada em tipos genéricos conhecidos, não em reflexão em tempo de execução.

## Um pequeno harness de benchmark "antes vs depois"

Mesmo que você não adote o SwitchMediator, vale fazer benchmark da fronteira do seu mediator. Este é um harness mínimo que você pode colocar em um app de console mirando **.NET 10** para entender a sua linha de base.

```cs
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

public static class Program
{
    public static void Main() => BenchmarkRunner.Run<MediatorBench>();
}

public sealed record Ping(int Value);
public sealed record Pong(int Value);

public interface IMediator
{
    ValueTask<Pong> Send(Ping request, CancellationToken ct = default);
}

public sealed class MediatorBench
{
    private readonly IMediator _mediator = /* wire your mediator here */;

    [Benchmark]
    public async ValueTask<Pong> SendPing() => await _mediator.Send(new Ping(123));
}
```

O que eu procuro:

-   **Bytes alocados por operação** devem ficar perto de zero para requisições triviais.
-   **Throughput** deve escalar com o trabalho do handler, não com o overhead do dispatch.

Se você vir alocações no caminho do dispatch, normalmente dá para encontrá-las trocando o tipo de retorno para `ValueTask` (como acima) e mantendo os tipos de request/response como records ou structs previsíveis para o JIT.

## Amigável a AOT geralmente significa "explícito"

Se você está experimentando native AOT em **.NET 10**, mediators carregados de reflexão são uma das primeiras coisas a quebrar.

O trade-off arquitetural é simples:

-   **Scanning por reflexão**: ótima experiência de desenvolvedor, história fraca de trimming/AOT.
-   **Registro explícito**: um pouco mais de setup, mas previsível e amigável a trimming.

A proposta do SwitchMediator sugere que ele se inclina para a ponta explícita do espectro. Isso bate com a forma como eu encaro trabalho de desempenho: aceito algumas linhas a mais de fiação se elas me dão comportamento previsível em produção.

Se quiser os detalhes, comece pela thread do anúncio e siga o link do repositório a partir dela: [https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator\_v3\_is\_out\_now\_a\_zeroalloc/](https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator_v3_is_out_now_a_zeroalloc/)
