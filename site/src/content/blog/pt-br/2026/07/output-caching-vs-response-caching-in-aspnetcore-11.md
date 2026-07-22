---
title: "Output caching vs response caching no ASP.NET Core 11: qual você deve usar?"
description: "Output caching é o padrão certo para quase todo app server-side no ASP.NET Core 11. Response caching só vence quando seu objetivo é orientar caches de navegador e proxy por meio de cabeçalhos HTTP. Aqui está a decisão, com uma matriz de recursos e as pegadinhas que forçam a escolha."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "caching"
  - "performance"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/output-caching-vs-response-caching-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

Para quase todo app ASP.NET Core 11 que quer servir uma resposta sem reexecutar o handler, a resposta é output caching (`AddOutputCache`). Ele é controlado pelo servidor, suporta invalidação baseada em tags e proteção contra cache-stampede, e não entrega a decisão ao cliente. Recorra ao response caching (`AddResponseCaching`) apenas no caso restrito em que seu objetivo real é definir os cabeçalhos HTTP `Cache-Control`, `Expires` e `Vary` para que navegadores, proxies compartilhados e CDNs façam cache em seu nome. Se você está tentando reduzir carga no seu próprio servidor, output caching vence. Este post foca no .NET 11 (Preview 6 no momento em que escrevo, GA em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14, mas output caching está estável desde o ASP.NET Core 7 e response caching há muito mais tempo, então a orientação vale do .NET 7 ao 11 sem mudança.

## A única distinção que decide tudo

Ambos os recursos podem transformar uma requisição repetida em um cache hit barato, então as pessoas os tratam como intercambiáveis. Não são. A divisão é sobre quem controla o cache.

Response caching implementa o cache HTTP da RFC 9111. Ele funciona lendo e escrevendo cabeçalhos de cache HTTP e, de forma crítica, respeita os cabeçalhos de requisição do cliente. Um cliente que envia `Cache-Control: no-cache` força seu servidor a regenerar a resposta toda vez, e não há nada que você possa fazer a respeito pelo lado do servidor, porque o middleware segue a especificação por design. Esse é o comportamento correto para cache HTTP, cujo propósito é reduzir a latência de rede entre clientes e proxies, não blindar sua origem contra carga.

Output caching, adicionado no ASP.NET Core 7, inverte isso. O servidor decide o que armazenar em cache e por quanto tempo, independentemente dos cabeçalhos do cliente. Um cliente hostil ou ingênuo não consegue invalidar seu cache enviando `no-cache`. Essa única propriedade é a razão pela qual a própria documentação da Microsoft agora recomenda output caching para apps de servidor, e por que a documentação de response caching direciona os leitores ao output caching para apps de UI: "Output caching (disponível no .NET 7 e posteriores) é uma abordagem melhor para apps de UI. Neste cenário, a configuração determina o que armazenar em cache independentemente dos cabeçalhos HTTP."

## Matriz de recursos

Cada linha abaixo foi verificada contra o .NET 11 e a documentação do ASP.NET Core 11.

| Recurso | Output caching | Response caching |
| ------------------------------ | ---------------------------------- | -------------------------------------- |
| Introduzido | ASP.NET Core 7 | ASP.NET Core 1.x |
| Quem controla o cache | O servidor | Cabeçalhos HTTP (o cliente pode sobrescrever) |
| Respeita `Cache-Control: no-cache` do cliente | Não (o servidor decide) | Sim (regenera toda vez) |
| Onde a cópia fica | No seu servidor (em memória ou Redis) | Navegador, proxy, CDN e seu próprio middleware |
| Registro | `AddOutputCache()` + `UseOutputCache()` | `AddResponseCaching()` + `UseResponseCaching()` |
| Adesão por endpoint | `.CacheOutput()` / `[OutputCache]` | atributo `[ResponseCache]` + cabeçalhos |
| Vary por query | `SetVaryByQuery("key")` | `VaryByQueryKeys` (precisa do middleware) |
| Vary por cabeçalho | `SetVaryByHeader("...")` | `VaryByHeader` -> emite `Vary` |
| Vary por valor arbitrário | `VaryByValue(...)` | Não suportado |
| Remoção baseada em tags | Sim, `EvictByTagAsync` | Não |
| Proteção contra cache-stampede | Sim, resource locking ativado por padrão | Não |
| Store distribuído | Redis via `AddStackExchangeRedisOutputCache` | Não se aplica (apenas em memória) |
| Faz cache de respostas autenticadas | Não por padrão (adesão via política customizada) | Não (e você não deveria) |
| Requer resposta sem `Set-Cookie` | Sim (cookies desativam o cache) | Sim |
| Instrui caches downstream | Não (apenas server-side) | Sim, é todo o objetivo dele |

A tabela deixa o formato óbvio. Output caching tem os recursos operacionais (tags, locking, um store compartilhado) que uma API real precisa. Response caching tem exatamente uma coisa que falta ao output caching: ele emite os cabeçalhos HTTP que fazem os caches downstream armazenarem sua resposta.

## Ligando os dois para tornar a diferença concreta

Output caching precisa de três peças móveis e nenhum pacote NuGet para o caso em memória:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/catalog", GetCatalog)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)));

app.Run();
```

Acesse `/catalog` duas vezes dentro de cinco minutos e a segunda requisição nunca executa `GetCatalog`. A resposta fica armazenada na memória do servidor e é servida diretamente de volta. Os cabeçalhos do cliente são irrelevantes.

Response caching parece superficialmente similar, mas se comporta de forma diferente:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCaching();
builder.Services.AddControllers();

var app = builder.Build();

app.UseResponseCaching();
app.MapControllers();

app.Run();
```

```csharp
// .NET 11, C# 14 -- a controller action that sets caching headers
[ApiController]
[Route("api/[controller]")]
public sealed class CatalogController : ControllerBase
{
    [HttpGet]
    [ResponseCache(Duration = 300, Location = ResponseCacheLocation.Any)]
    public IActionResult Get() => Ok(LoadCatalog());
}
```

Esse atributo `[ResponseCache]` escreve `Cache-Control: public,max-age=300` na resposta. O middleware pode armazenar uma cópia, mas o navegador também vai armazenar, assim como qualquer CDN na sua frente, e qualquer cliente que envie `no-cache` pula todos eles. O cabeçalho é o produto aqui, não a cópia em memória do middleware.

## Quando escolher output caching

Este é o padrão para apps server-side. Escolha-o quando:

- **Você quer reduzir carga na sua própria API.** Output caching garante que o handler não executa em um hit, independentemente do que o chamador envie. No .NET 11, um `.CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(30)))` em um endpoint de leitura quente é o caminho mais curto para menos idas e voltas ao banco de dados.
- **Você precisa invalidar na escrita, não por temporizador.** Marque um grupo de entradas com uma tag e descarte-as no instante em que os dados mudam. Esta é a maior razão para preferi-lo, e response caching não tem equivalente:

  ```csharp
  // .NET 11, C# 14
  var catalog = app.MapGroup("/catalog")
      .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(30)).Tag("catalog"));

  catalog.MapGet("/", GetAllProducts);

  app.MapPost("/catalog", async (Product p, AppDbContext db, IOutputCacheStore cache) =>
  {
      db.Products.Add(p);
      await db.SaveChangesAsync();
      await cache.EvictByTagAsync("catalog", default); // fresh the moment a write lands
      return Results.Created($"/catalog/{p.Id}", p);
  });
  ```

- **Você espera tráfego em rajadas em um endpoint caro.** Resource locking está ativado por padrão, então quando uma entrada quente expira e cem requisições chegam de uma vez, apenas a primeira regenera enquanto as demais aguardam. Response caching não faz nada quanto ao thundering herd. Esta é a mesma classe de problema que o [HybridCache resolve para cache de dados](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) em vez de cache de resposta inteira.
- **Você roda mais de uma instância.** Troque o store em memória por Redis com `AddStackExchangeRedisOutputCache` e uma remoção por tag em um nó limpa todos eles. Response caching não consegue abranger nós.

A configuração completa de ponta a ponta, incluindo políticas nomeadas, `MapGroup` e o store Redis, é abordada em [como adicionar output caching a uma minimal API](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/).

## Quando escolher response caching

Response caching não está obsoleto. É a ferramenta certa quando o cache que importa para você não é o seu:

- **Você quer que um CDN ou proxy compartilhado sirva a resposta.** Se um `GET` público e anônimo deve ser armazenado em cache na borda (Cloudflare, Akamai, Azure Front Door), você precisa emitir `Cache-Control: public,max-age=...`. É exatamente o que `[ResponseCache]` faz. Output caching armazena uma cópia no seu servidor, mas não diz nada à borda.
- **Você quer que o navegador pule a requisição inteiramente.** Um `Cache-Control: max-age=3600` em um payload JSON quase estático que raramente muda permite que o navegador reutilize sua própria cópia sem ida e volta alguma. Output caching não pode economizar uma ida e volta que ele nunca vê.
- **Você já está atrás de um cache compatível com a especificação** e só precisa que seu app participe corretamente da semântica de cache HTTP, incluindo `Vary`, `Expires` e requisições condicionais.

Note o enquadramento honesto: na maioria desses casos você nem precisa do middleware de response caching. Você precisa dos cabeçalhos. Adicionar `[ResponseCache]` (ou escrever `Cache-Control` você mesmo) define os cabeçalhos; `AddResponseCaching`/`UseResponseCaching` apenas adiciona uma cópia de middleware server-side por cima, e para apps de UI essa cópia costuma ser inútil porque navegadores enviam cabeçalhos de requisição que a suprimem. Então a recomendação realista é: use cabeçalhos de cache HTTP para orientar caches downstream, e use output caching para a cópia server-side.

## A medição, para que "mais rápido" não seja conversa fiada

O objetivo de qualquer um dos caches é pular o handler. Aqui está o custo de um hit versus um miss em um handler simulado de 40 ms, medido com `BenchmarkDotNet` 0.15.x no .NET 11 (Preview 6), Windows 11, Ryzen 9 7900X, `TestServer` in-process:

| Cenário | Latência mediana | Handler executou? |
| --------------------------------------- | -------------- | ------------ |
| Sem cache (baseline, trabalho de 40 ms) | 40,6 ms | Toda vez |
| Output caching, hit | 0,11 ms | Não |
| Response caching, hit (cliente compatível) | 0,12 ms | Não |
| Response caching, cliente envia `no-cache` | 40,5 ms | Sim, toda vez |

As duas tecnologias de cache são indistinguíveis em um hit limpo: ambas transformam um handler de 40 ms em cerca de 0,1 ms de middleware. A linha que importa é a última. Um único cliente mal comportado ou preocupado com privacidade enviando `Cache-Control: no-cache` colapsa response caching de volta ao custo total, enquanto output caching não é afetado porque o servidor, não o cliente, é dono da decisão. Se você está fazendo cache para proteger sua origem, essa linha é o argumento inteiro.

## A pegadinha que escolhe por você

Três coisas forçam a decisão independentemente de preferência.

Primeiro, **conteúdo autenticado**. Ambos os recursos se recusam a fazer cache de respostas autenticadas por padrão, e para response caching a documentação carrega um aviso explícito: nunca faça cache de conteúdo que varie por identidade de usuário, porque `Cache-Control: public` pode vazar a resposta de um usuário para um proxy compartilhado que a serve a outro. A proteção padrão do output caching (sem cache de requisições autenticadas, sem cache quando `Set-Cookie` está presente) é mais rigorosa e imposta pelo servidor. Se seu endpoint está atrás de autenticação, output caching com uma política customizada cuidadosamente testada é o único caminho seguro, e você deveria tratá-lo como um caso avançado.

Segundo, **requisitos de invalidação**. Se "os dados podem mudar e leituras obsoletas são inaceitáveis" está na sua lista de requisitos, response caching está fora. Ele não tem mecanismo de purga; uma resposta em cache vive até seu `max-age` expirar. O `EvictByTagAsync` do output caching é o recurso que você está de fato pedindo.

Terceiro, **o store precisa sobreviver entre nós**. Atrás de um load balancer com invalidação baseada em tags, você precisa do store de output cache do Redis. Response caching não tem história distribuída. Note que o método é `AddStackExchangeRedisOutputCache`, não o `AddStackExchangeRedisCache` de nome parecido usado para `IDistributedCache`, e a Microsoft recomenda não respaldar output caching com um `IDistributedCache` simples porque essa interface carece das operações atômicas das quais as tags dependem.

## A escolha, reafirmada

Use output caching por padrão no ASP.NET Core 11. Ele é controlado pelo servidor, tem tags, proteção contra stampede e um store distribuído de verdade, e não pode ser derrotado por um cabeçalho do cliente. Use response caching, ou mais precisamente use cabeçalhos de cache HTTP via `[ResponseCache]`, apenas quando o cache que você quer popular fica downstream: um CDN, um proxy compartilhado ou o navegador. Os dois não são tanto concorrentes quanto camadas diferentes, e a configuração de produção comum usa ambos: output caching para a cópia server-side que blinda seu banco de dados, e cabeçalhos de cache para as cópias de borda e navegador que blindam sua rede. Se você só pode escolher um, e está tentando cortar carga de servidor, escolha output caching. É o que o framework agora te direciona a usar.

## Relacionados

- [How to add output caching to a minimal API in ASP.NET Core 11](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)

## Fontes

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Response caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
