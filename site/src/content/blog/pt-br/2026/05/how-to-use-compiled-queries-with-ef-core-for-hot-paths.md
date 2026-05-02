---
title: "Como usar consultas compiladas no EF Core em hot paths"
description: "Um guia prático sobre consultas compiladas no EF Core 11: quando EF.CompileAsyncQuery realmente vence, o padrão de campo estático, as armadilhas com Include e tracking, e como medir antes e depois para provar que valeu a pena a cerimônia extra."
pubDate: 2026-05-02
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths"
translatedBy: "claude"
translationDate: 2026-05-02
---

Resposta curta: declare a consulta uma vez como um campo `static readonly` via `EF.CompileAsyncQuery`, armazene o delegate resultante e invoque-o com um `DbContext` novo mais os parâmetros a cada chamada. Em um endpoint de leitura quente que executa o mesmo formato milhares de vezes por segundo, isso elimina a etapa de tradução de LINQ para SQL e reduz de 20 a 40% do overhead por chamada no EF Core 11. Fora de hot paths, não vale o boilerplate, porque o cache de consultas do EF Core já memoriza a tradução para consultas estruturalmente idênticas repetidas.

Este post cobre a mecânica exata de `EF.CompileQuery` e `EF.CompileAsyncQuery` no EF Core 11.0.x sobre .NET 11, o padrão de campo estático que torna o ganho real, o que consultas compiladas não conseguem fazer (sem encadeamento de `Include` em runtime, sem composição no lado do cliente, sem retorno de IQueryable) e um harness de BenchmarkDotNet que você pode colar no seu repositório para verificar o ganho no seu próprio schema. Tudo abaixo usa `Microsoft.EntityFrameworkCore` 11.0.0 contra SQL Server, mas as mesmas APIs funcionam de forma idêntica no PostgreSQL e no SQLite.

## O que "consulta compilada" realmente significa no EF Core 11

Quando você escreve `ctx.Orders.Where(o => o.CustomerId == id).ToListAsync()`, o EF Core faz aproximadamente cinco coisas a cada chamada:

1. Faz o parse da árvore de expressão LINQ.
2. Procura ela no cache interno de consultas (a chave do cache é o formato estrutural da árvore mais os tipos dos parâmetros).
3. Em um cache miss, traduz a árvore para SQL e constrói um delegate de shaper.
4. Abre uma conexão, envia o SQL com parâmetros vinculados.
5. Materializa as linhas do resultado de volta em entidades.

A etapa 2 é rápida, mas não é gratuita. A busca no cache percorre a árvore de expressão para calcular uma chave de hash. Em uma consulta pequena, isso é questão de microssegundos. Em um endpoint quente atendendo 5000 requisições por segundo, esses microssegundos se acumulam. `EF.CompileAsyncQuery` permite pular completamente as etapas 1 a 3 em todas as chamadas após a primeira. Você entrega ao EF a árvore de expressão uma vez na inicialização, ele produz um delegate `Func`, e a partir daí toda invocação vai direto para a etapa 4. O custo por chamada cai para "construir um parâmetro, executar o shaper, devolver as linhas".

A orientação oficial está [na documentação avançada de desempenho do EF Core](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics). O número de destaque dos próprios benchmarks da equipe é uma redução de aproximadamente 30% no overhead por consulta, com a maior parte do ganho em consultas pequenas e executadas com frequência, onde a tradução é uma fração significativa do tempo total.

## O padrão de campo estático

