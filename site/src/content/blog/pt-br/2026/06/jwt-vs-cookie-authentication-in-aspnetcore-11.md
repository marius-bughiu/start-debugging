---
title: "JWT vs autenticação por cookie no ASP.NET Core 11: qual você deve escolher?"
description: "Use autenticação por cookie para qualquer app em que o navegador seja o único cliente e reserve os tokens bearer JWT para APIs chamadas por apps móveis, outros serviços ou terceiros. Aqui está a matriz de decisão completa."
pubDate: 2026-06-26
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet"
  - "authentication"
  - "security"
lang: "pt-br"
translationOf: "2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

Se a única coisa que chama o seu app ASP.NET Core 11 é um navegador, use autenticação por cookie. Se o chamador é um app móvel, outro serviço ou um cliente de terceiros que não consegue manter um cookie, use tokens bearer JWT. O único eixo que decide isso é o cliente: cookies são um mecanismo de sessão de navegador com revogação no lado do servidor e ferramentas de CSRF embutidas, enquanto JWTs são uma credencial autocontida e sem estado que qualquer cliente HTTP pode carregar, mas que você não consegue revogar antes de expirar. Escolher JWT para um site renderizado no servidor ou um single-page app de mesma origem é o erro de segurança mais comum no ecossistema .NET, porque empurra um token de longa duração para um armazenamento acessível ao JavaScript sem nenhum benefício. Este post embasa essa recomendação com a matriz de recursos, a configuração de ambos no .NET 11 e o detalhe traiçoeiro que força a decisão.

Tudo aqui mira o .NET 11, o ASP.NET Core 11 e o C# 14. Ambos os esquemas vêm prontos: a autenticação por cookie vive em `Microsoft.AspNetCore.Authentication.Cookies` e o bearer JWT vive em `Microsoft.AspNetCore.Authentication.JwtBearer`, sendo este último a única referência NuGet que você normalmente adiciona. Nada no trade-off central mudou no .NET 11, mas o framework continua empurrando você para o padrão certo: as diretrizes OAuth para apps baseados em navegador e o padrão Backend-for-Frontend reforçaram a recomendação de manter os tokens totalmente fora do navegador.

## A matriz de recursos

| Recurso                       | Autenticação por cookie               | Bearer JWT                              |
| ----------------------------- | ------------------------------------- | --------------------------------------- |
| Carregado em                  | cabeçalho `Cookie` (gerenciado pelo navegador) | cabeçalho `Authorization: Bearer`   |
| Estado no servidor            | com estado (o ticket pode ser revalidado) | sem estado (claims autocontidos)    |
| Revogável antes de expirar    | sim (imediatamente)                   | não (precisa de uma denylist ou TTL curto) |
| Definido automaticamente pelo navegador | sim                         | não (o cliente o anexa)                 |
| Exposição a CSRF              | sim, precisa de tokens antiforgery    | não (o cabeçalho não é enviado automaticamente) |
| Exposição da credencial a XSS | baixa (`HttpOnly` o esconde do JS)    | alta se armazenado em local legível por JS |
| Funciona com clientes não-navegador | desajeitado                     | nativo                                  |
| Cross-domain / multi-API      | doloroso (regras de escopo de cookie) | fácil (qualquer host valida a assinatura) |
| Tamanho do payload por requisição | valor opaco pequeno tipo id       | token completo, cresce com os claims    |
| Embutido no .NET 11           | sim                                   | sim (`AddJwtBearer`)                     |

As linhas que decidem projetos reais são revogação, CSRF e XSS. Todo o resto é encanamento.

## O que cada esquema realmente é

A autenticação por cookie emite um ticket de autenticação criptografado após o login e o armazena em um cookie que a camada de Data Protection do ASP.NET Core assina e criptografa. O navegador anexa esse cookie automaticamente a cada requisição de mesmo site. O servidor o descriptografa, reconstrói o `ClaimsPrincipal` e pode executar `OnValidatePrincipal` em cada requisição para reverificar o usuário no banco de dados, que é como você revoga uma sessão no instante em que um usuário é desativado.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.HttpOnly = true;                 // hidden from document.cookie
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.SameSite = SameSiteMode.Strict;  // blocks most CSRF by default
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.SlidingExpiration = true;
        options.LoginPath = "/login";
    });
```

A propriedade que a define é que o valor do cookie é opaco para o JavaScript quando `HttpOnly` está definido, e o servidor mantém contexto suficiente (as chaves de Data Protection e, opcionalmente, um armazenamento de apoio) para invalidá-lo. O custo é que, como o navegador envia o cookie automaticamente em requisições cross-site, você herda o CSRF e precisa se defender dele com tokens antiforgery.

A autenticação bearer JWT valida um token autocontido no cabeçalho `Authorization`. O token é um blob de claims assinado (e opcionalmente criptografado). Não há sessão no lado do servidor: a validação é pura matemática de assinatura mais claims, então qualquer número de serviços pode aceitar o mesmo token conhecendo a chave de assinatura ou a chave pública do emissor. O cliente é responsável por armazenar o token e anexá-lo a cada requisição.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";   // for key discovery
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://login.example.com",
            ValidateAudience = true,
            ValidAudience = "my-api",
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true
        };
    });
```

