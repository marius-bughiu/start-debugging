---
title: "Como usar HybridCache no ASP.NET Core 11 com Redis como cache L2"
description: "Conecte o HybridCache a um L2 de Redis no ASP.NET Core 11: registre o serviço, adicione o cache distribuído do StackExchange Redis e deixe o GetOrCreateAsync te dar um cache de dois níveis com proteção contra estampida e invalidação por tags integradas."
pubDate: 2026-06-07
template: how-to
tags:
  - "aspnetcore"
  - "dotnet"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache"
translatedBy: "claude"
translationDate: 2026-06-07
---

Para usar o HybridCache com Redis como cache de segundo nível no ASP.NET Core 11, instale `Microsoft.Extensions.Caching.Hybrid`, chame `builder.Services.AddHybridCache()` e então registre um `IDistributedCache` baseado em Redis com `AddStackExchangeRedisCache(...)`. O HybridCache pega automaticamente esse `IDistributedCache` como seu L2. A partir daí, toda chamada a `GetOrCreateAsync` lê primeiro o L1 (memória em processo), recorre ao L2 (Redis) e só chama sua factory quando há uma falha completa. Você ganha proteção contra estampida de cache e invalidação baseada em tags de graça, sem código repetitivo de cache-aside. Este artigo percorre a configuração completa, as opções que realmente importam e a pegadinha de múltiplas instâncias que confunde muita gente.

Todos os exemplos têm como alvo .NET 11, ASP.NET Core 11 e C# 14, usando `Microsoft.Extensions.Caching.Hybrid` 9.x (o pacote chegou ao GA com o .NET 9 e é o mesmo pacote que você usa no .NET 11). A biblioteca em si suporta runtimes até .NET Framework 4.7.2 e .NET Standard 2.0, então o mesmo código funciona em hosts mais antigos.

## Por que o HybridCache existe

Se você já lançou um cache distribuído antes, já escreveu este laço na mão: verifica o `IMemoryCache`, falha, verifica o `IDistributedCache` (Redis), falha, desserializa, chama o banco de dados, serializa, escreve de volta nas duas camadas, retorna. Multiplique isso por cada valor em cache e você tem uma pilha de código de cache-aside quase idêntico, cada cópia com seu próprio bug sutil. Os dois bugs clássicos são uma proteção contra estampida ausente (cem requisições atingem uma chave expirada ao mesmo tempo e todas martelam o banco de dados) e uma serialização inconsistente entre as duas camadas.

O HybridCache reduz tudo isso a uma única chamada. É um cache de dois níveis: o L1 é um `MemoryCache` em processo (rápido, por servidor, perdido ao reiniciar), e o L2 é qualquer `IDistributedCache` que você registrar (Redis, SQL Server, Postgres, Garnet). O ponto-chave para este artigo: você não configura o L2 diretamente no HybridCache. O HybridCache descobre o `IDistributedCache` a partir do contêiner de injeção de dependência. Registre um cache distribuído do Redis e o HybridCache o usa como L2 automaticamente.

## Conectar o Redis como cache L2

Aqui está a configuração de ponta a ponta como um procedimento numerado.

1. Instale os dois pacotes. O primeiro traz o HybridCache; o segundo é o `IDistributedCache` de Redis baseado no StackExchange.

   ```dotnetcli
   dotnet add package Microsoft.Extensions.Caching.Hybrid
   dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
   ```

2. Guarde a string de conexão do Redis na configuração. Mantenha-a fora do controle de versão com um arquivo de user-secrets em desenvolvimento:

   ```json
   {
     "ConnectionStrings": {
       "RedisConnectionString": "localhost:6379"
     }
   }
   ```

3. Registre o `IDistributedCache` do Redis. Este é o L2. `AddStackExchangeRedisCache` coloca um `IDistributedCache` na injeção de dependência baseado na sua instância de Redis.

   ```csharp
   // .NET 11, ASP.NET Core 11, C# 14
   var builder = WebApplication.CreateBuilder(args);

   builder.Services.AddStackExchangeRedisCache(options =>
   {
       options.Configuration =
           builder.Configuration.GetConnectionString("RedisConnectionString");
   });
   ```

