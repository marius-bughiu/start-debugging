---
title: "Como usar IDbContextFactory<T> a partir de um serviço singleton no Blazor"
description: "Um singleton não pode injetar um DbContext, mas pode injetar IDbContextFactory<T>, porque AddDbContextFactory registra a fábrica como singleton por padrão. Crie e descarte um contexto por chamada, nunca guarde a instância."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "ef-core"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-16
---

Um serviço singleton não pode receber um `DbContext` no construtor: `AddDbContext<T>` registra o contexto como scoped, e o validador de escopos do ASP.NET Core rejeita a captura já na inicialização. Ele pode receber `IDbContextFactory<T>`, porque `AddDbContextFactory<T>` registra a fábrica como **singleton** por padrão. Injete a fábrica, chame `CreateDbContextAsync` dentro de cada método, envolva em `await using` e nunca guarde o contexto retornado em um campo. Essa última regra é o que realmente importa: um singleton no Blazor é compartilhado por todos os circuitos do servidor, então um contexto em cache recebe chamadas de vários usuários ao mesmo tempo e o EF Core corrompe o estado ou lança exceção.

Este guia foi escrito para .NET 11 e EF Core 11. Tudo aqui vale igualmente para .NET 6, 8 e 10, porque `IDbContextFactory<T>` mantém a mesma forma de registro desde o EF Core 5.0. Os despejos de registro e as mensagens de erro abaixo foram produzidos com o SDK .NET 10.0.201 e `Microsoft.EntityFrameworkCore.Sqlite` 10.0.11, que era o runtime instalado quando escrevi isto.

## Por que um singleton do Blazor é o caso mais hostil para DbContext

O Blazor do lado do servidor mantém um *circuito* por usuário conectado. Esse circuito é um único escopo de DI de vida longa, que dura tanto quanto a aba do navegador, e não tanto quanto uma requisição HTTP. A própria orientação da Microsoft sobre EF Core com Blazor aponta que os três tempos de vida padrão são inadequados para um `DbContext`: singleton compartilha uma instância entre todos os usuários, scoped compartilha uma instância entre todos os componentes do circuito de um mesmo usuário, e transient produz contextos que vivem tanto quanto o componente que os segura.

O singleton é o pior dos três, e é fácil acabar com um sem querer. Um cache de catálogo, um serviço de tabelas de consulta, um `IHostedService` que atualiza dados de referência, um `IEmailSender` que grava uma linha de auditoria: todos são singletons por natureza, todos querem acesso ao banco de dados, e nenhum deles pode segurar um `DbContext`.

A validação de escopos pega a versão ingênua logo na inicialização. Registrar o contexto normalmente e injetá-lo em um singleton faz `BuildServiceProvider` falhar com `ValidateOnBuild`:

```text
Error while validating the service descriptor 'ServiceType: BadWarmer Lifetime: Singleton
ImplementationType: BadWarmer': Cannot consume scoped service 'AppDb' from singleton 'BadWarmer'.
```

Essa é a mesma verificação de dependência cativa que produz o [erro de não conseguir consumir um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) em aplicações ASP.NET Core comuns. A fábrica é a saída oficial.

## O que AddDbContextFactory realmente registra

A razão pela qual um singleton consegue injetar a fábrica não é convenção, é o padrão declarado. A assinatura é:

```csharp
// EF Core 11, Microsoft.Extensions.DependencyInjection
public static IServiceCollection AddDbContextFactory<TContext>(
    this IServiceCollection serviceCollection,
    Action<DbContextOptionsBuilder>? optionsAction = null,
    ServiceLifetime lifetime = ServiceLifetime.Singleton)
    where TContext : DbContext;
```

`lifetime` tem `ServiceLifetime.Singleton` como padrão, e controla "o tempo de vida com o qual a fábrica **e as opções** são registradas". Despejar os descritores de serviço que uma única chamada a `AddDbContextFactory<AppDb>` adiciona torna a forma concreta:

```text
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions
Singleton  Microsoft.EntityFrameworkCore.Internal.IDbContextFactorySource`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]
Scoped     AppDb
```

Vale notar duas coisas.

Primeiro, `IDbContextFactory<AppDb>` é singleton, então injetá-lo no seu próprio singleton passa pela validação de escopos sem problema. A implementação concreta resolvida é a `DbContextFactory<TContext>` embutida do EF Core.

Segundo, e isso surpreende: `AddDbContextFactory` **também registra o próprio tipo do contexto como scoped**. É comportamento documentado, não um vazamento. As notas da API dizem isso sem rodeios: "For convenience, this method also registers the context type itself as a scoped service. This allows a context instance to be resolved from a dependency injection scope directly or created by the factory, as appropriate." Ou seja, depois de uma chamada a `AddDbContextFactory`, `@inject AppDb Db` ainda compila e ainda funciona em um componente. No Blazor isso é uma armadilha, porque essa instância scoped pertence ao circuito e é compartilhada por todos os componentes da aba. Registrar a fábrica não impede ninguém de injetar o contexto do jeito errado.

## Como montar isso em quatro passos

1. Registre a fábrica em `Program.cs` e deixe o tempo de vida no padrão. Não passe `ServiceLifetime.Scoped`, que é a forma mais comum de quebrar isso.

   ```csharp
   // .NET 11, EF Core 11
   builder.Services.AddDbContextFactory<CatalogDb>(options =>
       options.UseSqlServer(builder.Configuration.GetConnectionString("Catalog")));

   builder.Services.AddSingleton<CatalogCache>();
   ```

2. Exponha no contexto o construtor com `DbContextOptions<TContext>`, exatamente como você faria para `AddDbContext`. A fábrica passa as opções por esse construtor, então um contexto que só tenha construtor sem parâmetros não poderá ser criado.

   ```csharp
   public sealed class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
   {
       public DbSet<Product> Products => Set<Product>();
   }
   ```

3. Injete `IDbContextFactory<TContext>` no singleton e crie um contexto por chamada de método. Use `CreateDbContextAsync` e `await using`, para que o descarte assíncrono siga o caminho próprio do provedor.

   ```csharp
   public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
   {
       public async Task<List<Product>> GetActiveAsync(CancellationToken ct = default)
       {
           await using var db = await factory.CreateDbContextAsync(ct);
           return await db.Products
               .AsNoTracking()
               .Where(p => p.IsActive)
               .ToListAsync(ct);
       }
   }
   ```

4. Ative a validação de escopos em todos os ambientes, para que uma refatoração futura que reintroduza um `DbContext` cativo falhe na inicialização, e não às 3 da manhã sob carga.

   ```csharp
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

Os contextos que a fábrica entrega **não** pertencem ao contêiner de DI. A documentação do EF Core é explícita ao dizer que as instâncias criadas assim "are not managed by the application's service provider and therefore must be disposed by the application". O `await using` do passo 3 não é gentileza opcional; sem ele você vaza conexões por toda a vida do processo.

## O que realmente quebra quando você guarda o contexto em cache

O atalho tentador é criar um contexto no construtor do singleton e reutilizá-lo. Parece inofensivo em desenvolvimento, onde você é o único usuário. Aqui está o mesmo `CatalogCache` segurando um único contexto, atingido por 25 chamadas concorrentes em threads reais:

```csharp
// Do not do this. One context, shared by every circuit on the server.
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    private readonly CatalogDb _shared = factory.CreateDbContext();

    public Task<int> CountAsync() => _shared.Products.CountAsync();
}
```

Rodar isso três vezes seguidas no EF Core 10.0.11 produziu três resultados diferentes, dois deles exceções distintas:

```text
run 1: InvalidOperationException: A second operation was started on this context instance
       before a previous operation completed. This is usually caused by different threads
       concurrently using the same instance of DbContext.
run 2: InvalidOperationException: ExecuteReader can only be called when the connection is open.
run 3: InvalidOperationException: A second operation was started on this context instance ...
```

