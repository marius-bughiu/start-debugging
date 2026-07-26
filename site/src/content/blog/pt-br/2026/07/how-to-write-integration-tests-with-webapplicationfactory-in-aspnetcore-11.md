---
title: "Como escrever testes de integração com WebApplicationFactory<T> no ASP.NET Core 11"
description: "Guia completo do WebApplicationFactory<TEntryPoint> no ASP.NET Core 11: como tornar o ponto de entrada Program acessível, ConfigureTestServices versus ConfigureWebHost, substituir o registro do EF Core via IDbContextOptionsConfiguration, o novo hook ConfigureHostApplicationBuilder do .NET 11 preview 6, autenticação simulada, WebApplicationFactoryClientOptions e UseKestrel quando você precisa de uma porta real."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "xunit"
lang: "pt-br"
translationOf: "2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Para escrever um teste de integração com `WebApplicationFactory<TEntryPoint>` no ASP.NET Core 11, referencie `Microsoft.AspNetCore.Mvc.Testing` no projeto de testes, torne o ponto de entrada da aplicação acessível adicionando `public partial class Program { }` ao final do `Program.cs` e então injete `WebApplicationFactory<Program>` em uma classe de teste do xUnit por meio de `IClassFixture<T>` e chame `CreateClient()`. Esse `HttpClient` conversa com o seu pipeline de middleware real e com o seu contêiner de injeção de dependência real por um transporte em memória, sem socket, sem porta e sem `dotnet run`. Todo o resto (trocar um serviço por um dublê, apontar o EF Core para outro banco de dados, simular um usuário autenticado) acontece dentro de `ConfigureWebHost` ou `WithWebHostBuilder`. Este artigo tem como alvo o .NET 11 (preview 6 no momento em que escrevo, GA em novembro de 2026) com C# 14, e destaca as duas APIs novas desde o .NET 9: `UseKestrel`, do .NET 10, e `ConfigureHostApplicationBuilder`, do .NET 11 preview 6. Todo o resto funciona sem alterações no .NET 8, 9 e 10.

## O que a factory realmente inicializa

`WebApplicationFactory<TEntryPoint>` não inicia a sua aplicação do mesmo jeito que `dotnet run`. Ela usa o `HostFactoryResolver` para invocar o seu ponto de entrada, intercepta o `IHost` logo antes de ele ser executado, troca a implementação do servidor por `TestServer` e devolve o host já construído. Vale internalizar a consequência disso, porque ela explica quase todo comportamento surpreendente:

- O seu `Program.cs` é executado. Cada chamada `builder.Services.Add*`, cada registro de middleware e cada `MapGet` executam exatamente como em produção.
- Nenhum socket de rede é aberto. `TestServer` implementa `IServer` sobre um `HttpMessageHandler` em memória, então as requisições pulam completamente a camada de transporte. O Kestrel não participa, o que também significa que redirecionamento HTTPS, negociação de HTTP/2 e limites de conexão não são exercitados.
- O contêiner de injeção de dependência é o de produção, mais o que você acrescentar em `ConfigureTestServices`. Singletons vivem por toda a vida da factory, então o estado vaza entre testes do mesmo fixture a menos que você o reinicialize.

Esse último ponto é a real proposta de valor. Um teste de unidade diz que um handler devolve o objeto certo. Um teste de integração diz que o template de rota casa, que o model binding faz o parsing do corpo, que a política de autorização admite o chamador, que o pipeline de filtros roda na ordem certa e que o JSON que trafega tem os nomes de propriedade que o seu cliente espera. Nada disso é exercitado chamando o handler diretamente.

## Passos para adicionar um teste com WebApplicationFactory

