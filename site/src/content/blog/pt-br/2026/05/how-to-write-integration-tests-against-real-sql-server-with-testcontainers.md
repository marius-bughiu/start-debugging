---
title: "Como escrever testes de integração contra um SQL Server real com Testcontainers"
description: "Um guia completo para rodar testes de integração de ASP.NET Core contra um SQL Server 2022 real usando Testcontainers 4.11 e EF Core 11: configuração de WebApplicationFactory, IAsyncLifetime, troca do registro do DbContext, aplicação de migrations, paralelismo, limpeza com Ryuk e armadilhas de CI."
pubDate: 2026-05-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "sql-server"
lang: "pt-br"
translationOf: "2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para rodar testes de integração contra um SQL Server real a partir de um projeto de testes em .NET 11, instale `Testcontainers.MsSql` 4.11.0, monte um `WebApplicationFactory<Program>` que seja dono de um `MsSqlContainer`, inicie o contêiner em `IAsyncLifetime.InitializeAsync`, sobrescreva o registro do `DbContext` em `ConfigureWebHost` para apontar para `container.GetConnectionString()` e aplique as migrations uma única vez antes do primeiro teste. Use `IClassFixture<T>` para que o xUnit compartilhe um único contêiner entre os testes de uma classe. Fixe a imagem do SQL Server em uma tag específica, padrão `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, e deixe o Ryuk descartar o contêiner se o seu processo travar. Este guia foi escrito para .NET 11 preview 3, C# 14, EF Core 11, xUnit 2.9 e Testcontainers 4.11. O padrão é o mesmo no .NET 8, 9 e 10; só mudam as versões dos pacotes.

## Por que um SQL Server real, e não o provider em memória

O EF Core traz um provider em memória e uma opção SQLite em memória que se parecem com o SQL Server até parar de se parecer. O provider em memória não tem comportamento relacional algum: nada de transações, nada de aplicação de chaves estrangeiras, nada de tokens de concorrência `RowVersion`, nada de tradução para SQL. O SQLite é um motor relacional de verdade, mas usa um dialeto SQL diferente, outra forma de citar identificadores e um tipo decimal distinto. Os problemas concretos que você quer que seus testes de integração capturem, como um índice ausente, uma violação de unique, um truncamento de `nvarchar` ou perda de precisão em `DateTime2`, ficam silenciosamente mascarados.

A documentação oficial do EF Core chegou a adicionar há anos um aviso de "não teste contra in-memory", e o padrão recomendado pelo time na página [testing without your production database system](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) é "suba um real em um contêiner". Testcontainers transforma isso numa única chamada de método. O preço é o tempo de cold start de baixar e iniciar uma imagem do SQL Server (cerca de 8 a 12 segundos com um daemon Docker quente), mas a partir daí cada asserção é avaliada pelo motor que roda em produção.

## Fixe a imagem, não deixe flutuando

Antes de escrever código, defina a tag da imagem. A documentação do Testcontainers usa por padrão `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, que é a escolha certa pelo mesmo motivo pelo qual você não usa `:latest` em produção: uma pipeline de CI que funcionou ontem precisa funcionar hoje. Uma nova atualização cumulativa não é um upgrade gratuito na sua pipeline de testes porque cada CU pode mudar o otimizador, alterar os esquemas de `sys.dm_*` e elevar o nível mínimo de patch para ferramentas como `sqlpackage`.

A imagem `2022-CU14-ubuntu-22.04` tem cerca de 1,6 GB compactada, e o primeiro pull num runner de CI novo é a parte mais lenta da suíte. Faça cache dessa camada na CI: o GitHub Actions tem `docker/setup-buildx-action` com `cache-from`, e o Azure DevOps faz cache de `~/.docker` com o mesmo efeito. Depois do primeiro cache quente, os pulls levam cerca de 2 segundos.

Se você precisar de recursos do SQL Server 2025 (busca vetorial, `JSON_CONTAINS`, ver [SQL Server 2025 JSON contains in EF Core 11](/pt-br/2026/04/efcore-11-json-contains-sql-server-2025/)), suba a tag para `2025-CU2-ubuntu-22.04`. Caso contrário, fique no 2022, porque a imagem developer do 2022 é a mais testada pelos mantenedores do Testcontainers.

## Os pacotes que você precisa

Três pacotes cobrem o caminho feliz:

```xml
<!-- .NET 11, xUnit-based test project -->
<ItemGroup>
  <PackageReference Include="Testcontainers.MsSql" Version="4.11.0" />
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
</ItemGroup>
```

`Testcontainers.MsSql` puxa o pacote `Testcontainers` base e o `MsSqlBuilder`. `Microsoft.AspNetCore.Mvc.Testing` traz o `WebApplicationFactory<TEntryPoint>`, que sobe todo o seu contêiner de DI e a pipeline HTTP contra um `TestServer`. `Microsoft.EntityFrameworkCore.SqlServer` é o que seu código de produção já referencia; o projeto de testes o adiciona para que o fixture consiga aplicar migrations.

Se seus testes usam xUnit, adicione também `xunit` 2.9.x e `xunit.runner.visualstudio` 2.8.x. Se você está em NUnit ou MSTest, o mesmo padrão de fábrica funciona, só mudam os nomes dos hooks de ciclo de vida.

## A classe de fábrica

A fábrica de testes de integração faz três coisas: ela é dona do ciclo de vida do contêiner, expõe a connection string para a DI do host e aplica o esquema antes de qualquer teste rodar. Eis a implementação completa contra um `OrdersDbContext` hipotético:

```csharp
// .NET 11, C# 14, EF Core 11, Testcontainers 4.11
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.MsSql;
using Xunit;

