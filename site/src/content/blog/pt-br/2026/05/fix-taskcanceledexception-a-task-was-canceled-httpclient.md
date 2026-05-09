---
title: "Correção: TaskCanceledException: A task was canceled no HttpClient"
description: "O HttpClient lança TaskCanceledException por três motivos diferentes: timeout, cancelamento pelo chamador ou um aborto em nível de conexão. Diferencie-os com InnerException e CancellationToken.IsCancellationRequested e corrija o motivo certo."
pubDate: 2026-05-09
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "cancellation"
lang: "pt-br"
translationOf: "2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient"
translatedBy: "claude"
translationDate: 2026-05-09
---

A correção: o `HttpClient` lança `TaskCanceledException` (uma subclasse de `OperationCanceledException`) por três causas distintas, e você precisa desambiguá-las antes de agir. Se `ex.InnerException is TimeoutException`, a requisição atingiu o `HttpClient.Timeout` (padrão de 100 segundos), então aumente o timeout ou mova chamadas de longa duração para um `CancellationTokenSource` por requisição. Se o seu próprio `CancellationToken` foi cancelado (`ex.CancellationToken.IsCancellationRequested == true`), é o chamador desistindo, e nenhuma correção é necessária além de deixar a exceção propagar. Se nenhuma dessas situações for verdadeira, você está diante de um aborto em nível de transporte (DNS, TCP, TLS, reset do servidor), o que geralmente aponta para infraestrutura, não para o seu código.

```text
System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.
 ---> System.TimeoutException: The operation was canceled.
 ---> System.Threading.Tasks.TaskCanceledException: The operation was canceled.
   at System.Threading.Tasks.TaskCompletionSource`1.TrySetCanceled(CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(...)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|...
   at MyApp.Program.<Main>$(String[] args)
```

Este guia foi escrito tendo como base o .NET 11 preview 4 e o `System.Net.Http` 11.0.0-preview.4. O tipo da exceção e o formato do `TimeoutException` aninhado não mudaram desde o .NET 5, mas o texto da mensagem foi refinado no .NET 8 para deixar claro qual timeout disparou ("The request was canceled due to the configured `HttpClient.Timeout` of 100 seconds elapsing"). No .NET 6 e anteriores você só recebia o genérico "A task was canceled.", motivo pelo qual tantos conselhos de antes de 2024 dizem para você logar a exceção interna manualmente.

## Por que o HttpClient lança TaskCanceledException para tudo

O pipeline do `HttpClient.SendAsync` é construído sobre `Task` e um único parâmetro `CancellationToken`. O timeout, o token do chamador e o aborto interno de conexão são todos vinculados em um único `CancellationTokenSource` antes de a requisição ir para o socket. Quando qualquer uma dessas fontes dispara, a operação completa com a mesma falha no formato de `OperationCanceledException`, independentemente de qual delas disparou primeiro.

A Microsoft confirmou essa decisão de design em [dotnet/runtime#21965](https://github.com/dotnet/runtime/issues/21965): o timeout não é exposto como `TimeoutException` diretamente porque mudar o tipo seria uma quebra binária. Em vez disso, o .NET 5 adicionou uma `InnerException` do tipo `TimeoutException` para que os chamadores possam distinguir os casos, e o .NET 8 adicionou o texto explícito da mensagem. A propriedade `CancellationToken` na exceção, definida pelo runtime, é o segundo desambiguador.

Então a mesma exceção cobre três problemas completamente diferentes. Agir sobre "task was canceled" sem inspecionar em qual caso você está é o motivo mais comum de esse bug ficar sem correção por semanas.

## Uma reprodução mínima para cada causa

```csharp
// .NET 11, C# 14, System.Net.Http 11.0.0-preview.4
using System.Net.Http;

// Cause 1: HttpClient.Timeout elapsed
using var c1 = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
try
{
    await c1.GetAsync("https://httpbin.org/delay/3");
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Inner: {ex.InnerException?.GetType().Name}");
    // Inner: TimeoutException
}

// Cause 2: caller's CancellationToken cancelled
using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
using var c2 = new HttpClient();
try
{
    await c2.GetAsync("https://httpbin.org/delay/3", cts.Token);
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Token cancelled: {ex.CancellationToken.IsCancellationRequested}");
    Console.WriteLine($"Linked token: {cts.Token == ex.CancellationToken}");
    // Token cancelled: True
}

// Cause 3: connection-level abort (DNS/TCP/TLS) - simulated with a closed port
using var c3 = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
try
{
    await c3.GetAsync("http://10.255.255.1/");
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    Console.WriteLine("Looks like a timeout, was actually connect failure under timeout.");
}
catch (HttpRequestException ex)
{
    Console.WriteLine($"True transport failure: {ex.HttpRequestError}");
    // .NET 8+ exposes ex.HttpRequestError = ConnectionError, NameResolutionError, etc.
}
```

O terceiro caso é interessante. Se o timeout de conexão for atingido, você recebe `HttpRequestException` com `ex.HttpRequestError == HttpRequestError.ConnectionError`. Se a conexão for bem-sucedida mas a resposta travar tempo suficiente para disparar o `HttpClient.Timeout`, você volta ao caso 1. Os dois parecem quase idênticos nos logs, mas exigem correções diferentes.

## Correção, em detalhes

### 1. Diagnostique primeiro, com um filtro de exceção

Antes de mudar qualquer timeout, registre em qual caso você está. Caso contrário, você vai aumentar `Timeout` para 5 minutos e descobrir que o problema real era um chamador cancelando.

```csharp
// .NET 11, C# 14
try
{
    return await client.GetAsync(url, ct);
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    logger.LogWarning(ex,
        "HttpClient.Timeout elapsed for {Url} (configured: {Timeout})",
        url, client.Timeout);
    throw;
}
catch (OperationCanceledException ex) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Caller cancelled request to {Url}", url);
    throw;
}
catch (TaskCanceledException ex)
{
    logger.LogError(ex, "Unknown cancellation cause for {Url}", url);
    throw;
}
```

`OperationCanceledException` é o tipo pai e é o que você quer no ramo de cancelamento pelo chamador, já que o tipo exato em runtime pode ser `OperationCanceledException` ou `TaskCanceledException` dependendo de onde no pipeline o cancelamento disparou.

### 2. Aumente HttpClient.Timeout, mas só para os clientes que precisam

`HttpClient.Timeout` é por cliente e se aplica a toda requisição que não passar um token com seu próprio timeout. O padrão de 100 segundos é adequado para chamadas REST típicas. Se você tiver um endpoint de longa duração, dê a ele um cliente dedicado.

```csharp
// .NET 11
builder.Services.AddHttpClient("LongRunning", c =>
{
    c.Timeout = TimeSpan.FromMinutes(10);
    c.BaseAddress = new Uri("https://reports.example.com/");
});

