---
title: "Como configurar CORS para uma API protegida com JWT no ASP.NET Core 11"
description: "Um guia completo de CORS para uma API com token bearer no ASP.NET Core 11: a ordem correta do UseCors em relação à autenticação, por que um token bearer no cabeçalho Authorization não é uma credencial de CORS, por que AllowAnyHeader funciona mas um curinga manual não cobre Authorization, e como evitar que o preflight falhe."
pubDate: 2026-06-21
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "cors"
  - "jwt"
  - "security"
lang: "pt-br"
translationOf: "2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Se o seu aplicativo de página única chama uma API do ASP.NET Core protegida com JWT a partir de uma origem diferente e o console do navegador mostra "No 'Access-Control-Allow-Origin' header is present" ou "Request header field authorization is not allowed", a correção quase nunca está do lado da autenticação. Você precisa de uma política de CORS que nomeie a origem do seu front-end com `WithOrigins`, permita o cabeçalho de requisição `Authorization` e execute `app.UseCors(...)` *antes* de `app.UseAuthentication()` e `app.UseAuthorization()`. O que a maioria dos guias erra: um token bearer que você mesmo coloca no cabeçalho `Authorization` **não** é uma credencial de CORS, então você **não** precisa de `AllowCredentials()` para uma API JWT baseada em cabeçalhos, e adicioná-lo força você a abrir mão de `AllowAnyOrigin` sem nenhum benefício. Este artigo tem como alvo o .NET 11 (preview 5 no momento da escrita), mas as APIs de CORS e de JWT bearer não mudaram desde o .NET 8, 9 e 10.

## CORS e JWT são dois portões não relacionados que falham ao mesmo tempo

Uma requisição de origem cruzada de `https://app.example.com` para `https://api.example.com` passa por duas verificações completamente independentes, e confundi-las é a raiz de quase todas as tardes desperdiçadas aqui.

A primeira é o CORS. Ele é imposto pelo navegador, não pelo seu servidor. O navegador decide se o JavaScript *pode ler a resposta* com base nos cabeçalhos `Access-Control-Allow-*` que o seu servidor envia. O CORS não sabe nada sobre quem você é. Ele só se importa com origens, métodos e cabeçalhos de requisição.

A segunda é a autenticação. O manipulador de JWT bearer do ASP.NET Core valida o token no cabeçalho `Authorization` e produz um 401 ou um `ClaimsPrincipal`. Ele não sabe nada sobre origens.

A armadilha é que uma política de CORS mal configurada e um token ausente produzem erros que parecem iguais no DevTools. Um 401 sem cabeçalhos de CORS aparece no console como uma falha de CORS, porque o navegador descarta a resposta antes que o seu código possa vê-la. Então você passa uma hora no token quando o problema real é a ordem da política, ou vice-versa. Mantenha os dois portões separados na sua cabeça: o CORS decide se o navegador entrega os bytes a você, a autenticação decide se o servidor os produziu.

## Um token bearer no cabeçalho Authorization não é uma "credencial" de CORS

Este é o ponto mais mal compreendido, e acertá-lo simplifica tudo o que vem depois.

Na especificação de CORS, "credenciais" significa três coisas específicas: cookies, certificados de cliente TLS e o cabeçalho `Authorization` *que o agente de usuário preenche automaticamente* a partir de uma autenticação HTTP armazenada. Quando você escreve `fetch(url, { headers: { Authorization: "Bearer " + token } })`, está definindo um cabeçalho de requisição definido pelo autor. Isso não é uma requisição com credenciais. O modo `credentials` desse fetch ainda é o padrão `"same-origin"`, que para uma chamada de origem cruzada significa "não enviar cookies".

A consequência: para uma SPA típica que guarda o seu JWT na memória ou no `localStorage` e o anexa manualmente, você **não** deve chamar `AllowCredentials()`. Você só precisa dele quando o token (ou um token de atualização, ou uma sessão) viaja em um cookie, porque cookies são credenciais reais de CORS e o navegador não os enviará em origem cruzada a menos que a resposta diga `Access-Control-Allow-Credentials: true`.

Por que isso importa além do preciosismo? Porque `AllowCredentials()` é incompatível com `AllowAnyOrigin()`. No momento em que você adiciona credenciais, a especificação de CORS proíbe o curinga de origem `*`, e o ASP.NET Core impõe isso lançando uma exceção na inicialização:

```csharp
// .NET 11, C# 14
// This throws ArgumentException at app build time:
// "The CORS protocol does not allow specifying a wildcard (any) origin
//  and credentials at the same time."
options.AddPolicy("bad", policy => policy
    .AllowAnyOrigin()
    .AllowCredentials());
```

Então, se você adicionar `AllowCredentials()` por reflexo em uma API bearer baseada em cabeçalhos, assumiu a restrição de fixar origens sem nenhum dos benefícios. Deixe-o de fora a menos que você realmente use cookies.

## A política que funciona

