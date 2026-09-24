---
title: "Correção: Unable to find the required 'IAuthenticationService' service com [Authorize(Policy = ...)] no Blazor"
description: "Uma página de Blazor Web App com [Authorize] vira um endpoint que o AuthorizationMiddleware verifica, e uma verificação que falha chama ChallengeAsync, que exige AddAuthentication. Registre um scheme real, ou deixe os endpoints de componentes passarem até o AuthorizeRouteView."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-10"
  - "authorization"
lang: "pt-br"
translationOf: "2026/09/fix-unable-to-find-the-required-iauthenticationservice-blazor-authorize-policy"
translatedBy: "claude"
translationDate: 2026-09-24
---

`Unable to find the required 'IAuthenticationService' service` em uma página Blazor com `@attribute [Authorize(Policy = "...")]` significa que o `AuthorizationMiddleware` do ASP.NET Core avaliou sua policy para a requisição HTTP, a verificação falhou e ele tentou chamar `HttpContext.ChallengeAsync()` sem nenhum serviço de autenticação registrado. A correção de verdade é `builder.Services.AddAuthentication(...)` com um scheme (normalmente cookies), para que o challenge tenha para onde ir. Se o seu app autentica apenas por meio de um `AuthenticationStateProvider` customizado, registre um `IAuthorizationMiddlewareResultHandler` que deixe passar os endpoints de componentes Razor, e deixe o `AuthorizeRouteView` aplicar a policy.

Tudo abaixo foi reproduzido no .NET 10.0.10 (SDK 10.0.302) e no .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) com o template padrão `dotnet new blazor -int Server`. Os dois runtimes deram resultados idênticos em todos os cenários.

## O erro em contexto

O navegador recebe um 500 na primeira requisição à página protegida. O log mostra que o challenge vem do middleware de autorização, não do Blazor:

```text
fail: Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddleware[1]
      An unhandled exception has occurred while executing the request.
      System.InvalidOperationException: Unable to find the required 'IAuthenticationService' service. Please add all the required services by calling 'IServiceCollection.AddAuthentication' in the application startup code.
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.GetAuthenticationService(HttpContext context)
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.ChallengeAsync(HttpContext context)
         at Microsoft.AspNetCore.Authorization.Policy.AuthorizationMiddlewareResultHandler.<>c__DisplayClass0_0.<<HandleAsync>g__Handle|0>d.MoveNext()
      --- End of stack trace from previous location ---
         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)
         at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
```

O padrão revelador que leva as pessoas ao Stack Overflow e à [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678): navegar até a página de dentro do app funciona, mas recarregá-la, abri-la por um favorito ou abri-la como primeira página de uma sessão quebra.

## Por que isso acontece

Três peças do ASP.NET Core se alinham para produzir a exceção.

1. **Um componente roteável é um endpoint HTTP.** Desde o .NET 8, `MapRazorComponents<App>()` cria um endpoint para cada `@page`. O `RazorComponentEndpointFactory` copia todos os atributos do tipo do componente para os metadados do endpoint, incluindo `[Authorize]` (veja o comentário "All attributes defined for the type are included as metadata" no código-fonte).
2. **`UseAuthorization()` é adicionado para você.** O `WebApplicationBuilder` insere o middleware de autorização automaticamente sempre que `IAuthorizationHandlerProvider` está registrado, e `AddAuthorizationCore()` o registra. Você não precisa chamar `app.UseAuthorization()` para ser afetado; minha reprodução nunca o chama.
3. **Uma policy que falha vira um challenge.** O `AuthorizationMiddlewareResultHandler` padrão chama `context.ChallengeAsync()` para um usuário anônimo e `context.ForbidAsync()` para um usuário autenticado que não passa na policy. Os dois precisam de `IAuthenticationService`, que só o `AddAuthentication()` registra.

