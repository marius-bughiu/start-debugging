---
title: "Como aquecer o modelo do EF Core antes da primeira consulta"
description: "O EF Core constrói seu modelo conceitual de forma preguiçosa no primeiro acesso ao DbContext, o que faz a primeira consulta de um processo recém-iniciado ser várias centenas de milissegundos mais lenta do que qualquer consulta seguinte. Este guia cobre as três soluções reais no EF Core 11: um IHostedService de inicialização que toca Model e abre uma conexão, dotnet ef dbcontext optimize para entregar um modelo pré-compilado, e as armadilhas da chave de cache que reconstroem o modelo silenciosamente mesmo assim."
pubDate: 2026-04-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "performance"
  - "startup"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/how-to-warm-up-ef-core-model-before-the-first-query"
translatedBy: "claude"
translationDate: 2026-04-29
---

A primeira consulta através de um `DbContext` recém-criado é a mais lenta que sua aplicação vai rodar, e isso não tem nada a ver com o banco de dados. O EF Core não constrói seu modelo interno quando o host inicia. Ele espera até a primeira vez que algo lê `DbContext.Model`, executa uma consulta, chama `SaveChanges` ou apenas enumera um `DbSet`. Nesse ponto ele executa a pipeline inteira de convenções contra os seus tipos de entidade, o que em um modelo de 50 entidades com relacionamentos, índices e value converters pode levar de 200 a 500 ms. Contextos seguintes no mesmo processo recebem o modelo em cache em menos de 1 ms. Este guia mostra as três soluções que realmente movem o número no EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14): um aquecimento explícito na inicialização, um modelo pré-compilado produzido por `dotnet ef dbcontext optimize`, e as armadilhas da chave de cache do modelo que silenciosamente derrotam as duas anteriores.

## Por que a primeira consulta é lenta mesmo com o banco aquecido

`DbContext.Model` é uma instância de `IModel` construída pela pipeline de convenções. As convenções são dezenas de implementações de `IConvention` (descoberta de relacionamento, inferência de chave, detecção de owned types, nomeação de chave estrangeira, escolha de value converter, mapeamento de coluna JSON e por aí vai) que percorrem cada propriedade de cada tipo de entidade e cada navegação. A saída é um grafo de modelo imutável que o EF Core mantém pela vida do processo sob uma chave produzida por `IModelCacheKeyFactory`.

Em um registro padrão `AddDbContext<TContext>`, esse trabalho acontece preguiçosamente. A sequência de runtime na partida fria é assim:

1. O host inicia. `IServiceProvider` é construído. `TContext` fica registrado como scoped. Nada relacionado a modelo rodou ainda.
2. A primeira requisição HTTP chega. O container de DI resolve um `TContext`. Seu construtor guarda `DbContextOptions<TContext>` e retorna. Ainda não rodou nada relacionado a modelo.
3. Seu handler escreve `await db.Blogs.ToListAsync()`. O EF Core dereferencia `Set<Blog>()`, o que lê `Model`, o que dispara a pipeline de convenções. Aqui estão os 200 a 500 ms.
4. A consulta então é compilada (tradução LINQ para SQL, vinculação de parâmetros, cache do executor), o que adiciona mais 30 a 80 ms.
5. A consulta finalmente bate no banco.

Os passos 3 e 4 acontecem apenas uma vez por processo por tipo de `DbContext`. A quinta requisição pelo mesmo tipo de contexto vê os dois custos como zero. É por isso que "primeira requisição lenta, todas as seguintes rápidas" se reproduz tão limpinho e por que você não consegue se livrar disso com tuning de banco. O trabalho está no seu processo, não no fio.

Se você cronometrar duas consultas seguidas em um processo recém-iniciado, vai ver a assimetria diretamente:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
var sw = Stopwatch.StartNew();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"first:  {sw.ElapsedMilliseconds} ms");