Esse indeterminismo é justamente o ponto. O detector de segurança entre threads do EF Core produz a primeira mensagem, mais amigável, quando vence a corrida, mas nem sempre vence: a segunda execução trouxe à tona uma falha crua de estado de conexão do ADO.NET, porque duas operações já haviam se entrelaçado na mesma conexão. Com outro ritmo de execução, o mesmo defeito devolve dados errados em silêncio em vez de lançar qualquer coisa. Antes, durante meus testes, 25 tarefas que por acaso completaram de forma síncrona devolveram todas a resposta certa e não lançaram nada, que é exatamente por que esse defeito chega à produção.

Trocando para um contexto por chamada, as mesmas 25 chamadas concorrentes tiveram sucesso com resultados idênticos. Isso não é código esperto, é apenas a [regra de uma unidade de trabalho](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/) aplicada com honestidade.

O mesmo raciocínio explica por que capturar um contexto dentro de uma tarefa solta produz [ObjectDisposedException sobre uma instância de contexto já descartada](/pt-br/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/): os dois defeitos vêm de deixar um contexto sobreviver à operação que precisava dele.

## A sobrecarga que quebra o padrão sem avisar

`AddDbContextFactory` aceita um `lifetime` opcional. Passar `ServiceLifetime.Scoped` é um conselho muito copiado e colado, geralmente herdado de um exemplo multitenant onde a string de conexão é resolvida por requisição. Isso muda o registro da fábrica e reintroduz exatamente a dependência cativa que você queria evitar:

```csharp
// This compiles, then fails at startup once a singleton consumes the factory.
builder.Services.AddDbContextFactory<CatalogDb>(
    options => options.UseSqlServer(connectionString),
    lifetime: ServiceLifetime.Scoped);
```

```text
Error while validating the service descriptor 'ServiceType: CacheWarmer Lifetime: Singleton
ImplementationType: CacheWarmer': Cannot consume scoped service
'Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]' from singleton 'CacheWarmer'.
```

Se você realmente precisa de uma string de conexão por circuito, não torne a fábrica scoped para depois consumi-la de um singleton. Mantenha a fábrica singleton e passe o tenant explicitamente, ou resolva a fábrica específica do tenant via `IServiceScopeFactory` dentro do método. O que leva à limitação real de todo esse padrão.

## Um singleton não tem circuito, então não tem usuário

Essa é a restrição em que as pessoas esbarram em segundo lugar, depois de acertarem a ligação. Um singleton é criado uma vez para o servidor inteiro. Ele não tem `AuthenticationStateProvider`, nem resolvedor de tenant ligado ao circuito, nem `HttpContext`. Qualquer `DbContextOptions` calculado a partir do usuário do ambiente simplesmente não existe no momento em que seu singleton roda.

Concretamente, isto não funciona:

```csharp
// The singleton has no circuit, so there is no current user to read here.
builder.Services.AddDbContextFactory<CatalogDb>((sp, options) =>
    options.UseSqlServer(sp.GetRequiredService<ITenantContext>().ConnectionString));
```

Se os dados que seu singleton toca são de fato por usuário, o singleton é o lugar errado para eles. Ou você move o trabalho para um serviço scoped que o componente chama, ou passa a identidade do tenant como parâmetro do método e escolhe a string de conexão você mesmo:

```csharp
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    public async Task<int> CountForAsync(string tenantId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Products.CountAsync(p => p.TenantId == tenantId, ct);
    }
}
```

Dados de referência, tabelas de consulta e agregações entre tenants encaixam bem em um singleton com uma fábrica. Qualquer coisa atrelada ao "usuário atual" não encaixa. Se você está recorrendo a um singleton principalmente para evitar consultas repetidas, um cache é a primitiva melhor, e [HybridCache versus IMemoryCache e IDistributedCache](/pt-br/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) cobre como escolher um.

## Quando usar a fábrica com pool

