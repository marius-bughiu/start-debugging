---
title: "HybridCache vs IMemoryCache vs IDistributedCache no .NET 11: qual você deve escolher?"
description: "Para código de cache novo no .NET 11, use HybridCache por padrão. Recorra ao IMemoryCache só quando precisar de velocidade em um único servidor sem serialização, e ao IDistributedCache só como armazenamento de respaldo. Aqui está a matriz de decisão."
pubDate: 2026-06-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "caching"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-14
---

Para código de cache novo no .NET 11, use `HybridCache` por padrão. Ele oferece a velocidade em processo do `IMemoryCache`, o alcance entre servidores do `IDistributedCache`, e proteção contra estampede mais invalidação por tags que nenhuma das APIs antigas tem, tudo por trás de uma única chamada a `GetOrCreateAsync`. Recorra ao `IMemoryCache` puro só quando precisar de latência de um único servidor sem serialização e controle fino de despejo, e recorra ao `IDistributedCache` puro principalmente quando precisar de um armazenamento distribuído sem uma camada L1 (ou como camada de respaldo do `HybridCache`). Este artigo embasa essa recomendação com a matriz de recursos completa, as diferenças de API que realmente importam, e o detalhe que decide por você.

Tudo aqui tem como alvo .NET 11, ASP.NET Core 11 e C# 14. O `HybridCache` vem no pacote `Microsoft.Extensions.Caching.Hybrid`, que chegou ao GA junto com o .NET 9 e é o mesmo pacote que você usa no .NET 11. Ele suporta runtimes até o .NET Framework 4.7.2 e o .NET Standard 2.0, então a comparação abaixo não se limita ao TFM mais recente.

## A matriz de recursos

| Recurso                         | IMemoryCache              | IDistributedCache               | HybridCache                          |
| ------------------------------- | ------------------------- | ------------------------------- | ------------------------------------ |
| Camada                          | L1 (em processo)          | L2 (fora do processo)           | L1 + L2 opcional                     |
| Compartilhado entre servidores  | Não                       | Sim                             | Sim (via L2)                         |
| Sobrevive ao reinício do processo | Não                     | Sim                             | L2 sobrevive, L1 não                 |
| Armazenado como                 | objeto vivo               | `byte[]`                        | objeto no L1, serializado no L2      |
| Serialização                    | nenhuma                   | você escreve                    | integrada (`System.Text.Json` e mais) |
| Proteção contra estampede       | não                       | não                             | sim                                  |
| Invalidação por tags            | não                       | não                             | sim (`RemoveByTagAsync`)             |
| Obter-ou-criar em uma chamada   | só extensão, sem proteção | não                             | sim (`GetOrCreateAsync`)             |
| Controle de expiração por entrada | completo                | absoluta + deslizante           | global + local (`LocalCacheExpiration`) |
| Métricas OpenTelemetry integradas | sim (.NET 11)           | depende do backend              | sim                                  |
| Incluído (sem NuGet)            | sim                       | abstração sim, backends não     | não (um pacote)                      |
| Runtime mínimo                  | amplo                     | amplo                           | .NET Framework 4.7.2 / netstandard2.0 |

As três são registradas via DI e resolvidas por interface (ou, para o `HybridCache`, uma classe abstrata). As diferenças que importam não estão no registro, estão no que cada uma faz em uma falha de cache e sob concorrência.

## O que cada API realmente é

O `IMemoryCache` armazena referências a objetos vivos em um armazenamento respaldado por `ConcurrentDictionary` dentro do seu processo. Não há serialização: você coloca um `Customer` e recebe a mesma referência `Customer`. Isso o torna o mais rápido dos três e o único onde um acerto de cache custa essencialmente uma busca em dicionário. O preço é que ele é por processo: duas instâncias atrás de um balanceador de carga têm dois caches independentes, e um reinício o esvazia.

```csharp
// .NET 11, C# 14
builder.Services.AddMemoryCache();

public class ProductService(IMemoryCache cache, ProductDb db)
{
    public Task<Product> GetAsync(int id) =>
        cache.GetOrCreateAsync($"product:{id}", entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            return db.LoadProductAsync(id);
        })!;
}
```