sw.Restart();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"second: {sw.ElapsedMilliseconds} ms");
```

Em um modelo demo de 30 entidades apontando para SQL Server 2025 com EF Core 11.0.0 em um notebook quente, a primeira iteração imprime cerca de `380 ms` e a segunda cerca de `4 ms`. A construção do modelo domina. Se o mesmo código rodar contra um AWS Lambda frio onde o host sobe por invocação, esses 380 ms aterrissam direto na latência p99 visível ao usuário, que é exatamente a classe de problema coberta em [reduzir o tempo de partida fria de um AWS Lambda com .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Solução um: aquecer o modelo na inicialização com IHostedService

A solução mais barata move o custo de "primeira requisição" para "início do host" sem mexer em nenhum caminho de código de produção. Registre um `IHostedService` cujo único trabalho seja resolver um contexto, forçar a materialização do modelo e sair. O host bloqueia em `StartAsync` antes de abrir o socket de escuta, então quando o Kestrel aceita uma requisição a pipeline de convenções já rodou e o `IModel` em cache está sentado na instância de opções.

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class EfCoreWarmup(IServiceProvider sp, ILogger<EfCoreWarmup> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var scope = sp.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BloggingContext>();

        // Forces the conventions pipeline to run and the IModel to be cached.
        _ = db.Model;

        // Forces the relational connection-string parsing and the SqlClient pool
        // to allocate one physical connection. ADO.NET keeps it warm in the pool.
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();

        log.LogInformation("EF Core warm-up done in {Elapsed} ms", sw.ElapsedMilliseconds);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Conecte depois de `AddDbContext`:

```csharp
// Program.cs, .NET 11, ASP.NET Core 11
builder.Services.AddDbContext<BloggingContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddHostedService<EfCoreWarmup>();
```

Três coisas que isso acerta e que aquecimentos feitos à mão geralmente erram:

1. Coloca o contexto em escopo. `AddDbContext` registra `TContext` como scoped, então resolvê-lo a partir do provider raiz lança exceção. `CreateAsyncScope` é o padrão documentado.
2. Lê `db.Model`, não `db.Set<Blog>().FirstOrDefault()`. Ler `Model` dispara a pipeline de convenções sem compilar nenhuma consulta LINQ, o que mantém o aquecimento livre de idas e voltas ao banco que poderiam falhar porque o esquema ainda não está pronto (pense na ordenação `WaitFor` do Aspire, ou em migrações que rodam depois de o host subir).
3. Abre e fecha uma conexão para o pool do SqlClient se primar. O pool mantém conexões físicas ociosas por uma janela curta, então a primeira requisição real não paga setup de TCP e TLS por cima da construção do modelo.

Um registro de contexto em pool (`AddDbContextPool<TContext>`) precisa do mesmo aquecimento, só que resolvido a partir do pool. Qualquer um dos padrões funciona, mas se você também precisa mexer no registro para trocar modelos em testes, consulte [o swap do RemoveDbContext / pooled factory para testes no EF Core 11](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) para a forma suportada de fazer isso sem reconstruir o service provider inteiro.

Essa solução já basta para a maioria dos apps ASP.NET Core. O modelo ainda é construído em runtime, você só escondeu o custo na janela de inicialização do host, que normalmente é gratuita ou perto disso. A solução que de fato remove o custo está abaixo.

## Solução dois: entregar um modelo pré-compilado com dotnet ef dbcontext optimize

O EF Core 6 introduziu o recurso de modelo compilado, o EF Core 7 estabilizou, e o EF Core 11 corrigiu limitações suficientes para tornar isso o padrão certo para qualquer serviço que se importa com partida fria. A ideia: em vez de rodar a pipeline de convenções em runtime, rodar em build e emitir um `IModel` escrito à mão como C# gerado. Em runtime o contexto carrega direto o modelo pré-construído e pula as convenções por completo.

O comando da CLI é uma vez só:

```bash
# .NET 11 SDK, dotnet-ef 11.0.0
dotnet ef dbcontext optimize \
  --output-dir GeneratedModel \
  --namespace MyApp.Data.GeneratedModel \
  --context BloggingContext
