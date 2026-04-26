---
title: "Como fazer testes unitários de código que usa HttpClient"
description: "Um guia completo para testar HttpClient no .NET 11: por que você não deve mockar HttpClient diretamente, como escrever um HttpMessageHandler de stub, trocar o handler primário com IHttpClientFactory, verificar retentativas do Polly e a opção WireMock.Net."
pubDate: 2026-04-26
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "httpclient"
lang: "pt-br"
translationOf: "2026/04/how-to-unit-test-code-that-uses-httpclient"
translatedBy: "claude"
translationDate: 2026-04-26
---

Para fazer testes unitários de código que conversa com uma API HTTP, não mock o `HttpClient` em si. Substitua o `HttpMessageHandler` dele por um stub que retorne a resposta que você quer simular, e então injete o `HttpClient` resultante (ou um `IHttpClientFactory` que entregue um) na classe sob teste. O handler é o ponto de extensão, não o cliente. Tudo o que segue tem como alvo .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) com xUnit 2.9, mas o padrão é o mesmo no .NET 6, 8, 9 e 10.

## Por que mockar HttpClient diretamente é a abordagem errada

`HttpClient` tem uma superfície pública (`GetAsync`, `PostAsync`, `SendAsync`) que parece mockável, e o Moq vai deixar você criar um mock sem reclamar. O problema é o que esses métodos realmente fazem: cada um deles desemboca em `HttpMessageInvoker.SendAsync(HttpRequestMessage, CancellationToken)` no `HttpMessageHandler` subjacente. Os métodos de conveniência do `HttpClient` não são `virtual`, o que significa que um `Mock<HttpClient>` ou não intercepta nada, ou depende de ferramentas como `Protected()` do Moq para alcançar elementos internos privados.

Duas consequências práticas:

1. Testes que mockam `HttpClient.GetAsync` diretamente pulam silenciosamente o pipeline de handlers. Qualquer coisa que você plugou no `IHttpClientFactory`, handlers de retry, handlers de log, handlers de autenticação, nunca executa no teste, então um teste verde pode mandar para produção uma cadeia de handlers quebrada.
2. Se você trocar de `GetAsync` para `Send`, o teste quebra mesmo que o comportamento seja idêntico.

A orientação oficial da Microsoft, qualquer resposta razoável do Stack Overflow desde 2018, e o próprio código-fonte do `HttpClient` apontam para o mesmo ponto de extensão: substituir o `HttpMessageHandler`. O handler tem exatamente um método para sobrescrever (`SendAsync`), é `protected internal virtual`, e é o contrato que o resto do pipeline já usa.

## Um stub handler mínimo

A implementação mais simples é uma classe que envolve um delegate. Não precisa de framework de mocking nenhum:

```csharp
// .NET 11, C# 14
public sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;
    public List<HttpRequestMessage> Requests { get; } = new();

    public StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    public StubHttpMessageHandler(HttpStatusCode status, string? body = null, string mediaType = "application/json")
        : this((_, _) => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = body is null ? null : new StringContent(body, Encoding.UTF8, mediaType),
        }))
    {
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return _handler(request, cancellationToken);
    }
}
```

Dois construtores cobrem a maior parte dos testes: um construtor com delegate para testes que precisam inspecionar a requisição, e um atalho de status/body para o caso trivial de "retorne 200 com este JSON". A lista `Requests` permite ao teste afirmar o que foi enviado.

## A classe sob teste

Para concretizar o resto, esta é a forma típica do código que as pessoas querem testar:

```csharp
// .NET 11, C# 14
public sealed record Repo(int Id, string Name, int Stars);

public sealed class GitHubClient
{
    private readonly HttpClient _http;

    public GitHubClient(HttpClient http) => _http = http;

    public async Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default)
    {
        var path = $"/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(name)}";
        using var response = await _http.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();

        var dto = await response.Content.ReadFromJsonAsync<RepoDto>(ct);
        return new Repo(dto!.Id, dto.Full_Name, dto.Stargazers_Count);
    }

    private sealed record RepoDto(int Id, string Full_Name, int Stargazers_Count);
}
```

O construtor recebe um `HttpClient`, não uma referência estática nem um recém-instanciado. Essa única decisão de design é o que torna possível tudo o que vem abaixo.

## Um teste que retorna uma resposta enlatada

```csharp
// .NET 11, C# 14, xUnit 2.9
[Fact]
public async Task GetRepoAsync_returns_parsed_repo_when_api_returns_200()
{
    var json = """
    { "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }
    """;

    var handler = new StubHttpMessageHandler(HttpStatusCode.OK, json);
    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    var repo = await sut.GetRepoAsync("octocat", "hello-world");

    Assert.Equal(42, repo.Id);
    Assert.Equal("octocat/hello-world", repo.Name);
    Assert.Equal(1300, repo.Stars);

    var sent = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, sent.Method);
    Assert.Equal("/repos/octocat/hello-world", sent.RequestUri!.AbsolutePath);
}
```

