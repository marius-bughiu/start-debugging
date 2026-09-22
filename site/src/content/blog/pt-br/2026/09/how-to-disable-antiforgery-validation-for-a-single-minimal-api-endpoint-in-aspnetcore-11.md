---
title: "Como desativar a validação antiforgery em um único endpoint de formulário de minimal API no ASP.NET Core 11"
description: "Chame .DisableAntiforgery() no endpoint específico, ou em um MapGroup. No ASP.NET Core 11 isso desativa tanto o middleware de token quanto a nova verificação automática de CSRF. Matriz medida, armadilhas de precedência e alternativas mais restritas."
pubDate: 2026-09-22
template: how-to
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "security"
  - "csrf"
lang: "pt-br"
translationOf: "2026/09/how-to-disable-antiforgery-validation-for-a-single-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Resposta curta:** encadeie `.DisableAntiforgery()` na chamada `MapPost` específica (ou em um `MapGroup` que contenha apenas endpoints máquina a máquina). No ASP.NET Core 11 essa única chamada tira o endpoint de **ambas** as camadas que podem rejeitar um post de formulário: o middleware `UseAntiforgery()` baseado em token e a nova verificação automática de CSRF entre origens que o `WebApplication` injeta para você. `[RequireAntiforgeryToken(false)]` no handler faz a mesma coisa. Não recorra à chave global `DisableCsrfProtection` para corrigir um único endpoint: em um app que nunca chama `UseAntiforgery()`, ela transforma todos os outros endpoints de formulário em `500`.

Tudo abaixo foi medido no SDK do .NET 11 RC 1 (`11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1`), com uma execução no .NET 10.0.10 para comparação. A matriz de requisições, as armadilhas de precedência e as alternativas mais restritas são a parte que a documentação deixa para você descobrir.

## Por que um endpoint de formulário rejeita requisições que você não esperava

Desde o .NET 8, qualquer handler de minimal API com um parâmetro vinculado ao formulário (`[FromForm]`, `IFormFile`, `IFormCollection`) recebe metadados de antiforgery automaticamente. Dá para ver isso em `RequestDelegateFactory.InferAntiforgeryMetadata`: quando a factory vincula um parâmetro a partir do formulário, ela adiciona ao endpoint um `IAntiforgeryMetadata` com `RequiresValidation = true`. Você nunca escreveu um atributo; o tipo do parâmetro fez isso por você.

O que lê esses metadados mudou no .NET 11.

- **.NET 8 a 10**: só o `app.UseAntiforgery()` age sobre eles. Se você nunca o chamou, o middleware de endpoint lança `InvalidOperationException: Endpoint HTTP: POST /protected contains anti-forgery metadata, but a middleware was not found that supports anti-forgery.` e toda requisição vira `500`. Se você o chamou, todo post sem um token válido (e seu cookie) é um `400`.
- **.NET 11**: o `WebApplication` também injeta automaticamente um `CsrfProtectionMiddleware` depois do roteamento (adicionado no Preview 6, veja [o ASP.NET Core 11 ativando a proteção automática contra CSRF](/pt-br/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)). Ele lê os mesmos metadados, verifica `Sec-Fetch-Site` e `Origin`, e registra um veredito em `IAntiforgeryValidationFeature`. O binder de formulário então aplica esse veredito com um `400`.

Então, no .NET 11, há duas formas de um post de formulário ser rejeitado, e elas falham para clientes diferentes. O middleware de token rejeita qualquer coisa sem token, incluindo o curl e os servidores do seu provedor de pagamentos. A verificação de CSRF deixa passar clientes que não são navegadores, mas rejeita posts de navegador entre origens: o caso clássico é uma página de terceiros que envia um formulário HTML de volta para você (uma página de pagamento hospedada, um callback no estilo SAML, o formulário "submit to" de um parceiro).

## O que cada cliente realmente recebe

Montei um app de teste com cinco endpoints e acionei cada um com quatro formatos de requisição, em quatro configurações de pipeline. "plain" é curl sem cabeçalhos de navegador, "cross-site" envia `Sec-Fetch-Site: cross-site` mais um `Origin` externo, "same-origin" envia `Sec-Fetch-Site: same-origin`, e "foreign Origin only" imita um navegador antigo que envia `Origin` mas nenhum Fetch Metadata.

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
app.MapPost("/protected", ([FromForm] string name) => $"hello {name}");

app.MapPost("/disabled", ([FromForm] string name) => $"hello {name}")
   .DisableAntiforgery();

app.MapPost("/attr",
    [RequireAntiforgeryToken(false)] ([FromForm] string name) => $"hello {name}");

var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => $"hello {name}");

