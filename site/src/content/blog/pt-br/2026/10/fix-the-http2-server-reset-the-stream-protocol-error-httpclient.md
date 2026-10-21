---
title: "Correção: HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR'"
description: "Um peer enviou RST_STREAM com PROTOCOL_ERROR para uma requisição. O HttpClient nunca faz retry dela. Descubra qual hop resetou o stream, corrija a requisição rejeitada, faça retry apenas de chamadas idempotentes ou rebaixe esse hop para HTTP/1.1."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "httpclient"
  - "http2"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/10/fix-the-http2-server-reset-the-stream-protocol-error-httpclient"
translatedBy: "claude"
translationDate: 2026-10-21
---

`HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1)` significa que a outra ponta da conexão HTTP/2 enviou um frame `RST_STREAM` para a sua requisição com o código de erro 1. O `HttpClient` não quebrou nada, ele apenas relata o que o peer disse, e nunca faz retry de um `PROTOCOL_ERROR` por conta própria. A correção é descobrir qual hop enviou o reset (seu app Kestrel ou um proxy, load balancer ou sidecar na frente dele), corrigir o que naquela requisição específica foi rejeitado, fazer retry de requisições idempotentes com um resilience handler e, como último recurso, usar HTTP/1.1 com o hop que se comporta mal.

Tudo abaixo foi reproduzido no .NET 10.0.10 (SDK 10.0.302, ASP.NET Core 10.0.10) com Kestrel e `HttpClient` em um único app baseado em arquivo, mais `Microsoft.Extensions.Http.Resilience` 10.0.0 para a seção de retry. Os caminhos de código relevantes são os mesmos no .NET 8, 9 e 11.

## O erro em contexto

Quando o reset chega antes dos cabeçalhos da resposta, `SendAsync` (ou `GetAsync`, `PostAsync`) lança uma `HttpRequestException` que encapsula a `HttpProtocolException`:

```text
System.Net.Http.HttpRequestException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
   at System.Net.Http.Http2Connection.ThrowRequestAborted(Exception innerException)
   at System.Net.Http.Http2Connection.Http2Stream.CheckResponseBodyState()
   at System.Net.Http.Http2Connection.Http2Stream.TryEnsureHeaders()
   at System.Net.Http.Http2Connection.Http2Stream.ReadResponseHeadersAsync(CancellationToken cancellationToken)
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
```

Se o servidor já enviou um código de status e o reset acontece enquanto o corpo está sendo lido, a mensagem externa muda, mas a exceção interna é idêntica:

```text
System.Net.Http.HttpRequestException: Error while copying content to a stream.
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
```

Nos dois casos, `HttpRequestException.HttpRequestError` é `HttpRequestError.HttpProtocolError` e `HttpProtocolException.ErrorCode` é `1`. Verifique essas duas propriedades no código em vez do texto da mensagem.

A redação "the HTTP/2 server reset the stream" também é importante, porque o `SocketsHttpHandler` tem três mensagens de falha HTTP/2 diferentes e cada uma aponta para um problema distinto:

| Mensagem | Frame que o cliente recebeu | Escopo |
| --- | --- | --- |
| `The HTTP/2 server reset the stream. HTTP/2 error code '...'` | `RST_STREAM` | Apenas esta requisição |
| `The HTTP/2 server closed the connection. HTTP/2 error code '...'` | `GOAWAY` com um erro | Todos os streams dessa conexão |
| `The HTTP/2 server sent invalid data on the connection. HTTP/2 error code '...'` | nenhum, o próprio cliente detectou a violação | A conexão inteira |

Este post cobre a primeira linha. Se você vir a segunda ou a terceira, a própria conexão não está saudável e o diagnóstico é outro.

## Por que isso acontece

