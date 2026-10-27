---
title: "Polly 8.8.1: o circuit breaker não mantém mais vivos os valores AsyncLocal do primeiro chamador"
description: "O Polly.Core 8.8.1 inicia o loop em segundo plano do circuit breaker sob ExecutionContext.SuppressFlow, então um pipeline de vida longa deixa de prender os valores AsyncLocal de quem o construiu. Uma reprodução de 15 linhas mostra o vazamento na 8.8.0 e a correção na 8.8.1."
pubDate: 2026-10-27
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "memory-leaks"
lang: "pt-br"
translationOf: "2026/10/polly-8-8-1-circuit-breaker-no-longer-keeps-the-first-callers-asynclocal-values-alive"
translatedBy: "claude"
translationDate: 2026-10-27
---

O [Polly 8.8.1](https://github.com/App-vNext/Polly/releases/tag/8.8.1) saiu em 2026-10-26, e a correção principal é um vazamento de memória fácil de ter sem perceber. Toda estratégia de circuit breaker construída com o Polly.Core 8.8.0 ou anterior mantinha vivo o `ExecutionContext` do código que a construiu durante toda a vida do pipeline. Isso inclui cada valor `AsyncLocal<T>` que estivesse definido naquele momento.

## Por que um circuit breaker capturava o seu contexto

O circuit breaker usa um `ScheduledTaskExecutor` interno para executar seus callbacks de mudança de estado (`OnOpened`, `OnClosed`, `OnHalfOpened`) fora do caminho crítico. O construtor dele iniciava um loop de processamento com `Task.Run(StartProcessingAsync)`. O `Task.Run` propaga o `ExecutionContext` atual por padrão, e o loop então aguarda em um `SemaphoreSlim` até o pipeline ser descartado.

Ou seja, quem quer que disparasse a construção doava seu estado ambiente para uma tarefa que nunca termina. Para um pipeline em um `ResiliencePipelineRegistry`, ou um que o `Microsoft.Extensions.Http.Resilience` constrói para um `HttpClient` nomeado, "a vida do pipeline" significa a vida da aplicação. A [issue #3275](https://github.com/App-vNext/Polly/issues/3275) descreve o pior caso: em uma aplicação Blazor Server, o circuito do primeiro usuário constrói o pipeline, um accessor baseado em `AsyncLocal` carrega os serviços desse circuito, e o circuito nunca é coletado depois que o usuário sai.

## Reproduzindo em uma aplicação baseada em arquivo

Isto roda como está com `dotnet run repro.cs` no SDK do .NET 10. Troque a versão do pacote para comparar:

```csharp
#:package Polly.Core@8.8.0
using System.Runtime.CompilerServices;
using Polly;

AsyncLocal<object?> current = new();

var (pipeline, value) = Build();
for (int i = 0; i < 3; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
GC.KeepAlive(pipeline);
Console.WriteLine($"alive: {value.IsAlive}");

[MethodImpl(MethodImplOptions.NoInlining)]
(ResiliencePipeline, WeakReference) Build()
{
    object payload = new byte[1024];
    current.Value = payload; // whatever the first caller's flow carries
    var p = new ResiliencePipelineBuilder().AddCircuitBreaker(new()).Build();
    current.Value = null;
    return (p, new WeakReference(payload));
}
```

Na minha máquina (SDK 10.0.302), `Polly.Core@8.8.0` imprime `alive: True` e `Polly.Core@8.8.1` imprime `alive: False`. Limpar o `AsyncLocal` depois não ajuda na 8.8.0, porque a tarefa em segundo plano guarda um snapshot do contexto tirado quando ela começou, não uma visão ao vivo dele.

## A correção

O [PR #3284](https://github.com/App-vNext/Polly/pull/3284) tem três linhas:

```csharp
public ScheduledTaskExecutor()
{
    using (ExecutionContext.SuppressFlow())
    {
        ProcessingTask = Task.Run(StartProcessingAsync);
    }
}
```

Há uma mudança de comportamento que você precisa conhecer: seus callbacks de mudança de estado não veem mais os valores `AsyncLocal` de quem construiu o pipeline. Eles nunca viram de forma confiável os valores da requisição que de fato disparou o breaker, apenas os do código que construiu o pipeline. Se você dependia disso, por exemplo lendo `Activity.Current` ou um accessor de tenant dentro do `OnOpened`, passe o que precisar pelo `ResilienceContext` ou pelos argumentos do callback.

## O que fazer

Atualize o `Polly.Core` (e o `Polly.Extensions`, se você o referencia diretamente) para 8.8.1. O `Microsoft.Extensions.Http.Resilience` traz o Polly de forma transitiva, então adicione uma referência explícita se o seu arquivo de lock ainda estiver na 8.8.0:

```xml
<PackageReference Include="Polly.Core" Version="8.8.1" />
```

Se você ainda não puder atualizar, o contorno da issue é construir os pipelines antecipadamente na inicialização dentro de `ExecutionContext.SuppressFlow()`, antes que qualquer requisição possa ser a que os constrói.

A mesma versão também acelera a execução de pipelines ([#3287](https://github.com/App-vNext/Polly/pull/3287)) e corrige uma falha de limpeza relacionada no registry ([#3288](https://github.com/App-vNext/Polly/pull/3288)): quando dois chamadores disputavam a inicialização da mesma chave, o pipeline perdedor era descartado mas mantinha seus recursos e registros de recarga. Agora ele passa pelo mesmo caminho de descarte assíncrono que as recargas usam, o que importa se você adotou o [`EnableReloadsWithMonitor` do Polly 8.8](/pt-br/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/).
