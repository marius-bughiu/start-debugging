---
title: "Como validar o emissor, a audiência e a validade de um JWT no ASP.NET Core 11"
description: "Um guia completo de TokenValidationParameters no ASP.NET Core 11: como ValidateIssuer, ValidateAudience e ValidateLifetime funcionam, quais são de fato os valores padrão, por que Authority configura automaticamente o emissor e as chaves de assinatura, a armadilha dos 5 minutos de ClockSkew e como ler os códigos de erro IDX quando um token aparentemente válido é rejeitado."
pubDate: 2026-06-22
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "pt-br"
translationOf: "2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-22
---

O manipulador de bearer JWT no ASP.NET Core não apenas verifica uma assinatura. Ele executa uma série de verificações independentes governadas por `TokenValidationParameters`: o emissor (`iss`), a audiência (`aud`), a validade (`exp` e `nbf`) e a chave de assinatura. A boa notícia é que `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` e `ValidateIssuerSigningKey` têm `true` como valor padrão, então um token é verificado corretamente já de início. A má notícia é que "padrão true" sem um valor configurado significa que o manipulador ainda lança uma exceção, e o bug de produção mais comum aqui é um token que continua vivo cinco minutos após seu `exp` porque `ClockSkew` tem um valor padrão de cinco minutos. Este artigo tem como alvo o .NET 11 (preview 5 no momento da escrita) com `Microsoft.AspNetCore.Authentication.JwtBearer`, mas o modelo de validação não muda desde o .NET 8, 9 e 10.

## O que o manipulador de bearer realmente valida

Quando chega uma requisição com `Authorization: Bearer <token>`, o `JwtBearerHandler` entrega o token bruto a um manipulador de tokens (desde o .NET 8 o padrão é o mais rápido `JsonWebTokenHandler` de `Microsoft.IdentityModel.JsonWebTokens`, não o antigo `JwtSecurityTokenHandler`). Esse manipulador lê `JwtBearerOptions.TokenValidationParameters` e executa cada verificação habilitada por vez. Se alguma verificação falhar, ele lança uma exceção, o manipulador produz um 401 e a resposta carrega um cabeçalho `WWW-Authenticate: Bearer error="invalid_token"` com uma descrição.

As quatro verificações que importam para praticamente qualquer API:

- **Assinatura** (`ValidateIssuerSigningKey`, ativada por padrão): a assinatura do token é verificada contra uma chave. Isso prova que o token foi cunhado por alguém que possui a chave privada e que não foi adulterado.
- **Emissor** (`ValidateIssuer`, ativado por padrão): o claim `iss` deve corresponder a `ValidIssuer` (ou a um de `ValidIssuers`). Isso impede que um token de um provedor de identidade diferente seja reenviado contra sua API.
- **Audiência** (`ValidateAudience`, ativada por padrão): o claim `aud` deve corresponder a `ValidAudience` (ou a um de `ValidAudiences`). Isso impede que um token cunhado para *outra* API do mesmo emissor seja aceito pela sua.
- **Validade** (`ValidateLifetime`, ativada por padrão): o horário atual deve ser igual ou posterior a `nbf` (not-before) e anterior a `exp` (expiração), dentro da tolerância de `ClockSkew`.

Os valores padrão vivem em `Microsoft.IdentityModel.Tokens.TokenValidationParameters`, e você pode confirmá-los no [código-fonte](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs): cada flag `Validate*` é inicializada como `true`, e `RequireExpirationTime` e `RequireSignedTokens` também são `true`. Você não liga a validação. Você fornece os valores contra os quais ela valida.

## A configuração correta mais rápida: apontar para uma authority

Se seus tokens vêm de um provedor OpenID Connect (Entra ID, Auth0, Keycloak, Okta, uma instância do IdentityServer/Duende), você quase nunca configura a chave de assinatura ou o emissor manualmente. Você configura `Authority`, e o manipulador descobre todo o resto a partir dos metadados do provedor.

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        // Discovers issuer + JWKS signing keys from
        // {Authority}/.well-known/openid-configuration
        options.Authority = "https://login.example.com";

        // Maps to TokenValidationParameters.ValidAudience
        options.Audience = "api://my-api";

        // Everything below is already the default, shown for clarity:
        options.TokenValidationParameters.ValidateIssuer = true;
        options.TokenValidationParameters.ValidateAudience = true;
        options.TokenValidationParameters.ValidateLifetime = true;
        options.TokenValidationParameters.ValidateIssuerSigningKey = true;
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Duas coisas acontecem nos bastidores quando você configura `Authority`:

1. Um `ConfigurationManager` busca `{Authority}/.well-known/openid-configuration` e, a partir dele, o endpoint JWKS (JSON Web Key Set). As chaves públicas de assinatura retornadas ali se tornam as `IssuerSigningKeys`, e o valor `issuer` dos metadados se torna o `ValidIssuer`. O manager faz cache disso e o atualiza periodicamente, então a rotação de chaves no provedor é tratada sem um novo deploy.
2. `JwtBearerOptions.Audience` é copiado para `TokenValidationParameters.ValidAudience`.

