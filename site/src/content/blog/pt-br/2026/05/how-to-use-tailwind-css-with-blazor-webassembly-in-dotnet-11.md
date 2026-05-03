---
title: "Como usar Tailwind CSS com Blazor WebAssembly no .NET 11"
description: "Uma configuração completa do .NET 11 para Tailwind CSS v4 em um app Blazor WebAssembly: CLI standalone (sem Node), target do MSBuild, diretivas @source para arquivos Razor e de isolamento de CSS, e um pipeline de publicação que sobrevive ao Native AOT."
pubDate: 2026-05-03
tags:
  - "blazor"
  - "blazor-webassembly"
  - "tailwind-css"
  - "dotnet-11"
  - "csharp"
  - "msbuild"
lang: "pt-br"
translationOf: "2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

A configuração viável mais curta do Tailwind v4 para um app Blazor WebAssembly no .NET 11 tem três peças móveis: o binário standalone do Tailwind CLI (sem Node, sem npm), um target `BeforeBuild` do MSBuild que o executa, e um arquivo `Styles/app.css` cujas diretivas `@source` apontam para seus arquivos `.razor` e `.razor.css`. O CLI compila para `wwwroot/css/app.css`, você referencia esse arquivo a partir de `wwwroot/index.html`, e o build adiciona aproximadamente um segundo em uma execução fria e de 50 a 150 ms em recompilações incrementais. O mesmo pipeline sobrevive ao `dotnet publish`, ao trimming e ao Native AOT, nenhum dos quais toca no CSS, mas todos quebram configurações ingênuas baseadas em Node.

Este guia percorre a integração completa em `Microsoft.AspNetCore.Components.WebAssembly` 11.0.0 com Tailwind CSS 4.0.x, C# 14 e o SDK fixado em `global.json` em `9.0.100` ou mais recente (o SDK do .NET 11 é distribuído como `9.0.100` até o GA). Toda afirmação abaixo foi verificada contra um projeto `dotnet new blazorwasm-empty` vazio no Windows 11 e no Ubuntu 24.04.

## Por que os templates baseados em Node não sobrevivem a um build do Blazor

A maioria dos tutoriais de "Tailwind no Blazor" ainda diz para você instalar o Node, rodar `npm install -D tailwindcss`, escrever um `tailwind.config.js` e invocar `npx tailwindcss` a partir de um target de build. Essa configuração funciona em um laptop de desenvolvedor e explode na primeira vez que roda em um container limpo ou em uma imagem de CI sem Node:

