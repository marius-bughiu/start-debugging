---
title: "Correção: HttpIOException: The response ended prematurely no HttpClient do .NET"
description: "O HttpClient reutiliza uma conexão keep-alive que o servidor acabou de fechar, ou o servidor derruba a conexão no meio da resposta. Reduza o PooledConnectionIdleTimeout para abaixo do tempo limite de ociosidade do servidor e repita apenas requisições idempotentes."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "httpclient"
  - "networking"
lang: "pt-br"
translationOf: "2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient"
translatedBy: "claude"
translationDate: 2026-09-24
---

`HttpIOException: The response ended prematurely. (ResponseEnded)` significa que a conexão TCP foi fechada antes de o `HttpClient` receber uma resposta HTTP completa. A causa mais comum é uma corrida de keep-alive: o `HttpClient` envia uma requisição por uma conexão do pool no exato momento em que o servidor a fecha por estar ociosa. Defina `SocketsHttpHandler.PooledConnectionIdleTimeout` bem abaixo do tempo limite de ociosidade do servidor (ou do load balancer) e repita `ResponseEnded` apenas para requisições que podem ser enviadas duas vezes com segurança. Se o erro acontece em toda requisição, você está falando com a coisa errada: `http://` contra uma porta HTTPS, ou um mapeamento de porta do Docker sem nada escutando por trás.

Tudo abaixo foi reproduzido no .NET 10.0.10 (SDK 10.0.302) e no .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) contra pequenos servidores de socket bruto que se comportam mal de propósito. Os dois runtimes deram resultados idênticos byte a byte.

## O erro em contexto

A exceção que você vê no ponto de chamada é quase sempre uma `HttpRequestException` que encapsula a `HttpIOException`:

```text
System.Net.Http.HttpRequestException: An error occurred while sending the request.
 ---> System.Net.Http.HttpIOException: The response ended prematurely. (ResponseEnded)
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|83_0(HttpRequestMessage request, HttpCompletionOption completionOption, CancellationTokenSource cts, Boolean disposeCts, CancellationTokenSource pendingRequestsCts, CancellationToken originalCancellationToken)
```

Existem três variantes da mensagem, e a que você recebe indica onde a conexão morreu:

| Mensagem externa | Mensagem interna | O que significa |
| --- | --- | --- |
| `An error occurred while sending the request.` | `The response ended prematurely. (ResponseEnded)` | EOF antes de chegar um único byte da linha de status |
| `Error while copying content to a stream.` | `The response ended prematurely. (ResponseEnded)` | Os cabeçalhos chegaram, o corpo foi cortado (leitura com buffer) |
| nenhuma, a `HttpIOException` é lançada diretamente | `The response ended prematurely, with at least 90 additional bytes expected. (ResponseEnded)` | Corpo cortado enquanto você mesmo lia o stream |

Conexões HTTP/2 adicionam uma quarta: `The response ended prematurely while waiting for the next frame from the server.` Desde o .NET 8, `HttpRequestException.HttpRequestError` e `HttpIOException.HttpRequestError` são ambos definidos como `HttpRequestError.ResponseEnded` em todos esses casos, e é isso que o seu código deve verificar em vez de analisar strings de mensagem.

## Por que isso acontece

O `SocketsHttpHandler` lança `ResponseEnded` sempre que uma leitura do socket retorna 0 bytes (um FIN limpo do outro lado) enquanto ele ainda espera dados. A origem são duas linhas em `HttpConnection.cs`: um buffer de leitura vazio depois de enviar a requisição, ou `bytesRead == 0` dentro de `FillAsync`. Nada no .NET decidiu falhar. O outro lado fechou a conexão. A questão é por quê, e as causas, ordenadas pela frequência com que aparecem, são:

1. **Corrida de keep-alive.** O servidor (ou um proxy, ou um load balancer na nuvem) fecha conexões ociosas depois de N segundos. O `HttpClient` mantém conexões ociosas por 60 segundos por padrão. Se N for menor, cedo ou tarde uma requisição sai por uma conexão que o servidor está fechando exatamente naquele momento. Esta é a versão intermitente, do tipo "funciona 99% das vezes".
2. **Nada de verdade está escutando.** Docker Desktop, `kubectl port-forward`, túneis SSH e alguns proxies reversos aceitam a conexão TCP eles mesmos e depois a fecham quando o backend não está lá. Você recebe `ResponseEnded` em vez de `Connection refused`.
3. **Protocolo errado na porta.** Enviar `http://` simples para uma porta que só aceita TLS (uma confusão comum no `launchSettings.json` do Kestrel) faz o servidor falhar o handshake e fechar o socket.
4. **O servidor travou ou desistiu no meio da resposta.** Um processo que morre durante o streaming, um proxy que atinge um limite de tamanho ou de tempo, ou um handler que define `Content-Length` maior do que o que ele escreve. Isso gera as variantes da fase do corpo.

## Reprodução mínima

Este app baseado em arquivo inicia um servidor TCP bruto que responde à primeira requisição de cada conexão e fecha a conexão sem responder à segunda, que é exatamente a aparência de um tempo limite de ociosidade do lado do servidor disparando durante a sua requisição.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
int connections = 0;

_ = Task.Run(async () =>
{
    while (true)
    {
        var tcp = await listener.AcceptTcpClientAsync();
        int connectionId = Interlocked.Increment(ref connections);
        _ = Task.Run(async () =>
        {
            using (tcp)
            {
                var stream = tcp.GetStream();
                for (int requestNo = 1; ; requestNo++)
                {
                    if (!await ReadRequestAsync(stream)) return;
                    Console.WriteLine($"  server: connection {connectionId}, request {requestNo}");
                    if (requestNo == 2) return; // idle timeout fires: close, no response
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"u8.ToArray());
                }
            }
        });
    }
});