Aqui está a configuração completa e correta para uma API mínima que valida JWTs e é chamada a partir de uma ou mais origens de front-end conhecidas. Se você ainda está escolhendo entre as APIs mínimas e o modelo MVC, os prós e contras são abordados em [APIs mínimas vs. controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); o CORS é idêntico nos dois casos.

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

const string SpaCors = "spa";

builder.Services.AddCors(options =>
{
    options.AddPolicy(SpaCors, policy => policy
        .WithOrigins("https://app.example.com", "http://localhost:5173")
        .WithHeaders("Authorization", "Content-Type")
        .WithMethods("GET", "POST", "PUT", "DELETE")
        .SetPreflightMaxAge(TimeSpan.FromMinutes(10)));
});

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
        // TokenValidationParameters tuned for your issuer here.
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Order is load-bearing. See the next section.
app.UseCors(SpaCors);
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Três escolhas deliberadas nessa política:

- `WithOrigins` lista origens exatas, esquema e porta incluídos. `http://localhost:5173` e `https://localhost:5173` são origens distintas, e o mesmo host em uma porta diferente também é.
- `WithHeaders("Authorization", "Content-Type")` permite os dois cabeçalhos de requisição que uma chamada JSON+JWT realmente envia. `Content-Type: application/json` não é um valor da lista segura de CORS, então dispara o preflight por conta própria.
- `WithMethods` lista os verbos que a API expõe. Um `PUT` ou `DELETE` sempre dispara o preflight.

Sem `AllowCredentials()`, porque esta é uma API bearer baseada em cabeçalhos.

## Por que o UseCors precisa ser executado antes do UseAuthentication

