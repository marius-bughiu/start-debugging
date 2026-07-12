---
title: "Como adicionar output caching a uma Minimal API no ASP.NET Core 11"
description: "Um guia completo e funcional de output caching em uma Minimal API do ASP.NET Core 11: AddOutputCache e UseOutputCache, CacheOutput em endpoints e MapGroup, políticas nomeadas e de base, Expire, VaryByQuery e VaryByHeader, remoção por tag com EvictByTagAsync, proteção contra cache stampede, revalidação com ETag e um armazenamento de apoio no Redis."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
  - "caching"
lang: "pt-br"
translationOf: "2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Para adicionar output caching a uma Minimal API no ASP.NET Core 11 você precisa de exatamente três peças móveis: registrar os serviços com `builder.Services.AddOutputCache()`, adicionar o middleware com `app.UseOutputCache()` e marcar os endpoints que você quer em cache com `.CacheOutput()`. Isso já basta para colocar uma resposta HTTP inteira em cache na memória e devolvê-la sem reexecutar o seu handler. Tudo além disso (janelas de expiração, chaves de cache por consulta, invalidação por tag, um armazenamento de apoio no Redis) é refinamento. Este post percorre o caminho completo de ponta a ponta. Ele tem como alvo o .NET 11 (Preview 5 no momento em que este texto foi escrito, GA em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14, mas a API de output caching está estável desde o ASP.NET Core 7, então cada passo aqui funciona sem alterações no .NET 8, 9 e 10.

## Output caching não é response caching

A primeira coisa a deixar clara, porque confunde quase todo mundo: output caching e response caching são recursos diferentes que resolvem problemas diferentes.

O response caching (`AddResponseCaching`) é o middleware mais antigo. Ele participa do cache HTTP: lê e escreve os cabeçalhos `Cache-Control`, `Vary` e `Expires`, e só faz cache quando a resposta opta por isso com os cabeçalhos corretos. Ele é, na verdade, um cache de proxy compartilhado que vive dentro da sua aplicação, e é fácil de errar porque um `Set-Cookie` perdido ou um `Cache-Control: public` ausente o desativa silenciosamente.

O output caching (`AddOutputCache`, adicionado no ASP.NET Core 7) é controlado pelo servidor. O servidor decide o que colocar em cache e por quanto tempo, independentemente dos cabeçalhos de requisição do cliente. Ele suporta variação da chave de cache com base em valores arbitrários, remoção por tag para que você possa expurgar um grupo de entradas quando os dados subjacentes mudam, e proteção embutida contra cache stampede. Para uma API onde você é dono das duas pontas, o output caching é quase sempre o que você quer. Este post é inteiramente sobre output caching.

## Conecte as três peças móveis

O output caching vive no shared framework, então não há pacote NuGet para instalar no caso em memória. Registre os serviços e adicione o middleware:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/time", () => new { now = DateTime.UtcNow })
    .CacheOutput();

app.Run();
```

Três coisas a notar. Primeiro, `AddOutputCache()` e `UseOutputCache()` por si só não fazem nada: elas deixam o cache disponível, mas não colocam nada em cache até que um endpoint opte por isso. Segundo, `.CacheOutput()` sem argumentos aplica a política padrão, que faz cache por 60 segundos. Acesse `/time` duas vezes dentro de um minuto e você receberá o mesmo timestamp de volta, porque a segunda requisição nunca executa a sua lambda.

Terceiro, e este é o que causa bugs em produção: a ordem do middleware importa. `UseOutputCache()` deve ficar depois de `UseCors()`, depois de `UseAuthentication()` e depois de `UseAuthorization()`. Se ele rodar antes da autorização, o middleware pode servir uma resposta em cache para um usuário anônimo a um usuário autenticado, ou vice-versa. Em aplicações Razor Pages e controllers, ele também precisa vir depois de `UseRouting()`. O host mínimo `WebApplication` configura o roteamento para você, mas se você adicionar autenticação, a ordenação é sua responsabilidade:

```csharp
// .NET 11, C# 14 -- correct ordering with auth
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache();   // after auth, not before
```

## Defina uma janela de expiração com uma política nomeada

A janela padrão de 60 segundos raramente é o que você quer. Para controlá-la, chame `.CacheOutput()` com um builder inline, ou defina uma política nomeada uma vez e a referencie pelo nome. Políticas nomeadas mantêm o `Program.cs` legível quando vários endpoints compartilham as mesmas configurações:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddPolicy("Short", policy => policy.Expire(TimeSpan.FromSeconds(10)));
    options.AddPolicy("Long", policy => policy.Expire(TimeSpan.FromMinutes(30)));
});
```

