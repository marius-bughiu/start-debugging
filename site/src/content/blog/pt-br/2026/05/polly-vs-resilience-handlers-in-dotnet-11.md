---
title: "Polly vs. resilience handlers no .NET 11: qual você deveria usar?"
description: "Use o resilience handler do Microsoft.Extensions.Http.Resilience para chamadas com HttpClient, pois ele é o Polly com padrões que entendem HTTP e telemetria em uma única linha. Recorra ao ResiliencePipeline do Polly diretamente apenas quando proteger algo que não seja um HttpClient."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "polly"
  - "resilience"
  - "httpclient"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/polly-vs-resilience-handlers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-24
---

A formulação "Polly vs. resilience handlers" está ligeiramente errada, e perceber o porquê é toda a resposta. O resilience handler, `AddStandardResilienceHandler` do pacote `Microsoft.Extensions.Http.Resilience`, não é uma alternativa ao Polly. Ele é o Polly, envolvido em uma camada que entende HTTP e é amigável à injeção de dependência, que se conecta diretamente ao `IHttpClientFactory`. Portanto, a verdadeira pergunta não é "qual biblioteca", mas "em qual camada eu configuro a resiliência". Para código novo no .NET 11 em 2026: se o que você está protegendo é uma chamada com `HttpClient`, use o resilience handler, porque ele lhe dá as estratégias do Polly com padrões que entendem HTTP, telemetria e vinculação de configuração em uma única linha. Recorra à API `ResiliencePipeline` do Polly diretamente apenas quando a operação não for uma requisição com `HttpClient`: uma consulta a banco de dados, uma publicação em um broker de mensagens, uma chamada gRPC invocada manualmente ou qualquer delegate arbitrário.

Todos os exemplos aqui têm como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 e C# 14. "Polly" significa Polly v8 (o pacote `Polly.Core`, 8.6.6 no NuGet), cuja API `ResiliencePipeline` substituiu os antigos tipos `Policy`. "Resilience handler" significa `Microsoft.Extensions.Http.Resilience` 10.6.0, que depende do `Microsoft.Extensions.Resilience` e do Polly. Os dois são o mesmo motor visto de duas alturas.

## A tabela de recursos em um relance

Esta é a tabela pela qual você veio. As colunas são as duas formas de realmente conectar a resiliência, e as linhas são as decisões que mudam qual você escolhe.

| Aspecto | Polly `ResiliencePipeline` | Resilience handler (`Microsoft.Extensions.Http.Resilience`) |
| ------- | ------------------------- | ---------------------------------------------------------- |
| O que envolve | Qualquer delegate ou operação | Apenas requisições com `HttpClient` |
| Construído sobre | `Polly.Core` (o motor) | `Polly.Core`, envolvido |
| Como executa | Você chama `pipeline.ExecuteAsync(...)` explicitamente | Transparente, dentro do pipeline de `HttpMessageHandler` |
| Padrões que entendem HTTP (5xx, 408, 429) | Você escreve `ShouldHandle` por conta própria | Incluído |
| Um pipeline padrão sensato em uma linha | Não, você o compõe | Sim, `AddStandardResilienceHandler()` |
| Telemetria (métricas + traces) | Via `Microsoft.Extensions.Resilience` ou manual | Incluída |
| Vinculação de configuração + recarga a quente | Manual | De primeira classe (`EnableReloads`) |
| Integração com injeção de dependência | `ResiliencePipelineRegistry<TKey>` | `IHttpClientBuilder` |
| Pacote NuGet | `Polly.Core` 8.6.6 | `Microsoft.Extensions.Http.Resilience` 10.6.0 |
| Melhor para | Chamadas a banco de dados, filas, gRPC, código arbitrário | Chamadas com `HttpClient` nomeadas ou tipadas |

O padrão na tabela é que o resilience handler é a coluna da direita que herda o motor da esquerda e adiciona conhecimento de HTTP, telemetria e conexão com injeção de dependência por cima. O custo de se mover para a direita é abrir mão da generalidade: o handler só executa contra `HttpClient`.

## Por que o resilience handler é só o Polly de uniforme

