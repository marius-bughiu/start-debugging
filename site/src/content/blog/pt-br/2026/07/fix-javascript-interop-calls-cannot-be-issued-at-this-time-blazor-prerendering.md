---
title: "Correção: JavaScript interop calls cannot be issued at this time (prerender do Blazor)"
description: "O prerender executa seu componente no servidor sem navegador, então IJSRuntime lança exceção. Mova a chamada para OnAfterRenderAsync, condicione com RendererInfo.IsInteractive ou desative o prerender."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering"
translatedBy: "claude"
translationDate: 2026-07-30
---

A correção: você chamou `IJSRuntime` a partir de `OnInitialized`, `OnInitializedAsync`, `OnParametersSet{Async}` ou do construtor de um componente, e esse código rodou durante o prerender, quando não existe navegador conectado para executar JavaScript. Mova a chamada para `OnAfterRenderAsync(bool firstRender)` protegida por `if (firstRender)`, que nunca roda durante o prerender. Se você precisa ramificar antes da primeira renderização interativa, verifique `RendererInfo.IsInteractive` (.NET 9 e posteriores). Se o componente realmente não funciona sem JavaScript, desative o prerender para ele com `@rendermode @(new InteractiveServerRenderMode(prerender: false))`.

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued at this time.
This is because the component is being statically rendered. When prerendering is enabled,
JavaScript interop calls can only be performed during the OnAfterRenderAsync lifecycle method.
   at Microsoft.AspNetCore.Components.Server.Circuits.RemoteJSRuntime.BeginInvokeJS(...)
   at Microsoft.JSInterop.JSRuntime.InvokeAsync[TValue](String identifier, Object[] args)
   at BlazorSample.Components.Pages.Theme.OnInitializedAsync()
```

Este artigo tem como alvo o .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.x), mas o comportamento não mudou desde que o prerender foi lançado e as orientações valem também para .NET 8, 9 e 10. A única exceção é `RendererInfo`, que chegou no .NET 9.

## Duas mensagens de erro, dois renderizadores

O tráfego de busca para esse problema cai em duas mensagens diferentes, e saber qual delas você recebeu indica qual modelo de hospedagem a lançou.

A mensagem citada acima vem do `RemoteJSRuntime`, na pilha do circuito do Blazor Server. Ela é lançada quando o proxy de cliente do runtime é null, ou seja, o componente está executando fora de um circuito SignalR ativo. Em um app clássico de Blazor Server com `render-mode="ServerPrerendered"`, essa é a mensagem que você vê.

A segunda mensagem vem de um tipo completamente diferente:

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued during
server-side static rendering, because the page has not yet loaded in the browser.
Statically-rendered components must wrap any JavaScript interop calls in conditional
logic to ensure those interop calls are not attempted during static rendering.
   at Microsoft.AspNetCore.Components.Endpoints.UnsupportedJavaScriptRuntime.Microsoft.JSInterop.IJSRuntime.InvokeAsync[TValue](...)
```

`UnsupportedJavaScriptRuntime` é um `IJSRuntime` interno e sealed que o renderizador de endpoints registra para renderização estática no servidor. Todos os métodos dele lançam exceção. Em um Blazor Web App (o template do .NET 8 e posteriores), tanto o prerender quanto o SSR estático passam pelo renderizador de endpoints, então essa é a mensagem que você recebe para uma página sem nenhum render mode, e para a passagem de prerender de um componente `InteractiveWebAssembly` ou `InteractiveAuto`.

Ambas são `InvalidOperationException`, ambas têm a mesma causa raiz e ambas têm o mesmo conjunto de correções. Se você vir `UnsupportedJavaScriptRuntime` no stack trace, repare na formulação: "must wrap any JavaScript interop calls in conditional logic". Essa frase importa, e é a armadilha coberta mais adiante neste artigo.

## Por que o prerender não tem navegador para chamar

Prerender é o processo de renderizar o conteúdo da página estaticamente no servidor para que o HTML chegue ao navegador o mais rápido possível. A árvore de componentes roda até o fim, produz markup, é escrita na resposta HTTP e é descartada. Só depois disso o script do Blazor inicia no navegador, abre um circuito (para `InteractiveServer`) ou baixa o runtime (para `InteractiveWebAssembly`), e reinstancia o componente de forma interativa.

