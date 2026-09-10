---
title: "Correção: IsAuthenticated é false e RemoteUserAccount é null no Blazor WebAssembly após atualizar o MSAL"
description: "Microsoft.Authentication.WebAssembly.Msal 10.0.8, 9.0.16 e 8.0.27 passaram para o msal.js 4, cujo init assíncrono concorre consigo mesmo. Inicialize o MSAL uma vez no Program.cs ou fixe a versão 10.0.7."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "authentication"
  - "msal"
  - "entra-id"
  - "dotnet-10"
  - "aspnet-core"
lang: "pt-br"
translationOf: "2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade"
translatedBy: "claude"
translationDate: 2026-09-10
---

Se o login em um app Blazor WebAssembly quebrou quando você passou o `Microsoft.Authentication.WebAssembly.Msal` de 10.0.7 para 10.0.8 ou posterior (ou de 9.0.15 para 9.0.16, ou de 8.0.26 para 8.0.27), o problema não é de configuração. Essas versões trocaram o msal.js 2.39.0 embutido pelo 4.30.0, e agora o `init` JavaScript do pacote pode rodar duas vezes ao mesmo tempo, criando dois clientes MSAL que atrapalham um ao outro. A correção é fazer o MSAL inicializar exatamente uma vez antes de o primeiro componente renderizar: aguarde `GetAuthenticationStateAsync()` no `Program.cs` antes de `RunAsync()`. Fixar o pacote em 10.0.7 também funciona, mas só como solução provisória. Em 2026-09-10, a 10.0.12 é a versão mais recente e continua afetada.

## O erro em contexto

