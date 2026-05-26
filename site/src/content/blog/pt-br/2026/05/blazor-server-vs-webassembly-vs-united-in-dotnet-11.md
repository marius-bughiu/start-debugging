---
title: "Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11: qual escolher em 2026?"
description: "Para qualquer app Blazor novo no .NET 11, crie um Blazor Web App (o template antes apelidado de Blazor United) e escolha o modo de render por página. Templates Server-only ou WebAssembly-only só fazem sentido em casos específicos."
pubDate: 2026-05-26
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Para um projeto Blazor novo no .NET 11, a resposta é o template Blazor Web App (o modelo apelidado de "Blazor United" enquanto o .NET 8 estava em preview). Ele deixa você decidir o renderização por componente: renderização estática do servidor para páginas de marketing, Server interativo para telas CRUD de baixa latência, WebAssembly interativo para widgets com capacidade offline, e Auto para componentes que devem migrar de Server para WebAssembly quando o payload do WASM terminar de baixar. Escolha um template só Server ou só WebAssembly apenas quando tiver uma restrição que descarte o modelo unificado: um app interno em que o download de WebAssembly seja inviável, ou um PWA que precise rodar totalmente offline contra uma API de terceiros.

Este artigo mira no .NET 11 (em preview no momento da escrita, GA prevista para novembro de 2026) e no conjunto de pacotes `Microsoft.AspNetCore.Components` 11.0.x. Os templates de projeto vêm de `Microsoft.AspNetCore.Components.WebAssembly.Templates` e do template `dotnet new blazor` que vem no SDK do .NET 11. Quando o comportamento varia entre versões, marco inline as diferenças entre .NET 8, .NET 9, .NET 10 e .NET 11.

## O que é "Blazor United" de verdade no .NET 11

"Blazor United" não é um modelo de hospedagem separado. Era o nome de trabalho que a Microsoft usou durante o ciclo de preview do .NET 8 para o que foi lançado como o template **Blazor Web App**. O template combina quatro modos de render em um único projeto:

- **Static Server (SSR)**: HTML renderizado no servidor, sem interatividade, sem circuito SignalR, sem download de WebAssembly. Carrega como uma Razor Page.
- **Interactive Server**: HTML renderizado no servidor, atualizações de DOM enviadas por um circuito SignalR. O modelo clássico do Blazor Server.
- **Interactive WebAssembly**: O componente roda no navegador sobre um runtime de WebAssembly. O modelo clássico do Blazor WebAssembly.
- **Interactive Auto**: Renderiza em Server enquanto o usuário aguarda o bundle de WebAssembly baixar em segundo plano, e depois passa de forma transparente para WebAssembly na próxima navegação. Fallback por componente se o WebAssembly não carregar.

Você declara o modo por componente com `@rendermode InteractiveServer`, `@rendermode InteractiveWebAssembly` ou `@rendermode InteractiveAuto`. O mesmo arquivo `.razor` pode rodar em qualquer um desses modos se não chamar APIs específicas do modo (mais sobre isso abaixo).

Blazor Server (o template autônomo, `dotnet new blazorserver`) e Blazor WebAssembly (`dotnet new blazorwasm`) ainda existem no .NET 11, mas a orientação da Microsoft desde o .NET 8 é: prefira o template unificado Blazor Web App, a menos que tenha um motivo específico para não usar.

## A matriz de recursos

