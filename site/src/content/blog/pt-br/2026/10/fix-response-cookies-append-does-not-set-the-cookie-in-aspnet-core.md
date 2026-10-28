---
title: "Correção: Response.Cookies.Append não define o cookie no navegador no ASP.NET Core"
description: "O cabeçalho Set-Cookie é enviado, mas o navegador o rejeita ou nunca o armazena. Corrija SameSite=None sem Secure, a falta de credentials: 'include' junto com AllowCredentials, a política de consentimento e chamadas tardias a Append."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "cookies"
  - "cors"
lang: "pt-br"
translationOf: "2026/10/fix-response-cookies-append-does-not-set-the-cookie-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-10-28
---

A correção: `Response.Cookies.Append` quase nunca falha no servidor. Ele escreve um cabeçalho `Set-Cookie`, e o navegador então se recusa silenciosamente a armazená-lo. Em ordem de probabilidade, a causa é: a requisição era cross-origin e o cliente não enviou `credentials: 'include'` (ou o servidor não chamou `AllowCredentials()`), o cookie tem `SameSite=None` sem `Secure`, uma verificação de consentimento do `CookiePolicy` suprimiu um cookie que não está marcado como `IsEssential`, ou `Append` foi executado depois que a resposta já havia começado. Abra a aba Network do DevTools do navegador, selecione a resposta e olhe a subaba Cookies: o Chromium diz exatamente qual regra o bloqueou.

Tudo abaixo tem como alvo o .NET 10 e o ASP.NET Core 10 (o comportamento é idêntico nas previews do .NET 11 e está estável desde o ASP.NET Core 3.1). O comportamento dos navegadores se refere às versões atuais do Chrome, Firefox e Safari em outubro de 2026.

```text
// Roughly what Chrome DevTools shows under Network > (response) > Cookies
Set-Cookie: session=abc123; path=/; samesite=none
  ⚠ This attempt to set a cookie via a Set-Cookie header was blocked because it had the
    "SameSite=None" attribute but did not have the "Secure" attribute, which is required
    in order to use "SameSite=None".
```

E no log do ASP.NET Core, quando o logger de `Microsoft.AspNetCore.Http.ResponseCookies` está habilitado em `Warning`:

```text
warn: Microsoft.AspNetCore.Http.ResponseCookies
      The cookie 'session' has set 'SameSite=None' and must also set 'Secure'.
```

## Por que o cookie nunca chega ao document.cookie nem à próxima requisição

`Response.Cookies.Append` é um wrapper fino. No código-fonte do ASP.NET Core (`src/Http/Http/src/Internal/ResponseCookies.cs`) ele faz três coisas: se `SameSite` é `None` e `Secure` é `false`, registra o aviso acima no log; codifica o valor para URL com `Uri.EscapeDataString`; e concatena um novo cabeçalho `Set-Cookie` à resposta. Só isso. Ele não valida o domínio, não verifica o CORS e não lança exceção quando o cookie vai ser rejeitado. Todas as falhas reais acontecem depois, dentro do navegador, que aplica uma pilha de regras a cada cabeçalho `Set-Cookie`:

1. **Modo de credenciais do CORS.** Para um `fetch` ou `XMLHttpRequest` cross-origin, o navegador ignora `Set-Cookie` por completo, a menos que a requisição tenha sido feita em modo de credenciais (`credentials: 'include'` / `withCredentials = true`) e a resposta tenha trazido `Access-Control-Allow-Credentials: true` com um `Access-Control-Allow-Origin` explícito (diferente de `*`).
2. **SameSite.** Um cookie `SameSite=None` sem `Secure` é rejeitado por todos os navegadores atuais. Um cookie `Lax` ou `Strict` definido em uma resposta cross-site é rejeitado como cookie de terceiros.
3. **Secure.** Um cookie `Secure` definido sobre `http://` simples é rejeitado, com uma exceção: o Chrome (desde a versão 89) e o Firefox (desde a 75) tratam `http://localhost` como seguro para esse fim. O Safari não.
4. **Domain e Path.** Um atributo `Domain` que não corresponde ao domínio do host da resposta é rejeitado. Um `Path` que não cobre a URL que você requisita depois significa que o cookie é armazenado mas nunca enviado de volta, o que parece idêntico a "não definido".
5. **Tamanho.** Um único cookie (nome mais valor) acima de 4096 bytes é descartado.

Além das regras do navegador, o próprio ASP.NET Core tem dois pontos onde um cookie pode sumir antes de ir para a rede: a verificação de consentimento do `CookiePolicyMiddleware` e a fronteira de "a resposta já começou".