```

Isso escreve uma pasta de arquivos como `BloggingContextModel.cs`, `BlogEntityType.cs`, `PostEntityType.cs`. Adicione a pasta ao controle de versão, aponte `UseModel` para o singleton gerado, e a construção do modelo em runtime desaparece:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<BloggingContext>(o => o
    .UseSqlServer(builder.Configuration.GetConnectionString("Db"))
    .UseModel(MyApp.Data.GeneratedModel.BloggingContextModel.Instance));
```

No mesmo modelo demo de 30 entidades, a primeira consulta cai de 380 ms para cerca de 18 ms depois dessa mudança. O custo restante é a tradução LINQ-para-SQL para o formato específico da consulta, que é por formato de consulta e que a segunda invocação da mesma consulta já cacheia. Se a consulta é a mesma que você roda em cada requisição, o cache de consultas do EF come o custo na iteração dois e a primeira requisição fica efetivamente tão rápida quanto o estado estável.

Três detalhes que mordem na primeira vez que você faz isso:

1. **Regere quando o modelo mudar.** O modelo otimizado é uma foto. Adicionar uma propriedade, um índice ou uma regra do `OnModelCreating` e enviar sem rerodar `dotnet ef dbcontext optimize` produz uma incompatibilidade em runtime que o EF Core detecta e lança. Pendure o comando no build (`<Target Name="OptimizeEfModel" BeforeTargets="BeforeBuild">`) ou no mesmo passo que roda migrações, para que não dê para sair do sincronismo.
2. **A flag `--precompile-queries` existe no preview do EF Core 11.** Ela estende a otimização para a camada LINQ-para-SQL para consultas conhecidas. Em `Microsoft.EntityFrameworkCore.Tools` 11.0.0 ela está documentada como preview e emite atributos que você pode ler na [documentação oficial de consultas pré-compiladas](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries). Use para apps amarrados a AOT onde reflexão é restrita, ou para caminhos quentes onde os 30 a 80 ms marginais ainda importam.
3. **Um modelo pré-compilado é obrigatório para Native AOT.** `OnModelCreating` roda caminhos de reflexão que o trimmer do AOT não consegue analisar estaticamente, então sem um modelo pré-compilado o app publicado quebra na primeira vez que toca `DbContext`. Se você também está olhando AOT para o resto do host, as mesmas restrições de [usar Native AOT com APIs mínimas do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) se aplicam ao EF Core.

Para um serviço que já roda `dotnet ef migrations` no CI, adicionar `dotnet ef dbcontext optimize` ao mesmo passo são duas linhas de YAML e se paga em toda partida fria para sempre.

## A armadilha da chave de cache do modelo que derrota as duas soluções

Existe uma categoria de bug em que o aquecimento roda limpo, o modelo pré-compilado carrega limpo, e a primeira consulta visível ao usuário *ainda* é lenta. A causa quase sempre é `IModelCacheKeyFactory`. O EF Core cacheia o `IModel` materializado em um dicionário estático com chave em um objeto que o factory retorna. O factory padrão retorna uma chave que é só o tipo do contexto. Se o seu `OnModelCreating` consulta estado de runtime (um id de tenant, uma cultura, uma feature flag), o modelo precisa ser cacheado separadamente por valor desse estado, e você tem que dizer isso ao EF Core substituindo o factory.

```csharp
// .NET 11, EF Core 11.0.0
public sealed class TenantBloggingContext(
    DbContextOptions<TenantBloggingContext> options,
    ITenantProvider tenant) : DbContext(options)
{
    public string Tenant { get; } = tenant.CurrentTenant;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Blog>().ToTable($"Blogs_{Tenant}");
    }
}

public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is TenantBloggingContext t ? (context.GetType(), t.Tenant, designTime) : context.GetType();
}
```