`AddPooledDbContextFactory<TContext>` também registra um `IDbContextFactory<TContext>` singleton, apoiado por `PooledDbContextFactory<TContext>`, com um `poolSize` cujo padrão é 1024 no EF Core 6 e posteriores (era 128 no EF Core 5.0). Descartar um contexto do pool o reinicia e o devolve ao pool em vez de jogá-lo fora, o que reduz de forma mensurável as alocações em caminhos quentes.

Comportamento verificado no EF Core 10.0.11: criar um contexto, descartá-lo e criar outro devolve a **mesma** instância, e tocar no primeiro depois do descarte lança `ObjectDisposedException`. Ou seja, o pool realmente recicla, e o uso após descarte continua sendo detectado.

Duas ressalvas antes de trocar:

- As sobrecargas com pool não aceitam parâmetro `lifetime`, e `optionsAction` é obrigatório em vez de opcional. A configuração precisa ser feita externamente, porque `OnConfiguring` não é chamado de forma alguma em contextos do pool.
- Contextos do pool não podem receber serviços arbitrários injetados no construtor, já que a instância é reutilizada entre operações sem relação entre si. Qualquer estado que você guarde no contexto sobrevive até a próxima chamada, a menos que o EF Core o reinicie.

Para um singleton que faz leituras curtas e de alta frequência, a fábrica com pool é o padrão melhor. Para um singleton que trabalha ocasionalmente, a fábrica comum é mais simples e a diferença de alocação não vai aparecer em um profiler. Se o caminho quente são as consultas em si, e não a construção do contexto, [consultas compiladas para caminhos quentes do EF Core](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) são a alavanca maior.

## Modos de renderização, WebAssembly e serviços em segundo plano

Vale nomear três casos limite, porque eles mudam onde o singleton vive.

**Modos de renderização interactive WebAssembly e Auto.** Um singleton registrado no `Program.cs` do projeto de servidor existe só no servidor. Componentes que rodam no cliente têm seu próprio provedor de serviços no projeto WebAssembly, e um `DbContext` não consegue abrir conexão nenhuma com banco de dados a partir do sandbox do navegador. Se um componente passa de interactive server para interactive WebAssembly, o singleton do qual ele dependia deixa de ser resolvível no cliente, silenciosamente. Essa fronteira é a mesma que está por trás do [problema de estado entre a renderização estática e a interativa do Blazor](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

**SSR estático e prerenderização.** Durante a renderização estática do lado do servidor não há circuito, mas o provedor raiz da aplicação continua existindo, então um singleton com uma fábrica funciona normalmente. Esse é um dos poucos padrões de banco de dados que se comporta de forma idêntica em SSR estático, prerenderização e renderização interativa de servidor, o que é um argumento real a favor dele.

**BackgroundService.** `AddHostedService<T>` registra um singleton, então um serviço hospedado que precisa de dados tem exatamente o mesmo problema e exatamente a mesma solução. Injete `IDbContextFactory<T>` quando o trabalho for acesso puro a dados; recorra a `IServiceScopeFactory` quando a unidade de trabalho precisar de vários serviços scoped juntos, o que é coberto em [usar serviços scoped dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

O padrão é pequeno o bastante para caber em uma linha: singletons podem segurar fábricas, nunca contextos. Todo o resto deste artigo é consequência disso.

## Fontes

- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), documentação do EF Core, sobre `AddDbContextFactory` e o descarte de contextos não gerenciados.
- [ASP.NET Core Blazor with Entity Framework Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-ef-core), sobre circuitos e por que singleton, scoped e transient são todos inadequados para um `DbContext`.
- [EntityFrameworkServiceCollectionExtensions.AddDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), para o padrão `ServiceLifetime.Singleton` e o registro scoped do tipo do contexto.
- [EntityFrameworkServiceCollectionExtensions.AddPooledDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.addpooleddbcontextfactory), para o padrão de `poolSize` e a ressalva sobre `OnConfiguring`.