| Capacidade                                | Blazor Server (autônomo)                 | Blazor WebAssembly (autônomo)                | Blazor Web App / United (.NET 11)            |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Local de renderização                     | servidor                                 | navegador                                    | por componente (Static, Server, WASM, Auto)  |
| Payload inicial (cache frio)              | ~50-80 KB HTML                           | ~1,4 MB WASM + assemblies (R2R, .NET 11)     | ~50-80 KB HTML, WASM baixa sob demanda       |
| First Contentful Paint (LAN)              | ~80-150 ms                               | ~600-900 ms                                  | ~80-150 ms (Static / Server) ~600-900 ms (WASM-first) |
| Tempo até interatividade após FCP         | dezenas de ms (abertura do WebSocket)    | centenas de ms (boot do WASM)                | depende do modo de render da página          |
| Requer WebSocket persistente              | sim (SignalR)                            | não                                          | só para componentes Interactive Server       |
| Funciona offline                          | não                                      | sim (com service worker)                     | sim para componentes WebAssembly, não para Server |
| Acesso direto a banco de dados / arquivos / segredos | sim (processo do servidor)      | não (sandbox do navegador)                   | sim em componentes Server, não em componentes WASM |
| Superfície de API .NET                    | runtime de servidor completo             | subconjunto reduzido, seguro para navegador  | ambos, dependendo do componente              |
| Histórico de depuração                    | F5 no Visual Studio / Rider              | devtools do Chrome + depurador WASM do VS    | ambos                                        |
| Teto de escala por servidor               | limitado por circuitos abertos (~5k por nó) | ilimitado (arquivos estáticos + API)     | limitado só para as páginas Interactive Server |
| Suporte a Native AOT                      | não (o servidor ainda é JIT)             | parcial via WASM AOT                         | por modo de render                           |
| Histórico de autenticação                 | cookie + circuito                        | OIDC / token no navegador                    | cookie para SSR/Server, token para WASM      |
| Status no .NET 11                         | suportado, não é o padrão recomendado    | suportado, não é o padrão recomendado        | padrão recomendado                           |

A linha que encerra a conversa para a maioria dos apps novos é a última. Os próprios templates, exemplos da documentação e tutoriais da Microsoft começam pelo template Blazor Web App. Escolher só Server ou só WebAssembly em 2026 é agora um desvio explícito que precisa de justificativa.

## Quando escolher Blazor Server (autônomo)

O template autônomo Blazor Server ainda é a escolha certa quando você tem uma destas restrições:

- **Aplicação interna em LAN, número fixo de usuários, proibição de downloads de WebAssembly.** Ferramentas de campo, dashboards de manufatura, telas em chão de hospital. Um download de 1,4 MB de WebAssembly por um Wi-Fi de quiosque instável é pior experiência que uma reconexão SignalR. Com .NET 11, o template autônomo Server também é a imagem de contêiner mais leve porque nunca copia o runtime WASM para a sua saída de publicação.
- **Você precisa chamar um SQL Server com autenticação do Windows ou um serviço protegido por Kerberos a partir do componente.** O componente roda no processo do servidor, então pode usar as credenciais integradas da identidade do app pool. Não há equivalente para WebAssembly sem um proxy do lado servidor.
- **A equipe não tem front-end e nunca terá.** A renderização de servidor com um circuito SignalR esconde quase todas as preocupações do navegador. O estado mora no servidor, você depura com ferramentas .NET comuns e não há um segundo pipeline de build para o bundle WASM.

Um `Program.cs` mínimo de Blazor Server no .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Note que `AddRazorComponents()` mais `AddInteractiveServerComponents()` é a API do .NET 8+. A antiga `AddServerSideBlazor()` ainda funciona, mas passa por uma camada de compatibilidade e não ativa a nova infraestrutura de modos de render. Use as APIs novas em qualquer projeto greenfield.

## Quando escolher Blazor WebAssembly (autônomo)

Vá para o template autônomo de WebAssembly quando:

- **O app precisa funcionar offline.** Um PWA enviado para engenheiros de campo, um app de tablet para associados de loja, qualquer coisa que fale com um backend atrás de uma conexão instável. Combine um service worker com um armazenamento local (`IndexedDB` via `Microsoft.JSInterop`) e o app sobrevive a uma perda total de rede.
- **Você está fazendo deploy em um CDN ou host estático sem runtime .NET.** Blazor WebAssembly é só `wwwroot/` mais uma pasta `_framework/`. Solte no Cloudflare Pages, GitHub Pages, Azure Static Web Apps ou qualquer bucket S3 atrás do CloudFront. Você paga zero de computação. O template Blazor Web App, em contraste, precisa de um host ASP.NET Core para as páginas Server e SSR.
- **O backend é uma API de terceiros que você não controla.** Se o seu repositório de dados é Stripe, Auth0 ou uma API REST pública, não há lógica de servidor para hospedar. O template autônomo de WASM mais um fluxo OIDC PKCE te dá um app totalmente do lado cliente sem infraestrutura própria.
- **Você quer enviar o front-end como parte de um app MAUI Hybrid ou Electron.** Tanto `BlazorWebView` quanto o template .NET MAUI Hybrid esperam um grafo de componentes no estilo WebAssembly autônomo. Embutir um projeto Blazor Web App ali não agrega nada.