Acertar esses `TokenValidationParameters` é onde a maioria dos bugs de JWT vive; se você está depurando um token que o framework rejeita, veja [como validar o issuer, a audience e o lifetime de um JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). O outro lado é que você não consegue desemitir um token válido: uma vez assinado e nas mãos do cliente, ele é aceito até `exp` passar, não importa o que aconteça com a conta do usuário.

## Quando escolher autenticação por cookie

- **Apps renderizados no servidor: MVC, Razor Pages ou Blazor Server no .NET 11.** O navegador é o único cliente, ele gerencia o cookie para você e o `HttpOnly` mantém a credencial fora do alcance de qualquer script injetado. Não há token para o JavaScript vazar.
- **Um single-page app de mesma origem conversando com seu próprio backend.** Este é o caso que as pessoas mais erram. Se o seu app React ou Angular é servido a partir da mesma origem e a chama, um cookie é ao mesmo tempo mais simples e mais seguro do que cunhar um JWT e guardá-lo no `localStorage`. As diretrizes do grupo de trabalho OAuth para apps baseados em navegador direcionam explicitamente os SPAs de primeira parte a um Backend-for-Frontend apoiado em cookie em vez de tokens no navegador.
- **Você precisa de revogação instantânea.** Desativar um usuário, rotacionar uma senha ou forçar um logout global precisa fazer efeito agora. Com cookies, você revalida o principal por requisição (`OnValidatePrincipal`) ou muda a chave de Data Protection, e a próxima requisição fica não autenticada. Não há espera por um token expirar.
- **Você está usando o ASP.NET Core Identity com contas locais.** A UI padrão e o `SignInManager` do Identity são baseados em cookie, e esse é o caminho suportado de primeira parte.

