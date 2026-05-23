---
title: "HttpClient vs HttpClientFactory vs Refit: qual usar no .NET 11?"
description: "Nunca crie um HttpClient por requisição. Use IHttpClientFactory para gerenciar o ciclo de vida e adicione Refit por cima quando quiser uma interface tipada em vez de escrever o código de requisição na mão. Um HttpClient singleton puro só serve para os casos mais simples."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "httpclient"
  - "httpclientfactory"
  - "refit"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/httpclient-vs-httpclientfactory-vs-refit"
translatedBy: "claude"
translationDate: 2026-05-23
---

A primeira coisa a entender é que esses três não são realmente concorrentes. São três camadas da mesma pilha. O `IHttpClientFactory` gerencia o ciclo de vida do `HttpClient`, e o Refit gera as chamadas de `HttpClient` para você, em cima da fábrica. Então a verdadeira pergunta é em que altura da pilha você deve se posicionar. Para código novo de .NET 11 em 2026: registre seus clientes através do **IHttpClientFactory** para que o ciclo de vida da conexão e o DNS sejam tratados corretamente, e recorra ao **Refit** quando quiser uma interface tipada em vez de escrever o código de construção de requisições na mão. Um `HttpClient` singleton puro e de vida longa só é aceitável para os casos de uma única chamada mais simples, e `new HttpClient()` por requisição é o único padrão que está sempre errado.

Todos os exemplos aqui têm como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 e C# 14. O Refit se refere à versão 10.1.6 (lançada em 2026-03-21, estável atual no NuGet), e as partes de resiliência usam `Microsoft.Extensions.Http.Resilience` 10.6.0. O `IHttpClientFactory` mora em `Microsoft.Extensions.Http`, que vem de fábrica com os SDKs do ASP.NET Core e Worker.

## A matriz de recursos num relance

Esta é a tabela que você veio buscar. As colunas são as três formas com que você de fato vai montar uma chamada HTTP, e as linhas são as decisões que mudam qual delas você escolhe.

| Aspecto | HttpClient puro (singleton) | IHttpClientFactory | Refit (+ HttpClientFactory) |
| ------- | -------------------------- | ------------------ | --------------------------- |
| Seguro contra esgotamento de sockets | Sim, se for realmente singleton | Sim | Sim |
| Respeita mudanças de DNS | Só com `PooledConnectionLifetime` | Sim, o handler rotaciona (2 min por padrão) | Sim, herda da fábrica |
| Pipeline de handlers via DI | Manual | Nativo (`AddHttpMessageHandler`) | Nativo, herda da fábrica |
| Resiliência embutida | Feita na mão | `AddStandardResilienceHandler` | `AddStandardResilienceHandler` |
| Clientes nomeados / tipados | Não | Sim | Sim, a interface é o cliente |
| Código de construção de requisições que você escreve | Tudo | Tudo | Nada, gerado em tempo de compilação |
| Respostas fortemente tipadas | Desserialização manual | Desserialização manual | Automática |
| Native AOT / trimming | Sim | Sim | Sim, desde 9.0.2 no .NET 10+ |
| Dependência NuGet extra | Nenhuma (de fábrica) | Nenhuma para ASP.NET Core | `Refit`, `Refit.HttpClientFactory` |
| Melhor para | Uma ou duas chamadas simples | A maior parte do código de servidor | Muitos endpoints contra uma mesma API |

O padrão da tabela é que cada coluna herda as garantias de segurança da que está à sua esquerda e adiciona ergonomia por cima. O custo de andar para a direita é uma dependência e um pouco de indireção, não a corretude.

## Quando o HttpClient puro está de fato OK

Existe um mito persistente de que você nunca deve usar `HttpClient` diretamente. Isso é uma supercorreção. Um único `HttpClient` de vida longa compartilhado por toda a aplicação é um padrão perfeitamente válido e bem suportado. O perigo nunca foi o `HttpClient` em si, mas criar um novo por requisição dentro de um bloco `using`, o que vaza sockets em `TIME_WAIT` e, com o tempo, esgota a faixa de portas sob carga.

