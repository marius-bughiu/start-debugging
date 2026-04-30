---
title: "Como adicionar rate limiting por endpoint no ASP.NET Core 11"
description: "Um guia completo de rate limiting por endpoint no ASP.NET Core 11: quando escolher fixed window vs sliding window vs token bucket vs concurrency, como RequireRateLimiting e [EnableRateLimiting] diferem, particionamento por usuário ou IP, o callback OnRejected, e a armadilha de implantação distribuída em que todo mundo cai."
pubDate: 2026-04-30
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "rate-limiting"
lang: "pt-br"
translationOf: "2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

Para limitar a taxa de um endpoint específico no ASP.NET Core 11, registre uma política nomeada em `AddRateLimiter`, chame `app.UseRateLimiter()` após o roteamento, e associe a política ao endpoint com `RequireRateLimiting("name")` em uma minimal API ou `[EnableRateLimiting("name")]` em uma action de MVC. O runtime traz quatro algoritmos integrados em `Microsoft.AspNetCore.RateLimiting`: fixed window, sliding window, token bucket e concurrency. O middleware retorna `429 Too Many Requests` quando uma requisição é rejeitada e expõe um callback `OnRejected` para respostas personalizadas, incluindo `Retry-After`. Este guia cobre o .NET 11 preview 3 com C# 14, mas a API está estável desde o .NET 7 e cada exemplo de código compila sem alterações no .NET 8, 9 e 10.

## Por que rate limiting "global" raramente é o que você quer

A configuração mais simples, um único limitador global que descarta requisições quando o processo inteiro está acima do orçamento, é atraente por uns dez segundos. Aí você percebe que o endpoint de login e a sonda estática de saúde compartilham esse orçamento. Uma botnet martelando `/login` vai derrubar `/health` com prazer, e seu balanceador de carga vai tirar a instância da rotação porque a sonda barata começou a retornar 429.

Rate limiting por endpoint resolve isso. Cada endpoint declara sua própria política com limites ajustados ao seu custo real: `/login` recebe um token bucket por IP apertado, `/api/search` recebe uma sliding window generosa, o endpoint de upload de arquivo recebe um limitador de concurrency, e `/health` não recebe nada. O limitador global, se você mantiver um, vira uma rede de segurança para abuso em nível de protocolo em vez da defesa principal.

O middleware `Microsoft.AspNetCore.RateLimiting` saiu de preview no .NET 7 e desde então só teve refinamentos de qualidade de vida. É parte first-class do framework no .NET 11, sem pacote NuGet adicional para instalar.

## O Program.cs mínimo

Aqui está a menor configuração que adiciona duas políticas distintas por endpoint, aplica uma a um endpoint de minimal API e deixa o resto da aplicação sem throttling.

```csharp
// .NET 11 preview 3, C# 14
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter(policyName: "search", o =>
    {
        o.PermitLimit = 30;
        o.Window = TimeSpan.FromSeconds(10);
        o.QueueLimit = 0;
    });

    options.AddTokenBucketLimiter(policyName: "login", o =>
    {
        o.TokenLimit = 5;
        o.TokensPerPeriod = 5;
        o.ReplenishmentPeriod = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
        o.AutoReplenishment = true;
    });
});

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/api/search", (string q) => Results.Ok(new { q }))
   .RequireRateLimiting("search");

app.MapPost("/api/login", (LoginRequest body) => Results.Ok())
   .RequireRateLimiting("login");

app.MapGet("/health", () => Results.Ok("ok"));

app.Run();

record LoginRequest(string Email, string Password);
```

Duas coisas para notar. Primeiro, `RejectionStatusCode` por padrão é `503 Service Unavailable`, o que é errado para quase qualquer API pública. Defina como `429` uma vez, em `AddRateLimiter`, e esqueça. Segundo, `app.UseRateLimiter()` precisa vir depois de `app.UseRouting()` se você chamar o roteamento explicitamente, porque o middleware lê os metadados do endpoint para decidir qual política se aplica. O `WebApplication` integrado adiciona o roteamento automaticamente antes de middlewares terminais, então a chamada explícita a `UseRouting` só é necessária se você tiver outro middleware que precise ficar entre o roteamento e o rate limiting.

## RequireRateLimiting vs [EnableRateLimiting]

O ASP.NET Core tem duas formas igualmente válidas de associar uma política a um endpoint, e elas existem porque minimal APIs e MVC têm histórias de metadados diferentes.