4. Registre o HybridCache. Ele encontrará o `IDistributedCache` do passo 3 e o usará como L2. Sem um `IDistributedCache` registrado, o HybridCache ainda funciona como um cache em processo só de L1, então esta única linha é a única coisa que "liga" o comportamento de dois níveis.

   ```csharp
   // .NET 11, ASP.NET Core 11
   builder.Services.AddHybridCache();

   var app = builder.Build();
   ```

Essa é toda a fiação. A ordem não importa entre os passos 3 e 4 porque a injeção de dependência resolve o `IDistributedCache` de forma tardia quando o HybridCache precisa dele pela primeira vez. Não há uma chamada `UseRedis()` no HybridCache nem uma configuração de L2 para apontar para o Redis. A descoberta é implícita através do `IDistributedCache`, que é exatamente por que o mesmo código de HybridCache roda contra Redis, SQL Server ou sem L2 algum sem mudar uma linha.

## Ler e escrever com GetOrCreateAsync

`GetOrCreateAsync` é a API que você vai usar 95% do tempo. Injete o `HybridCache` e o chame com uma chave e uma factory:

```csharp
// .NET 11, C# 14
public sealed class ProductService(HybridCache cache, ProductDbContext db)
{
    public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
    {
        return await cache.GetOrCreateAsync(
            $"product:{id}",                       // unique cache key
            async cancel => await db.Products
                .AsNoTracking()
                .FirstOrDefaultAsync(p => p.Id == id, cancel),
            cancellationToken: ct);
    }
}
```

Na primeira chamada para `product:42`, o HybridCache falha no L1, falha no L2, roda a factory, serializa o resultado, escreve-o tanto no Redis quanto no cache em processo e retorna. A próxima chamada no mesmo servidor acerta no L1 e nunca toca o Redis. Uma chamada em um servidor diferente do seu cluster falha no L1 mas acerta no L2 (Redis), então pula o banco de dados e preenche seu próprio L1. Essa é a vantagem dos dois níveis: as chaves quentes ficam em processo, as chaves mornas ficam no Redis e o banco de dados só vê uma falha quando ambas as camadas estão frias.

Repare na string interpolada passada diretamente dentro da chamada. A documentação recomenda escrever a chave em linha assim em vez de construí-la primeiro em uma variável local, porque isso permite que versões futuras da biblioteca evitem a alocação da string em alguns casos. Há também uma segunda sobrecarga de `GetOrCreateAsync` que recebe uma tupla `state` mais um lambda `static`, o que evita alocações de closure em caminhos quentes:

```csharp
// .NET 11, C# 14 - allocation-conscious overload
return await cache.GetOrCreateAsync(
    $"product:{id}",
    (db, id),
    static async (state, cancel) => await state.db.Products
        .AsNoTracking()
        .FirstOrDefaultAsync(p => p.Id == state.id, cancel),
    cancellationToken: ct);
```

Use a sobrecarga sem estado por padrão. Recorra à com estado apenas quando um profiler te disser que a alocação da closure importa, o que é raro diante do custo de uma ida e volta ao banco de dados.

## A proteção contra estampida é o recurso que você realmente compra

Esta é a parte difícil de acertar na mão. Quando uma chave popular expira e chega uma rajada de requisições, um cache-aside ingênuo deixa cada requisição falhar e chamar a factory ao mesmo tempo. O HybridCache garante que, para uma dada chave em um dado servidor, apenas um chamador roda a factory. O restante aguarda o mesmo resultado.

```csharp
// 100 concurrent requests for the same cold key
// -> exactly 1 factory invocation, 99 awaiters share the result
var tasks = Enumerable.Range(0, 100)
    .Select(_ => service.GetProductAsync(42, ct));
var results = await Task.WhenAll(tasks);
```

Uma sutileza: o `CancellationToken` que você passa representa o cancelamento combinado de todos os chamadores na fila. A factory continua rodando enquanto pelo menos um chamador ainda quiser o resultado, então um único cliente que se desconecta não cancelará o trabalho compartilhado para todos os outros.

A ressalva honesta: esta proteção é por instância. O HybridCache não inclui um lock distribuído, então em um cluster de três servidores uma chave fria pode disparar até três chamadas à factory, uma por servidor, não uma em toda a frota. Para a maioria das cargas de trabalho isso está bem. Se você de fato precisa de single-flight em todo o cluster, precisa de um lock distribuído externo ou de um cache de terceiros como o FusionCache que adicione uma camada com um. Não suponha que "proteção contra estampida" significa "uma consulta ao banco de dados em todos os servidores".