using var client = new HttpClient();
foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
{
    for (int i = 1; i <= 2; i++)
    {
        try
        {
            using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{port}/");
            if (method == HttpMethod.Post) request.Content = new StringContent("{}");
            using var response = await client.SendAsync(request);
            Console.WriteLine($"{method} #{i}: {await response.Content.ReadAsStringAsync()}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"{method} #{i}: {ex.HttpRequestError} / {ex.InnerException?.Message}");
        }
    }
}

// Reads one request: headers up to the blank line, then Content-Length bytes of body.
static async Task<bool> ReadRequestAsync(NetworkStream stream)
{
    var data = new List<byte>();
    var buffer = new byte[8192];
    int headerEnd;
    while ((headerEnd = Encoding.ASCII.GetString(data.ToArray()).IndexOf("\r\n\r\n")) < 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        data.AddRange(buffer.AsSpan(0, read));
    }
    var headers = Encoding.ASCII.GetString(data.ToArray(), 0, headerEnd);
    var lengthLine = headers.Split("\r\n")
        .FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
    int remaining = (lengthLine is null ? 0 : int.Parse(lengthLine[15..])) - (data.Count - headerEnd - 4);
    while (remaining > 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        remaining -= read;
    }
    return true;
}
```

Saída no .NET 10.0.10 e no .NET 11 RC 1:

```text
  server: connection 1, request 1
GET #1: ok
  server: connection 1, request 2
  server: connection 2, request 1
GET #2: ok
  server: connection 2, request 2
POST #1: ResponseEnded / The response ended prematurely. (ResponseEnded)
  server: connection 3, request 1
POST #2: ok
```

Leia as linhas do servidor. O `GET #2` também caiu na conexão morta (conexão 1, requisição 2), e o `SocketsHttpHandler` o reenviou silenciosamente por uma conexão 2 novinha. O `POST #1` então reutilizou a conexão 2, foi derrubado do mesmo jeito e fez a exceção aparecer. O handler reenvia uma requisição que falhou apenas quando ela saiu por uma conexão reutilizada do pool e não tinha corpo, ou quando o corpo foi retido por `Expect: 100-continue` (a flag `_canRetry` em `HttpConnection.SendAsync`). Um `POST` com conteúdo nunca é reenviado, porque o handler não tem como saber se o servidor já agiu sobre ele. É por isso que esse erro aparece nos logs para as suas escritas e quase nunca para as suas leituras.

## Correção 1: mantenha conexões ociosas por menos tempo que o servidor

A correção duradoura para a versão intermitente é garantir que o `HttpClient` descarte uma conexão ociosa antes que o servidor o faça. Encontre o menor tempo limite de ociosidade no caminho: o próprio serviço, qualquer proxy reverso e o load balancer. Alguns padrões reais:

- `KeepAliveTimeout` do Kestrel: 130 segundos, mais do que o padrão do cliente, então .NET com .NET funciona bem de fábrica.
- `http.Server` do Node.js 26: `keepAliveTimeout` de 5 segundos, `keepAliveTimeoutBuffer` de 1 segundo.
- uvicorn: `--timeout-keep-alive` de 5 segundos. Gunicorn: `keepalive` de 2 segundos.
- AWS Application Load Balancer: tempo limite de ociosidade de 60 segundos, o mesmo que o padrão do cliente, o que torna a corrida possível em toda conexão que fica ociosa por cerca de um minuto.

Depois configure o handler abaixo desse número. Com `IHttpClientFactory`:

```csharp
// .NET 10, Microsoft.Extensions.Http 10.0.12
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.internal/"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Server or load balancer closes idle connections after 60s (AWS ALB default).
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        // Also recycle connections so DNS changes are picked up.
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    });
```

Deixe uma margem real. O `PooledConnectionIdleTimeout` não é verificado quando uma conexão é retirada do pool. Ele é aplicado por um timer de limpeza em segundo plano que roda a cada `PooledConnectionIdleTimeout / 4`, com um mínimo de um segundo (`HttpConnectionPoolManager.cs`). Uma conexão pode, portanto, viver até cerca de 1,25 vez o tempo limite de ociosidade configurado, ou o tempo limite de ociosidade mais um segundo para valores pequenos. Metade do tempo limite do servidor é uma regra segura.

O que é verificado no momento de retirar a conexão é o próprio cabeçalho de resposta `Keep-Alive: timeout=N` do servidor. `HttpConnection.PrepareForReuse` chama `CheckKeepAliveTimeoutExceeded()` e descarta a conexão se ela ficou ociosa por N segundos ou mais, tanto no HTTP/1.1 quanto no 1.0. É por isso que serviços Node.js raramente disparam isso: o Node anuncia `timeout=5` e de fato fecha depois de 6. Se o servidor é seu, enviar um cabeçalho `Keep-Alive` com um valor menor que o tempo limite real é uma correção que protege todos os clientes, não só os de .NET.

Medi as três opções contra um servidor que fecha conexões depois de exatamente 2.000 ms de ociosidade, com um cliente que envia um `POST` a cada 1.990-2.010 ms (150 requisições cada, .NET 10.0.10):

| Configuração cliente/servidor | Sucesso | `ResponseEnded` |
| --- | --- | --- |
| Padrões (`PooledConnectionIdleTimeout` 60 s) | 147 | 3 |
| `PooledConnectionIdleTimeout = 800 ms` | 150 | 0 |
| Servidor envia `Keep-Alive: timeout=1` | 150 | 0 |

Três falhas em 150 é o que torna esse erro tão irritante em produção: é raro o bastante para passar em todos os testes e frequente o bastante para acionar o plantão de alguém. Na maioria das vezes o FIN do servidor chega antes da próxima requisição, e o `PrepareForReuse` vê a conexão fechada e abre uma nova discretamente. Ele só aparece quando o fechamento cai nos poucos milissegundos entre essa verificação e a saída da requisição. As duas correções o eliminaram completamente. O tempo limite de ociosidade de 800 ms funciona porque o limpador (rodando a cada segundo com essa configuração) descarta as conexões antes do tempo limite de 2.000 ms do servidor. O cabeçalho funciona porque o cliente o verifica de forma síncrona a cada retirada do pool.

## Correção 2: repita `ResponseEnded`, mas só quando uma segunda tentativa for segura

Tempos limite reduzem a corrida, mas não conseguem eliminá-la: um servidor ainda pode reiniciar, reduzir a escala ou derrubar uma conexão pelos próprios motivos. Então trate `ResponseEnded` como transitório, com uma condição. O servidor pode ter recebido e processado a requisição antes de fechar o socket. Meu servidor de reprodução leu o corpo completo de cada requisição que depois derrubou. Para um `POST` que cria um pedido, uma nova tentativa às cegas pode criar dois pedidos.

O `AddStandardResilienceHandler()` não faz essa distinção por você. O `ShouldHandle` padrão dele (`HttpClientResiliencePredicates.IsTransient`) trata toda `HttpRequestException` como transitória, para todo método HTTP. Chame `options.Retry.DisableForUnsafeHttpMethods()`, ou escreva um predicado que repita métodos não seguros apenas quando a requisição carrega uma chave de idempotência que o servidor usa para deduplicar:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddHttpClient<OrdersClient>()
    .AddResilienceHandler("stale-connection", pipeline => pipeline.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 1,
        Delay = TimeSpan.Zero, // a new connection is all we need, no backoff
        ShouldHandle = args => ValueTask.FromResult(
            args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.ResponseEnded }
            && args.Context.GetRequestMessage() is { } request
            && (request.Method == HttpMethod.Get
                || request.Method == HttpMethod.Put
                || request.Method == HttpMethod.Delete
                || request.Headers.Contains("Idempotency-Key"))),
    }));