Ou seja, o middleware executa sua policy contra `HttpContext.User`. Seu `AuthenticationStateProvider` customizado não é consultado em nenhum momento nesse caminho, e é por isso que o próximo ponto surpreende as pessoas: **o erro também acontece para usuários que o seu provider considera autenticados**. Na minha reprodução, um provider que retorna um principal com a role `Admin` ainda recebeu um 500 em `/admin`, porque `HttpContext.User` estava anônimo.

A navegação do lado do cliente dentro de um circuito interativo nunca faz uma requisição HTTP, então o middleware nunca a vê. Ali quem avalia `[Authorize]` é o `AuthorizeRouteView`, usando o `AuthenticationStateProvider`. Essa é toda a explicação para "funciona quando clico no link, quebra no F5".

Isso funcionava no Blazor Server do .NET 7 porque `_Host.cshtml` era o único endpoint e os componentes nunca eram mapeados individualmente. [Migrar para um Blazor Web App](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) é exatamente o momento em que a maioria das pessoas encontra esse erro.

## Reprodução mínima

Um Blazor Web App que autentica contra uma API externa e expõe o resultado apenas por meio de um `AuthenticationStateProvider` customizado, sem nenhum scheme de autenticação do ASP.NET Core:

```csharp
// .NET 10.0.10 / .NET 11 RC 1, Program.cs
using System.Security.Claims;
using AuthRepro.Components;
using Microsoft.AspNetCore.Components.Authorization;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<AuthenticationStateProvider, ApiTokenAuthStateProvider>();
builder.Services.AddAuthorizationCore(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));

var app = builder.Build();
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();

class ApiTokenAuthStateProvider : AuthenticationStateProvider
{
    public override Task<AuthenticationState> GetAuthenticationStateAsync() =>
        Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
}
```

```razor
@* .NET 10 / 11, Components/Pages/Admin.razor *@
@page "/admin"
@attribute [Authorize(Policy = "Admins")]
<h1>Admin area</h1>
```

`Routes.razor` usa `<AuthorizeRouteView>` com um bloco `<NotAuthorized>`. Fazendo curl no app em execução, o resultado é:

| Requisição | Resultado |
| --- | --- |
| `GET /` | 200 |
| `GET /admin` | 500, exceção de `IAuthenticationService` |
| `GET /admin`, provider retorna um Admin | 500, mesma exceção |

## Correção 1: registre um scheme de autenticação real (recomendado)

Se os usuários fazem login no seu app, dê ao ASP.NET Core um scheme que saiba quem eles são na requisição HTTP. Para um app Blazor renderizado no servidor, isso quase sempre significa cookies:

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authentication.Cookies;

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.LoginPath = "/login";
        o.AccessDeniedPath = "/access-denied";
    });

builder.Services.AddAuthorization(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));
```

Com isso no lugar, `GET /admin` como usuário anônimo retorna `302` para `/login?ReturnUrl=%2Fadmin` em vez de lançar a exceção. Um usuário autenticado que não tem a role é enviado para `AccessDeniedPath`.

Dois ajustes adicionais tornam isso correto, e não apenas silencioso:

- **Faça o login com o cookie.** Se o seu fluxo de login chama uma API externa e recebe um token de volta, finalize-o com `HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal)` a partir de uma página de SSR estático ou de um endpoint de minimal API, com as claims que importam para você (roles, id do usuário). Você pode guardar o token da API nas `AuthenticationProperties` do cookie se chamadas posteriores precisarem dele.
- **Remova o `AuthenticationStateProvider` customizado se ele só duplicava esse trabalho.** O `ServerAuthenticationStateProvider` nativo do Blazor lê `HttpContext.User` durante a pré-renderização e o repassa ao circuito, então as páginas, o `AuthorizeView` e o middleware concordam sobre quem é o usuário.

Se você não tem certeza se cookies ou tokens se encaixam no seu app, [autenticação JWT vs cookie no ASP.NET Core](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) explica os trade-offs. Para um Blazor Web App que serve a própria UI, cookies vencem quase sempre.

Um detalhe que vale conhecer: desde o .NET 7, quando exatamente um scheme está registrado, ele se torna o padrão automaticamente. `AddAuthentication().AddCookie()` sem argumento de scheme padrão também funcionou na minha reprodução, redirecionando para o `/Account/Login` padrão do handler de cookie. Assim que você adiciona um segundo scheme (OpenID Connect, JWT bearer), nomeie os padrões explicitamente, ou você troca este erro por `No authenticationScheme was specified, and there was no DefaultChallengeScheme found`.

## Correção 2: deixe os endpoints de componentes passarem até o AuthorizeRouteView

Alguns apps realmente não têm identidade no nível HTTP: o app Blazor Server chama uma Web API separada, guarda o token no estado do circuito e expõe o usuário apenas por meio de um `AuthenticationStateProvider` customizado. Adicionar um scheme de cookie nesse caso significa reconstruir o fluxo de login. A alternativa é mudar o que o middleware de autorização faz quando uma policy falha, usando o ponto de extensão documentado [`IAuthorizationMiddlewareResultHandler`](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse):

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Components.Endpoints;

builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    BlazorAuthorizationMiddlewareResultHandler>();

sealed class BlazorAuthorizationMiddlewareResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context,
        AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        // Razor component pages: let the request through. AuthorizeRouteView
        // re-checks [Authorize] against the AuthenticationStateProvider.
        if (context.GetEndpoint()?.Metadata.GetMetadata<ComponentTypeMetadata>() is not null)
            return next(context);

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
```