## Repro mínima: um dev server React chamando uma API ASP.NET Core

Esta é a configuração por trás da maioria das perguntas de "cookie não definido" no Stack Overflow: uma SPA em uma porta, uma API em outra.

```csharp
// .NET 10, ASP.NET Core 10 - Program.cs (broken)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

app.MapPost("/login", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Append("session", "abc123", new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.None
    });
    return Results.Ok();
});

app.MapGet("/me", (HttpContext ctx) =>
    ctx.Request.Cookies.TryGetValue("session", out var s)
        ? Results.Ok(s)
        : Results.Unauthorized());

app.Run();
```

```javascript
// Vite dev server on http://localhost:5173
await fetch("https://localhost:7001/login", { method: "POST" });
const me = await fetch("https://localhost:7001/me");
console.log(me.status); // 401
```

Três bugs separados se acumulam aqui. As chamadas `fetch` usam o padrão `credentials: 'same-origin'`, então o navegador descarta o `Set-Cookie` da resposta cross-origin e não anexa cookies a `/me`. A política de CORS não tem `AllowCredentials()`. E o cookie é `SameSite=None` sem `Secure`. Corrigir só um deles deixa você olhando para o mesmo 401, e é por isso que esse problema parece tão aleatório.

## Correção 1: envie credenciais e permita-as na política de CORS

Para qualquer chamada cross-origin, os dois lados precisam aceitar explicitamente. No cliente:

```javascript
// Browser, any framework
await fetch("https://localhost:7001/login", {
  method: "POST",
  credentials: "include"
});

// axios equivalent
axios.post("https://localhost:7001/login", null, { withCredentials: true });
```

No servidor, liste as origens exatas e chame `AllowCredentials()`:

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "https://app.example.com")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));
```

Você não pode combinar `AllowAnyOrigin()` com `AllowCredentials()`. A especificação do CORS proíbe `Access-Control-Allow-Origin: *` em uma resposta com credenciais, e o ASP.NET Core impõe isso ao montar a política, lançando `InvalidOperationException: The CORS protocol does not allow specifying a wildcard (any) origin and credentials at the same time.` Se você precisa de origens dinâmicas, use `SetIsOriginAllowed(origin => ...)` com uma verificação de verdade, nunca `_ => true`, porque refletir qualquer origem com credenciais habilitadas é uma brecha de CSRF de livro-texto. A configuração completa da política, incluindo cache de preflight, é abordada em [configurar CORS para uma API protegida por JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

A ordem dos middlewares também importa: `app.UseCors()` precisa rodar antes do endpoint que adiciona o cookie, e antes de `UseAuthentication()` / `UseAuthorization()`.

## Correção 2: combine SameSite=None com Secure, ou evite SameSite=None

O padrão de `CookieOptions.SameSite` é `SameSiteMode.Unspecified`, o que significa que o ASP.NET Core não emite nenhum atributo `SameSite` e o navegador aplica o próprio padrão. O Chromium trata um atributo ausente como `Lax`. Esse padrão é correto para quase todo app same-site, e você só deve recorrer a `None` quando o cookie realmente precisa trafegar em requisições cross-site (um iframe incorporado em outro site, um widget de terceiros, um callback de provedor de identidade que usa `form_post`).

Se você realmente precisa de `None`, `Secure` é obrigatório:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("session", token, new CookieOptions
{
    HttpOnly = true,
    Secure = true,                  // required with SameSite=None
    SameSite = SameSiteMode.None,
    Path = "/",
    MaxAge = TimeSpan.FromHours(8)
});
```

Esta é a distinção que confunde as pessoas: **SameSite diz respeito ao site, CORS diz respeito à origem.** Um site é o esquema mais o domínio registrável, e ele ignora a porta. Então `http://localhost:5173` chamando `http://localhost:5001` é cross-origin (o CORS se aplica, você precisa da Correção 1), mas same-site (cookies `Lax` funcionam). `app.example.com` chamando `api.example.com` também é same-site. Nessas configurações você não precisa de `SameSite=None`; mantenha `Lax` e corrija apenas as credenciais.

O esquema conta, porém. O Chrome usa "schemeful same-site" desde o Chrome 89, então `http://localhost:5173` chamando `https://localhost:7001` é cross-site, e um cookie `Lax` definido pela API HTTPS não será enviado nas requisições da página HTTP. Ou rode os dois dev servers no mesmo esquema (o plugin `basicSsl` do Vite ou `dotnet dev-certs https` funcionam), ou coloque a API atrás do proxy do dev server para que o navegador só converse com uma origem. A opção do proxy é a mais robusta porque reproduz a implantação same-origin de produção.