A forma mais comum de usar `EF.CompileAsyncQuery` errado é chamá-lo dentro do método que executa a consulta. Isso recria o delegate a cada chamada, o que é estritamente pior do que não compilar nada. O padrão que funciona é colocá-lo em um campo estático:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetOrderById =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static readonly Func<ShopContext, int, IAsyncEnumerable<Order>> GetOrdersByCustomer =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int customerId) =>
                ctx.Orders
                    .AsNoTracking()
                    .Where(o => o.CustomerId == customerId)
                    .OrderByDescending(o => o.PlacedAt));
}
```

Duas coisas para notar. Primeiro, a lista de parâmetros é posicional e os tipos estão fixados: `int id` faz parte da assinatura do delegate. Você não pode passar uma `Expression<Func<Order, bool>>` arbitrária para ele depois, porque isso anularia todo o propósito. Segundo, o delegate é invocado com uma instância de `DbContext` por chamada:

```csharp
public sealed class OrderService(IDbContextFactory<ShopContext> factory)
{
    public async Task<Order?> Get(int id)
    {
        await using var ctx = await factory.CreateDbContextAsync();
        return await OrderQueries.GetOrderById(ctx, id);
    }
}
```

O padrão de factory importa aqui. Consultas compiladas são thread-safe entre contextos, mas o próprio `DbContext` não é. Se você compartilhar um contexto entre threads e executar consultas compiladas concorrentemente, vai obter as mesmas condições de corrida que obteria com qualquer outro uso concorrente do EF Core. Use [um pooled DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) para a instância por chamada. Se não usar, o custo de alocar e configurar um novo contexto por chamada vai ofuscar tudo o que você economizou ao compilar a consulta.

## Os dois sabores e quando cada um vence

O EF Core 11 traz dois métodos estáticos em `EF`:

- `EF.CompileQuery` retorna um `Func<,...>` síncrono. O tipo de retorno é `T`, `IEnumerable<T>` ou `IQueryable<T>` dependendo da lambda.
- `EF.CompileAsyncQuery` retorna ou `Task<T>` para operadores terminais de uma única linha (`First`, `FirstOrDefault`, `Single`, `Count`, `Any`, etc.) ou `IAsyncEnumerable<T>` para consultas em streaming.

Para cargas de servidor, a variante async é quase sempre o que você quer. A variante síncrona bloqueia a thread chamadora no round trip do banco, o que é aceitável em uma aplicação console ou em um cliente desktop, mas vai esfomear o thread pool em ASP.NET Core sob carga. A única exceção é uma migração na inicialização ou uma ferramenta de CLI onde você genuinamente quer bloquear.

Uma sutileza: `EF.CompileAsyncQuery` não aceita um parâmetro `CancellationToken` diretamente. O token é capturado pela maquinaria async ao redor. Se você precisa cancelar uma consulta compilada de longa duração, o padrão do [guia de cancelamento para tarefas longas](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) ainda se aplica: registre um `CancellationToken` no escopo da requisição e deixe o `DbCommand` honrá-lo via a conexão. Consultas compiladas propagam o token pelo mesmo caminho de `DbCommand.ExecuteReaderAsync` que uma consulta não compilada.

## Uma reprodução que mostra o ganho

Construa o menor modelo possível:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public DateTime PlacedAt { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Agora escreva duas implementações da mesma busca, uma compilada e outra não:

```csharp
// .NET 11, EF Core 11.0.0
public static class Bench
{
    public static readonly Func<ShopContext, int, Task<Order?>> Compiled =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static Task<Order?> NotCompiled(ShopContext ctx, int id) =>
        ctx.Orders
            .AsNoTracking()
            .FirstOrDefaultAsync(o => o.Id == id);
}
```

Coloque ambas no BenchmarkDotNet 0.14 com um SQL Server suportado por Testcontainers, o mesmo harness que você usaria do [guia de testes de integração com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/):

```csharp
// .NET 11, BenchmarkDotNet 0.14.0, Testcontainers 4.11
[MemoryDiagnoser]
public class CompiledQueryBench
{
    private IDbContextFactory<ShopContext> _factory = null!;

    [GlobalSetup]
    public async Task Setup()
    {
        // Initialise the container, run migrations, seed N rows.
        // Resolve the IDbContextFactory<ShopContext> from your service provider.
    }