Registre a substituição nas opções:

```csharp
builder.Services.AddDbContext<TenantBloggingContext>(o => o
    .UseSqlServer(connStr)
    .ReplaceService<IModelCacheKeyFactory, TenantModelCacheKeyFactory>());
```

Duas coisas dão errado aqui sem a solução de aquecimento:

- A primeira requisição para o tenant `acme` reconstrói o modelo na chave de cache `(TenantBloggingContext, "acme", false)`. A primeira requisição para o tenant `globex` reconstrói de novo em `(TenantBloggingContext, "globex", false)`. Toda chave de cache distinta bate na pipeline de convenções uma vez. Um aquecimento ingênuo que só resolve um tenant só aquece um de N caches.
- Um factory de chave de cache que captura mais estado do que o necessário (por exemplo, o snapshot inteiro de `IConfiguration`) fragmenta o cache. Se você descobrir que o modelo é reconstruído a cada requisição, logue o valor de retorno de `IModelCacheKeyFactory.Create` e veja se ele é instável.

A solução de aquecimento do começo continua valendo, você só precisa iterá-la sobre as dimensões da chave de cache que importam: no hosted service, resolva um contexto por tenant conhecido antes de declarar a inicialização concluída. Se o conjunto de tenants é ilimitado (subdomínios por cliente em um SaaS multi-tenant) a solução do modelo pré-compilado também não te salva, porque `dotnet ef dbcontext optimize` produz um snapshot, não uma família por tenant. Nesse caso, aceite o custo do primeiro hit por tenant e em vez disso limite-o com um `UseQuerySplittingBehavior` mais estrito e com as pequenas melhorias de consulta relacionais cobertas em [como o EF Core 11 poda joins de referência em split queries](/pt-br/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/).

## Uma ordem pragmática de operações

Se você veio por "o que devo fazer, em que ordem", esta é a sequência que rodo em um serviço real:

1. Meça. Cronometre as três primeiras consultas em um processo recém-iniciado. Se a primeira consulta está abaixo de 50 ms, não faça nada.
2. Adicione o `IHostedService` `EfCoreWarmup`. São 30 linhas de código e converte um visível-para-o-usuário de 300 ms em um 300 ms na inicialização do host.
3. Se o tempo de inicialização em si importa (Lambda, Cloud Run, autoscaler), rode `dotnet ef dbcontext optimize` e `UseModel(...)`. Adicione o comando ao CI.
4. Se você tem um `IModelCacheKeyFactory` customizado, audite o que ele captura. Garanta que o conjunto de chaves seja enumerável e aqueça cada entrada. Se for ilimitado, aceite o custo por chave e pare de brigar com isso.
5. Se a segunda consulta também é lenta, o custo está na tradução LINQ, não na construção do modelo. Investigue `DbContextOptionsBuilder.EnableSensitiveDataLogging` mais `LogTo` filtrado para `RelationalEventId.QueryExecuting`, ou pré-compile a consulta.

Esse é o mesmo formato de aquecer qualquer cache: descubra onde mora o custo, mova-o para mais cedo, e verifique a movimentação com um cronômetro.

## Relacionado

- [Como mockar DbContext sem quebrar o change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Como usar IAsyncEnumerable com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Como reduzir o tempo de partida fria de um AWS Lambda com .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [EF Core 11: RemoveDbContext e o swap de pooled factory para testes](/pt-br/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [EF Core 11 preview 3 poda joins de referência em split queries](/pt-br/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/)

## Fontes

- [Modelos compilados do EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models) - Microsoft Learn
- [Tópicos avançados de performance do EF Core: consultas compiladas](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) - Microsoft Learn
- [Referência de `dotnet ef dbcontext optimize`](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-dbcontext-optimize) - Microsoft Learn
- [Referência da API `IModelCacheKeyFactory`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.imodelcachekeyfactory) - Microsoft Learn
- [Estratégias de teste do EF Core](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) - Microsoft Learn
