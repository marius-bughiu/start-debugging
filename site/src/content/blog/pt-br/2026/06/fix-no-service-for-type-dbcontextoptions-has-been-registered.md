---
title: "Corrigir: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered"
description: "O EF Core lança isso quando AddDbContext nunca rodou, rodou depois de Build ou o construtor do contexto recebe o DbContextOptions errado. Registre antes de Build e use DbContextOptions<SeuContexto>."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered"
translatedBy: "claude"
translationDate: 2026-06-26
---

A correção: o contêiner de injeção de dependência recebeu um pedido de `DbContextOptions` enquanto construía seu `DbContext`, e não tinha nada para devolver. Em quase todos os casos isso significa que `AddDbContext<SeuContexto>(...)` nunca foi chamado, foi chamado depois de `builder.Build()`, vive em um método `ConfigureServices` que não roda mais, ou o construtor do seu contexto declara um parâmetro que o contêiner não registra. Adicione `builder.Services.AddDbContext<SeuContexto>(...)` antes de `Build()`, e dê ao construtor um parâmetro `DbContextOptions<SeuContexto>`, não o `DbContextOptions` não genérico.

```text
System.InvalidOperationException: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered.
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Você também pode ver a mesma causa raiz pelo caminho de ativação, com a forma genérica com crase do nome do tipo:

```text
System.InvalidOperationException: Unable to resolve service for type 'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to activate 'MyApp.Data.AppDbContext'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.GetService(...)
```

Este guia foi escrito contra .NET 11, EF Core 11.0.0 (`Microsoft.EntityFrameworkCore` 11.0.0) e `Microsoft.Extensions.DependencyInjection` 11.0.0. O comportamento descrito aqui é estável desde o EF Core 3.0, então as correções se aplicam igualmente ao EF Core 6, 8 e 10.

## As duas formas da mensagem são o mesmo erro

O contêiner do .NET emite duas frases diferentes para uma única falha subjacente, e qual delas você recebe depende de como a resolução começou:

- `No service for type 'X' has been registered.` vem de `GetRequiredService<X>()`. Algo pediu `X` ao provedor diretamente e `X` não estava na coleção.
- `Unable to resolve service for type 'X' while attempting to activate 'Y'.` vem de `ActivatorUtilities`. O contêiner estava construindo `Y`, encontrou um parâmetro de construtor do tipo `X` e não conseguiu satisfazê-lo.

Em ambos os casos aqui, `X` é `DbContextOptions` (ou seu genérico `DbContextOptions<AppDbContext>`, que o runtime imprime como ``DbContextOptions`1[AppDbContext]``). `Y`, quando presente, é o seu contexto. Leia os nomes dos tipos antes de mudar qualquer coisa: o erro é sobre o objeto de opções que o EF Core precisa para configurar o contexto, não sobre o contexto em si.

## O que o AddDbContext realmente registra

Entender a correção significa entender o que `AddDbContext<TContext>` coloca no contêiner. Internamente ele registra duas coisas para as opções (`Microsoft.EntityFrameworkCore.EntityFrameworkServiceCollectionExtensions`, o método `AddCoreServices`):

```csharp
// EF Core 11.0.0 - paraphrased from AddCoreServices
serviceCollection.TryAdd(
    new ServiceDescriptor(
        typeof(DbContextOptions<TContextImplementation>),
        CreateDbContextOptions<TContextImplementation>,
        optionsLifetime));

serviceCollection.Add(
    new ServiceDescriptor(
        typeof(DbContextOptions),
        p => p.GetRequiredService<DbContextOptions<TContextImplementation>>(),
        optionsLifetime));
```

Dois fatos saem disso e explicam cada variante do erro:

1. O genérico `DbContextOptions<TContext>` é o registro real. Ele é adicionado com `TryAdd`, então a primeira chamada vence para aquele tipo fechado.
2. O não genérico `DbContextOptions` é um encaminhador adicionado com `Add` (incondicional). Ele apenas chama `GetRequiredService<DbContextOptions<TContext>>()` por baixo dos panos. Por ser `Add`, não `TryAdd`, cada chamada de `AddDbContext` adiciona outro encaminhador, e quando você resolve o `DbContextOptions` não genérico, **o último registrado vence**.

Então, se você nunca chamar `AddDbContext`, nenhum dos dois registros existe, e pedir qualquer uma das formas lança a exceção. E se você registrar dois contextos mas um receber o `DbContextOptions` não genérico, esse contexto silenciosamente recebe as opções do outro contexto. Ambos os casos são cobertos abaixo.

## Reprodução mínima

O menor programa .NET 11 que lança o erro, por esquecer o registro completamente:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.AspNetCore.App 11.0.0
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// No builder.Services.AddDbContext<AppDbContext>(...) here.
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Product> Products => Set<Product>();
}

