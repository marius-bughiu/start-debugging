---
title: "Como remover ou ocultar endpoints individuais que o MapIdentityApi mapeia no ASP.NET Core"
description: "MapIdentityApi<TUser>() mapeia dez endpoints e não tem nenhuma opção para pular um deles. Estas são quatro formas medidas de lidar com isso no .NET 11: ocultar um endpoint do OpenAPI, fazê-lo retornar 404, sobrepô-lo ou removê-lo completamente do roteamento, além da armadilha do /confirmEmail que transforma o registro em um 500."
pubDate: 2026-10-17
template: how-to
tags:
  - "aspnetcore"
  - "aspnetcore-11"
  - "identity"
  - "minimal-apis"
  - "openapi"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/10/how-to-remove-or-hide-individual-endpoints-that-mapidentityapi-maps-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-17
---

**Resposta curta:** `MapIdentityApi<TUser>()` não tem nenhum parâmetro para escolher endpoints, e isso continua valendo no .NET 11 RC 2. O que você recebe de volta é um `IEndpointConventionBuilder`, cujas convenções rodam em cada endpoint com o padrão de rota final já disponível, então você pode identificar `/register` ou `/manage/2fa` pelo padrão. Para ocultar um endpoint apenas do documento OpenAPI, adicione `ExcludeFromDescriptionAttribute` em uma convenção. Para torná-lo inutilizável, substitua também `EndpointBuilder.RequestDelegate` por um que retorne 404. Para removê-lo completamente do roteamento, mapeie o Identity em um `IEndpointRouteBuilder` privado e reexponha seus endpoints por meio de um `EndpointDataSource` filtrante (cerca de 30 linhas, mostradas abaixo). Nunca remova `/confirmEmail` enquanto `/register` ou `/resendConfirmationEmail` estiverem ativos: ambos lançam `NotSupportedException` e retornam 500.

Tudo abaixo foi executado no macOS com o SDK 11.0.100-rc.1.26425.128, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0.0-rc.1.26425.128 e um store InMemory do EF Core. Comparei `IdentityApiEndpointRouteBuilderExtensions.cs` entre as tags `v8.0.0`, `v11.0.0-rc.1.26425.128` e `v11.0.0-rc.2.26504.105`: a lista de rotas é idêntica nas três, e o arquivo não mudou entre o RC 1 e o RC 2, então as técnicas se aplicam ao .NET 8, 9, 10 e 11.

## Por que não existe uma forma nativa de pular um endpoint

`MapIdentityApi<TUser>()` é um único método de extensão que cria um grupo de rotas vazio e mapeia tudo dentro dele:

| Método | Rota | Exige autenticação |
| --- | --- | --- |
| POST | `/register` | não |
| POST | `/login` | não |
| POST | `/refresh` | não |
| GET | `/confirmEmail` | não |
| POST | `/resendConfirmationEmail` | não |
| POST | `/forgotPassword` | não |
| POST | `/resetPassword` | não |
| POST | `/manage/2fa` | sim |
| GET | `/manage/info` | sim |
| POST | `/manage/info` | sim |

Em seguida, o código-fonte envolve o grupo em um tipo privado `IdentityEndpointsConventionBuilder`, com um comentário dizendo que faz isso "to avoid a potential future behavioral breaking change". Você não consegue converter o valor de retorno de volta para `RouteGroupBuilder`, e os handlers são lambdas dentro do método, então também não dá para chamá-los você mesmo.