O `IDistributedCache` é uma abstração deliberadamente de baixo nível sobre um armazenamento fora do processo. Sua superfície é `GetAsync`, `SetAsync`, `RefreshAsync` e `RemoveAsync` (mais as variantes síncronas), e cada valor é um `byte[]`. Não há `GetOrCreate`, nem modelo de objetos, nem controle de concorrência. Você cuida da serialização, da nomeação de chaves, da política de expiração e do padrão de leitura direta.

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisCache(o =>
    o.Configuration = builder.Configuration.GetConnectionString("Redis"));

public class ProductService(IDistributedCache cache, ProductDb db)
{
    public async Task<Product> GetAsync(int id)
    {
        var key = $"product:{id}";
        var bytes = await cache.GetAsync(key);
        if (bytes is not null)
            return JsonSerializer.Deserialize<Product>(bytes)!;

        var product = await db.LoadProductAsync(id);
        await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(product),
            new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5)
            });
        return product;
    }
}
```

Isso são aproximadamente quinze linhas de código repetitivo por valor em cache, e cada cópia é uma chance de esquecer a expiração, tratar mal um null, ou escolher um serializador ligeiramente diferente. As implementações integradas incluem em memória (`AddDistributedMemoryCache`, só para desenvolvimento e testes, já que não é realmente distribuído), Redis (`AddStackExchangeRedisCache`), SQL Server (`AddDistributedSqlServerCache`), Azure Cache for Redis, e armazenamentos de terceiros como NCache.

O `HybridCache` é a abstração que a Microsoft adicionou para fundir os dois padrões acima em um. Ele mantém um L1 em processo (um `MemoryCache` por padrão) e, se você registrou um `IDistributedCache`, o usa automaticamente como L2. Uma chamada a `GetOrCreateAsync` verifica o L1, depois o L2, depois executa sua factory e grava de volta em ambas as camadas. Você nunca toca na serialização a menos que queira.

```csharp
// .NET 11, C# 14
builder.Services.AddHybridCache();
// If an IDistributedCache is also registered, it becomes the L2 automatically.