Um `Program.cs` mínimo de Blazor WebAssembly no .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.WebAssembly 11.0.x
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

await builder.Build().RunAsync();
```

No .NET 11, o runtime de WebAssembly tem multithreading habilitado por padrão para projetos novos quando você opta pela flag `<WasmEnableThreads>true</WasmEnableThreads>` no `.csproj`. Isso elimina um dos motivos mais usados para descartar Blazor WebAssembly: trabalho intensivo em CPU não bloqueia mais a thread de UI.

## Quando escolher Blazor Web App (o modelo United)

Para todo o resto. O template unificado entrega um único projeto onde:

- A landing é `@rendermode StaticServer` e carrega em menos de 100 ms sem nenhum JavaScript. Para um crawler é indistinguível de uma Razor Page.
- O dashboard é `@rendermode InteractiveServer` porque fala direto com um `DbContext` e você não quer expor essas consultas por uma API.
- O anotador de imagens é `@rendermode InteractiveWebAssembly` porque executa um modelo ONNX no navegador via `Microsoft.ML.OnnxRuntime`.
- Os componentes compartilhados do shell são `@rendermode InteractiveAuto`: renderizam em Server no primeiro paint, depois passam para WebAssembly quando o bundle termina de baixar, de modo que as navegações seguintes são instantâneas e sobrevivem a um restart do servidor.

Essa capacidade de composição é o que nada mais iguala. Você deixa de ter uma decisão binária "app Server ou app WASM" e passa a ter uma decisão por página, do mesmo jeito que o Next.js deixa misturar `ssr`, `static` e `client`. Um `Program.cs` mínimo de Blazor Web App no .NET 11:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x +
// Microsoft.AspNetCore.Components.WebAssembly.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorApp.Client._Imports).Assembly);

app.Run();
```

O projeto `.Client` que vem com o template é onde você coloca os componentes que precisam rodar em WebAssembly. Componentes só de servidor ficam no projeto host. Componentes Interactive Auto vivem em `.Client` (porque também precisam estar acessíveis do lado WebAssembly).

## Os dados de cold start e tamanho de bundle

Os números abaixo vêm de um `dotnet new blazor`, `dotnet new blazorserver` e `dotnet new blazorwasm` limpos no SDK do .NET 11 `11.0.100-preview.4.26152.6`, publicados com `dotnet publish -c Release` e servidos por `dotnet run`. Medidos com Chrome 137 em um MacBook Pro M2, cache frio, throttling "Fast 3G" no DevTools.

| Métrica                                      | Blazor Server | Blazor WebAssembly | Blazor Web App (landing Auto) |
| -------------------------------------------- | ------------- | ------------------ | ----------------------------- |
| HTML inicial transferido                     | 8 KB          | 4 KB               | 8 KB                          |
| WebAssembly + assemblies transferidos        | 0             | 1,42 MB (gzip)     | 1,42 MB (gzip, sob demanda)   |
| Tempo até First Contentful Paint             | 320 ms        | 1850 ms            | 340 ms                        |
| Tempo até interatividade (botão de contador) | 410 ms        | 2300 ms            | 440 ms (Server) / 2400 ms (handoff para WASM) |
| Memória após a primeira navegação            | 7 MB navegador| 38 MB navegador    | 9 MB e depois 41 MB após o handoff |

O Blazor Web App em modo Auto vence o WebAssembly autônomo no first paint por um fator de cinco porque não espera pelo bundle. Não vence o Server autônomo porque, assim que o bundle de WebAssembly termina de carregar, ele consome memória de qualquer jeito. O ponto não é que Auto seja o mais rápido em uma métrica. O ponto é que ele nunca é o mais lento.