1. Adicione um projeto de testes e referencie `Microsoft.AspNetCore.Mvc.Testing` mais uma referência de projeto para a aplicação sob teste.
2. Exponha o ponto de entrada acrescentando `public partial class Program { }` ao `Program.cs` da aplicação.
3. Injete `WebApplicationFactory<Program>` na classe de teste via `IClassFixture<T>` e chame `CreateClient()`.
4. Derive uma factory própria e sobrescreva `ConfigureWebHost` quando precisar substituir serviços ou configuração.
5. Use `WithWebHostBuilder` para substituições por teste que não devem vazar para o restante da classe.
6. Reinicialize o estado compartilhado entre testes, já que o host e seus singletons são compartilhados por todo o fixture.

## Os pacotes

```xml
<!-- .NET 11 preview 6, test project -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="11.0.0-preview.6.*" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.0" />
  <PackageReference Include="xunit.v3" Version="3.1.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="..\..\src\Orders.Api\Orders.Api.csproj" />
</ItemGroup>
```

No .NET 10 use a versão estável `10.0.0` do `Microsoft.AspNetCore.Mvc.Testing`. Se você ainda não migrou do xUnit v2, `xunit` 2.9.x funciona de forma idêntica para tudo o que vem a seguir, exceto pela assinatura de `IAsyncLifetime`, coberta na seção de ciclo de vida.

`Microsoft.AspNetCore.Mvc.Testing` não é específico do MVC, apesar do nome. Ele funciona para minimal APIs, controllers, Razor Pages e Blazor Server. Ele também traz um target de MSBuild que carimba um `WebApplicationFactoryContentRootAttribute` no assembly de testes para que a factory encontre o content root da aplicação, o que importa para arquivos estáticos e views do Razor.

## Tornando o ponto de entrada alcançável

É aqui que a maioria das primeiras tentativas para. Top-level statements compilam para uma classe chamada `Program` cuja acessibilidade é `internal`, então referenciá-la a partir de um assembly de testes falha em tempo de compilação:

```
error CS0122: 'Program' is inaccessible due to its protection level
```

A correção é uma linha no fim do `Program.cs`, depois de `app.Run()`:

```csharp
// .NET 11, C# 14 -- Program.cs, last line
app.Run();

public partial class Program { }
```

O compilador mescla a sua declaração parcial com a gerada e a classe passa a ser pública. A alternativa é `[assembly: InternalsVisibleTo("Orders.Api.Tests")]` no projeto da aplicação, que mantém `Program` como internal mas também abre todos os outros tipos internos para o assembly de testes. Prefira a classe parcial, a não ser que exista uma razão de política para não usá-la.

Uma falha relacionada aparece assim em tempo de execução:

```
System.InvalidOperationException: The entry point exited without ever building an IHost.
```

Isso significa que o resolver executou o seu `Program.cs` até o fim sem nunca ver um host ser construído. As causas usuais são um `return` antecipado em algum caminho de argumentos, um `Main` que chama `Environment.Exit`, ou uma exceção lançada durante a inicialização que acaba engolida. Note que o código de inicialização da aplicação realmente executa durante o teste, então um `Program.cs` que lê uma string de conexão e lança quando ela falta também vai lançar aqui. A configuração da qual você depende na inicialização precisa estar disponível para o processo de teste.

## O primeiro teste

Com o ponto de entrada exposto, a factory padrão não precisa de subclasse alguma:

```csharp
// .NET 11, xUnit v3
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

public sealed class OrdersEndpointTests
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrdersEndpointTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Unknown_order_returns_404()
    {
        var response = await _client.GetAsync("/orders/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/orders")]
    public async Task Endpoint_returns_json(string url)
    {
        var response = await _client.GetAsync(url);

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json; charset=utf-8",
            response.Content.Headers.ContentType?.ToString());
    }
}
```

`IClassFixture<T>` constrói a factory uma vez por classe de teste e a descarta depois do último teste daquela classe. `CreateClient` pode ser chamado repetidamente; cada chamada devolve um `HttpClient` novo ligado ao mesmo host, com seu próprio contêiner de cookies.

## Substituindo serviços com ConfigureTestServices