É por isso que uma configuração mínima de `Authority` + `Audience` valida por completo: emissor, audiência, validade e assinatura estão todos cobertos. Se seu provedor serve metadados apenas por HTTPS (e deveria), mantenha `options.RequireHttpsMetadata = true`, que é o valor padrão fora de `Development`.

## Validar um token que você mesmo assinou (chave simétrica)

Se você cunha tokens na mesma aplicação, por exemplo uma pequena API própria que emite seus próprios tokens de acesso, não há metadados OIDC a descobrir. Você fornece o emissor, a audiência e a chave de assinatura explicitamente.

```csharp
// .NET 11, C# 14
var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "my-api-clients",

            ValidateLifetime = true,

            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,

            // Default is 5 minutes. See the next section.
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

Note que atribuir um `TokenValidationParameters` totalmente novo substitui os valores padrão por completo, então liste todas as flags com que você se importa. O segredo HMAC deve ter pelo menos 256 bits (32 bytes) para `HS256`, ou a camada de assinatura lança `IDX10720` ao criar o token.

## A armadilha dos cinco minutos de ClockSkew

Este é o comportamento mais surpreendente, e morde quem escreve um teste esperando que um token seja rejeitado no instante em que expira.

`TokenValidationParameters.ClockSkew` tem um valor padrão de **cinco minutos** (`DefaultClockSkew = TimeSpan.FromMinutes(5)`). Ele existe para absorver a deriva de relógio entre a máquina que emitiu o token e a que o valida: sem ele, uma diferença de um segundo nos relógios do sistema poderia rejeitar cada token recém-cunhado como "ainda não válido" ou aceitá-lo e rejeitá-lo de forma inconsistente. O custo é que um token com `exp` às 12:00:00 ainda é aceito até 12:05:00 no servidor que valida.

Para a maioria das APIs, cinco minutos de tolerância em um token de acesso são inofensivos e o padrão correto. Mas se você emite tokens de curta duração (digamos, tokens de acesso de 60 segundos respaldados por um fluxo de refresh, o padrão descrito em [como implementar tokens de refresh no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), o skew domina a validade e o token vive efetivamente seis minutos, não um. Ajuste-o de forma deliberada:

```csharp
// .NET 11, C# 14
// Strict expiry. Only safe if your servers run NTP-synced clocks.
options.TokenValidationParameters.ClockSkew = TimeSpan.Zero;
```

Configure `ClockSkew = TimeSpan.Zero` apenas quando seu emissor e sua API tiverem relógios sincronizados (NTP em ambos, o que é normal em qualquer ambiente de nuvem). Se eles podem derivar, um valor pequeno diferente de zero como 30 segundos é o meio-termo sensato. Não "conserte" uma rejeição inesperada de token *aumentando* o skew. Um token que está genuinamente expirado deve ser rejeitado; aumentar o skew para esconder um problema de relógio apenas amplia sua janela de reenvio.

## Por que ValidateAudience = true sem audiência é uma mina na inicialização

Um erro comum é deixar `ValidateAudience = true` (o valor padrão) sem nunca configurar `Audience` / `ValidAudience`. O manipulador não tem nada com que comparar `aud`, então lança uma exceção na primeira requisição:

```text
IDX10208: Unable to validate audience. The 'audience' is null or whitespace
and validationParameters.ValidAudiences is also null or empty.
```

Você tem duas respostas corretas, e exatamente uma errada:

- **Correta, e preferida**: configure `Audience` (ou `ValidAudiences` para várias). A validação de audiência é um controle de segurança real. É o que impede que um token emitido para `api://billing` no seu tenant compartilhado do Entra seja reenviado contra `api://reporting`.
- **Correta, apenas quando você genuinamente não tem um claim de audiência**: configure `ValidateAudience = false` *explicitamente*, e escreva um comentário explicando por quê. Alguns emissores antigos não carimbam `aud`.
- **Errada**: silenciar a exceção capturando-a, ou apontar `ValidAudience` para um valor que você não controla.

A mesma forma se aplica a `ValidateIssuer = true` sem `ValidIssuer` e sem `Authority`: você obtém `IDX10204` ("Unable to validate issuer"). Configurar `Authority` preenche `ValidIssuer` a partir dos metadados, e é por isso que o caminho OIDC raramente esbarra nisso.

## Aceitar mais de um emissor ou audiência

Durante uma migração entre provedores de identidade, ou quando uma API serve clientes cunhados sob vários nomes de audiência, use as coleções no plural. Elas são aditivas em relação a qualquer coisa descoberta a partir de `Authority`.

```csharp
// .NET 11, C# 14
options.TokenValidationParameters.ValidIssuers = new[]
{
    "https://old-idp.example.com",
    "https://login.example.com",
};
options.TokenValidationParameters.ValidAudiences = new[]
{
    "api://my-api",
    "api://my-api-legacy",
};
```

Um token passa se seu `iss` corresponder a *qualquer* entrada de `ValidIssuers` e seu `aud` corresponder a *qualquer* entrada de `ValidAudiences`. Isso permite executar ambos os emissores em paralelo durante uma transição e remover o antigo assim que o tráfego tiver escoado, sem que haja uma janela em que tokens sejam rejeitados.

