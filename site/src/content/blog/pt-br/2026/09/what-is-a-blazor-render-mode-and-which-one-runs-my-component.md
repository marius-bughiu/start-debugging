---
title: "O que é um modo de renderização no Blazor e qual deles executa meu componente?"
description: "Um modo de renderização decide onde um componente Razor executa e se ele é interativo. Estes são os quatro modos do .NET 11, as regras de propagação que decidem o que seu componente herda, e as propriedades RendererInfo e AssignedRenderMode que dizem em tempo de execução qual delas venceu."
pubDate: 2026-09-05
tags:
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component"
translatedBy: "claude"
translationDate: 2026-09-05
---

Um modo de renderização é a configuração por componente de uma Blazor Web App que decide duas coisas: onde o componente executa (servidor ou navegador) e se ele consegue responder a eventos da interface. São quatro: Static Server, Interactive Server, Interactive WebAssembly e Interactive Auto. Você atribui um deles com a diretiva ou o atributo de diretiva `@rendermode`, o padrão é Static Server, e os modos se propagam para baixo na árvore de componentes, então a maioria dos componentes nunca declara nenhum. Para descobrir qual modo realmente executa um determinado componente, leia `ComponentBase.AssignedRenderMode` e `ComponentBase.RendererInfo` de dentro do componente: `AssignedRenderMode` é `null` no SSR estático, e `RendererInfo.IsInteractive` é `false` durante a pré-renderização mesmo em um componente cujo modo atribuído é interativo.

Tudo aqui tem como alvo o .NET 11 e o ASP.NET Core 11, com C# 14. Modos de renderização existem apenas em uma Blazor Web App (o template unificado introduzido no .NET 8). Uma app Blazor WebAssembly standalone ou uma app Blazor Server legada tem um único modelo de hospedagem para a app inteira e nenhuma diretiva `@rendermode`. Onde o comportamento mudou no .NET 10 ou no .NET 11, eu aviso.

## Os quatro modos e os dois eixos em que eles variam

| Modo | Executa em | Interativo | Exige um projeto `.Client` |
| --- | --- | --- | --- |
| Static Server | Servidor | Não | Não |
| Interactive Server | Servidor, sobre um circuito SignalR | Sim | Não |
| Interactive WebAssembly | Navegador | Sim | Sim |
| Interactive Auto | Servidor primeiro, navegador nas visitas seguintes | Sim | Sim |

Static Server, normalmente escrito SSR estático, renderiza o componente no fluxo de resposta HTTP e para. Não há circuito, não há runtime do .NET no navegador e não há tratamento de eventos. Um `@onclick` em um botão renderizado estaticamente compila normalmente e não faz nada em tempo de execução. Esse é o padrão, e para páginas de conteúdo é o padrão certo: nenhuma conexão para manter aberta, nenhum payload de WebAssembly para baixar.

Interactive Server mantém o componente vivo no servidor e canaliza eventos do DOM e diffs sobre uma conexão SignalR. Interactive WebAssembly baixa o runtime do .NET e o bundle da sua app e executa o componente no navegador. Interactive Auto não é um terceiro runtime: ele renderiza com Interactive Server na primeira visita enquanto o bundle do WebAssembly é baixado em segundo plano, e depois usa WebAssembly nas visitas seguintes, quando o bundle já está em cache.