Depois selecione uma política por endpoint pelo nome:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices).CacheOutput("Short");
app.MapGet("/catalog", GetCatalog).CacheOutput("Long");
```

Se você preferir manter a configuração ao lado do endpoint, a forma inline faz a mesma coisa sem uma política registrada:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(10)));
```

Também existe um atributo `[OutputCache]` caso você prefira atributos em um handler, que é a forma que os controllers usam. Em um endpoint de Minimal API, ele fica assim: `app.MapGet("/x", [OutputCache(PolicyName = "Short")] () => ...)`, mas o fluente `.CacheOutput("Short")` lê melhor e é a convenção que a maior parte do código de Minimal API segue.

## Faça cache de um route group inteiro de uma vez

Repetir `.CacheOutput()` em cada endpoint cansa rápido. Como `MapGroup` retorna um `RouteGroupBuilder` que compartilha convenções, você pode anexar o output caching ao grupo e cada endpoint dentro dele o herda. Isso se compõe de forma limpa com os módulos de endpoint por recurso abordados em [organizando endpoints de Minimal API com MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var catalog = app.MapGroup("/catalog")
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)).Tag("catalog"));

catalog.MapGet("/", GetAllProducts);
catalog.MapGet("/{id:int}", GetProduct);
```

Ambos os endpoints agora fazem cache por cinco minutos e carregam a tag `catalog`, o que importa para o passo de invalidação abaixo.

## Controle a chave de cache para não servir a resposta errada

Por padrão, a chave de cache é a URL completa: esquema, host, porta, caminho e a query string inteira. Isso significa que `/search?q=widgets` e `/search?q=gadgets` são entradas separadas automaticamente, o que costuma estar correto. Mas dois casos precisam de tratamento explícito.

O primeiro: você quer variar em um valor específico da query e ignorar o resto. `SetVaryByQuery` restringe a chave às chaves de query que você nomear, para que parâmetros de rastreamento como `utm_source` não fragmentem seu cache em milhares de entradas quase idênticas:

```csharp
// .NET 11, C# 14 -- cache per culture, ignore everything else in the query
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy
        .Expire(TimeSpan.FromMinutes(10))
        .SetVaryByQuery("culture"));
```

O segundo: você serve conteúdo diferente com base em um cabeçalho de requisição, como `Accept-Language` ou um cabeçalho customizado de versão de API. Use `SetVaryByHeader` para que cada valor de cabeçalho tenha sua própria entrada:

```csharp
// .NET 11, C# 14
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy.SetVaryByHeader("Accept-Language"));
```

Para qualquer coisa que a URL e os cabeçalhos não consigam expressar, `VaryByValue` permite que você calcule um fragmento de chave a partir do `HttpContext`. É assim que você varia em um id de tenant resolvido a partir de uma claim, ou em um bucket de A/B:

```csharp
// .NET 11, C# 14 -- separate cache entry per tenant
app.MapGet("/dashboard", GetDashboard)
    .CacheOutput(policy => policy.VaryByValue(context =>
        new KeyValuePair<string, string>(
            "tenant", context.User.FindFirst("tenant")?.Value ?? "public")));
