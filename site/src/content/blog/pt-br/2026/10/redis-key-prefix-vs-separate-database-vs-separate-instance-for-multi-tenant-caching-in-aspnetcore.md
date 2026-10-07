---
title: "Prefixo de chave Redis vs banco de dados separado vs instância separada para cache multi-tenant no ASP.NET Core"
description: "Use um prefixo de tenant em um Redis compartilhado para quase todo app multi-tenant ASP.NET Core, mova para uma instância própria apenas os tenants com isolamento contratual ou cargas ruidosas, e evite bancos numerados: Redis Cluster, Azure Managed Redis e Redis Cloud só têm o banco 0."
pubDate: 2026-10-07
template: vs
tags:
  - "comparison"
  - "redis"
  - "aspnetcore"
  - "dotnet"
  - "caching"
  - "multi-tenancy"
lang: "pt-br"
translationOf: "2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-07
---

Para um app ASP.NET Core multi-tenant, coloque todos os tenants em um único Redis compartilhado e isole-os com um prefixo de chave como `t:{tenantId}:`. Isso funciona em qualquer topologia de Redis, se encaixa direto no `HybridCache` e no `IDistributedCache`, e o prefixo é algo de que você precisa de qualquer forma, porque o L1 em processo do `HybridCache` é compartilhado entre os tenants. Dê a um tenant sua própria instância de Redis apenas quando um contrato, uma fronteira de conformidade ou uma carga ruidosa exigir. Evite bancos de dados numerados (`SELECT 3`): Redis Cluster, Azure Managed Redis e Redis Cloud só suportam o banco 0, e o isolamento que oferecem é mais fraco do que parece.

Tudo abaixo foi verificado por compilação no .NET SDK 10.0.302 com alvo `net10.0`, usando `Microsoft.Extensions.Caching.StackExchangeRedis` 10.0.12, `Microsoft.Extensions.Caching.Hybrid` 10.10.0 e `StackExchange.Redis` 3.3.1. As mesmas APIs existem nos pacotes 11.0.0-rc.1 para .NET 11.

## As três opções lado a lado

| | Prefixo de chave, instância compartilhada | Banco numerado por tenant | Instância por tenant |
| --- | --- | --- | --- |
| Como o tenant é separado | `t:42:` na frente de toda chave | `SELECT 42` na conexão | Host e credenciais diferentes |
| Funciona em Redis Cluster / Azure Managed Redis / Redis Cloud | Sim | Não, apenas banco 0 | Sim |
| Máximo de tenants | Ilimitado | 16 por padrão (configuração `databases`) | Seu orçamento |
| Limite de memória e remoção (eviction) | Compartilhado | Compartilhado (`maxmemory` é por servidor) | Separado |
| Isolamento de CPU e latência | Nenhum | Nenhum | Total |
| Controle de acesso por tenant | Padrões de chave em ACL `~t:42:*` (Redis 7+) | Apenas Valkey 9.1+ (regra `db=`) | Credenciais separadas |
| Apagar um tenant | `SCAN` + `DEL`, ou tag do `HybridCache` | `FLUSHDB` | Excluir a instância |
| Funciona com um único `AddHybridCache()` | Sim | Precisa de um `IDistributedCache` de roteamento | Precisa de um `IDistributedCache` de roteamento |
| Conexões por instância do app | 1 multiplexer | 1 multiplexer por banco em uso | 1 multiplexer por tenant |
| Custo | Menor | Menor | Maior |

Bancos numerados parecem um meio-termo. Na prática, eles compartilham todos os limites que importam com a abordagem de prefixo e acrescentam restrições que o prefixo não tem.

## Por que bancos numerados são a armadilha