builder.Services.AddHttpClient("Default", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
});
```

Não aumente `Timeout` no cliente global só para fazer uma chamada lenta funcionar. Você vai esconder regressões futuras: uma chamada que deveria levar 200ms mas começa a levar 90s vai passar silenciosamente pelo limite frouxo e aparecer como travamento de UI. Timeouts mais apertados pegam regressões de desempenho cedo. O [tutorial sobre testes unitários com HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) mostra como exercitar esses limites de timeout em testes para que uma regressão aqui não escape do CI.

### 3. Mude para CancellationTokenSource por requisição para controle fino

`HttpClient.Timeout` é um instrumento bruto. Dentro de um `BackgroundService` ou um pipeline de requisição que já tem um token, vincule-os:

```csharp
// .NET 11, C# 14
using var perCallCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
using var linked = CancellationTokenSource.CreateLinkedTokenSource(
    perCallCts.Token, requestAborted);

try
{
    var response = await client.GetAsync(url, linked.Token);
    return await response.Content.ReadAsStringAsync(linked.Token);
}
catch (OperationCanceledException) when (perCallCts.IsCancellationRequested
                                          && !requestAborted.IsCancellationRequested)
{
    // Per-call timeout, not caller cancellation. Surface as your own timeout type.
    throw new TimeoutException($"GET {url} exceeded 15 seconds.");
}
```

Esse padrão se compõe limpamente com `IHttpClientFactory`: mantenha o `Timeout` do cliente nomeado alto (ou `Timeout.InfiniteTimeSpan`) e imponha o orçamento real no local da chamada com o CTS vinculado. O motivo pelo qual `Timeout.InfiniteTimeSpan` funciona aqui é que o `HttpClient` só adiciona seu `Timeout` ao token vinculado quando ele é positivo, então um `Timeout` infinito no cliente significa "o chamador está no comando". O [tutorial sobre deadlock de cancelamento](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cobre o padrão de token vinculado em mais detalhes, incluindo como diferenciar timeouts de cancelamentos do chamador em camadas mais altas.

### 4. Use HttpCompletionOption.ResponseHeadersRead para corpos em streaming

`HttpClient.Timeout` cobre o tempo de `SendAsync` até "pronto para ler o corpo" apenas quando o `HttpCompletionOption.ResponseContentRead` padrão é usado. Com `ResponseHeadersRead`, o timeout se aplica apenas até o recebimento dos cabeçalhos. A leitura do corpo fica por sua conta para dar timeout, conforme confirmado na [documentação do HttpCompletionOption](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption).

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
using var response = await client.GetAsync(
    url, HttpCompletionOption.ResponseHeadersRead, cts.Token);

response.EnsureSuccessStatusCode();
await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
await using var file = File.Create(path);
await stream.CopyToAsync(file, cts.Token);
```