O pedido para dividi-lo está aberto desde 2024 como [dotnet/aspnetcore#55792](https://github.com/dotnet/aspnetcore/issues/55792) ("Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled"), e o [dotnet/aspnetcore#50303](https://github.com/dotnet/aspnetcore/issues/50303), mais amplo, sobre extensibilidade remonta às previews do .NET 8. Ambos estão no milestone Backlog. Até que um deles seja entregue, os motivos usuais que levam as pessoas a esbarrar nisso (o cadastro público precisa ficar desligado, a 2FA é tratada em outro lugar, o documento OpenAPI não deve anunciar a redefinição de senha) precisam ser tratados todos pelo lado de fora.

## O ambiente de teste

Este é o app em que cada variante abaixo se encaixa. Os endpoints do Identity ficam em `/account`, porque é assim que a maioria dos apps reais os monta e porque isso afeta como você identifica as rotas:

```csharp
// .NET 11 RC 1, Microsoft.AspNetCore.Identity.EntityFrameworkCore 11.0.0-rc.1.26425.128
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ids"));
builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var account = app.MapGroup("/account");
account.MapIdentityApi<IdentityUser>();

app.Run();

class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);
```

Sem nenhuma alteração, `/openapi/v1.json` lista as dez rotas em `/account`, `POST /account/register` retorna 200 e um `POST /account/manage/2fa` anônimo retorna 401.

Um detalhe importa para todas as técnicas abaixo: dentro de uma convenção, `RouteEndpointBuilder.RoutePattern.RawText` é o padrão **final**, com o prefixo do grupo incluído. Registrá-lo em log a partir de uma convenção imprime `/account/register`, `/account/manage/2fa` e assim por diante, não `/register`. O próprio Identity depende disso ao nomear o endpoint de confirmação de e-mail. Portanto, compare com `EndsWith` ou com o caminho completo com prefixo:

```csharp
// .NET 11 RC 1
string[] blocked = ["/register", "/manage/2fa"];

bool IsBlocked(EndpointBuilder b) =>
    b is RouteEndpointBuilder rb &&
    blocked.Any(p => rb.RoutePattern.RawText!.EndsWith(p, StringComparison.OrdinalIgnoreCase));
```

## Opção 1: ocultar um endpoint apenas do documento OpenAPI

Se o endpoint deve continuar funcionando, mas ficar fora do seu contrato publicado (comum para `/refresh` ou `/manage/info` em um documento de API público), adicione o mesmo metadado que `.ExcludeFromDescription()` adiciona:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (IsBlocked(b))
        b.Metadata.Add(new ExcludeFromDescriptionAttribute());
});
```

Resultado medido: `/account/register` e `/account/manage/2fa` desaparecem de `/openapi/v1.json`, e `POST /account/register` continua retornando 200. Esse é o objetivo desta opção, e também o seu limite. Ocultar é documentação, não controle de acesso. Qualquer pessoa que tenha lido a documentação do Identity sabe que a rota existe.

`ExcludeFromDescriptionAttribute` fica em `Microsoft.AspNetCore.Routing` e implementa `IExcludeFromDescriptionMetadata`, que tanto o gerador embutido `Microsoft.AspNetCore.OpenApi` quanto o API explorer do Swashbuckle respeitam. Se preferir manter tudo isso em um só lugar, você pode fazer a mesma filtragem em um document transformer, como mostrado no [post sobre transformers de operação e de schema do OpenAPI](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/), mas a abordagem por metadado é mais simples e também cobre outros consumidores do API explorer.

## Opção 2: manter a rota, mas fazê-la retornar 404

Para realmente desligar um endpoint, substitua o request delegate dele na mesma convenção. As convenções recebem o `EndpointBuilder` antes de o `RouteEndpoint` ser construído, e `RequestDelegate` é uma propriedade com setter:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (!IsBlocked(b)) return;

    b.Metadata.Add(new ExcludeFromDescriptionAttribute());
    b.RequestDelegate = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    };
});
```

Resultado medido: `POST /account/register` retorna 404, ambas as rotas somem do documento OpenAPI, e todos os outros endpoints se comportam como antes. Obtive o mesmo resultado com `.Finally(...)` no lugar de `.Add(...)`. As convenções `Finally` rodam depois de todas as outras, o que é a escolha mais segura se algo mais no seu pipeline também mexer em `RequestDelegate`.

O problema é que o endpoint ainda existe para o roteamento e a autorização. Ele mantém todos os seus metadados, incluindo o `RequireAuthorization()` que o Identity coloca no grupo `/manage`. O middleware de autorização roda antes do delegate do endpoint, então um `POST /account/manage/2fa` anônimo ainda retorna **401**, não 404. Apenas chamadores autenticados chegam ao seu 404. Se o objetivo é "não revelar que isso existe", essa diferença é visível de fora.