Um singleton estático evita o esgotamento de sockets, mas introduz um segundo problema mais sutil: o `HttpClient` resolve o DNS apenas quando abre uma conexão, e um pool de conexões de vida longa nunca resolve de novo. Se o host de destino fizer failover para um novo IP, seu singleton continua martelando o antigo. A correção, no .NET Core e no .NET 5+, é limitar o ciclo de vida da conexão no handler:

```csharp
// .NET 11, C# 14 - a singleton that still picks up DNS changes
using System.Net;

var handler = new SocketsHttpHandler
{
    // Recycle pooled connections so DNS failover is respected
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    AutomaticDecompression = DecompressionMethods.All
};

// Construct once, reuse for the entire process lifetime
var http = new HttpClient(handler)
{
    BaseAddress = new Uri("https://api.example.com")
};
```

Use isso quando você tiver uma ferramenta de console, um worker pequeno ou uma biblioteca sem container de DI e fizer chamadas a um ou dois endpoints. No momento em que você tiver um container de DI e mais de um par de clientes, estará reimplementando o `IHttpClientFactory` na mão, e deveria parar e usar a versão de verdade.

## Quando o IHttpClientFactory é o padrão correto

Para quase todo código de servidor em 2026, o `IHttpClientFactory` é a base. Ele encapsula o gerenciamento de ciclo de vida descrito acima para que você não precise pensar em `PooledConnectionLifetime` nem na rotação de DNS: a fábrica agrupa instâncias de `HttpMessageHandler` e as rotaciona em um intervalo configurável (dois minutos por padrão), o que te dá reutilização de sockets e frescor de DNS ao mesmo tempo.

A maior vantagem é o pipeline de handlers de mensagens. Você pode registrar preocupações transversais (cabeçalhos de autenticação, log, IDs de correlação, retentativas) como instâncias de `DelegatingHandler` na DI, e todo cliente construído pela fábrica os compõe em ordem. Um cliente tipado vincula um `HttpClient` configurado a uma classe de serviço específica:

```csharp
// .NET 11, C# 14 - typed client registered through the factory
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // Polly-backed retries, timeout, circuit breaker

public sealed class GitHubService(HttpClient client)
{
    public async Task<Repo?> GetRepoAsync(string owner, string name, CancellationToken ct)
    {
        // You still hand-write the path, the verb, and the deserialize
        return await client.GetFromJsonAsync<Repo>($"/repos/{owner}/{name}", ct);
    }
}

public record Repo(long Id, string FullName, int StargazersCount);
```

