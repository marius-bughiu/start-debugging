---
title: "Fix: dotnet ef migrations add falha com 'Unable to create an object of type DbContext'"
description: "As ferramentas em tempo de design do EF Core não conseguiram instanciar seu DbContext. Exponha um host com WebApplication.CreateBuilder, aponte para o startup project correto ou implemente IDesignTimeDbContextFactory."
pubDate: 2026-05-11
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
lang: "pt-br"
translationOf: "2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext"
translatedBy: "claude"
translationDate: 2026-05-11
---

A correção: `dotnet ef` executa sua aplicação em tempo de design para descobrir o `DbContext`. Falhou porque o ponto de entrada não retornou um host que pudesse ser inspecionado, ou porque seu `DbContext` tem parâmetros de construtor que não podem ser resolvidos sem um. Em uma aplicação web, garanta que `Program.cs` compile e use (ou retorne) um `WebApplication`. Em uma biblioteca de classes ou projeto de testes, adicione uma implementação de `IDesignTimeDbContextFactory<TContext>`. Depois execute novamente com `--startup-project` apontando para o projeto host, não para o projeto de dados.

```text
Unable to create an object of type 'AppDbContext'. For the different patterns supported at design time, see https://go.microsoft.com/fwlink/?linkid=851728
```

Este guia foi escrito contra `Microsoft.EntityFrameworkCore.Design` 11.0.0-preview.4, `dotnet-ef` 11.0.0-preview.4 e o SDK do .NET 11 preview 4. O mesmo comportamento se aplica até o EF Core 3.1: as regras de descoberta em tempo de design não mudaram de forma desde a introdução do host genérico. Se você ainda está no EF Core 6 ou 8, todas as correções abaixo funcionam, apenas os namespaces mudam ligeiramente.

## Como as ferramentas em tempo de design encontram seu DbContext

Quando você executa `dotnet ef migrations add Init`, a ferramenta não faz uma varredura estática do seu código. Ela compila seu projeto, carrega o assembly resultante e procura por uma de quatro coisas, nesta ordem:

1. Uma implementação de `IDesignTimeDbContextFactory<TContext>` no startup project.
2. Um host retornado de `Program.Main` ou exposto via o padrão implícito de `WebApplication`. A ferramenta chama `IHost.Services.GetRequiredService<TContext>()` contra ele.
3. Um `DbContext` com um construtor público sem parâmetros. A ferramenta chama `new TContext()` diretamente.
4. Um `DbContext` com `OnConfiguring` que não depende de serviços injetados.

Se nenhum produzir uma instância, você recebe o erro `Unable to create an object of type 'X'`. O hyperlink na mensagem aponta para a documentação de tempo de design, que lista os mesmos quatro caminhos.

## Por que isso acontece em uma aplicação web típica

A maioria dos projetos falha no caminho 2. A ferramenta consegue chamar seu `Program.cs` mas não encontra um host para inspecionar. Três coisas comumente quebram o caminho 2 em 2026:

1. `Program.cs` compila o `WebApplication` mas sai antes que a ferramenta possa ler `Services` por causa da ordem das top-level statements.
2. O `DbContext` está registrado em um assembly diferente daquele passado como `--startup-project`. A ferramenta executou o projeto errado.
3. O construtor do `DbContext` recebe um tipo personalizado (um resolver de tenant, um relógio, um serviço de feature flag) que o container de injeção de dependência não consegue resolver sem que `app.Run()` execute de fato.

O primeiro é o assassino silencioso. Com top-level statements, o compilador sintetiza um `Program.Main` cujo tipo de retorno e instrução final importam para o EF Core. Se `app.Run()` é a última expressão, a ferramenta lê o host via reflexão sobre a classe sintética `Program`. Se você envolveu a chamada de run em um condicional, ou se faz um `return` antecipado, o host nunca chega à ferramenta.

## Uma reprodução mínima

Este é o menor projeto que produz o erro. Um projeto `WebApi`, um `DbContext` com uma dependência injetada, sem design-time factory.

```csharp
// AppDbContext.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext : DbContext
{
    private readonly ITenantResolver _tenant;

    public AppDbContext(DbContextOptions<AppDbContext> options, ITenantResolver tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Order> Orders => Set<Order>();
}

public interface ITenantResolver { string Current { get; } }
public sealed class Order { public int Id { get; set; } public string TenantId { get; set; } = ""; }
```

```csharp
// Program.cs - .NET 11
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

if (args.Contains("--migrate-only"))
{
    return; // <-- design-time tool reads this path, never reaches app.Run()
}

app.Run();
```

Executar `dotnet ef migrations add Init` contra esse projeto imprime o erro. O registro de `ITenantResolver` só acontece depois de `builder.Build()`, mas o `return` antecipado curto-circuita o `Main` sintetizado e a inspeção de host do EF Core vê um estado parcialmente inicializado. O código de descoberta também tenta `new AppDbContext()`, que falha porque o construtor precisa de dois argumentos.

