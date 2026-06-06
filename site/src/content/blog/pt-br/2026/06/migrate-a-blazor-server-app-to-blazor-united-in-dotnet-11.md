---
title: "Migrar um app Blazor Server para Blazor United (Blazor Web App) no .NET 11"
description: "Uma lista de passos para mover um app Blazor Server independente para o template unificado Blazor Web App no .NET 11, mantendo cada página em InteractiveServer sem mudança de comportamento."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Se você tem um app Blazor Server independente (`dotnet new blazorserver`) e quer movê-lo para o template unificado que foi apelidado de "Blazor United" durante o ciclo de versão prévia do .NET 8 e que foi lançado como **Blazor Web App**, a migração é em sua maior parte mecânica e geralmente leva meio dia para um app pequeno, de um a três dias para um grande. Nada do código dos seus componentes precisa mudar. O que muda é o host: `_Host.cshtml` desaparece, o roteamento se move para um componente `Routes`, o `Program.cs` troca `MapBlazorHub` por `MapRazorComponents`, e você declara um render mode de forma explícita. Mantenha cada página em `@rendermode InteractiveServer` e o comportamento permanece idêntico ao do Blazor Server da era .NET 7. A única coisa que morde é a dupla execução do prerendering. Este guia tem como alvo o **.NET 11** (versão prévia no momento da escrita, com GA programado para novembro de 2026) e o conjunto de pacotes `Microsoft.AspNetCore.Components` 11.0.x.

## Por que sair do template Server independente

O template `blazorserver` independente ainda funciona no .NET 11, então esta não é uma migração forçada. Faça-a quando um destes for um resultado real que você deseja, não antes:

- **Render modes por página.** Uma vez no template Web App você pode colocar uma página de marketing em `@rendermode StaticServer` (sem circuito SignalR, sem JavaScript, indexa como uma Razor Page) enquanto mantém o dashboard em `InteractiveServer`. Você não pode misturar modos de jeito nenhum no template independente.
- **Um caminho para WebAssembly e Auto sem uma reescrita.** Adicionar mais tarde um widget com capacidade offline significa adicionar um projeto `.Client` e um `@rendermode InteractiveWebAssembly`, não portar o app inteiro.
- **Você está no padrão recomendado pela Microsoft.** Os templates, os exemplos da documentação e os novos tutoriais lideram com o template Blazor Web App desde o .NET 8. Ficar no Server independente é agora um desvio que você precisa justificar na revisão de código.
- **Estado de circuito resiliente no .NET 10+.** O template Web App junto com o atributo `[PersistentState]` pode restaurar o estado do componente quando um circuito SignalR derrubado se reconecta, algo que o antigo modelo `ServerPrerendered` nunca fez de forma limpa.

Se nenhum desses se aplica, uma mudança `<TargetFramework>net11.0</TargetFramework>` no seu app Server independente existente é uma alternativa válida e não é esta migração.

## O que quebra

| Área                       | Mudança                                                                                       | Severidade |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| Página host                | `Pages/_Host.cshtml` e `_Layout.cshtml` são substituídos por um componente host raiz `App.razor` | high     |
| Roteamento                 | `<Router>` se move para fora do `App.razor` para um novo `Routes.razor`                       | high     |
| Inicialização em `Program.cs` | `AddServerSideBlazor()` + `MapBlazorHub()` + `MapFallbackToPage("/_Host")` substituídos por `AddRazorComponents().AddInteractiveServerComponents()` + `MapRazorComponents<App>().AddInteractiveServerRenderMode()` | high     |
| Render mode                | A interatividade é opt-in por componente ou global; não há um "o app inteiro é interativo" implícito | high     |
| Prerendering               | `OnInitialized`/`OnInitializedAsync` executam duas vezes (passada de prerender + passada interativa) por padrão | medium   |
| Script de cliente          | `_framework/blazor.server.js` passa a ser `_framework/blazor.web.js`                         | medium   |
| Cabeamento de autenticação | O componente `CascadingAuthenticationState` é substituído por `AddCascadingAuthenticationState()` na DI | medium   |
| Acesso ao `HttpContext`    | `HttpContext` só está disponível durante o SSR estático, não dentro de um componente interativo | medium   |
| Semântica do `App.razor`   | `App.razor` não é mais o roteador; é o shell do documento HTML                               | low      |