Uma característica do Auto surpreende as pessoas. Conforme a [documentação de modos de renderização](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), o Auto nunca troca o modo de renderização de um componente que já está na página. Ele toma uma decisão quando o componente renderiza pela primeira vez e mantém aquele modo enquanto o componente existir. Ele também prefere combinar com o modo dos componentes interativos que já estão na página, para não introduzir no meio da página um segundo runtime do .NET que não compartilha estado com o primeiro. Se você ainda está escolhendo entre modelos de hospedagem em vez de depurar um, o tratamento mais longo está em [Blazor Server vs WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

Modos interativos precisam dos serviços e endpoints correspondentes registrados em `Program.cs`, senão o `@rendermode` não significa nada:

```csharp
// .NET 11, C# 14 -- Program.cs of a Blazor Web App
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

// ...

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode();
```

## Três lugares onde um modo de renderização pode ser definido

O modo que chega a um componente pode vir de três posições sintáticas diferentes, e elas não são intercambiáveis.

**Em uma instância de componente**, como atributo de diretiva, onde o componente é usado:

```razor
@* .NET 11 -- any render mode instance is allowed here *@
<Dialog @rendermode="InteractiveServer" />
```

**Na definição de um componente**, como diretiva no topo do arquivo `.razor`. É isso que você usa para uma página roteável, porque nada instancia uma página manualmente:

```razor
@* .NET 11 -- Pages/Counter.razor *@
@page "/counter"
@rendermode InteractiveServer
```

`@rendermode` é ao mesmo tempo uma diretiva Razor e um atributo de diretiva Razor, e a diferença importa exatamente uma vez: a forma de diretiva exige uma instância estática de modo de renderização, enquanto a forma de atributo de diretiva aceita qualquer instância, inclusive uma que você construa com opções.

**Para a app inteira**, colocando o modo no componente `Routes` dentro de `App.razor`. O router propaga seu modo para cada página que ele roteia:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="InteractiveServer" />
<HeadOutlet @rendermode="InteractiveServer" />
```

Definir um modo no próprio componente raiz `App` não tem suporte. É por isso que a interatividade global é expressa em `Routes` e `HeadOutlet` em vez de uma única diretiva no topo. Se você está movendo uma app legada para esse modelo, a mecânica está em [migrar uma app Blazor Server para Blazor Web App no .NET 11](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/).

Você também pode calcular o modo, que é como se recorta páginas com SSR estático dentro de uma app que no resto é interativa:

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="PageRenderMode" />

@code {
    private IComponentRenderMode? PageRenderMode => InteractiveServer;
}
```

## As regras de propagação que decidem o que seu componente recebe

A maioria dos componentes de uma app real não tem `@rendermode` nenhum. Eles herdam, e as quatro regras são curtas:

1. O modo de renderização padrão é Static.
2. Um componente sem `@rendermode` assume o modo do pai.
3. Você não pode trocar para um modo interativo diferente em um filho. Um componente Interactive Server não pode hospedar um filho Interactive WebAssembly.
4. Parâmetros passados de um pai estático para um filho interativo precisam ser serializáveis em JSON.

A regra 2 é o motivo de um componente compartilhado que funciona em uma página e fica inerte em outra quase nunca ser culpa do componente. Coloque isto em uma página sem modo e o botão não faz nada:

```razor
@* .NET 11 -- Components/SharedMessage.razor, render-mode agnostic *@
<button @onclick="UpdateMessage">Click me</button> @message

@code {
    private string message = "Not updated yet.";

    private void UpdateMessage() => message = "Somebody updated me!";
}
```

Coloque o mesmo componente sob `@rendermode InteractiveServer` e ele funciona. Nada no componente mudou. O instinto correto diante de "meu botão não faz nada" é olhar para cima na árvore, não para o handler.

A regra 3 produz um erro em tempo de execução em vez de silêncio. Uma página fixada em Interactive Server com um filho WebAssembly falha com `Cannot create a component of type '...' because its render mode 'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.` Componentes irmãos com modos interativos diferentes em uma página estática funcionam; aninhar um dentro do outro não.

A regra 4 é a que produz a mensagem mais confusa. Passar conteúdo filho através de uma fronteira estático-para-interativo lança:

> System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is because the parameter is of the delegate type 'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and cannot be serialized.

Um filho interativo de um pai estático é um componente raiz para o próprio renderizador dele, e seus parâmetros precisam atravessar uma fronteira de processo (ou de rede) como JSON. Um `RenderFragment` é um delegate, e delegate não serializa. A correção histórica é mover a fronteira para cima: envolva o filho em um componente que não receba nenhum render fragment e coloque `@rendermode` no wrapper.

```razor
@* .NET 11 -- Components/WrapperComponent.razor *@
<SharedMessage>
    Child content
</SharedMessage>
```

```razor
@* .NET 11 -- the page *@
@page "/render-mode-10"

<WrapperComponent @rendermode="InteractiveServer" />
```

É exatamente por isso que o template traz um `Routes.razor` envolvendo o `Router` em vez de colocar `@rendermode` diretamente no `Router`.

## A mudança do .NET 11: layouts interativos finalmente funcionam

A regra 4 tinha uma vítima bem conhecida. `LayoutComponentBase` expõe `@Body` como um `RenderFragment`, então colocar `@rendermode InteractiveServer` no `MainLayout` em uma app com interatividade por página lançava o mesmo erro de serialização, com `'Body'` como nome do parâmetro. Todo contorno das últimas três versões maiores foi alguma variação de "coloque a interatividade em um wrapper ou em uma seção do Blazor".

Essa restrição acabou no .NET 11. A documentação da Microsoft agora limita toda a limitação "Statically-rendered layout components" às versões `>= 8.0 < 11.0` e afirma que ela vale "prior to the release of .NET 11". O trabalho por trás disso é [dotnet/aspnetcore#52768](https://github.com/dotnet/aspnetcore/issues/52768), entregue no .NET 11 Preview 5: quando um componente com modo de renderização recebe um parâmetro `RenderFragment`, o framework agora invoca o fragmento no lado estático, serializa a árvore de renderização resultante como JSON e a reidrata em um delegate `RenderFragment` no lado interativo. Para manter isso honesto, o compilador exige que essas funções empacotadas sejam funções locais estáticas, de modo que não possam capturar estado do servidor que não sobreviveria à viagem.

O efeito prático: no .NET 11 você pode escrever

```razor
@* .NET 11 only -- Components/Layout/MainLayout.razor *@
@inherits LayoutComponentBase
@rendermode InteractiveServer

<div class="page">
    <NavMenu />
    <main>@Body</main>
</div>
```

e ter uma barra de navegação interativa sem a dança do wrapper baseado em seções. No .NET 10 e anteriores o mesmo arquivo lança em tempo de execução. Declare o framework alvo antes de copiar um trecho de layout da internet, porque este virou.

## Qual modo está executando meu componente agora?

`ComponentBase` expõe duas propriedades para isso, ambas disponíveis desde o .NET 9. Nenhuma exige injeção.

`AssignedRenderMode` retorna o modo atribuído ao componente: uma instância de `InteractiveServerRenderMode`, `InteractiveWebAssemblyRenderMode` ou `InteractiveAutoRenderMode`, ou `null` quando o componente está rodando sob SSR estático.

`RendererInfo` descreve o renderizador que de fato executa o componente. `RendererInfo.Name` é um entre `Static`, `Server`, `WebAssembly` ou `WebView`. `RendererInfo.IsInteractive` é `true` só quando o componente é genuinamente interativo, e `false` tanto no SSR estático quanto durante a passada de pré-renderização de um componente interativo.

Essa última distinção é a útil. Um componente com `@rendermode InteractiveServer` renderiza duas vezes: uma durante a pré-renderização, onde `AssignedRenderMode` é uma instância de `InteractiveServerRenderMode` mas `RendererInfo.IsInteractive` é `false`, e outra sobre o circuito, onde as duas concordam. Então:

- Use `AssignedRenderMode is null` para perguntar "este componente vai ser interativo em algum momento?" Essa é uma decisão sobre o formato do markup.
- Use `RendererInfo.IsInteractive` para perguntar "posso tratar eventos agora?" Essa é uma decisão sobre a passada atual.

Um componente de diagnóstico que você pode largar em qualquer ponto da árvore para ver o que uma subárvore herdou:

```razor
@* .NET 11 -- Components/RenderModeProbe.razor *@
<dl>
    <dt>AssignedRenderMode</dt>
    <dd>@(AssignedRenderMode?.GetType().Name ?? "null (static SSR)")</dd>
    <dt>RendererInfo.Name</dt>
    <dd>@RendererInfo.Name</dd>
    <dt>RendererInfo.IsInteractive</dt>
    <dd>@RendererInfo.IsInteractive</dd>
</dl>
```

Como a sonda não declara modo próprio, ela herda, e reporta exatamente o que a página hospedeira passou para baixo. Essa é uma resposta mais rápida do que ler diretivas `@rendermode` subindo a árvore, principalmente em uma app que atribui modos programaticamente.

O uso documentado de `AssignedRenderMode` é degradar com elegância: renderizar um `form` HTML de verdade quando o componente é estático, e inputs com binding e um handler de evento quando não é.

```razor
@* .NET 11 *@
@if (AssignedRenderMode is null)
{
    <form action="/movies">
        <input type="text" name="titleFilter" />
        <input type="submit" value="Search" />
    </form>
}
else
{
    <input @bind="titleFilter" />
    <button @onclick="FilterMovies">Search</button>
}
```

E o uso documentado de `IsInteractive` é suprimir controles que silenciosamente não fariam nada durante a passada de pré-renderização:

```razor
@* .NET 11 *@
<button @onclick="Send" disabled="@(!RendererInfo.IsInteractive)">
    Send
</button>
```

## Pré-renderização, e por que seu inicializador roda duas vezes

A pré-renderização vem ligada por padrão nos três modos interativos. O servidor renderiza o componente estaticamente dentro da resposta HTML inicial, e então o renderizador interativo assume e renderiza de novo. Por isso `OnInitializedAsync` roda duas vezes, uma por renderizador, que é a causa real das reclamações de "minha API é chamada duas vezes" e "a interface pisca de volta para o estado de carregamento".

`OnAfterRender` e `OnAfterRenderAsync` são a exceção: eles não são chamados durante a pré-renderização. É também por isso que interop com JS a partir de `OnInitializedAsync` lança, já que ainda não existe navegador para chamar, detalhado em [JavaScript interop calls cannot be issued at this time](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).

Você tem duas respostas. Desligar a pré-renderização para o componente:

```razor
@* .NET 11 -- component definition form *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

```razor
@* .NET 11 -- component instance form *@
<Dialog @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Ou, melhor para qualquer coisa visível ao usuário, manter a pré-renderização e levar o estado através da fronteira com o atributo `[PersistentState]` (`[SupplyParameterFromPersistentComponentState]` sob o nome antigo; `PersistentStateAttribute` é a API do .NET 10 em diante):

```csharp
// .NET 11, C# 14
[PersistentState]
public int? CurrentCount { get; set; }
```

O tratamento completo, incluindo `RestoreBehavior` e `AllowUpdates`, está em [como persistir estado através da fronteira de renderização estática-para-interativa do Blazor no .NET 11](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

Uma armadilha no caminho de desligar: `prerender: false` só tem efeito em um modo de renderização de nível superior. Se um componente pai já declarou um modo, a configuração de pré-renderização dos filhos dele é ignorada por completo. Definir isso em um componente aninhado e ver a pré-renderização continuar não é um bug.

## O SSR estático perde mais do que interatividade

Sob SSR estático a requisição é tratada pelo pipeline de middleware do ASP.NET Core, e componentes Razor não são renderizados durante esse processamento. Então os próprios recursos de router do Blazor não participam. No .NET 10 e no .NET 11, o conteúdo `<NotAuthorized>` de `AuthorizeRouteView` não é exibido em páginas renderizadas estaticamente; requisições não autorizadas são tratadas pelo middleware de autorização, normalmente através de um `IAuthorizationMiddlewareResultHandler` personalizado. Antes do .NET 10, o conteúdo `<NotFound>` tinha o mesmo problema. Uma app com interatividade em nível de raiz não esbarra nisso, porque depois da primeira renderização estática o pipeline de middleware não está mais envolvido.

O .NET 11 também adiciona uma ferramenta adjacente aos modos de renderização que vale conhecer: o componente `CacheView` guarda em cache a saída renderizada de uma subárvore de componentes durante o SSR estático e reproduz o markup em um acerto, sem instanciar os componentes filhos nem executar seus métodos de ciclo de vida.

```razor
@* .NET 11 *@
<CacheView VaryByQuery="category" ExpiresAfter="TimeSpan.FromMinutes(5)">
    <ProductList Category="@Category" />
</CacheView>
```

Ele só se aplica ao SSR estático, o que é mais um motivo para deixar páginas de conteúdo no modo padrão em vez de tornar a app inteira interativa por hábito.

## A versão curta

Um modo de renderização é onde o componente roda e se ele consegue tratar eventos. Atribua em uma instância, em uma definição, ou em `Routes` para a app inteira; tudo sem diretiva herda do pai, e o padrão é estático. Um botão morto significa olhar para cima na árvore. Uma exceção de serialização significa que um `RenderFragment` cruzou uma fronteira estático-para-interativo, o que no .NET 10 e anteriores inclui qualquer layout interativo e no .NET 11 não inclui mais. Uma chamada de API duplicada significa pré-renderização, e a correção é `[PersistentState]` bem mais vezes do que `prerender: false`. Quando você precisar do fato em vez de um palpite, leia `AssignedRenderMode` para a atribuição e `RendererInfo.IsInteractive` para a passada atual, e lembre que elas discordam de propósito durante a pré-renderização.

## Relacionados

- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Migrar uma app Blazor Server para Blazor United (Blazor Web App) no .NET 11](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)
- [Como persistir estado através da fronteira de renderização estática-para-interativa do Blazor no .NET 11](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time (pré-renderização do Blazor)](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Fix: Attempting to reconnect to the server quando um circuito do Blazor Server cai](/pt-br/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## Fontes

- [ASP.NET Core Blazor render modes -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)
- [Prerender ASP.NET Core Razor components -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender?view=aspnetcore-11.0)
- [ASP.NET Core Blazor layouts -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/layouts?view=aspnetcore-11.0)
- [Persist state across prerendering -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)
- [What's new in ASP.NET Core in .NET 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)
- [Support serializing RenderFragment parameters -- dotnet/aspnetcore #52768](https://github.com/dotnet/aspnetcore/issues/52768)
- [ComponentBase.AssignedRenderMode Property -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.componentbase.assignedrendermode)
- [RendererInfo Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendererinfo)
