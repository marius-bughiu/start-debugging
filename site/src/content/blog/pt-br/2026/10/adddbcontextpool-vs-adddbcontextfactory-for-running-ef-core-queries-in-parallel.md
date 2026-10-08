---
title: "AddDbContextPool vs AddDbContextFactory para executar consultas do EF Core em paralelo"
description: "AddDbContextPool entrega um DbContext com escopo por escopo de DI, então não consegue executar duas consultas ao mesmo tempo. AddDbContextFactory e AddPooledDbContextFactory entregam um contexto por chamada, que é o que consultas em paralelo exigem. Medido no EF Core 11 RC 1: a factory com pool cria um contexto em 342 ns e 40 B contra 17 us e 44 KB."
pubDate: 2026-10-08
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/10/adddbcontextpool-vs-adddbcontextfactory-for-running-ef-core-queries-in-parallel"
translatedBy: "claude"
translationDate: 2026-10-08
---

Se você quer executar consultas do EF Core em paralelo, `AddDbContextPool` sozinho é a ferramenta errada: ele registra seu `DbContext` como um serviço com escopo, então tudo em uma requisição (um escopo de DI) compartilha uma única instância, e um único `DbContext` não consegue executar duas operações ao mesmo tempo. `AddDbContextFactory` registra um `IDbContextFactory<T>` singleton que entrega um contexto novo a cada chamada, que é exatamente o formato que `Task.WhenAll` precisa. Se você quer os dois, registre `AddPooledDbContextFactory`: é a mesma API de factory apoiada pelo mesmo pool que `AddDbContextPool` usa, então cada ramo paralelo pega emprestada a sua própria instância reciclada.

Tudo abaixo foi medido no EF Core 11.0.0-rc.1.26425.128 com o SDK 11.0.100-rc.1.26425.128 e `Microsoft.EntityFrameworkCore.Sqlite` em um Apple M4. Executei o mesmo harness no EF Core 10.0.12 com .NET 10.0.10: os registros, o comportamento de reutilização e o tamanho do pool foram idênticos, e os tempos ficaram na mesma faixa (14,3 us e 43 KB por contexto sem pool, 357 ns e 40 B com pool).

## A comparação em resumo

| | `AddDbContextPool<T>` | `AddDbContextFactory<T>` | `AddPooledDbContextFactory<T>` |
| --- | --- | --- | --- |
| O que você injeta | `T` (com escopo) | `IDbContextFactory<T>` (singleton) | `IDbContextFactory<T>` (singleton) |
| Também registra `T` com escopo | Sim, é o serviço principal | Sim | Sim |
| Contextos por escopo de DI | 1 | Quantos você criar | Quantos você criar |
| Seguro para `Task.WhenAll` em uma requisição | Não | Sim | Sim |
| Instâncias reutilizadas após `Dispose` | Sim | Não | Sim |
| Custo de criar + descartar (medido) | n/d via escopo de DI | 17.250 ns, 44.888 B | 342 ns, 40 B |
| O construtor pode receber serviços com escopo | Não | Sim | Não |
| `OnConfiguring` executa | Uma vez por instância do pool | Em toda instância | Uma vez por instância do pool |
| Tamanho padrão do pool | 1024 | n/d | 1024 |

A linha "seguro em paralelo" é a que este post trata, e ela é decidida pelo tempo de vida, não pelo pool. O pool só decide quão caro é cada contexto.

## Por que um DbContext não consegue executar duas consultas ao mesmo tempo

Um `DbContext` possui um change tracker, uma conexão e, durante uma consulta, um data reader aberto. Nenhum deles é thread-safe, e o EF Core não tenta torná-los. Em vez disso, ele tem um detector de concorrência que lança uma exceção assim que uma segunda operação começa enquanto a primeira ainda está em execução. Cobri essa exceção em profundidade no [post sobre "A second operation was started on this context instance"](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/), mas a versão curta importa aqui: paralelismo no EF Core sempre significa um contexto por operação concorrente.

É aí que `AddDbContextPool` pega as pessoas. Ele soa como se devesse ajudar com concorrência ("um pool de contextos"), mas o pool é compartilhado entre escopos, não dentro de um. Veja o que o contêiner realmente contém após cada chamada, extraído de um `ServiceCollection` do EF Core 11 RC 1:

```text
--- AddDbContextPool
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Scoped    IScopedDbContextLease<AppDb>
  Scoped    AppDb
--- AddDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextFactorySource<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
--- AddPooledDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
```