O `AddStandardResilienceHandler` (de `Microsoft.Extensions.Http.Resilience` 10.6.0) empilha um limitador de taxa, um timeout total da requisição, retentativa, um circuit breaker e um timeout por tentativa com padrões sensatos. Esse é o substituto moderno para fiar políticas do Polly na mão, e é uma única linha. Se você ainda estiver vendo timeouts depois de adicioná-lo, a causa costuma ser um timeout por tentativa mal configurado, e não o handler em si, o que é uma fonte comum de um [TaskCanceledException, uma tarefa foi cancelada](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

A única coisa que a fábrica não faz é escrever o seu código de requisição. Você ainda redige o caminho, o verbo HTTP, a query string e a desserialização para cada chamada. Para um ou dois endpoints isso tudo bem. Para uma API REST com trinta endpoints, isso são trinta métodos de código repetitivo quase idêntico, e essa é exatamente a lacuna que o Refit preenche.

## Quando o Refit justifica sua dependência

O Refit transforma uma interface C# em um cliente REST funcional. Você declara o formato da API com atributos, e o gerador de código-fonte do Refit emite a implementação em tempo de compilação. Não há construção de requisições por chamada nem desserialização manual:

```csharp
// .NET 11, C# 14, Refit 10.1.6 - the interface IS the client
using Refit;

public interface IGitHubApi
{
    [Get("/repos/{owner}/{name}")]
    Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default);

    [Get("/users/{user}/repos")]
    Task<IReadOnlyList<Repo>> GetUserReposAsync(string user, [Query] string sort = "updated");

    [Post("/repos/{owner}/{name}/issues")]
    Task<Issue> CreateIssueAsync(string owner, string name, [Body] NewIssue issue);
}

public record Repo(long Id, string FullName, int StargazersCount);
public record Issue(long Number, string Title);
public record NewIssue(string Title, string Body);
```

Registre-o contra a mesma infraestrutura da fábrica com `Refit.HttpClientFactory`, para manter todas as garantias de ciclo de vida, DNS e resiliência da camada de baixo:

```csharp
// .NET 11, C# 14, Refit.HttpClientFactory 10.1.6
using Refit;
using Microsoft.Extensions.DependencyInjection;

builder.Services
    .AddRefitClient<IGitHubApi>()
    .ConfigureHttpClient(c =>
    {
        c.BaseAddress = new Uri("https://api.github.com");
        c.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
    })
    .AddStandardResilienceHandler(); // same resilience stack as a typed client
```

Esse é o cliente inteiro. Três métodos de interface substituem o que seriam três métodos escritos na mão mais a lógica de construção de requisição e parsing deles. Para uma base de código que conversa com uma API de terceiros grande, a redução de código que você precisa ler e manter é o argumento inteiro. O Refit também lida bem com as partes chatas: `[Query]` para query strings, `[Body]` com serialização, `[Header]` e `[Authorize]` para autenticação, uploads multipart, e `ApiResponse<T>` quando você precisa do código de status e dos cabeçalhos em vez de apenas o corpo desserializado.

Duas notas práticas para 2026. Primeiro, o Refit 9.0.2 (novembro de 2025) adicionou suporte a Native AOT e trimming para .NET 10 e posteriores, então o Refit não está mais desqualificado de containers com trimming e funções scale-to-zero como acontece com clientes pesados em reflexão. Para o caminho AOT, forneça metadados de `System.Text.Json` gerados por código-fonte via um `JsonSerializerContext` para que o serializador permaneça livre de reflexão, a mesma disciplina abordada em [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/). Segundo, se sua API for descrita por um documento OpenAPI, você nem escreve a interface na mão: ferramentas podem emitir interfaces do Refit a partir da especificação, o que se sobrepõe a [gerar um cliente fortemente tipado a partir de uma especificação OpenAPI](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Qual é de fato a sobrecarga

A resposta honesta sobre desempenho é que, para chamadas HTTP, a rede domina e a escolha entre esses três fica no ruído. Uma ida e volta a uma API real é medida em milissegundos a centenas de milissegundos; a sobrecarga de construção da requisição é medida em microssegundos. Escolher o Refit em vez de um cliente tipado para economizar CPU é otimizar a camada errada.

Dito isso, a sobrecarga não é zero e vale a pena saber onde ela mora:

| Aspecto | Cliente puro / tipado | Refit |
| ------ | ------------------ | ----- |
| Construção de requisição por chamada | Direta, escrita na mão | Gerada, quase direta no .NET 8+ |
| Reflexão em tempo de execução | Nenhuma | Nenhuma com o gerador de código-fonte |
| Custo de inicialização | Nenhum | Registro único de stubs gerados |
| Alocação por chamada | Linha de base | Comparável, o parsing de atributos é em tempo de compilação |

O ponto metodológico-chave: o Refit migrou para um gerador de código-fonte do Roslyn (o `InterfaceStubGenerator`), então a análise da interface acontece em tempo de compilação, não a cada chamada. O antigo custo de reflexão e `Reflection.Emit` que o AOT não tolerava se foi. Se você quiser um número real para os seus próprios formatos de objeto, rode o BenchmarkDotNet contra seus DTOs em vez de confiar num valor genérico, mas espere que o delta entre um cliente tipado e um cliente Refit seja de dezenas de nanossegundos frente a uma chamada de rede que leva milissegundos. A decisão é sobre o código que você mantém, não sobre os ciclos que você gasta.

## O detalhe que decide por você

Algumas restrições resolvem a escolha antes de a preferência entrar em cena.

**`new HttpClient()` por requisição nunca é a resposta.** Esse é o único padrão genuinamente errado, e está errado para as três colunas. Ele esgota os sockets sob carga mesmo que o `HttpClient` seja `IDisposable` e pareça pedir um `using`. Se você levar uma única coisa, leve esta: construa o `HttpClient` uma vez, ou deixe a fábrica construí-lo para você, mas nunca por chamada.

**Singletons que capturam um cliente tipado anulam a fábrica.** Registrar um cliente tipado ou um cliente Refit e então capturá-lo dentro de um singleton fixa um handler para sempre, o que significa que ele para de rotacionar e para de ver as mudanças de DNS, exatamente o problema que a fábrica existe para resolver. Injete o cliente onde você o usa, ou injete o `IHttpClientFactory` e crie sob demanda. Não o guarde em um campo estático.

**O Refit precisa que a resposta combine com o contrato.** Como a desserialização é automática, uma resposta que não combina com o seu record (um envelope embrulhado, um casing diferente, um corpo de erro retornado com um 200) aparece como uma falha de desserialização em vez de algo que você trata em linha. Use `ApiResponse<T>` quando precisar inspecionar o status e os cabeçalhos, e configure o serializador do mesmo jeito que faria em outro lugar. Testar esses clientes também é levemente diferente porque não há corpo de método para mockar; você mocka o `HttpMessageHandler`, a mesma abordagem de [testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/).

**Licenciamento não é um fator aqui.** Diferente de alguns dos debates sobre mappers e mediators em 2026, as três opções são gratuitas e têm licenças permissivas. O `HttpClient` e o `IHttpClientFactory` vêm com o .NET, e o Refit é MIT. Não há barreira comercial te empurrando em direção ou para longe de nenhuma delas.

## A decisão, em uma linha

Para código novo de .NET 11 em 2026: faça do `IHttpClientFactory` o seu padrão para que ciclo de vida, DNS e resiliência sejam tratados para você, e adicione o Refit por cima quando estiver chamando muitos endpoints contra uma mesma API e quiser o código de requisição gerado em vez de escrito na mão. Reserve o `HttpClient` puro para o caso genuinamente simples (um singleton com `PooledConnectionLifetime`, uma ou duas chamadas, sem DI), e nunca crie um por requisição. Essas não são três bibliotecas rivais entre as quais você escolhe; são três degraus de uma mesma escada, e você sobe até o degrau que combina com quanto do encanamento HTTP você quer parar de escrever por conta própria.

## Relacionados

- [Como gerar um cliente fortemente tipado a partir de uma especificação OpenAPI no .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Como testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException, uma tarefa foi cancelada no HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Fontes

- [Use IHttpClientFactory to implement resilient HTTP requests](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) - clientes nomeados e tipados, ciclo de vida do handler, e o pipeline de handlers de mensagens.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) - esgotamento de sockets, DNS, e o padrão `PooledConnectionLifetime` para singletons.
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler` e a pilha de resiliência padrão.
- [Refit on GitHub](https://github.com/reactiveui/refit) - o gerador de código-fonte, a referência de atributos, e a integração com `Refit.HttpClientFactory`.
- [Refit.HttpClientFactory 10.1.6 on NuGet](https://www.nuget.org/packages/refit.httpclientfactory) - versão estável atual e frameworks de destino.