public class ProductService(HybridCache cache, ProductDb db)
{
    public ValueTask<Product> GetAsync(int id, CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            $"product:{id}",
            async token => await db.LoadProductAsync(id, token),
            cancellationToken: ct);
}
```

Mesmo resultado que o bloco do `IDistributedCache`, três linhas em vez de quinze, com proteção contra estampede e uma camada L1 que você não precisou conectar.

## Quando escolher IMemoryCache diretamente

- **Caches de um único servidor ou por nó onde os dados são baratos de recalcular após um reinício.** Uma tabela de consulta carregada uma vez por processo, uma config analisada, um bucket de limitador de taxa. Não há benefício em serializá-los fora do processo. Combine com o novo medidor OpenTelemetry integrado do .NET 11 para continuar obtendo métricas de taxa de acertos e despejos sem um poller personalizado, como abordado em [o artigo sobre as métricas do MemoryCache no .NET 11](/pt-br/2026/06/dotnet-11-memorycache-opentelemetry-metrics/).
- **Caminhos críticos onde até uma rodada de serialização é demais.** Como o `IMemoryCache` devolve o objeto vivo, um acerto é uma leitura de dicionário. Se você está armazenando em cache um valor lido milhares de vezes por segundo em uma máquina, isso importa. Esse é o mesmo raciocínio por trás de manter um plano de consulta residente, como em [consultas compiladas para caminhos críticos do EF Core](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Você precisa de recursos de despejo que o `HybridCache` não expõe.** Limites por tamanho (`SizeLimit` mais `Size` por entrada), prioridade de despejo e `PostEvictionCallbacks` são conceitos do `IMemoryCache`. O `HybridCache` não os expõe em sua API.

A pegadinha que você aceita ao ir direto: o `GetOrCreateAsync` no `IMemoryCache` é um método de extensão sem proteção contra estampede. Sob uma rajada com cache frio, cada chamador concorrente executa a factory.

## Quando escolher IDistributedCache diretamente

- **Você precisa de um armazenamento compartilhado mas explicitamente não quer uma camada L1.** Se a correção depende de cada nó ver o mesmo valor no instante em que ele muda, um L1 em processo com sua própria expiração é um risco, porque invalidar uma chave não alcança o L1 de outros servidores (mais sobre isso abaixo). Ir direto ao Redis remove a janela de obsolescência que o L1 introduz.
- **Você não está realmente fazendo cache.** O `IDistributedCache` respalda o estado de sessão do ASP.NET Core e pode conter chaves de Data Protection. Esses são casos de uso de armazenamento, não caches de leitura direta, e o `HybridCache` tem o formato errado para eles.
- **Você precisa de controle total sobre os bytes serializados.** Formatos binários personalizados, compressão que você gerencia, ou interoperabilidade com outro sistema que lê as mesmas chaves do Redis. O `HybridCache` pode receber um serializador personalizado, mas se os bytes são o contrato, a API de mais baixo nível é mais honesta.

## Quando escolher HybridCache (o padrão)

- **Qualquer cache de leitura direta novo em uma app que pode escalar além de uma instância.** Você obtém a velocidade do L1 hoje e a correção do L2 no momento em que registra um cache Redis, sem mudança de código no ponto de chamada. Essa é exatamente a configuração descrita em [usar HybridCache com Redis como o cache L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/).
- **Em qualquer lugar onde um cache estampede causaria dano.** O `HybridCache` garante que, para uma chave dada, apenas um chamador concorrente execute a factory enquanto o resto aguarda esse único resultado. Um cache frio atingido por cem requisições emite uma consulta de respaldo, não cem, que é o mesmo problema que você combate ao perseguir [consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).
- **Você quer invalidação agrupada.** Marque um conjunto de entradas com tags (`tags: ["product", $"category:{categoryId}"]`) e remova-as juntas com `RemoveByTagAsync("category:42")`. Nenhuma das APIs antigas tem conceito de tag.

## O benchmark de estampede, concretamente

Essa é a diferença que aparece em produção, então vale a pena medir em vez de afirmar. Pegue uma factory que simula uma leitura de banco de dados de 200 ms e dispare 100 chamadas concorrentes a `GetOrCreateAsync` para a mesma chave contra um cache frio.

```csharp
// .NET 11, BenchmarkDotNet 0.15.x style harness (simplified)
async Task<int> Factory(CancellationToken _)
{
    Interlocked.Increment(ref _factoryCalls);
    await Task.Delay(200);          // stand-in for a DB / HTTP round trip
    return 42;
}

var tasks = Enumerable.Range(0, 100)
    .Select(_ => hybrid.GetOrCreateAsync("k", Factory).AsTask());
