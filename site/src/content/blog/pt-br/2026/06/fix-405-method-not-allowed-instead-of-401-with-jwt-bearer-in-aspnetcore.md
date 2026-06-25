---
title: "Corrigindo: 405 Method Not Allowed em vez de 401 com JWT bearer no ASP.NET Core"
description: "Um endpoint protegido retornando 405 em vez de 401 quase sempre significa que o roteamento rejeitou o verbo HTTP antes da autenticação rodar, ou que um esquema de cookie roubou o desafio. Veja como identificar qual dos dois é."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "pt-br"
translationOf: "2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-25
---

Você adicionou `[Authorize]` (ou `RequireAuthorization()`) a um endpoint, enviou uma requisição sem token esperando um `401 Unauthorized` limpo, e em vez disso recebeu `405 Method Not Allowed`. O 405 engana: ele quase nunca significa que sua autenticação está quebrada. Significa que a requisição nunca chegou ao estágio de autorização, porque o roteamento de endpoints rejeitou o verbo HTTP primeiro e fez um curto-circuito com um 405, ou, menos frequentemente, um esquema de autenticação por cookie é o desafio padrão e respondeu no lugar do handler do JWT bearer. A correção para o caso comum é enviar o verbo que o endpoint realmente mapeia (`POST` para um `MapPost`, não `GET`); a correção para o caso do esquema é definir `DefaultChallengeScheme` como o esquema bearer. Este post usa .NET 11 com `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0 e C# 14, mas o comportamento de roteamento é idêntico até o .NET 6.

## O erro em contexto

```text
HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Length: 0
```

Esse cabeçalho `Allow` é a pista. Uma falha de autenticação genuína retorna:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Se você vê `Allow` e nenhum `WWW-Authenticate`, foi o roteamento que produziu essa resposta, não o handler do JWT bearer. Se você vê `WWW-Authenticate: Bearer`, o handler rodou e você tem um problema real de autenticação, o que é outro post: [por que seu JWT retorna 401 mesmo com um token válido](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) cobre esse caminho.

## Por que o roteamento vence antes da autorização rodar

O pipeline do ASP.NET Core é ordenado. Em um app padrão de minimal API ou de controllers ele se parece com isto:

```csharp
// .NET 11, ASP.NET Core 11.0.0
var app = builder.Build();

app.UseRouting();        // 1. selects the endpoint (including method matching)
app.UseAuthentication(); // 2. reads the token, sets HttpContext.User
app.UseAuthorization();  // 3. enforces [Authorize] on the selected endpoint

app.MapControllers();
app.Run();
```

`UseRouting` roda primeiro. O roteamento faz correspondência pelo caminho da requisição *e* pelo método HTTP. Quando um caminho corresponde a uma rota registrada mas o método não, o roteamento não cai para "nenhum endpoint". Ele seleciona um endpoint sintético embutido produzido pelo `HttpMethodMatcherPolicy`, cujo único trabalho é retornar `405 Method Not Allowed` com um cabeçalho `Allow` listando os verbos que *estão* mapeados para aquele caminho. Veja a [documentação de fundamentos de roteamento](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) para entender como as policies do matcher alimentam a seleção de endpoints.

Esse endpoint 405 sintético não carrega nenhum metadado de autorização. Então, quando o `UseAuthorization` olha o endpoint selecionado, não encontra nada para impor, deixa a requisição passar, e o 405 é escrito na resposta. Sua action decorada com `[Authorize]` nunca foi sequer uma candidata, porque o verbo a eliminou durante a correspondência. A autorização literalmente não consegue rodar sobre um endpoint que o roteamento não selecionou.

É por isso que adicionar `[Authorize]` parece "causar" o 405: não causa. O 405 já estava lá antes de você adicionar a autenticação também, você só não estava reparando, porque sem `[Authorize]` um `GET` para um endpoint que só aceita `POST` também retorna 405. Adicionar `[Authorize]` muda sua *expectativa* para 401, o que expõe a incompatibilidade de verbo que você já tinha.

## Reprodução mínima

```csharp
// .NET 11, C# 14, ASP.NET Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(); // appsettings supplies Authority/Audience

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

