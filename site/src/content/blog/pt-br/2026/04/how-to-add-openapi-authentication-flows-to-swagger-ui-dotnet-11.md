---
title: "Como adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11"
description: "No .NET 11 o documento OpenAPI é gerado por Microsoft.AspNetCore.OpenApi e o Swagger UI não vem mais no template. Veja como conectar Bearer, OAuth2 com PKCE e OpenID Connect para que o botão Authorize realmente funcione."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "openapi"
  - "swagger"
  - "authentication"
  - "dotnet-11"
template: how-to
lang: "pt-br"
translationOf: "2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-28
---

No .NET 11 o documento OpenAPI é produzido pelo `Microsoft.AspNetCore.OpenApi` e o Swagger UI não vem mais no template do projeto. Para ter um botão Authorize que realmente envia headers, você precisa de três peças conectadas: um document transformer que registre um esquema de segurança no documento OpenAPI, um requisito de segurança global ou por operação para que os endpoints declarem o que precisam, e o middleware do Swagger UI (`Swashbuckle.AspNetCore.SwaggerUI`) configurado com as opções de cliente OAuth se você usa OAuth2 ou OpenID Connect. Este post percorre Bearer JWT, OAuth2 authorization code com PKCE e OpenID Connect, tudo sobre o .NET 11 GA.

Versões referenciadas ao longo do post: .NET 11.0 GA, `Microsoft.AspNetCore.OpenApi` 11.0, `Swashbuckle.AspNetCore.SwaggerUI` 7.x, `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0. Os exemplos são minimal API, mas os mesmos transformers funcionam em controllers MVC.

## O que mudou desde o .NET 8

No .NET 8 e anteriores, `Swashbuckle.AspNetCore` vinha como padrão. Você chamava `AddSwaggerGen()` e configurava tudo (esquemas de auth, requisitos, opções de UI) em um único lugar. A partir do .NET 9 o template inclui `Microsoft.AspNetCore.OpenApi` para a geração do documento e remove o Swagger UI por completo. O .NET 11 mantém essa separação.

Isso implica duas coisas para os fluxos de autenticação:

1. O documento OpenAPI não é mais responsabilidade do Swashbuckle, então todos os exemplos de `OperationFilter` e `DocumentFilter` no Stack Overflow estão obsoletos. O novo ponto de extensão é `IOpenApiDocumentTransformer` e `IOpenApiOperationTransformer`.
2. O Swagger UI agora é opcional. Se você o quer de volta, instala `Swashbuckle.AspNetCore.SwaggerUI` (apenas o pacote da UI, cerca de 600 KB) e aponta para o documento JSON que o novo gerador emite.

Se você só quer uma UI de "experimentar o endpoint", o [Scalar é uma alternativa mais leve](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) que lê o mesmo documento OpenAPI. Os transformers abaixo produzem um modelo de segurança OpenAPI 3.x válido, então qualquer UI que respeite a especificação detecta os fluxos de auth.

## A configuração mínima de Bearer JWT

Comece pelo esquema mais simples: `http` com `bearer` e a dica de formato JWT. Instale o gerador OpenAPI, a UI e a autenticação JWT bearer:

```bash
# .NET 11
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Swashbuckle.AspNetCore.SwaggerUI
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Adicione um document transformer que registre o esquema:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header,
            Description = "Paste a JWT issued by your IdP."
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "Bearer"
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

Registre o transformer e sirva o JSON junto com a UI:

```csharp
// .NET 11, C# 14, Program.cs
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "https://login.example.com/";
        o.Audience = "api://my-api";
    });

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapOpenApi();           // serves /openapi/v1.json
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
});

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/secret", () => "hello").RequireAuthorization();
app.Run();
```

Abra `/swagger`, clique em **Authorize**, cole o token, e o Swagger UI passa a enviar `Authorization: Bearer <token>` em cada chamada. Os `SecurityRequirements` globais fazem cada operação herdar o requisito; se você quer um endpoint público, sobrescreve por operação (coberto na seção "Múltiplos esquemas" abaixo).

## OAuth2 authorization code com PKCE

A configuração de Bearer é boa para "já tenho um token, vou colar aqui", mas a maioria dos times quer que o Swagger UI conduza o usuário por um login OAuth de verdade. Para fluxos no estilo SPA, use authorization code com PKCE.