Passe o mesmo token em todos os lugares. Um bug comum é passar `cts.Token` para `GetAsync` mas esquecê-lo em `CopyToAsync`, caso em que `HttpClient.Timeout` não se aplica mais ao corpo e um produtor travado fica suspenso para sempre. O [post sobre streaming a partir do ASP.NET Core](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cobre o erro simétrico do lado do servidor, em que esquecer de encaminhar o `CancellationToken` da requisição produz o mesmo travamento no produtor.

### 5. Configure o timeout de conexão separadamente no .NET 8 e posteriores

`HttpClient.Timeout` cobre toda a requisição, mas DNS e conexão TCP fazem parte desse orçamento. Se você quer que DNS ou conexão falhem rápido, independentemente do timeout da requisição, defina `SocketsHttpHandler.ConnectTimeout`:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(5),
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
};

builder.Services.AddHttpClient("Api", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.BaseAddress = new Uri("https://api.example.com/");
}).ConfigurePrimaryHttpMessageHandler(() => handler);
```

Um timeout de conexão curto converte "espere 30 segundos por nada" em "falhe em 5 segundos, tente novamente em outro endpoint". Distinguir timeouts de conexão dos de resposta é a diferença entre um circuit breaker do Polly que abre rápido e um que arrasta cada chamador pela janela completa de timeout.

## Formatos comuns que disparam isso

### Cliente tipado do IHttpClientFactory com o Timeout errado

Um cliente tipado herda o `Timeout` que você configurou em `AddHttpClient`, não a propriedade que você definiu no `HttpClient` depois. Código que faz `_client.Timeout = TimeSpan.FromMinutes(5)` a partir de injeção de dependência no construtor lança `InvalidOperationException` assim que uma requisição já tiver passado pelo cliente. A factory recicla o handler subjacente, mas a instância de `HttpClient` é de uso único para fins de `Timeout`. Configure o timeout em `AddHttpClient`, não no construtor do cliente tipado.

### Um Task.WhenAll com tokens incompatíveis

Quando você faz fan-out de N chamadas HTTP com `Task.WhenAll(tasks)` e uma é cancelada, só ela lança a exceção. As demais continuam rodando e podem também atingir timeouts. Se seu código relança o primeiro cancelamento, as tarefas sobreviventes ficam não observadas e suas exceções aparecem em `TaskScheduler.UnobservedTaskException`. Use `Task.WhenAll` com um CTS vinculado compartilhado que você cancela na primeira falha, para que as requisições restantes também parem.

### Política de retry do Polly esconde o timeout interno

Um handler de retry do Polly que engole `TaskCanceledException` e tenta novamente pode mascarar inteiramente o timeout subjacente. Se o upstream estiver de fato lento, você transforma uma espera de 100 segundos em três esperas de 100 segundos e depois desiste. Configure o Polly para fazer curto-circuito em `TimeoutException` interna e deixar o chamador decidir.

```csharp
// .NET 11, Microsoft.Extensions.Http.Resilience 11.0.0-preview.4
builder.Services.AddHttpClient("Api")
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
        options.Retry.ShouldHandle = args => args.Outcome switch
        {
            { Exception: HttpRequestException } => PredicateResult.True(),
            { Exception: TaskCanceledException tce } when tce.InnerException is TimeoutException
                => PredicateResult.False(),
            _ => PredicateResult.False(),
        };
    });