## Lista pré-decolagem

- Instale o **SDK do .NET 11** (`dotnet --version` reporta `11.0.1xx`). Confirme com `dotnet --list-sdks`.
- Faça commit de um ponto de verificação limpo e **crie um branch**. Esta migração deleta arquivos; você quer um caminho fácil de volta.
- Anote o seu ponto de entrada atual. O Blazor Server independente usa ou `_Host.cshtml` (o layout comum anterior ao .NET 8) ou já um host `App.razor`. Os passos abaixo assumem `_Host.cshtml`.
- Inventarie cada `OnInitializedAsync` que tenha efeitos colaterais (escritas, eventos de analytics, fetches de uma única vez). Esses são os métodos que o prerendering executará duas vezes. Você revisitará cada um no passo 7.
- Atualize seu CI para uma imagem de SDK do .NET 11 e confirme que um `dotnet build` e um `dotnet test` de referência passam sobre o código atual antes de tocar em qualquer coisa.
- Faça o scaffold de um app de referência descartável com `dotnet new blazor --interactivity Server -o _ref` para ter um `App.razor`, `Routes.razor` e `Program.cs` conhecidos como bons dos quais copiar a estrutura.

## Passos de migração

### 1. Suba o target framework e os pacotes

Edite o `.csproj`. O SDK continua sendo `Microsoft.NET.Sdk.Web`.

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
</PropertyGroup>
```

Suba qualquer referência de pacote `Microsoft.AspNetCore.Components.*` para `11.0.x`. Remova `Microsoft.AspNetCore.Components.Web` se ele for referenciado explicitamente; ele faz parte da referência de framework para os projetos do SDK web.

Verifique: `dotnet restore` é concluído e `dotnet build` falha apenas com erros sobre a página host e o `Program.cs` (esperado neste ponto), não com erros de resolução de pacotes.

### 2. Crie o componente host `App.razor`

No template Server independente, o documento HTML vive em `Pages/_Host.cshtml` e `Pages/_Layout.cshtml`. Mova essa marcação para um novo `App.razor` raiz (delete primeiro o antigo roteador `App.razor`, ou renomeie-o). O tag helper `<component>` que inicializava a raiz passa a ser `<Routes />`.

```razor
@* .NET 11 - App.razor is now the HTML document shell, not the router *@
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="YourApp.styles.css" />
    <HeadOutlet />
</head>
<body>
    <Routes />
    <script src="_framework/blazor.web.js"></script>
</body>
</html>
```

Duas mudanças fáceis de passar batido: o script é `blazor.web.js` (não `blazor.server.js`), e `<HeadOutlet />` junto com `<Routes />` são componentes, então adotam o render mode que você atribuir no passo 6.

Verifique: o arquivo compila como um componente Razor (sem diretiva `@page`, sem `@model`).

### 3. Mova o roteamento para `Routes.razor`

Crie `Routes.razor` na raiz do projeto e cole o bloco `<Router>` que costumava viver no antigo `App.razor`.

```razor
@* .NET 11 - Routes.razor holds the router that used to be in App.razor *@
<Router AppAssembly="@typeof(Program).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
        <FocusOnNavigate RouteData="@routeData" Selector="h1" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <LayoutView Layout="@typeof(Layout.MainLayout)">
            <p role="alert">Sorry, there's nothing at this address.</p>
        </LayoutView>
    </NotFound>
</Router>
```

Verifique: um `dotnet build` não reclama mais de um tipo `Routes` ausente.

### 4. Habilite as abreviações de render mode em `_Imports.razor`

Adicione esta linha ao `_Imports.razor` para que você possa escrever `InteractiveServer` em vez de qualificá-lo por completo:

```razor
@* .NET 11 *@
@using static Microsoft.AspNetCore.Components.Web.RenderMode
```

Verifique: `@rendermode InteractiveServer` em um componente é resolvido sem um erro de using.

### 5. Reescreva o `Program.cs`

Troque o registro do Blazor Server e os endpoints pelos equivalentes do Razor Components.

```csharp
// .NET 11, C# 14 - Blazor Web App startup
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// keep your existing app services here (DbContext, HttpClient, etc.)

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Delete `AddServerSideBlazor()`, `app.MapBlazorHub()` e `app.MapFallbackToPage("/_Host")`. A chamada `app.UseAntiforgery()` é nova e obrigatória; o template Web App habilita o middleware de antiforgery por padrão e os envios de formulário falham sem ela.