`PROTOCOL_ERROR` é o código mais genérico da [RFC 9113 seção 7](https://www.rfc-editor.org/rfc/rfc9113#section-7). Um peer o envia como erro de stream quando uma requisição (seus cabeçalhos, seu corpo ou seu enquadramento) viola uma regra, e o peer quer rejeitar essa requisição sem derrubar a conexão compartilhada. Esse design explica por que o erro parece aleatório "sob carga": uma conexão HTTP/2 transporta centenas de requisições simultâneas, o reset atinge apenas a requisição que disparou uma verificação e as demais têm sucesso. Mais tráfego significa mais requisições com a propriedade rara que dispara a verificação, então a taxa de falhas sobe com a carga mesmo que a carga não seja a causa.

As causas, ordenadas pela frequência com que aparecem para um cliente .NET:

1. **Um proxy no meio rejeitou algo naquela requisição.** Reverse proxies, service meshes, ingress controllers e load balancers de nuvem terminam o HTTP/2 e validam requisições com regras próprias: caracteres de cabeçalho que consideram inválidos, valores de cabeçalho com várias linhas, cabeçalhos específicos de conexão, limites de tamanho para cabeçalhos ou corpos. Exemplos reais: o Envoy resetando streams que carregam [caracteres malformados em cabeçalhos](https://github.com/envoyproxy/envoy/issues/7061), o nginx falhando com um [valor de cabeçalho de várias linhas](https://github.com/nginx/nginx/issues/540) sem registrar nada, e o próprio Kestrel rejeitando [pseudo-cabeçalhos depois de cabeçalhos regulares](https://github.com/dotnet/aspnetcore/issues/12190) enviados por um hop Envoy.
2. **O corpo da requisição não correspondia ao seu `Content-Length`.** O Kestrel reseta o stream com `PROTOCOL_ERROR` quando recebe mais ou menos bytes DATA do que o tamanho declarado (`Http2StreamErrorMoreDataThanLength` e `Http2StreamErrorLessDataThanLength` em [`Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs)). Um `HttpClient` do .NET detecta a própria divergência antes do servidor (você recebe `Sent 5 request content bytes, but Content-Length promised 50.`), então quando o Kestrel registra isso, normalmente é um cliente que não é .NET, ou um proxy que reescreveu o corpo sem corrigir o cabeçalho.
3. **O Kestrel rejeitou os pseudo-cabeçalhos da requisição.** `:method` inválido, `:path` inválido, `:scheme` divergente, um `Host`/`:authority` ruim ou um CONNECT estendido malformado terminam em `ResetAndAbort(..., Http2ErrorCode.PROTOCOL_ERROR)` no Kestrel. O `HttpClient` monta esses cabeçalhos sozinho, então você só chega a isso por meio de um proxy ou de um cliente feito à mão.
4. **O código da aplicação resetou o stream.** Qualquer middleware ou handler que chame `IHttpResetFeature.Reset(1)` produz exatamente este erro no cliente. É raro, mas alguns gateways e interceptors de gRPC fazem isso de propósito para sinalizar "requisição malformada".

Uma coisa que normalmente *não* é a causa: o cliente .NET enviando cabeçalhos ruins diretamente ao Kestrel. No meu repro, `TE: gzip`, `Connection: keep-alive` e um cabeçalho personalizado de 300 KB enviados por h2c ao Kestrel 10.0.10 voltaram todos como um `400 Bad Request` normal, não como um reset. Se você vir `PROTOCOL_ERROR` contra um backend Kestrel, suspeite primeiro do que está entre o cliente e o Kestrel.

## Repro mínimo

A forma mais simples de reproduzir a exceção exata é um endpoint Kestrel que reseta o próprio stream por meio de `IHttpResetFeature`, que é, byte a byte, o que um `RST_STREAM` de proxy parece do lado do cliente.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false
using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var hits = 0;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
// h2c (HTTP/2 without TLS) needs an HTTP/2-only endpoint
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(5199, o => o.Protocols = HttpProtocols.Http2));
var app = builder.Build();
app.MapGet("/reset/{code:int}", (HttpContext ctx, int code) =>
{
    Interlocked.Increment(ref hits);
    ctx.Features.Get<IHttpResetFeature>()!.Reset(code); // 1 = PROTOCOL_ERROR, 7 = REFUSED_STREAM
    return Results.Empty;
});
await app.StartAsync();

var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version20,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
};

foreach (var code in new[] { 1, 7 })
{
    hits = 0;
    try { await client.GetAsync($"http://localhost:5199/reset/{code}"); }
    catch (HttpRequestException e) when (e.InnerException is HttpProtocolException p)
    {
        Console.WriteLine($"code {code}: {e.HttpRequestError}, ErrorCode={p.ErrorCode}, server hits={hits}");
        Console.WriteLine($"  outer: {e.Message}");
    }
}
await app.StopAsync();
```

Saída:

```text
code 1: HttpProtocolError, ErrorCode=1, server hits=1
  outer: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
code 7: HttpProtocolError, ErrorCode=7, server hits=4
  outer: The request was aborted.
```

A coluna `server hits` é a parte útil. Um reset `PROTOCOL_ERROR` chega ao servidor uma vez e é lançado para você. Um reset `REFUSED_STREAM` sofre retry pelo próprio `SocketsHttpHandler`, porque a RFC 9113 garante que o peer não processou um stream recusado. O pool desiste depois de `MaxConnectionFailureRetries = 3` retries, então o servidor viu 4 tentativas. A fonte é [`Http2Stream.OnReset`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs), onde `canRetry` é verdadeiro apenas para `REFUSED_STREAM` e para streams que um `GOAWAY` marcou como não processados.

## A correção, em detalhe

### 1. Descubra qual hop enviou o reset

O cliente não consegue dizer quem enviou o `RST_STREAM`. Ele só sabe que o frame veio do peer ao qual está conectado, que é o primeiro hop HTTP/2: muitas vezes um proxy, não o seu serviço. Resolva isso antes de mudar código:

- **Ative os logs de debug de HTTP/2 do Kestrel no backend.** O Kestrel registra todo stream que reseta na categoria `Microsoft.AspNetCore.Server.Kestrel.Http2` no nível `Debug`, com mensagens como `HTTP/2 stream error "PROTOCOL_ERROR". A Reset is being sent to the stream.` (evento 35) e `HTTP/2 stream error.` (evento 30, carregando a `Http2StreamErrorException` com o motivo exato, por exemplo `More data received than specified in the Content-Length header.`).

```json
// appsettings.Development.json, ASP.NET Core 10
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore.Server.Kestrel.Http2": "Debug",
      "Microsoft.AspNetCore.Server.Kestrel.BadRequests": "Debug"
    }
  }
}
```

- **Se o Kestrel não registra nada para a requisição que falhou, o reset veio de um intermediário.** Procure no log de acesso do proxy naquela janela de tempo. O Envoy marca resets em seus response flags e nos detalhes `upstream_reset_before_response_started`, o nginx registra problemas de cabeçalho no nível `info` do seu log de erros (aumente `error_log` para `info` para vê-los) e os load balancers de nuvem normalmente expõem um código de motivo por requisição.
- **Contorne o proxy uma vez.** Chame o backend diretamente (port-forward, endereço interno) com a mesma requisição. Se o erro desaparecer, você provou qual hop é o responsável.

### 2. Corrija a requisição que o hop rejeitou

Depois de saber qual hop e qual regra, a correção geralmente está na requisição, não no transporte. Registre o método, o caminho, os nomes dos cabeçalhos, os tamanhos dos valores dos cabeçalhos e o tamanho do corpo das requisições que falham (nunca os valores de cabeçalhos de autenticação) e compare com as que tiveram sucesso. Os suspeitos de sempre:

- Valores de cabeçalho com caracteres fora do ASCII visível, quebras de linha embutidas ou espaços no início ou no fim, muitas vezes entrada do usuário copiada para um cabeçalho personalizado. O `HttpClient` bloqueia CR, LF e NUL, mas proxies estritos rejeitam mais do que isso.
- Cabeçalhos que só fazem sentido em HTTP/1.1 (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding`, `Upgrade` e `TE` com qualquer valor diferente de `trailers`). O `HttpClient` permite adicioná-los com `TryAddWithoutValidation`, e intermediários podem resetar um stream que os carrega.
- Uma requisição maior que os limites do proxy: cookies grandes, JWTs com muitas claims, corpos grandes em um proxy configurado com buffers pequenos. São as clássicas falhas "só para alguns usuários".
- Um `HttpContent` personalizado que define `Headers.ContentLength` e depois escreve um número diferente de bytes, ou um filtro de proxy que comprime ou reescreve o corpo. O equivalente fora do .NET disso é um `PROTOCOL_ERROR` direto do Kestrel.

### 3. Faça retry, mas apenas de requisições seguras para repetir

Quando o reset vem de uma infraestrutura que você não controla, adicione um retry. Um reset `PROTOCOL_ERROR` não informa se o servidor processou a requisição (um proxy pode resetar depois de encaminhá-la), então limite os retries a métodos idempotentes. Com `Microsoft.Extensions.Http.Resilience`:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.0.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

builder.Services.AddHttpClient("api", c =>
    {
        c.BaseAddress = new Uri("https://api.internal");
        c.DefaultRequestVersion = HttpVersion.Version20;
    })
    .AddResilienceHandler("h2-reset", pipeline =>
    {
        var retry = new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(50),
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.HttpProtocolError }),
        };
        retry.DisableForUnsafeHttpMethods(); // never replay POST, PUT, PATCH, DELETE, CONNECT
        pipeline.AddRetry(retry);
    });
```

Contra um endpoint que reseta a primeira tentativa e tem sucesso na segunda, um `GET` por esse cliente retornou `ok on attempt 2 via HTTP/2`, enquanto um `POST` ainda lançou o `PROTOCOL_ERROR` original após um único hit no servidor. Se você já usa `AddStandardResilienceHandler`, o `ShouldHandle` padrão dele trata `HttpRequestException` como transitória e também cobre este caso, mas ele faz retry de todos os métodos, a menos que você chame `DisableForUnsafeHttpMethods()` em `options.Retry`. Observe que `DisableForUnsafeHttpMethods` retorna `void`, então chame-o no objeto de opções antes de passá-lo a `AddRetry`, não em uma cadeia fluente.

### 4. Rebaixe o hop problemático para HTTP/1.1

Se o reset vem de um intermediário com uma implementação HTTP/2 com bugs ou excessivamente estrita, e você não pode corrigi-lo ou atualizá-lo, tire o HTTP/2 desse hop. No cliente:

```csharp
// .NET 10: ask for HTTP/1.1 for this client only
var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version11,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
};
```

No HTTP/1.1 não existe stream para resetar: o mesmo endpoint que resetou o stream sobre HTTP/2 respondeu `ok on attempt 2 via HTTP/1.1` no repro. Você perde a multiplexação, então espere mais conexões sob carga, e o gRPC não consegue fazer isso, pois exige HTTP/2. Trate isso como um workaround com uma issue aberta contra o proxy, não como a correção.

## Pegadinhas e variantes

- **`REFUSED_STREAM` parece semelhante, mas é um problema diferente.** A mensagem externa é `The request was aborted.` com a `HttpProtocolException` de `REFUSED_STREAM` dentro, e você só a vê depois que o handler já fez retry 3 vezes. Significa que o servidor ou proxy está recusando novos streams, normalmente porque atingiu o limite de streams simultâneos ou está sendo encerrado. Olhe `SETTINGS_MAX_CONCURRENT_STREAMS` no servidor e considere `SocketsHttpHandler.EnableMultipleHttp2Connections = true`.
- **`HTTP_1_1_REQUIRED` em um endpoint h2c local.** Se você configura o Kestrel com `HttpProtocols.Http1AndHttp2` em `http://` simples e força HTTP/2 no cliente, recebe `The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).` Sem TLS não há ALPN para negociar o protocolo, então o h2c precisa de um endpoint somente `Http2`.
- **Resets no meio do corpo com `ResponseHeadersRead`.** Quando você faz o streaming da resposta por conta própria, o código de status (muitas vezes `200`) já foi retornado quando o reset chega. Não trate um status de sucesso como prova de que o corpo está completo. A leitura lança `Error while copying content to a stream.`, ou a `HttpProtocolException` diretamente (sem o wrapper `HttpRequestException`) a partir de `ReadAsync` no stream da resposta.
- **Resilience handlers não conseguem fazer retry de um reset no meio do corpo.** O pipeline do handler retorna assim que os cabeçalhos da resposta chegam, e o `HttpClient` faz o buffer do corpo depois disso. Um reset durante o corpo, portanto, ignora o retry do passo 3, mesmo com o `ResponseContentRead` padrão. Se o corpo importa, envolva toda a operação de "enviar e ler" em um retry próprio para chamadas idempotentes.
- **O peer fechou a conexão em vez de resetar.** Se a exceção interna é `HttpIOException` com `ResponseEnded` em vez de `HttpProtocolException`, a conexão morreu sem um frame HTTP/2. Essa é a família de keep-alive e idle-timeout coberta na [correção de "the response ended prematurely"](/pt-br/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/).
- **Timeouts não são resets.** Se a chamada trava e depois falha com `TaskCanceledException`, nada resetou o stream. Comece por [por que o HttpClient lança "A task was canceled"](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Relacionados

- [Fix: HttpIOException "The response ended prematurely" in HttpClient](/pt-br/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) cobre o irmão deste erro no nível da conexão.
- [Polly vs resilience handlers in .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica onde o retry acima se encaixa e como o handler padrão é composto.
- [HttpClient vs IHttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/) mostra como configurar o cliente nomeado que este post usa.
- [Fix: The SSL connection could not be established](/pt-br/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) ajuda quando a falha acontece antes mesmo de o HTTP/2 ser negociado.
- [gRPC in containers: 4 traps you can fix](/pt-br/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) cobre os problemas de transporte exclusivo de HTTP/2 que o gRPC adiciona.

## Fontes

- [RFC 9113, HTTP/2: error codes (section 7) and stream errors (section 5.4.2)](https://www.rfc-editor.org/rfc/rfc9113#section-7)
- [`HttpProtocolException` class, Microsoft Learn](https://learn.microsoft.com/dotnet/api/system.net.http.httpprotocolexception)
- [`HttpProtocolException.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/HttpProtocolException.cs) e [`Http2Stream.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) em dotnet/runtime v10.0.0
- [Kestrel `Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) e [`KestrelTrace.Http2.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/KestrelTrace.Http2.cs) em dotnet/aspnetcore v10.0.0
- [Build resilient HTTP apps, Microsoft Learn](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [envoyproxy/envoy#7061](https://github.com/envoyproxy/envoy/issues/7061), [nginx/nginx#540](https://github.com/nginx/nginx/issues/540), [dotnet/aspnetcore#12190](https://github.com/dotnet/aspnetcore/issues/12190)