Quando você chama `AddStandardResilienceHandler`, o pacote constrói um `ResiliencePipeline<HttpResponseMessage>` do Polly e o instala como um `DelegatingHandler` no pipeline de manipuladores de mensagens que o `IHttpClientFactory` compõe para aquele cliente. Cada nova tentativa, cada abertura do circuit breaker, cada timeout é executado pelo `Polly.Core`. Não existe um segundo motor de resiliência no .NET. A Microsoft não reimplementou as tentativas; ela pegou o Polly v8, deu a ele padrões ajustados para HTTP, conectou-o ao sistema de opções e emitiu métricas e traces compatíveis com OpenTelemetry ao seu redor.

É por isso que "devo usar o Polly ou o resilience handler?" é um erro de categoria para código HTTP. Usar o handler é usar o Polly. A decisão é se você quer a camada de conveniência em formato de HTTP ou se precisa do motor bruto porque sua operação não é HTTP.

## Quando o resilience handler é a escolha certa

Para qualquer resiliência que viva sobre um `HttpClient` resolvido via `IHttpClientFactory`, o handler vence. O handler padrão é uma única linha sobre um cliente tipado:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // rate limiter, total timeout, retry, breaker, attempt timeout
```

Essa única chamada empilha cinco estratégias com padrões que entendem HTTP: ela já sabe que HTTP 500+, 408 e 429 são transitórios, que `HttpRequestException` e a `TimeoutRejectedException` do Polly devem ser repetidas, e que um cabeçalho `Retry-After` deve ser respeitado. Você não escreveu um predicado `ShouldHandle` para nada disso. Este é o substituto moderno para conectar políticas do Polly à mão sobre um cliente, e é o padrão certo para quase todo código HTTP do lado do servidor.

Quando os padrões não estão exatamente certos, você não desce para o Polly bruto. Você permanece na camada do handler e personaliza, porque o handler expõe as mesmas opções do Polly por meio de tipos de opções específicos de HTTP. Use `AddResilienceHandler` para construir um pipeline nomeado e totalmente personalizado:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

httpClientBuilder.AddResilienceHandler("CustomPipeline", static builder =>
{
    builder.AddRetry(new HttpRetryStrategyOptions
    {
        BackoffType = DelayBackoffType.Exponential,
        MaxRetryAttempts = 5,
        UseJitter = true
    });

    builder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        SamplingDuration = TimeSpan.FromSeconds(10),
        FailureRatio = 0.2,
        MinimumThroughput = 3,
        ShouldHandle = static args => ValueTask.FromResult(args is
        {
            Outcome.Result.StatusCode:
                HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
        })
    });

    builder.AddTimeout(TimeSpan.FromSeconds(5));
});
```

Repare nos tipos: `HttpRetryStrategyOptions` e `HttpCircuitBreakerStrategyOptions`. Estas são as versões com sabor de HTTP de `RetryStrategyOptions<T>` e `CircuitBreakerStrategyOptions<T>` do Polly, carregando conveniências como `DisableForUnsafeHttpMethods()` que só fazem sentido para HTTP. Você ainda está no Polly, apenas na parte do Polly que entende `HttpResponseMessage`.

O handler também se vincula à configuração e recarrega em tempo de execução. Vincule `HttpStandardResilienceOptions` a uma seção do `appsettings.json`, chame `EnableReloads` dentro de uma sobrecarga de `AddResilienceHandler` que expõe o `ResilienceHandlerContext`, e alterar o JSON reajusta o pipeline ao vivo sem reiniciar. Essa encanação não é gratuita de escrever à mão contra o Polly bruto, e o handler lhe dá isso.

## O que o handler padrão realmente configura

Os leitores chegam a esta comparação porque querem saber o que `AddStandardResilienceHandler` faz antes de confiar nele. A configuração padrão encadeia cinco estratégias, da mais externa para a mais interna. Os números abaixo são os padrões do .NET 11 / `Microsoft.Extensions.Http.Resilience` 10.6.0:

| Ordem | Estratégia | Padrão |
| ----- | -------- | ------- |
| 1 | Rate limiter | Permit: `1_000`, Queue: `0` |
| 2 | Timeout total da requisição | 30s ao longo de todas as tentativas |
| 3 | Retry | Máx. de tentativas: `3`, backoff exponencial, jitter ligado, atraso base 2s |
| 4 | Circuit breaker | Taxa de falhas: 10%, throughput mín.: `100`, amostragem 30s, abertura 5s |
| 5 | Timeout por tentativa | 10s por tentativa individual |

