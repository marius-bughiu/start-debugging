---
title: "Correção: o render mode não é compatível com o render mode do componente pai (Blazor)"
description: "Você colocou @rendermode em um filho cujo pai já é interativo. Um subárvore tem exatamente um render mode. Remova a diretiva do filho ou mova-a para o limite."
pubDate: 2026-06-09
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor"
translatedBy: "claude"
translationDate: 2026-06-09
---

A correção: você aplicou `@rendermode` a um componente filho que vive dentro de um subárvore que já tem um render mode interativo, e os dois modos não coincidem. Um subárvore do Blazor tem exatamente um render mode, fixado no seu limite interativo. Você não pode trocar de `InteractiveServer` para `InteractiveWebAssembly` (ou vice-versa) no meio da árvore. Remova a diretiva `@rendermode` do filho para que ele herde o modo do pai, ou suba o render mode para o único componente que possui o limite interativo. Se os modos forem na verdade o mesmo, o problema real é um `@rendermode` duplicado em um componente aninhado, e você deve excluir o interno.

```text
System.InvalidOperationException: Cannot create a component of type
'BlazorSample.Components.SharedMessage' because its render mode
'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode'
is not supported by Interactive Server rendering.
   at Microsoft.AspNetCore.Components.Rendering.ComponentState..ctor(...)
   at Microsoft.AspNetCore.Components.RenderTree.Renderer.AddToRenderQueue(...)
   at Microsoft.AspNetCore.Components.Endpoints.EndpointHtmlRenderer...
```

Este guia foi escrito para .NET 11 (ASP.NET Core 11, `Microsoft.AspNetCore.Components` 11.0.0), mas a regra é idêntica desde que os render modes chegaram no .NET 8. O texto da mensagem varia conforme a combinação que você atinge, então o tráfego de busca chega aqui com várias formulações: "its render mode is not supported by Interactive Server rendering", "render mode is not supported by the parent component's render mode" e a bem relacionada "Cannot pass the parameter X to component Y with rendermode InteractiveServerRenderMode". As três vêm da mesma restrição de fundo, e a última tem uma correção diferente, abordada mais adiante.

## Um subárvore, um render mode

Em uma Blazor Web App, a interatividade não é um interruptor por componente que você espalha onde quiser. Quando um componente declara `@rendermode InteractiveServer` ou `@rendermode InteractiveWebAssembly`, ele cria um *limite* interativo. Tudo que é renderizado dentro desse limite (cada filho, neto e o conteúdo que eles renderizam) roda sob esse único render mode. O limite é a raiz de uma *ilha* interativa, e uma ilha tem um único modelo de hospedagem: ou um circuito SignalR no servidor, ou um runtime WebAssembly no navegador. Não há como rodar metade de uma ilha no servidor e metade no navegador, porque as duas compartilham uma árvore de estado de componentes viva e um único dispatcher.

É por isso que as regras na documentação oficial são enunciadas como absolutos. Da [documentação de render modes do Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes):

- Os render modes se propagam para baixo pela hierarquia de componentes.
- O render mode padrão é Static.
- Você não pode trocar para um render mode interativo diferente em um componente filho. Por exemplo, um componente Server não pode ser filho de um componente WebAssembly.

Então, quando o renderizador percorre a árvore, chega ao seu componente filho e encontra um `@rendermode` que conflita com a ilha em que ele já está, ele não pode honrá-lo. Ele lança uma exceção em vez de escolher um em silêncio. A exceção é construída quando o framework tenta criar o estado do componente para o filho problemático, por isso a stack trace aponta para `ComponentState` e o renderizador, não para o seu código.

Um modelo mental útil: `@rendermode` responde à pergunta "onde esta ilha começa e o que a hospeda?". Não é uma propriedade de cada componente. A maioria dos componentes não deveria carregar nenhum render mode e simplesmente herdar a ilha em que cai.

## O repro mínimo

Uma página é interativa no servidor e aninha um componente que pede WebAssembly:

```razor
@* RenderMode11.razor -- .NET 11, ASP.NET Core 11 -- throws at render time *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage @rendermode="InteractiveWebAssembly" />
```

`SharedMessage` em si é agnóstico quanto ao render mode (não declara modo próprio):

```razor
@* SharedMessage.razor -- .NET 11 *@
<p>@message</p>
<button @onclick="UpdateMessage">Update</button>

@code {
    private string message = "Not updated yet.";
    private void UpdateMessage() => message = "Updated!";
}
```

Navegue até `/render-mode-11` e a página falha ao renderizar com:

```text
Cannot create a component of type 'SharedMessage' because its render mode
'InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.
```

O pai possui uma ilha de servidor. O filho exigiu uma ilha WebAssembly aninhada dentro. Esse aninhamento não é representável, então ele lança a exceção.

## A correção, em ordem de prioridade

**1. Remova o render mode do filho (o mais comum).** Nove em cada dez vezes o filho nunca deveria ter um `@rendermode`. Foi copiado de um exemplo, ou adicionado por precaução "para torná-lo interativo", quando na verdade ele herda a interatividade do pai de graça. Exclua a diretiva:

```razor
@* RenderMode11.razor -- fixed: child inherits the parent's server island *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage />
```

Agora `SharedMessage` roda de forma interativa sobre a mesma conexão SignalR que o pai. O botão funciona. Esse é o comportamento de [herança de render mode](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-inheritance) que a documentação descreve: um componente colocado dentro de um pai interativo adota o modo desse pai.

**2. Faça os dois modos coincidirem.** Se você realmente queria WebAssembly aqui, o que está errado é o *pai*. Coloque a ilha inteira em WebAssembly no seu limite e remova a diretiva do filho:

```razor
@* fixed: the whole island is WebAssembly *@
@page "/render-mode-11"
@rendermode InteractiveWebAssembly

<SharedMessage />
```

Lembre-se de que uma ilha WebAssembly só pode viver no projeto cliente (aquele cujo nome termina em `.Client`). Mova para lá tanto a página quanto `SharedMessage`, ou esta correção troca um erro por `Could not find any interactive components`.

**3. Divida a ilha para que os dois modos sejam irmãos, não aninhados.** Conteúdo Server e WebAssembly podem coexistir na mesma página desde que nenhum esteja *dentro* do outro. Faça ambos serem filhos de um pai estático:

```razor
@* fixed: two sibling islands under a static page *@
@page "/render-mode-11"

@* no @rendermode here -- the page stays static SSR *@
<ServerWidget @rendermode="InteractiveServer" />
<WasmWidget @rendermode="InteractiveWebAssembly" />
```

A página em si renderiza estaticamente e hospeda duas ilhas independentes. Esse é o padrão correto quando um widget precisa de serviços só de servidor (um banco de dados, cookies HTTP) e outro precisa rodar offline no navegador. A restrição é apenas sobre *aninhar* modos não coincidentes, não sobre ter ambos em uma página.

**4. Use `InteractiveAuto` no limite, não no meio.** `InteractiveAuto` continua sendo um único render mode para a ilha: ele escolhe Server na primeira visita e WebAssembly depois que o bundle está em cache. Você o define uma única vez, no limite, exatamente como os outros dois. Ele não permite misturar modos dentro de um subárvore.

## O parecido: "Cannot pass the parameter ... with rendermode"

Um erro diferente, mas constantemente confundido, tem quase o mesmo gatilho. Quando um filho interativo fica sob um pai *estático* e você passa um `RenderFragment` (conteúdo filho) para ele, você recebe:

```text
System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to
component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is
because the parameter is of the delegate type
'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and
cannot be serialized.
```

Aqui os modos não conflitam; o *parâmetro* não pode cruzar o limite. Parâmetros entregues de um pai estático para um filho interativo precisam ser serializáveis em JSON, porque o servidor estático tem que serializá-los dentro da página para que o runtime interativo os reidrate. Um `RenderFragment` é um delegate compilado (código arbitrário), então não pode ser empacotado (marshal).

