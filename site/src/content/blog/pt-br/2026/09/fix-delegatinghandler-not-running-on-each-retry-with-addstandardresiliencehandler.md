---
title: "Correção: DelegatingHandler personalizado não roda de novo a cada retry com AddStandardResilienceHandler"
description: "Um DelegatingHandler registrado antes de AddStandardResilienceHandler roda uma vez por requisição lógica, não uma vez por retry. Mova-o para depois do resilience handler e torne-o idempotente, porque o retry reenvia o mesmo HttpRequestMessage. Medido com Microsoft.Extensions.Http.Resilience 10.10.0 e 8.10.0."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "httpclient"
  - "resilience"
  - "polly"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Resposta curta:** `IHttpClientFactory` monta a cadeia de handlers na ordem de registro, e o primeiro registrado é o mais externo. Se você chama `AddHttpMessageHandler<MyHandler>()` *antes* de `AddStandardResilienceHandler()`, o seu handler fica fora do loop de retry e roda exatamente uma vez, não importa quantas tentativas o Polly faça por baixo dele. Registre-o *depois* do resilience handler e ele roda uma vez por tentativa. Em seguida, corrija o segundo bug que essa mudança expõe: o retry padrão reenvia o **mesmo** objeto `HttpRequestMessage`, então qualquer `request.Headers.Add(...)` em um handler por tentativa acumula valores duplicados, e um corpo `StreamContent` não posicionável (non-seekable) lança `InvalidOperationException: The stream was already consumed` na segunda tentativa.

Tudo abaixo foi medido com um probe baseado em arquivo no .NET 10.0.10 (SDK 10.0.302) contra `Microsoft.Extensions.Http.Resilience` 10.10.0, a versão estável atual, e repetido na 8.10.0. As duas versões produziram saída idêntica, então isso não é uma regressão e não é algo que uma atualização de pacote vá mudar. É assim que o pipeline é construído.

## Por que o handler roda só uma vez

`AddStandardResilienceHandler` não é uma configuração do client. É mais um `DelegatingHandler`, do tipo `ResilienceHandler`, adicionado à mesma lista ordenada à qual `AddHttpMessageHandler` adiciona. A documentação do ASP.NET Core descreve a regra em uma linha: os handlers [podem ser registrados na ordem em que devem ser executados](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), e cada um envolve o próximo.

Dentro de `ResilienceHandler.SendAsync`, o pipeline do Polly executa um callback que chama `base.SendAsync(request, ...)`, que é o próximo handler da cadeia. Quando a estratégia de retry decide tentar de novo, ela invoca esse callback de novo. Então só os handlers **abaixo** de `ResilienceHandler` são reexecutados. Qualquer coisa acima dele já chamou `base.SendAsync` uma vez e está simplesmente aguardando o resultado final.

Esse é o bug inteiro. Tutoriais e código mais antigo costumam registrar handlers transversais primeiro e acoplar a resiliência no final, porque a leitura fica natural:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<SigningHandler>();

builder.Services.AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"))
    .AddHttpMessageHandler<SigningHandler>()   // outermost: runs once
    .AddStandardResilienceHandler();           // retries happen below this line