A ordem importa. O timeout total (30s) fica fora das tentativas, então três tentativas que cada uma atinja o timeout por tentativa de 10s não podem rodar para sempre: toda a operação é limitada a 30s. O circuit breaker fica dentro do retry, então conta as falhas de tentativas individuais, e quando 10% de pelo menos 100 chamadas amostradas falham dentro de 30s, ele abre por 5s e curto-circuita tudo abaixo. Se você lembrar apenas de uma coisa sobre os padrões: as tentativas são limitadas por um relógio de parede de 30s, não apenas por uma contagem.

## Quando recorrer ao Polly diretamente

O handler deixa de ser uma opção no momento em que o que você está protegendo não é uma chamada com `HttpClient`. Não há `AddStandardResilienceHandler` para uma consulta a banco de dados, um `ServiceBusSender.SendMessageAsync`, uma chamada ao Redis ou um bloco de lógica de negócio que ocasionalmente lança uma exceção. Para esses, você constrói um `ResiliencePipeline` do Polly e o invoca explicitamente:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - resilience around a non-HTTP operation
using Polly;
using Polly.Retry;

ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
    .AddRetry(new RetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Only retry the transient failures this dependency actually throws
        ShouldHandle = new PredicateBuilder().Handle<TimeoutException>()
    })
    .AddTimeout(TimeSpan.FromSeconds(5))
    .Build();

await pipeline.ExecuteAsync(
    async token => await SaveOrderAsync(order, token),
    cancellationToken);
```

A forma é o mesmo motor que você viu dentro do handler: `AddRetry`, `AddTimeout`, `AddCircuitBreaker`, o mesmo `DelayBackoffType` e `ShouldHandle`. O que muda é que você chama `ExecuteAsync` por conta própria, escolhe o que conta como falha transitória (aqui `TimeoutException`, porque não há código de status HTTP para inspecionar), e o pipeline pode envolver literalmente qualquer delegate.

Para resultados tipados, use o builder genérico para que o pipeline possa raciocinar sobre o valor de retorno, não apenas sobre exceções:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - a pipeline that inspects the result
using Polly;

ResiliencePipeline<DbResult> pipeline = new ResiliencePipelineBuilder<DbResult>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        ShouldHandle = static args => ValueTask.FromResult(
            args.Outcome.Result is { Status: DbStatus.Throttled })
    })
    .Build();

DbResult result = await pipeline.ExecuteAsync(
    async token => await QueryAsync(token),
    cancellationToken);
```

Em uma aplicação com injeção de dependência você não instancia pipelines nos pontos de chamada. Você os registra uma vez com `AddResiliencePipeline`, e eles caem no `ResiliencePipelineRegistry<TKey>` para que você possa resolvê-los em qualquer lugar via `ResiliencePipelineProvider<TKey>`:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - register once, resolve anywhere
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.Registry;

builder.Services.AddResiliencePipeline("db-writes", static b =>
{
    b.AddRetry(new()).AddTimeout(TimeSpan.FromSeconds(5));
});

