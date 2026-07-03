---
title: "Como configurar autenticação JWT bearer em uma minimal API no ASP.NET Core 11"
description: "Uma configuração completa e funcional de autenticação JWT bearer em uma minimal API do ASP.NET Core 11: instalar o pacote, conectar AddAuthentication().AddJwtBearer(), emitir um token, proteger endpoints com RequireAuthorization, adicionar políticas de role e de claim, e testar tudo com dotnet user-jwts."
pubDate: 2026-07-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "jwt"
  - "security"
lang: "pt-br"
translationOf: "2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Para proteger uma minimal API no ASP.NET Core 11 com tokens JWT bearer você precisa de três partes: registrar o handler bearer com `builder.Services.AddAuthentication().AddJwtBearer()`, dizer a ele como é um token válido (issuer, audience, chave de assinatura) e marcar os endpoints que você quer proteger com `.RequireAuthorization()`. O host `WebApplication` conecta o middleware de autenticação e autorização para você, então uma configuração mínima é de fato um punhado de linhas. Este artigo percorre o caminho completo do início ao fim: o pacote, a configuração, a emissão de um token, a proteção de endpoints, as políticas de role e de claim, e o teste com `dotnet user-jwts`. Ele mira o .NET 11 (Preview 5 no momento da escrita, GA em novembro de 2026) com `Microsoft.AspNetCore.Authentication.JwtBearer` e C# 14, mas cada passo aqui funciona sem alterações desde o .NET 8.

## Instale o único pacote de que você precisa

O suporte bearer não está no framework compartilhado por padrão. Adicione o pacote:

```bash
# .NET 11 SDK
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Isso traz o `JwtBearerHandler`, os métodos de extensão `AddJwtBearer` e a pilha de tokens do `Microsoft.IdentityModel` que de fato valida o token. Você não precisa do `System.IdentityModel.Tokens.Jwt` separadamente para a validação; o handler usa internamente o `JsonWebTokenHandler`, mais rápido. Você vai querer um tipo de criação de tokens quando emitir tokens você mesmo, algo coberto mais adiante.

## A menor configuração que autentica e autoriza

Aqui está um `Program.cs` completo que registra o esquema bearer, expõe um endpoint aberto e um endpoint protegido:

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
using System.Security.Claims;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication()
    .AddJwtBearer(); // reads options from configuration, see below

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapGet("/", () => "public, no token needed");

app.MapGet("/me", (ClaimsPrincipal user) => $"hello {user.Identity!.Name}")
    .RequireAuthorization();

app.Run();
```

Vale a pena destacar duas coisas, porque elas fazem tropeçar quem vem do antigo modelo `Startup.cs`.

Primeiro, não há nenhum `app.UseAuthentication()` nem `app.UseAuthorization()` naquele arquivo, e mesmo assim funciona. No modelo de hosting mínimo, o `WebApplication` inspeciona o contêiner de serviços em tempo de build e, se enxergar registrados os serviços de autenticação e autorização, insere ambos os middleware na ordem correta para você. Você só precisa chamar `UseAuthentication` e `UseAuthorization` na mão quando precisar controlar a ordem em relação a outro middleware, sendo o caso clássico o CORS, que tem que rodar primeiro. Se uma SPA de navegador chamar esta API de outra origem, leia [como configurar CORS para uma API protegida com JWT](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) antes de supor que a fiação de auth está errada; um preflight que come o cabeçalho fica idêntico a um token ruim.

Segundo, `AddJwtBearer()` sem lambda não está incompleto. Ele carrega seus `TokenValidationParameters` a partir da configuração, sob a seção `Authentication:Schemes:Bearer`. Esse é o padrão moderno, orientado a configuração, e é exatamente o que o `dotnet user-jwts` escreve para você.

## Onde vivem as regras do token: configuração vs código

Você pode dizer ao handler como é um token válido em dois lugares. Escolha um e seja consistente.

A abordagem **orientada a configuração** mantém issuer e audience fora do seu código e no `appsettings.json`. O framework procura sob `Authentication:Schemes:{SchemeName}`, e o nome de esquema padrão para `AddJwtBearer()` é `Bearer`:

```json
{
  "Authentication": {
    "Schemes": {
      "Bearer": {
        "ValidIssuer": "https://my-api.example.com",
        "ValidAudiences": [ "https://localhost:7259" ]
      }
    }
  }
}
```

A abordagem **orientada a código** define os mesmos valores no lambda, à qual você recorrerá quando assinar tokens com sua própria chave simétrica:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.Tokens;
using System.Text;

var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "https://localhost:7259",

            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
        };
    });
