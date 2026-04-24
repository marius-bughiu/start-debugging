---
title: "Como Gerar Código de Cliente Fortemente Tipado a partir de uma Especificação OpenAPI no .NET 11"
description: "Use o Kiota, o gerador oficial de OpenAPI da Microsoft, para produzir um cliente C# fluent e fortemente tipado a partir de qualquer especificação OpenAPI. Passo a passo: instalar, gerar, conectar à injeção de dependência do ASP.NET Core e gerenciar autenticação."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "aspnet"
  - "openapi"
lang: "pt-br"
translationOf: "2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

No momento em que uma API publica um documento OpenAPI, manter um wrapper de `HttpClient` escrito manualmente é uma aposta perdida. Cada novo campo, rota renomeada ou código de status adicional implica uma atualização manual, e a especificação e o cliente se desatualizam silenciosamente. A solução correta é inverter o relacionamento: tratar a especificação como a fonte da verdade e gerar os tipos de C# a partir dela.

No .NET 11, a ferramenta canônica para isso é o [Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview), o gerador de clientes OpenAPI da Microsoft. Instale-o como uma ferramenta .NET, aponte-o para uma especificação e ele escreverá um cliente C# fluent e orientado a recursos com classes reais e fortemente tipadas para requisições e respostas. Um único metapacote gerencia HTTP, JSON e middleware de autenticação. A configuração completa leva menos de dez minutos com uma especificação limpa.

## Por que wrappers HttpClient escritos manualmente param de funcionar

Um wrapper típico escrito manualmente tem esta aparência: você escreve um POCO para a resposta, adiciona um método em uma classe de serviço, hardcodeia o segmento de URL. Repete para cada endpoint. Depois repete novamente quando o proprietário da API adiciona um novo campo de resposta, altera o nome de um parâmetro de rota ou ajusta um contrato nullable. Nenhuma dessas alterações produz um erro do compilador. Elas surgem como surpresas em tempo de execução -- exceções de referência nula em produção, nomes de propriedades JSON que não correspondem e que silenciosamente zeram um valor.

Um cliente gerado inverte isso. A especificação é compilada diretamente em tipos de C#. Se a especificação diz que um campo é `nullable: false`, a propriedade é `string`, não `string?`. Se a especificação adiciona uma nova rota, a próxima execução de `kiota generate` adiciona o método. Um diff nos arquivos gerados mostra exatamente o que mudou no contrato da API.

## Kiota vs NSwag: qual gerador escolher

Dois geradores dominam o espaço .NET: NSwag (maduro, produz um único arquivo de classe monolítico) e Kiota (mais recente, orientado a recursos, produz muitos arquivos pequenos e focados).

O Kiota constrói uma hierarquia de rotas que espelha a estrutura de URL. Uma chamada para `GET /repos/{owner}/{repo}/releases` se torna `client.Repos["owner"]["repo"].Releases.GetAsync()`. Cada segmento de rota é uma classe C# separada. Isso produz mais arquivos, mas torna o código gerado navegável e mockável em qualquer nível de rota.

O NSwag gera uma classe com um método por operação: `GetReposOwnerRepoReleasesAsync(owner, repo)`. Isso é simples para APIs pequenas, mas se torna inviável quando a especificação tem centenas de rotas. A especificação completa do GitHub gera um arquivo com quase 400.000 linhas com o NSwag.

O Kiota é o que a Microsoft usa para o SDK do Microsoft Graph e o SDK do Azure para .NET. Foi declarado com disponibilidade geral em 2024 e é o gerador para o qual os tutoriais de início rápido da documentação oficial apontam. Ambas as ferramentas são mostradas abaixo; a seção do NSwag cobre a alternativa mínima para equipes já investidas nessa cadeia de ferramentas.

## Passo 1: Instalar o Kiota

**Instalação global** (mais simples para uma máquina de desenvolvedor):

```bash
dotnet tool install --global Microsoft.OpenApi.Kiota
```

**Instalação local** (recomendada para projetos em equipe -- reproduzível em máquinas de CI):