```

Se `SigningHandler` carimba um timestamp e uma assinatura HMAC, todo retry sai com a assinatura calculada para a primeira tentativa. Se ele busca um token de vida curta, um retry depois de um 503 lento pode sair com um token que já expirou. Se ele registra "sending request" no log, você vê uma linha de log para três chamadas de rede.

## A cadeia de handlers medida

Resolvi `IHttpMessageHandlerFactory.CreateHandler("c")` e percorri `InnerHandler` até o handler primário. O primário era um stub que retorna `503` duas vezes e depois `200`, e os atrasos de retry foram zerados para o probe rodar instantaneamente. Um `CountingHandler` registra no log cada chamada que recebe.

Registrado **antes** de `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> CountingHandler -> ResilienceHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #1 X-Attempt=[]
CountingHandler #1 <- 200
```

Três requisições chegaram à rede. O handler rodou uma vez e só viu o `200` final.

Registrado **depois** de `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #2 <- 503
CountingHandler #3 <- 503
CountingHandler #4 <- 200
```

Agora ele roda por tentativa e vê cada `503`. Repare onde fica o próprio `LoggingHttpMessageHandler` da factory: sempre no nível mais interno, logo acima do handler primário. É por isso que a categoria de log embutida `System.Net.Http.HttpClient.<name>.ClientHandler` já mostra uma entrada por tentativa, enquanto um handler que você registrou primeiro mostra uma entrada por chamada. Se os seus logs e o seu handler discordam sobre a contagem de requisições, o motivo é esse.

## Corrija em três passos

1. Decida, handler por handler, se o trabalho dele pertence à **chamada lógica** ou a **cada tentativa**. Assinatura, obtenção de token, log e métricas por tentativa são por tentativa. Uma chave de idempotência, um correlation ID que você quer manter estável entre retries e qualquer coisa que precise acontecer exatamente uma vez são por chamada.
2. Registre os handlers por tentativa **depois** de `AddStandardResilienceHandler()` (ou `AddResilienceHandler(...)`), e os handlers por chamada antes dele.
3. Torne cada handler por tentativa seguro para rodar repetidamente sobre o mesmo `HttpRequestMessage`: substitua os headers em vez de adicioná-los, e garanta que o corpo da requisição possa ser lido mais de uma vez.

O registro do exemplo de pagamentos fica assim:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<IdempotencyKeyHandler>();
builder.Services.AddTransient<SigningHandler>();

var payments = builder.Services
    .AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"));

payments.AddHttpMessageHandler<IdempotencyKeyHandler>(); // once per call: same key on every retry
payments.AddStandardResilienceHandler();
payments.AddHttpMessageHandler<SigningHandler>();        // once per attempt: fresh signature
```

Guarde o `IHttpClientBuilder` em uma variável. Você não consegue encadear `.AddHttpMessageHandler<T>()` em `AddStandardResilienceHandler()`, porque ele retorna um `IHttpStandardResiliencePipelineBuilder`, não o builder do client. Tentar isso quebra o build:

```text
error CS1929: 'IHttpStandardResiliencePipelineBuilder' does not contain a definition for
'AddHttpMessageHandler' and the best extension method overload
'HttpClientBuilderExtensions.AddHttpMessageHandler<SigningHandler>(IHttpClientBuilder)'
requires a receiver of type 'Microsoft.Extensions.DependencyInjection.IHttpClientBuilder'
```

Desconfio que esse erro de compilador é o verdadeiro motivo de tanto código registrar handlers primeiro: a cadeia fluente só compila na ordem errada, então as pessoas colocam a resiliência por último e seguem em frente. Uma segunda chamada `AddHttpClient<PaymentsClient>()` para o mesmo client também funciona, já que ela retorna um builder para o mesmo nome, mas a variável deixa a ordem visível.

A chave de idempotência é o caso que as pessoas erram na direção oposta. Se você move *todos* os handlers para dentro do retry para corrigir a assinatura, um handler que gera `Idempotency-Key: Guid.NewGuid()` passa a enviar uma chave diferente por tentativa, e o servidor não consegue mais distinguir um retry de um pagamento novo. O objetivo da chave é justamente permanecer constante entre retries, então ela precisa ficar fora do loop.

## O retry reenvia o mesmo HttpRequestMessage

Esse me surpreendeu. Eu esperava que o resilience handler clonasse a requisição a cada tentativa. Ele não faz isso, no caso do handler padrão (retry). O probe registrou o hash code da requisição em cada tentativa e era o mesmo objeto todas as vezes. Um handler por tentativa que usa `Headers.Add` então produz isto:

```text
chain: ... -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
CountingHandler #5 X-Attempt=[1]
CountingHandler #6 X-Attempt=[1,1]
CountingHandler #7 X-Attempt=[1,1,1]
```

Na terceira tentativa o header tem três valores. Para um header de assinatura, isso significa que o servidor recebe `X-Signature: abc, def, ghi` e rejeita. O código em `ResilienceHandler` confirma: o callback do pipeline chama `GetRequestMessage(context, state.request)`, que retorna a requisição original, a menos que uma estratégia externa tenha colocado outra no contexto. Só o hedging faz isso.

A correção é escrever headers com semântica de "set". `Authorization` é uma propriedade tipada de valor único, então atribuir a ela substitui o valor antigo. Para headers personalizados, remova primeiro:

```csharp
// .NET 10, C# 14
public sealed class SigningHandler(ISigner signer, TimeProvider clock) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString();

        request.Headers.Remove("X-Timestamp");
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Timestamp", timestamp);
        request.Headers.Add("X-Signature", await signer.SignAsync(request, timestamp, cancellationToken));

        return await base.SendAsync(request, cancellationToken);
    }
}
```