// Only POST is mapped for /orders
app.MapPost("/orders", () => Results.Ok())
   .RequireAuthorization();

app.Run();
```

Agora chame com o verbo errado e sem token:

```bash
curl -i http://localhost:5000/orders        # implicit GET
# HTTP/1.1 405 Method Not Allowed
# Allow: POST
```

Existe um endpoint `POST /orders`, então o caminho corresponde, mas `GET` não é permitido, então o roteamento retorna 405. Você esperava 401 porque esqueceu que o endpoint só aceita `POST`. Envie o verbo certo e o 401 que você queria aparece:

```bash
curl -i -X POST http://localhost:5000/orders
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
```

## Correção 1: envie o verbo que o endpoint mapeia (a causa usual)

Nove em cada dez vezes o bug está em quem chama. O front-end, a coleção do Postman ou o teste de integração está usando um verbo que a rota não mapeia. Verifique, nesta ordem:

1. **O método HTTP na requisição.** Um `fetch` que assume `GET` por padrão contra um `MapPost`, um formulário fazendo post quando a API espera `PUT`, ou um cliente acessando `/api/orders` com `GET` quando o endpoint de leitura na verdade é `/api/orders/{id}`. O cabeçalho `Allow` informa exatamente quais verbos o caminho suporta, então leia-o.
2. **O atributo de verbo na action.** Em controllers, uma action com `[Route("orders")]` mas sem `[HttpPost]` não responde a todos os verbos da maneira que você poderia supor sob o roteamento por atributos. Fixe o verbo explicitamente com `[HttpPost("orders")]` para que um `GET` para o mesmo caminho produza um 405 deliberado, não uma surpresa.
3. **Templates de rota que colidem.** Dois endpoints no mesmo caminho com verbos diferentes não são problema. Mas um `MapGet("/orders/{id}")` e um `MapPost("/orders")` são caminhos diferentes; um `POST /orders/5` não corresponde a nenhum dos dois de forma limpa e você pode obter um 405 ou um 404 dependendo do template. Use `MapGroup` para manter os verbos de um prefixo visíveis em um só lugar: [organizando endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) mostra o padrão.

Se você quer que um recurso protegido responda 401 para *todo* verbo que um cliente possa tentar, incluindo os não mapeados, é preciso mapear um catch-all. Isso raramente é o que você quer, mas é possível com `MapMethods` cobrindo os verbos com que você se importa mais um fallback.

## Correção 2: impeça um esquema de cookie de responder ao desafio

A segunda causa aparece quando você combina o ASP.NET Core Identity (que registra autenticação por cookie) com JWT bearer e nunca define um padrão explícito. Como documentado nesta [thread de Q&A da Microsoft](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u), o desafio então roda pelo handler de cookie do Identity em vez do handler bearer. O desafio do handler de cookie é um redirecionamento para uma página de login, e quando essa rota de login não aceita o verbo da requisição original, você cai em um 405 em vez do 401 do bearer.

A correção é ser explícito sobre qual esquema autentica e qual esquema desafia:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidAudience = builder.Configuration["Jwt:Audience"],
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!))
    };
});
```