Cookies verdadeiramente cross-site (a SPA em `myapp.com`, a API em `myapi.net`) são cookies de terceiros. O Chrome os manteve habilitados por padrão depois que o Google abandonou o plano de descontinuação em abril de 2025, mas o Safari os bloqueia totalmente e o Firefox os particiona sob o Total Cookie Protection. Não construa em cima deles. Mova a API para o mesmo domínio registrável, ou mude para um Backend-for-Frontend para que o navegador guarde um cookie primário. Se você precisa incorporar cross-site, veja os cookies particionados (CHIPS). `CookieOptions` no ASP.NET Core 10 não tem uma propriedade `Partitioned`, mas `Extensions` permite que você mesmo adicione o atributo:

```csharp
// .NET 10, ASP.NET Core 10 - CHIPS partitioned cookie for a cross-site iframe
var options = new CookieOptions
{
    Secure = true,
    SameSite = SameSiteMode.None,
    HttpOnly = true
};
options.Extensions.Add("Partitioned");
ctx.Response.Cookies.Append("widget-state", value, options);
```

## Correção 3: marque o cookie como IsEssential, ou pare de exigir consentimento

Se o seu app chama `app.UseCookiePolicy()` com `CheckConsentNeeded` retornando `true`, o `CookiePolicyMiddleware` envolve a coleção de cookies da resposta e descarta silenciosamente todo cookie que não está marcado como essencial até que o usuário aceite o cookie de consentimento. Nada é registrado no nível padrão de log, e a chamada a `Append` parece ter funcionado. Os templates do ASP.NET Core 2.1 a 2.2 vinham com isso habilitado, então projetos mais antigos que foram atualizados passo a passo muitas vezes ainda carregam essa configuração.

```csharp
// .NET 10, ASP.NET Core 10 - the configuration that eats cookies
builder.Services.Configure<CookiePolicyOptions>(o =>
{
    o.CheckConsentNeeded = _ => true;
    o.MinimumSameSitePolicy = SameSiteMode.Lax;
});
// ...
app.UseCookiePolicy();
```

Ou o cookie é necessário para o app funcionar, e nesse caso defina `IsEssential = true` (e seja honesto sobre isso na sua política de privacidade), ou não é, e o comportamento correto é esperar o consentimento:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("cart", cartId, new CookieOptions
{
    IsEssential = true,
    HttpOnly = true,
    Secure = true
});
```

Você pode verificar o estado do consentimento explicitamente com `ctx.Features.Get<ITrackingConsentFeature>()`, cuja propriedade `CanTrack` informa se cookies não essenciais serão escritos. `MinimumSameSitePolicy` nas mesmas opções também pode reescrever o `SameSite` do seu cookie para algo mais restrito do que você passou, então se um cookie aparecer com um `SameSite` diferente do que você definiu, procure aqui.

## Correção 4: chame Append antes de a resposta começar

Os cabeçalhos da resposta são enviados no momento em que o primeiro byte do corpo é descarregado. Depois desse ponto, `Response.Cookies.Append` lança `InvalidOperationException: Headers are read-only, response has already started.` Os lugares clássicos onde isso acontece são um middleware que adiciona um cookie depois de `await next()`, um endpoint que escreve em `Response.Body` e depois define um cookie, e código dentro de uma resposta em streaming ou de um loop de SSE.

```csharp
// .NET 10, ASP.NET Core 10 - broken: the endpoint already wrote the body
app.Use(async (ctx, next) =>
{
    await next();
    ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
});