public sealed class OrdersApiFactory
    : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04")
        .WithPassword("Strong!Passw0rd_for_tests")
        .Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<OrdersDbContext>>();
            services.AddDbContext<OrdersDbContext>(opts =>
                opts.UseSqlServer(_sql.GetConnectionString()));
        });
    }

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();

        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider
            .GetRequiredService<OrdersDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        await _sql.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Três detalhes merecem uma pausa. O contêiner é construído no inicializador de campo, mas só é iniciado em `InitializeAsync` porque o xUnit chama esse método exatamente uma vez por fixture. O host (e portanto o contêiner de DI) é construído de forma preguiçosa pelo `WebApplicationFactory` na primeira vez que você lê `Services` ou chama `CreateClient`, então quando `InitializeAsync` chama `Services.CreateScope()` o contêiner SQL já está de pé e a connection string está ligada. A linha `RemoveAll<DbContextOptions<OrdersDbContext>>` não é negociável: omiti-la deixa dois registros, e `services.AddDbContext` vira o segundo, que silenciosamente mantém os dois conforme a ordem do resolver.

A chamada `WithPassword` define a senha do SA. A política de senha do SQL Server exige pelo menos oito caracteres e uma mistura de maiúsculas, minúsculas, dígitos e símbolos; se você passar uma senha mais fraca, o contêiner sobe mas o motor falha nos health checks. A senha SA padrão do Testcontainers é `yourStrong(!)Password`, que já passa na política, então omitir `.WithPassword` também funciona.

## Usando a fábrica em uma classe de teste

`IClassFixture<T>` do xUnit é o escopo certo para a maioria dos casos. Ele constrói o fixture uma vez, roda cada método de teste da classe contra o mesmo contêiner SQL e depois descarta:

```csharp
// .NET 11, xUnit 2.9
public sealed class OrdersApiTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    private readonly HttpClient _client;

    public OrdersApiTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Post_creates_order_and_returns_201()
    {
        var response = await _client.PostAsJsonAsync("/orders",
            new { customerId = "C-101", amount = 49.99m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Get_returns_persisted_order()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Add(new Order { Id = "O-1", CustomerId = "C-101" });
        await db.SaveChangesAsync();

        var response = await _client.GetAsync("/orders/O-1");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
```

Se você precisa de um contêiner novo para cada teste (por exemplo, quando um teste reescreve o esquema), use `IAsyncLifetime` direto na classe de teste no lugar de `IClassFixture`. Isso é raro: em nove casos de cada dez você quer pagar o custo de cold start uma vez por classe e resetar o estado truncando tabelas, não reiniciando.

## Resete o estado entre testes, não reinicie o contêiner

O custo honesto dos testes com "SQL Server real" é o vazamento de estado: o teste A insere linhas, o teste B faz asserção sobre uma contagem e recebe uma resposta errada. Existem três soluções, em ordem de velocidade:

1. **Truncar no início de cada teste.** O mais barato. Mantenha um `static readonly string[] TablesInTruncationOrder` e rode `TRUNCATE TABLE` em cada uma. É o que os mantenedores do Testcontainers recomendam no exemplo de ASP.NET Core deles.
2. **Envolver cada teste em uma transação e dar rollback no final.** Funciona se o código sob teste não chamar `BeginTransaction` por conta própria. O EF Core 11 ainda não permite transações aninhadas no SQL Server sem uma chamada a `EnlistTransaction`.
3. **Usar `Respawn`** ([pacote no NuGet](https://www.nuget.org/packages/Respawn)). Gera o script de truncamento uma vez lendo o information schema, faz cache e o roda antes de cada teste. É o que a maioria dos times grandes acaba adotando depois de algumas centenas de testes.

Escolha o que escolher, **não** chame `EnsureDeletedAsync` e `MigrateAsync` entre testes. O runner de migrations do EF Core leva alguns segundos mesmo para um esquema pequeno; multiplique por 200 testes e sua suíte sai de 30 segundos para 30 minutos. Para os trade-offs do ciclo de vida do DbContext em testes, ver [removing pooled DbContextFactory in EF Core 11 test swaps](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) e as notas relacionadas sobre [warming up the EF Core model](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/).

## Execução paralela de testes

O xUnit executa classes de teste em paralelo por padrão. Com um contêiner por fixture de classe, isso significa N classes acendendo M contêineres de uma vez, onde M é limitado pela memória do seu host Docker. Um SQL Server consome cerca de 1,5 GB de RAM por instância parada, então um runner do GitHub Actions com 16 GB para em torno de oito classes paralelas antes de começar a fazer swap.

Dois ajustes comuns:

```xml
<!-- xunit.runner.json in the test project, copy to output -->
{
  "parallelizeTestCollections": true,
  "maxParallelThreads": 4
}
```

```csharp
// or, opt-out per assembly
[assembly: CollectionBehavior(MaxParallelThreads = 4)]
```

Se você usar o atributo `[Collection]` para compartilhar um contêiner entre várias classes, essas classes serializam. Às vezes é o trade-off certo: um contêiner quente, relógio de parede mais lento por teste, muito menos pressão de RAM.

## O que o Ryuk faz e por que você deveria deixar ligado

O Testcontainers entrega um sidecar chamado Ryuk (imagem `testcontainers/ryuk`). Quando o processo .NET inicia, o Ryuk se conecta ao daemon Docker e fica de olho no processo pai. Se o seu test runner cai, dá pânico ou leva `kill -9`, o Ryuk percebe que o pai sumiu e descarta os contêineres rotulados. Sem o Ryuk, uma execução de testes que crasha deixa contêineres SQL Server órfãos, e a próxima execução bate em conflito de portas ou fica sem RAM.

O Ryuk vem ligado por padrão. Desligá-lo (`TESTCONTAINERS_RYUK_DISABLED=true`) é às vezes recomendado em ambientes de CI restritos, mas isso joga o ônus da limpeza no seu CI. Se você precisar desligar, adicione um passo pós-job que rode `docker container prune -f --filter "label=org.testcontainers=true"`.

## Armadilhas de CI

Os runners do GitHub Actions trazem o Docker pré-instalado em runners Linux (`ubuntu-latest`), mas não em macOS ou Windows. Fixe em Linux para o contêiner SQL ou pague o preço de `docker/setup-docker-action`. Os agentes Linux hospedados pela Microsoft no Azure DevOps funcionam do mesmo jeito; em agentes Windows self-hosted você precisa de Docker Desktop com backend WSL2 e uma imagem do SQL Server que combine com a arquitetura do host.

A outra coisa que machuca os times é fuso horário e cultura. A imagem base do Ubuntu está em UTC; se seus testes comparam contra `DateTime.Now`, vão passar localmente e falhar no CI. Use `DateTime.UtcNow` em todo lugar ou injete `TimeProvider` (embutido no .NET 8 e posteriores) e plante uma hora determinística.

## Verificando se o contêiner subiu de verdade

Se um teste falhar com `A network-related or instance-specific error occurred`, o contêiner não terminou de subir antes do EF Core abrir uma conexão. O módulo MsSql do Testcontainers tem uma estratégia de espera embutida que faz polling até o motor responder, então isso só acontece se você substituiu a espera. Confirme com:

```csharp
// peek at the dynamic host port
var port = _sql.GetMappedPublicPort(MsSqlBuilder.MsSqlPort);
Console.WriteLine($"SQL is listening on localhost:{port}");
```

A estratégia de espera usa `sqlcmd` dentro do contêiner; se sua imagem do SQL Server não inclui `sqlcmd` (imagens mais antigas), passe `.WithWaitStrategy(Wait.ForUnixContainer().UntilCommandIsCompleted("/opt/mssql-tools18/bin/sqlcmd", "-Q", "SELECT 1"))` para sobrescrever.

## Onde isso deixa de ser suficiente

O Testcontainers te dá um SQL Server real. Não te dá Always On, roteamento por sharding nem busca full-text espalhada por vários arquivos. Se o seu banco de produção é um cluster configurado, seus testes de integração rodam contra um único nó e sua suíte tem uma lacuna de cobertura conhecida. Documente-a e escreva testes menores e direcionados contra um ambiente de staging para o comportamento específico do cluster, ver [unit testing code that uses HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) para o padrão que cuida das chamadas à API de staging.

O que o provider em memória ensinou a uma geração de times .NET é que "passa local" não é um sinal de deploy. Banco de dados real, porta real, bytes reais no fio, pagos com 10 segundos de cold start. Seguro barato.

## Relacionados

- [How to mock DbContext without breaking change tracking](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Removing pooled DbContextFactory for cleaner test swaps in EF Core 11](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [Warm up the EF Core model before the first query](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)
- [Single-step migrations with `dotnet ef update --add` in EF Core 11](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Unit-testing code that uses HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Fontes

- [Microsoft SQL Server module (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/modules/mssql/)
- [ASP.NET Core example (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/examples/aspnet/)
- [Testcontainers.MsSql 4.11.0 on NuGet](https://www.nuget.org/packages/Testcontainers.MsSql)
- [Choosing a testing strategy (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)
- [Respawn package on NuGet](https://www.nuget.org/packages/Respawn)