Com `DefaultChallengeScheme` definido como o esquema bearer, uma requisição não autenticada recebe `401 Unauthorized` com `WWW-Authenticate: Bearer`, não um redirecionamento de cookie que degenera em um 405. Se você legitimamente tem ambos os esquemas e alguns endpoints devem usar bearer especificamente, nomeie o esquema no atributo em vez de depender do padrão: `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. A mesma armadilha de incompatibilidade de esquema é a causa raiz por trás de muitos [tokens válidos que ainda assim retornam 401](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/), então vale a pena acertar os padrões de uma vez.

## Confirmando qual é a sua causa com logs

Você não precisa adivinhar. Aumente o nível de logging para roteamento e autorização e a origem da resposta fica óbvia:

```json
// appsettings.Development.json - .NET 11
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Routing": "Debug",
      "Microsoft.AspNetCore.Authentication": "Debug",
      "Microsoft.AspNetCore.Authorization": "Debug"
    }
  }
}
```

Se o verbo está errado, você verá o roteamento selecionar o endpoint method-not-allowed e *nenhuma* linha de log de autenticação, porque o handler nunca rodou:

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher
      Endpoint selection: 405 HTTP Method Not Supported
```

Se um esquema de cookie está desafiando, você verá o handler de cookie nomeado explicitamente:

```text
dbug: Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationHandler
      AuthenticationScheme: Identity.Application was challenged.
```

Essa única linha informa que o handler bearer não é seu esquema de desafio padrão, o que aponta diretamente para a Correção 2.

## Pegadinhas e casos parecidos

**O preflight de CORS retorna 405.** Um navegador envia um preflight `OPTIONS` antes de um `POST` ou `PUT` de origem cruzada. Se você nunca chamou `app.UseCors(...)` com uma policy que permite o método, o roteamento não tem nenhum endpoint `OPTIONS` para o caminho e responde 405, que o navegador apresenta como uma falha de CORS. A correção é configurar CORS, não a autenticação: [configurando CORS para uma API protegida por JWT](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) percorre a policy e a ordem dos middlewares. Note que o `OPTIONS` do preflight é intencionalmente não autenticado; não coloque `[Authorize]` na frente dele.

**Requisições HEAD para um endpoint que só aceita GET.** `MapGet` não responde automaticamente a `HEAD`. Um health check ou uma CDN sondando com `HEAD` contra uma rota `MapGet` recebe 405. Mapeie ambos os verbos com `app.MapMethods("/health", new[] { "GET", "HEAD" }, handler)` conforme a [documentação de route handlers](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers). Isto é uma incompatibilidade de verbo, não um problema de autenticação.

**403 não é 405.** Se você autenticou com sucesso mas não tem um role ou claim de policy exigido, recebe `403 Forbidden`, não 405 e nem 401. Um 403 significa que o token foi validado e o handler rodou; seu problema é uma verificação de policy ou role, coberta quando você [valida o issuer, audience e lifetime de um JWT](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) e os claims que ele carrega.

**Um middleware customizado fazendo curto-circuito antes do roteamento.** Se você escreveu um middleware que roda antes do `UseRouting` e escreve um 405 (por exemplo, uma allowlist de métodos feita à mão), ele vai mascarar tudo o que vem depois. Qualquer coisa que chame `context.Response.StatusCode = 405` antes do roteamento produz esse sintoma sem nenhum cabeçalho `Allow` vindo do matcher.

A linha mestra: 405 é um status de *roteamento* no ASP.NET Core, decidido antes que a autenticação e a autorização sequer olhem para a requisição. Quando você esperava 401 e recebeu 405, comece pelo verbo e pelo cabeçalho `Allow`, não pelo seu token. Reserve a depuração de autenticação para o caso em que você de fato vê `WWW-Authenticate: Bearer`.

## Relacionados

- [Por que seu JWT do ASP.NET Core retorna 401 mesmo com um token válido](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Como validar o issuer, audience e lifetime de um JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Como configurar CORS para uma API protegida por JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)

## Fontes

- [ASP.NET Core routing fundamentals](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) - correspondência de endpoints e policies do matcher de métodos
- [Route handlers in minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) - `MapMethods`, HEAD e OPTIONS
- [Microsoft Q&A: 405 Method Not Allowed instead of 401 with JWT](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) - a causa e a correção do esquema padrão de cookie
- [RFC 9110, section 15.5.6 (405 Method Not Allowed)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.6) e [15.5.2 (401 Unauthorized)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)