// fixed: register a callback that runs just before headers are flushed
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
        return Task.CompletedTask;
    });
    await next();
});
```

Se a exceção for engolida em algum lugar (um filtro de exceção, uma tarefa fire-and-forget), o sintoma visível é apenas um cookie ausente, então verifique `ctx.Response.HasStarted` em um ponto de interrupção quando suspeitar disso.

## Armadilhas que parecem "o cookie não foi definido"

**O cookie é definido, mas o seu JavaScript não consegue vê-lo.** `HttpOnly = true` o esconde de `document.cookie` por design. Verifique a aba Application do DevTools. Esse é o comportamento que você quer para tokens de sessão, como discutido em [autenticação JWT vs cookie no ASP.NET Core 11](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

**O cookie é armazenado mas não é enviado de volta.** `CookieOptions` usa `/` como padrão para `Path`, o que está ok, mas se você definir `Path = "/api/auth"` o navegador só vai anexá-lo a URLs sob esse caminho. O mesmo vale para um `Domain` definido como um domínio pai com o qual o seu host de desenvolvimento não corresponde. Deixe `Domain` sem definir, a menos que precise compartilhar entre subdomínios; um cookie host-only é mais restrito e mais seguro.

**O valor parece corrompido.** `Append` passa o valor por `Uri.EscapeDataString`, então `a b=c` chega em `document.cookie` como `a%20b%3Dc`. `Request.Cookies` o decodifica para você no servidor; leitores em JavaScript precisam de `decodeURIComponent`.

**O Safari funciona em produção mas não no localhost.** O Safari rejeita cookies `Secure` sobre `http://localhost`, enquanto Chrome e Firefox os aceitam. Rode o dev server em HTTPS com `dotnet dev-certs https --trust`.

**Componentes interativos do Blazor.** No Blazor Server ou nos modos de renderização interativos, o componente roda sobre um circuito SignalR depois que a resposta HTTP inicial já foi embora, então não há resposta à qual adicionar o cookie e `HttpContext` é nulo ou obsoleto. Defina cookies a partir de uma Razor Page, de um endpoint de minimal API que o cliente chama ou de um post de formulário em SSR estático. A mesma restrição orienta o design por trás de [`[SupplyParameterFromSession]` em SSR estático](/pt-br/2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5/).

**O cookie é grande demais.** Os navegadores descartam um cookie cujo nome mais valor excede 4096 bytes. O handler de autenticação por cookie do ASP.NET Core divide tickets grandes entre `.AspNetCore.Cookies`, `C1`, `C2` automaticamente por meio do `ChunkingCookieManager`, mas um `Response.Cookies.Append` simples não faz isso. Se você está enfiando em um cookie um JWT com muitas claims, reduza as claims ou mantenha o token no servidor e coloque um identificador curto no cookie. Fluxos de refresh token são uma fonte comum disso; veja [implementar refresh tokens no ASP.NET Core Identity](/pt-br/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) para um layout que mantém os cookies pequenos.

**Cookies de antiforgery sumindo depois de uma implantação** são um problema diferente com o mesmo sintoma. O cookie é definido, mas não pode ser descriptografado pela próxima instância. Esse caso é abordado em [corrigir "The antiforgery token could not be decrypted"](/pt-br/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Um checklist que encontra a causa em menos de um minuto

Quando um cookie não persiste, percorra estes passos em ordem. Cada passo ou encontra o bug ou descarta uma categoria inteira:

1. Abra o DevTools, aba Network, selecione a resposta que deveria definir o cookie e confirme que o cabeçalho `Set-Cookie` está presente. Se estiver ausente, o problema é do lado do servidor: política de consentimento, uma exceção depois que a resposta começou, ou o caminho de código nunca foi executado.
2. Se o cabeçalho estiver presente, abra a subaba Cookies dessa requisição. O Chromium marca cookies bloqueados com um ícone de aviso e o motivo exato (SameSite, Secure, Domain ou bloqueio de terceiros).
3. Se a chamada for cross-origin, verifique se a requisição tem `credentials: 'include'` e se a resposta tem `Access-Control-Allow-Credentials: true` mais um `Access-Control-Allow-Origin` concreto.
4. Se o cookie é armazenado mas a próxima requisição não o leva, compare o `Path`, `Domain`, `SameSite` e `Secure` dele com a URL e o esquema dessa próxima requisição.
5. Se funciona no Chrome e falha no Safari, é `Secure` sobre `http://localhost` ou um cookie de terceiros.

O código do servidor raramente é o bug. Trate `Append` como "por favor, considere armazenar isto" e depure a resposta do navegador.

## Fontes

- [ResponseCookies.cs em dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http/src/Internal/ResponseCookies.cs) (o aviso de `SameSite=None` e a codificação do valor)
- [Classe CookieOptions no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.cookieoptions)
- [Habilitar CORS no ASP.NET Core: credenciais em requisições cross-origin](https://learn.microsoft.com/en-us/aspnet/core/security/cors#credentials-in-cross-origin-requests)
- [Suporte ao Regulamento Geral sobre a Proteção de Dados (GDPR) da UE no ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/gdpr)
- [Trabalhar com cookies SameSite no ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/samesite)
- [MDN: Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie)
- [dotnet/aspnetcore#55370: Add support for Partitioned cookies](https://github.com/dotnet/aspnetcore/issues/55370)
