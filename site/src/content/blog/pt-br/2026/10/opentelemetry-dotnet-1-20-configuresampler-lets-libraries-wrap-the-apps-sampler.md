---
title: "OpenTelemetry .NET 1.20: ConfigureSampler permite que bibliotecas envolvam o sampler do app"
description: "O OpenTelemetry .NET 1.20.0, lançado em 15 de outubro de 2026, adiciona TracerProviderBuilder.ConfigureSampler. Agora uma biblioteca pode envolver o sampler que o SDK resolveu a partir de SetSampler, OTEL_TRACES_SAMPLER ou do padrão, em vez de sobrescrevê-lo silenciosamente."
pubDate: 2026-10-19
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "tracing"
lang: "pt-br"
translationOf: "2026/10/opentelemetry-dotnet-1-20-configuresampler-lets-libraries-wrap-the-apps-sampler"
translatedBy: "claude"
translationDate: 2026-10-19
---

O [OpenTelemetry .NET 1.20.0](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.20.0) foi lançado em 15 de outubro de 2026. A maior parte do changelog são correções (um vazamento de contagem de referências em `SuppressInstrumentationScope`, `ResourceBuilder.CreateDefault` ignorando `OTEL_SERVICE_NAME`, duas condições de corrida em métricas), mas uma nova API muda a forma como bibliotecas e distros devem lidar com amostragem: `TracerProviderBuilder.ConfigureSampler`.

## SetSampler sempre foi "o último a escrever vence"

Até a 1.19.x, a única forma de influenciar o sampler de traces era `SetSampler`. Um sampler programático tem prioridade sobre a variável de ambiente `OTEL_TRACES_SAMPLER`, que tem prioridade sobre o padrão `ParentBased(AlwaysOnSampler)`. Essa precedência funciona bem para o código da aplicação, mas é hostil para bibliotecas. Um pacote que quisesse descartar seus próprios spans ruidosos tinha que chamar `SetSampler`, e no momento em que fazia isso, o `OTEL_TRACES_SAMPLER=traceidratio` do operador era registrado como ignorado e descartado. Duas bibliotecas fazendo a mesma coisa entravam em conflito silenciosamente: a que se registrasse por último vencia.

## O que ConfigureSampler faz

O [PR #7780](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7780) adiciona um callback que recebe o sampler que o SDK já resolveu e retorna o que será usado:

```csharp
public static TracerProviderBuilder ConfigureSampler(
    this TracerProviderBuilder tracerProviderBuilder,
    Func<IServiceProvider, Sampler, Sampler> configureSampler);
```

As regras, segundo a documentação XML:

- Os callbacks são executados depois que o SDK escolhe um sampler a partir de `SetSampler`, `OTEL_TRACES_SAMPLER` ou do padrão, independentemente de serem registrados antes ou depois de `SetSampler`.
- Cada callback é executado uma vez, durante `Build()`. O sampler do provider permanece imutável depois disso.
- Vários callbacks são encadeados na ordem de registro, cada um recebendo o resultado do anterior.
- Retornar `null` ou lançar uma exceção faz o build do provider falhar.

Assim, uma biblioteca pode decorar o que o app configurou em vez de substituí-lo:

```csharp
public sealed class DropPollingSpansSampler(Sampler inner) : Sampler
{
    public override SamplingResult ShouldSample(in SamplingParameters parameters)
    {
        // The library's background poll loop creates a span every second.
        if (parameters.Name == "MyLibrary.Poll")
        {
            return new SamplingResult(SamplingDecision.Drop);
        }

        return inner.ShouldSample(parameters);
    }
}

public static class MyLibraryTracingExtensions
{
    public static TracerProviderBuilder AddMyLibrary(this TracerProviderBuilder builder) =>
        builder
            .AddSource("MyLibrary")
            .ConfigureSampler((_, resolved) => new DropPollingSpansSampler(resolved));
}
```

Com `OTEL_TRACES_SAMPLER=traceidratio` e `OTEL_TRACES_SAMPLER_ARG=0.1` definidos, o app continua amostrando 10% dos traces, e a biblioteca apenas descarta seus spans de polling antes dessa decisão. Troque a variável de ambiente por um `SetSampler(new AlwaysOnSampler())` explícito em `Program.cs` e o wrapper também o aproveita, sem jogos de ordenação.

## A ressalva sobre o descarte

O provider só descarta (dispose) o sampler final. Se o seu callback descarta o sampler que recebeu, ou o envolve, o ciclo de vida do sampler interno passa a ser sua responsabilidade. Para samplers sem estado, como `TraceIdRatioBasedSampler`, isso não importa. Para qualquer coisa que mantenha um timer ou uma conexão de configuração remota, encaminhe `Dispose` a partir do seu wrapper.

## Quem deve migrar

Se você mantém uma biblioteca ou uma distro interna que hoje chama `SetSampler`, migre para `ConfigureSampler` para parar de sobrescrever a configuração do operador. O código da aplicação pode continuar usando `SetSampler`, que ainda ocupa o posto de maior precedência. O PR também posiciona isso como base para amostragem controlada remotamente e configuração declarativa, em que a escolha do sampler sai completamente do código.

Atualize os pacotes principais juntos, já que eles seguem o mesmo versionamento:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.20.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.20.0
```

Se você pulou o patch anterior, a [correção de regex com wildcard da 1.19.1](/pt-br/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/) também está incluída.