```

E no ponto de chamada:

```csharp
// .NET 10
using var request = new HttpRequestMessage(HttpMethod.Post, "orders") { Content = JsonContent.Create(order) };
request.Headers.Add("Idempotency-Key", order.ClientRequestId.ToString());
using var response = await http.SendAsync(request, ct);
```

Contra o servidor de reprodução (que derruba a segunda requisição de cada conexão), três `POST`s com esse handler retornaram `200 ok`, com uma nova tentativa cada para o segundo e o terceiro. O servidor viu cinco requisições em três conexões, e esse é o ponto: as duas derrubadas chegaram até ele. Se a sua lógica de nova tentativa fica em um `DelegatingHandler`, tenha em mente [onde esse handler roda em relação ao loop de novas tentativas](/pt-br/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/), e leia [Polly vs os handlers de resiliência nativos](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) se estiver decidindo entre as duas APIs.

## Correção 3: quando falha em toda requisição

Um `ResponseEnded` consistente na primeira requisição de um processo novo não é uma corrida. Meu teste produziu exatamente a mesma exceção nestes dois casos:

**`http://` contra um endpoint TLS.** Um servidor que só fala TLS recebe `GET / HTTP/1.1` como um ClientHello inválido, falha o handshake e fecha. Confira o esquema e a porta contra o `launchSettings.json` (o perfil padrão do Kestrel escuta em uma porta `https` e em uma porta `http`, e é fácil combinar as erradas) ou contra `ASPNETCORE_URLS`. O erro oposto, `https://` contra uma porta HTTP simples, gera [the SSL connection could not be established](/pt-br/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) em vez disso.

**Um listener sem nada por trás.** O Docker publica portas através do próprio proxy. Se o app dentro do contêiner escuta em `localhost` em vez de `0.0.0.0` (`ASPNETCORE_URLS=http://+:8080` resolve isso para ASP.NET Core), ou travou, o proxy aceita a sua conexão e a fecha imediatamente. Rode `curl -v http://localhost:8080/` na mesma máquina. Se o curl reportar `Empty reply from server`, o problema não está no seu código .NET.

## Correção 4: quando o que é cortado é o corpo

Se a mensagem externa é `Error while copying content to a stream.`, ou você mesmo lê o stream e vê `with at least N additional bytes expected`, a linha de status e os cabeçalhos chegaram e a conexão foi fechada no meio do corpo. Os logs do lado do servidor são onde está a resposta:

- O processo upstream travou ou foi encerrado (OOM, despejo de pod, uma implantação) durante o streaming.
- Um proxy cortou a resposta em um limite de tamanho ou de duração. O `proxy_read_timeout` do nginx, um limite de resposta de CDN ou um teto de payload de um API gateway terminam todos assim.
- O servidor declarou um `Content-Length` maior do que os bytes que escreveu, geralmente um middleware que alterou o corpo (compressão, reescrita) depois que o cabeçalho foi definido. O .NET informa a diferença com exatidão: 90 bytes na minha reprodução, em que o cabeçalho dizia 100 e o servidor enviou 10.
- Uma resposta chunked terminou sem o chunk final de tamanho zero, o que também produz a variante `copying content`.

Repetir um corpo truncado só é seguro sob as mesmas regras de idempotência da Correção 2, porque o servidor certamente processou essa requisição.

## Armadilhas e erros parecidos

**`HttpRequestError` existe apenas no .NET 8 e posteriores.** No .NET 6 e 7 a exceção interna é uma `IOException` simples com a mensagem `The response ended prematurely.`, e não há enum para usar em um switch. O comportamento de keep-alive e todas as correções acima são os mesmos.

**`Connection reset by peer` é a mesma corrida, um passo depois.** Se o servidor fecha um socket que ainda tem dados de requisição não lidos no buffer de recepção, o kernel envia RST em vez de FIN, e você recebe uma `HttpRequestException` encapsulando `IOException: Unable to read data from the transport connection: Connection reset by peer` (`An existing connection was forcibly closed by the remote host` no Windows). As correções são idênticas.

**`PooledConnectionIdleTimeout = TimeSpan.Zero` desativa o pooling.** Isso torna a corrida impossível, e no meu teste transformou o `POST` que falhava em sucesso, mas toda requisição passa a pagar por um novo handshake TCP (e TLS). Use apenas para diagnóstico: se o erro desaparece com isso, você confirmou a corrida de keep-alive.

**`TaskCanceledException` é uma falha diferente.** Uma requisição que atinge `HttpClient.Timeout` termina com [a task was canceled](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), não com `ResponseEnded`. Se você vê os dois, o servidor provavelmente está lento e algo na frente dele está fechando conexões que esperam demais.

**Criar um novo `HttpClient` por requisição não resolve.** Isso esconde a corrida de keep-alive por nunca reutilizar conexões, e a troca por esgotamento de sockets sob carga. [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/) cobre as regras de tempo de vida que realmente funcionam.

## Relacionados

- [Correção: TaskCanceledException: A task was canceled com HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), a contraparte de tempo limite deste erro.
- [Correção: The SSL connection could not be established](/pt-br/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/), para a confusão de esquema na direção oposta.
- [Por que um DelegatingHandler não roda a cada nova tentativa com AddStandardResilienceHandler](/pt-br/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/).
- [Polly vs handlers de resiliência no .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/).
- [Como fazer teste unitário de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/), se você quer um teste que lance `HttpRequestException` com `HttpRequestError.ResponseEnded` para cobrir o seu predicado de nova tentativa.

## Fontes

- [`HttpConnection.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnection.cs) (`SendAsync`, `FillAsync`, `PrepareForReuse`, `CheckKeepAliveTimeoutExceeded`) e [`HttpConnectionPoolManager.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnectionPoolManager.cs) (período do limpador) no branch `release/10.0` do dotnet/runtime.
- [`ContentLengthReadStream.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/ContentLengthReadStream.cs) e as [strings de recurso do System.Net.Http](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/Resources/Strings.resx) para as mensagens exatas.
- [Enum `HttpRequestError`](https://learn.microsoft.com/dotnet/api/system.net.http.httprequesterror) e [`SocketsHttpHandler.PooledConnectionIdleTimeout`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.pooledconnectionidletimeout) no Microsoft Learn.
- [Diretrizes do HttpClient para .NET](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines), sobre o tempo de vida de conexões do pool e a reutilização do cliente.
- [`HttpClientResiliencePredicates.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpClientResiliencePredicates.cs) e [`HttpRetryStrategyOptionsExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpRetryStrategyOptionsExtensions.cs) no dotnet/extensions.
- [`server.keepAliveTimeout` do Node.js](https://nodejs.org/api/http.html#serverkeepalivetimeout) e [tempo limite de ociosidade de conexão do AWS ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout).