```

Se seus tokens vêm de um provedor OpenID Connect externo (Entra ID, Auth0, Keycloak, Okta, Duende IdentityServer), você pula a chave de assinatura por completo e define `options.Authority`, e o handler descobre o issuer e as chaves públicas de assinatura a partir dos metadados `/.well-known/openid-configuration` do provedor. O detalhamento completo do que cada flag `Validate*` faz, e a armadilha dos cinco minutos de `ClockSkew` que faz os tokens viverem além do seu `exp`, está em [como validar o issuer, audience e lifetime de um JWT](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). Para este guia de configuração, o ponto-chave é que atribuir um novo objeto `TokenValidationParameters` substitui os padrões por inteiro, então liste cada flag que importa para você.

## Defina um esquema padrão, ou um [Authorize] simples não faz nada

`RequireAuthorization()` (e o atributo `[Authorize]`) desafia o esquema de autenticação *padrão*. `AddAuthentication()` sem argumento registra serviços mas não define um padrão. Se você deixar assim, um endpoint protegido não tem esquema para rodar, o usuário permanece anônimo e cada requisição responde 401 mesmo com um token perfeito. Nomear o esquema resolve:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication.JwtBearer;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
```

`JwtBearerDefaults.AuthenticationScheme` é a string `"Bearer"`. Passá-la para `AddAuthentication` define de uma vez `DefaultAuthenticateScheme` e `DefaultChallengeScheme` em uma única chamada, então um `.RequireAuthorization()` simples agora sabe que deve rodar o handler bearer. Quando você registra um *único* esquema bearer, este é o padrão correto. Essa família de bugs de "401 silencioso com um token válido", esquema padrão ausente, ordem de middleware errada, nome de esquema desalinhado, é comum o suficiente para ter seu próprio guia: [por que seu JWT do ASP.NET Core retorna 401 mesmo com um token válido](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Emita um token de um endpoint de login

Se sua API é sua própria fonte de identidade, você precisa de um endpoint que entregue tokens assinados após verificar uma credencial. Use `JsonWebTokenHandler.CreateToken` com um `SecurityTokenDescriptor`:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using System.Security.Claims;
using System.Text;

app.MapPost("/login", (LoginRequest req, IConfiguration config) =>
{
    // Replace with a real credential check against your user store.
    if (req is not { Username: "demo", Password: "demo" })
        return Results.Unauthorized();

    var key = new SymmetricSecurityKey(
        Encoding.UTF8.GetBytes(config["Jwt:Secret"]!));

    var descriptor = new SecurityTokenDescriptor
    {
        Issuer = "https://my-api.example.com",
        Audience = "https://localhost:7259",
        Expires = DateTime.UtcNow.AddMinutes(15),
        SigningCredentials = new SigningCredentials(
            key, SecurityAlgorithms.HmacSha256),
        Subject = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.Name, req.Username),
            new Claim(ClaimTypes.Role, "user"),
        }),
    };

    var token = new JsonWebTokenHandler().CreateToken(descriptor);
    return Results.Ok(new { access_token = token });
});

record LoginRequest(string Username, string Password);
```

O segredo HMAC deve ter no mínimo 256 bits (32 bytes) para `HS256`, ou a camada de assinatura lança `IDX10720`. Mantenha-o fora do código-fonte: use user secrets em desenvolvimento (`dotnet user-secrets set "Jwt:Secret" "<a-long-random-string>"`) e um cofre de segredos real em produção. Este é um token de acesso autoemitido com um lifetime de 15 minutos; quando você quiser que o cliente permaneça autenticado além disso sem reinserir credenciais, combine-o com um fluxo de refresh como descrito em [como implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/).

## Proteja endpoints e leia os claims de quem chama

`.RequireAuthorization()` sem argumento significa "qualquer usuário autenticado". Dentro do handler, injete `ClaimsPrincipal` para ler quem está chamando:

```csharp
// .NET 11, C# 14
app.MapGet("/orders", (ClaimsPrincipal user) =>
{
    var name = user.Identity!.Name;               // ClaimTypes.Name
    var isAdmin = user.IsInRole("admin");         // ClaimTypes.Role
    var sub = user.FindFirstValue(ClaimTypes.NameIdentifier);
    return Results.Ok(new { name, isAdmin, sub });
})
.RequireAuthorization();
```

Um detalhe sutil sobre nomes de claim: `JwtBearerOptions.MapInboundClaims` é `true` por padrão, o que reescreve nomes de claim JWT curtos como `sub` e `role` para as URIs longas WS-* (`ClaimTypes.NameIdentifier`, `ClaimTypes.Role`). Se você prefere trabalhar com os nomes curtos crus, defina `options.MapInboundClaims = false` e depois aponte `TokenValidationParameters.NameClaimType` e `RoleClaimType` para o que seus tokens de fato carregam. Esse mapeamento é o motivo pelo qual `user.Identity.Name` pode ser null mesmo com um token válido: o token não tinha nenhum claim que correspondesse ao `NameClaimType` configurado.

## Adicione políticas de role e de claim para um acesso mais fino

"Qualquer usuário autenticado" raramente basta. Para qualquer coisa além de um portão geral, defina políticas nomeadas uma vez e anexe-as por nome. `AddAuthorizationBuilder` é a maneira amigável às minimal API:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin_only", policy =>
        policy.RequireRole("admin"))
    .AddPolicy("can_write_orders", policy =>
        policy
            .RequireRole("admin")
            .RequireClaim("scope", "orders_api"));

// ...

app.MapDelete("/orders/{id}", (int id) => Results.NoContent())
    .RequireAuthorization("admin_only");

app.MapPost("/orders", (object order) => Results.Created())
    .RequireAuthorization("can_write_orders");
```