Adicione outro transformer:

```csharp
// .NET 11, C# 14
internal sealed class OAuth2SecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oauth2"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OAuth2,
            Flows = new OpenApiOAuthFlows
            {
                AuthorizationCode = new OpenApiOAuthFlow
                {
                    AuthorizationUrl = new Uri($"{authority}/oauth2/authorize"),
                    TokenUrl = new Uri($"{authority}/oauth2/token"),
                    Scopes = new Dictionary<string, string>
                    {
                        ["api://my-api/read"]  = "Read your data",
                        ["api://my-api/write"] = "Write your data"
                    }
                }
            }
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oauth2"
                }
            }] = ["api://my-api/read", "api://my-api/write"]
        });

        return Task.CompletedTask;
    }
}
```

O lado do documento OpenAPI está pronto. O Swagger UI também precisa saber quem *ele* é para o IdP, senão o redirecionamento do endpoint authorize falha com `invalid_client`:

```csharp
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");

    c.OAuthClientId("swagger-ui");        // public client registered with the IdP
    c.OAuthUsePkce();                     // mandatory for public clients
    c.OAuthScopes("api://my-api/read");
    c.OAuthAppName("Swagger UI for My API");
});
```

Dois detalhes do registro no IdP que costumam pegar as pessoas:

- A redirect URI deve ser exatamente `https://your-host/swagger/oauth2-redirect.html`. O Swashbuckle já entrega essa página; não invente outra.
- O client deve ser um cliente *público* (sem segredo). Se o seu IdP recusa clientes públicos, mude para client credentials para máquina-a-máquina e esqueça o fluxo na UI.

## OpenID Connect via discovery

Se o seu IdP expõe um documento de discovery, prefira `openIdConnect` a colocar URLs no código. O Swagger UI 7.x lê o documento de discovery e descobre o resto:

```csharp
// .NET 11, C# 14
internal sealed class OidcSecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oidc"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OpenIdConnect,
            OpenIdConnectUrl = new Uri($"{authority}/.well-known/openid-configuration")
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oidc"
                }
            }] = ["openid", "profile", "api://my-api/read"]
        });

        return Task.CompletedTask;
    }
}
```

O esquema `openIdConnect` é OpenAPI 3.x válido desde 3.0.1 e dá ao Swagger UI uma única fonte de verdade para `authorization_endpoint`, `token_endpoint` e `scopes_supported`. Na prática, é a configuração mais limpa quando você roda contra Microsoft Entra ID, Auth0, Keycloak ou qualquer outro IdP que exponha `/.well-known/openid-configuration`. Mesmo assim, você precisa de `OAuthClientId` e `OAuthUsePkce` no lado do Swagger UI; o documento de discovery cobre apenas o lado *servidor* do contrato.

## Múltiplos esquemas e requisitos por operação

APIs reais geralmente misturam: um par de endpoints aceita uma API key, o resto exige OAuth, o probe de health é anônimo. Tire a chamada global `SecurityRequirements.Add(...)` do document transformer e aplique os requisitos por operação.

Adicione um operation transformer que lê metadados do endpoint:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authorization;