`ComponentTypeMetadata` (público, em `Microsoft.AspNetCore.Components.Endpoints`) é anexado a todo endpoint que `MapRazorComponents` cria, então a passagem se aplica apenas às páginas. Todo o resto mantém o comportamento padrão.

Resultados medidos com esse handler e sem nenhuma chamada a `AddAuthentication()`:

| Requisição | Usuário do provider | Resultado |
| --- | --- | --- |
| `GET /admin` | anônimo | 200, conteúdo de `<NotAuthorized>` renderizado |
| `GET /admin` | tem a role `Admin` | 200, página renderizada |
| `GET /api/secret` (`RequireAuthorization("Admins")`) | qualquer um | 500, exceção de `IAuthenticationService` |

Entenda o que você está assumindo com essa correção:

- **A página é protegida pelo `AuthorizeRouteView`, não pelo middleware.** Ele renderiza `<NotAuthorized>` no lugar da página, durante a pré-renderização e no circuito. Seu `Routes.razor` precisa usar `AuthorizeRouteView` (o `RouteView` simples ignora `[Authorize]`), e o conteúdo de `<NotAuthorized>` é o que os usuários anônimos veem, então coloque um link de login ali.
- **A resposta é 200, não 401 nem 302.** Crawlers e monitores de uptime veem uma página bem-sucedida. Se você precisa de um redirecionamento, faça-o a partir do bloco `<NotAuthorized>` com `NavigationManager.NavigateTo("/login")`, ou use a Correção 1.
- **Endpoints que não são componentes ainda precisam da Correção 1.** A última linha da tabela é proposital: uma minimal API ou um controller atrás de uma policy não tem um `AuthorizeRouteView` para recorrer. Se você tem esses endpoints, precisa de um scheme real de qualquer forma.

Não "corrija" isso registrando um handler de autenticação vazio cujo challenge não faz nada. O middleware interrompe o pipeline depois de um challenge, então os usuários recebem uma página 200 vazia sem nenhuma explicação, o que é pior que a exceção.

## Correção 3: mova a verificação para dentro do componente

Se apenas uma seção da página é restrita, o atributo é a ferramenta errada. Remova `@attribute [Authorize(...)]` e envolva o markup protegido:

```razor
@* .NET 10 / 11 *@
@page "/admin"

<AuthorizeView Policy="Admins">
    <Authorized><h1>Admin area</h1></Authorized>
    <NotAuthorized><p>You need the Admin role.</p></NotAuthorized>
</AuthorizeView>
```