```

Uma advertência com `VaryByValue` em dados específicos do usuário: por padrão, o output caching se recusa a colocar em cache respostas a requisições autenticadas, precisamente para evitar vazar a resposta de um usuário para outro. Se você deliberadamente sobrescrever esse comportamento (veja a seção de política customizada), variar por um valor por usuário é o que mantém as entradas separadas, e errar nisso é um bug de vazamento de dados, não um bug de desempenho. Trate o output caching autenticado como um caso avançado e teste-o com rigor.

## Invalide sob demanda com tags

A expiração baseada em tempo é um instrumento tosco. Se seu catálogo muda duas vezes por dia mas você faz cache por cinco minutos, você está servindo dados obsoletos por até cinco minutos toda vez e rebuscando sem propósito no resto do tempo. Tags resolvem isso: anexe uma tag às entradas de cache e depois remova por tag no momento em que os dados subjacentes mudam.

Você viu `.Tag("catalog")` no grupo acima. Para expurgá-lo, injete `IOutputCacheStore` e chame `EvictByTagAsync`. O lugar natural para isso é dentro da operação de escrita que mudou os dados, não um endpoint administrativo separado:

```csharp
// .NET 11, C# 14
app.MapPost("/catalog", async (Product product, AppDbContext db, IOutputCacheStore cache) =>
{
    db.Products.Add(product);
    await db.SaveChangesAsync();

    // The catalog changed, so drop every cached catalog response.
    await cache.EvictByTagAsync("catalog", default);

    return Results.Created($"/catalog/{product.Id}", product);
});
```

Agora o cache serve leituras instantâneas e permanece atualizado: uma expiração de cinco minutos (ou até de uma hora) é uma rede de segurança, e a invalidação real acontece exatamente quando uma escrita ocorre. Se você amarrar a chamada `EvictByTagAsync` ao mesmo `SaveChanges` que muta a linha, os leitores nunca veem dados mais antigos que a última escrita bem-sucedida. Isso combina bem com o trabalho de rastrear as consultas por trás dessas escritas; se um endpoint de leitura é lento o bastante para você recorrer a cache, vale a pena descartar primeiro uma [consulta N+1 no EF Core](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), porque colocar uma consulta lenta em cache apenas esconde o problema.

Você também pode registrar tags de forma declarativa em uma política de base, o que aplica tag a cada endpoint correspondente sem tocar em cada um deles:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy
        .With(c => c.HttpContext.Request.Path.StartsWithSegments("/catalog"))
        .Tag("catalog"));
});
```

## Políticas de base se aplicam a tudo por padrão

`AddBasePolicy` difere de `AddPolicy` em um aspecto importante: uma política de base se aplica a todos os endpoints (ou a todos os endpoints que correspondem ao seu predicado `With`) sem nenhuma chamada `.CacheOutput()` no endpoint. É assim que você define um esquema padrão de expiração ou de tags para a aplicação inteira:

```csharp
// .NET 11, C# 14 -- cache everything for 30 seconds unless overridden
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Seja deliberado aqui. Uma política de base abrangente vai alegremente colocar em cache endpoints que você nunca pretendeu cachear. Delimite-a com `.With(...)` a um prefixo de caminho, ou prefira chamadas explícitas `.CacheOutput()` por endpoint se sua API mistura leituras cacheáveis e escritas não cacheáveis, o que a maioria faz.

## O que a política padrão vai e não vai cachear

Mesmo depois de você habilitar um endpoint, o output caching aplica salvaguardas. Sem configuração adicional, ele só faz cache quando:

- O status da resposta é `HTTP 200`.
- O método da requisição é `GET` ou `HEAD`.
- A resposta não define cookies (qualquer `Set-Cookie` desativa o cache para aquela resposta).
- A requisição não é autenticada.

Essas regras são o motivo de `.CacheOutput()` em um endpoint `POST` parecer não fazer nada: `POST` é excluído por padrão. Elas existem para impedir que você cacheie algo inseguro por acidente. Se você genuinamente precisa cachear um `POST`, ou cachear respostas `301`, ou cachear respostas autenticadas, você escreve uma `IOutputCachePolicy` customizada e habilita explicitamente:

```csharp
// .NET 11, C# 14 -- excerpt of a custom policy that allows POST
public sealed class CachePostPolicy : IOutputCachePolicy
{
    public static readonly CachePostPolicy Instance = new();

    ValueTask IOutputCachePolicy.CacheRequestAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
    {
        var request = context.HttpContext.Request;
        var attempt = HttpMethods.IsGet(request.Method)
                   || HttpMethods.IsHead(request.Method)
                   || HttpMethods.IsPost(request.Method);

        context.EnableOutputCaching = true;
        context.AllowCacheLookup = attempt;
        context.AllowCacheStorage = attempt;
        context.AllowLocking = true;
        context.CacheVaryByRules.QueryKeys = "*";
        return ValueTask.CompletedTask;
    }