await Task.WhenAll(tasks);
```

Com o `HybridCache`, `_factoryCalls` é **1**: um chamador executa a factory de 200 ms e os outros 99 aguardam o resultado, então toda a rajada se resolve em aproximadamente 200 ms com uma única chamada de respaldo. Troque pelo método de extensão `GetOrCreateAsync` do `IMemoryCache` e `_factoryCalls` sobe até **100**, porque nada serializa os chamadores que falham a frio. Contra um banco de dados real, essa é a diferença entre uma consulta e um congestionamento de cem no pool de conexões. A contagem exata para o caso do `IMemoryCache` varia com o timing (alguns chamadores podem chegar depois que a primeira gravação termina), o que é exatamente o ponto: ela não é limitada e é não determinística, enquanto o `HybridCache` a fixa em um. Números medidos no .NET 11 (11.0.x), Windows 11, com apenas o L1 integrado e sem L2 configurado.

## Expiração: os nomes das opções diferem de um jeito que morde

As três APIs nomeiam a expiração de formas diferentes, e confundi-las é o erro de configuração mais comum.

O `IMemoryCache` usa `MemoryCacheEntryOptions` com `AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow` e `SlidingExpiration`. O `IDistributedCache` usa `DistributedCacheEntryOptions` com os mesmos três nomes. O `HybridCache` usa `HybridCacheEntryOptions` com duas propriedades que significam algo diferente:

```csharp
// .NET 11, C# 14
var options = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),        // overall lifetime (drives L2)
    LocalCacheExpiration = TimeSpan.FromMinutes(1) // how long the L1 copy is trusted
};
```

`Expiration` é o tempo de vida total da entrada, e governa a cópia do L2. `LocalCacheExpiration` é por quanto tempo a cópia L1 em processo é considerada válida antes de a entrada ser buscada novamente no L2. Definir `LocalCacheExpiration` mais curto que `Expiration` é como você limita a obsolescência do L1 em uma implantação multiservidor: cada nó confia em sua cópia local por no máximo um minuto, depois revalida contra o L2 compartilhado. Não há conceito de expiração deslizante no `HybridCache`; se você depende de janelas deslizantes, essa é uma razão para ficar com a API de mais baixo nível.

Outros padrões que vale conhecer: `HybridCacheOptions.MaximumPayloadBytes` tem padrão de 1 MB e `MaximumKeyLength` de 1024 caracteres. Valores ou chaves acima do limite são registrados e silenciosamente não armazenados em cache, o que é um modo de falha silencioso se você armazena blobs grandes.

## O detalhe que decide por você

A invalidação por tags e por chave no `HybridCache` não alcança o L1 de outros servidores. Quando você chama `RemoveByTagAsync` ou `RemoveAsync`, a entrada é removida do L1 local e do L2 compartilhado, mas cada outro nó continua servindo sua própria cópia L1 até que essa cópia expire pelo seu próprio `LocalCacheExpiration`. A documentação é explícita: a invalidação por tags é uma operação lógica que marca leituras futuras como falhas, ela não purga ativamente outros nós.

Esse único comportamento decide vários designs:

- Se você pode tolerar uma janela de obsolescência limitada (defina `LocalCacheExpiration` para a janela que você aceita), o `HybridCache` é ideal e você mantém a velocidade do L1.
- Se você não pode tolerar nenhuma janela, porque um valor de autorização ou de preço obsoleto é um bug de correção, então uma camada L1 é a ferramenta errada, e você deveria ir direto ao `IDistributedCache` (ou definir `LocalCacheExpiration` como zero, o que em grande parte anula o propósito do L1).

A outra função forçante é a **segurança de serialização**. O `HybridCache` desserializa um objeto novo por chamador por padrão para preservar as garantias de segurança de thread do `IDistributedCache`. Se seu tipo em cache é imutável, você pode optar pela reutilização de instâncias selando o tipo e aplicando `[ImmutableObject(true)]`, o que remove a sobrecarga de desserialização por chamada. Se seus objetos em cache são mutáveis e compartilhados, não aplique esse atributo, ou você introduzirá condições de corrida.

## A recomendação, reafirmada

No .NET 11, escreva código de cache novo contra o `HybridCache` a menos que você tenha uma razão específica para não fazer isso. Ele é quase um substituto direto de ambas as APIs antigas, elimina o código repetitivo de cache-aside que o `IDistributedCache` impõe a você, e fecha o buraco de estampede que o `IMemoryCache.GetOrCreateAsync` sem proteção deixa aberto. Desça para o `IMemoryCache` puro quando precisar de velocidade de um único servidor, zero serialização, ou recursos de despejo (limites de tamanho, prioridade, callbacks de despejo) que o `HybridCache` não expõe. Desça para o `IDistributedCache` puro quando precisar de um armazenamento compartilhado sem janela de obsolescência de L1, quando os bytes serializados forem um contrato com outro sistema, ou quando você o usar para armazenamento de sessão e chaves em vez de cache. Para todo o resto, que é a maioria do cache, o `HybridCache` é a resposta.

## Relacionado

- [Como usar HybridCache no ASP.NET Core 11 com Redis como o cache L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 dá ao MemoryCache métricas OpenTelemetry de primeira classe](/pt-br/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Como usar consultas compiladas com EF Core para caminhos críticos](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Fontes

- [Biblioteca HybridCache no ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Cache distribuído no ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/distributed?view=aspnetcore-10.0)
- [Cache em memória no ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/memory?view=aspnetcore-10.0)
- [Hello HybridCache! (Blog do .NET da Microsoft, anúncio de GA)](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Visão geral de cache no ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview?view=aspnetcore-10.0)