Durante essa primeira passagem não existe DOM, nem `window`, nem transporte para enviar uma mensagem de JS interop. `IJSRuntime` continua injetável, porque o serviço está registrado e o componente compila normalmente, mas a implementação por trás dele ou não tem proxy de cliente ou é um substituto cujo único trabalho é lançar uma mensagem útil. É por isso que esse é um erro de runtime e nunca de compilação.

A documentação do ciclo de vida é explícita sobre a consequência: `OnAfterRender` e `OnAfterRenderAsync` "aren't invoked during prerendering or static server-side rendering (static SSR) on the server because those processes aren't attached to a live browser DOM and are already complete before the DOM is updated". Exatamente essa propriedade é o que torna `OnAfterRenderAsync` o lugar seguro para o interop.

Note também que `OnInitializedAsync` roda duas vezes em um componente prerenderizado: uma vez na passagem estática e outra quando o componente se torna interativo. Tudo o que você busca ali é calculado duas vezes. Esse é um problema separado com uma solução separada, coberto em [como persistir o estado através do limite de renderização estático-para-interativo do Blazor](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

## Reprodução mínima

Coloque isto em um Blazor Web App criado a partir do template do .NET 11 com um render mode interativo global ou por página. Falha na primeira requisição, sempre.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0, Blazor Web App *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @theme</p>

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        // Throws during the prerender pass: no browser, no localStorage.
        theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
    }
}
```

O mesmo código com `@rendermode InteractiveWebAssembly` lança a variante do `UnsupportedJavaScriptRuntime`, porque a passagem de prerender acontece no renderizador de endpoints no servidor e não em um circuito. Remova a linha `@rendermode` por completo e você também recebe a variante do `UnsupportedJavaScriptRuntime`, permanentemente, porque agora a página é SSR estático e nunca se torna interativa.

## Correção 1: mova a chamada para `OnAfterRenderAsync`

Essa é a correção recomendada e para a qual a própria mensagem de erro do framework aponta. `OnAfterRenderAsync` só é chamado depois que o componente foi renderizado de forma interativa com um DOM ativo, então o interop é sempre válido ali.

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0 *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @(theme ?? "loading...")</p>

@code {
    private string? theme;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
            StateHasChanged();
        }
    }
}
```

Dois detalhes em que as pessoas tropeçam:

A proteção `if (firstRender)` não é higiene opcional. Sem ela você reexecuta o interop a cada renderização e, como `StateHasChanged` dispara uma renderização, você obtém um loop infinito.

O `StateHasChanged()` explícito é obrigatório. Diferente dos outros métodos do ciclo de vida, o framework deliberadamente não agenda uma nova renderização quando a `Task` retornada por `OnAfterRenderAsync` completa, justamente para evitar esse loop infinito. Se você atribuir um campo e não chamar `StateHasChanged`, a interface nunca atualiza e o bug parece "meu interop retorna null".

Projete o markup de modo que a saída prerenderizada faça sentido sem o resultado do JavaScript. O usuário vê essa primeira passagem. Um placeholder, um esqueleto ou um valor padrão sensato é melhor que um elemento vazio que aparece do nada um instante depois.

## Correção 2: condicione com `RendererInfo.IsInteractive`

Às vezes você precisa ramificar antes da primeira renderização interativa, por exemplo para decidir o que renderizar em vez do que buscar. `ComponentBase.RendererInfo` (.NET 9 e posteriores) expõe exatamente isso:

- `RendererInfo.Name` retorna `Static`, `Server`, `WebAssembly` ou `WebView`.
- `RendererInfo.IsInteractive` é `true` quando a renderização é interativa e `false` durante o prerender ou o SSR estático.
- `ComponentBase.AssignedRenderMode` retorna o render mode atribuído ao componente, ou `null` quando não há nenhum.

```razor
@* ThemeAware.razor *@
@* .NET 11 / .NET 10 / .NET 9. RendererInfo requires aspnetcore 9.0+ *@
@page "/theme-aware"
@rendermode InteractiveServer
@inject IJSRuntime JS

@if (!RendererInfo.IsInteractive)
{
    <p>Loading preferences...</p>
}
else
{
    <p>Stored theme: @theme</p>
}

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        if (RendererInfo.IsInteractive)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
        }
    }
}
```