app.MapPost("/manual", async (HttpRequest req) =>
    $"hello {(await req.ReadFormAsync())["name"]}");
```

Pipeline padrão do .NET 11 (sem `AddAntiforgery`, sem `UseAntiforgery`), ambiente Production:

| Endpoint | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | 200 | **400** | 200 | **400** |
| `/disabled` | 200 | 200 | 200 | 200 |
| `/attr` | 200 | 200 | 200 | 200 |
| `/hooks/payments` | 200 | 200 | 200 | 200 |
| `/manual` | 200 | 200 | 200 | 200 |

Com `builder.Services.AddAntiforgery()` e `app.UseAntiforgery()` (o que apps Blazor e MVC atualizados do .NET 8-10 costumam ter):

| Endpoint | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | **400** | **400** | **400** | **400** |
| `/disabled`, `/attr`, `/hooks/payments` | 200 | 200 | 200 | 200 |

Com `DisableCsrfProtection=true` e sem `UseAntiforgery()`: `/protected` é **500** para toda requisição, exatamente como o .NET 10.0.10 sem `UseAntiforgery()`, que também medi. Os endpoints desativados continuam em 200.

Os logs do servidor dizem qual camada recusou. A camada de CSRF registra `Cross-origin CSRF protection marked request POST /protected from origin 'https://evil.example' as invalid.` em `Debug` sob `Microsoft.AspNetCore.Antiforgery.CsrfProtectionMiddleware`, e o binder então registra `Antiforgery validation failed when reading parameter "string name" from the request body as form.` com uma `CsrfValidationException` interna. A camada de token produz a mesma mensagem do binder com uma `AntiforgeryValidationException: The required antiforgery cookie ".AspNetCore.Antiforgery.<suffix>" is not present.` interna. Em Production o corpo da resposta vem vazio, então ative `Debug` para `Microsoft.AspNetCore.Http.RequestDelegateFactory` e `Microsoft.AspNetCore.Antiforgery` quando estiver caçando um `400` misterioso.

## Desativar em um endpoint, passo a passo

1. Confirme que o endpoint realmente não é um endpoint de cookie de navegador. Os únicos candidatos seguros são chamadores que se autenticam de outra forma: um webhook assinado com HMAC, uma API key, um bearer token, mTLS. Se o navegador de um usuário logado pode enviar posts para ele e o handler age com base na identidade do cookie, mantenha a proteção.
2. Encadeie `.DisableAntiforgery()` nesse `MapPost`. É uma extensão sobre qualquer `IEndpointConventionBuilder` em `Microsoft.AspNetCore.Builder`, então nenhum `using` extra é necessário em um projeto web.
3. Substitua a proteção que você acabou de remover pela prova do próprio chamador. Para um webhook com form-encoded, isso é uma verificação de assinatura sobre o corpo bruto, feita em middleware para rodar antes que qualquer coisa vincule o formulário.
4. Teste de novo com o formato de requisição cross-site acima (`-H 'Sec-Fetch-Site: cross-site' -H 'Origin: https://other.example'`) e com curl simples, para ter certeza de que as duas camadas saíram do caminho.

Aqui está tudo junto para um provedor que envia `application/x-www-form-urlencoded` e assina o corpo bruto com HMAC-SHA256:

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var secret = Encoding.UTF8.GetBytes(app.Configuration["Sms:WebhookSecret"]!);

// Verify the signature over the raw body before anything binds the form.
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/webhooks/sms"), branch =>
    branch.Use(async (ctx, next) =>
    {
        ctx.Request.EnableBuffering();
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        ctx.Request.Body.Position = 0;

        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, ms.ToArray()));
        var actual = ctx.Request.Headers["X-Signature"].ToString();

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual)))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await next(ctx);
    }));

app.MapPost("/webhooks/sms", ([FromForm] SmsStatus status) =>
        Results.Ok($"{status.MessageId}: {status.Status}"))
   .DisableAntiforgery();

app.Run();

record SmsStatus(string MessageId, string Status);
```

Medido: um post corretamente assinado retornou 200 tanto como curl simples quanto com os cabeçalhos de navegador cross-site, e uma assinatura errada retornou 401.

Meu primeiro rascunho colocou essa verificação em um endpoint filter, e ela falhou em todas as requisições assinadas. Quando um endpoint filter roda, o parâmetro `[FromForm]` já foi vinculado, o leitor de formulário já esvaziou o stream da requisição, e `EnableBuffering` nesse ponto não tem mais nada para bufferizar: o filtro calculou o hash de **0 bytes**. Verificações de assinatura sobre o corpo bruto pertencem ao middleware, e esse é um dos casos concretos em [endpoint filters vs middleware](/pt-br/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/). Um endpoint filter serve bem para verificações só de cabeçalho, como uma API key.