    ValueTask IOutputCachePolicy.ServeFromCacheAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    ValueTask IOutputCachePolicy.ServeResponseAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;
}
```

Registre-a como uma política nomeada com `options.AddPolicy("CachePost", CachePostPolicy.Instance)` e selecione-a com `.CacheOutput("CachePost")`. Cachear um `POST` é incomum e você deve ter um motivo específico, mas o ponto de extensão está lá.

## A proteção contra stampede está ativada por padrão

Quando uma entrada de cache quente expira e cem requisições chegam ao mesmo tempo, um cache ingênuo deixa todas as cem falharem e martelarem seu banco de dados simultaneamente. Isso é um cache stampede, ou thundering herd. O output caching mitiga isso com bloqueio de recurso: quando uma entrada está sendo gerada, requisições concorrentes para a mesma chave esperam a primeira terminar em vez de cada uma gerar a sua própria. Isso está ativado por padrão e é uma das vantagens concretas sobre código artesanal com `IMemoryCache`, que não faz isso a menos que você mesmo construa.

Você pode desativar o bloqueio por política com `SetLocking(false)` se um endpoint é barato de gerar e você preferiria não ter requisições esperando:

```csharp
// .NET 11, C# 14
app.MapGet("/cheap", GetCheapThing)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(5)).SetLocking(false));
```

Deixe ativado para qualquer coisa cara. A proteção contra stampede é exatamente o que você quer sob carga, e é a mesma classe de problema que o [HybridCache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) resolve para cache de dados em vez de cache de resposta inteira.

## Revalidação barata com ETags

O output caching também coopera com requisições condicionais do HTTP. Se seu handler define um cabeçalho `ETag`, o middleware responderá um `If-None-Match` correspondente com um `304 Not Modified` e um corpo vazio em vez de reenviar o payload inteiro. Para uma resposta grande servida a um cliente que já a tem, isso transforma uma transferência completa em alguns bytes:

```csharp
// .NET 11, C# 14
app.MapGet("/report", async (HttpContext context) =>
{
    context.Response.Headers.ETag = $"\"{ComputeReportVersion()}\"";
    await WriteReport(context);
}).CacheOutput();
```

Nenhuma configuração extra é necessária além de habilitar o output caching. O mesmo funciona com `If-Modified-Since` em relação ao horário de criação da entrada de cache.

## Ajuste os limites e, quando escalar horizontalmente, migre para o Redis

Dois limites de `OutputCacheOptions` valem a pena conhecer antes de você entrar em produção. `MaximumBodySize` tem padrão de 64 MB: uma resposta maior que isso nunca é colocada em cache, o que é um padrão sensato mas silencioso se você se perguntou por que uma exportação grande nunca é cacheada. `SizeLimit` tem padrão de 100 MB de armazenamento total de cache, depois do qual novas entradas esperam as antigas serem removidas. `DefaultExpirationTimeSpan` são os 60 segundos que você recebe quando uma política não define um `Expire` explícito.

O armazenamento padrão é a memória em processo, o que significa que cada instância do servidor tem seu próprio cache e ele evapora ao reiniciar. Atrás de um balanceador de carga com várias instâncias, isso costuma ser aceitável para endpoints de muita leitura, mas significa que uma remoção por `tag` em um nó não limpa os outros. Quando você precisa de um cache compartilhado que sobrevive a reinícios e remove de forma consistente entre os nós, adicione o armazenamento no Redis. É um pacote separado:

```bash
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp";
});

builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Note que o método é `AddStackExchangeRedisOutputCache`, não o método de nome parecido `AddStackExchangeRedisCache` usado para `IDistributedCache`. Essa distinção importa, porque a Microsoft recomenda explicitamente não apoiar o output caching em um `IDistributedCache` simples: essa interface não tem as operações atômicas de que a remoção por tag depende, então as tags não removeriam de forma confiável. Use o armazenamento de output cache no Redis embutido ou um `IOutputCacheStore` customizado, não `IDistributedCache`.

## O formato para memorizar

O output caching em uma Minimal API se resume a um conjunto pequeno e componível de peças. Registre com `AddOutputCache`, insira `UseOutputCache` depois do seu middleware de autenticação, e habilite endpoints com `.CacheOutput()` ou um `.CacheOutput()` no nível do grupo. Recorra a `Expire` para definir a janela, `SetVaryByQuery` e `SetVaryByHeader` para manter as chaves corretas, e `Tag` mais `EvictByTagAsync` para invalidar no instante em que seus dados mudam, em vez de esperar um temporizador. Deixe a proteção contra stampede ativada para trabalho caro, respeite as salvaguardas padrão que mantêm respostas autenticadas e com cookies fora do cache, e troque o armazenamento em memória pelo Redis somente quando você de fato roda mais de uma instância. Isso cobre a grande maioria das APIs reais, e cada linha acima roda no .NET 8 até o .NET 11 sem alterações.

## Relacionados

- [Como organizar endpoints de Minimal API com MapGroup no ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como usar HybridCache no ASP.NET Core 11 com o Redis como cache L2](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache no .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [Como detectar consultas N+1 no EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Como adicionar rate limiting por endpoint no ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)

## Fontes

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [IOutputCacheStore.EvictByTagAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.ioutputcachestore.evictbytagasync)
- [OutputCachePolicyBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.outputcachepolicybuilder)