```

O `AddStandardResilienceHandler` do pacote `Microsoft.Extensions.Http.Resilience` separa timeouts por tentativa e de requisição total de forma limpa, sendo a substituição limpa para código artesanal de Polly + CTS vinculado.

### Wait ou Result síncronos em uma chamada do HttpClient

`client.GetAsync(url).Result` causa deadlock sob um contexto de sincronização de uma só thread (ASP.NET clássico, WPF) e aparece como `TaskCanceledException` quando o `HttpClient.Timeout` finalmente dispara 100 segundos depois. A correção é `await`, ponto final. O deadlock faz com que a requisição nunca inicie a fase de resposta, o timer eventualmente dispara e o sintoma parece um timeout de rede. Se você vê "task was canceled" sem saída de rede em seus rastreamentos, procure chamadas síncronas bloqueantes na pilha de chamadas. O [post sobre o padrão BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) cobre a regra de async-em-todo-o-caminho para serviços hospedados, onde isso morde mais forte.

### Reutilização de HttpRequestMessage

`HttpRequestMessage` não pode ser enviado duas vezes. O segundo `SendAsync` lança `InvalidOperationException: The request message was already sent`. Algumas bibliotecas de retry encobrem isso e a falha aparece como um cancelamento de uma requisição diferente que compartilhou um token com a que falhou. Sempre crie uma nova `HttpRequestMessage` por tentativa.

## Variantes que parecem este erro mas não são

### "The operation was canceled" sem exceção interna, no .NET Framework 4.8

No .NET Framework, a `InnerException` raramente é uma `TimeoutException`. O padrão de desambiguação no passo 1 só funciona no .NET 5 e posteriores. Se você ainda está no Framework, seu melhor sinal é comparar `ex.CancellationToken` com o token que você passou e registrar o tempo decorrido antes do throw. A ergonomia desse caso é um dos melhores motivos para terminar de migrar do Framework mais cedo do que tarde.

### "An error occurred while sending the request" envolvendo SocketException

Classe de exceção totalmente diferente (`HttpRequestException`), quase sempre um problema de transporte (DNS, TCP RST, falha de handshake TLS). No .NET 8+, `ex.HttpRequestError` enumera a causa: `ConnectionError`, `NameResolutionError`, `SecureConnectionError`, etc. A correção mora no DNS, firewall ou configuração de certificado, não no seu código.

### "The SSL connection could not be established"

A exceção interna é `AuthenticationException` de `System.Net.Security`. Isto é uma falha de negociação TLS, não um timeout, mesmo que possa demorar segundos e parecer superficialmente similar. Verifique a cadeia de certificados, o host SNI e a versão do protocolo TLS (`SslProtocols.Tls12 | SslProtocols.Tls13` é o padrão do .NET 11).

### "A connection attempt failed because the connected party did not properly respond"

`SocketException` com `ErrorCode == 10060` (WSAETIMEDOUT). Dispara quando um syn-ack nunca chega. Geralmente uma queda de firewall em nível de rede. Surgir como `TaskCanceledException` só acontece quando o `HttpClient.Timeout` envolvente é mais curto que o timeout de conexão do nível do SO; caso contrário, você recebe um `HttpRequestException`.

### "Request was forcibly aborted" via CancelPendingRequests

Chamar `HttpClient.CancelPendingRequests` cancela todas as requisições em andamento naquele cliente, não apenas uma. Se sua aplicação reutiliza um cliente e um componente chama `CancelPendingRequests`, todas as requisições pendentes de outros componentes falham com a mesma `TaskCanceledException`. Este é um dos motivos mais fortes para usar `IHttpClientFactory` em vez de um cliente estático de longa duração. Os clientes tipados por chamada da factory são fachadas de curta duração, então um `CancelPendingRequests` perdido só afeta o chamador.

## Relacionados

Para o padrão completo de cancelamento, o [tutorial cancelar uma tarefa de longa duração](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cobre `CancellationToken`, `Task.WaitAsync` e o formato de token vinculado usado acima. O [guia de testes unitários com HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) mostra como simular timeouts em testes para que os ramos de timeout sejam de fato exercitados. Para downloads em streaming, o [post sobre streaming a partir do ASP.NET Core](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cobre o encaminhamento correspondente de cancelamento do lado do servidor. Se seus workers em segundo plano estão emitindo essas chamadas, o [tutorial sobre BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) cobre as regras de tempo de vida e cancelamento que mantêm o padrão de token vinculado correto sob desligamento do host.

## Fontes

- [Propriedade `HttpClient.Timeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.timeout), Microsoft Learn.
- [Enum `HttpCompletionOption`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption), Microsoft Learn.
- [`SocketsHttpHandler.ConnectTimeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.connecttimeout), Microsoft Learn.
- [Enum `HttpRequestError`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn.
- [HttpClient throws TaskCanceledException on timeout](https://github.com/dotnet/runtime/issues/21965), issue dotnet/runtime.
- [How to identify HttpClient connect timeout errors?](https://github.com/dotnet/runtime/issues/78070), issue dotnet/runtime.
- [Handler padrão do `Microsoft.Extensions.Http.Resilience`](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience), Microsoft Learn.