No momento em que você precisa de um gateway de pagamento falso ou de um banco de dados diferente, cria uma subclasse da factory e sobrescreve `ConfigureWebHost`. Use `ConfigureTestServices`, não `ConfigureServices`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

public sealed class OrdersApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, StubPaymentGateway>();
        });
    }
}
```

A distinção importa. Callbacks de `ConfigureServices` rodam na ordem de registro ao lado dos da própria aplicação, então o seu pode executar antes de o `Program.cs` adicionar a implementação dele. `ConfigureTestServices` é deliberadamente adiado até depois de o registro de serviços da aplicação ter terminado, e é isso que torna confiável a substituição em que "o último vence".

"O último vence" só se aplica à resolução de um único serviço. `GetRequiredService<IPaymentGateway>()` devolve o último registro, mas `GetRequiredService<IEnumerable<IPaymentGateway>>()` devolve os dois, e qualquer coisa injetada como `IEnumerable<T>` (validadores, health checks, hosted services, `IStartupFilter`) também vai enxergar o original. É por isso que `RemoveAll<T>` aparece antes do `Add`. Para serviços registrados por chave, a injeção de dependência do .NET 11 tem `RemoveAllKeyed<T>`, que combina com [o registro e a resolução de serviços com chave](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

Para uma substituição pontual que não deve afetar o restante da classe, use `WithWebHostBuilder`. Ele devolve uma nova factory que não compartilha nada além da configuração que você fornecer:

```csharp
[Fact]
public async Task Gateway_timeout_maps_to_502()
{
    var client = _factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, TimingOutGateway>();
        });
    }).CreateClient();

    var response = await client.PostAsJsonAsync("/orders",
        new { customerId = "C-1", amount = 10m });

    Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
}
```

## A pegadinha do registro do EF Core

Tutoriais escritos antes do EF Core 9 mandam localizar e remover o descritor de `DbContextOptions<TContext>` antes de adicionar o seu próprio provedor. Esse trecho não faz mais o que diz. Desde o EF Core 9, `AddDbContext` registra a configuração do provedor por meio de `IDbContextOptionsConfiguration<TContext>` em `Microsoft.EntityFrameworkCore.Infrastructure`, e remover apenas `DbContextOptions<TContext>` deixa a configuração original do SQL Server no lugar. Você então adiciona um segundo provedor e o EF lança:

```
System.InvalidOperationException: Only a single database provider can be registered
in a service provider. If possible, ensure that Entity Framework is managing its
service provider by removing the call to UseInternalServiceProvider.
```

O registro a remover no EF Core 9, 10 e 11 é este:

```csharp
// .NET 11, EF Core 11
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

builder.ConfigureTestServices(services =>
{
    var registrations = services
        .Where(d => d.ServiceType ==
            typeof(IDbContextOptionsConfiguration<OrdersDbContext>))
        .ToList();

    foreach (var registration in registrations)
    {
        services.Remove(registration);
    }

    services.AddDbContext<OrdersDbContext>(options =>
        options.UseSqlite(_connection));
});
```

Repare que a conexão SQLite é um campo da factory, aberto uma vez e mantido aberto, porque um banco de dados SQLite em memória é destruído quando a última conexão dele fecha. Não recorra ao provedor em memória do EF Core aqui: ele não tem semântica relacional, então chaves estrangeiras, restrições de unicidade e tipos de coluna ficam todos sem verificação. Se o teste precisa provar que uma restrição dispara, execute-o contra o motor real como descrito em [testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), e veja [como simular o DbContext sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) para os casos em que um banco de dados é realmente exagero.

## Configuração e ambiente

`UseEnvironment("Testing")` é a alavanca mais barata: faz `IWebHostEnvironment.EnvironmentName` retornar `Testing`, carrega `appsettings.Testing.json` se existir e permite que o código de produção se ramifique com `env.IsProduction()` sem casos especiais para testes.

Para ajustes individuais, o complicado é o momento da substituição. `ConfigureAppConfiguration` dentro de `ConfigureWebHost` roda depois que `WebApplication.CreateBuilder` já retornou, então um valor adicionado ali é invisível para qualquer código do `Program.cs` que leia `builder.Configuration` durante a inicialização, o que inclui a maioria das chamadas a `AddOptions` e `Bind`. O .NET 11 preview 6 adiciona um hook que roda cedo o bastante:

```csharp
// .NET 11 preview 6 and later
private static readonly KeyValuePair<string, string?>[] s_settings =
[
    new("Payments:Endpoint", "https://localhost/stub"),
    new("Features:UseNewPricing", "true"),
];