Sem metadados de endpoint, sem verificação do middleware, sem exceção: na mesma reprodução (ainda sem `AddAuthentication()`), essa página retornou 200 com o conteúdo de `<NotAuthorized>` para um usuário anônimo e o markup de admin para um Admin. Isso bate com a observação de quem abriu a #55678 de que `<AuthorizeView>` na primeira página nunca falhava. Funciona bem para controlar o que aparece na UI, mas lembre-se de que tudo o que é renderizado no servidor ainda é enviado aos usuários que passam na verificação, então o acesso a dados no componente também deve verificar a autorização, não apenas o markup.

## Armadilhas e erros parecidos

**Uma `FallbackPolicy` quebra todas as páginas, inclusive a página inicial.** `AddAuthorization(o => o.FallbackPolicy = ...RequireAuthenticatedUser()...)` se aplica a todo endpoint que não tem seus próprios metadados de autorização. Na minha reprodução, `GET /` passou de 200 para 500 com a mesma exceção. Apps Blazor Server clássicos que ainda usam `_Host.cshtml` e `MapBlazorHub()` caem no erro desse jeito (ou via `MapBlazorHub().RequireAuthorization()`), já que seus componentes não são endpoints individuais.

**`AddAuthorizationCore()` vs `AddAuthorization()` não é a causa.** Os dois registram o handler provider que faz o `WebApplicationBuilder` inserir `UseAuthorization()`. Trocar um pelo outro não muda nada aqui.

**Blazor WebAssembly standalone nunca mostra esse erro.** Não existe pipeline do ASP.NET Core no cliente. Se um app WebAssembly acha que o usuário é anônimo depois do login, esse é outro problema, tratado em [IsAuthenticated é false depois de uma atualização do MSAL](/pt-br/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/).

**O render mode não importa.** A requisição que falha é o GET HTTP inicial que serve a página, antes de qualquer interatividade começar. Páginas de SSR estático, Interactive Server, WebAssembly e Auto se comportam da mesma forma. Se os render modes ainda parecem confusos, [qual render mode executa meu componente](/pt-br/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) explica onde cada um é executado.

**O usuário do `AuthenticationStateProvider` não chega ao `HttpContext.User`.** O fluxo só vai no sentido contrário: o `ServerAuthenticationStateProvider` lê do `HttpContext`. Tudo o que roda antes da renderização dos componentes (middleware, filtros de endpoint, rate limiting particionado por usuário) só vê o que um handler de autenticação colocou ali.

## Relacionados

- [Migrar um app Blazor Server para um Blazor Web App no .NET 11](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), a migração que normalmente faz esse erro aparecer.
- [Autenticação JWT vs cookie no ASP.NET Core 11](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), para escolher o scheme da Correção 1.
- [O que é um render mode do Blazor e qual deles executa meu componente?](/pt-br/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [Correção: JavaScript interop calls cannot be issued at this time durante a pré-renderização do Blazor](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/), outro erro que só aparece na primeira requisição HTTP.

## Fontes

- [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678), "Exception triggered by AuthorizeAttribute on the first page loaded in a circuit", e [#53732](https://github.com/dotnet/aspnetcore/issues/53732) sobre `AddAuthorizationCore` sem autenticação em Blazor Web Apps do .NET 8.
- [`RazorComponentEndpointFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointFactory.cs) e [`ComponentTypeMetadata.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/ComponentTypeMetadata.cs) na tag `v10.0.0`.
- [`WebApplicationBuilder.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/DefaultBuilder/src/WebApplicationBuilder.cs) (`UseAuthentication` / `UseAuthorization` automáticos) e [`AuthorizationMiddlewareResultHandler.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authorization/Policy/src/AuthorizationMiddlewareResultHandler.cs).
- [Customize the behavior of AuthorizationMiddleware](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) e [ASP.NET Core Blazor authentication and authorization](https://learn.microsoft.com/aspnet/core/blazor/security/) no Microsoft Learn.
- [Authentication uses single scheme as DefaultScheme](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-7.0#authentication-uses-single-scheme-as-defaultscheme) em What's new in ASP.NET Core 7.0.