    [Benchmark(Baseline = true)]
    public async Task<Order?> NotCompiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.NotCompiled(ctx, 42);
    }

    [Benchmark]
    public async Task<Order?> Compiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.Compiled(ctx, 42);
    }
}
```

Em um laptop de 2024 contra um container local de SQL Server 2025, a versão compilada chega cerca de 25% mais rápida em execuções aquecidas, com um perfil de alocação menor porque o pipeline de tradução LINQ não roda. O número exato depende fortemente da contagem de linhas e do formato das colunas, mas em uma busca de chave primária de uma única linha você pode esperar um ganho significativo.

O resultado interessante é o que acontece em uma consulta executada exatamente uma vez: não há ganho. A versão compilada faz o mesmo trabalho de tradução na primeira vez que você invoca o delegate. Se seu hot path é "formato diferente a cada chamada", consultas compiladas não são a ferramenta certa. Elas recompensam a repetição.

## O que consultas compiladas não conseguem fazer

Consultas compiladas são análise estática sobre uma árvore de expressão fixa. Isso significa que vários padrões comuns de LINQ ficam fora dos limites:

- **Sem `Include` condicional**. Você não pode fazer `query.Include(o => o.Customer).If(includeLines, q => q.Include(o => o.Lines))` dentro da lambda. O formato é fixado em tempo de compilação.
- **Sem retorno `IQueryable` para composição posterior**. Se você retornar `IAsyncEnumerable<Order>`, pode fazer `await foreach` sobre ele, mas não pode chamar `.Where(...)` no resultado e ter esse filtro executado no servidor. Ele roda no cliente, o que anula o ganho.
- **Sem captura de estado por closure**. A lambda passada para `EF.CompileAsyncQuery` precisa ser autocontida. Capturar uma variável local ou um campo de serviço do escopo externo lança em runtime: "An expression tree may not contain a closure-captured variable in a compiled query". A correção é adicionar o valor como parâmetro na assinatura do delegate.
- **Sem `Skip` e `Take` com valores tipados como `Expression`**. Eles precisam ser parâmetros `int` no delegate. O EF Core 8 adicionou suporte a paginação dirigida por parâmetros, o EF Core 11 mantém isso, mas você não pode passar uma `Expression<Func<int>>`.
- **Sem métodos avaliáveis no cliente**. Se seu `Where` chama `MyHelper.Format(x)`, o EF não consegue traduzir. Em uma consulta não compilada, você receberia um aviso em runtime. Em uma consulta compilada, você recebe uma exceção dura em tempo de compilação, o que é, na verdade, o melhor modo de falha.

As restrições são o trade-off que você faz para conseguir o ganho de velocidade. Se sua consulta real precisa de formato com ramificação, escreva uma consulta LINQ normal e deixe o cache de consultas do EF Core fazer o trabalho dele. O cache é bom. Apenas não é gratuito.

## Tracking, AsNoTracking e por que isso importa aqui

Quase todo exemplo neste post usa `AsNoTracking()`. Isso não é decorativo. Consultas compiladas em entidades rastreadas ainda passam pelo change tracker na materialização, o que adiciona de volta uma fatia do overhead que você acabou de remover. Para hot paths somente leitura, `AsNoTracking` é o padrão que você quer.

Se você realmente precisa de tracking (o usuário vai mutar a entidade e chamar `SaveChangesAsync`), a conta muda. O trabalho do change tracker domina o custo por chamada, e a fatia que você ganha com consultas compiladas é menor. Nesse caso, o ganho é mais como 5 a 10%, o que raramente vale o boilerplate.

Há um corolário no [guia de detecção de N+1](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): se você compilar uma consulta que usa `Include` para uma navegação, a explosão cartesiana fica fixada no SQL compilado. Você não pode aplicar `AsSplitQuery` oportunisticamente depois. Decida uma vez e escolha o formato que se encaixa no local de chamada.

## Aquecimento e a primeira invocação

O trabalho de compilação é adiado até a primeira chamada ao delegate, não até a atribuição ao campo estático. Se seu serviço tem uma meta estrita de latência P99 em cold starts, a primeira requisição que atingir um caminho de código com consulta compilada vai pagar o custo de tradução em cima do overhead normal de primeira requisição.

A correção mais limpa é aquecer tanto o modelo do EF Core quanto as consultas compiladas durante a inicialização da aplicação, a mesma ideia coberta no [guia de aquecimento do EF Core](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/):

```csharp
// .NET 11, ASP.NET Core 11
var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var factory = scope.ServiceProvider
        .GetRequiredService<IDbContextFactory<ShopContext>>();
    await using var ctx = await factory.CreateDbContextAsync();

    // Touch the model
    _ = ctx.Model;

    // Trigger compilation by invoking each hot-path delegate once
    _ = await OrderQueries.GetOrderById(ctx, 0);
}