protected override void ConfigureHostApplicationBuilder(
    IHostApplicationBuilder hostApplicationBuilder)
{
    hostApplicationBuilder.Configuration.AddInMemoryCollection(s_settings);
    base.ConfigureHostApplicationBuilder(hostApplicationBuilder);
}
```

A fonte de configuração já está no lugar antes de `CreateBuilder` retornar, então o código de inicialização a enxerga. No .NET 10 e anteriores o equivalente é sobrescrever `CreateHost` e chamar `builder.ConfigureHostConfiguration(...)` antes de `base.CreateHost(builder)`, ou simplesmente definir variáveis de ambiente no processo de teste antes de o host ser construído.

## Simulando um usuário autenticado

Não tente obter um token real em um teste. Registre um esquema de autenticação de teste que sempre tem sucesso e torne-o o padrão:

```csharp
// .NET 11, C# 14
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, "user-1"),
            new(ClaimTypes.Name, "Test User"),
            new("scope", "orders:write"),
        ];

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme));
        var ticket = new AuthenticationTicket(principal, Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// in ConfigureTestServices
services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = TestAuthHandler.Scheme;
    options.DefaultChallengeScheme = TestAuthHandler.Scheme;
})
.AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
    TestAuthHandler.Scheme, _ => { });
```

Depois defina `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(TestAuthHandler.Scheme)` e a requisição chega autenticada. As suas políticas de autorização continuam rodando de verdade, e esse é o ponto: isso testa a política, não o formato do token. Se o que você quer verificar é a validação do token em si, esse é outro teste, e os parâmetros envolvidos estão cobertos em [como configurar autenticação JWT bearer em uma minimal API](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Opções do cliente que mudam a resposta

`CreateClient` aceita um `WebApplicationFactoryClientOptions`, e duas das suas propriedades rotineiramente decidem se um teste passa:

```csharp
var client = factory.CreateClient(new WebApplicationFactoryClientOptions
{
    AllowAutoRedirect = false,          // default true
    BaseAddress = new Uri("https://localhost"),
    HandleCookies = true,               // default true
    MaxAutomaticRedirections = 7,
});
```

`AllowAutoRedirect` é `true` por padrão, então um handler que devolve `302` é seguido silenciosamente e a sua asserção sobre `HttpStatusCode.Redirect` falha com `200 OK`. Desligue-o sempre que o próprio redirecionamento for o comportamento sob teste. O `BaseAddress` de `https://localhost` importa se o pipeline inclui `UseHttpsRedirection`, já que uma requisição para `http://localhost` é respondida com um redirecionamento em vez do recurso.

## Quando você precisa de uma porta real

`TestServer` não consegue servir um navegador. Desde o .NET 10, `WebApplicationFactory` pode rodar sobre o Kestrel, vinculando uma porta real de loopback:

```csharp
// .NET 10 and .NET 11
var factory = new OrdersApiFactory();
factory.UseKestrel(0);      // 0 means "pick a free port"
factory.StartServer();

var client = factory.CreateClient();
// client.BaseAddress is now the real bound address, for example
// http://127.0.0.1:53127/, taken from IServerAddressesFeature
await page.GotoAsync(client.BaseAddress!.ToString());
```