public sealed class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController]
[Route("products")]
public sealed class ProductsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(db.Products.Count());
}
```

Acesse `GET /products` e o MVC pede ao contêiner para ativar `ProductsController`, que precisa de um `AppDbContext`, que precisa de um `DbContextOptions<AppDbContext>`. Nada o registrou, então você recebe a forma de ativação do erro. Essa é a forma exata que você encontra logo após gerar (scaffold) um controller no Visual Studio contra um contexto que você ainda não conectou no `Program.cs`.

## Correção um: registre o contexto antes de o host ser construído

A resposta na grande maioria das vezes. Adicione o registro em `Program.cs` e garanta que ele rode antes de `builder.Build()`:

```csharp
// .NET 11, EF Core 11.0.0
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();
```

`builder.Build()` tira um snapshot da coleção de serviços. Tudo o que você adicionar a `builder.Services` depois dessa linha é silenciosamente ignorado pelo host em execução, então isto está errado:

```csharp
// .NET 11 - bug: registration after Build is discarded
var app = builder.Build();
builder.Services.AddDbContext<AppDbContext>(options => options.UseSqlServer(cs)); // too late
app.Run();
```

Se você está no modelo mais antigo de `Startup`, o registro pertence ao `ConfigureServices`, e a versão clássica desse erro é uma segunda sobrecarga de `ConfigureServices`, ou uma linha `services.AddDbContext` comentada que alguém desativou durante a depuração e nunca restaurou. Procure por `AddDbContext` em todo o projeto e confirme que a chamada que você encontrar está de fato no caminho de código que o host roda.

Se você construir um `DbContext` fora do pipeline de requisições, a mesma regra se aplica dentro de qualquer provedor que você tenha construído. Resolver um `DbContext` com escopo (scoped) a partir do provedor raiz, ou antes de `app.Run()` sem criar um escopo, falha pelo mesmo motivo:

```csharp
// .NET 11 - resolve a scoped DbContext correctly outside a request
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
}
```

## Correção dois: dê ao construtor um DbContextOptions<SeuContexto>

Se o registro está presente e você ainda assim encontra o erro, olhe o construtor. O registro de DI do EF Core produz `DbContextOptions<AppDbContext>`, então esse é o parâmetro que o construtor deveria declarar:

```csharp
// Right: generic, tied to this specific context type
public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
```

A versão não genérica compila e, com um único contexto registrado, até funciona, porque o encaminhador descrito acima a resolve. Mas é frágil:

```csharp
// Risky: non-generic. Works with one context, breaks with two.
public AppDbContext(DbContextOptions options) : base(options) { }
```

No momento em que um segundo contexto é registrado, ambas as chamadas de `AddDbContext` adicionam um encaminhador `DbContextOptions` não genérico, o último vence, e seu contexto recebe as opções erradas, normalmente a connection string errada ou até o provedor de banco de dados errado. A falha pode aparecer como um erro `No service` durante um registro parcial, ou pior, como um contexto que silenciosamente consulta o banco de dados errado. A documentação da Microsoft é explícita sobre isso:

> A maioria das subclasses de `DbContext` que aceitam um `DbContextOptions` deveria usar a variação genérica `DbContextOptions<TContext>`. Isso garante que as opções corretas para o subtipo de `DbContext` específico sejam resolvidas a partir da injeção de dependência, mesmo quando vários subtipos de `DbContext` são registrados.

Há um uso legítimo da forma não genérica: uma classe base destinada a ser herdada. A base recebe um `DbContextOptions` não genérico para que cada subclasse concreta possa passar seu próprio `DbContextOptions<TConcreto>`:

```csharp
// .NET 11, EF Core 11.0.0 - base class shared by several contexts
public abstract class AppDbContextBase : DbContext
{
    protected AppDbContextBase(DbContextOptions options) : base(options) { }
}

public sealed class CatalogDbContext : AppDbContextBase
{
    public CatalogDbContext(DbContextOptions<CatalogDbContext> options) : base(options) { }
}

public sealed class OrdersDbContext : AppDbContextBase
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }
}
```

Cada contexto concreto ainda expõe o construtor genérico, então a DI lhe entrega as opções certas; a base só fornece um construtor ao qual as subclasses se encadeiam. Um contexto que precisa ser instanciado diretamente e também herdado deveria expor ambos os construtores, com o genérico público e o não genérico protegido.

## Correção três: ferramentas em tempo de design (migrações e scaffolding)

Uma variante distinta desse erro aparece apenas quando você roda `dotnet ef`:

```text
Unable to create a 'DbContext' of type ''. The exception 'Unable to resolve service for type
'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to
activate 'MyApp.Data.AppDbContext'.' was thrown while attempting to create an instance.
```

Em tempo de design não há um host web em execução, então o EF Core não consegue extrair as opções do contêiner de DI da sua aplicação. Ele tenta construir o contexto mesmo assim e falha no parâmetro de opções. Duas correções confiáveis:

1. Deixe o EF encontrar o host do seu app. Se o seu `DbContext` vive no projeto de inicialização e o `Program.cs` chama `AddDbContext`, as ferramentas do EF podem usar o provedor de serviços do app. Mantenha o mesmo projeto em tempo de design e em tempo de execução, ou passe `--startup-project`.
2. Forneça uma fábrica explícita. Implemente `IDesignTimeDbContextFactory<TContext>` ao lado do contexto. O EF a descobre automaticamente e a usa em vez de adivinhar:

```csharp
// .NET 11, EF Core 11.0.0 - found automatically by dotnet ef
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=DesignTime;ConnectRetryCount=0")
            .Options;

        return new AppDbContext(options);
    }
}
```

A fábrica constrói `DbContextOptions<AppDbContext>` na mão, então os comandos em tempo de design nunca tocam a DI da sua aplicação. Essa é a correção canônica quando o contexto vive em uma biblioteca de classes sem host de inicialização próprio. Para a versão mais ampla dessa falha, veja o passo a passo dedicado sobre [por que `dotnet ef migrations add` reporta "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Construindo um contexto na mão

Se você não está usando DI de jeito nenhum, o registro não genérico de `DbContextOptions` é irrelevante. Construa as opções você mesmo e passe-as ao construtor:

```csharp
// .NET 11, EF Core 11.0.0 - no DI container involved
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlServer(connectionString)
    .Options;