## Expiração: os dois relógios que você controla

`HybridCacheEntryOptions` expõe duas configurações de expiração, e confundi-las é o erro de configuração mais comum:

- `Expiration` é o tempo de vida total, incluindo a cópia do L2 (Redis).
- `LocalCacheExpiration` é o tempo de vida do L1 em processo. Geralmente é mais curto que `Expiration`.

```csharp
// .NET 11 - global defaults
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1 MB, the default
    options.MaximumKeyLength = 1024;           // chars, the default
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),       // L2 + overall
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 only
    };
});
```

Manter `LocalCacheExpiration` mais curto que `Expiration` é um padrão deliberado: limita por quanto tempo qualquer servidor pode servir dados obsoletos da sua própria memória, enquanto deixa o Redis reter o valor por mais tempo para o compartilhamento entre servidores. Um L1 curto mais um L2 mais longo significa que a janela de dados obsoletos de um servidor é pequena, mas o cluster como um todo ainda evita o banco de dados. Você pode sobrescrever esses valores por chamada passando um `HybridCacheEntryOptions` para `GetOrCreateAsync`.

A propriedade `Flags` em `HybridCacheEntryOptions` permite desabilitar um nível para uma entrada específica, por exemplo `HybridCacheEntryFlags.DisableLocalCacheWrite` para pular o L1 em um valor grande e raramente lido, ou `DisableDistributedCache` para manter algo apenas em processo. Recorra a essas opções de forma cirúrgica; os padrões são os corretos para a maioria das entradas.

## Invalidar por chave e por tag

Quando os dados subjacentes mudam, remova a entrada. Por chave:

```csharp
await cache.RemoveAsync($"product:{id}", ct);
```

As tags são a ferramenta mais poderosa. Anexe tags ao criar uma entrada e então invalide um grupo inteiro em uma única chamada:

```csharp
// .NET 11, C# 14
public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
{
    var options = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(10),
        LocalCacheExpiration = TimeSpan.FromMinutes(2)
    };
    var tags = new[] { "products", $"category:{await GetCategoryAsync(id, ct)}" };

    return await cache.GetOrCreateAsync(
        $"product:{id}",
        async cancel => await db.Products
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == id, cancel),
        options,
        tags,
        cancellationToken: ct);
}

// Invalidate every product in one category after a bulk price update
public ValueTask InvalidateCategoryAsync(int categoryId, CancellationToken ct = default)
    => cache.RemoveByTagAsync($"category:{categoryId}", ct);
```

Isso substitui o velho padrão de rastrear quais chaves pertencem a qual grupo em um dicionário separado. `RemoveByTagAsync("products")` invalida tudo marcado como `products` em uma única chamada. Há um curinga: `RemoveByTagAsync("*")` invalida logicamente todo o cache, mesmo as entradas sem tag. A correspondência glob não é suportada, então `RemoveByTagAsync("foo*")` não remove as chaves que começam com `foo`.

Aqui está a nuance que surpreende as pessoas. Nem o `IMemoryCache` nem o `IDistributedCache` entendem tags, então a invalidação por tag é uma operação lógica, não uma exclusão física. O HybridCache não entra no Redis e apaga as chaves marcadas. Em vez disso, ele registra que a tag foi invalidada e, na próxima leitura de qualquer entrada que carregue essa tag, trata o valor como uma falha e o busca novamente. Os bytes permanecem no Redis e na memória até expirarem naturalmente. Para a correção isso está bem. Para a contabilidade de memória do Redis significa que a invalidação por tag não libera espaço imediatamente.

## A pegadinha de múltiplas instâncias que pega todo mundo

Leia isto duas vezes se você roda mais de um servidor. Quando você chama `RemoveAsync` ou `RemoveByTagAsync`, a entrada é invalidada no servidor atual e no L2 (Redis). Ela não é invalidada no L1 (memória em processo) dos outros servidores. Cada um desses servidores continuará servindo sua própria cópia em cache até que essa cópia esgote seu `LocalCacheExpiration`.

Então, se você tem cinco servidores e remove `product:42` no servidor A, os servidores B a E ainda podem retornar o produto antigo da sua memória local por até `LocalCacheExpiration`. Esta é a razão mais importante para manter `LocalCacheExpiration` curto em dados que são invalidados explicitamente. Se você precisa de uma invalidação entre servidores quase instantânea, tem que difundi-la você mesmo, por exemplo com uma mensagem de publicação/assinatura do Redis que cada servidor trata chamando seu próprio `RemoveAsync`. O HybridCache não faz essa propagação por você de fábrica.