A própria [documentação do `SELECT`](https://redis.io/docs/latest/commands/select/) do Redis é direta: os bancos servem para separar chaves "dentro da mesma aplicação", não para executar cargas não relacionadas em um servidor. Em seguida acrescenta que "o Redis Cluster só suporta o banco zero". Essa única frase elimina boa parte do mercado gerenciado:

- O **Azure Managed Redis** é "configurado internamente para usar clustering, em todas as camadas e SKUs", segundo sua [página de arquitetura](https://learn.microsoft.com/en-us/azure/redis/architecture), e roda sobre o Redis Enterprise.
- **Redis Software e Redis Cloud** não suportam bancos compartilhados. A página do `SELECT` diz que o comando é "suportado apenas por compatibilidade" e não realiza nenhuma operação ali. Se o seu código depende de `SELECT` para isolamento e você migra para um desses, todos os tenants caem silenciosamente no mesmo keyspace. Esse é o pior modo de falha possível em multi-tenancy: nenhum erro, apenas dados vazando entre tenants.
- O **Redis OSS em modo cluster** (incluindo a maioria das ofertas gerenciadas em modo cluster) rejeita qualquer banco que não seja o 0.

A única exceção é o Valkey: o [Valkey 9.0](https://www.linuxfoundation.org/press/valkey-9.0-delivers-performance-and-resiliency-for-real-time-workloads) adicionou bancos numerados em modo cluster, e o [Valkey 9.1 adicionou regras de ACL `db=`](https://valkey.io/commands/acl-setuser/) para que um usuário possa ser restrito a bancos específicos. Se você roda Valkey 9.1+ e nunca pretende sair dele, os bancos se tornam defensáveis. Em qualquer outro lugar, escolher bancos amarra seu modelo de tenancy a uma única topologia de hospedagem.

Mesmo onde os bancos funcionam, eles não isolam o que os tenants realmente disputam. `maxmemory` e a política de remoção se aplicam ao servidor inteiro, então um tenant que enche seu banco remove chaves de todos os outros. O Redis executa comandos em uma única thread principal, então um tenant que roda um `KEYS *` lento trava todos os bancos. E com o padrão `databases 16`, os tenants acabam antes dos clientes.

O outro problema prático está do lado .NET. O `RedisCache`, a implementação de `IDistributedCache` por trás de `AddStackExchangeRedisCache`, chama `connection.GetDatabase()` sem argumento, como você pode ver em [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs). Ele sempre fala com o `DefaultDatabase` da conexão. Para alcançar o banco 7 você precisa de um `RedisCache` construído a partir de um `ConfigurationOptions` com `DefaultDatabase = 7`, o que significa um `ConnectionMultiplexer` separado para cada banco em uso, exatamente o overhead que o multiplexer compartilhado deveria evitar.

## A abordagem de prefixo de chave, bem feita

`RedisCacheOptions.InstanceName` é documentado como uma forma de particionar "um único cache de backend para uso com vários apps/serviços". É um prefixo de escopo do processo, então use-o para o nome do app e coloque o tenant em cada chave:

```csharp
// .NET 10, ASP.NET Core 10
// Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
// Microsoft.Extensions.Caching.Hybrid 10.10.0, StackExchange.Redis 3.3.1
using Microsoft.Extensions.Caching.Hybrid;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var mux = await ConnectionMultiplexer.ConnectAsync(
    builder.Configuration.GetConnectionString("redis")!);
builder.Services.AddSingleton<IConnectionMultiplexer>(mux);

builder.Services.AddStackExchangeRedisCache(o =>
{
    // share the multiplexer instead of opening a second connection
    o.ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(mux);
    o.InstanceName = "myapp:"; // note the trailing delimiter
});
builder.Services.AddHybridCache();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ITenantContext, ClaimTenantContext>();
builder.Services.AddScoped<TenantCache>();

var app = builder.Build();

app.MapGet("/products/{id:int}", async (int id, TenantCache cache) =>
    await cache.GetOrCreateAsync($"product:{id}",
        ct => ValueTask.FromResult($"product {id}")));

app.Run();
```

O tenant vem de uma fonte confiável, nunca de um header ou query string controlado pelo cliente. Aqui é uma claim do usuário autenticado:

```csharp
// .NET 10, C# 14
public interface ITenantContext { string TenantId { get; } }

public sealed class ClaimTenantContext(IHttpContextAccessor accessor) : ITenantContext
{
    public string TenantId =>
        accessor.HttpContext?.User.FindFirst("tenant_id")?.Value
        ?? throw new InvalidOperationException("No tenant on this request.");
}
```

O ponto importante é que o código da aplicação nunca monta uma chave de cache bruta. Ele passa por um wrapper com escopo que adiciona o tenant todas as vezes, de modo que um desenvolvedor não consiga esquecer:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Hybrid 10.10.0
public sealed class TenantCache(HybridCache cache, ITenantContext tenant)
{
    private string Key(string key) => $"t:{tenant.TenantId}:{key}";
    private string TenantTag => $"tenant:{tenant.TenantId}";

    public ValueTask<T> GetOrCreateAsync<T>(
        string key,
        Func<CancellationToken, ValueTask<T>> factory,
        HybridCacheEntryOptions? options = null,
        IEnumerable<string>? tags = null,
        CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            Key(key),
            factory,
            static (f, c) => f(c),
            options,
            [TenantTag, .. (tags ?? []).Select(t => $"{TenantTag}:{t}")],
            ct);

    public ValueTask RemoveAsync(string key, CancellationToken ct = default) =>
        cache.RemoveAsync(Key(key), ct);

    // logical wipe of everything this tenant cached
    public ValueTask InvalidateTenantAsync(CancellationToken ct = default) =>
        cache.RemoveByTagAsync(TenantTag, ct);
}
```

No Redis, a entrada de produto do tenant 42 termina como o hash `myapp:t:42:product:7`. As tags também recebem prefixo: as tags do `HybridCache` são strings globais, então um `RemoveByTagAsync("products")` sem prefixo vindo de um tenant invalidaria as entradas de produto de todos os tenants.

Se você usa `IDatabase` diretamente para contadores, locks ou sets, o StackExchange.Redis tem a mesma ideia embutida por meio de `StackExchange.Redis.KeyspaceIsolation`:

```csharp
// StackExchange.Redis 3.3.1
using StackExchange.Redis.KeyspaceIsolation;

IDatabase tenantDb = mux.GetDatabase().WithKeyPrefix($"myapp:t:{tenantId}:");
await tenantDb.StringIncrementAsync("logins"); // writes myapp:t:42:logins
```

## O problema do L1 que encerra o debate

Este é o detalhe que torna o prefixo obrigatório, qualquer que seja a opção escolhida. O `HybridCache` é um cache de dois níveis, e seu L1 é um `MemoryCache` em processo compartilhado por todas as requisições do processo. Suponha que você roteie o tenant 42 para sua própria instância de Redis e mantenha a chave de cache como `product:7`. A consulta ao L2 vai para o servidor certo, mas a consulta ao L1 acontece primeiro, e o `product:7` do tenant 41 já está na memória. O tenant 42 recebe o produto do tenant 41.

Portanto, bancos separados e instâncias separadas não eliminam a necessidade de chaves com escopo de tenant. Eles adicionam um segundo mecanismo de isolamento sobre o que você ainda precisa construir. Uma vez que o prefixo existe, a pergunta que resta é apenas se alguns tenants precisam de mais do que separação em nível de chave.

O mesmo vale para o output caching. `AddStackExchangeRedisOutputCache` tem seu próprio `InstanceName`, e a chave de cache precisa variar por tenant (`VaryByValue` na claim do tenant) independentemente de onde as entradas são armazenadas.

## Quando uma instância separada é a escolha certa

Um Redis separado por tenant não é o padrão, mas é uma camada legítima. Escolha-o quando:

- **Um contrato ou regulador exige.** Residência de dados em uma região específica, uma chave de criptografia gerenciada pelo cliente, ou "nenhuma infraestrutura compartilhada" em um contrato enterprise. Prefixos de chave não satisfazem um auditor que pede separação física.
- **A carga de um tenant é grande o bastante para prejudicar os outros.** Um tenant com 40 GB de dados quentes ou um job em lote com picos vai remover as chaves de todos os outros em um `maxmemory` compartilhado. Tirá-lo dali restaura taxas de acerto previsíveis para o resto.
- **Você precisa de política de remoção ou persistência por tenant.** As configurações `maxmemory-policy`, AOF e RDB valem para o servidor inteiro.
- **O offboarding do tenant precisa ser comprovadamente completo.** Excluir uma instância é mais fácil de comprovar do que "varremos e excluímos todas as chaves".

O formato usual é um modelo de pool com um silo premium: todos na instância compartilhada e com prefixo, e uma lista curta de tenants mapeada para instâncias dedicadas. Como o `AddHybridCache()` conecta exatamente um L2, o roteamento precisa viver em um `IDistributedCache` que escolhe o backend a cada chamada:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;

public sealed class TenantRoutingCache(
    IHttpContextAccessor accessor,
    IConfiguration config,
    [FromKeyedServices("shared")] IDistributedCache shared) : IDistributedCache
{
    private readonly ConcurrentDictionary<string, IDistributedCache> _dedicated = new();

    private IDistributedCache Current()
    {
        var tenant = accessor.HttpContext?.User.FindFirst("tenant_id")?.Value;
        var cs = tenant is null ? null : config[$"Tenants:{tenant}:Redis"];
        if (cs is null) return shared;

        return _dedicated.GetOrAdd(tenant!, _ => new RedisCache(
            new RedisCacheOptions { Configuration = cs, InstanceName = "myapp:" }));
    }

    public byte[]? Get(string key) => Current().Get(key);
    public Task<byte[]?> GetAsync(string key, CancellationToken token = default) =>
        Current().GetAsync(key, token);
    public void Set(string key, byte[] value, DistributedCacheEntryOptions options) =>
        Current().Set(key, value, options);
    public Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options,
        CancellationToken token = default) => Current().SetAsync(key, value, options, token);
    public void Refresh(string key) => Current().Refresh(key);
    public Task RefreshAsync(string key, CancellationToken token = default) =>
        Current().RefreshAsync(key, token);
    public void Remove(string key) => Current().Remove(key);
    public Task RemoveAsync(string key, CancellationToken token = default) =>
        Current().RemoveAsync(key, token);
}
```

Registre o `RedisCache` compartilhado como um serviço com chave (keyed service) e o roteador como o `IDistributedCache` sem chave que o `HybridCache` resolve. As chaves continuam carregando o prefixo de tenant vindo do `TenantCache`, o que mantém o L1 seguro. Duas coisas a saber sobre esse roteador: ele depende de `HttpContext`, então jobs em segundo plano precisam estabelecer o tenant de outra forma (um `AsyncLocal` definido pelo executor do job funciona), e ele ignora o caminho rápido `IBufferDistributedCache` do `RedisCache`, porque implementa apenas a interface base. Para um punhado de tenants premium, essa troca é aceitável.

Cada `RedisCache` dedicado possui um multiplexer. Um multiplexer foi projetado para ser compartilhado e de longa duração, então mantenha essas instâncias em cache durante toda a vida do processo e nunca as crie por requisição. Com 20 tenants dedicados e 10 pods do app, você mantém 200 conexões Redis extras, que é o ponto em que o modelo de instância por tenant deixa de escalar e o motivo pelo qual ele deve continuar sendo uma camada, não o padrão.

## Armadilhas dos prefixos de chave

**Sempre termine o prefixo com um delimitador.** O `RedisCache` concatena `InstanceName` e a chave sem separador. A [orientação sobre chaves do HybridCache](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) dá o exemplo clássico: `order{customerId}{orderId}` faz o cliente 42 com o pedido 123 e o cliente 421 com o pedido 23 virarem ambos `order42123`. A mesma coisa acontece com tenants: o tenant `7` mais a chave `42:profile` e o tenant `74` mais a chave `2:profile` colidem se você escrever `t{tenant}{key}`. Use `t:{tenant}:` e garanta que os ids de tenant não possam conter `:`.

**Apagar as chaves de um tenant é um scan, não um comando.** `RemoveByTagAsync($"tenant:{id}")` é a opção barata, mas é uma invalidação lógica: a documentação diz que os valores permanecem no Redis "até expirarem da forma usual". Quando você precisa remover dados fisicamente (offboarding, exclusão por LGPD/GDPR), faça scan em cada primário:

```csharp
// StackExchange.Redis 3.3.1
public static async Task<long> PurgeTenantAsync(IConnectionMultiplexer mux, string tenantId)
{
    var db = mux.GetDatabase();
    long deleted = 0;
    foreach (var endpoint in mux.GetEndPoints())
    {
        var server = mux.GetServer(endpoint);
        if (server.IsReplica) continue;

        await foreach (var key in server.KeysAsync(pattern: $"myapp:t:{tenantId}:*", pageSize: 500))
        {
            // one DEL per key: in a cluster, keys from one node can span many hash slots
            if (await db.KeyDeleteAsync(key)) deleted++;
        }
    }
    return deleted;
}
```

`KeysAsync` usa `SCAN` por baixo dos panos e, em um cluster, só enxerga as chaves daquele nó, e é por isso que o laço percorre todos os endpoints. A [documentação do StackExchange.Redis](https://seredis.dev/KeysScan) ainda desaconselha executá-lo em servidores de produção ocupados, então faça isso em um job em segundo plano com um tamanho de página modesto.

**Não use hash tags para tenants.** Escrever chaves como `{t:42}:product:7` força todas as chaves de um tenant em um único hash slot, o que permite operações com várias chaves, mas também prende o tenant inteiro a um único shard. Seu maior tenant vira um shard quente. Deixe o tenant fora das chaves de hash tag, a menos que você realmente precise de transações entre chaves.

**Adicione ACLs se os tenants têm acesso direto ao Redis.** Normalmente só o seu app fala com o Redis, então o prefixo é garantido por code review e pelo wrapper `TenantCache`. Se um worker específico de um tenant recebe suas próprias credenciais, os padrões de chave de ACL do Redis 7 impõem o prefixo no servidor: `ACL SETUSER tenant42 on >secret ~myapp:t:42:* +@read +@write`.

**O comprimento do prefixo é overhead em toda chave.** `myapp:t:` mais um id de tenant GUID dá 44 bytes antes da chave propriamente dita. Em um cache com dezenas de milhões de entradas pequenas, isso é memória de verdade. Um id de tenant inteiro curto ou em base 36 mantém isso desprezível e o mantém longe do `MaximumKeyLength` de 1024 caracteres do `HybridCache`.

## A recomendação, com os motivos

Use um prefixo de chave em um Redis compartilhado. Ele roda em todas as topologias, de um contêiner local ao Azure Managed Redis com clustering OSS, é a única opção que se combina com uma única chamada a `AddHybridCache()`, e o tenant precisa estar na chave de qualquer forma por causa do L1 compartilhado. Adicione uma camada de instâncias dedicadas, roteada por um `IDistributedCache` como o acima, para os tenants cujos contratos ou cargas justifiquem pagar por isolamento. Evite bancos numerados, a menos que você esteja comprometido com o Valkey 9.1+: eles dão `FLUSHDB` e contagens de chaves por banco em `INFO keyspace`, mas compartilham memória e CPU com todos os outros tenants e desaparecem no momento em que você migra para um Redis em cluster ou enterprise.

## Relacionados

- [Como usar o HybridCache no ASP.NET Core 11 com Redis como cache L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) cobre a configuração base sobre a qual este post se apoia.
- [HybridCache vs IMemoryCache vs IDistributedCache no .NET 11](/pt-br/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) explica a divisão L1/L2 que torna as chaves de tenant obrigatórias.
- [Output caching em uma minimal API](/pt-br/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) mostra `VaryByValue` para entradas de output cache por tenant.
- [Keyed services na injeção de dependência do .NET](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) é como os caches compartilhado e roteado são registrados lado a lado.
- [Filtros de consulta nomeados no EF Core 11](/pt-br/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) é a contrapartida no lado do banco de dados para o isolamento de tenants.

## Fontes

- [Comando `SELECT` do Redis](https://redis.io/docs/latest/commands/select/), incluindo as notas sobre cluster e Redis Software.
- [Arquitetura do Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/architecture) para os detalhes de clustering e de política de cluster.
- [Valkey `ACL SETUSER`](https://valkey.io/commands/acl-setuser/) para padrões de chave e as regras `db=` do 9.1.
- [RedisCacheOptions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCacheOptions.cs) e [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) para ver como `InstanceName` e o banco são aplicados.
- [Biblioteca HybridCache no ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) para a orientação sobre chaves e a semântica de invalidação por tag.
- [StackExchange.Redis: KEYS, SCAN, FLUSHDB etc](https://seredis.dev/KeysScan) para scan em clusters.