using var db = new AppDbContext(options);
```

Essa é a forma certa para uma ferramenta de console, um teste ou um utilitário em segundo plano que não tem `IServiceProvider`. Note que o builder também é genérico: `DbContextOptionsBuilder<AppDbContext>` produz um `DbContextOptions<AppDbContext>`, que combina com o construtor genérico.

## Variantes que caem nesta página por engano

Vários casos parecidos são pesquisados da mesma forma mas se resolvem de modo diferente:

- **`No connection string named 'DefaultConnection' could be found`.** O contexto foi registrado certo; a busca pela connection string falhou. Outra camada, outra correção. Veja [o erro de connection string DefaultConnection](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/).
- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`, onde X é o seu próprio serviço, não `DbContextOptions`.** Isso é um registro faltando simples no seu código, não um problema de fiação do EF Core. Veja [o erro geral de resolução de serviço](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot consume scoped service 'AppDbContext' from singleton 'Y'`.** O contexto está registrado corretamente; um singleton está capturando-o. A correção é um escopo, não um registro.
- **`A second operation was started on this context instance`.** O contexto foi resolvido bem e está sendo compartilhado entre threads ou aguardado (await) incorretamente.
- **`AddDbContextPool` e `AddDbContextFactory`.** Ambos registram `DbContextOptions<TContext>` da mesma forma que `AddDbContext`, então a regra do construtor é idêntica: contextos em pool e construídos por fábrica também exigem o parâmetro genérico `DbContextOptions<TContext>`. Se você está trocando o contexto em testes através da fábrica em pool, veja [como remover uma fábrica de DbContext em pool para uma troca em testes no EF Core 11](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## Confirmando a fiação em dez segundos

Quando o registro parece correto mas o erro persiste, prove isso a partir de um escopo em vez de adivinhar:

```csharp
// .NET 11 - remove before commit
using (var scope = app.Services.CreateScope())
{
    var options = scope.ServiceProvider.GetService<DbContextOptions<AppDbContext>>();
    Console.WriteLine(options is null ? "OPTIONS NOT REGISTERED" : "options OK");

    var ctx = scope.ServiceProvider.GetService<AppDbContext>();
    Console.WriteLine(ctx is null ? "CONTEXT NOT REGISTERED" : ctx.GetType().FullName);
}
```

Se a linha das opções imprimir `OPTIONS NOT REGISTERED`, `AddDbContext` nunca rodou neste provedor, e você está na Correção um. Se as opções resolverem mas o contexto não, o parâmetro do construtor está errado, e você está na Correção dois. Você também pode ligar a validação em tempo de build para que o host se recuse a iniciar com um grafo quebrado em vez de falhar na primeira requisição:

```csharp
// .NET 11
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;
    o.ValidateOnBuild = true;
});
```

`ValidateOnBuild` percorre cada registro uma vez e falha rápido, o que transforma um 500 em tempo de execução em um erro de inicialização que você não tem como perder. Combine o construtor genérico com `AddDbContext` antes de `Build`, e o erro de `DbContextOptions` não volta. Para os padrões por trás de testes unitários que constroem contextos sem DI nenhuma, a peça complementar sobre [como mockar DbContext sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) cobre os trade-offs.

## Fontes

- Microsoft Learn, [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), incluindo a seção `DbContextOptions` versus `DbContextOptions<TContext>`.
- Microsoft Learn, [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation) e `IDesignTimeDbContextFactory<TContext>`.
- Código-fonte do EF Core, [`EntityFrameworkServiceCollectionExtensions.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Extensions/EntityFrameworkServiceCollectionExtensions.cs), onde `AddCoreServices` registra as opções genéricas e não genéricas.
- Issue dotnet/efcore [#32936](https://github.com/dotnet/efcore/issues/32936) sobre o erro de ativação em tempo de design e a correção com fábrica.
