---
title: "Correção: endpoints de API do ASP.NET Core retornam 401 em vez de redirecionar para a página de login após atualizar para o .NET 10"
description: "No .NET 10, a autenticação por cookie responde a endpoints do tipo API com 401/403 em vez de redirecionar para o login. Restaure isso por endpoint, globalmente ou com um switch do AppContext."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "authentication"
  - "cookies"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/fix-aspnetcore-api-endpoints-return-401-instead-of-redirecting-to-login-dotnet-10"
translatedBy: "claude"
translationDate: 2026-09-15
---

No ASP.NET Core 10, requisições não autenticadas a endpoints "com cara de API" protegidos por autenticação por cookie recebem um `401` (e as proibidas, um `403`) em vez de um `302` para o seu `LoginPath`. Isso abrange controllers `[ApiController]`, minimal APIs que leem ou escrevem JSON, retornos `TypedResults` e SignalR. A mudança é intencional. Se um navegador realmente navega até um desses endpoints, adicione `.AllowCookieRedirect()` (ou `[AllowCookieRedirect]`) a esse endpoint. Para trazer de volta o comportamento do .NET 9 em toda a aplicação, sobrescreva `OnRedirectToLogin`/`OnRedirectToAccessDenied` ou defina o switch do AppContext `Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata`. Tudo o que está abaixo foi medido no ASP.NET Core 10.0.10 (SDK 10.0.302) em comparação com o 9.0.20.

## O erro em contexto

Depois da atualização não há exceção nem nada no log. A página de login simplesmente para de aparecer. Uma requisição que antes era redirecionada para `/login` agora volta assim:

```text
HTTP/1.1 401 Unauthorized
Content-Length: 0
Server: Kestrel
Location: http://localhost:5103/login?ReturnUrl=%2Fm%2Fdto
```

Repare que o header `Location` continua lá. O handler de cookie calcula a URL de login exatamente como antes e a escreve na resposta, mas define o status como `401` em vez de `302`, então navegadores e `HttpClient` não a seguem. Um usuário autenticado que não passa em uma política de autorização recebe o mesmo tratamento: `403 Forbidden` com `Location: /denied?ReturnUrl=...` em vez de um redirecionamento para `AccessDeniedPath`.

Sintomas típicos:

- Uma aplicação Razor Pages ou MVC com alguns endpoints de minimal API: abrir um deles em uma aba do navegador mostra uma página em branco (ou a própria página de 401 do navegador) em vez do formulário de login.
- Um `fetch` no frontend que antes seguia o `302`, caía no HTML de login e detectava isso com `res.redirected` agora recebe um `401` e lança um erro em outro caminho do código.
- Testes de integração que verificavam o redirecionamento para o login (um `302` com `AllowAutoRedirect = false`, ou uma URL final em `/Account/Login` com o cliente padrão) agora falham exatamente nos endpoints listados acima, enquanto os demais continuam passando.

## Por que o .NET 10 parou de redirecionar nesses endpoints