## Serialização e objetos grandes

Para o armazenamento no L2, os valores devem ser serializados. O HybridCache trata `string` e `byte[]` internamente e usa `System.Text.Json` para todo o resto por padrão. Você pode trocar por um serializador específico de tipo ou geral (protobuf, MessagePack, XML) encadeando-o a `AddHybridCache`:

```csharp
// .NET 11 - custom serializer for one type
builder.Services
    .AddHybridCache()
    .AddSerializer<Product, ProtobufProductSerializer>();
```

Dois limites para lembrar. `MaximumPayloadBytes` tem padrão de 1 MB; valores maiores que isso são registrados e silenciosamente não armazenados em cache, então um objeto grande demais vira uma falha permanente que sempre atinge sua factory. `MaximumKeyLength` tem padrão de 1024 caracteres; chaves mais longas contornam o cache por completo. Se você constrói chaves a partir da entrada do usuário, limite seu comprimento e nunca confie em strings de usuário cruas como chaves, tanto para se manter abaixo do limite quanto para evitar um ataque de negação de serviço por inundação de cache.

Se o seu tipo em cache é imutável, você pode dizer ao HybridCache para pular a desserialização defensiva por chamada e entregar uma instância compartilhada, o que corta CPU e alocações para objetos grandes ou quentes. Marque o tipo como `sealed` e aplique `[ImmutableObject(true)]`:

```csharp
// .NET 11, C# 14 - safe to reuse the same instance across callers
[ImmutableObject(true)]
public sealed record Product(int Id, string Name, decimal Price);
```

Faça isso apenas quando o objeto verdadeiramente nunca é alterado após a criação; caso contrário, você reintroduz os bugs de concorrência dos quais o comportamento padrão te protege. Para o Redis especificamente, o pacote `Microsoft.Extensions.Caching.StackExchangeRedis` pode implementar `IBufferDistributedCache`, que permite ao HybridCache evitar alocações de `byte[]` no caminho do L2. Vale a pena habilitar isso em serviços de alta vazão.

## Onde o HybridCache se encaixa ao lado do que você já usa

O HybridCache não substitui o `IMemoryCache` nem o `IDistributedCache`; ele se posiciona acima deles e orquestra ambos. Se você ainda faz cache-aside na mão sobre o `IMemoryCache`, ou observa a taxa de acertos do cache com o novo medidor integrado descrito em [as métricas de OpenTelemetry de primeira classe para o MemoryCache no .NET 11](/pt-br/2026/06/dotnet-11-memorycache-opentelemetry-metrics/), o HybridCache é a camada que une os níveis em processo e distribuído com uma única API consistente. Ele combina naturalmente com a história de resiliência em [Polly versus os handlers de resiliência integrados no .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), já que tanto o cache quanto o retry protegem uma dependência lenta.

O cache também é a solução mais barata para os problemas de consulta que você pode ver em [detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): uma vez que uma consulta está correta, armazenar seu resultado a mantém fora do caminho quente, o que complementa [as consultas compiladas para caminhos quentes do EF Core](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). E como a serialização do L2 passa pelo `System.Text.Json` por padrão, as mesmas regras de [escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) se aplicam a qualquer coisa que você armazene em cache e precise de serialização personalizada.

O modelo mental a guardar: o HybridCache te dá um cache de dois níveis, proteção contra estampida por servidor e invalidação lógica por tags, tudo por trás de `GetOrCreateAsync`. O Redis vira o L2 no momento em que você registra um `IDistributedCache`. As duas coisas que ele não faz, single-flight em todo o cluster e invalidação de L1 entre servidores, são exatamente as duas coisas que você deve projetar com cuidado: com um `LocalCacheExpiration` curto e, se precisar, sua própria invalidação por publicação/assinatura.

## Fontes

- [Biblioteca HybridCache no ASP.NET Core, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Hello HybridCache! Streamlining Cache Management for ASP.NET Core Applications, .NET Blog](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Referência da API IBufferDistributedCache](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.caching.distributed.ibufferdistributedcache)
- [Integração do FusionCache com HybridCache](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/MicrosoftHybridCache.md)
</content>