Para minimal APIs e grupos de endpoints, o método fluente `RequireRateLimiting` em `IEndpointConventionBuilder` é a chamada certa:

```csharp
// .NET 11, C# 14
var api = app.MapGroup("/api/v1").RequireRateLimiting("search");

api.MapGet("/products", (...) => ...);          // inherits "search"
api.MapGet("/orders", (...) => ...);            // inherits "search"
api.MapPost("/login", (...) => ...)
   .RequireRateLimiting("login");               // overrides to "login"
```

Metadados em nível de endpoint vencem metadados em nível de grupo, então a sobrescrita em `/login` faz o que você esperaria: apenas a política mais específica do endpoint é aplicada.

Para controllers MVC, a forma com atributo é a chamada certa:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("api/[controller]")]
[EnableRateLimiting("search")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(/* ... */);

    [HttpGet("{id}")]
    [EnableRateLimiting("hot")]    // narrower policy for a hot endpoint
    public IActionResult Get(int id) => Ok(/* ... */);

    [HttpPost("import")]
    [DisableRateLimiting]          // bypass entirely for an internal endpoint
    public IActionResult Import() => Ok();
}
```

`[EnableRateLimiting]` e `[DisableRateLimiting]` seguem as regras padrão de resolução de atributos do ASP.NET Core: nível de action vence nível de controller, e `DisableRateLimiting` sempre vence. Misturar os estilos fluente e de atributo é tranquilo, o pipeline de metadados lê os dois da mesma forma.

Um erro comum é colocar `[EnableRateLimiting]` em um endpoint de minimal API com `.WithMetadata(new EnableRateLimitingAttribute("search"))`. Funciona, mas `RequireRateLimiting("search")` é mais curto e mais claro.

## Escolhendo um algoritmo

Os quatro algoritmos integrados respondem a quatro formatos diferentes de "com que frequência é demais", e escolher errado se manifesta como picos de tráfego que furam seu limite ou usuários legítimos recebendo 429 durante rajadas normais.

**Fixed window** conta requisições em buckets de tempo não sobrepostos. `PermitLimit = 100, Window = 1s` significa até 100 requisições em cada segundo alinhado ao relógio. Barato de calcular e fácil de raciocinar, mas permite uma rajada de 200 requisições na fronteira da janela: 100 no último milissegundo de uma janela, 100 no primeiro milissegundo da próxima. Use para limites de custo onde a rajada é aceitável, ou para anti-abuso não crítico onde você não quer gastar CPU rastreando.

**Sliding window** divide a janela em segmentos e os rola para frente. `PermitLimit = 100, Window = 1s, SegmentsPerWindow = 10` significa 100 requisições em qualquer fatia de 1 segundo, avaliada em incrementos de 100ms. Elimina a rajada na fronteira ao custo de mais contabilidade por requisição. Esse é o padrão sensato para endpoints públicos de leitura.

**Token bucket** repõe `TokensPerPeriod` tokens a cada `ReplenishmentPeriod`, até `TokenLimit`. Cada requisição consome um token. Rajadas são permitidas até `TokenLimit`, depois a taxa estabiliza na taxa de reposição. Esse é o modelo certo para qualquer endpoint onde você queira permitir uma pequena rajada (um usuário logado abre cinco abas) mas limitar a taxa sustentada (nada de scraping). Login, redefinição de senha e endpoints de envio de e-mail são todos candidatos a token bucket.

**Concurrency** limita o número de requisições em voo ao mesmo tempo, independentemente da duração. `PermitLimit = 4` significa no máximo quatro requisições concorrentes; a quinta ou entra na fila ou é rejeitada. Use para endpoints que batem em um recurso lento downstream: uploads grandes de arquivos, geração de relatórios cara, ou qualquer endpoint onde o custo é tempo de relógio em um worker em vez de contagem de requisições.

As opções `QueueLimit` e `QueueProcessingOrder` são compartilhadas entre os quatro. `QueueLimit = 0` significa "rejeitar imediatamente quando estiver no limite", que é o que você quer para a maioria das APIs HTTP porque os clientes vão tentar de novo após 429 mesmo. Limites de fila não-zero fazem sentido para limitadores de concurrency onde o trabalho é curto e enfileirar por 200ms é mais barato que mandar o cliente para um loop de retry.

## Particionamento: por usuário, por IP, por tenant

Um único bucket compartilhado por endpoint raramente é o que você quer. Se `/api/search` permite 30 requisições por 10 segundos globalmente, um cliente barulhento bloqueia todo mundo. Limitadores particionados dão a cada "chave" seu próprio bucket.

A sobrecarga fluente `AddPolicy` recebe um `HttpContext` e retorna um `RateLimitPartition<TKey>`:

```csharp
// .NET 11, C# 14
options.AddPolicy("per-user-search", context =>
{
    var key = context.User.Identity?.IsAuthenticated == true
        ? context.User.FindFirst("sub")?.Value ?? "anon"
        : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
    {
        PermitLimit = 60,
        Window = TimeSpan.FromMinutes(1),
        SegmentsPerWindow = 6,
        QueueLimit = 0
    });
});
```

A factory é chamada uma vez por chave de partição. O runtime cacheia o limitador resultante em um `PartitionedRateLimiter`, então requisições subsequentes com a mesma chave reutilizam a mesma instância de limitador. O uso de memória escala com o número de chaves distintas que você acabar vendo, por isso você deveria evictar limitadores ociosos: o framework faz isso automaticamente quando um limitador fica ocioso por `IdleTimeout` (padrão de 1 minuto), mas você pode ajustar com as sobrecargas de `RateLimitPartition.GetSlidingWindowLimiter(key, factory)`.

Duas pegadinhas de particionamento:

1. **`RemoteIpAddress` é `null` atrás de um reverse proxy** a menos que você chame `app.UseForwardedHeaders()` com `ForwardedHeaders.XForwardedFor` configurado e uma lista `KnownProxies` ou `KnownNetworks`. Sem isso, toda requisição recebe a chave de partição `"unknown"` e você tem um limitador global de novo.
2. **Usuários autenticados e anônimos se misturam na mesma partição** se você só usa `sub` como chave. Use um prefixo como `"user:"` ou `"ip:"` para que um atacante deslogado não possa colidir com o bucket de um usuário real.

Para políticas mais complexas (por tenant, por API key, vários limitadores encadeados), implemente `IRateLimiterPolicy<TKey>` e registre com `options.AddPolicy<string, MyPolicy>("name")`. A interface da política te dá o mesmo método `GetPartition` mais um callback `OnRejected` no escopo daquela política.

## Personalizando a resposta de rejeição

A resposta 429 padrão é um corpo vazio sem header `Retry-After`. Isso está bom para APIs internas, mas clientes públicos (browsers, SDKs, integrações de terceiros) esperam uma dica. O callback `OnRejected` roda depois que o limitador rejeita mas antes que a resposta seja escrita:

```csharp
// .NET 11, C# 14
options.OnRejected = async (context, cancellationToken) =>
{
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)retryAfter.TotalSeconds).ToString();
    }

    context.HttpContext.Response.ContentType = "application/problem+json";
    await context.HttpContext.Response.WriteAsJsonAsync(new
    {
        type = "https://tools.ietf.org/html/rfc6585#section-4",
        title = "Too Many Requests",
        status = 429,
        detail = "Rate limit exceeded. Retry after the indicated period."
    }, cancellationToken);
};
```

Dois detalhes fáceis de errar. Primeiro, `MetadataName.RetryAfter` só é populado por limitadores de token bucket e de reposição, não por fixed window ou sliding window. Limitadores de sliding window podem calcular um retry-after a partir de `Window / SegmentsPerWindow`, mas a conta é com você. Segundo, o callback `OnRejected` roda no caminho do middleware do rate limiter, não dentro do endpoint, então acessar serviços específicos do endpoint via `context.HttpContext.RequestServices` funciona mas acessar filtros de controller ou contexto de action não funciona, eles ainda não estão vinculados.

Se você quer um `OnRejected` por política em vez de um global, implemente `IRateLimiterPolicy<TKey>` e sobrescreva `OnRejected` na política. O callback em nível de política roda além do global, então cuidado para não escrever o corpo da resposta duas vezes.

## A armadilha da implantação distribuída

Cada exemplo de código acima armazena o estado de rate limit em memória do processo. Isso está bom quando você roda uma única instância, e é catastrófico quando você escala horizontalmente. Três réplicas atrás de um balanceador de carga com `PermitLimit = 100` por 10 segundos na verdade permitem 300 requisições por 10 segundos, porque cada réplica conta independentemente. Sticky sessions só ajudam se seu hash distribuir as chaves de partição uniformemente, o que tipicamente não acontece.

Não existe um rate limiter distribuído integrado em `Microsoft.AspNetCore.RateLimiting`. As opções mantidas no .NET 11 são:

- **Empurrar o limite para o balanceador de carga.** NGINX `limit_req`, regras baseadas em taxa do AWS WAF, rate limiting do Azure Front Door, Cloudflare Rate Limiting Rules. Essa é a resposta certa para anti-abuso grosseiro na borda da rede.
- **Usar uma biblioteca apoiada em Redis.** `RateLimit.Redis` (sample da Microsoft no GitHub) e `AspNetCoreRateLimit.Redis` ambos implementam `PartitionedRateLimiter<HttpContext>` contra um sorted set do Redis ou um incremento atômico. O round-trip ao Redis adiciona 0.5-2ms por requisição, o que é aceitável para endpoints que não estão no caminho quente.
- **Combinar os dois.** A borda aplica um limite generoso; a aplicação aplica um limite por usuário no Redis; in-process fica reservado para backpressure em downstreams lentos via o limitador de concurrency.

Não implemente seu próprio limitador distribuído em cima de `IDistributedCache` e `INCRBY` a menos que tenha lido [o post do blog da Cloudflare sobre contadores deslizantes distribuídos](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) e tenha uma opinião forte sobre desvio de relógio.

## Testando endpoints com rate limit

Testes de integração com `WebApplicationFactory<TEntryPoint>` funcionam, mas o rate limiter não é resetado entre testes por padrão. Duas estratégias:

1. **Sobrescrever a política no host de teste.** Injete um limitador permissivo (`PermitLimit = int.MaxValue`) para o ambiente de teste, e escreva um conjunto separado de testes que batem no limitador explicitamente com uma política real.
2. **Desabilitar o limitador para o endpoint sob teste.** Envolva suas chamadas `MapGroup`/`RequireRateLimiting` em `if (!env.IsEnvironment("Testing"))`, ou use `[DisableRateLimiting]` em sobrescritas de teste.

O middleware também expõe `RateLimiterOptions.GlobalLimiter` para um limitador particionado de nível superior que roda em toda requisição antes das políticas por endpoint. É o lugar certo para um portão por IP do tipo "você é obviamente um bot", e o lugar certo para adicionar um header `Retry-After` em toda rejeição independentemente de qual política nomeada disparou. Não use como substituto para políticas por endpoint; os dois compõem, não substituem um ao outro.

## Quando o middleware integrado não é suficiente

O middleware cobre 90% dos casos. Os 10% restantes geralmente envolvem um destes:

- **Limites baseados em custo**: cada requisição consome N tokens dependendo do seu custo computado (uma busca com 5 facetas custa mais que uma listagem plana). O middleware não tem um hook para consumo variável de tokens, então você envolve o endpoint com uma chamada manual a `RateLimiter.AcquireAsync(permitCount)` dentro do handler.
- **Limites suaves com degradação**: em vez de retornar 429, você serve uma resposta cacheada ou subamostrada. Implemente isso no endpoint, não no middleware: cheque `context.Features.Get<IRateLimitFeature>()` (adicionado pelo middleware no .NET 9) e bifurque a partir disso.
- **Exposição de métricas por rota**: o middleware emite `aspnetcore.rate_limiting.request_lease.duration` e métricas similares via meter `Microsoft.AspNetCore.RateLimiting`. Conecte via `OpenTelemetry` para obter contagens de 429 por política no seu dashboard. Os contadores integrados não quebram por endpoint; se você precisa disso, taggue o meter você mesmo no `OnRejected`.

## Relacionado

- [Como adicionar um filtro global de exceção no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) cobre as regras de ordem do middleware que também se aplicam ao `UseRateLimiter`.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para as implicações de trim-safety de `IRateLimiterPolicy<T>`.
- [Como testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/) para o padrão de test host referenciado acima.
- [Como adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para a história da chave de partição quando API keys carregam a identidade do usuário.
- [Como gerar código cliente fortemente tipado a partir de uma especificação OpenAPI no .NET 11](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) para o lado consumidor do contrato 429.

## Fontes

- [Middleware de rate limiting no ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) no MS Learn.
- [Referência da API `Microsoft.AspNetCore.RateLimiting`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting).
- [Código fonte do pacote `System.Threading.RateLimiting`](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.RateLimiting) para as primitivas subjacentes do limitador.
- [RFC 6585 seção 4](https://www.rfc-editor.org/rfc/rfc6585#section-4) para a definição canônica de `429 Too Many Requests` e o header `Retry-After`.