Esta é a breaking change [Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints), lançada no .NET 10 Preview 7 e disponível de forma geral desde o 10.0.0 (novembro de 2025). Ela atende a um pedido de 2019 ([dotnet/aspnetcore#9039, "ApiController redirects to login page"](https://github.com/dotnet/aspnetcore/issues/9039)): uma página de login em HTML é inútil para um cliente JSON.

O mecanismo são os metadados do endpoint. O delegate padrão `OnRedirectToLogin` em `CookieAuthenticationEvents` agora é assim:

```csharp
// ASP.NET Core 10.0.0, src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs (abridged)
public Func<RedirectContext<CookieAuthenticationOptions>, Task> OnRedirectToLogin { get; set; } = context =>
{
    if (IsAjaxRequest(context.Request) || IsCookieRedirectDisabledByMetadata(context.HttpContext))
    {
        context.Response.Headers.Location = context.RedirectUri;
        context.Response.StatusCode = 401;
    }
    else
    {
        context.Response.Redirect(context.RedirectUri);
    }
    return Task.CompletedTask;
};

private static bool IsCookieRedirectDisabledByMetadata(HttpContext context)
{
    if (_ignoreCookieRedirectMetadata) // AppContext switch, read once
    {
        return false;
    }
    var endpoint = context.GetEndpoint();
    return endpoint?.Metadata.GetMetadata<IDisableCookieRedirectMetadata>() is not null &&
        endpoint?.Metadata.GetMetadata<IAllowCookieRedirectMetadata>() is null;
}
```

O ramo `IsAjaxRequest` (um header `X-Requested-With: XMLHttpRequest`) existe há anos. A novidade é `IDisableCookieRedirectMetadata`, que o framework anexa automaticamente nestes lugares:

- `ApiControllerAttribute` agora implementa `IDisableCookieRedirectMetadata`, então toda action de um controller `[ApiController]` o carrega.
- `RequestDelegateFactory` (e o Request Delegate Generator usado no Native AOT) o adiciona quando um handler de minimal API tem um parâmetro de corpo JSON, ou quando seu tipo de retorno é serializado como JSON.
- Os tipos `TypedResults` orientados a API (`Ok`, `Ok<T>`, `Created`, `Accepted`, `NotFound<T>`, `BadRequest`, `Conflict`, `ValidationProblem`, `ProblemHttpResult`, `JsonHttpResult<T>`, `ServerSentEventsResult<T>` e companhia) o adicionam a partir do seu `PopulateMetadata`.
- `MapHub` e `MapConnectionHandler` o adicionam para o SignalR.

Um detalhe confunde quem pesquisa sobre isso: a página do Microsoft Learn ainda chama a interface marcadora de `IApiEndpointMetadata`. Esse era o nome no Preview 7. A revisão de API a renomeou antes do GA em [dotnet/aspnetcore#63283](https://github.com/dotnet/aspnetcore/pull/63283), que também adicionou o opt-out `IAllowCookieRedirectMetadata`, os métodos de extensão `AllowCookieRedirect`/`DisableCookieRedirect` e o switch do AppContext. Em uma aplicação .NET 10 lançada, `IApiEndpointMetadata` não existe. Os tipos são `IDisableCookieRedirectMetadata` e `IAllowCookieRedirectMetadata` em `Microsoft.AspNetCore.Http.Metadata`.

## Reprodução mínima

Uma aplicação baseada em arquivo, executada uma vez no runtime do .NET 9.0.20 e outra no 10.0.10:

```csharp
// .NET 10, ASP.NET Core 10.0.10, run with: dotnet run probe.cs
#:sdk Microsoft.NET.Sdk.Web

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o => { o.LoginPath = "/login"; o.AccessDeniedPath = "/denied"; });
builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var m = app.MapGroup("/m").RequireAuthorization();
m.MapGet("/string", () => "plain text");                          // text/plain
m.MapGet("/dto", () => new Todo(1, "json"));                       // JSON response
m.MapGet("/typed", () => TypedResults.Ok(new Todo(1, "typed")));   // TypedResults
m.MapGet("/iresult", () => Results.Ok(new Todo(1, "iresult")));    // returns IResult
m.MapPost("/body", (Todo t) => "got body");                        // JSON request body
app.MapControllers();
app.Run();

public record Todo(int Id, string Title);

[ApiController, Route("c/api"), Authorize]
public class ApiCtl : ControllerBase { [HttpGet] public Todo Get() => new(1, "api"); }

[Route("c/mvc"), Authorize]
public class MvcCtl : Controller { [HttpGet] public Todo Get() => new(1, "mvc"); }
```

Estes são os resultados de `curl -D -` sem cookie. As duas primeiras colunas vêm do mesmo código; a terceira é o 10.0.10 com `IgnoreRedirectMetadata` definido como `true`:

| Endpoint | 9.0.20 | 10.0.10 | 10.0.10 + switch |
| --- | --- | --- | --- |
| `GET /m/string` (retorna `string`) | 302 | 302 | 302 |
| `GET /m/dto` (retorna um record) | 302 | **401** | 302 |
| `GET` handler assíncrono que retorna `Task<Todo>` | 302 | **401** | 302 |
| `GET /m/typed` (`TypedResults.Ok`) | 302 | **401** | 302 |
| `Results<Ok<Todo>, NotFound>` | 302 | **401** | 302 |
| `TypedResults.Json(...)` | 302 | **401** | 302 |
| `GET /m/iresult` (`Results.Ok`, declarado como `IResult`) | 302 | 302 | 302 |
| `TypedResults.Text`, `TypedResults.File`, `TypedResults.Redirect` | 302 | 302 | 302 |
| `POST /m/body` (corpo JSON) | 302 | **401** | 302 |
| Action de `[ApiController]` | 302 | **401** | 302 |
| Action de `Controller` comum (sem `[ApiController]`) | 302 | 302 | 302 |
| Qualquer endpoint com `X-Requested-With: XMLHttpRequest` | 401 | 401 | 401 |
| Autenticado, falha em `RequireRole`, endpoint JSON | 302 para `/denied` | **403** | 302 para `/denied` |
| Autenticado, falha em `RequireRole`, endpoint `string` | 302 para `/denied` | 302 para `/denied` | 302 para `/denied` |

Então a regra prática não é "APIs" em nenhum sentido arquitetural. O que importa são os metadados do endpoint. `Results.Ok(...)` continua redirecionando e `TypedResults.Ok(...)` não, porque `IResult` esconde o tipo concreto da inferência de metadados. A diferença entre as duas factories é abordada em [typed results vs IResult vs IActionResult](/pt-br/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/).

## A correção, em detalhes

Escolha a primeira opção que corresponde ao que o endpoint realmente é.

### 1. O endpoint é chamado a partir de código: mantenha o 401 e corrija o cliente

Se quem chama é `fetch`, `HttpClient` ou um app móvel, o novo comportamento é o correto, e o antigo `302` para uma página HTML era um bug que você vinha contornando. Trate o código de status em vez de farejar redirecionamentos:

```javascript
// Browser fetch against an ASP.NET Core 10 cookie-authenticated API
const res = await fetch("/api/todos", { credentials: "same-origin" });
if (res.status === 401) {
  // Cookie missing or expired: send the user to the login page ourselves
  location.href = "/login?ReturnUrl=" + encodeURIComponent(location.pathname);
} else if (res.status === 403) {
  location.href = "/denied";
} else {
  const todos = await res.json();
}
```

Aproveite para remover qualquer verificação `res.redirected` ou `res.url.includes("/login")`: no .NET 10 elas são código morto para esses endpoints. Se o seu SPA e a sua API rodam em origens diferentes, a parte de credenciais e CORS é um assunto à parte, abordado em [JWT vs autenticação por cookie no ASP.NET Core](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

### 2. Um navegador navega até o endpoint: reative o redirecionamento com `AllowCookieRedirect`

Para os poucos endpoints que um usuário realmente abre em uma aba (um link de exportação que retorna JSON, um link "ver bruto" em uma página de administração, uma action de `[ApiController]` para a qual as antigas views MVC apontam diretamente), restaure o redirecionamento por endpoint:

```csharp
// .NET 10, ASP.NET Core 10.0.10
app.MapGet("/export/orders", (OrderService s) => s.GetAll())
   .RequireAuthorization()
   .AllowCookieRedirect();

[ApiController, Route("api/reports"), Authorize]
public class ReportsController : ControllerBase
{
    [HttpGet("download"), AllowCookieRedirect]
    public ReportDto Download() => new(/* ... */);
}
```

`IAllowCookieRedirectMetadata` prevalece sobre `IDisableCookieRedirectMetadata` independentemente da ordem, então também funciona em um grupo (`app.MapGroup("/export").AllowCookieRedirect()`). No teste, `/m/dto` com `.AllowCookieRedirect()` voltou a `302`, assim como uma action de `[ApiController]` com `[AllowCookieRedirect]`. O inverso também existe. `.DisableCookieRedirect()` faz um endpoint que retorna `string` responder `401`, o que é útil para endpoints de health ou de diagnóstico que nunca devem mostrar uma página de login.

### 3. Aplicação mista: redirecione apenas navegações reais do navegador

Se você tem muitos endpoints dos dois tipos, é mais limpo decidir por requisição do que por endpoint. Todos os principais navegadores atuais (Chrome, Edge, Firefox, Safari 16.4+) enviam [`Sec-Fetch-Mode: navigate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Mode) em uma navegação de nível superior e `cors`/`same-origin` em um `fetch`:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/login";
        options.AccessDeniedPath = "/denied";

        options.Events.OnRedirectToLogin = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// ... app.Run();

static bool IsBrowserNavigation(HttpRequest request)
{
    var mode = request.Headers["Sec-Fetch-Mode"].ToString();
    if (mode.Length > 0)
        return mode == "navigate";

    // Clients without Fetch Metadata headers: fall back to the Accept header
    return HttpMethods.IsGet(request.Method)
        && request.Headers.Accept.ToString().Contains("text/html");
}
```

Medido no 10.0.10 sobre a metade `OnRedirectToLogin`: `/m/dto` com `Sec-Fetch-Mode: navigate` recebeu `302`, `/m/string` com `Sec-Fetch-Mode: cors` recebeu `401`, e um `curl` puro (sem Fetch Metadata, `Accept: */*`) recebeu `401` em todos os endpoints, inclusive nos que o framework teria redirecionado. Como isso substitui o delegate padrão, os metadados do endpoint deixam de ser consultados: quem decide é a requisição, não o endpoint.

### 4. Sempre redirecionar, exatamente como antes

Este é o trecho da página da breaking change. Use-o quando a aplicação for um site renderizado no servidor e nenhum dos seus endpoints tiver um chamador que não seja um navegador:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
```

Observe que isso também redireciona XHRs, o que o .NET 9 não fazia. Se você quer exatamente a semântica do .NET 9 (`401` para `X-Requested-With: XMLHttpRequest`, redirecionamento para todo o resto), o switch da opção 5 faz isso com uma linha.

### 5. O switch do AppContext: comportamento do .NET 9 sem escrever eventos

O switch não aparece na página do Microsoft Learn, mas foi incluído no 10.0.0 (a partir do PR #63283) e é a forma menos invasiva de voltar à semântica do .NET 9. Defina-o no arquivo de projeto:

```xml
<!-- .NET 10, in the web project's .csproj -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata"
                                  Value="true" />
</ItemGroup>
```

ou como a primeira linha de `Program.cs`:

```csharp
// .NET 10, must run before the cookie handler is first used
AppContext.SetSwitch("Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata", true);
```

O item `RuntimeHostConfigurationOption` vira uma entrada `configProperties` em `bin/.../<app>.runtimeconfig.json`. Testei tanto essa entrada quanto a chamada `SetSwitch`, e cada uma produziu a coluna "10.0.10 + switch" acima: todos os endpoints voltam a redirecionar e os XHRs continuam recebendo `401`. Trate isso como uma muleta de migração, não como destino final. Ele desativa os metadados para a aplicação inteira, incluindo o marcador nos hubs do SignalR, então uma requisição de negotiate não autenticada volta à regra anterior ao .NET 10: só um header `X-Requested-With: XMLHttpRequest` impede que ela seja redirecionada para uma página HTML.

## Armadilhas e casos parecidos

**Você já tinha um `OnRedirectToLogin` personalizado.** Então nada mudou para você, e talvez você se pergunte por que a aplicação de um colega se comporta de outro jeito. A verificação de metadados fica dentro do delegate *padrão*. Qualquer aplicação que substituiu `OnRedirectToLogin` ou derivou de `CookieAuthenticationEvents` e sobrescreveu `RedirectToLogin` a ignora completamente. Também vale o contrário: se você quer o novo comportamento *e* um evento personalizado (por exemplo, para registrar logins que falharam), chame a sua lógica e depois reproduza você mesmo a verificação de `IDisableCookieRedirectMetadata`.

**O switch é lido uma única vez.** `_ignoreCookieRedirectMetadata` é um campo `static readonly` em `CookieAuthenticationEvents`. Definir o switch depois da primeira requisição, ou alterá-lo em um teste depois que o host já iniciou, não tem efeito.

**Só o handler de cookie olha esses metadados.** No repositório do aspnetcore, o único consumidor de `IDisableCookieRedirectMetadata` é `CookieAuthenticationEvents`. Se o seu `DefaultChallengeScheme` for OpenID Connect (Microsoft.Identity.Web, Entra ID, Auth0), é o handler OIDC que emite o challenge, e ele continua redirecionando para o provedor de identidade em todos os endpoints. Se você vê um `401` ali, o esquema de cookie é o esquema de challenge para aquele endpoint, geralmente por causa de um `[Authorize(AuthenticationSchemes = ...)]` explícito ou de uma política.

**Testes de integração.** Os clientes do `WebApplicationFactory` seguem redirecionamentos por padrão, então testes que verificavam "requisição não autenticada termina na página de login" agora veem um `401` nos endpoints de API. Atualize a asserção em vez de adicionar `AllowCookieRedirect` só para manter os testes verdes; os padrões de configuração estão em [testes de integração com WebApplicationFactory](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

**O Native AOT se comporta da mesma forma.** O Request Delegate Generator emite uma classe `DisableCookieRedirectMetadata` local ao arquivo e a adiciona sob as mesmas condições de JSON que a factory baseada em reflection, então builds AOT e JIT concordam.

**O .NET 11 mantém isso.** A mesma verificação `IsCookieRedirectDisabledByMetadata` está no `main`, então, se você vai direto do .NET 8 ou 9 para o 11, isso entra na sua lista junto com as outras mudanças de autenticação em [o checklist de migração do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

**Não é este problema: 401 com bearer token, ou 405.** Se o endpoint usa JWT bearer e você recebe `401` com um header `WWW-Authenticate: Bearer`, é o próprio token que está sendo rejeitado; veja [por que um JWT no ASP.NET Core retorna 401 mesmo com um token válido](/pt-br/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/). Se você recebe `405` com um header `Allow`, o roteamento rejeitou o verbo antes de a autenticação rodar; veja [405 Method Not Allowed em vez de 401 com JWT bearer](/pt-br/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/). A mudança de cookie do .NET 10 sempre produz `401`/`403` com um header `Location` e nenhum header `WWW-Authenticate`.

## Relacionados

- [JWT vs autenticação por cookie no ASP.NET Core](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)
- [Typed results vs IResult vs IActionResult](/pt-br/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [Como escrever testes de integração com WebApplicationFactory](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Correção: 405 Method Not Allowed em vez de 401 com JWT bearer](/pt-br/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/)
- [Migrar do .NET 8 para o .NET 11: o checklist completo](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Fontes

- [Breaking change: Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) (Microsoft Learn) e o anúncio [aspnet/Announcements#525](https://github.com/aspnet/Announcements/issues/525).
- [dotnet/aspnetcore#62816: Avoid cookie login redirects for known API endpoints](https://github.com/dotnet/aspnetcore/pull/62816), a mudança original.
- [dotnet/aspnetcore#63283: Address API review feedback for what was IApiEndpointMetadata](https://github.com/dotnet/aspnetcore/pull/63283), a renomeação, `AllowCookieRedirect` e o switch `IgnoreRedirectMetadata`.
- [`CookieAuthenticationEvents.cs` na v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs) e [`RequestDelegateFactory.cs` na v10.0.12](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Http.Extensions/src/RequestDelegateFactory.cs).
- [dotnet/aspnetcore#9039: ApiController redirects to login page](https://github.com/dotnet/aspnetcore/issues/9039), o pedido de 2019 por trás da mudança.