## A forma com atributo, para handlers que ficam em métodos

Se seus handlers são métodos estáticos em vez de lambdas, o atributo fica mais legível e sobrevive a refatorações que movem o mapeamento:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

app.MapPost("/webhooks/payments", PaymentHooks.Handle);

static class PaymentHooks
{
    [RequireAntiforgeryToken(false)]
    public static IResult Handle([FromForm] string eventId) => Results.Ok(eventId);
}
```

`RequireAntiforgeryTokenAttribute` implementa `IAntiforgeryMetadata` diretamente, e os dois middlewares pedem ao endpoint `GetMetadata<IAntiforgeryMetadata>()`, então o resultado é idêntico ao de `.DisableAntiforgery()`. Para controllers MVC o equivalente é `[IgnoreAntiforgeryToken]`; o `AntiforgeryMiddlewareAuthorizationFilter` no .NET 11 respeita o veredito de qualquer um dos middlewares.

## Desativar para um grupo de webhooks

Quando você tem vários callbacks de provedores, coloque-os sob um único prefixo e desative o grupo uma vez:

```csharp
// .NET 11 RC 1
var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => Results.Ok());
hooks.MapPost("/sms", ([FromForm] string name) => Results.Ok());
```

Isso mantém a decisão de segurança em um lugar visível em vez de espalhada por vários arquivos, que é o principal argumento para [organizar endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) em primeiro lugar.

## Armadilhas de precedência que encontrei no teste

**Desativar no grupo vence reativar no endpoint.** Eu esperava que isto reativasse a proteção para um endpoint dentro do grupo desativado:

```csharp
// .NET 11 RC 1: does NOT re-enable validation
hooks.MapPost("/strict", ([FromForm] string name) => $"hello {name}")
     .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

Não reativa. `/hooks/strict` retornou 200 para a requisição cross-site nos dois modos de pipeline. O motivo está no próprio `DisableAntiforgery`: ele registra seus metadados com `builder.Finally(...)`, que roda depois das convenções do próprio endpoint, e `GetMetadata<T>()` retorna o último item correspondente. O "não obrigatório" do grupo chega por último e vence. Se um endpoint dentro de um prefixo precisa continuar protegido, não desative no nível do grupo; desative por endpoint, ou divida o prefixo em dois grupos.

**A mesma ordenação do `Finally` é o motivo de `.DisableAntiforgery()` sempre vencer os metadados inferidos.** O binder de formulário adiciona `RequiresValidation = true` enquanto constrói o endpoint; o callback do `Finally` adiciona `false` depois disso. Você não precisa se preocupar com a ordem em que encadeia as chamadas.

**Handlers que leem o formulário manualmente não recebem proteção nenhuma.** O endpoint `/manual` acima lê `req.ReadFormAsync()` sem um parâmetro vinculado ao formulário, então nenhum metadado é inferido e nenhum dos middlewares olha para ele: posts cross-site receberam 200 em todos os modos. Se você quer proteção ali, precisa ativá-la com `.WithMetadata(new RequireAntiforgeryTokenAttribute())`. Mas aí o modo de falha muda: quando o veredito é inválido, o `FormFeature` se recusa a ler o corpo e lança `InvalidOperationException: This form is being accessed with a failed antiforgery validation. Validate the IAntiforgeryValidationFeature on the request before reading from the form.`, que é um 500, não um 400. Verifique o recurso você mesmo antes:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/manual-protected", async (HttpContext ctx) =>
    {
        if (ctx.Features.Get<IAntiforgeryValidationFeature>() is { IsValid: false })
            return Results.BadRequest();

        var form = await ctx.Request.ReadFormAsync();
        return Results.Ok(form["name"].ToString());
    })
    .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

**`DisableCsrfProtection` não é uma ferramenta por endpoint.** Ela remove o middleware injetado automaticamente para o app inteiro. Esse middleware também é o que satisfaz a verificação "a middleware was not found that supports anti-forgery" em apps que nunca chamam `UseAntiforgery()`, então ligar a chave para corrigir um webhook quebra todos os outros endpoints de formulário com um 500 (medido acima). A documentação chama isso de válvula de escape; trate como tal.

## Alternativas mais restritas antes de desativar qualquer coisa

Desativar é o certo para chamadas servidor a servidor assinadas. Para tráfego de navegador há duas opções mais restritas.

**Confiar em um chamador específico de outra origem via CORS.** A implementação padrão de `ICsrfProtection` consulta a política de CORS que se aplica ao endpoint: se o `Origin` da requisição é permitido por uma política nomeada ou padrão, o post é aceito mesmo quando `Sec-Fetch-Site` é `cross-site`. `AllowAnyOrigin` é ignorado de propósito.