```bash
dotnet new tool-manifest   # creates .config/dotnet-tools.json
dotnet tool install Microsoft.OpenApi.Kiota
```

Após uma instalação local, `dotnet tool restore` em qualquer máquina de desenvolvedor ou trabalho de CI instala a versão exata fixada. Sem deriva de versão na equipe.

Verifique a instalação:

```bash
kiota --version
# 1.x.x
```

## Passo 2: Gerar o cliente

```bash
# .NET 11 / Kiota 1.x
kiota generate \
  -l CSharp \
  -c WeatherClient \
  -n MyApp.ApiClient \
  -d ./openapi.yaml \
  -o ./src/ApiClient
```

Os parâmetros principais:

| Parâmetro | Finalidade |
|-----------|------------|
| `-l CSharp` | Linguagem alvo. O Kiota também suporta Go, Java, TypeScript, Python, PHP, Ruby. |
| `-c WeatherClient` | Nome da classe cliente raiz. |
| `-n MyApp.ApiClient` | Namespace raiz de C# para todos os arquivos gerados. |
| `-d ./openapi.yaml` | Caminho ou URL HTTPS para o documento OpenAPI. O Kiota aceita YAML e JSON. |
| `-o ./src/ApiClient` | Diretório de saída. O Kiota o sobrescreve a cada execução -- não edite os arquivos gerados manualmente. |

Para especificações públicas grandes (GitHub, Stripe, Azure), adicione `--include-path` para limitar o cliente às rotas que você realmente usa:

```bash
# Only generate the /releases subtree from GitHub's spec
kiota generate \
  -l CSharp \
  -c GitHubClient \
  -n MyApp.GitHub \
  -d https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o ./src/GitHub \
  --include-path "/repos/{owner}/{repo}/releases/*"
```

Sem `--include-path`, a especificação completa do GitHub gera aproximadamente 600 arquivos. Com ele, você obtém a dúzia de arquivos para a subárvore de releases. Você sempre pode ampliar o filtro posteriormente.

Faça commit dos arquivos gerados no controle de código-fonte. A URL da especificação ou o caminho local é suficiente para regenerá-los, e os revisores podem ver os tipos exatos em uso durante a revisão de código.

## Passo 3: Adicionar o pacote NuGet

```bash
dotnet add package Microsoft.Kiota.Bundle
```

`Microsoft.Kiota.Bundle` é um metapacote que inclui:

- `Microsoft.Kiota.Abstractions` -- contratos do adaptador de requisições e interfaces de serialização
- `Microsoft.Kiota.Http.HttpClientLibrary` -- `HttpClientRequestAdapter`, o backend HTTP padrão
- `Microsoft.Kiota.Serialization.Json` -- serialização com System.Text.Json
- `Microsoft.Kiota.Authentication.Azure` -- opcional, para provedores de autenticação do Azure Identity

O bundle tem como alvo `netstandard2.0`, portanto é compatível com .NET 8, .NET 9, .NET 10 e .NET 11 (atualmente em versão prévia) sem nenhum ajuste adicional em `<TargetFramework>`.

## Passo 4: Usar o cliente em um aplicativo de console

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

var adapter = new HttpClientRequestAdapter(new AnonymousAuthenticationProvider());
var client = new WeatherClient(adapter);

// GET /forecasts
var all = await client.Forecasts.GetAsync();
Console.WriteLine($"Received {all?.Count} forecasts.");

// GET /forecasts/{location}
var specific = await client.Forecasts["lon=51.5,lat=-0.1"].GetAsync();
Console.WriteLine($"Temperature: {specific?.Temperature}");