## Correção 1 - deixe o host ser descobrível (recomendado para aplicações web)

A correção mais limpa é deixar `Program.cs` terminar de inicializar o host sem returns antecipados condicionais. A design-time host factory do EF Core usa `HostFactoryResolver` para percorrer o `Program.Main` compilado e pegar a referência ao `IHost`. Qualquer coisa que impeça esse percurso também impede o EF Core de encontrar o contexto.

```csharp
// Program.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

app.MapGet("/", () => "ok");

app.Run();
```

Essa única mudança normalmente é suficiente. Confirme com a flag `--verbose`:

```bash
dotnet ef migrations add Init --verbose
```

Você deve ver linhas como `Finding design-time services...`, `Using application service provider from Microsoft.Extensions.Hosting.IHostBuilder.` e `Using DbContext factory 'AppDbContext'.` Se `--verbose` reportar `No host builder was found`, o caminho 2 ainda está quebrado e você precisa da correção 2 ou da correção 3.

Se você genuinamente precisa de um switch `--migrate-only` (um runner de console que sai antes de `app.Run()` em produção), coloque-o depois que o host for construído, mas **retorne o host** em vez de void, para que o `Main` sintetizado ainda termine com a referência ao host:

```csharp
// Program.cs - .NET 11
var app = builder.Build();
app.MapGet("/", () => "ok");

if (args.Contains("--migrate-only"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.Run();
```

A ferramenta em tempo de design ainda vê `app.Run()` como a instrução terminal e consegue inspecionar `app.Services` antes de invocá-la.

## Correção 2 - aponte para o startup project correto

Uma solution com um projeto `Web` que referencia uma biblioteca de classes `Data` é a segunda causa mais comum. As pessoas executam `dotnet ef migrations add Init` de dentro de `Data/`, onde o `DbContext` vive, esperando que a ferramenta use o host registrado em `Web`. Ela não vai usar. A ferramenta compila o projeto **atual** (ou o que `--project` indicar) e procura um host dentro **daquele** assembly.

```bash
# Run from the solution root, EF Core 11.0.0-preview.4 / .NET 11
dotnet ef migrations add Init \
  --project src/Data/Data.csproj \
  --startup-project src/Web/Web.csproj
```

`--project` é onde os arquivos de migração são escritos. `--startup-project` é onde o host vive. Ambas as flags são obrigatórias quando não são o mesmo projeto. Muitos times criam um alias para isso em `Directory.Build.props` ou num `Makefile` para nunca precisar digitar a invocação longa.

Você pode verificar qual assembly a ferramenta carregou de fato com `dotnet ef dbcontext info --startup-project src/Web/Web.csproj`. Ele imprime o nome do tipo resolvido, o provider e a fonte da connection string. Se `info` funciona mas `migrations add` falha, você tem um problema de construtor, não de descoberta: pule para a correção 3.

## Correção 3 - implemente IDesignTimeDbContextFactory

Para bibliotecas de classes sem host (o layout típico para uma camada de dados empacotada, um projeto de testes ou um projeto compartilhado hospedado do Blazor WebAssembly), não há `Program.Main` para inspecionar. Adicione uma factory no mesmo projeto que o `DbContext`:

```csharp
// DesignTimeDbContextFactory.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=design-time;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;

        return new AppDbContext(options, new DesignTimeTenantResolver());
    }

    private sealed class DesignTimeTenantResolver : ITenantResolver
    {
        public string Current => "design-time";
    }
}
```

A descoberta do EF Core verifica se existe `IDesignTimeDbContextFactory<TContext>` **antes** de percorrer o host, então essa implementação também sobrescreve qualquer outra coisa. Isso a torna a correção mais confiável, mas tem um custo: a connection string é duplicada. Leia-a de `appsettings.json` se quiser evitar isso:

```csharp
// EF Core 11.0.0-preview.4 - read connection string from config
public AppDbContext CreateDbContext(string[] args)
{
    var config = new ConfigurationBuilder()
        .SetBasePath(Directory.GetCurrentDirectory())
        .AddJsonFile("appsettings.json", optional: false)
        .AddJsonFile($"appsettings.{Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "Development"}.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseSqlServer(config.GetConnectionString("Default"))
        .Options;

    return new AppDbContext(options, new DesignTimeTenantResolver());
}
```

Um lembrete sobre cópia de arquivo: `appsettings.json` precisa estar configurado como `Copy if newer` no projeto que executa a ferramenta, ou o diretório de trabalho não vai contê-lo. Se você passar do erro de descoberta e cair em uma connection string `null`, essa é a mesma armadilha coberta no artigo canônico sobre [o erro No connection string named DefaultConnection](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/).

