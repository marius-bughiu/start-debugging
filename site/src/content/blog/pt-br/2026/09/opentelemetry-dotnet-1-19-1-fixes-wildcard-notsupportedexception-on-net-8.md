---
title: "OpenTelemetry .NET 1.19.1 corrige o NotSupportedException de curingas no net8.0"
description: "O OpenTelemetry 1.19.0 passou a usar RegexOptions.NonBacktracking na regex de fontes com curingas, o que lança exceção no net8.0 quando você registra fontes suficientes. A 1.19.1, lançada em 2026-09-21, volta para uma regex compilada com timeout de correspondência."
pubDate: 2026-09-22
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8"
translatedBy: "claude"
translationDate: 2026-09-22
---

O [OpenTelemetry .NET 1.19.1](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.19.1) saiu em 2026-09-21, três dias depois da 1.19.0. Ele contém exatamente uma mudança relevante e, se o seu app tem como alvo `net8.0` e registra uma longa lista de activity sources ou meters, ela é a diferença entre um `TracerProvider` funcionando e um crash na inicialização.

## O que a 1.19.0 quebrou

O SDK transforma os nomes passados em `AddSource("...")` e `AddMeter("...")` em uma única regex sempre que pelo menos um deles contém `*` ou `?`. O [PR #7760](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7760), incorporado na 1.19.0, reforçou essa regex construindo-a com `RegexOptions.NonBacktracking` no .NET moderno. A intenção era boa: nada de backtracking catastrófico, não importa qual padrão acabe na lista.

O problema é que o engine sem backtracking compila o padrão em um autômato com um limite rígido de tamanho, e esse limite é de 1.000 nós no .NET 8 (10.000 no .NET 9 e posteriores). Um ramo de alternância por fonte se acumula rápido. A distribuição Grafana do OpenTelemetry, que pré-registra dezenas de fontes, bateu nele imediatamente, como relatado na [issue #7787](https://github.com/open-telemetry/opentelemetry-dotnet/issues/7787):

```text
System.NotSupportedException : The specified pattern with RegexOptions.NonBacktracking
could result in an automata as large as '1285' nodes, which is larger than the configured
limit of '1000'.
   at OpenTelemetry.WildcardHelper.GetWildcardRegex(IEnumerable`1 patterns)
   at OpenTelemetry.Trace.TracerProviderSdk..ctor(IServiceProvider serviceProvider, Boolean ownsServiceProvider)
```

Repare no gatilho: um único curinga em qualquer lugar da lista puxa todos os nomes de fontes para dentro da regex. Uma configuração como esta basta no `net8.0` quando a lista é longa o suficiente:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddSource("MyCompany.Orders", "MyCompany.Billing", "MyCompany.Shipping")
        .AddSource(internalSourceNames)   // a few hundred names from config
        .AddSource("AWSSDK.*")            // one wildcard switches on regex mode
        .AddOtlpExporter());
```

Builds para `net9.0`, `net10.0` e .NET Framework não eram afetados pela exceção. Mas não escapavam do custo: o PR observa que uma `Regex` sem backtracking retém cerca de 35x mais memória do que uma com backtracking, então suítes de teste e hosts que constroem muitos providers ao longo da vida do processo podiam esbarrar em `OutOfMemoryException`.

## O que a 1.19.1 faz no lugar

O [PR #7788](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7788) remove `NonBacktracking` em todos os target frameworks e volta para uma regex compilada, mantendo a proteção por meio de um timeout de correspondência:

```csharp
var pattern = "^(?:" + convertedPattern + ")$";

return new Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, RegexMatchTimeout);
// RegexMatchTimeout = TimeSpan.FromSeconds(1)
```

`WildcardHelper.IsMatch` captura `RegexMatchTimeoutException` e retorna `false`, então um padrão patológico significa que uma fonte deixa de ser escutada, e não uma thread travada. A mesma mudança vale para nomes de instrumentos com curingas em `AddView`, que também usava `NonBacktracking` no .NET moderno.

## Atualizando

Atualize todos os pacotes core do OpenTelemetry juntos, já que eles são versionados em sincronia:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.19.1
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

Se você está na 1.18.x, pode pular a 1.19.0 completamente. Se você já implantou a 1.19.0 no `net8.0` e ela não lançou exceção, você está abaixo do limite de nós hoje, mas adicionar mais algumas fontes depois teria disparado o erro na inicialização, então atualize mesmo assim. Para relembrar a configuração mais ampla, meu passo a passo sobre [usar OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) continua valendo sem alterações.

A lição mais ampla vale a pena guardar: `RegexOptions.NonBacktracking` não é um interruptor de segurança gratuito. Ele troca o risco de backtracking por um limite de tamanho do autômato e um consumo maior de memória, e no .NET 8 esse limite é pequeno o bastante para ser atingido com uma configuração comum.