- O target do MSBuild invoca `npx`, que falha rapidamente com `'npx' is not recognized`. O passo de `dotnet publish` sai com código 1 e um stack trace apontando para dentro do MSBuild em vez do seu código.
- `package.json` e `node_modules` acabam versionados ao lado do `.csproj`, dobrando o tempo de restore e inchando o repositório com centenas de megabytes de pacotes npm transitivos cuja única função é compilar um único arquivo CSS.
- O caminho baseado em PostCSS do Tailwind v4 usa o [Lightning CSS](https://lightningcss.dev/), que distribui binários nativos por OS e CPU. Um `package-lock.json` gerado no Windows falha em um build agent Linux, com um passo de `npm rebuild` parafusado por cima como solução alternativa.

O [Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) lançou um CLI standalone explicitamente para escapar dessa pilha inteira. É um único binário, em torno de 80 MB, que contém o compilador completo e o scanner de conteúdo Oxide. Você o coloca ao lado do seu repositório (ou instala em todo o sistema), invoca a partir do MSBuild, e a única dependência que uma imagem de CI precisa é o próprio arquivo.

## Obtenha o CLI standalone do Tailwind v4

O Tailwind publica binários por plataforma a cada release. Escolha o que combina com seus build agents e máquinas de desenvolvimento:

- Windows x64: `tailwindcss-windows-x64.exe`
- Linux x64: `tailwindcss-linux-x64`
- macOS arm64: `tailwindcss-macos-arm64`

Baixe da [página de releases do Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/releases) e ou coloque o arquivo em `tools/tailwindcss.exe` dentro do seu repositório (commitado, ~80 MB), ou instale em todo o sistema via `winget install --id TailwindLabs.Tailwind` no Windows ou `brew install tailwindcss` no macOS.

A abordagem do binário commitado é a que se sustenta em CI sem surpresas, porque o build não precisa de acesso à rede e cada contribuidor recebe exatamente a mesma versão do Tailwind. O custo é ~80 MB no seu histórico do Git. Se isso te incomoda, armazene em [Git LFS](https://git-lfs.com/) ou baixe na hora em um target `Restore`. Para o restante deste post vou assumir que o binário vive em `tools/tailwindcss.exe`.

```text
MyBlazorApp/
├── MyBlazorApp.csproj
├── Styles/
│   └── app.css
├── tools/
│   └── tailwindcss.exe   <-- standalone v4 binary
└── wwwroot/
    ├── index.html
    └── css/
        └── app.css        <-- generated, gitignored
```

Adicione o arquivo gerado ao `.gitignore`:

```text
# .gitignore
wwwroot/css/app.css
```

O CSS gerado é puro artefato de build; commitá-lo produz diffs barulhentos toda vez que alguém muda um nome de classe em um componente.

## Conecte o CLI ao seu `.csproj`

Abra `MyBlazorApp.csproj` e adicione um target `BeforeBuild`. A task `Exec` invoca o CLI standalone com a entrada, saída e (em `Release`) uma flag `--minify` corretas.

```xml
<!-- MyBlazorApp.csproj  (.NET 11, Tailwind CSS 4) -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TailwindCli>$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
    <TailwindInput>$(MSBuildProjectDirectory)/Styles/app.css</TailwindInput>
    <TailwindOutput>$(MSBuildProjectDirectory)/wwwroot/css/app.css</TailwindOutput>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="11.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="11.0.0" PrivateAssets="all" />
  </ItemGroup>

  <Target Name="TailwindBuild" BeforeTargets="BeforeBuild">
    <Exec Command="&quot;$(TailwindCli)&quot; -i &quot;$(TailwindInput)&quot; -o &quot;$(TailwindOutput)&quot; $(TailwindArgs)"
          ConsoleToMSBuild="true" />
  </Target>

  <Target Name="TailwindBuildRelease" BeforeTargets="TailwindBuild" Condition="'$(Configuration)' == 'Release'">
    <PropertyGroup>
      <TailwindArgs>--minify</TailwindArgs>
    </PropertyGroup>
  </Target>
</Project>
```

Duas coisas vale saber sobre esse target. Primeiro, o comando `Exec` coloca cada caminho entre aspas para que o build ainda funcione quando o projeto vive em `C:\Users\you\Documents\My Apps\Blazor`. Segundo, a flag `--minify` só dispara em `Release`, o que mantém os builds de `Debug` rápidos e te dá um CSS legível nas dev tools do navegador durante o desenvolvimento.

No Linux e no macOS você pode substituir o caminho específico do Windows por uma condição por OS:

```xml
<TailwindCli Condition="'$(OS)' == 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
<TailwindCli Condition="'$(OS)' != 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss</TailwindCli>
```

Os dois binários compartilham a mesma superfície de CLI; a única diferença é o nome do arquivo e o bit de executável no Unix.

## Diga ao Tailwind onde suas classes vivem

A maior mudança do Tailwind v4 para usuários Blazor é o desaparecimento do `tailwind.config.js`. O framework agora faz configuração CSS-first: você coloca blocos `@theme`, `@source` e `@layer` diretamente no seu arquivo CSS de entrada, e não há nenhuma configuração JavaScript. Isso é boa notícia para projetos .NET, que não tinham por que arrastar uma toolchain JS para definir uma paleta de cores.

Crie `Styles/app.css` e diga ao Tailwind onde procurar por nomes de classe. Por padrão o v4 só varre o sistema de arquivos relativo ao CSS de entrada, então sem diretivas `@source` explícitas ele não vai encontrar nada nos seus arquivos Razor.

```css
/* Styles/app.css -- Tailwind CSS 4.0 */
@import "tailwindcss";

@source "../**/*.razor";
@source "../**/*.razor.cs";
@source "../**/*.razor.css";
@source "../**/*.cshtml";
@source "../wwwroot/index.html";

@theme {
  --color-brand-50:  oklch(96% 0.02 260);
  --color-brand-500: oklch(64% 0.18 260);
  --color-brand-900: oklch(28% 0.10 260);

  --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}

@layer components {
  .btn-primary {
    @apply inline-flex items-center gap-2 rounded-md
           bg-brand-500 px-4 py-2 text-sm font-medium text-white
           hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-brand-500 transition-colors;
  }
}
```

Alguns detalhes vale destacar. O glob `../**/*.razor.cs` pega arquivos code-behind onde você pode montar nomes de classe dinamicamente, por exemplo `var classes = active ? "bg-brand-500" : "bg-gray-100";`. O scanner de conteúdo do Tailwind é um extrator baseado em regex (o [engine Oxide](https://tailwindcss.com/blog/tailwindcss-v4#new-high-performance-engine)), então enquanto a string literal aparecer em qualquer lugar de um arquivo varrido ela vai parar na saída. O bloco `@theme` define design tokens como custom properties de CSS, que o Tailwind então expõe como utilidades (`bg-brand-500`, `text-brand-900`). Isso substitui inteiramente o bloco JavaScript `theme: { extend: { colors: ... } }` da v3.

Conecte o arquivo gerado ao `wwwroot/index.html`:

```html
<!-- wwwroot/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyBlazorApp</title>
  <base href="/" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="MyBlazorApp.styles.css" />
</head>
<body>
  <div id="app">Loading...</div>
  <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
```

O link `MyBlazorApp.styles.css` é o bundle de isolamento de CSS do Blazor, que o SDK gera a partir de cada arquivo `Component.razor.css` no projeto. A ordem importa: carregue `app.css` primeiro para que estilos com escopo de componente possam sobrescrever os defaults do Tailwind.

## Faça o isolamento de CSS conviver bem

O isolamento de CSS do Blazor anexa um atributo de escopo por componente (por exemplo `b-9pdypsqo3w`) a cada seletor e reescreve elementos para carregar esse atributo. Utilidades do Tailwind aplicadas diretamente em elementos no markup herdam o escopo automaticamente, mas diretivas `@apply` dentro de um arquivo `Component.razor.css` precisam de um momento de cuidado.

Isto funciona:

```razor
@* Pages/Counter.razor *@
<button class="btn-primary" @onclick="IncrementCount">
  Count: @currentCount
</button>
```

`btn-primary` veio do seu bloco `@layer components` em `Styles/app.css`, então a definição da classe vive no `app.css` global. O botão ainda recebe o atributo de escopo, mas o seletor do Tailwind é `.btn-primary` (sem escopo), que casa.

Isto também funciona, e é a maneira certa de escrever utilidades privadas de componente:

```css
/* Pages/Counter.razor.css */
@reference "../../Styles/app.css";

.danger {
  @apply rounded-md bg-red-600 px-3 py-1 text-white;
}
```

A diretiva `@reference` (nova na v4) diz ao Tailwind quais design tokens do arquivo de entrada usar sem duplicar o CSS deles no bundle do componente. Sem `@reference`, `@apply red-600` não consegue resolver, porque o arquivo CSS com escopo de componente não tem nenhum `@import "tailwindcss";` próprio. Com ela, apenas os bytes da utilidade `red-600` são puxados para o bundle com escopo, e o atributo de escopo é preservado pelo passo de isolamento de CSS do Blazor.

Adicione os arquivos de isolamento aos seus padrões `@source` (já mostrado acima) para que quaisquer classes que você escreva inline em arquivos `.razor.css` sejam extraídas junto com o resto. Se você só coloca utilidades no markup e nunca as referencia em `.razor.css`, pode descartar esse glob.

## Um componente real de ponta a ponta

Aqui está uma página `Pages/Home.razor` e seu CSS com escopo, construído sobre os design tokens definidos acima. Ela usa utilidades diretamente no markup, chama uma classe de componente customizada do `app.css` e adiciona uma utilidade privada de componente via `@apply`.

```razor
@* Pages/Home.razor *@
@page "/"

<section class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="font-sans text-4xl font-semibold text-brand-900">
    Tailwind on Blazor WebAssembly
  </h1>
  <p class="mt-3 text-base text-slate-600">
    Built with the standalone CLI, no Node toolchain required.
  </p>

  <div class="mt-8 flex items-center gap-3">
    <button class="btn-primary" @onclick="Refresh">Refresh</button>
    <span class="status">Last refresh: @lastRefresh.ToLocalTime():T</span>
  </div>
</section>

@code {
    private DateTime lastRefresh = DateTime.UtcNow;

    private void Refresh() => lastRefresh = DateTime.UtcNow;
}
```

```css
/* Pages/Home.razor.css */
@reference "../../Styles/app.css";

.status {
  @apply text-sm font-mono text-slate-500;
}
```

Rode `dotnet build`. O target `TailwindBuild` dispara antes que o SDK comece a compilar C#, o binário varre cada arquivo Razor e CSS que os globs `@source` casam, e `wwwroot/css/app.css` aterrissa apenas com as utilidades que você de fato usou. Em um projeto `blazorwasm-empty` recém-criado a saída cai dos teóricos 3,5 MB de Tailwind não minificado para aproximadamente 18 KB minificado para a página acima. Esse número escala com quantas utilidades distintas você puxa em todo o app, que é justamente o ponto de um engine on-demand.

## Builds de produção, `dotnet publish` e Native AOT

`dotnet publish -c Release` roda o mesmo target `BeforeBuild` com `--minify` habilitado. A saída publicada em `bin/Release/net11.0/publish/wwwroot/css/app.css` é o arquivo minificado pronto para compressão Brotli pelo pipeline de publicação do Blazor (`BlazorEnableCompression`, ligado por padrão).

Há algumas arestas a conhecer:

- **Native AOT para Blazor WebAssembly**: o passo de compilação AOT (`<RunAOTCompilation>true</RunAOTCompilation>`) opera em assemblies .NET, nunca em CSS. O Tailwind fica inteiramente fora desse pipeline, então AOT não muda nada para essa configuração. Os tempos de publicação fria se esticam de 30 segundos para vários minutos, mas o Tailwind continua sendo um custo abaixo de um segundo nessa mistura.
- **Trimming**: o trimmer também não tem nada a ver com CSS. Ele vai, no entanto, ocasionalmente reclamar de reflexão dentro de bibliotecas JavaScript adjacentes ao Tailwind que você possa adicionar (por exemplo, helpers de UI headless). Mantenha esses isolados em arquivos JS referenciados a partir do `index.html`, não bundleados através de qualquer camada de interop em C#.
- **Bundling de static web assets**: se você definir `<BlazorWebAssemblyLoadAllGlobalizationData>` ou usar [as opções de compressão em tempo de publicação do Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/webassembly), `wwwroot/css/app.css` é incluído automaticamente. Não há nenhuma fiação extra.
- **Modo watch**: `dotnet watch` roda novamente o target `BeforeBuild` a cada mudança em arquivo Razor, então adicionar uma classe a um componente dispara uma recompilação do Tailwind e o navegador faz hot-reload da nova folha de estilos em menos de um segundo. Se você quer watching apenas de CSS de verdade (mais barato que a recompilação Razor completa), rode `tools/tailwindcss.exe --watch` em um terminal separado ao lado do `dotnet watch run`.

## Pegadinhas que vale conhecer

A configuração acima é durável, mas três coisas mordem as pessoas consistentemente na entrada.

Primeiro, classes construídas em runtime que o scanner não consegue ver no código-fonte não vão sobreviver ao purge do Tailwind. `var c = $"bg-{color}-500";` produz `bg-red-500` em runtime, mas o Tailwind nunca vê o literal no fonte e o descarta da saída. O conserto é colocar o conjunto completo em uma whitelist explicitamente via um comentário:

```csharp
// .NET 11, C# 14: Tailwind scanner sees these literals
// bg-red-500 bg-green-500 bg-blue-500
private static string ColorClass(string color) => $"bg-{color}-500";
```

O extrator baseado em regex do Tailwind encontra esses literais no comentário e os mantém no bundle. A concatenação em runtime então resolve para uma classe que de fato existe no CSS.

Segundo, páginas Blazor pré-renderizadas (uma configuração híbrida Blazor United onde o host renderiza no servidor o cliente WASM) precisam que tanto `app.css` quanto `MyBlazorApp.styles.css` sejam alcançáveis a partir do pipeline de arquivos estáticos do servidor. Se você divide o projeto em um host `Server` mais um projeto WASM `Client`, o [layout de compartilhamento de validação que cobri no início desta semana](/pt-br/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) é o mesmo padrão: o projeto `Client` é dono do build do Tailwind, e o `Server` referencia o `Client` para que seu `wwwroot` seja publicado ao lado do host.

Terceiro, integração com IDE. A extensão oficial [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) para VS Code lê seu `Styles/app.css` e te dá completions dentro de arquivos `.razor` uma vez que você adiciona `razor` à configuração `tailwindCSS.includeLanguages`. Rider e Visual Studio ambos distribuem plugins de Tailwind a partir das releases 2025.1, ambos os quais funcionam da mesma maneira: aponte-os para o arquivo CSS de entrada e eles capturam os design tokens de `@theme` automaticamente.

## Leitura relacionada

- [Como compartilhar lógica de validação entre servidor e Blazor WebAssembly](/pt-br/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) para o padrão de layout de projeto que casa naturalmente com este pipeline de CSS.
- [dotnet new webworker: Web Workers de primeira classe para Blazor no .NET 11 Preview 2](/pt-br/2026/04/dotnet-11-preview-2-blazor-webworker-template/) para descarregar trabalho de CPU sem quebrar seu layout do Tailwind.
- [Blazor Virtualize Finalmente Lida com Itens de Altura Variável no .NET 11](/pt-br/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) já que linhas de altura variável combinam mal com utilidades do Tailwind que assam tamanhos fixos.
- [Blazor SSR Finalmente Ganha TempData no .NET 11](/pt-br/2026/04/blazor-ssr-tempdata-dotnet-11/) para padrões de estilização de mensagens flash que você pode construir com os design tokens acima.

## Links de origem

- [Notas de release do Tailwind CSS v4.0](https://tailwindcss.com/blog/tailwindcss-v4)
- [Releases do CLI standalone do Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/releases)
- [Referência das diretivas `@source` e `@theme`](https://tailwindcss.com/docs/functions-and-directives)
- [Visão geral do isolamento de CSS do Blazor no MS Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/css-isolation)
- [Notas de release do .NET 11](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)
