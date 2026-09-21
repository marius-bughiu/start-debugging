---
title: "Aspire 13.5.4 impede que os health checks do Kafka vazem um producer a cada verificação"
description: "Antes do Aspire 13.5.4, cada health check do AppHost em um recurso AddKafka criava um novo producer do Confluent que ninguém descartava, então as threads de polling se acumulavam e o AppHost queimava CPU. A correção, e a armadilha do HealthCheckRegistration.Factory por trás dela, vale também para os seus próprios health checks."
pubDate: 2026-09-21
tags:
  - "aspire"
  - "kafka"
  - "dotnet"
  - "health-checks"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/09/aspire-13-5-4-fixes-kafka-health-check-thread-leak"
translatedBy: "claude"
translationDate: 2026-09-21
---

O [Aspire 13.5.4](https://github.com/microsoft/aspire/releases/tag/v13.5.4) saiu em 2026-09-15 e é um patch que vale a pena aplicar se o seu AppHost chama `AddKafka`. Até a 13.5.3, o health check do Kafka que o `Aspire.Hosting.Kafka` registra criava um producer do Confluent.Kafka totalmente novo a cada execução e nunca o descartava. Cada producer inicia a própria thread de polling, então um AppHost rodando por muito tempo ia se enchendo de threads presas em `SafeKafkaHandle.Poll`. O relato na [issue #20091](https://github.com/microsoft/aspire/issues/20091) mostra um AppHost no macOS em 350-400% de CPU, com um trace de amostragem de threads em que 1.901 de 1.934 threads amostradas estavam dentro do loop de polling do Kafka.

Se você já deixou `dotnet run` aberto em um AppHost por uma tarde inteira e se perguntou por que as ventoinhas dispararam, este é um candidato provável.

## De onde vinham os producers

A integração de hosting montava o check dentro de uma factory de `HealthCheckRegistration`:

```csharp
var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp =>
    {
        var options = new KafkaHealthCheckOptions();
        options.Configuration = new ProducerConfig();
        options.Configuration.BootstrapServers = connectionString
            ?? throw new InvalidOperationException("Connection string is unavailable");
        return new KafkaHealthCheck(options);
    },
    failureStatus: default,
    tags: default);
builder.Services.AddHealthChecks().Add(healthCheckRegistration);
```

O `HealthCheckService` chama essa factory a cada execução do check. O `KafkaHealthCheck` cria um producer de forma preguiçosa e o libera em `Dispose()`, mas o objeto retornado pela factory era construído com `new`, não resolvido a partir do container. O runner de health checks abre e descarta um scope de DI por execução, só que um scope descarta apenas as instâncias que ele mesmo criou. Ninguém chamava `Dispose()` no check, então cada verificação deixava para trás mais um producer e mais uma thread de polling.

O código evitava de propósito o `AddKafka(...)` do pacote de health checks da Xabaril: esse helper registra um singleton e, com dois recursos Kafka, a factory leria a connection string do último recurso ([Xabaril #2298](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/issues/2298)). O workaround resolveu o bug de configuração e introduziu o bug de ciclo de vida.

## A correção: deixar o DI ser dono do check

O [PR #20092](https://github.com/microsoft/aspire/pull/20092), portado para a 13.5.4 como #20094, registra um singleton com chave por recurso Kafka e faz a factory resolvê-lo:

```csharp
builder.Services.AddKeyedSingleton<KafkaHealthCheck>(healthCheckKey, (sp, _) =>
{
    var options = new KafkaHealthCheckOptions();
    options.Configuration = new ProducerConfig();
    options.Configuration.BootstrapServers = connectionString
        ?? throw new InvalidOperationException("Connection string is unavailable");
    return new KafkaHealthCheck(options);
});

var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp => sp.GetRequiredKeyedService<KafkaHealthCheck>(healthCheckKey),
    failureStatus: default,
    tags: default);
```

Usar a chave `"{name}_check"` mantém separados os bootstrap servers de cada recurso, o producer é reutilizado entre verificações e o container raiz o descarta quando o AppHost é encerrado. A medição do PR contra dois brokers Kafka 8.2.0 reais: 84 execuções do health check geraram 84 instâncias do check e 84 threads de polling na 13.5.3, contra 2 instâncias e 2 threads com a correção, e 0 threads restantes após o descarte.

## Atualizando

Atualize os pacotes do Aspire no projeto do AppHost:

```xml
<PackageReference Include="Aspire.Hosting.Kafka" Version="13.5.4" />
```

Não é preciso mudar código no AppHost e não há mudança de API pública. A mesma versão também corrige falhas do DevTunnel com regiões selecionadas automaticamente (uma regressão da 13.3), esconde o recurso `azure-environment` sem uso em AppHosts só com emuladores e marca `IAwsRadiusProviderBuilder` e `IAzureRadiusProviderBuilder` com o diagnóstico experimental `ASPIRERADIUS003`, que pode aparecer como um novo warning-as-error se você referencia essas interfaces diretamente.

## Procure o mesmo padrão nos seus health checks

O bug não é exclusivo do Kafka. Qualquer factory de `HealthCheckRegistration` que retorna `new SomethingDisposable(...)` vaza uma instância por verificação e, com o período padrão de 30 segundos do publisher de health checks, isso dá 2.880 objetos vazados por dia por check. Ou você registra o check no DI e o resolve na factory, como o Aspire faz agora, ou mantém o cliente caro (producer, conexão, `HttpClient`) em um singleton e deixa o check ser um objeto barato e sem estado. Se você ainda está na linha 13.5, o [post anterior sobre `WithTerminal()`](/pt-br/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/) cobre o resto do que a 13.5 mudou no dashboard.