## Ler a falha: ative os códigos IDX

Quando um token que parece correto recebe um 401, o corpo da resposta está vazio e o cabeçalho `WWW-Authenticate` é lacônico. A razão real está na exceção que o manipulador engoliu. Conecte `OnAuthenticationFailed` para expô-la enquanto depura:

```csharp
// .NET 11, C# 14
options.Events = new JwtBearerEvents
{
    OnAuthenticationFailed = context =>
    {
        // Logs the underlying SecurityTokenException, e.g. IDX10223
        context.NoResult();
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILogger<Program>>();
        logger.LogWarning(context.Exception, "JWT validation failed");
        return Task.CompletedTask;
    },
};
```

Os códigos `IDX` de `Microsoft.IdentityModel` correspondem diretamente às quatro verificações, e conhecê-los encerra a maioria das sessões de depuração em segundos:

- `IDX10223`: a validação de validade falhou, o token está expirado. Verifique `exp` e `ClockSkew`.
- `IDX10205` / `IDX10204`: o emissor é inválido ou não pôde ser validado. O claim `iss` não corresponde a `ValidIssuer`/`ValidIssuers`, ou nenhum foi configurado.
- `IDX10214` / `IDX10208`: a audiência é inválida ou não pôde ser validada. O claim `aud` não corresponde, ou nenhuma foi configurada.
- `IDX10503` / `IDX10500`: a validação de assinatura falhou, frequentemente uma chave que a API não tem. Com `Authority`, isso normalmente significa um cache de metadados desatualizado ou um provedor que rotacionou chaves; a atualização do `ConfigurationManager` resolve.

Se o token valida mas `User.Identity?.Name` é null ou suas verificações `[Authorize(Roles = ...)]` falham, o problema é o mapeamento de claims, não a validação. `JwtBearerOptions.MapInboundClaims` tem `true` por padrão, o que reescreve nomes curtos de claim como `sub` e `role` nas URIs longas de WS-*. Configure `options.MapInboundClaims = false` para manter os nomes curtos originais, e então configure `TokenValidationParameters.NameClaimType` e `RoleClaimType` com o que seus tokens realmente usam.

## Juntando tudo, passo a passo

1. Escolha sua âncora de confiança. Para um provedor OIDC, configure `options.Authority`; o emissor e as chaves de assinatura vêm dos metadados. Para tokens autoassinados, configure `ValidIssuer` e `IssuerSigningKey` manualmente.
2. Configure a audiência. Atribua `options.Audience` (ou `ValidAudiences`) para que `ValidateAudience = true` tenha algo a verificar. Não desative a validação de audiência a menos que seus tokens realmente não carreguem `aud`.
3. Deixe `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` e `ValidateIssuerSigningKey` em seu valor padrão `true`. Você está configurando valores, não interruptores.
4. Configure `ClockSkew` para corresponder à validade do seu token. Mantenha o padrão de 5 minutos para tokens de acesso normais; reduza para `TimeSpan.Zero` ou 30 segundos para tokens de curta duração em relógios sincronizados por NTP.
5. Para cenários multi-provedor ou multi-audiência, use as coleções no plural `ValidIssuers` / `ValidAudiences` durante a transição.
6. Adicione log de `JwtBearerEvents.OnAuthenticationFailed` fora de produção para que o código `IDX` diga qual das quatro verificações falhou.
7. Coloque `app.UseAuthentication()` antes de `app.UseAuthorization()`, e se uma SPA de navegador chama a API de outra origem, acerte a ordem do middleware conforme [como configurar CORS para uma API protegida com JWT](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

## Quando a validação passa mas a requisição ainda falha

Uma vez que as quatro verificações passam, qualquer falha restante não é mais um problema de validação de token. Um 403 (não um 401) significa que o token era válido mas uma política de autorização ou um requisito de role não foi atendido, o que é uma camada totalmente distinta. Uma requisição que funciona no código mas falha a partir de uma UI de documentação normalmente é a ferramenta descartando o cabeçalho, algo coberto em [por que seu bearer token é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) e em [adicionar fluxos de autenticação OpenAPI ao Swagger UI](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/). E se você está conectando autenticação a uma minimal API, agrupe os endpoints protegidos para que a política se aplique em um só lugar, como mostrado em [organizar endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

O modelo mental que mantém isso simples: `TokenValidationParameters` são quatro perguntas independentes que o manipulador faz de cada token. Quem o assinou? Quem o emitiu? Para quem ele é? Ainda está dentro da validade? Os valores padrão tornam as quatro obrigatórias, então seu único trabalho é dar a cada uma um valor correto, e lembrar que "ainda dentro da validade" carrega um colchão de cinco minutos até você dizer o contrário.

Fontes: [TokenValidationParameters source - AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs), [Configure JWT bearer authentication in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), [JwtBearerOptions - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.jwtbearer.jwtbeareroptions), [Microsoft.AspNetCore.Authentication.JwtBearer - NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
