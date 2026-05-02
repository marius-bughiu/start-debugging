---
title: "Como detectar consultas N+1 no EF Core 11"
description: "Um guia prático para identificar consultas N+1 no EF Core 11: como o padrão aparece em código real, como expô-lo via logs, interceptadores de diagnóstico, OpenTelemetry e um teste que quebra o build quando um caminho crítico regride."
pubDate: 2026-05-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-02
---

Resposta curta: ative o `LogTo` do EF Core 11 com a categoria `Microsoft.EntityFrameworkCore.Database.Command` no nível `Information` e execute o endpoint suspeito uma única vez. Se você ver o mesmo `SELECT` com um valor de parâmetro diferente disparando 50 vezes seguidas em vez de um único `JOIN`, você tem um N+1. A correção duradoura não é apenas adicionar `Include`, é montar um `DbCommandInterceptor` que conta os comandos por requisição e um teste unitário que afirma um limite superior de comandos por operação lógica, para que a regressão não possa voltar silenciosamente.

Este post cobre como o N+1 ainda aparece no EF Core 11 (lazy loading, acesso a navegação oculto em projeções e split queries mal aplicadas), três camadas de detecção (logs, interceptadores e OpenTelemetry) e como bloqueá-lo no CI com um teste que falha quando um endpoint excede seu orçamento de consultas. Todos os exemplos estão em .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) e SQL Server, mas tudo, exceto os nomes de eventos específicos do provedor, se aplica de forma idêntica ao PostgreSQL e ao SQLite.

## Como um N+1 realmente se parece no EF Core 11

A definição de manual é "uma consulta para carregar N linhas pai e, em seguida, uma consulta extra por pai para carregar uma coleção ou referência relacionada, totalizando N+1 idas e voltas." Em uma base de código real com EF Core 11, o gatilho raramente é um `foreach` explícito sobre `Include`. As quatro formas que vejo com mais frequência são:

1. **Lazy loading ainda ativo**: alguém adicionou `UseLazyLoadingProxies()` anos atrás, a base de código cresceu, e uma página Razor agora itera 200 pedidos e acessa `order.Customer.Name`. Cada acesso dispara uma consulta separada.
2. **Projeção que chama um método**: `Select(o => new OrderDto(o.Id, FormatCustomer(o.Customer)))` onde `FormatCustomer` não pode ser traduzido para SQL, então o EF Core cai em avaliação no lado do cliente e consulta `Customer` novamente por linha.
3. **`AsSplitQuery` na forma errada**: um `.Include(o => o.Lines).Include(o => o.Customer).AsSplitQuery()` divide corretamente um único join pai em várias idas e voltas, mas se você adicionar `.AsSplitQuery()` dentro de um `foreach` que já itera os pais, multiplica as idas e voltas.
4. **`IAsyncEnumerable` misturado com acesso a navegação**: transmitir um `IAsyncEnumerable<Order>` com [IAsyncEnumerable no EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) e então tocar em `order.Customer.Email` no consumidor. Cada passo de enumeração abre uma nova ida e volta se a navegação ainda não estiver carregada.

A razão pela qual todas as quatro são difíceis de identificar é que a API do `DbContext` nunca lança ou avisa por padrão. O plano de consulta está bom. O único sinal é a conversa no fio, que é invisível até você olhar.

## Uma reprodução concreta

Suba um modelo minúsculo e o exercite:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Agora escreva o pior loop possível:

```csharp
// Triggers N+1 if Customer is not eagerly loaded
var orders = await ctx.Orders.ToListAsync();
foreach (var order in orders)
{
    Console.WriteLine($"{order.Id}: {order.Customer?.Name}");
}
```

Sem lazy loading, `order.Customer` é `null` e você só vê um `SELECT` de `Orders`. Esse é um bug diferente, perda silenciosa de dados, mas não é N+1. Ative o lazy loading e o mesmo código se torna o antipadrão clássico:

```csharp
options.UseLazyLoadingProxies();
```

Agora você obtém um `SELECT` de `Orders` e, em seguida, um `SELECT * FROM Customers WHERE Id = @p0` por pedido. Com 1000 pedidos, são 1001 idas e voltas. A primeira coisa que você precisa é de uma maneira de vê-los.

## Camada 1: logs estruturados com LogTo e a categoria certa

O sinal de detecção mais rápido é o logger de comandos embutido do EF Core. O EF Core 11 expõe `LogTo` em `DbContextOptionsBuilder` e roteia eventos através de `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting`:

```csharp
services.AddDbContext<ShopContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.LogTo(
        Console.WriteLine,
        new[] { RelationalEventId.CommandExecuting },
        LogLevel.Information);
});
```