Com `Remove` seguido de `Add`, o probe mostrou `X-Attempt=[1]`, `[2]`, `[3]` nas três tentativas: um valor, renovado a cada vez. O mesmo vale para um handler de token: `request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);` já é seguro de repetir.

## Os corpos das requisições precisam ser reenviáveis

Como o mesmo `HttpRequestMessage` sai de novo, o mesmo `HttpContent` sai também. `StringContent`, `ByteArrayContent`, `JsonContent` e `FormUrlEncodedContent` são mantidos em memória e podem ser serializados quantas vezes for preciso. O handler primário do probe copiou o corpo com `CopyToAsync`, que é o que o `SocketsHttpHandler` faz, e um POST com `StringContent` chegou intacto nas três tentativas.

Um `StreamContent` sobre um stream não posicionável (um stream de rede, um pipe, um upload que você está repassando) não sobrevive:

```text
primary #1 body='{"a":1}'
primary #2 InvalidOperationException: The stream was already consumed. It cannot be read again.
```

`InvalidOperationException` não está entre as exceções que o retry padrão trata como transitórias, então a chamada falha na segunda tentativa com essa exceção em vez de tentar de novo. Um stream posicionável funciona, porque o `StreamContent` volta para a posição inicial antes de cada envio.

Você tem três opções:

```csharp
// .NET 10, C# 14
// Option 1: buffer it (fine for small bodies)
var content = new StreamContent(uploadStream);
await content.LoadIntoBufferAsync(cancellationToken);   // probe: all 3 attempts sent the full body

// Option 2: copy to a seekable stream first
var ms = new MemoryStream();
await uploadStream.CopyToAsync(ms, cancellationToken);
ms.Position = 0;
var seekable = new StreamContent(ms);

// Option 3: do not retry this request at all
builder.Services.AddHttpClient("uploads")
    .AddStandardResilienceHandler()
    .Configure(o => o.Retry.DisableForUnsafeHttpMethods());
```

Para uploads grandes, a opção 3 costuma ser a resposta honesta. Carregar um corpo de 500 MB em memória para torná-lo reenviável é um modo de falha pior do que expor o erro. `DisableForUnsafeHttpMethods` também impede o handler padrão de fazer retry de `POST`, `PUT`, `PATCH` e `DELETE` em geral, o que você muitas vezes quer de qualquer forma para endpoints não idempotentes.

## Aspire e ConfigureHttpClientDefaults já colocam o seu handler dentro

Se o seu projeto usa os `ServiceDefaults` do .NET Aspire, talvez você nem tenha esse bug. `AddServiceDefaults()` chama `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, e as ações padrão sempre rodam antes da configuração própria de um client nomeado ou tipado. Registrei o resilience handler via `ConfigureHttpClientDefaults` e um `CountingHandler` no client nomeado:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
CountingHandler #8 <- 503
CountingHandler #9 <- 503
CountingHandler #10 <- 200
```

Todo handler por client cai dentro do retry, independentemente da ordem de `AddServiceDefaults()` e `AddHttpClient(...)` em `Program.cs`. Esse é o padrão certo para assinatura e tokens, e o errado para chaves de idempotência. Se você precisa de um handler por chamada em um app Aspire, tem que remover o resilience handler padrão daquele client e adicioná-lo de novo depois do seu handler, o que é explicado em [como sobrescrever o resilience handler padrão que o Aspire registra](/pt-br/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/). Adicionar um segundo `AddStandardResilienceHandler()` não substitui o primeiro, ele empilha.

## Hedging se comporta de forma diferente

`AddStandardHedgingHandler()` é a exceção à regra do "mesmo objeto de requisição". O hedging pode ter várias tentativas em andamento ao mesmo tempo, então ele tira um snapshot da requisição original e envia um clone por tentativa. A cadeia também contém duas instâncias de `ResilienceHandler`, uma para o pipeline de hedging e outra para as estratégias por endpoint:

```text
chain: ... -> ResilienceHandler -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
final: 503, primary calls: 2
CountingHandler #16 req@9c43c1 X-Attempt=[1]
CountingHandler #17 req@17e61ce X-Attempt=[1]
```