O imposto que você aceita com cookies é o CSRF. Como o navegador envia o cookie em posts de formulário cross-site, você precisa de proteção antiforgery em endpoints que alteram estado. `SameSite=Strict` ou `Lax` bloqueia os casos comuns, e os tokens antiforgery do ASP.NET Core fecham o restante. Se esses tokens param de validar após um deploy, isso geralmente é um problema com o chaveiro de Data Protection, abordado em [por que o token antiforgery não pôde ser descriptografado](/pt-br/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Quando escolher bearer JWT

- **Uma API REST ou gRPC consumida por um app móvel ou desktop.** Um cliente nativo não tem um cookie jar atrelado ao seu domínio e pode armazenar um token no keychain do SO ou em armazenamento seguro, que é um lar mais seguro do que um navegador. Tokens bearer são o encaixe natural.
- **Chamadas serviço-a-serviço e microsserviços.** Um token assinado por um provedor de identidade central pode ser validado de forma independente por uma dúzia de serviços que nunca compartilham um armazenamento de sessão. Este é o cenário onde a ausência de estado é um recurso, não um problema.
- **Acesso a API de terceiros onde você não controla o cliente.** APIs públicas, integrações com parceiros e qualquer coisa conduzida pelos fluxos OAuth 2.0 de client-credentials ou authorization-code vivem em tokens bearer por design.
- **Chamadas cross-domain que um cookie não consegue alcançar de forma limpa.** Se `app.com` precisa chamar `api.other.com`, o escopo de cookie briga com você enquanto um token bearer não se importa com a origem. Se você de fato roteia uma chamada de API protegida por JWT a partir de um navegador em outra origem, a parte difícil costuma ser o preflight, não o token; veja [como configurar CORS para uma API protegida por JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

O imposto que você aceita com JWTs é a revogação. Um token vazado ou roubado é válido até expirar, então a mitigação padrão são tokens de acesso de curta duração (5 a 15 minutos) combinados com refresh tokens de duração mais longa que você pode revogar no lado do servidor. Se você está emitindo seus próprios tokens, não pule essa maquinaria; [como implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) percorre as partes de rotação e revogação.

## Por que "JWT no localStorage" é o padrão errado para navegadores

A razão de essa comparação importar é que o padrão popular de tutorial de SPA, cunhar um JWT no login e salvá-lo no `localStorage`, troca um não-problema por um real. Um SPA de mesma origem não precisa de ausência de estado; seu backend está bem ali e pode manter uma sessão. O que ele recebe em troca do token é uma credencial exfiltrável por XSS. Qualquer script que rode na sua página, incluindo um puxado por uma dependência npm comprometida, pode ler o `localStorage`, surrupiar o token e reproduzi-lo de qualquer lugar até ele expirar.

Um cookie com `HttpOnly` não pode ser lido por `document.cookie` de jeito nenhum, então o mesmo XSS que drena um token do `localStorage` não consegue roubar um cookie diretamente. Essa é a razão inteira pela qual a indústria migrou para o padrão Backend-for-Frontend: o SPA se autentica contra seu próprio backend com um cookie seguro, `HttpOnly` e `SameSite`, e o backend mantém quaisquer tokens OAuth upstream no lado do servidor, nunca os entregando ao JavaScript. O rascunho atual do IETF para apps baseados em navegador recomenda exatamente isso, e o framework BFF da Duende o empacota para o ASP.NET Core. A versão curta: tokens pertencem ao navegador apenas quando não há servidor para mantê-los por você, o que, para um app de primeira parte, é nunca.

## Executando ambos os esquemas em um só app

Escolher um esquema globalmente não significa que você só pode usar um. Um formato comum no mundo real é um site renderizado no servidor mais uma API JSON no mesmo host: cookies para as páginas, JWT para a API. Registre ambos e selecione por endpoint.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie()
    .AddJwtBearer();   // second scheme, not the default

// Pages use the default cookie scheme:
app.MapGet("/dashboard", () => Results.Ok("hello"))
   .RequireAuthorization();

// The API explicitly requires the bearer scheme:
app.MapGet("/api/orders", () => Results.Ok(orders))
   .RequireAuthorization(new AuthorizeAttribute
   {
       AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme
   });
```

O detalhe-chave: o esquema que você passa primeiro para `AddAuthentication` é o padrão, e qualquer `[Authorize]` sem um esquema explícito o usa. Endpoints que devem aceitar um token bearer precisam nomear `JwtBearerDefaults.AuthenticationScheme` explicitamente, ou o framework tentará validar um cookie, não encontrará nenhum e desafiará com um redirecionamento para a página de login em vez de retornar `401`. Esse descompasso, uma API retornando um redirecionamento de login em HTML em vez de um `401` limpo, é um sintoma frequente de um esquema padrão mal configurado. Uma variante relacionada, em que a API responde `405` em vez de `401`, e a classe mais ampla de problemas de "token válido ainda rejeitado", valem a pena conhecer antes de você lançar uma configuração mista: veja [por que um JWT do ASP.NET Core retorna 401 mesmo com um token válido](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## O detalhe traiçoeiro que escolhe por você

A latência de revogação é a função forçante. Faça uma pergunta: quando o acesso de um usuário precisa ser cortado, por quanto tempo você consegue tolerar a credencial antiga ainda funcionando?

- Se a resposta é "zero, precisa parar imediatamente" (bancos, consoles de administração, qualquer coisa onde uma conta comprometida ou demitida é uma ameaça ativa), cookies vencem, porque você pode invalidar a sessão na próxima requisição. Para obter o mesmo comportamento com JWTs, você precisa acoplar uma denylist no lado do servidor, o que reintroduz exatamente a consulta com estado que você adotou JWTs para evitar.
- Se a resposta é "alguns minutos está ok", JWTs de curta duração com refresh tokens são aceitáveis, e você mantém a ausência de estado que os torna atraentes entre serviços.

A segunda função forçante é o cliente. Um cookie é uma construção de navegador. No momento em que um cliente não-navegador precisa se autenticar, um cookie deixa de ser natural e um token bearer se torna o portador óbvio. Se o seu app tem os dois tipos de chamador, isso não é um empate, é um sinal para executar ambos os esquemas como mostrado acima, cada um nos endpoints que lhe servem.

## A recomendação, reafirmada

Para um app cujo único cliente é um navegador, incluindo um SPA de mesma origem, use autenticação por cookie: `HttpOnly`, `Secure`, `SameSite`, com antiforgery em endpoints que alteram estado. Você obtém uma credencial que o JavaScript não consegue ler e uma revogação que faz efeito na próxima requisição, e não abre mão de nada que um app web de primeira parte realmente precise. Recorra ao bearer JWT quando o chamador é um app móvel ou desktop, outro serviço ou um terceiro, onde a ausência de estado é uma vantagem genuína e não há sessão no lado do servidor para se apoiar. Quando os dois tipos de cliente existem, registre ambos os esquemas e selecione por endpoint em vez de forçar um a fazer o trabalho do outro. A decisão não é sobre qual tecnologia é mais moderna; é sobre quem está segurando a credencial e quão rápido você precisa tirá-la.

## Relacionados

- [Como validar o issuer, a audience e o lifetime de um JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Por que um JWT do ASP.NET Core retorna 401 mesmo com um token válido](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Como configurar CORS para uma API protegida por JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Como implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [Por que o token antiforgery não pôde ser descriptografado no ASP.NET Core](/pt-br/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Fontes

- [Overview of ASP.NET Core authentication (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/?view=aspnetcore-10.0)
- [Use cookie authentication without ASP.NET Core Identity (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0)
- [Authentication and authorization in minimal APIs / JWT bearer (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)
- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0)
- [OAuth 2.0 for Browser-Based Apps (IETF draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- [Securing SPAs using the BFF Pattern (Duende Software)](https://duendesoftware.com/blog/20210326-bff)