Com `AddDbContextPool`, `AppDb` tem escopo e é emprestado do pool por meio de `IScopedDbContextLease<AppDb>`. Resolva-o duas vezes no mesmo escopo e você obtém o mesmo objeto. Não existe nenhum `IDbContextFactory<AppDb>` no contêiner, então você também não consegue pedir um segundo contexto.

## A consulta paralela que falha com AddDbContextPool

Este é o repro mínimo. Um controller ou endpoint de minimal API recebe o contexto com escopo e tenta fazer o fan-out:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextPool<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (AppDb db) =>
{
    // Both queries use the same pooled instance: this throws.
    var ordersTask = db.Orders.CountAsync();
    var customersTask = db.Customers.CountAsync();
    await Task.WhenAll(ordersTask, customersTask);
    return new { Orders = ordersTask.Result, Customers = customersTask.Result };
});
```

Contra SQL Server ou PostgreSQL, onde as chamadas assíncronas realmente cedem o controle enquanto esperam pela rede, a segunda consulta começa antes de a primeira terminar e o EF Core lança:

```text
InvalidOperationException: A second operation was started on this context instance
before a previous operation completed. This is usually caused by different threads
concurrently using the same instance of DbContext.
```

Dois detalhes dos testes. Primeiro, os métodos assíncronos do SQLite completam de forma síncrona, então a versão ingênua acima não se sobrepõe no SQLite e "funciona", o que faz de uma suíte de testes baseada em SQLite um detector ruim para esse bug. Tive de envolver as duas consultas em `Task.Run` para que se sobrepusessem. Segundo, se a corrida acontece no primeiríssimo uso de um contexto novo, você recebe uma mensagem diferente, "An attempt was made to use the context instance while it is being configured", porque as duas threads tentam inicializar o contexto ao mesmo tempo. Mesmo bug, mesma correção.

## Fan-out com AddDbContextFactory

A versão com factory dá a cada ramo a sua própria instância:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (IDbContextFactory<AppDb> factory, CancellationToken ct) =>
{
    async Task<int> CountOrders()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Orders.CountAsync(ct);
    }

    async Task<int> CountCustomers()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Customers.CountAsync(ct);
    }

    var orders = CountOrders();
    var customers = CountCustomers();
    await Task.WhenAll(orders, customers);
    return new { Orders = orders.Result, Customers = customers.Result };
});
```

Cada função local cria um contexto, executa uma consulta e o descarta. Nada é compartilhado, então não há nada para disputar. No meu harness de testes, o mesmo formato com quatro ramos (`Task.WhenAll` sobre quatro chamadas `CountAsync`, uma por região) retornou `250,250,250,250` em toda execução.

Repare que `AddDbContextFactory` também registrou `AppDb` com escopo. O código existente que injeta `AppDb` diretamente continua funcionando, então você pode trocar o registro sem mexer em todo construtor da aplicação, e só os endpoints que fazem fan-out precisam receber a factory.

## AddPooledDbContextFactory: os dois ao mesmo tempo

`AddDbContextFactory` cria um contexto totalmente novo a cada chamada de `CreateDbContext`. Esse custo normalmente é pequeno perto de uma ida e volta ao banco de dados, mas em um endpoint quente que faz fan-out para cinco ou dez consultas ele se acumula. `AddPooledDbContextFactory` mantém o formato de factory e pega instâncias emprestadas de um pool:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddPooledDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

O código chamador é idêntico ao da seção anterior, porque você continua injetando `IDbContextFactory<AppDb>`. A implementação por trás é `PooledDbContextFactory<AppDb>` em vez de `DbContextFactory<AppDb>`, e `Dispose` devolve a instância ao pool em vez de jogá-la fora. Verifiquei isso diretamente: crie um contexto, descarte, crie outro, e `ReferenceEquals` retorna `true` com a factory com pool e `false` com a simples.

Veja o que isso rende, medido com um loop simples (200.000 iterações para criar/descartar, 20.000 para criar/consultar/descartar, com aquecimento, uma única thread, `GC.GetAllocatedBytesForCurrentThread` para as alocações):

| Operação | `AddDbContextFactory` | `AddPooledDbContextFactory` |
| --- | --- | --- |
| `CreateDbContext` + tocar em `Model` + `Dispose` | 17.250 ns, 44.888 B | 342 ns, 40 B |
| Criar + `FirstOrDefault` por chave (SQLite, sem tracking) + `Dispose` | 49,7 us, 62.461 B | 20,0 us, 11.710 B |