await app.RunAsync();
```

A consulta contra `Id == 0` retorna `null`, mas força a tradução. Depois desse bloco, sua primeira requisição real bate no banco com o SQL já em cache no delegate.

## Quando pular consultas compiladas inteiramente

Há a tentação de compilar toda consulta na base de código. Resista. A própria orientação da equipe do EF Core diz para usar consultas compiladas "com parcimônia, apenas em situações onde micro-otimizações são realmente necessárias". As razões:

- O cache interno de consultas já memoriza traduções para consultas estruturalmente idênticas repetidas. Para a maioria das cargas de trabalho, a taxa de acerto do cache após o aquecimento é maior que 99%.
- Consultas compiladas adicionam uma segunda fonte de verdade para o formato da consulta (o campo estático mais o local de chamada), o que torna refatorar mais doloroso.
- Stack traces ficam menos úteis: uma exceção em uma consulta compilada aponta para o local de invocação do delegate, não para a expressão LINQ original.

A regra honesta de decisão é: meça primeiro. Rode o endpoint sob carga realista com [`dotnet-trace`](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) e veja quanto do tempo está na infraestrutura de consultas do EF Core. Se for um único dígito como porcentagem do tempo total da requisição, deixe quieto. Se você ver 20% ou mais em `RelationalQueryCompiler`, `QueryTranslationPostprocessor` ou `QueryCompilationContext`, isso é um candidato a consulta compilada.

## Dois padrões que se compõem bem

A consulta compilada é mais útil em laços apertados ou em processadores em segundo plano que martelam o mesmo formato:

```csharp
// .NET 11, EF Core 11.0.0 - a streaming export
public static readonly Func<ShopContext, DateTime, IAsyncEnumerable<Order>> OrdersSince =
    EF.CompileAsyncQuery(
        (ShopContext ctx, DateTime since) =>
            ctx.Orders
                .AsNoTracking()
                .Where(o => o.PlacedAt >= since)
                .OrderBy(o => o.PlacedAt));

await foreach (var order in OrdersSince(ctx, cutoff).WithCancellation(ct))
{
    await writer.WriteRowAsync(order, ct);
}
```

Combine isso com [`IAsyncEnumerable<T>` no EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) e você obtém uma exportação em streaming que não armazena o conjunto de resultados em buffer, não aloca uma lista e reusa o SQL compilado em cada lote. Para um job de exportação que roda à noite por milhões de linhas, essa combinação reduz mensuravelmente tanto a latência quanto a pressão de memória.

O outro padrão é o endpoint de busca de alta cardinalidade: uma busca de chave primária de uma única linha em uma API pública onde a taxa de requisições está nos milhares por segundo. Aí as economias por chamada multiplicam pelo volume de chamadas, e uma consulta compilada em um `FirstOrDefault` combinada com [response caching](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response) te dá a coisa mais próxima de uma leitura "gratuita" que o EF Core tem.

Para todo o resto, escreva a consulta em LINQ comum, conte com o cache de consultas e revisite apenas quando o profiler te disser que a etapa de tradução é o gargalo. Consultas compiladas são um bisturi, não uma marreta.