```csharp
// .NET 11 RC 1
builder.Services.AddCors(o => o.AddPolicy("partner",
    p => p.WithOrigins("https://pay.partner.example")));

var app = builder.Build();
app.UseCors();

app.MapPost("/partner-callback", ([FromForm] string orderId) => Results.Ok(orderId))
   .RequireCors("partner");
```

Medido no pipeline padrão: a origem do parceiro recebeu 200, uma origem externa e um vizinho `same-site` ainda receberam 400, e curl simples recebeu 200. Duas ressalvas. Sem `app.UseCors()` o endpoint lança `contains CORS metadata, but a middleware was not found that supports CORS` (500). E isso só relaxa a camada de Fetch Metadata: com `UseAntiforgery()` no pipeline, a validação de token roda depois, sobrescreve o veredito, e o post do parceiro voltou a ser 400. Se você já combina CORS com cookies ou JWTs, o post sobre [configuração de CORS para uma API protegida por JWT](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) cobre o lado da política.

**Deixe o framework cuidar dos callbacks do provedor de identidade.** Callbacks de OpenID Connect com `response_mode=form_post` e de WS-Federation são posts de formulário cross-site por design. No .NET 11 os handlers de autenticação remota suprimem um veredito inválido enquanto controlam o caminho do callback (`RemoteAuthenticationAntiforgery` no código-fonte), porque o parâmetro `state` e o cookie de correlação já os protegem. Você não precisa de `.DisableAntiforgery()` em `/signin-oidc`, e nem conseguiria colocá-lo ali, já que o handler é um middleware, não um endpoint.

## Pegadinhas ao atualizar do .NET 8, 9 ou 10

- **Apps que já chamam `UseAntiforgery()` não veem mudança no tráfego same-origin**, porque a validação de token é autoritativa e sobrescreve o veredito de CSRF. As chamadas `.DisableAntiforgery()` que você já tem continuam funcionando sem alteração.
- **Apps que nunca chamaram `UseAntiforgery()` param de lançar 500** em endpoints de formulário no .NET 11 (o middleware de CSRF satisfaz a verificação do endpoint), mas começam a retornar 400 para posts de navegador de outras origens. Isso pode parecer uma regressão aleatória em um formulário que recebe posts de um subdomínio irmão, já que `same-site` também é rejeitado.
- **Um 400 vindo de um endpoint de formulário nem sempre é antiforgery.** Um `Content-Type` ausente ou errado dá [415 Unsupported Media Type](/pt-br/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/), e erros no formato do binding dão nulos, como em [o dicionário `[FromForm]` que é sempre null](/pt-br/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/). Confira a categoria do log antes de desativar qualquer coisa.
- **Erros de token depois de uma implantação são outro bug.** Se formulários same-origin falham só depois de escalar horizontalmente ou reiniciar, o problema são as chaves do Data Protection, abordadas em [o token antiforgery não pôde ser descriptografado](/pt-br/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/), e não a falta de uma desativação.
- **Rotas com short-circuit não podem carregar metadados de antiforgery obrigatórios.** `.ShortCircuit()` em um endpoint de formulário que ainda exige validação é um 500 no momento da requisição (`contains anti-forgery metadata, but this endpoint is marked with short circuit and it will execute on Routing Middleware`). Depois que o endpoint é desativado, a verificação deixa de se aplicar.

## Relacionados

- [O ASP.NET Core 11 Preview 6 ativa a proteção automática contra CSRF](/pt-br/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Endpoint filters vs middleware no ASP.NET Core 11](/pt-br/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [Correção: "415 Unsupported Media Type" em um endpoint de minimal API no ASP.NET Core 11](/pt-br/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Correção: The antiforgery token could not be decrypted no ASP.NET Core](/pt-br/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Fontes

- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/anti-request-forgery) (MS Learn, seções sobre proteção automática contra CSRF e desativação por endpoint)
- [Notas de versão do ASP.NET Core no .NET 11 Preview 6: proteção automática entre origens (CSRF)](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)
- [dotnet/aspnetcore #66585](https://github.com/dotnet/aspnetcore/pull/66585) e [#67082](https://github.com/dotnet/aspnetcore/pull/67082), os PRs do middleware de CSRF
- Código-fonte na tag `v11.0.0-rc.1.26425.128`: [`CsrfProtectionMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/CsrfProtectionMiddleware.cs), [`DefaultCsrfProtection.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/DefaultCsrfProtection.cs), [`RoutingEndpointConventionBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Routing/src/Builder/RoutingEndpointConventionBuilderExtensions.cs), [`RequireAntiforgeryTokenAttribute.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Antiforgery/src/RequireAntiforgeryTokenAttribute.cs)