`UseKestrel` precisa ser chamado antes de a factory ser inicializada, ou seja, antes de qualquer chamada a `CreateClient` ou `StartServer`, senão lança `InvalidOperationException`. Uma vez que o Kestrel entra em jogo, `CreateClient` devolve um `HttpClient` comum cujo `BaseAddress` foi extraído do `IServerAddressesFeature` do servidor, então Playwright ou Selenium podem dirigir o mesmo host que os seus outros testes exercitam em memória. Existem também as sobrecargas `UseKestrel()` e `UseKestrel(Action<KestrelServerOptions>)` para quando você precisa configurar limites ou HTTPS.

## Ciclo de vida, descarte e estado compartilhado

`WebApplicationFactory<T>` é descartável, e o xUnit descarta o fixture por você. Se a sua factory possui recursos extras (uma conexão SQLite, um contêiner, um diretório temporário), implemente `IAsyncLifetime` nela. No xUnit v3 a interface deriva de `IAsyncDisposable` e ambos os métodos retornam `ValueTask`, então as assinaturas do v2 que retornavam `Task` não compilam mais depois de uma migração:

```csharp
// xUnit v3
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");

    public async ValueTask InitializeAsync() => await _connection.OpenAsync();

    public override async ValueTask DisposeAsync()
    {
        await _connection.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

A escolha do escopo é um trade-off: `IClassFixture<T>` inicializa um host por classe de teste, `ICollectionFixture<T>` compartilha um host entre todas as classes da coleção (e as serializa), e um fixture de assembly compartilha um para a execução inteira. A inicialização do host costuma levar de 200 a 500 ms, então por classe é um padrão razoável, mas lembre que cada singleton da aplicação fica compartilhado por esse tempo. Um cache, um contador `static`, um `IMemoryCache` ou um outbox em processo carregam estado de um teste para o próximo. Reinicialize isso explicitamente no teste, ou reduza o escopo do fixture.

Para qualquer coisa que dependa do relógio, não durma. Registre `TimeProvider` na aplicação e troque-o por `FakeTimeProvider` em `ConfigureTestServices`, como descrito em [como testar código dependente do tempo com TimeProvider e FakeTimeProvider](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). E quando a aplicação faz chamadas HTTP para fora, substitua o handler em vez do cliente, seguindo o padrão de [como testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/).

Uma última armadilha: `xunit.runner.visualstudio` faz shadow copy dos assemblies de teste por padrão em algumas configurações, o que quebra a descoberta do content root da qual arquivos estáticos e views do Razor dependem. Se uma página renderiza em produção mas dá 404 em um teste, adicione `xunit.runner.json` com `"shadowCopy": false` e configure-o para ser copiado para o diretório de saída.

O modelo mental que mantém tudo isso em ordem é que `WebApplicationFactory` é o seu host de produção com exatamente duas coisas alteradas: a implementação do servidor e o que você substituir deliberadamente em `ConfigureTestServices`. Toda surpresa que ele produz remete a algo no seu caminho real de inicialização que você esqueceu que iria executar.

## Relacionados

- [Como escrever testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Como testar código dependente do tempo com TimeProvider e FakeTimeProvider no .NET 11](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [Como testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Como configurar autenticação JWT bearer em uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Como registrar e resolver serviços com chave na injeção de dependência do .NET 11](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [WebApplication.CreateBuilder versus CreateSlimBuilder e CreateEmptyBuilder no ASP.NET Core 11](/pt-br/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Fontes

- [Testes de integração no ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [WebApplicationFactory&lt;TEntryPoint&gt;.UseKestrel (referência de API)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel)
- [Código-fonte do WebApplicationFactory.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Testing/src/WebApplicationFactory.cs)
- [IDbContextOptionsConfiguration&lt;TContext&gt; (referência de API do EF Core)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.idbcontextoptionsconfiguration-1)
- [Migrando testes de unidade do xUnit v2 para o v3](https://xunit.net/docs/getting-started/v3/migration)