Uma política é um conjunto de requisitos que quem chama deve satisfazer. `RequireRole` verifica o claim de role; `RequireClaim("scope", "orders_api")` verifica que um claim `scope` com esse valor está presente. Quem se autentica mas falha na política recebe um **403**, não um 401. Essa distinção importa quando você depura: 401 significa "não sabemos quem você é" (autenticação), 403 significa "sabemos, e você não tem permissão" (autorização). Se você está vendo 403, pare de olhar o token e olhe a política.

Quando vários endpoints compartilham uma política, não repita `.RequireAuthorization("...")` em cada um. Agrupe-os para que o requisito viva em um único lugar, o que também evita que um esquema ou política se desvie silenciosamente entre rotas:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin").RequireAuthorization("admin_only");
admin.MapGet("/stats", () => "admin stats");
admin.MapDelete("/orders/{id}", (int id) => Results.NoContent());
```

Os padrões de agrupamento, incluindo grupos aninhados e filtros por grupo, são cobertos em [como organizar endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Teste sem construir uma interface de login

Você não precisa de um cliente nem de um provedor de identidade real para exercitar a configuração. A ferramenta `dotnet user-jwts` cunha um token assinado com uma chave que ela também conecta na sua configuração de desenvolvimento, de modo que a validação não pode falhar por um desalinhamento de chave:

```bash
# .NET 11 SDK, run in the project directory
dotnet user-jwts create
```

Executada contra um projeto, a ferramenta escreve as opções de validação correspondentes (um `ValidIssuer` de `dotnet-user-jwts` mais as URLs da sua app como `ValidAudiences`) no `appsettings.Development.json`, e imprime um token pronto para uso. Para cunhar um token que carregue o role e o scope que suas políticas exigem:

```bash
# .NET 11 SDK
dotnet user-jwts create --role "admin" --scope "orders_api"
```

Depois envie-o:

```bash
# {token} is the value dotnet user-jwts printed
curl -i -H "Authorization: Bearer {token}" https://localhost:7259/orders
```

O formato do cabeçalho é estrito: a palavra literal `Bearer`, um espaço e depois o token cru, sem aspas. Se um token do `user-jwts` autentica mas o do seu provedor real não, a diferença está nos claims do token ou na chave de assinatura, não na sua fiação. Se até o token do `user-jwts` responde 401, a fiação continua errada; revise novamente o esquema padrão e a ordem do middleware.

## A configuração em sete passos

Para recapitular todo o fluxo como uma lista de verificação:

1. Adicione o pacote: `dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer`.
2. Registre o esquema e torne-o padrão: `builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();`.
3. Adicione autorização: `builder.Services.AddAuthorization();` (ou `AddAuthorizationBuilder()` se você definir políticas).
4. Configure como é um token válido, seja na seção de configuração `Authentication:Schemes:Bearer`, via `options.Authority` para um provedor OIDC, ou via `TokenValidationParameters` em código para tokens autoassinados.
5. Proteja endpoints com `.RequireAuthorization()`, adicionando um nome de política para requisitos de role ou de claim.
6. Deixe o `WebApplication` adicionar o middleware automaticamente, ou chame `UseAuthentication` e depois `UseAuthorization` na mão apenas quando a ordem (por exemplo, CORS) exigir.
7. Teste com `dotnet user-jwts create` e uma requisição `curl` carregando o cabeçalho `Authorization: Bearer`.

Esse é todo o caminho feliz. O modelo mental que mantém isso claro: a autenticação decide *quem* é quem chama validando o token e populando `HttpContext.User`, e a autorização decide *se* essa pessoa pode prosseguir avaliando políticas. Mantenha esses dois trabalhos separados na sua cabeça e quase todo problema com JWT se organiza em "o token está errado" (um problema de validação) ou "a fiação está errada" (um problema de esquema, middleware ou política). Se você ainda está decidindo se tokens bearer são sequer a escolha certa para sua app em relação a sessões no lado do servidor, pese os compromissos em [JWT vs autenticação por cookie no ASP.NET Core 11](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

## Fontes

- [Authentication and authorization in Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security), Microsoft Learn, para o registro automático do middleware, `AddAuthorizationBuilder` e o comportamento do `dotnet user-jwts`.
- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
- [Microsoft.AspNetCore.Authentication.JwtBearer no NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
- [.NET 11 Preview 5 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), .NET Blog, para o preview atual e o objetivo de GA de novembro de 2026.
