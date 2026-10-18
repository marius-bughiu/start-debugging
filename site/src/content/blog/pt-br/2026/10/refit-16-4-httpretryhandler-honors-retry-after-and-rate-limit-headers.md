---
title: "Refit 16.4 traz o HttpRetryHandler, que lê os headers de rate limit do GitHub, Azure e AWS"
description: "O Refit 16.4.0 adiciona um HttpRetryHandler opcional que repete requisições idempotentes, respeita o Retry-After e headers específicos de provedores como x-ratelimit-reset e x-ms-retry-after-ms, e não precisa de Polly nem de pacote de resiliência."
pubDate: 2026-10-18
tags:
  - "dotnet"
  - "refit"
  - "httpclient"
  - "resilience"
lang: "pt-br"
translationOf: "2026/10/refit-16-4-httpretryhandler-honors-retry-after-and-rate-limit-headers"
translatedBy: "claude"
translationDate: 2026-10-18
---

O [Refit 16.4.0](https://github.com/reactiveui/refit/releases/tag/v16.4.0) saiu em 17 de outubro de 2026, e o recurso principal é um handler de retry que vive no pacote central `Refit`. O `HttpRetryHandler` é um `DelegatingHandler` comum, então funciona com clientes Refit e com qualquer `HttpClient` normal, sem trazer o Polly ou o `Microsoft.Extensions.Http.Resilience`.

Não é só mais um loop de backoff exponencial. A parte interessante é como ele decide quanto tempo esperar.

## As dicas do servidor vencem o backoff

Por padrão, o handler permite três novas tentativas após o primeiro envio, mas apenas para `GET`, `HEAD`, `OPTIONS` e `TRACE`. Ele repete HTTP 408, 429, 500, 502, 503 e 504, além de `HttpRequestException`. Um 403 só é repetido quando o leitor de atraso configurado encontra uma dica de tempo válida, que é exatamente como o GitHub sinaliza um rate limit primário esgotado.

O atraso vem de um `DelayProvider`. O padrão lê o header `Retry-After` padrão, e `RetryDelayProviders` traz quatro leitores específicos de provedores:

- `Azure`: `x-ms-retry-after-ms`, depois `retry-after-ms`, depois `Retry-After`.
- `Aws`: `x-amz-retry-after` em milissegundos, depois `Retry-After`.
- `GitHub`: `Retry-After`, ou `x-ratelimit-reset` (segundos Unix) quando a cota restante é zero em um 403 ou 429.
- `Jira`: `Retry-After`, ou o `X-RateLimit-Reset` em ISO 8601 em um 429.

Quando não existe dica válida, ele recorre ao backoff exponencial começando em um segundo, limitado a 30 segundos, com jitter completo. O jitter nunca encurta uma dica do servidor, e uma dica acima de `MaxDelay` faz o handler devolver a resposta em vez de tentar de novo cedo demais.

## Conectando a um cliente Refit

Com o `Refit.HttpClientFactory`, o handler entra na cadeia como qualquer outro message handler:

```csharp
using Refit;

services.AddRefitGeneratedClient<IGitHubApi>()
    .ConfigureHttpClient(static client =>
        client.BaseAddress = new Uri("https://api.github.com"))
    .AddHttpMessageHandler(static () => new HttpRetryHandler(new HttpRetryOptions
    {
        MaxRetries = 3,
        DelayProvider = RetryDelayProviders.GitHub,
        MaxDelay = TimeSpan.FromMinutes(2),
    }));
```

Retorne um handler novo a partir da lambda de fábrica, como acima. Instâncias de handler pertencem a um único pipeline.

Se a sua API usa algum outro header, `RetryDelayProviders.ReadHeader` interpreta segundos, milissegundos, timestamps Unix ou datas para você:

```csharp
var options = new HttpRetryOptions
{
    DelayProvider = static (response, now, ct) =>
        RetryDelayProviders.ReadHeader(
            response, "X-Throttle-Reset", RetryHeaderFormat.UnixTimeSeconds, now, ct),
};
```

## As proteções

`POST`, `PUT`, `PATCH` e `DELETE` não são repetidos a menos que você defina `RetryUnsafeMethods = true`, e você só deve fazer isso para endpoints que aceitam uma chave de idempotência. Cada tentativa é um `HttpRequestMessage` novo, com headers e opções copiados. O corpo é armazenado em buffer uma vez, com limite padrão de 1 MiB (`MaxRequestContentBufferSize`), então uploads em streaming sem limite não combinam bem.

Dois detalhes de ordem importam. Um handler de autenticação colocado dentro do handler de retry roda em toda tentativa, que é o que você quer para tokens renovados. E o `HttpClient.Timeout` cobre a chamada inteira, incluindo as esperas entre tentativas, então um timeout padrão de 100 segundos pode interromper uma janela de reset de dois minutos do GitHub.

Não empilhe isso em cima do `AddStandardResilienceHandler`. Escolha uma única camada de retry. Se você já roda o pipeline de resiliência da Microsoft, mantenha-o. Se você tem um cliente Refit pequeno que só precisa se comportar com educação diante de uma API com rate limit, agora isso é uma mudança de duas linhas.

Para testes, o `Refit.Testing` adiciona `RetryReply.After`, `RetryReply.Header` e `StubHttp.CreateRetryHandler`, todos guiados por `TimeProvider`, para que você possa verificar as esperas sem dormir.

A versão também adiciona `[Query(Name = "client_id")]` e `[Url(AllowRelative = true)]`, e corrige parâmetros de rota e de query que diferem apenas por maiúsculas e minúsculas. É a maior entrega do Refit desde que [o 16.1 passou a gerar o loop de paginação com PagedEnumerable](/pt-br/2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable/).