internal sealed class SecurityRequirementOperationTransformer
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken ct)
    {
        var endpoint = context.Description.ActionDescriptor.EndpointMetadata;
        var hasAuth   = endpoint.OfType<IAuthorizeData>().Any();
        var anonymous = endpoint.OfType<IAllowAnonymous>().Any();

        if (!hasAuth || anonymous) return Task.CompletedTask;

        var schemeId = endpoint
            .OfType<AuthorizeAttribute>()
            .Select(a => a.AuthenticationSchemes)
            .FirstOrDefault(s => !string.IsNullOrEmpty(s)) ?? "oauth2";

        operation.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = schemeId
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

Registre os dois transformers lado a lado:

```csharp
builder.Services.AddOpenApi(o =>
{
    o.AddDocumentTransformer<OAuth2SecuritySchemeTransformer>();
    o.AddDocumentTransformer<ApiKeySecuritySchemeTransformer>();
    o.AddOperationTransformer<SecurityRequirementOperationTransformer>();
});
```

Agora `[Authorize]` desenha um cadeado na operação, `[AllowAnonymous]` pula, e `[Authorize(AuthenticationSchemes = "ApiKey")]` desenha o cadeado do esquema certo. O documento OpenAPI volta ao formato do antigo overload `AddSecurityRequirement` do Swashbuckle, mas sem `OperationFilter` para manter.

## Detalhes que mordem em produção

Algumas coisas nunca aparecem na documentação oficial mas surgem em toda triagem:

**`document.Components` pode ser null.** Em um `OpenApiDocument` recém-criado, `Components` é `null` até algo atribuir um valor. A linha defensiva `document.Components ??= new OpenApiComponents();` em cada transformer acima não é opcional. O serializador não escreve `components.securitySchemes` se a seção estiver ausente, e o Swagger UI ignora silenciosamente a referência do requisito porque o esquema apontado não existe.

**`Reference.Id` precisa bater exatamente com a chave do dicionário.** Se você registrou o esquema como `"Bearer"` mas o requisito usa `"bearer"`, o OpenAPI 3.x trata como `$ref` não resolvido e o Swagger UI mostra o ícone do cadeado mas nunca envia o header. Escolha uma capitalização por aplicação e mantenha.

**A autorização persistida vem desligada.** Cada recarga apaga o token. Para conforto em desenvolvimento, ative `c.EnablePersistAuthorization()`. O token fica em `localStorage`, então não ative em uma implantação de produção.

**URL de redirecionamento OAuth com path bases não-raiz.** Quando a aplicação roda atrás de um reverse proxy em `/api`, o Swagger UI monta o redirecionamento como `/api/swagger/oauth2-redirect.html`. O registro no IdP precisa incluir exatamente esse path ou o callback falha com `redirect_uri_mismatch`. Verifique os headers `Forwarded` e o `UsePathBase` se o redirecionamento parecer estranho.

**Native AOT.** No .NET 11, o novo gerador de OpenAPI não é anotado como trim-safe para transformers arbitrários, e embora o serviço de arquivos estáticos do Swashbuckle.AspNetCore.SwaggerUI funcione sob AOT, os transformers devem evitar reflection sobre genéricos fechados. Se aparecerem warnings `RequiresUnreferencedCode`, veja o [guia de Native AOT com minimal API](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para o padrão.

**Os requisitos por operação acumulam, não substituem.** Se o documento tem um `SecurityRequirements` global *e* o operation transformer adiciona outro, ambos são avaliados como alternativas (semântica OR no OpenAPI). Para um endpoint público, é preciso limpar `operation.Security` explicitamente; deixar o transformer quieto não basta.

## Conectando o SwaggerUI com vários documentos

Se você versiona sua API e emite um documento OpenAPI por versão, o dropdown do Swagger UI precisa de um endpoint para cada uma:

```csharp
app.MapOpenApi("/openapi/{documentName}.json");

app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
    c.SwaggerEndpoint("/openapi/v2.json", "API v2");

    c.OAuthClientId("swagger-ui");
    c.OAuthUsePkce();
});
```

Cada documento carrega seus próprios `securitySchemes`, então um transformer que roda por documento é chamado uma vez por versão. Boa notícia: nada de estado compartilhado para perseguir. Má notícia: se você esquecer de registrar o transformer para o documento v2, só v1 fica com cadeado. O padrão se encaixa direitinho com o `WithDocumentPerVersion()` do `Asp.Versioning` 10.0 (coberto no [post de versionamento de API](/2026/04/api-versioning-openapi-dotnet-10/)).

## Relacionado

- [Scalar in ASP.NET Core: why your Bearer token is ignored (.NET 10)](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Asp.Versioning 10.0 finally plays nicely with built-in OpenAPI in .NET 10](/2026/04/api-versioning-openapi-dotnet-10/)
- [How to generate strongly-typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Fontes

- [Documentação de personalização de Microsoft.AspNetCore.OpenApi](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi)
- [Referência da API `IOpenApiDocumentTransformer`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.openapi.iopenapidocumenttransformer)
- [Código-fonte de Swashbuckle.AspNetCore.SwaggerUI 7.x](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/tree/master/src/Swashbuckle.AspNetCore.SwaggerUI)
- [OpenAPI 3.0.3 security requirement object](https://spec.openapis.org/oas/v3.0.3#security-requirement-object)