Um [endpoint filter](/pt-br/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/) leva ao mesmo resultado, porque `AddEndpointFilter` funciona em qualquer `IEndpointConventionBuilder`:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().AddEndpointFilter(async (ctx, next) =>
{
    var route = (ctx.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    if (blocked.Any(p => route.EndsWith(p))) return Results.NotFound();
    return await next(ctx);
});
```

Ele também retornou 404 para `/account/register`, mas aqui é estritamente pior: o filtro roda em toda requisição do Identity, os endpoints continuam no documento OpenAPI a menos que você adicione também o metadado, e o model binding do corpo da requisição já aconteceu quando o filtro roda. A [comparação entre endpoint filters e middleware](/pt-br/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) explica essa ordem com mais detalhes. Use a troca do delegate.

## Opção 3: sobrepor a rota com um endpoint de maior prioridade

Muitas respostas online sugerem mapear seu próprio endpoint na mesma rota. Mapeado de forma ingênua, com `account.MapPost("/register", () => Results.NotFound())` depois de `MapIdentityApi`, isso não tem utilidade: eu esperava uma `AmbiguousMatchException`, mas um `POST /account/register` em JSON ainda retornou 200 do handler do Identity. O endpoint do Identity faz bind de um parâmetro `[FromBody]`, então carrega metadados de accepts `application/json`, e a matcher policy de content-type o classifica acima do seu endpoint, que não declara nada. Seu endpoint nunca roda, em silêncio. Dê a ele um `Order` menor e o matcher o prefere antes de qualquer desempate:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>();
account.MapPost("/register", () => Results.NotFound())
    .WithOrder(-1)
    .ExcludeFromDescription();
```

Resultado medido: `POST /account/register` retorna 404, e a lista de endpoints agora contém tanto `POST /account/register order=0` quanto `POST /account/register order=-1`. O endpoint original continua no documento OpenAPI, porque `ExcludeFromDescription()` se aplica apenas ao seu endpoint sobreposto. Você precisa da opção 1 por cima para ocultá-lo.

A sobreposição é a ferramenta certa quando você quer **substituir** um endpoint em vez de removê-lo, por exemplo um `/register` que também exige um código de convite, enquanto o resto de `MapIdentityApi` continua padrão. Para uma remoção simples, é a mais bagunçada das quatro opções.

## Opção 4: remover endpoints do roteamento por completo

Para fazer um endpoint realmente não existir (sem rota, sem entrada no OpenAPI, sem 401 para chamadores anônimos, apenas o mesmo 404 de qualquer URL desconhecida), você precisa impedir que o `RouteEndpoint` dele chegue ao sistema de roteamento. `MapIdentityApi` usa apenas dois membros do `IEndpointRouteBuilder` que você passa: `ServiceProvider`, para resolver seus serviços, e `DataSources`, onde `MapGroup("")` adiciona sua fonte de endpoints. Isso lhe dá um ponto de apoio:

1. Passe para `MapIdentityApi` um pequeno `IEndpointRouteBuilder` seu, cuja coleção `DataSources` seja privada.
2. Envolva essa coleção privada em um `EndpointDataSource` que descarta os endpoints indesejados.
3. Adicione o wrapper aos `DataSources` do construtor de rotas real.

```csharp
// .NET 11 RC 1, works the same on .NET 8, 9 and 10
using Microsoft.Extensions.Primitives;

static class IdentityApiExceptExtensions
{
    public static IEndpointConventionBuilder MapIdentityApiExcept<TUser>(
        this IEndpointRouteBuilder endpoints, params string[] excludedRoutes)
        where TUser : class, new()
    {
        var capture = new CapturingRouteBuilder(endpoints);
        var conventions = capture.MapIdentityApi<TUser>();

        bool Keep(Endpoint e) =>
            e is not RouteEndpoint re ||
            !excludedRoutes.Any(r =>
                re.RoutePattern.RawText!.EndsWith(r, StringComparison.OrdinalIgnoreCase));

        endpoints.DataSources.Add(new FilteringEndpointDataSource(capture.DataSources, Keep));
        return conventions;
    }

    private sealed class CapturingRouteBuilder(IEndpointRouteBuilder inner) : IEndpointRouteBuilder
    {
        public ICollection<EndpointDataSource> DataSources { get; } = new List<EndpointDataSource>();
        public IServiceProvider ServiceProvider => inner.ServiceProvider;
        public IApplicationBuilder CreateApplicationBuilder() => inner.CreateApplicationBuilder();
    }

    private sealed class FilteringEndpointDataSource(
        ICollection<EndpointDataSource> sources, Func<Endpoint, bool> keep) : EndpointDataSource
    {
        private readonly CompositeEndpointDataSource _inner = new(sources);

        public override IReadOnlyList<Endpoint> Endpoints =>
            _inner.Endpoints.Where(keep).ToList();

        public override IReadOnlyList<Endpoint> GetGroupedEndpoints(RouteGroupContext context) =>
            _inner.GetGroupedEndpoints(context).Where(keep).ToList();

        public override IChangeToken GetChangeToken() => _inner.GetChangeToken();
    }
}
```

O uso é uma mudança de uma linha:

```csharp
// .NET 11 RC 1
var account = app.MapGroup("/account");
account.MapIdentityApiExcept<IdentityUser>("/register", "/manage/2fa");
```

Resultado medido: a lista de endpoints tem oito entradas em vez de dez, `/openapi/v1.json` lista oito caminhos, e tanto `POST /account/register` quanto um `POST /account/manage/2fa` anônimo retornam 404. Os outros oito endpoints funcionam como antes, e o construtor de convenções retornado ainda se aplica a eles, então `.RequireRateLimiting(...)` ou `.WithTags(...)` encadeados no resultado se comportam normalmente.

Duas partes desse código são fáceis de errar:

- **Sobrescreva `GetGroupedEndpoints`.** Quando você chama a extensão em um grupo como `account`, o grupo externo não lê `Endpoints`. Ele chama `GetGroupedEndpoints` com o prefixo e as convenções do grupo. Delegar essa chamada às fontes internas permite que elas construam cada endpoint uma única vez, com o prefixo completo e todas as convenções aplicadas, em vez de depender de a classe base reembrulhar endpoints que já tinham sido construídos sem o prefixo. É também por isso que `RawText` já traz `/account` quando `Keep` roda.
- **Repasse o change token.** Os endpoints do Identity são estáticos, mas retornar um token real do composite interno mantém o data source correto caso algo mais venha a adicionar endpoints à coleção capturada.

Isso depende de `MapIdentityApi` usar apenas `ServiceProvider` e `DataSources`. Isso é verdade em todas as versões do 8.0 ao 11 RC 2, mas é um detalhe de implementação. Uma versão futura que, por exemplo, chamasse `CreateApplicationBuilder()` ainda funcionaria por meio da delegação acima. Uma que mapeie para algum outro construtor não funcionaria. Um teste que verifique a lista de rotas esperada (o dump de `IEnumerable<EndpointDataSource>` que usei tem três linhas) vai detectar isso na atualização.

## A armadilha do `/confirmEmail`

O único endpoint que você não pode remover isoladamente é `GET /confirmEmail`. `/register`, `/resendConfirmationEmail` e o ramo de troca de e-mail de `POST /manage/info` geram o link de confirmação pelo nome do endpoint, com `LinkGenerator.GetUriByName`. O nome é atribuído em uma convenção `Finally` em `/confirmEmail`, como `MapIdentityApi-` seguido do padrão de rota final.

Com a opção 4 e `MapIdentityApiExcept<IdentityUser>("/confirmEmail")`, a convenção ainda roda (o endpoint é construído e depois filtrado), então o nome é definido, mas o gerador de links não encontra nenhum endpoint com esse nome. O registro então falha:

```text
System.NotSupportedException: Could not find endpoint named 'MapIdentityApi-/account/confirmEmail'.
```

Resultado medido: `POST /account/register` retorna **500** e `POST /account/resendConfirmationEmail` também, enquanto `/login` continua funcionando. Se você não quer confirmação de e-mail por esta API, remova `/register` e `/resendConfirmationEmail` junto com `/confirmEmail`, ou mantenha `/confirmEmail` roteado e apenas oculte-o do OpenAPI com a opção 1.

A opção 2 não tem esse problema, porque o endpoint continua existindo para a geração de links. Ele apenas responde 404.

## Qual opção usar

- **O endpoint está ok, só não deve aparecer no documento publicado:** opção 1.
- **O endpoint não deve funcionar, e um 401 para chamadores anônimos em `/manage/*` é aceitável:** opção 2 com a troca do delegate em `Finally`. São poucas linhas e não depende de detalhes internos do Identity.
- **O endpoint não deve existir de forma alguma:** opção 4.
- **Você precisa de uma implementação diferente de um endpoint:** opção 3, mais a opção 1 para ocultar o original.
- **Você precisa mudar o comportamento dentro de vários endpoints** (campos extras no registro, login por nome de usuário, respostas de token diferentes): copie [`IdentityApiEndpointRouteBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) para o seu projeto e edite. Ele tem licença MIT, cerca de 490 linhas, e os DTOs de requisição e resposta que ele usa (`RegisterRequest`, `LoginRequest`, `AccessTokenResponse` e assim por diante) são tipos públicos em `Microsoft.AspNetCore.Identity.Data`. Você perde as correções automáticas de futuras atualizações do framework, então acompanhe o histórico do arquivo ao atualizar.

Se você já está no ponto de substituir vários endpoints, compare antes os prós e contras em [JWT vs autenticação por cookie no ASP.NET Core 11](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/). Os bearer tokens que o `MapIdentityApi` emite são tokens opacos do Data Protection, não JWTs, e esse costuma ser o verdadeiro motivo pelo qual uma equipe supera esses endpoints.

## Armadilhas

- **Compare a rota completa, ou use `EndsWith` com cuidado.** `EndsWith("/info")` corresponde tanto a `GET` quanto a `POST /manage/info`. Se você só quer bloquear o `POST` (é ele que pode alterar o e-mail e a senha), verifique também `b.Metadata.OfType<HttpMethodMetadata>()` na convenção, ou `re.Metadata.GetMetadata<HttpMethodMetadata>()` na opção 4.
- **`/login` e `/refresh` andam juntos.** Remover `/refresh` e manter `/login` deixa os clientes com um `refreshToken` que eles nunca poderão usar. O [passo a passo de refresh tokens](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) cobre o que `/refresh` realmente valida.
- **Remover `/register` não impede a criação de contas.** `UserManager<TUser>.CreateAsync` continua disponível para o seu próprio código, e fluxos de login externo ainda podem criar usuários. Bloquear o endpoint remove apenas a rota anônima de cadastro público.
- **Não parta primeiro para middleware baseado em caminho.** Um middleware que retorna 404 para caminhos que começam com `/account/register` funciona, mas fixa o prefixo do grupo no código, roda em todas as requisições do app e deixa a entrada do OpenAPI no lugar. As convenções de endpoint conhecem o padrão final e rodam uma única vez, quando os endpoints são construídos.
- **Monte o Identity em seu próprio grupo.** Chamar `MapIdentityApi` diretamente em `app` coloca `/login` e `/register` na raiz da sua API. Um grupo dedicado, como descrito em [organizando endpoints de minimal API com `MapGroup`](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), também permite aplicar rate limiting e tags apenas ao Identity.

## Relacionado

- [Como implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/), incluindo quando `MapIdentityApi` deixa de ser suficiente.
- [Como organizar endpoints de minimal API com `MapGroup` no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como personalizar o OpenAPI com transformers de operação e de schema no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Endpoint filters vs middleware no ASP.NET Core 11](/pt-br/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [JWT vs autenticação por cookie no ASP.NET Core 11](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)

## Fontes

- [`IdentityApiEndpointRouteBuilderExtensions.cs` em `v11.0.0-rc.2.26504.105`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.2.26504.105/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs), dotnet/aspnetcore.
- [dotnet/aspnetcore#55792: Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled](https://github.com/dotnet/aspnetcore/issues/55792)
- [dotnet/aspnetcore#50303: Extensibility for Identity Endpoints](https://github.com/dotnet/aspnetcore/issues/50303)
- [Use Identity to secure a Web API backend for SPAs](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization), Microsoft Learn.
- [Route groups and endpoint conventions in minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers#route-groups), Microsoft Learn.
- [`EndpointDataSource` class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.routing.endpointdatasource), Microsoft Learn.