// elsewhere, injected ResiliencePipelineProvider<string> provider
ResiliencePipeline pipeline = provider.GetPipeline("db-writes");
await pipeline.ExecuteAsync(static async ct => await DoWorkAsync(ct), ct);
```

Se você também incorporar `Microsoft.Extensions.Resilience`, esses pipelines registrados recebem o mesmo tratamento de telemetria que o handler HTTP desfruta, então um pipeline que não é HTTP ainda pode emitir métricas e traces. Isso é o mais próximo que você chega da "experiência do handler" para código que não é HTTP, e é a ferramenta certa quando você quer resiliência em torno da sua camada de dados ou de mensageria em vez do seu HTTP de saída.

## Um é mais rápido que o outro?

Não, e a pergunta revela o equívoco. Como o resilience handler executa um `ResiliencePipeline` do Polly por baixo, a sobrecarga por chamada do "handler" e do "Polly bruto" é o mesmo motor executando as mesmas estratégias. Não há imposto do Polly que você evite ao montar um pipeline à mão, nem imposto do handler que você pague pela conveniência. O Polly v8 foi reescrito especificamente para cortar alocações em relação ao v7, e ambos os pontos de entrada se apoiam nessa reescrita.

O que difere não é o throughput, mas o que você ganha em torno da execução: o handler adiciona telemetria, vinculação de configuração e as garantias de tempo de vida do `IHttpClientFactory` de graça, enquanto um pipeline bruto lhe dá isso apenas se você conectar. Se você quer um número real para sua própria carga de trabalho, rode o BenchmarkDotNet contra seu próprio delegate com e sem o pipeline; não escolha entre os dois com base em desempenho, porque o desempenho não é o eixo que os separa.

## O detalhe que decide por você

Algumas restrições rígidas resolvem a escolha antes que a preferência entre em jogo.

**O handler só funciona sobre `HttpClient` via `IHttpClientFactory`.** Se o seu código não passa por `AddHttpClient` e um cliente injetado, não há handler para adicionar. Um `HttpClient` singleton estático, um `DbContext`, um produtor Kafka: nenhum deles pode receber um resilience handler. Eles recebem um pipeline do Polly ou nada. Esse único fato decide a maioria dos casos reais.

**Não empilhe resilience handlers.** A orientação da Microsoft é explícita: adicione exatamente um resilience handler por cliente. Se você precisa de uma forma diferente, chame primeiro `RemoveAllResilienceHandlers()` e então adicione o seu personalizado. Empilhar um handler padrão e um personalizado aninha dois pipelines completos e produz contagens de tentativas e timeouts que se multiplicam de formas que ninguém pretende.

**Tentativas com verbos não idempotentes duplicam dados.** O handler padrão repete cada método HTTP por padrão. Um `POST` repetido que já chegou ao servidor pode inserir o mesmo registro duas vezes. Chame `options.Retry.DisableForUnsafeHttpMethods()` para pular as tentativas em `POST`, `PATCH`, `PUT`, `DELETE` e `CONNECT`, ou `DisableFor(HttpMethod.Post, ...)` para uma lista específica. Esta é uma preocupação da camada do handler com a qual o Polly bruto não pode ajudar, porque o Polly bruto não sabe o que é um verbo HTTP.

**O Polly lança `TimeoutRejectedException`, não `TimeoutException`.** Se você escrever um predicado `ShouldHandle` em um retry e esperar capturar a falha da estratégia de timeout, lembre-se de que ela aflora como a `TimeoutRejectedException` do Polly. Tratar isso de forma errada é uma fonte frequente de uma [TaskCanceledException indicando que uma tarefa foi cancelada](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) que sobe onde você esperava um retry.

## A decisão, em uma linha

Para código novo no .NET 11 em 2026: se você está adicionando resiliência a um `HttpClient` resolvido via `IHttpClientFactory`, use o resilience handler, porque `AddStandardResilienceHandler` é o Polly com padrões que entendem HTTP, telemetria e vinculação de configuração em uma única linha, e `AddResilienceHandler` permite personalizar sem sair dessa camada. Desça para a API `ResiliencePipeline` do Polly diretamente apenas quando a operação não for uma chamada com `HttpClient`: acesso a banco de dados, brokers de mensagens, gRPC que você invoca à mão ou delegates arbitrários. Você nunca está realmente escolhendo entre duas bibliotecas de resiliência, porque só existe uma. Você está escolhendo se usa o Polly pela porta em formato de HTTP ou pela de propósito geral, e o tipo de operação que você está protegendo escolhe a porta por você.

## Relacionado

- [HttpClient vs. HttpClientFactory vs. Refit: qual você deveria usar no .NET 11?](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Solução: TaskCanceledException, uma tarefa foi cancelada no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Como cancelar uma Task de longa duração em C# sem causar deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Como usar OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Como fazer testes unitários de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Fontes

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler`, `AddResilienceHandler`, os padrões do pipeline padrão e a lista de resultados transitórios.
- [Introduction to resilient app development](https://learn.microsoft.com/en-us/dotnet/core/resilience/) - como o `Microsoft.Extensions.Resilience` se constrói sobre o Polly e adiciona telemetria.
- [Polly docs: Resilience pipelines](https://www.pollydocs.org/pipelines/) - `ResiliencePipelineBuilder`, `ExecuteAsync` e o registry.
- [Polly docs: Advanced dependency injection](https://www.pollydocs.org/advanced/dependency-injection/) - `AddResiliencePipeline`, `ResiliencePipelineRegistry` e as recargas dinâmicas.
- [Polly v7 to v8 migration guide](https://www.pollydocs.org/migration-v8.html) - por que a API `Policy` foi substituída pelo `ResiliencePipeline`.
- [Microsoft.Extensions.Http.Resilience on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience) - versão atual do pacote e suas dependências.
</content>