Esses números são contra um arquivo SQLite local, então a parte do banco de dados é quase de graça e a configuração do contexto domina. Contra um SQL Server real através de uma rede, o tempo da consulta vai engolir os 17 us, e é por isso que a documentação oficial descreve o pooling como algo para "high-performance scenarios". A diferença de alocação, porém, não diminui com a latência: 44 KB de lixo por contexto, vezes dez ramos paralelos, vezes a sua taxa de requisições, é pressão real sobre o GC. A [documentação de desempenho avançado do EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics) relata o mesmo padrão contra SQL Server: 50,38 KB alocados sem pool contra 4,63 KB com ele.

A mesma documentação também observa que resolver um contexto com pool por meio de DI "incurs a slight overhead" em comparação com chamar a factory com pool diretamente, então a factory é a mais rápida das duas opções com pool, mesmo quando você não precisa de paralelismo.

## Você pode registrar os dois e compartilhar um pool

Você não precisa escolher. Chamar `AddDbContextPool<AppDb>` e depois `AddPooledDbContextFactory<AppDb>` com as mesmas opções funciona, e os dois compartilham o mesmo `IDbContextPool<AppDb>`. Verifiquei pegando um contexto emprestado da factory, descartando-o e então resolvendo `AppDb` a partir de um novo escopo: era a mesma instância. Isso permite que a maior parte da aplicação injete `AppDb` como de costume, enquanto os poucos endpoints com fan-out injetam a factory, sem pagar por dois pools.