Verifique: `dotnet build` é concluído com zero erros.

### 6. Torne o app interativo (render mode global)

A migração de menor risco torna o app inteiro `InteractiveServer`, reproduzindo o antigo comportamento exatamente. Defina o render mode em `<Routes />` e `<HeadOutlet />` dentro do `App.razor`:

```razor
@* .NET 11 - global InteractiveServer, matches standalone Blazor Server behaviour *@
<HeadOutlet @rendermode="InteractiveServer" />
...
<Routes @rendermode="InteractiveServer" />
```

Verifique: rode `dotnet run`, abra o app, e confirme que os componentes interativos (botões, `@onclick`, envios de `EditForm`) funcionam e que o navegador mantém um WebSocket aberto para `/_blazor`. Uma vez que isso funcione, mais tarde você pode rebaixar páginas individuais para `@rendermode StaticServer` ou escalar ilhas para WebAssembly, mas isso é trabalho pós-migração.

### 7. Lide com a dupla execução do prerendering

Esta é a única mudança de comportamento que surpreende as pessoas. Com um render mode interativo, o Blazor prerenderiza primeiro o HTML estático, depois renderiza de novo sobre o circuito ativo, então `OnInitialized` e `OnInitializedAsync` executam duas vezes. O antigo padrão do Server independente (`render-mode="ServerPrerendered"`) tinha a mesma propriedade, mas muitos apps usavam `render-mode="Server"` e nunca a viam.

Você tem três opções. A mais limpa no .NET 11 é o atributo declarativo `[PersistentState]` (adicionado no .NET 10): faz o fetch uma vez durante o prerender, serializa no HTML, restaura na passada interativa.

```csharp
// .NET 11 - fetch once, survive the prerender-to-interactive handoff
public partial class Dashboard : ComponentBase
{
    [PersistentState]
    public List<Order>? Orders { get; set; }

    [Inject] public required IOrderService OrderService { get; init; }

    protected override async Task OnInitializedAsync()
    {
        // Orders is non-null on the interactive pass: state was restored,
        // so the service is not hit a second time.
        Orders ??= await OrderService.GetRecentAsync();
    }
}
```

Se você não quiser fazer o fetch durante o prerender de jeito nenhum, desabilite o prerendering para aquele limite:

```razor
@* .NET 11 - skip the prerender pass entirely for this component tree *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Verifique: coloque um breakpoint ou uma linha de log em cada `OnInitializedAsync` com efeitos colaterais e confirme que ele executa uma vez por navegação real, não duas.

### 8. Refaça o cabeamento da autenticação e da autorização

Se o seu app usava `<CascadingAuthenticationState>` envolvendo o roteador, remova esse componente e registre-o na DI no lugar, depois troque `RouteView` por `AuthorizeRouteView` no `Routes.razor`.

```csharp
// .NET 11 - Program.cs
builder.Services.AddCascadingAuthenticationState();
```

```razor
@* .NET 11 - Routes.razor, authorized routing *@
<AuthorizeRouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
```

Verifique: acesse uma página `[Authorize]` deslogado e confirme que você é redirecionado, depois faça login e confirme o acesso.

### 9. Delete os arquivos host mortos

Remova `Pages/_Host.cshtml`, `Pages/_Layout.cshtml` e qualquer chamada `app.MapRazorPages()` que existia apenas para servir o `_Host`. Remova `AddRazorPages()` do `Program.cs` se nada mais usa Razor Pages.

Verifique: `dotnet build` está limpo e o app ainda serve cada rota.

## Verificação: o smoke test pós-migração

Rode todos estes antes de fazer merge:

- `dotnet build -c Release` reporta zero avisos relacionados a render modes.
- `dotnet test` passa com a mesma contagem da sua referência pré-migração.
- O app inicia com `dotnet run` e a página inicial é renderizada.
- Um controle interativo (`@onclick`, `EditForm`) funciona e o navegador mantém um WebSocket `/_blazor` aberto.
- Uma navegação de página não dispara duas vezes um efeito colateral (a verificação do passo 7, repetida de ponta a ponta).
- Uma rota protegida com `[Authorize]` redireciona quando deslogado.
- Um POST de formulário tem sucesso (esta é a verificação do middleware de antiforgery do passo 5).
- Veja o código-fonte de uma página: a marcação é HTML prerenderizado, não um `<div id="app">` vazio.

## Plano de rollback

Esta migração é reversível apenas se você manteve o branch do passo pré-decolagem. Uma vez que você deleta o `_Host.cshtml` e reescreve o `Program.cs`, não há um botão in loco para voltar ao modelo Server independente. Faça o rollback com checkout do commit pré-migração, não editando para frente. Como a mudança é estrutural e não uma migração de dados, não há nada a desfazer no seu banco de dados ou armazenamento. Crie um branch, faça o trabalho, verifique contra o smoke test, e faça merge apenas quando estiver no verde.

## Tropeços que tivemos

- **Esquecer o `app.UseAntiforgery()`.** O template Web App requer o middleware de antiforgery. Sem a chamada, cada POST de `EditForm` retorna um 400 com `Antiforgery token validation failed`. O template Server independente não precisava disso porque o tratamento de formulários ia sobre o circuito SignalR, não sobre POST HTTP.
- **`HttpContext` é null dentro de componentes interativos.** No Server independente você às vezes conseguia alcançar `IHttpContextAccessor` a partir de um componente. Sob o template Web App, `HttpContext` existe apenas durante a passada de SSR estático. Leia o que você precisa (cabeçalhos, cookies, o usuário autenticado) durante o prerender e passe para baixo, ou use o `AuthenticationState` em cascata.
- **`blazor.server.js` deixado na marcação.** Se você copiar o antigo tag de script do `_Host.cshtml` literalmente, a página carrega mas nenhum circuito abre e nada é interativo. Deve ser `_framework/blazor.web.js`.
- **Serviços scoped se comportando de forma diferente através do limite do prerender.** Um serviço resolvido durante o prerender e de novo durante a passada interativa são dois scopes diferentes. Se você cacheava estado por requisição em um serviço scoped esperando que ele sobrevivesse, ele não sobreviverá. Esta é a mesma classe de problema coberta em [Não é possível consumir um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Ativos estáticos com 404 após o movimento.** O template Web App serve o CSS com escopo de componente como `YourApp.styles.css`. Se o seu antigo `_Layout.cshtml` referenciava um bundle com nome diferente, o link quebra silenciosamente. Verifique os hrefs `<link>` no novo `App.razor`.

O destino aqui é quase sempre "cada página em `InteractiveServer`, prerendering tratado". Essa é a migração que não muda nada que o usuário possa ver. Adicionar páginas Static Server, ilhas WebAssembly e componentes Auto é a recompensa que você coleta depois, um componente de cada vez, sem mais agitação estrutural.

## Relacionado

- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11: qual você deve escolher](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) para a decisão por trás do template de destino.
- [Como compartilhar a lógica de validação entre o servidor e o Blazor WebAssembly](/pt-br/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) para o padrão de projeto compartilhado que você vai querer assim que adicionar componentes WASM.
- [Blazor SSR finalmente tem TempData no .NET 11](/pt-br/2026/04/blazor-ssr-tempdata-dotnet-11/) para os fluxos Post-Redirect-Get nas páginas de SSR estático que você agora pode adicionar.
- [Solução: Não é possível consumir um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) para os problemas de tempo de vida de scope que o limite do prerender expõe.
- [Migrar do .NET Framework 4.8 para o .NET 11 em 2026](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) se este movimento de Blazor for parte de um salto de framework maior.

## Fontes

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, acessado em 2026-06-05.
- [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/aspnet/core/blazor/state-management/prerendered-state-persistence), Microsoft Learn, para o atributo `[PersistentState]` adicionado no .NET 10.
- [Migrate from ASP.NET Core in .NET 7 to .NET 8](https://learn.microsoft.com/aspnet/core/migration/70-to-80), Microsoft Learn, para os passos originais de reestruturação do host de Blazor Server para Web App.
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/aspnet/core/blazor/components/lifecycle), Microsoft Learn, para o comportamento de dupla execução do prerender.
</content>