A ordem do middleware não é estética. `app.UseCors(...)` deve vir depois de `UseRouting` (que `WebApplication` chama implicitamente) e **antes** de `UseAuthentication` e `UseAuthorization`. A [documentação de CORS](https://learn.microsoft.com/en-us/aspnet/core/security/cors) da Microsoft estabelece a regra; aqui está o que realmente quebra se você a ignorar.

Um preflight de CORS é uma requisição `OPTIONS`, e o navegador a envia **sem** o cabeçalho `Authorization`. Isso é por design: o preflight pergunta "posso fazer esta requisição?" antes que qualquer credencial seja anexada. Se a autenticação ou uma verificação de `[Authorize]`/`RequireAuthorization` for executada antes do middleware de CORS, a requisição `OPTIONS` não autenticada recebe um 401, o navegador nunca recebe os cabeçalhos `Access-Control-Allow-*` e a requisição real nunca é enviada. Você verá uma falha de preflight na aba Network e concluirá, erroneamente, que o seu token está errado.

Com `UseCors` colocado primeiro, o middleware de CORS reconhece o preflight, responde com um 204 e os cabeçalhos corretos, e interrompe o fluxo antes que a autenticação seja executada. O `GET`/`POST` real que vem em seguida leva o token e flui pela autenticação normalmente.

A mesma ordem também corrige o problema do "401 sem cabeçalhos de CORS" para as requisições reais. Quando um token está ausente ou expirado, você *quer* que o 401 ainda leve `Access-Control-Allow-Origin` para que o navegador exponha a resposta e a sua SPA possa ler o status e redirecionar para o login. Isso só acontece se o CORS for executado antes do middleware de autenticação que produz o 401. Essa lacuna exata foi tema de um problema de longa data no ASP.NET Core ([dotnet/aspnetcore#16584](https://github.com/dotnet/aspnetcore/issues/16584)) e a ordem é a solução.

## A armadilha do curinga no cabeçalho Authorization

Esta atinge quem tenta ser permissivo no desenvolvimento e depois aperta. Conforme o [padrão Fetch](https://fetch.spec.whatwg.org/), e documentado no [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), o curinga em `Access-Control-Allow-Headers: *` **não** cobre o cabeçalho `Authorization`. O navegador trata `Authorization` como especial: ele deve ser nomeado explicitamente, ou o preflight de qualquer requisição que leve um token bearer falha com "Request header field authorization is not allowed by Access-Control-Allow-Headers".

Então, se você implementar CORS manualmente em um middleware personalizado com um literal `Access-Control-Allow-Headers: *`, as suas chamadas JWT quebram mesmo que o curinga pareça permitir tudo.

Aqui está a parte tranquilizadora para os usuários do ASP.NET Core: o `AllowAnyHeader()` integrado **não** emite um literal `*`. O `CorsService` devolve exatamente os cabeçalhos que o navegador pediu em `Access-Control-Request-Headers`, o que significa que `Authorization` é refletido e o preflight tem sucesso. Você pode verificar isso no [código-fonte do CorsService](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs): o valor de cabeçalhos permitidos vem de `GetCommaSeparatedValues(CorsConstants.AccessControlRequestHeaders)`, não de um `*` constante.

A regra prática que decorre disso:

- `AllowAnyHeader()` funciona bem para tokens bearer, porque o ASP.NET Core reflete em vez de usar curinga.
- `WithHeaders(...)` funciona apenas se você incluir `"Authorization"` na lista. Esquecê-lo é a falha de CORS autoinfligida mais comum em uma API JWT, porque `Content-Type` sozinho parece completo e o erro de 403/preflight é pouco específico.

Na dúvida, liste `Authorization` explicitamente. Não custa nada e remove uma classe inteira de bugs.

## Configurando corretamente, passo a passo

1. Registre o CORS com uma política nomeada em `AddCors`, fixando as origens do seu front-end com `WithOrigins` (esquema, host e porta exatos).
2. Permita os cabeçalhos de requisição que o seu cliente envia. Inclua `"Authorization"` e `"Content-Type"` explicitamente com `WithHeaders`, ou use `AllowAnyHeader()` e confie no reflexo de cabeçalhos do ASP.NET Core.
3. Permita os métodos HTTP que os seus endpoints expõem com `WithMethods`, incluindo os verbos (`PUT`, `DELETE`) que sempre disparam o preflight.
4. Decida sobre as credenciais: omita `AllowCredentials()` para um token bearer baseado em cabeçalhos; adicione-o apenas se um cookie estiver envolvido, e nesse caso substitua `AllowAnyOrigin` por `WithOrigins` explícito.
5. Coloque `app.UseCors("policy")` depois do roteamento e antes de `app.UseAuthentication()` e `app.UseAuthorization()`.
6. Aplique a política globalmente com `app.UseCors(...)`, ou por endpoint com `.RequireCors("policy")` (ou `[EnableCors("policy")]` em controllers). Não misture CORS de middleware global com o atributo no mesmo aplicativo.

## Cookies, tokens de atualização e o caso com credenciais

Se o seu design guarda o token de acesso na memória mas armazena um token de atualização em um cookie `HttpOnly` (um padrão comum e sólido, veja [como implementar tokens de atualização no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), então a chamada de atualização *é* com credenciais e as regras se invertem:

```csharp
// .NET 11, C# 14
options.AddPolicy("spa-with-cookie", policy => policy
    .WithOrigins("https://app.example.com") // exact origins only, no AllowAnyOrigin
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .AllowCredentials());                    // required so the browser sends the cookie
```

No cliente, esse endpoint específico precisa de `fetch(url, { credentials: "include" })`. O servidor deve responder com um `Access-Control-Allow-Origin` específico (nunca `*`) e `Access-Control-Allow-Credentials: true`, que é exatamente o que a política acima produz. O ASP.NET Core continua refletindo os cabeçalhos permitidos em vez de usar curinga, então `Authorization` continua funcionando também no caso com credenciais. A conclusão: limite `AllowCredentials()` à política que realmente toca cookies, não à sua API inteira.

## Reduzindo o ruído do preflight

Cada requisição de origem cruzada com um método ou cabeçalho não simples paga o custo de uma ida e volta de preflight. `SetPreflightMaxAge(TimeSpan.FromMinutes(10))` diz ao navegador que ele pode armazenar em cache o resultado do preflight, de modo que chamadas repetidas ao mesmo endpoint pulam o salto `OPTIONS`. Os navegadores limitam esse valor (o Chromium honra até duas horas, o Firefox até 24, e ambos têm os seus próprios tetos), então trate-o como uma dica e não como uma garantia. Mesmo assim vale a pena defini-lo em uma API muito tagarela.

Se você só precisa de algumas origens de front-end e a mesma política em todos os lugares, `AddDefaultPolicy` mais um `app.UseCors()` sem parâmetros é um pouco menos cerimonioso que uma política nomeada. Para uma API maior em que diferentes grupos de endpoints têm regras diferentes, combine uma política nomeada com `.RequireCors(...)` em um `MapGroup`, que combina naturalmente com a estrutura descrita em [organizar endpoints de APIs mínimas com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Quando o token é rejeitado e o CORS não é o problema

Assim que o preflight passa e a requisição real leva `Access-Control-Allow-Origin`, qualquer 401 restante é uma falha de autenticação genuína, e você deve parar de olhar para o CORS. Os suspeitos de sempre são um `Audience` ou `Authority` que não combinam, um descompasso de relógio na vida útil do token, ou ferramentas que descartam o cabeçalho silenciosamente. Se uma interface como Scalar ou Swagger envia requisições sem o token bearer mesmo que você o tenha colado, esse é um problema separado e bem documentado, abordado em [por que o seu token bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) e em [adicionar fluxos de autenticação OpenAPI ao Swagger UI](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

O modelo mental que te mantém longe de problemas: o CORS é o navegador perguntando "esta chamada de origem cruzada é permitida, e posso ler a resposta?" e o JWT bearer é o servidor perguntando "eu confio neste token?". Configure a política para nomear as suas origens e o cabeçalho `Authorization`, execute `UseCors` antes do middleware de autenticação, omita `AllowCredentials` a menos que haja um cookie em jogo, e os dois portões param de interferir um no outro.

Fontes: [Enable Cross-Origin Requests (CORS) in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/cors), [Access-Control-Allow-Headers - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), [Fetch Standard - WHATWG](https://fetch.spec.whatwg.org/), [CorsService source - dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs), [aspnetcore#16584 - CORS headers and JWT bearer 401](https://github.com/dotnet/aspnetcore/issues/16584).