Três coisas para notar. O handler é construído com um status e um body, o `HttpClient` é construído com esse handler e um `BaseAddress`, e o teste verifica tanto o resultado parseado quanto a requisição de saída. A terceira asserção é a que a maioria dos testes pula e a que pega mais regressões, um caminho errado, um header esquecido, um body que está vazio quando não deveria estar.

## Retornar respostas diferentes por requisição

Para uma classe que faz várias chamadas (lista paginada, retry, GET condicional), passe um delegate:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_throws_on_404()
{
    var handler = new StubHttpMessageHandler((req, _) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            RequestMessage = req,
            Content = new StringContent("""{ "message": "Not Found" }""", Encoding.UTF8, "application/json"),
        }));

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    await Assert.ThrowsAsync<HttpRequestException>(() => sut.GetRepoAsync("octocat", "ghost"));
}
```

Para respostas sequenciais (a primeira chamada retorna 401, a segunda retorna 200 após um refresh de token), mantenha um contador dentro do delegate:

```csharp
// .NET 11, C# 14
var calls = 0;
var handler = new StubHttpMessageHandler((req, _) =>
{
    var status = calls++ == 0 ? HttpStatusCode.Unauthorized : HttpStatusCode.OK;
    return Task.FromResult(new HttpResponseMessage(status)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });
});
```

Isso é suficiente para quase todo cenário de teste unitário. Sem framework de mocking, sem truques de membros protegidos, sem cerimônia.

## A variante com Moq, e por que eu a evito

Se sua base de código já padroniza o Moq, o equivalente é:

```csharp
// .NET 11, C# 14, Moq 4.20
var handler = new Mock<HttpMessageHandler>(MockBehavior.Strict);
handler
    .Protected()
    .Setup<Task<HttpResponseMessage>>(
        "SendAsync",
        ItExpr.IsAny<HttpRequestMessage>(),
        ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });

var http = new HttpClient(handler.Object) { BaseAddress = new Uri("https://api.github.com") };
```

Funciona. As desvantagens:

- `"SendAsync"` é uma string. Se o framework algum dia renomear isso (não vai, mas o princípio vale), o compilador não vai pegar.
- `Protected()` requer `using Moq.Protected;` e força todo desenvolvedor que ler o teste a conhecer o truque.
- Retornar uma única instância de `HttpResponseMessage` de um setup singleton vaza estado entre chamadas se a resposta for enumerada mais de uma vez. O stub handler da seção anterior cria uma resposta nova por chamada.

Para testes pontuais o Moq está ok. Para uma classe de teste com cinco cenários HTTP, o stub feito à mão é mais curto, mais rápido de ler e mais fácil de depurar.

## Testando através de IHttpClientFactory

Em código de produção que usa `IHttpClientFactory` (e a maior parte do código moderno usa), a unidade sob teste recebe um `IHttpClientFactory` ou um cliente tipado, e a factory constrói um `HttpClient` com a cadeia de handlers que você registrou no `Program.cs`. O ponto de extensão do teste passa de "construir um `HttpClient` diretamente" para "configurar o handler primário da factory".

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http 11.0
[Fact]
public async Task TypedClient_uses_registered_handler_chain()
{
    var stub = new StubHttpMessageHandler(HttpStatusCode.OK,
        """{ "id": 7, "full_name": "a/b", "stargazers_count": 5 }""");

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .ConfigurePrimaryHttpMessageHandler(() => stub)
        .Services
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();

    var repo = await sut.GetRepoAsync("a", "b");
    Assert.Equal(7, repo.Id);
}
```

`ConfigurePrimaryHttpMessageHandler` troca a base da cadeia. Todo outro handler que você registrou (log, retry, auth) continua executando, que é exatamente o ponto. Se quiser substituir a cadeia inteira (você quase nunca quer), use `AddHttpMessageHandler` mais um stub handler no final, ou construa o `HttpClient` manualmente como nos exemplos anteriores.

## Verificar que um retry do Polly realmente reentregou

Este é o teste que o Moq torna doloroso e o stub handler torna trivial. Suponha que seu `Program.cs` registre:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 9.0
builder.Services.AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
    .AddStandardResilienceHandler();
```

O standard resilience handler refaz erros 5xx e timeouts três vezes por padrão. Para provar isso sob teste:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_retries_on_503()
{
    var calls = 0;
    var handler = new StubHttpMessageHandler((_, _) =>
    {
        calls++;
        var status = calls < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                        Encoding.UTF8, "application/json"),
        });
    });

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .AddStandardResilienceHandler()
        .Services
        .ConfigureAll<HttpClientFactoryOptions>(o => o.HttpMessageHandlerBuilderActions.Add(b =>
            b.PrimaryHandler = handler))
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();
    var repo = await sut.GetRepoAsync("x", "y");

    Assert.Equal(3, calls);
    Assert.Equal(1, repo.Id);
}
```

A asserção `Assert.Equal(3, calls)` é o que torna isso um teste de integração da cadeia de handlers. Um mock puro de `HttpClient.GetAsync` não teria invocado o Polly e a asserção seria `calls == 1`, que é a falha silenciosa que avisei antes.

## Cancelamento e timeout