Dois objetos de requisição diferentes, cada um com exatamente um valor de header, mesmo com a versão `Headers.Add` do handler. Handlers registrados depois do hedging handler continuam rodando por tentativa. Mas não conte com a clonagem: código que só é correto com hedging quebra no dia em que alguém voltar para o handler padrão.

## Outras coisas que mudam quando o handler fica dentro

Mover um handler para baixo do resilience handler o coloca sob o **timeout por tentativa** (10 segundos por padrão) e dentro da visão de mundo do **circuit breaker**. Três consequências:

- Trabalho lento no handler conta contra cada tentativa. Um endpoint de token que leva 8 segundos deixa 2 segundos para a requisição real antes de a tentativa estourar o timeout. Faça cache dos tokens e renove-os antes de expirarem, em vez de no caminho da requisição.
- Exceções que o seu handler lança são resultados que o retry e o circuit breaker avaliam. Uma `HttpRequestException` lançada pelo seu handler sofre retry e conta como falha para o breaker. Lance algo não transitório (ou retorne uma resposta) para falhas que um retry não consegue resolver, como configuração ausente.
- Um handler que faz curto-circuito e retorna o próprio `HttpResponseMessage` (um acerto de cache, por exemplo) também está sujeito ao `ShouldHandle` do retry. Retornar um `503` sintético de dentro do loop gera retry como se fosse um real.

Instâncias de `DelegatingHandler` registradas com `AddHttpMessageHandler<T>()` precisam ser transient, e isso não muda. A factory cria uma cadeia por tempo de vida do handler (dois minutos por padrão) e a reutiliza entre requisições, então o estado por requisição pertence ao `HttpRequestMessage` (`request.Options`), não a campos do handler.

## Como verificar a sua própria cadeia

Não confie no código de registro, verifique a cadeia construída. Este teste funciona para qualquer client:

```csharp
// .NET 10, xUnit v3, Microsoft.Extensions.Http.Resilience 10.10.0
[Fact]
public void SigningHandler_runs_inside_the_retry()
{
    var services = new ServiceCollection();
    services.AddTransient<SigningHandler>();
    services.AddSingleton<ISigner, FakeSigner>();
    services.AddSingleton(TimeProvider.System);
    var payments = services.AddHttpClient("payments");
    payments.AddStandardResilienceHandler();
    payments.AddHttpMessageHandler<SigningHandler>();

    using var sp = services.BuildServiceProvider();
    var handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler("payments");

    var names = new List<string>();
    for (HttpMessageHandler? h = handler; h is not null; h = (h as DelegatingHandler)?.InnerHandler)
        names.Add(h.GetType().Name);

    Assert.True(names.IndexOf(nameof(ResilienceHandler)) < names.IndexOf(nameof(SigningHandler)));
}
```

Para um teste de comportamento, troque o handler primário por um stub que falha um número fixo de vezes, a mesma técnica usada em [testes unitários de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/), e verifique se a contagem de chamadas do seu handler é igual ao número de tentativas.

## Relacionados

- [Polly vs resilience handlers no .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica as cinco estratégias dentro de `AddStandardResilienceHandler` e a ordem delas.
- [Como sobrescrever o resilience handler padrão que o Aspire registra](/pt-br/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/) para remover e adicionar de novo o handler por client.
- [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/) mostra como a factory compõe pipelines de `DelegatingHandler`.
- [Corrigir TaskCanceledException: A task was canceled no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para quando é o timeout por tentativa, e não o seu handler, que faz a chamada falhar.
- [Polly 8.8 recarrega um pipeline de resiliência a partir do seu próprio IOptionsMonitor](/pt-br/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/) se você ajusta as configurações de retry em tempo de execução.

## Fontes

- [Fazer requisições HTTP de saída: middleware de requisições de saída](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), Microsoft Learn
- [Criar apps HTTP resilientes: principais padrões de desenvolvimento](https://learn.microsoft.com/dotnet/core/resilience/http-resilience), Microsoft Learn
- [`ResilienceHandler.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHandler.cs) em dotnet/extensions
- [`Microsoft.Extensions.Http.Resilience` no NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience), versões 10.10.0 e 8.10.0 testadas
- [`HttpContent.LoadIntoBufferAsync`](https://learn.microsoft.com/dotnet/api/system.net.http.httpcontent.loadintobufferasync), Microsoft Learn
