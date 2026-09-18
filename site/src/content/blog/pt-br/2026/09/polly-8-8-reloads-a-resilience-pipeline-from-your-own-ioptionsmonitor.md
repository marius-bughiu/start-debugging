---
title: "Polly 8.8 recarrega um resilience pipeline a partir do seu próprio IOptionsMonitor"
description: "O Polly 8.8.0 adiciona EnableReloadsWithMonitor, para que um resilience pipeline possa ser recarregado em tempo de execução a partir de um monitor de feature flags ou de configuração remota que não está registrado na DI. Um teste mostra a reconstrução, e uma armadilha: context.GetOptions ainda lê o monitor da DI e retorna valores padrão."
pubDate: 2026-09-18
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "configuration"
lang: "pt-br"
translationOf: "2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor"
translatedBy: "claude"
translationDate: 2026-09-18
---

O [Polly 8.8.0](https://github.com/App-vNext/Polly/releases/tag/8.8.0) saiu em 2026-09-14, e sua principal mudança é pequena, mas preenche uma lacuna real no `Polly.Extensions`. Até agora, a única forma de recarregar em tempo de execução um resilience pipeline registrado na DI era `context.EnableReloads<TOptions>()`, que resolve `IOptionsMonitor<TOptions>` a partir do container. Se as suas contagens de retry ou timeouts vêm de um SDK de feature flags, de um cliente de configuração remota ou de um monitor que você mesmo constrói, era preciso registrá-lo na DI antes ou abrir mão dos recarregamentos.

## A nova sobrecarga

O [PR #3140](https://github.com/App-vNext/Polly/pull/3140) adiciona `EnableReloadsWithMonitor<TOptions>(IOptionsMonitor<TOptions> monitor, string? name = null)` em `AddResiliencePipelineContext<TKey>`. O antigo `EnableReloads<TOptions>()` agora é uma única linha que resolve o monitor pela DI e chama o novo método. Os dois terminam no mesmo lugar: o registry se inscreve em `monitor.OnChange` e reconstrói o pipeline quando ele dispara.

Aqui está uma versão mínima, com um monitor feito à mão no lugar de um serviço de flags:

```csharp
var flags = new FlagMonitor<RetryFlags>(new RetryFlags { MaxRetries = 1 });

services.AddResiliencePipeline("orders", (builder, context) =>
{
    context.EnableReloadsWithMonitor(flags);

    var opts = flags.CurrentValue;
    builder.AddRetry(new() { MaxRetryAttempts = opts.MaxRetries, Delay = TimeSpan.Zero });
});

public sealed class FlagMonitor<T>(T initial) : IOptionsMonitor<T>
{
    private readonly List<Action<T, string?>> _listeners = [];
    public T CurrentValue { get; private set; } = initial;
    public T Get(string? name) => CurrentValue;

    public IDisposable OnChange(Action<T, string?> listener)
    {
        _listeners.Add(listener);
        return new Unsub(() => _listeners.Remove(listener));
    }

    public void Set(T value)
    {
        CurrentValue = value;
        foreach (var l in _listeners.ToArray()) l(value, Options.DefaultName);
    }

    private sealed class Unsub(Action a) : IDisposable { public void Dispose() => a(); }
}
```

Rodei isso como um app baseado em arquivo no SDK 10.0.302 com o `Polly.Extensions` 8.8.0. O pipeline sempre lança exceção, então a contagem de tentativas mostra qual configuração de retry está ativa:

```text
building pipeline with MaxRetries=1
attempts: 2
building pipeline with MaxRetries=4
attempts after change: 5
same instance: True
```

Depois de `flags.Set(...)`, o callback de configuração rodou de novo e a chamada seguinte fez cinco tentativas. O `ResiliencePipeline` obtido de `GetPipeline("orders")` continua sendo o mesmo objeto. O Polly troca o pipeline interno por trás dele, então o código que guardou o pipeline em um campo recebe a mudança sem precisar pedi-lo de novo. Na 8.7.0, o mesmo arquivo falha com CS1061, porque o método não existe lá.

## A armadilha do GetOptions

O callback de configuração também tem `context.GetOptions<TOptions>()`, e é tentador usá-lo junto com o novo método. Não faça isso. `GetOptions` ainda resolve `IOptionsMonitor<TOptions>` a partir do container, e `AddResiliencePipeline` registra a infraestrutura de options, então ele não lança exceção. Ele entrega uma instância criada com o construtor padrão. No teste, `context.GetOptions<RetryFlags>().MaxRetries` retornou `0` nos dois builds, enquanto o monitor personalizado dizia `1` e depois `4`. Um pipeline construído a partir desse valor teria parado de fazer retry silenciosamente.

Quando você passa o seu próprio monitor, leia os valores desse mesmo monitor (`flags.CurrentValue` ou `flags.Get(name)`) dentro do callback.

## Também na 8.8.0

O [PR #3220](https://github.com/App-vNext/Polly/pull/3220) corrige um bug do Simmy: um `FaultGenerator` vazio, ou um cujos pesos somam zero, lançava `InvalidOperationException: Nullable object must have a value` em vez de não injetar nada. O gerador agora retorna `null` e a estratégia de caos deixa a chamada passar. A versão também inclui trabalho de "preparação para o .NET 11" e a migração para o xunit v3 na suíte de testes.

Se você ainda precisa decidir se quer pipelines do Polly ou handlers do `Microsoft.Extensions.Http.Resilience`, [Polly vs resilience handlers no .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica os prós e contras.