Cancelamento é direto: o stub handler recebe o `CancellationToken` e você pode fazê-lo observar.

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_propagates_cancellation()
{
    var handler = new StubHttpMessageHandler(async (_, ct) =>
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    });

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://x") };
    var sut = new GitHubClient(http);

    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        sut.GetRepoAsync("a", "b", cts.Token));
}
```

`HttpClient.Timeout` em si aparece como um `TaskCanceledException` (com um `TimeoutException` interno desde o .NET 5). Se você quiser testar comportamento de timeout, defina `http.Timeout = TimeSpan.FromMilliseconds(50)` e faça o handler aguardar com `await Task.Delay` por mais tempo que isso. Veja [Como cancelar uma Task de longa duração em C# sem causar deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para os padrões de cancelamento cooperativo que o código de produção já deveria seguir.

## Afirmando sobre corpos de requisição

Para `POST` e `PUT`, capture e leia o conteúdo da requisição dentro do delegate do handler:

```csharp
// .NET 11, C# 14
string? captured = null;
var handler = new StubHttpMessageHandler(async (req, ct) =>
{
    captured = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
    return new HttpResponseMessage(HttpStatusCode.Created);
});
```

Leia o body dentro do handler, não depois. Assim que `SendAsync` retorna, o stream da requisição pode estar descartado.

## Headers, query strings e endereços base

`BaseAddress` mais um caminho relativo é a configuração mais limpa, mas cuidado com a barra final. `new Uri("https://api.example.com/v1")` mais uma requisição para `/users` descarta `/v1` porque a URI não tem barra final. `https://api.example.com/v1/` mais `users` (sem barra inicial) te dá `/v1/users`. Teste:

```csharp
// .NET 11, C# 14
Assert.Equal("/v1/users", handler.Requests[0].RequestUri!.AbsolutePath);
```

Headers padrão vão no `HttpClient`, não em cada requisição, e são visíveis para o handler:

```csharp
// .NET 11, C# 14
http.DefaultRequestHeaders.Add("User-Agent", "start-debugging/1.0");
// in the handler:
Assert.Contains("start-debugging/1.0", req.Headers.UserAgent.ToString());
```

## Quando recorrer ao WireMock.Net

A abordagem do stub handler é um teste unitário, sem socket, sem HTTP real. Para testes de componente ou de integração que exercitam a stack HTTP real (TLS, negociação de conteúdo, transferência chunked real, timeouts do servidor) recorra ao [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net):

```csharp
// .NET 11, C# 14, WireMock.Net 1.6
using var server = WireMockServer.Start();
server
    .Given(Request.Create().WithPath("/repos/octocat/hello-world").UsingGet())
    .RespondWith(Response.Create()
        .WithStatusCode(200)
        .WithHeader("Content-Type", "application/json")
        .WithBody("""{ "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }"""));

var http = new HttpClient { BaseAddress = new Uri(server.Url!) };
var sut = new GitHubClient(http);
var repo = await sut.GetRepoAsync("octocat", "hello-world");
```

WireMock.Net sobe um servidor HTTP real numa porta local. Mais lento que um stub handler, mais realista, mais frágil (conflitos de porta, TLS, startup assíncrono). Eu uso para testes que precisam verificar comportamentos que o framework só faz para sockets reais, fora isso o stub handler é mais rápido e silencioso. Para uma abordagem comparável de mockar outras dependências veja [Como escrever um JsonConverter customizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), do qual o passo de desserialização em `GetRepoAsync` já depende.

## Erros que aparecem em revisões de código

Uma lista curta de coisas que sinalizei em mais de um PR:

- Construir `HttpClient` dentro da classe sob teste (`private readonly HttpClient _http = new();`). O teste não consegue injetar um handler falso, então o teste chama uma rede real ou falha. Receba a dependência.
- Usar `MockBehavior.Loose` no mock de `HttpMessageHandler` e depois esquecer de verificar a requisição. O teste passa mesmo quando o código de produção nunca chama a API.
- Retornar a mesma instância de `HttpResponseMessage` em múltiplas chamadas de teste. O stream de conteúdo é lido apenas uma vez, então a segunda chamada vê um body vazio. Ou construa uma resposta nova por chamada (construtor com delegate), ou copie o body para um `StringContent` novo.
- Afirmar sobre `response.StatusCode` em vez de comportamento. O propósito do teste é o que `GetRepoAsync` faz com um 503, não que um literal `HttpResponseMessage` que você construiu tenha o status code com que você o construiu.
- Mockar através de `Mock<HttpClient>` diretamente. Como coberto acima, isso pula a cadeia de handlers e quebra silenciosamente os handlers de resiliência ou autenticação.

O handler é o ponto de extensão, o resto segue. Se seu teste precisar de Moq, NSubstitute, FakeItEasy ou WireMock, tudo bem, mas configure o ponto de extensão, não a superfície.

## Links de referência

- [HttpMessageHandler.SendAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.httpmessagehandler.sendasync)
- [Guia do IHttpClientFactory (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory)
- [ConfigurePrimaryHttpMessageHandler (MS Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.httpclientbuilderextensions.configureprimaryhttpmessagehandler)
- [Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net)