Para um olhar mais profundo em como o SDK do .NET 11 reduz o bundle WASM, veja [o novo template Blazor WebWorker do .NET 11](/2026/04/dotnet-11-preview-2-blazor-webworker-template/), que usa as mesmas configurações do trimmer.

## O gotcha que decide por você

Três coisas forçam a decisão independente da preferência:

1. **Você não pode colocar uma injeção de `DbContext` em um componente WebAssembly.** Nem nenhum valor de `IConfiguration` que contenha um segredo. Nem nenhum cliente de blob que use uma string de conexão. O navegador é um ambiente hostil por design. Se o seu componente precisa ler o banco de dados direto, ele precisa ser Server (ou você precisa de uma API backend que o componente WASM chame). O template Blazor Web App revela isso falhando rápido: solte `@inject ApplicationDbContext Db` em um componente `.Client` e o build falha com um erro claro de DI faltante.

2. **Você não pode trocar de `@rendermode` dentro de um limite de modo de render.** Uma página renderizada como Static Server pode hospedar uma ilha Interactive Server, e uma página Interactive Server pode hospedar ilhas Interactive WebAssembly, mas você não pode aninhar interatividade dentro de interatividade. Na prática: escolha o modo de render mais baixo que sirva para a página e só escale no nível de ilha.

3. **HTTPS, antiforgery e estado de autenticação fluem por cookies por padrão.** Componentes WebAssembly não veem esses cookies em requisições cross-origin. Se a parte WebAssembly de um Blazor Web App chama uma API externa, você precisa de um fluxo de token OIDC por cima, não só do cookie do host. Esse é o tropeço mais comum na migração de um app Blazor Server para o template Web App.

Para o ângulo específico de antiforgery, [o comportamento de TempData no Blazor SSR no .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) e o [guia de lógica de validação compartilhada](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) cobrem os padrões práticos.

## Recomendação reafirmada

Para um projeto Blazor novo no .NET 11 em 2026, comece com `dotnet new blazor` (o template Blazor Web App) e atribua modos de render por página. O custo de poder cair para `@rendermode StaticServer` em uma página de marketing ou subir para `@rendermode InteractiveWebAssembly` em um componente com capacidade offline é quase zero em relação ao custo de escolher o template autônomo errado e reescrever depois. Escolha `dotnet new blazorserver` só se tiver uma proibição rígida de downloads de WebAssembly. Escolha `dotnet new blazorwasm` só se o destino de deploy não tiver runtime .NET, ou se estiver embutindo o front-end em MAUI Hybrid ou Electron.

Se você já está em Blazor Server hoje e pesa uma migração, o destino é quase sempre o template Blazor Web App com a maioria das suas páginas existentes em `@rendermode InteractiveServer`. Essa é a migração de menor risco: o comportamento fica idêntico para as páginas que migram, e você destrava a opção de adicionar componentes Static Server e Auto de forma incremental.

## Relacionados

- [Minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para as decisões de API backend que um Blazor Web App abre.
- [Como usar Tailwind CSS com Blazor WebAssembly no .NET 11](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) para as diferenças do pipeline de estilo entre WASM autônomo e o template Blazor Web App.
- [Como compartilhar lógica de validação entre servidor e Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) para o padrão prático de "projeto compartilhado" que o template Web App formaliza.
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) para os trade-offs de modo de compilação que afetam tanto Server quanto WASM.
- [Blazor virtualize com altura variável no .NET 11 Preview 3](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) para uma das APIs novas que beneficiam listas de componentes em modo Auto.

## Fontes

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, acessado em 2026-05-26.
- [What's new in ASP.NET Core in .NET 8](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-8.0) para o primeiro envio do template unificado (então chamado "Blazor United" em previews).
- [What's new in ASP.NET Core for .NET 11](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-11.0) para as melhorias por modo de render.
- [ASP.NET Core Blazor WebAssembly with multithreading](https://learn.microsoft.com/aspnet/core/blazor/performance#webassembly-multithreading) para a flag `WasmEnableThreads`.
- [`dotnet/aspnetcore` discussion 51020](https://github.com/dotnet/aspnetcore/discussions/51020), onde engenheiros da Microsoft explicaram por que "United" virou "Web App" no nome do template GA.