Essa é a "conditional logic" que a mensagem do `UnsupportedJavaScriptRuntime` pede. É também a ferramenta certa para um componente que precisa renderizar markup estático utilizável, por exemplo um formulário que faz post normalmente quando `AssignedRenderMode is null` e usa um manipulador de eventos quando não é o caso.

No .NET 8, onde `RendererInfo` não existe, o equivalente mais próximo para detectar a passagem de prerender é um `[CascadingParameter] public HttpContext? HttpContext { get; set; }` no componente: ele só é diferente de null durante a renderização no servidor. Funciona, mas acopla o componente a tipos de hospedagem do ASP.NET Core, então prefira `RendererInfo` se puder ter como alvo o .NET 9 ou posterior.

## Correção 3: desative o prerender para o componente

Se um componente não faz sentido sem JavaScript (um wrapper de gráfico, um mapa, um editor de texto rico), o prerender só compra um lampejo de markup quebrado. Desative na definição do componente:

```razor
@* MapView.razor *@
@* .NET 11. prerender: false is valid on all three interactive render modes *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

Ou no ponto de uso:

```razor
@* .NET 11 *@
<MapView @rendermode="new InteractiveWebAssemblyRenderMode(prerender: false)" />
```

Para desativar em todo o app, defina o modo no componente `Routes` em `App.razor`, e lembre de fazer o mesmo para `HeadOutlet`:

```razor
@* App.razor, .NET 11 Blazor Web App template *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
<HeadOutlet @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Uma regra que pega muita gente: desativar o prerender só tem efeito para render modes de nível superior. Se um componente pai já especifica um render mode, as configurações de prerender dos filhos são ignoradas. Essa é a mesma restrição de "uma subárvore, um render mode" por trás [do erro o render mode não é compatível com o render mode do componente pai](/pt-br/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/). Recorra a `prerender: false` apenas quando você for dono do limite, e trate como último recurso: você está abrindo mão da primeira pintura rápida e do benefício de SEO pelo qual o prerender existe.

## A armadilha: `OnAfterRenderAsync` nunca roda em uma página com SSR estático

Essa é a razão mais comum de "movi para `OnAfterRenderAsync` e ainda não funciona".

`OnAfterRender{Async}` não é chamado durante o prerender *nem* durante o SSR estático. Em um componente interativo prerenderizado isso não é problema, porque o componente é recriado de forma interativa um instante depois e o método dispara nesse momento. Mas em uma página **sem** render mode, o componente é renderizado apenas estaticamente. Não há segunda passagem. `OnAfterRenderAsync` nunca é invocado, seu interop simplesmente nunca acontece, e o sintoma passa de uma exceção barulhenta para um recurso morto.