## Correção 4 - a armadilha do contrato de args

Se você já tem uma design-time factory e ainda vê o erro na CI, verifique o parâmetro `args`. A ferramenta do EF Core passa sua própria lista de argumentos para `CreateDbContext(string[] args)`. Código que confunde isso com os `args` da aplicação e rejeita flags desconhecidas lançará uma exceção antes de o contexto ser retornado. A ferramenta então reporta esse throw como a falha de descoberta:

```csharp
// Wrong - throws on EF Core's own args
public AppDbContext CreateDbContext(string[] args)
{
    if (args.Length != 2) throw new ArgumentException("expected env and db");
    ...
}
```

Ou remova a validação, ou aceite que os `args` em tempo de design são opacos e baseie a lógica em `Environment.GetEnvironmentVariable`.

## Erros que parecem este mas não são

- **`Could not load file or assembly 'Microsoft.EntityFrameworkCore.Design'`**. Você esqueceu de adicionar o pacote `Microsoft.EntityFrameworkCore.Design` ao startup project. Ele precisa estar referenciado lá mesmo que o `DbContext` viva em outro lugar, porque a ferramenta o carrega da pasta bin do assembly de inicialização.
- **`No project was found`**. Você executou `dotnet ef` de uma pasta sem `.csproj`. Execute a partir da raiz do projeto ou passe `--project`.
- **`The command 'dotnet-ef' could not be found`**. O manifesto local de ferramentas está faltando. Execute `dotnet new tool-manifest` e `dotnet tool install dotnet-ef --version 11.0.0-preview.4`. Fixar a versão importa: um `dotnet-ef` global instalado anos atrás vai silenciosamente desencaixar com o runtime.
- **`Cannot consume scoped service from singleton`**. A descoberta funcionou, mas o registro de injeção de dependência está errado. Esse é um erro diferente e a [correção de scoped vs singleton lifetime](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) cobre isso.
- **`A second operation was started on this context instance`**. Também é um erro diferente, mas usuários do EF Core o encontram pelo mesmo buraco de coelho de busca. O [artigo sobre concorrência de DbContext](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/) explica passo a passo.

## Um checklist de depuração quando nenhuma das correções funciona

Se você tentou as quatro e a ferramenta ainda não consegue encontrar seu contexto, percorra este checklist em ordem. É a mesma lista que a label de triagem "design-time" do time do EF Core recomenda no GitHub.

1. `dotnet build` é bem-sucedido sem warnings sobre assemblies faltantes. A ferramenta roda contra seu build output, então um build verde é pré-requisito.
2. `dotnet ef dbcontext list --startup-project src/Web/Web.csproj` imprime o nome do seu contexto. Se isso também falhar, o assembly nunca carregou um contexto. Provavelmente falta `AddDbContext`.
3. `dotnet ef dbcontext info` imprime o provider e a connection string. Se isso tem sucesso mas `migrations add` falha, o construtor do seu `DbContext` lança uma exceção quando invocado de fato. Adicione log.
4. O `TargetFramework` do startup project bate com o runtime da ferramenta `dotnet-ef`. As ferramentas do EF Core 11 miram .NET 11. Elas não conseguem inspecionar um projeto que mira apenas `netstandard2.0`.
5. O startup project tem tanto `Microsoft.EntityFrameworkCore.Design` quanto o pacote do provider (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL`, etc.) referenciados.
6. `Program.cs` é o ponto de entrada. Se você tem múltiplos métodos `Main` ou usa configurações de `OutputType` que o escondem, a descoberta falha.

Uma vez que `dotnet ef dbcontext info` funcione de ponta a ponta, todos os outros comandos vão funcionar. Esse é o melhor smoke test e é mais rápido do que executar uma migração de verdade.

## Relacionado

- O [fluxo de migração de um passo no EF Core 11](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) cobre `dotnet ef migrations update --add`, o novo comando combinado introduzido para atualizações rotineiras de schema.
- Para erros de escopo de injeção de dependência em runtime, veja [a correção de serviço scoped a partir de singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Se `GetConnectionString` retorna null em tempo de design, veja [o artigo sobre connection string faltante](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/).
- Para testar a camada de dados sem encostar na descoberta em tempo de design, [testes de integração com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) mantém o projeto de testes independente do toolchain de migrações.
- Para aquecer a criação do modelo antes da primeira requisição, [como aquecer o modelo do EF Core](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) cobre o problema relacionado de caminho frio.

## Fontes

- [Design-time DbContext Creation - EF Core docs](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation)
- [EF Core Tools Reference - dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [HostFactoryResolver source on dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting/src/Internal/HostFactoryResolver.cs)
- [EF Core issue 21025: design-time discovery on top-level statements](https://github.com/dotnet/efcore/issues/21025)
- [WebApplication and the generic host - ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis)
