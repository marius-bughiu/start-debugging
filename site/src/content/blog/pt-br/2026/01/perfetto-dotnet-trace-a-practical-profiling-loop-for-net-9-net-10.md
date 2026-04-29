---
title: "Perfetto + dotnet-trace: um ciclo prático de profiling para .NET 9/.NET 10"
description: "Um ciclo prático de profiling para .NET 9 e .NET 10: capture traces com dotnet-trace, visualize-os no Perfetto e itere sobre problemas de CPU, GC e thread pool."
pubDate: 2026-01-21
updatedDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
  - "performance"
lang: "pt-br"
translationOf: "2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
A forma mais rápida de destravar um "está lento" em .NET é parar de adivinhar e começar a olhar para uma linha do tempo. Um artigo que está circulando esta semana mostra um fluxo limpo: capturar traces com `dotnet-trace` e depois inspecioná-los no Perfetto (o mesmo ecossistema de visualizador de traces que muitos conhecem do mundo Android e Chromium): [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/).

## Por que vale a pena adicionar o Perfetto à sua caixa de ferramentas

Se você já usa `dotnet-counters` ou um profiler, o Perfetto não é um substituto. É um complemento:

-   Você obtém uma linha do tempo visual que torna muito mais fácil raciocinar sobre problemas de concorrência (picos de thread pool, sintomas de contenção de locks, cascatas assíncronas).
-   Você pode compartilhar um arquivo de trace com outro engenheiro sem pedir que ele instale sua IDE ou seu profiler comercial.

Para aplicações .NET 9 e .NET 10 isso é especialmente útil quando você está tentando validar que uma mudança "pequena" não introduziu acidentalmente alocações extras, threads extras ou um novo gargalo de sincronização.

## O ciclo de captura (reproduzir primeiro, traçar depois)

O truque é tratar o tracing como um ciclo, não como uma ação isolada:

-   Torne a lentidão reproduzível (mesmo endpoint, mesmo payload, mesmo dataset).
-   Capture de 10 a 30 segundos em torno da janela de interesse.
-   Inspecione, formule uma hipótese, mude uma coisa, repita.

Esta é a sequência mínima de captura usando a ferramenta global:

```bash
dotnet tool install --global dotnet-trace

# Find the PID of the target process (pick one)
dotnet-trace ps

# Capture an EventPipe trace (default providers are usually a good starting point)
dotnet-trace collect --process-id 12345 --duration 00:00:15 --output app.nettrace
```

Você terminará com `app.nettrace`. A partir daí, siga os passos de conversão/abertura do artigo original (o caminho exato para "abrir no Perfetto" depende de qual Perfetto UI você usa e qual passo de conversão escolher).

## O que procurar quando abrir o trace

Comece por perguntas que você pode responder em minutos:

-   **Uso de CPU**: Você está CPU-bound (métodos quentes) ou esperando (bloqueio, sleep, I/O)?
-   **Comportamento do thread pool**: Você vê rajadas de worker threads que se correlacionam com picos de latência?
-   **Correlação com GC**: As janelas de pausa coincidem com a requisição lenta ou apenas com atividade de fundo?

Quando encontrar uma janela suspeita, volte ao código e aplique uma mudança cirúrgica (por exemplo: reduzir alocações, evitar sync-over-async, remover um lock do hot path da requisição ou agrupar chamadas caras).

## Um padrão pragmático: traçar em Release sem perder símbolos

Se possível, execute o caminho lento em Release (mais próximo de produção), mas mantenha informação suficiente para raciocinar sobre os frames. Em projetos SDK-style, os PDBs são gerados por padrão; para uma sessão de profiling você normalmente quer caminhos de saída previsíveis:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Configuration>Release</Configuration>
    <DebugType>portable</DebugType>
  </PropertyGroup>
</Project>
```

Mantenha tudo previsível: entrada estável, configuração estável, traces curtos, repita.

Se quiser os passos detalhados do Perfetto e capturas de tela, o artigo original é a melhor referência para deixar aberta enquanto roda o ciclo: [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/).