A correção que o próprio framework usa é um componente envoltório que não recebe parâmetros e aplica o render mode na sua própria definição. É exatamente por isso que o template de Blazor Web App envolve `Router` dentro de um componente `Routes`:

```razor
@* WrapperComponent.razor -- holds the render mode, takes no serialized params *@
@rendermode InteractiveServer

<SharedMessage>
    <p>This child content is created inside the interactive island, not passed across it.</p>
</SharedMessage>
```

Como o `RenderFragment` agora é escrito *dentro* do limite interativo em vez de passado através dele, não há nada para serializar. O mesmo truque resolve a variante que você atinge ao tentar tornar interativo um layout que deriva de `LayoutComponentBase` em um app com interatividade por página: envolva a parte interativa em vez de marcar o layout.

## Armadilhas que levam à correção errada

**Marcar o componente `App` ou raiz como interativo.** Tornar interativo um componente raiz como `App` não é suportado, então você não pode definir o render mode de todo o app diretamente no `App`. O template o define em `<Routes @rendermode="..." />` e `<HeadOutlet @rendermode="..." />`. Se você colocar `@rendermode` em `App.razor` verá erros de limite relacionados; mova-o para baixo, para `Routes`.

**Um render mode `null` não é "estático".** Passar `@rendermode="@umaVariavelNull"` não força o renderizado estático. Um render mode `null` significa "herde do pai". Se o pai é interativo, um filho `null` continua interativo. A única razão pela qual o [padrão de páginas SSR estáticas](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#static-ssr-pages-in-an-interactive-app) funciona com um modo `null` é que o pai dele (`App`) é estático desde o início.

**A interatividade global esconde a diretiva.** Se você adotou a interatividade global definindo o modo em `Routes`, cada página o herda. Adicionar um *segundo* `@rendermode` a uma página ou componente agora é redundante na melhor das hipóteses e conflitante na pior. Procure diretivas `@rendermode` perdidas no seu projeto antes de supor que o framework está errado.

**Definição de componente vs instância de componente.** Você pode aplicar `@rendermode` de duas formas: em uma *instância* de componente (`<SharedMessage @rendermode="InteractiveServer" />`) ou na *definição* do componente (`@rendermode InteractiveServer` no topo de `SharedMessage.razor`, via forma de atributo). Um modo embutido na definição dispara em todo lugar onde o componente é usado, inclusive dentro de uma ilha que já tem um modo diferente. Se você não encontrar uma diretiva de instância problemática, verifique o próprio arquivo `.razor` do filho por uma no nível de definição.

O fio condutor de cada variante: decida onde cada ilha interativa começa, defina o modo uma única vez nesse limite e deixe tudo o que está dentro herdar. O renderizador lança a exceção precisamente porque você tentou redesenhar um limite no meio de um subárvore que já tinha um.

## Relacionado

- [Como persistir estado através do limite de renderização estática para interativa do Blazor no .NET 11](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) cobre o lado dos dados do mesmo limite que este erro protege.
- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) explica qual modelo de hospedagem cada render mode escolhe e quando usar cada um.
- [Migrar um app Blazor Server para Blazor United no .NET 11](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) percorre como introduzir render modes em um app que nunca os teve.
- [Como compartilhar lógica de validação entre o servidor e Blazor WebAssembly](/pt-br/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) é o padrão que você quer quando ilhas irmãs precisam das mesmas regras.
- [Blazor SSR finalmente ganha TempData no .NET 11](/pt-br/2026/04/blazor-ssr-tempdata-dotnet-11/) é útil quando uma página SSR estática em um app interativo precisa passar dados através de uma recarga completa de página.

## Fontes

- [ASP.NET Core Blazor render modes -- Render mode propagation and inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Microsoft Learn (aspnetcore-11.0).
- [ASP.NET Core Blazor render modes -- Child component with a different render mode than its parent](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-propagation), Microsoft Learn.
- [dotnet/aspnetcore #55319 -- Blazor component cannot be nested inside a parent using a render fragment if the nested component is interactive](https://github.com/dotnet/aspnetcore/issues/55319).
</content>