Se o interop parou de lançar exceção mas também parou de rodar, verifique se o componente realmente tem um render mode interativo, seja diretamente, herdado de um pai ou aplicado globalmente em `Routes`. `AssignedRenderMode is null` dentro do componente é uma confirmação de uma linha de que você está em SSR estático. Qual modelo de hospedagem você deveria atribuir é uma decisão à parte, detalhada em [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## A terceira variante: "the circuit has disconnected and is being disposed"

Existe uma terceira mensagem com as mesmas palavras iniciais, e é um bug diferente com uma correção diferente:

```text
Microsoft.JSInterop.JSDisconnectedException: JavaScript interop calls cannot be issued
at this time. This is because the circuit has disconnected and is being disposed.
```

Repare no tipo da exceção: `JSDisconnectedException`, não `InvalidOperationException`. Isso não tem nada a ver com prerender. Acontece na outra ponta da vida do componente, em apps do lado servidor, quando você chama JS (ou descarta um `IJSObjectReference`) depois que o circuito SignalR já se foi, tipicamente a partir de `DisposeAsync` enquanto o usuário navega para fora ou recarrega. A correção é capturá-la:

```csharp
// .NET 11, server-side Blazor. Disposing a JS module after the circuit is gone.
async ValueTask IAsyncDisposable.DisposeAsync()
{
    try
    {
        if (module is not null)
        {
            await module.DisposeAsync();
        }
    }
    catch (JSDisconnectedException)
    {
    }
}
```

Em um componente WebAssembly não há circuito a perder, então remova o `try`/`catch` e apenas descarte o módulo. E se você precisa executar limpeza de verdade no navegador depois que a conexão cai, JS interop é a ferramenta errada: use o padrão `MutationObserver` ou o `disconnectedCallback` de um custom element no cliente.

## Armadilhas que produzem a mesma exceção

**Bibliotecas de componentes de terceiros.** MudBlazor, Radzen e bibliotecas parecidas chamam interop internamente para medir viewports, posicionar popovers ou ler capacidades do navegador. Se o stack trace da exceção termina em um tipo da biblioteca e não no seu código, a correção normalmente é uma chave no nível da biblioteca ou desativar o prerender para a página que hospeda o componente. Confira primeiro as notas de versão da biblioteca: a maioria adicionou proteções de prerender desde o .NET 8.

**Serviços injetados que chamam JS.** Um serviço com escopo que encapsula `localStorage` vai lançar exceção de onde quer que você o chame pela primeira vez, o que muitas vezes é `OnInitializedAsync`. O serviço não consegue corrigir isso por você; o ponto de chamada é que precisa ser movido ou condicionado. Algumas bibliotecas (Blazored.LocalStorage entre elas) documentam isso como a orientação de só tocar no armazenamento depois da primeira renderização, exatamente por esse motivo.

**`IJSInProcessRuntime` no WebAssembly.** O interop síncrono só está disponível em componentes do lado do cliente depois que o runtime WebAssembly está em execução. Durante a passagem de prerender no servidor de um componente `InteractiveWebAssembly`, converter `IJSRuntime` para `IJSInProcessRuntime` falha ou a chamada lança exceção. Use `OperatingSystem.IsBrowser()` quando precisar saber se o código está realmente executando no WebAssembly.

**Roteamento interativo pula o prerender.** Se você chega à página por uma navegação aprimorada interna em um app cujo componente `Routes` é interativo, o prerender não acontece, então o bug só se reproduz em um carregamento completo de página. Um componente que funciona ao clicar em um link e falha ao apertar F5 é quase sempre isso.

**Trabalho demorado na inicialização.** Como o prerender espera pela quiescência, um `OnInitializedAsync` lento bloqueia toda a resposta prerenderizada. Isso não é essa exceção, mas é o problema vizinho que a renderização em streaming existe para resolver, e costuma aparecer nos mesmos componentes.

## Relacionados

- [Como persistir o estado através do limite de renderização estático-para-interativo do Blazor no .NET 11](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) resolve a metade de dupla inicialização do limite de prerender.
- [Correção: o render mode não é compatível com o render mode do componente pai (Blazor)](/pt-br/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) explica a regra de uma subárvore e um render mode que limita onde `prerender: false` tem efeito.
- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cobre qual render mode atribuir em primeiro lugar.
- [Migrar um app Blazor Server para Blazor United (Blazor Web App) no .NET 11](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) mostra como introduzir render modes em um app que nunca teve nenhum.
- [Como compartilhar lógica de validação entre o servidor e o Blazor WebAssembly](/pt-br/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) é o padrão para lógica que precisa rodar dos dois lados do limite.

## Fontes

- [Prerender ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender) (Microsoft Learn, .NET 10/11)
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle) (Microsoft Learn)
- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) (Microsoft Learn), "Detect rendering location, interactivity, and assigned render mode at runtime"
- [ASP.NET Core Blazor JavaScript interoperability (JS interop)](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/) (Microsoft Learn), "JavaScript interop calls without a circuit"
- [`RemoteJSRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Server/src/Circuits/RemoteJSRuntime.cs) e [`UnsupportedJavaScriptRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Endpoints/src/DependencyInjection/UnsupportedJavaScriptRuntime.cs) em `dotnet/aspnetcore`, onde as duas mensagens são lançadas
- [dotnet/aspnetcore #24320](https://github.com/dotnet/aspnetcore/issues/24320), a issue de longa data que acompanha esse erro