Execute o loop uma vez e o console se enche de cópias da mesma instrução parametrizada. Se estiver olhando para um aplicativo real, envie para o seu logger via `ILoggerFactory` em vez disso:

```csharp
var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
options.UseLoggerFactory(loggerFactory);
options.EnableSensitiveDataLogging(); // only in dev
```

A chave `EnableSensitiveDataLogging` é o que torna os valores dos parâmetros visíveis. Sem ela, você vê o SQL, mas não os valores, o que torna muito mais difícil identificar "100 destes são idênticos exceto por `@p0`". Mantenha-a desligada em produção: ela registra os parâmetros de consulta, que podem incluir PII ou segredos. A orientação oficial sobre isso está em [a documentação de logging do EF Core](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/).

Uma vez que você consegue ver a mangueira de incêndio, a regra de detecção manual é simples: para qualquer ação lógica única do usuário, o número de instruções SQL distintas deve ser limitado por uma constante pequena. Um endpoint de listagem não deveria escalar sua contagem de consultas com a contagem de linhas. Se escala, você encontrou um.

## Camada 2: um DbCommandInterceptor que conta consultas por escopo

O fluxo de "logar e usar grep" é bom para um único desenvolvedor, terrível para um time. A próxima camada é um interceptador que mantém um contador por requisição e permite que você afirme sobre ele. O EF Core 11 inclui [`DbCommandInterceptor`](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors), que é invocado para cada comando executado:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class CommandCounter
{
    private int _count;
    public int Count => _count;
    public void Increment() => Interlocked.Increment(ref _count);
    public void Reset() => Interlocked.Exchange(ref _count, 0);
}

public sealed class CountingInterceptor(CommandCounter counter) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        counter.Increment();
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        counter.Increment();
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}
```

Conecte o interceptador com escopo por requisição:

```csharp
services.AddScoped<CommandCounter>();
services.AddScoped<CountingInterceptor>();
services.AddDbContext<ShopContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(sp.GetRequiredService<CountingInterceptor>());
});
```

Agora qualquer caminho de código pode perguntar "quantos comandos SQL acabei de enviar?" em O(1). No ASP.NET Core 11, envolva isso em torno da requisição:

```csharp
app.Use(async (ctx, next) =>
{
    var counter = ctx.RequestServices.GetRequiredService<CommandCounter>();
    await next();
    if (counter.Count > 50)
    {
        var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
        logger.LogWarning(
            "{Path} executed {Count} SQL commands",
            ctx.Request.Path,
            counter.Count);
    }
});
```

Um aviso barulhento de "mais de 50 comandos por requisição" é suficiente para revelar todo infrator durante um teste de carga ou uma execução em sombra na produção. Também é a base do gate de CI mais adiante.

A razão pela qual isso funciona melhor que logs em produção é o volume. O logger de comandos no nível `Information` vai afogar um app real. Um contador é um único inteiro por requisição e uma única linha de log condicional sobre os infratores.

## Camada 3: OpenTelemetry, onde os dados já vivem

Se você já segue a configuração de [o guia de OpenTelemetry para .NET 11](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/), você não precisa de um contador separado de jeito nenhum. O pacote [`OpenTelemetry.Instrumentation.EntityFrameworkCore`](https://www.nuget.org/packages/OpenTelemetry.Instrumentation.EntityFrameworkCore) emite um span por comando executado com o SQL como `db.statement`:

```csharp
services.AddOpenTelemetry()
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o =>
        {
            o.SetDbStatementForText = true;
        })
        .AddOtlpExporter());