Se você está no EF Core 11, também existe uma sobrecarga sem parâmetros `AddPooledDbContextFactory<T>()` que lê a configuração do próprio `OnConfiguring` do contexto, que descrevi no [post do EF Core 11 Preview 3 sobre RemoveDbContext e a factory com pool](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## O pool não limita o paralelismo, o pool de conexões limita

O `poolSize` padrão é 1024 tanto para `AddDbContextPool` quanto para `AddPooledDbContextFactory`. Esse número é o máximo de instâncias que o pool mantém, não o máximo que você pode ter vivas. Quando defini `poolSize: 2` e peguei cinco contextos ao mesmo tempo, obtive cinco instâncias distintas. Depois de descartar os cinco e pegar cinco de novo, exatamente dois voltaram do primeiro lote. Em outras palavras, o excedente recorre à criação de contextos novos e os extras são simplesmente descartados na devolução. O pool nunca bloqueia.

O teto real para consultas paralelas é o pool de conexões do ADO.NET por baixo. O EF Core abre uma conexão logo antes de cada consulta e a fecha logo depois, e cada consulta concorrente precisa da sua própria conexão. `Microsoft.Data.SqlClient` usa `Max Pool Size=100` por padrão, e o Npgsql também usa 100. Faça fan-out de 20 consultas por requisição com 10 requisições concorrentes e você já está esperando por conexões, o que aparece como um timeout ao obter uma conexão do pool, e não como um erro do EF. Se você faz fan-out sobre uma lista de IDs, limite o grau de paralelismo com `Parallel.ForEachAsync` em vez de jogar tudo em `Task.WhenAll`; os trade-offs estão em [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/pt-br/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
await Parallel.ForEachAsync(regionIds,
    new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
    async (regionId, token) =>
    {
        await using var db = await factory.CreateDbContextAsync(token);
        totals[regionId] = await db.Orders
            .Where(o => o.RegionId == regionId)
            .SumAsync(o => o.Total, token);
    });
```

Aqui, `totals` deve ser um `ConcurrentDictionary<int, decimal>` ou um array com tamanho pré-definido, já que o corpo do loop executa de forma concorrente.

## Armadilhas que só afetam as variantes com pool

### Dependências do construtor com escopo são resolvidas a partir do provider raiz

Esta me surpreendeu. Um contexto com pool é criado uma vez e reutilizado entre escopos, então as dependências do seu construtor não podem vir do escopo da requisição. No EF Core 11 RC 1, um contexto com pool com um construtor como `TenantDb(DbContextOptions<TenantDb> options, Tenant tenant)`, onde `Tenant` tem escopo, se comporta assim:

- Com a validação de escopo ativada (o padrão no ambiente `Development`), resolvê-lo lança `InvalidOperationException: Cannot resolve scoped service 'Tenant' from root provider.`
- Com a validação de escopo desativada (o padrão em `Production`), ele tem sucesso silenciosamente. O contexto recebe uma instância de `Tenant` do provider raiz, que não corresponde ao `Tenant` que o escopo da requisição resolve, e a mesma instância capturada acompanha o contexto com pool em todas as requisições seguintes.

Então o bug que você nunca vê localmente vira um vazamento de dados entre tenants em produção. O `AddDbContextFactory` simples não tem esse problema porque constrói um contexto novo a cada vez. Se você precisa de estado por requisição com pooling, o padrão documentado é uma factory wrapper com escopo que pega emprestado da factory com pool e define uma propriedade:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public sealed class TenantDbFactory(
    IDbContextFactory<TenantDb> pooled, ITenant tenant) : IDbContextFactory<TenantDb>
{
    public TenantDb CreateDbContext()
    {
        var db = pooled.CreateDbContext();
        db.TenantId = tenant.Id; // reset on every rent, never trust the previous value
        return db;
    }
}

builder.Services.AddPooledDbContextFactory<TenantDb>(o => o.UseSqlServer(cs));
builder.Services.AddScoped<TenantDbFactory>();
```

A mesma armadilha de serviço com escopo dentro de singleton aparece fora do EF também; [o post sobre "Cannot consume scoped service from singleton"](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) explica por que o contêiner a recusa.

### Seus próprios campos não são redefinidos

O EF Core redefine o próprio estado quando um contexto com pool é devolvido: o change tracker é limpo (adicionei uma entidade, descartei, peguei de novo, e `ChangeTracker.Entries()` estava vazio). Campos e propriedades que você adicionou à sua subclasse de `DbContext` não são tocados. Um `public string? Note` que defini como `"dirty"` antes de descartar ainda era `"dirty"` no empréstimo seguinte. Tudo que for por requisição deve ser atribuído a cada empréstimo, como no wrapper acima. O mesmo vale para uma `DbConnection` que você abriu manualmente: feche-a antes de o contexto ser devolvido.

### OnConfiguring executa uma vez

Como a instância é reutilizada, `OnConfiguring` só executa na primeira vez que uma instância do pool é criada. Não leia o usuário atual, o tenant ou a cultura ali.

### Dispose é o que devolve a instância

Com a factory com pool, um contexto que você esquece de descartar nunca é devolvido. Não é um vazamento no sentido clássico, já que o GC ainda o coleta, mas você perde o benefício do pooling e o pool vai se enchendo silenciosamente de instâncias novas. Use sempre `await using`.

## Quando escolher cada um

- **Apenas consultas sequenciais, aplicação comum**: `AddDbContext` ou `AddDbContextPool`. Injete `AppDb`, aguarde cada consulta em sequência. O pooling é um ganho barato se o seu contexto não tem dependências no construtor nem estado por requisição.
- **Alguns endpoints fazem fan-out em paralelo**: registre `AddPooledDbContextFactory` (ou `AddDbContextPool` mais `AddPooledDbContextFactory` com as mesmas opções). Injete `AppDb` onde você trabalha de forma sequencial e `IDbContextFactory<AppDb>` onde faz fan-out.
- **O contexto precisa de serviços com escopo no construtor**: `AddDbContextFactory`, sem pool. Ou mova esse estado para uma propriedade definida por um wrapper com escopo e mantenha o pooling.
- **Singletons, hosted services, componentes do Blazor Server**: a factory, pelos motivos em [usar IDbContextFactory a partir de um singleton no Blazor](/pt-br/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/). Com pool se o contexto permitir.

Uma última alternativa se você já usa `AddDbContextPool` e não quer um segundo registro: crie um escopo filho por ramo paralelo com `IServiceScopeFactory.CreateAsyncScope()` e resolva `AppDb` a partir dele. Cada escopo empresta a sua própria instância do pool, e meu teste de quatro ramos retornou os mesmos `250,250,250,250`. Funciona, mas é mais cerimônia do que injetar a factory, e cada ramo também resolve todo o resto naquele escopo.

A regra prática: paralelismo exige um contexto por operação, e só as duas factories entregam isso diretamente. O pooling é uma decisão independente sobre quão barato é cada um desses contextos, e no EF Core 11 a factory com pool torna a criação de um cerca de 50 vezes mais barata, desde que o seu contexto não carregue estado por requisição no construtor.

## Fontes

- [Advanced Performance Topics: DbContext pooling (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [DbContext Lifetime, Configuration, and Initialization: using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`EntityFrameworkServiceCollectionExtensions` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions)
- [Sample: AspNetContextPoolingWithState (dotnet/EntityFramework.Docs)](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Performance/AspNetContextPoolingWithState)
- [SQL Server connection pooling (ADO.NET)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql-server-connection-pooling)