A mesma regressão chega às pessoas por sintomas diferentes, e cada um tem sua própria issue no `dotnet/aspnetcore`. O relato original, [dotnet/aspnetcore#66978](https://github.com/dotnet/aspnetcore/issues/66978), descreve um app que funcionava na 10.0.7 em que, após a atualização para 10.0.8 sem nenhuma outra mudança, `User.Identity.IsAuthenticated` é sempre `false` e o `RemoteUserAccount` passado para um `AccountClaimsPrincipalFactory.CreateUserAsync` personalizado durante o callback de login é `null`. A única coisa no console é o log de autorização:

```
info: Microsoft.AspNetCore.Authorization.DefaultAuthorizationService[2]
      Authorization failed. These requirements were not met:
      DenyAnonymousAuthorizationRequirement: Requires an authenticated user.
```

Depois, quem abriu a issue fez o experimento decisivo: copiar o `AuthenticationService.js` da 10.0.7 para o app com 10.0.8 resolveu o problema sem nenhuma outra mudança. O bug está na camada JavaScript.

A [dotnet/aspnetcore#68549](https://github.com/dotnet/aspnetcore/issues/68549) mostra a variante barulhenta. Na 10.0.10, recarregar uma página autenticada no Firefox falha com uma exceção lançada de `_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js`:

```
uninitialized_public_client_application: You must call and await the initialize function before attempting to call any other MSAL API.
```

O Edge não reproduziu. A [dotnet/aspnetcore#68136](https://github.com/dotnet/aspnetcore/issues/68136) é a variante silenciosa: o login funciona, mas `InteractiveRequestOptions.ReturnUrl` é ignorado e todo usuário cai em `/`. Comentários na #66978 acrescentam o logout travando da 10.0.8 à 10.0.10. Os quatro sintomas têm uma única causa.

## O que mudou na 10.0.8

O `Microsoft.Authentication.WebAssembly.Msal` não referencia o msal.js a partir de uma CDN. Ele compila o `@azure/msal-browser` dentro do asset estático `AuthenticationService.js` que o seu `index.html` carrega. O msal.js 2.x chegou ao fim da vida útil e foi sinalizado pela varredura de component governance da Microsoft, então a [dotnet/aspnetcore#66055](https://github.com/dotnet/aspnetcore/pull/66055) passou para `^4.30.0` no .NET 11 preview 4, e a mudança foi portada para todas as linhas suportadas: [#66094](https://github.com/dotnet/aspnetcore/pull/66094) para 10.0, [#66234](https://github.com/dotnet/aspnetcore/pull/66234) para 9.0 e [#66236](https://github.com/dotnet/aspnetcore/pull/66236) para 8.0. As três versões de serviço saíram em 2026-05-12. Conferi os arquivos publicados em vez de confiar nos milestones: o `AuthenticationService.js` da 10.0.7 embute o msal-browser 2.39.0, e o da 10.0.12 embute o 4.30.0.

| Linha | Última versão com msal.js 2 | Primeira versão com msal.js 4 |
| ---- | --------------------------- | ---------------------------- |
| .NET 8 | 8.0.26 | 8.0.27 |
| .NET 9 | 9.0.15 | 9.0.16 |
| .NET 10 | 10.0.7 | 10.0.8 |
| .NET 11 | 11.0.0-preview.3 | 11.0.0-preview.4 (RC 1 incluído) |

## Por que a atualização do msal.js quebra o login

O msal-browser 3.0 trouxe uma mudança que importa aqui: um `PublicClientApplication` não pode mais ser usado logo após a construção. É preciso chamar e aguardar `initialize()` antes, conforme o [guia de migração da v2 para a v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md). O pacote do Blazor adicionou essa chamada no lugar óbvio, no meio do seu `init` estático:

```ts
// Microsoft.Authentication.WebAssembly.Msal 10.0.8 through 10.0.12 (msal-browser 4.30.0)
public static async init(settings: AuthorizeServiceConfiguration, jsLoggingOptions: JavaScriptLoggingOptions) {
    if (!AuthenticationService._initialized) {
        AuthenticationService.instance = new MsalAuthorizeService(settings, new Logger(jsLoggingOptions));
        await AuthenticationService.instance.initialize(); // new in 10.0.8
        AuthenticationService.instance.initializeMsalHandler();
        AuthenticationService._initialized = true;
    }
    return Promise.resolve();
}
```

Na 10.0.7, a linha com `await` não existia. Entre ler `_initialized` e atribuí-lo não havia nenhum ponto de suspensão e, como o JavaScript roda em uma única thread, o bloco inteiro era atômico. Uma segunda chamada sempre via `_initialized === true` e não fazia nada. Agora a flag só é atribuída depois de um `await`, então uma segunda chamada que chega enquanto a primeira está suspensa também passa pela verificação.

E essa segunda chamada chega, porque o lado C# tem o mesmo formato há anos. Este é o `RemoteAuthenticationService` em `Microsoft.AspNetCore.Components.WebAssembly.Authentication` 10.0.x:

```csharp
// Microsoft.AspNetCore.Components.WebAssembly.Authentication 10.0.x
private async ValueTask EnsureAuthService()
{
    if (!_initialized)
    {
        await JsRuntime.InvokeVoidAsync("AuthenticationService.init", Options.ProviderOptions, _loggingOptions);
        _initialized = true;
    }
}
```

Todos os pontos de entrada o chamam: `GetAuthenticationStateAsync`, `RequestAccessToken`, `SignInAsync`, `CompleteSignInAsync`, `SignOutAsync` e `CompleteSignOutAsync`. Se dois deles começam antes de o primeiro `init` JS terminar, os dois o invocam. Isso era inofensivo enquanto o JS era atômico. Com o msal.js 4, cada chamada constrói seu próprio `MsalAuthorizeService`, cada uma chama `initialize()` e depois `handleRedirectPromise()`, e a segunda atribuição sobrescreve `AuthenticationService.instance`. A partir daí, todo método estático, `getUser`, `completeSignIn` e `signOut`, conversa com a instância atribuída por último. Essa instância pode ainda estar inicializando, ou pode ser a que perdeu a corrida para processar a resposta do redirecionamento.

Isso explica os sintomas. Se `getUser` atinge a segunda instância antes de o `initialize()` dela resolver, lança `uninitialized_public_client_application`, e se isso acontece ou não depende da ordem das promises, por isso o Firefox mostra o erro e o Edge não. O Blazor guarda a URL de retorno no `sessionStorage` e a apaga na primeira leitura, então, quando duas instâncias tratam um mesmo callback, uma delas fica sem estado e o `RemoteAuthenticatorView` volta para `/`. Esse é o diagnóstico que um comentarista publicou na #68136, junto com um rascunho de correção que faz o `init` devolver uma única promise compartilhada. E quando `completeSignIn` consulta a instância que não processou a resposta, nenhuma conta volta, `CreateUserAsync` recebe `null` e o usuário continua anônimo.

## Reprodução mínima

A inicialização dupla é fácil de provar sem um tenant do Entra. Crie o template com IDs fictícios, no .NET SDK 10.0.302:

```bash
dotnet new blazorwasm -au SingleOrg --client-id "00001111-aaaa-2222-bbbb-3333cccc4444" --tenant-id "aaaabbbb-0000-cccc-1111-dddd2222eeee" -o MsalRepro
```

Coloque as três referências de pacote em 10.0.12. O template puro não apresenta a condição de corrida: o `AuthorizeRouteView` espera o estado de autenticação antes de renderizar o `RemoteAuthenticatorView`, então o primeiro `init` já terminou quando qualquer outra coisa pergunta. Apps reais raramente continuam tão simples. Basta qualquer coisa fora da barreira de autorização que mexa com autenticação na inicialização, por exemplo um componente de layout que carrega dados pelo `HttpClient` autorizado. O `AuthorizeRouteView` renderiza o layout enquanto ainda está autorizando, então isto roda em paralelo com o primeiro `GetAuthenticationStateAsync`:

```razor
@* Layout/NavMenu.razor, .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12 *@
@using Microsoft.AspNetCore.Components.WebAssembly.Authentication
@inject IAccessTokenProvider TokenProvider

@code {
    protected override async Task OnInitializedAsync()
    {
        // Same effect as any startup call through the authorized HttpClient.
        await TokenProvider.RequestAccessToken();
    }
}
```

Para contar o que acontece, carregue um pequeno script de diagnóstico logo depois do `AuthenticationService.js` que envolve o `init` e observa as atribuições a `AuthenticationService.instance`:

```js
// wwwroot/probe.js, diagnostic only. Load after AuthenticationService.js.
(() => {
  const svc = window.AuthenticationService;
  const probe = window.__probe = { initCalls: 0, instances: 0 };
  let current;
  Object.defineProperty(svc, 'instance', {
    configurable: true,
    get: () => current,
    set: v => { probe.instances++; current = v; }
  });
  const init = svc.init;
  svc.init = function (...args) { probe.initCalls++; return init.apply(svc, args); };
})();
```

Carreguei `/` e `/authentication/login-callback` em um navegador baseado em Chromium e li `window.__probe` depois da inicialização. As duas rotas deram os mesmos números:

| Configuração | Chamadas a `init` | Instâncias do MSAL criadas |
| ----- | ------------ | ---------------------- |
| Msal 10.0.12 | 2 | 2 |
| Msal 10.0.7 (msal.js 2.39.0) | 2 | 1 |
| Msal 10.0.12 + pré-inicialização no `Program.cs` (correção 1) | 1 | 1 |
| Msal 10.0.12 + shim de `init` idempotente (correção 2) | 2 | 1 |

A linha da 10.0.7 é a que interessa: a chamada dupla vinda do C# sempre existiu, e o `init` síncrono do msal.js 2 a absorvia. Sem um registro de aplicativo descartável no Entra, não consegui fazer um login real com a versão quebrada, então a ligação entre a segunda instância e cada sintoma vem do código e das threads das issues acima. A instância dupla em si foi medida.

## A correção, em detalhes

### 1. Inicialize o MSAL uma vez no Program.cs

Chame o provedor de estado de autenticação uma vez, depois de `Build()` e antes de `RunAsync()`:

```csharp
// .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using MsalRepro;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

builder.Services.AddMsalAuthentication(options =>
{
    builder.Configuration.Bind("AzureAd", options.ProviderOptions.Authentication);
});

var host = builder.Build();

// Run AuthenticationService.init to completion before any component can race it.
await host.Services.GetRequiredService<AuthenticationStateProvider>().GetAuthenticationStateAsync();

await host.RunAsync();
```

Nesse ponto ainda não existe nenhum componente, então nada pode se sobrepor à chamada. O `EnsureAuthService` roda até o fim, o que atribui a flag `_initialized` do C# e a do JavaScript, e toda chamada posterior pula o `init` por completo. A interoperabilidade com JavaScript está disponível em um host WebAssembly antes do `RunAsync`, e na minha reprodução isso reduziu a contagem para uma chamada a `init` e uma instância nas duas rotas.

O custo é que a primeira renderização espera o MSAL inicializar e ler seu cache, trabalho que o app fazia de qualquer forma alguns milissegundos depois. Se o seu `AccountClaimsPrincipalFactory` chama o Microsoft Graph ou a sua própria API em `CreateUserAsync`, essa chamada também passa para antes da primeira renderização. Mantenha-a leve ou aceite uma primeira pintura um pouco mais tardia.

### 2. Ou torne o init idempotente em JavaScript

Se você não controla a inicialização, por exemplo porque uma biblioteca de componentes compartilhada dispara requisições de token que não são suas, corrija a condição de corrida onde ela está: no `init`. Este shim memoriza a promise, que é também o que o rascunho de correção da #68136 faz dentro do pacote:

```js
// wwwroot/msal-init-fix.js
// Workaround for dotnet/aspnetcore#66978, #68549, #68136
// (Microsoft.Authentication.WebAssembly.Msal 8.0.27+, 9.0.16+, 10.0.8+).
(() => {
  const svc = window.AuthenticationService;
  if (!svc || svc.__initFixApplied) return;
  const originalInit = svc.init;
  let pending;
  svc.init = function (settings, loggingOptions) {
    pending ??= originalInit.call(svc, settings, loggingOptions)
      .catch(e => { pending = undefined; throw e; });
    return pending;
  };
  svc.__initFixApplied = true;
})();
```

A ordem dos scripts importa. Ele precisa rodar depois que o script do pacote define `window.AuthenticationService` e antes de o Blazor iniciar:

```html
<!-- wwwroot/index.html -->
<script src="_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js"></script>
<script src="msal-init-fix.js"></script>
<script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
```

O C# continua chamando `init` duas vezes, mas agora as duas chamadas aguardam a mesma promise e apenas um `MsalAuthorizeService` é criado. O `.catch` limpa o cache para que uma inicialização que falhou possa ser tentada de novo em vez de falhar para sempre. Funciona porque o Blazor invoca `AuthenticationService.init` pelo nome através de `window` em cada chamada, então substituir a propriedade basta.

### 3. Ou fixe o pacote em 10.0.7

```xml
<!-- .NET 10: last Msal release that bundles msal.js 2.39.0 -->
<PackageReference Include="Microsoft.Authentication.WebAssembly.Msal" Version="10.0.7" />
```

Os equivalentes são 9.0.15 e 8.0.26. Você pode manter o `Microsoft.AspNetCore.Components.WebAssembly` em 10.0.12: essa combinação compila e o app serve o bundle 2.39.0. Note que fixar a versão puxa o `Microsoft.AspNetCore.Components.WebAssembly.Authentication` para 10.0.7 como dependência transitiva. O preço é distribuir um msal.js no fim da vida útil, que é justamente o motivo pelo qual a Microsoft atualizou, então trate isso como uma ponte. Confirme o que o navegador realmente recebe:

```bash
curl -s http://localhost:5117/_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js | grep -oE '"(2\.39\.0|4\.30\.0)"'
```

Depois de qualquer troca de versão, limpe os dados do site no navegador em que você testa. O cache do MSAL e o estado que o Blazor salva no `sessionStorage` sobrevivem às atualizações do app, algo que a [seção de solução de problemas do Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id#cookies-and-site-data) destaca justamente para esse tipo de teste.

## Armadilhas e erros parecidos

**Usuários deslogados ao fechar o navegador, com `CacheLocation = "localStorage"`.** Isso é o msal.js 4 funcionando como projetado, não a condição de corrida. A partir da v4, o MSAL criptografa o cache do `localStorage` com AES-GCM e guarda a chave em um cookie de sessão chamado `msal.cache.encryption` (presente no bundle da 10.0.12). O [guia de migração da v3 para a v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md) diz que a chave é removida quando o navegador fecha, então o `localStorage` não persiste mais entre sessões do navegador. Nenhuma das correções acima muda isso. Planeje um login silencioso ou interativo depois de reiniciar o navegador.

**O login silencioso falha só em hosts com IP privado.** Se o app roda em `192.168.x.x` ou `10.x.x.x` e o Chrome 142 ou posterior bloqueia o iframe oculto com `LocalNetworkAccessPermissionDenied`, trata-se da restrição Local Network Access do Chrome, acompanhada na [dotnet/aspnetcore#64699](https://github.com/dotnet/aspnetcore/issues/64699). Ela aparece em qualquer versão do pacote.

**Apps com `AddOidcAuthentication` não são afetados por esta mudança.** A troca do msal.js mexeu apenas no script de interoperabilidade do pacote Msal. Se você usa o provedor OIDC genérico, ou uma Blazor Web App que autentica no servidor, procure em outro lugar.

**Quando a correção sair, os contornos são inofensivos.** As três issues estão abertas no milestone 10.0.x sem correção mesclada em 2026-09-10. Deixar a chamada no `Program.cs` não custa nada depois disso. O shim vira um wrapper sem efeito, e você pode apagá-lo quando `AuthenticationService.init` guardar uma promise em vez de um booleano.

Se for um app novo e não um app quebrado, vale ler antes [Blazor Server vs WebAssembly vs United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). A autenticação no servidor evita totalmente tokens guardados no navegador.

## Relacionados

- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [JWT vs autenticação por cookie no ASP.NET Core 11](/pt-br/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), para o lado da API de um cliente WebAssembly.
- [O que é um modo de renderização do Blazor e qual deles executa o meu componente](/pt-br/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [SignalR no .NET 11 RC 1 troca um token que expira sem derrubar a conexão](/pt-br/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)

## Fontes

- [dotnet/aspnetcore#66978, problema de autenticação MSAL após atualizar para 10.0.8](https://github.com/dotnet/aspnetcore/issues/66978)
- [dotnet/aspnetcore#68549, `uninitialized_public_client_application` após recarregar no Firefox com 10.0.10](https://github.com/dotnet/aspnetcore/issues/68549)
- [dotnet/aspnetcore#68136, `RemoteAuthenticatorView` ignora `ReturnUrl` na 10.0.10](https://github.com/dotnet/aspnetcore/issues/68136)
- [dotnet/aspnetcore#66055, atualizar `@azure/msal-browser` para 4.x](https://github.com/dotnet/aspnetcore/pull/66055), e seus backports [#66094](https://github.com/dotnet/aspnetcore/pull/66094), [#66234](https://github.com/dotnet/aspnetcore/pull/66234), [#66236](https://github.com/dotnet/aspnetcore/pull/66236)
- [`AuthenticationService.ts` em `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Authentication.Msal/src/Interop/AuthenticationService.ts)
- [`RemoteAuthenticationService.cs` em `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/WebAssembly.Authentication/src/Services/RemoteAuthenticationService.cs)
- [Proteger um app autônomo Blazor WebAssembly com o Microsoft Entra ID](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id)
- [Guia de migração do msal-browser da v2 para a v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) e [guia de migração da v3 para a v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md)
- [Microsoft.Authentication.WebAssembly.Msal no NuGet](https://www.nuget.org/packages/Microsoft.Authentication.WebAssembly.Msal)