```

Em qualquer backend que agrupa spans filhos sob seu HTTP pai (painel do Aspire, Jaeger, Honeycomb, Grafana Tempo), um endpoint com N+1 aparece como um flame graph com uma única raiz HTTP e uma pilha de spans SQL com forma idêntica. O sinal visual é inconfundível: um bloco quadrado de spans filhos repetidos é N+1, sempre. Uma vez que você tem isso, na verdade não precisa da camada de log para a triagem do dia a dia.

Tenha cuidado com `SetDbStatementForText = true` em produção: ele envia o SQL renderizado para seu coletor, que pode incluir valores identificáveis das cláusulas `WHERE`. A maioria dos times o mantém ligado em não produção e o desliga (ou higieniza) em produção.

## Camada 4: um teste que quebra o build

A detecção em desenvolvimento e em produção é necessária, mas a única coisa que evita uma regressão lenta de volta a N+1 é um teste. O padrão usa o mesmo interceptador contador e um [teste de integração baseado em Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) batendo em um banco de dados real:

```csharp
// .NET 11, xUnit 2.9, EF Core 11.0.0, Testcontainers 4.11
[Fact]
public async Task Get_orders_endpoint_executes_at_most_two_commands()
{
    await using var factory = new ShopFactory(); // WebApplicationFactory<Program>
    var counter = factory.Services.GetRequiredService<CommandCounter>();
    counter.Reset();

    var client = factory.CreateClient();
    var response = await client.GetAsync("/orders?take=100");

    response.EnsureSuccessStatusCode();
    Assert.InRange(counter.Count, 1, 2);
}
```

O orçamento de "1 a 2" reflete a forma realista: um `SELECT` para `Orders`, opcionalmente um para `Customers` se você o incluir com `Include`. Se uma mudança futura transformar o `Include` em um lazy load, a contagem pula para 101 e o teste falha. O teste não precisa conhecer SQL nem se preocupar com o texto exato. Ele apenas aplica um contrato por endpoint.

Uma sutileza: o contador tem escopo, mas o `WebApplicationFactory` o resolve a partir do provider raiz em versões mais antigas do EF Core. No EF Core 11, o padrão seguro é expor o contador via um middleware por requisição que o guarda em `HttpContext.Items` e então lê-lo a partir de `factory.Services` apenas em testes onde você controla o ciclo de vida. Caso contrário, você corre o risco de ler um contador que pertence a uma requisição diferente.

## Por que `ConfigureWarnings` não é a história completa

O EF Core tem `ConfigureWarnings` desde a versão 3, e muitos guias dirão para você lançar exceção em `RelationalEventId.MultipleCollectionIncludeWarning` ou `CoreEventId.LazyLoadOnDisposedContextWarning`. Ambos são úteis, mas nenhum captura o N+1 diretamente. Eles capturam formas específicas:

- `MultipleCollectionIncludeWarning` dispara quando você faz `Include` de duas coleções irmãs em uma única consulta não dividida e avisa sobre uma explosão cartesiana. Esse é um problema diferente (uma consulta grande que retorna linhas demais) e a correção é `AsSplitQuery`, que pode se tornar N+1 se usado errado.
- `LazyLoadOnDisposedContextWarning` só dispara depois que o `DbContext` já foi descartado. Não captura o lazy load em contexto que produz o N+1 clássico.

Não há um único aviso que diga "você acabou de fazer a mesma consulta 100 vezes." É por isso que a abordagem do contador é fundamental: ela observa o comportamento, não a configuração.

## Padrões de correção depois que você detectou um

A detecção é metade do trabalho. Uma vez que o teste do contador falha, a correção geralmente se encaixa em uma destas formas:

- **Adicionar um `Include`**. A correção mais simples quando a navegação é sempre necessária.
- **Trocar para uma projeção**. `Select(o => new OrderListDto(o.Id, o.Customer.Name))` traduz para um único `JOIN` SQL e evita materializar o grafo completo.
- **Usar `AsSplitQuery`** quando o pai tem várias coleções grandes. Uma ida e volta por coleção ainda escala `O(1)` em pais.
- **Pré-carregar em massa**. Se você tem uma lista de chaves estrangeiras após a consulta pai, faça um único follow-up `WHERE Id IN (...)` em vez de uma busca por linha. A tradução de listas de parâmetros do EF Core 11 torna isso conciso.
- **Desligar o lazy loading completamente**. `UseLazyLoadingProxies` raramente vale a surpresa em tempo de execução. Análise estática e `Include` explícito encontram mais bugs no momento do PR do que às 3 da manhã.

Se você simula `DbContext` em testes unitários, nada disso aflora. Essa é mais uma razão para se apoiar em testes de integração contra um banco de dados real, o mesmo argumento feito em [o post sobre simular DbContext](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): mocks fazem o rastreador de mudanças se comportar, mas não conseguem reproduzir a conversa no fio que torna o N+1 visível.

## Onde olhar a seguir

Os padrões acima vão capturar mais de 95% dos N+1, mas duas ferramentas de nicho preenchem os cantos. O perfil `database` do `dotnet-trace` registra todo comando ADO.NET para revisão offline, o que é útil quando a regressão só se reproduz em um teste de carga (veja [o guia do dotnet-trace](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) para o fluxo). E o [`MiniProfiler`](https://miniprofiler.com/) ainda funciona bem como uma sobreposição de UI por requisição se você quer um selo voltado ao desenvolvedor que diz "esta página rodou 47 consultas SQL."

A coisa que todas elas compartilham é a mesma ideia: expor a atividade no fio cedo o suficiente para que o desenvolvedor que introduziu a regressão a veja antes do merge. O EF Core 11 torna isso mais fácil do que qualquer versão anterior, mas só se você optar por participar. O padrão é o silêncio.