// POST /forecasts
var created = await client.Forecasts.PostAsync(new()
{
    Location = "lon=51.5,lat=-0.1",
    TemperatureC = 21,
});
Console.WriteLine($"Created forecast ID: {created?.Id}");
```

`AnonymousAuthenticationProvider` não adiciona cabeçalhos de autenticação -- correto para APIs públicas. Consulte a seção de autenticação abaixo para tokens Bearer.

Cada método assíncrono gerado aceita um `CancellationToken` opcional. Passe um do seu próprio contexto:

```csharp
// .NET 11, Kiota 1.x
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var forecasts = await client.Forecasts.GetAsync(cancellationToken: cts.Token);
```

O token flui pelo adaptador HTTP e cancela a chamada subjacente de `HttpClient`. Nenhuma configuração adicional é necessária.

## Passo 5: Conectar o cliente à injeção de dependência do ASP.NET Core

Criar o adaptador de requisições em cada handler desperdiça sockets (ignorando o pool de conexões do `IHttpClientFactory`) e torna o cliente impossível de testar. O padrão correto é uma classe de fábrica que aceita um `HttpClient` gerenciado via injeção de dependência no construtor.

Crie a fábrica:

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

public class WeatherClientFactory(HttpClient httpClient)
{
    public WeatherClient GetClient() =>
        new(new HttpClientRequestAdapter(
            new AnonymousAuthenticationProvider(),
            httpClient: httpClient));
}
```

Registre tudo em `Program.cs`:

```csharp
// .NET 11
using Microsoft.Kiota.Http.HttpClientLibrary;

// Registra os handlers HTTP integrados do Kiota no contêiner de DI
builder.Services.AddKiotaHandlers();

// Registra o HttpClient nomeado e anexa esses handlers
builder.Services.AddHttpClient<WeatherClientFactory>(client =>
{
    client.BaseAddress = new Uri("https://api.weather.example.com");
})
.AttachKiotaHandlers();

// Expõe o cliente gerado diretamente para injeção
builder.Services.AddTransient(sp =>
    sp.GetRequiredService<WeatherClientFactory>().GetClient());
```

`AddKiotaHandlers` e `AttachKiotaHandlers` são métodos de extensão de `Microsoft.Kiota.Http.HttpClientLibrary`. Eles registram os handlers delegantes padrão do Kiota -- retry, redirecionamento, inspeção de cabeçalhos -- e os conectam ao ciclo de vida do `IHttpClientFactory` para que sejam descartados corretamente.

Injete `WeatherClient` diretamente nos seus endpoints de Minimal API:

```csharp
// .NET 11
app.MapGet("/weather", async (WeatherClient client, CancellationToken ct) =>
{
    var forecasts = await client.Forecasts.GetAsync(cancellationToken: ct);
    return forecasts;
});
```

O parâmetro `CancellationToken` em um handler de Minimal API é automaticamente vinculado ao token de cancelamento da requisição HTTP. Se o cliente desconectar, a chamada Kiota em andamento é cancelada de forma limpa sem nenhum código adicional.

## Passo 6: Autenticação

Para APIs que requerem um token Bearer, implemente `IAccessTokenProvider` e passe-o para `BaseBearerTokenAuthenticationProvider`:

```csharp
// .NET 11, Kiota 1.x
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;

public class StaticTokenProvider(string token) : IAccessTokenProvider
{
    public Task<string> GetAuthorizationTokenAsync(
        Uri uri,
        Dictionary<string, object>? additionalContext = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(token);

    public AllowedHostsValidator AllowedHostsValidator { get; } = new();
}
```

Conecte na fábrica:

```csharp
// .NET 11, Kiota 1.x
var authProvider = new BaseBearerTokenAuthenticationProvider(
    new StaticTokenProvider(apiKey));

return new WeatherClient(new HttpClientRequestAdapter(authProvider, httpClient: httpClient));
```

Em produção, substitua `StaticTokenProvider` por uma implementação que leia o token do contexto HTTP atual, de um valor `IOptions<>`, ou de `DefaultAzureCredential` do Azure Identity (o pacote `Microsoft.Kiota.Authentication.Azure` expõe `AzureIdentityAuthenticationProvider` exatamente para esse caso).

## Usando NSwag se você preferir uma estrutura de arquivos mais simples

Se seu projeto já usa NSwag ou foi gerado com `dotnet-openapi`, você não precisa migrar. Instale a CLI do NSwag e regenere com:

```bash
dotnet tool install --global NSwag.ConsoleCore

nswag openapi2csclient \
  /input:openapi.yaml \
  /classname:WeatherClient \
  /namespace:MyApp.ApiClient \
  /output:WeatherClient.cs
```

O NSwag produz um único arquivo C# contendo a classe cliente e uma interface `IWeatherClient` correspondente. Essa interface torna os testes unitários simples -- você pode mockar `IWeatherClient` diretamente sem nenhuma indireção por nível de rota. Para especificações pequenas e estáveis onde o arquivo gerado completo cabe em uma tela, o NSwag é uma escolha prática. Para especificações grandes ou que mudam com frequência, a estrutura de arquivos por rota do Kiota torna os diffs de API mais fáceis de revisar.

## Problemas a considerar antes de fazer commit dos arquivos gerados

**A qualidade da especificação determina a precisão dos tipos.** O Kiota valida o documento OpenAPI no momento da geração. Uma anotação `nullable: true` faltando se torna `string` onde você esperava `string?`. Um `type: integer` incorreto se torna `int` onde a API realmente envia floats. Se você é o proprietário do servidor, execute o [Spectral](https://stoplight.io/open-source/spectral) contra a especificação antes de gerar. Entrada de dados incorretos, tipos enganosos como resultado.

**`--include-path` não é opcional para APIs públicas grandes.** Sem ele, a especificação do GitHub gera centenas de arquivos, a do Stripe ainda mais. Limite o cliente no momento da geração às rotas que você usa. Você sempre pode regenerar com um filtro mais amplo posteriormente; um cliente com 600 arquivos que cresce ao longo do tempo é mais difícil de reduzir.

**Colisões de nomes de modelos são resolvidas automaticamente com namespaces.** Se `GET /posts/{id}` e `GET /users/{id}` ambos referenciam um esquema chamado `Item`, o Kiota gera `Posts.Item.Item` e `Users.Item.Item`. Verifique seus `using` se os nomes parecerem colidir.

**`CancellationToken` em endpoints de Minimal API é gratuito.** Declare-o como parâmetro e o ASP.NET Core o vincula ao token de cancelamento da requisição sem nenhum atributo. Passe-o para cada chamada do Kiota e seu cliente HTTP é cancelado automaticamente quando o navegador fecha a conexão ou um timeout de gateway é acionado. A mecânica do cancelamento cooperativo de tarefas em C# é abordada em profundidade em [como cancelar uma Task de longa duração em C# sem deadlock](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**Regenere no CI, não apenas localmente.** Adicione `dotnet tool restore && kiota generate [...]` como uma etapa do pipeline. Se a especificação mudar e o código gerado no repositório estiver desatualizado, o build detectará a diferença antes que chegue à produção.

## Artigos relacionados

- Se você expõe o servidor da API e quer que a autenticação Bearer apareça corretamente na interface de documentação Scalar, a configuração não é óbvia: [Scalar no ASP.NET Core: por que seu token Bearer é ignorado](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- Se suas chamadas de serviço para serviço usam gRPC em vez de REST, as armadilhas de rede em contêineres são diferentes das de HTTP: [gRPC em contêineres no .NET 9 e .NET 10](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- Adicionar rastreamento distribuído à camada do cliente HTTP combina bem com [rastreamento nativo do OpenTelemetry no ASP.NET Core 11](/2026/04/aspnetcore-11-native-opentelemetry-tracing/)

## Fontes

- [Visão geral do Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview) -- Microsoft Learn
- [Compilar clientes de API para .NET](https://learn.microsoft.com/en-us/openapi/kiota/quickstarts/dotnet) -- Microsoft Learn
- [Registrar um cliente Kiota com injeção de dependência no .NET](https://learn.microsoft.com/en-us/openapi/kiota/tutorials/dotnet-dependency-injection) -- Microsoft Learn
- [NSwag: a cadeia de ferramentas Swagger/OpenAPI para .NET](https://github.com/RicoSuter/NSwag) -- GitHub
