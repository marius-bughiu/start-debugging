---
title: "Fix: RZ10012: Found markup element with unexpected name no Blazor"
description: "O compilador Razor do Blazor emite RZ10012 quando uma tag em PascalCase não tem um tipo de componente correspondente no escopo. Adicione @using para o namespace do componente em _Imports.razor, ou @namespace no componente, e recompile."
pubDate: 2026-05-12
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "razor"
lang: "pt-br"
translationOf: "2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor"
translatedBy: "claude"
translationDate: 2026-05-12
---

A correção: o compilador Razor viu uma tag em PascalCase (por exemplo `<NavMenu />` ou `<MudButton />`) e não conseguiu vinculá-la a um tipo de componente no escopo daquele arquivo. Adicione `@using <namespace>` ao arquivo `.razor` pai ou a um `_Imports.razor` que o cubra, e recompile. Se o componente vive em uma Razor Class Library (RCL) cuja estrutura de pastas não corresponde ao seu namespace, adicione também `@namespace <FullNamespace>` ao arquivo `.razor` do componente. Apague `bin/`, `obj/` e `.vs/` se o aviso persistir na IDE depois de uma compilação limpa.

```text
RZ10012: Found markup element with unexpected name 'NavMenu'.
If this is intended to be a component, add a @using directive for its namespace.
```

Este guia foi escrito contra .NET 11 preview 4, o Razor SDK incluído em `Microsoft.AspNetCore.App` 11.0.0-preview.4 e Visual Studio 17.13. O ID de diagnóstico `RZ10012` e o texto exato têm sido estáveis desde .NET Core 3.1, então as correções abaixo aplicam sem alterações em .NET 6, 7, 8, 10 e 11. Blazor Server, Blazor WebAssembly, Blazor United e Razor Class Libraries emitem todas o mesmo diagnóstico no mesmo passo do compilador.

RZ10012 é um **aviso do compilador** por padrão, não um erro. O projeto continua compilando. Se a tag realmente é para ser um componente e você fizer deploy sem corrigir, em runtime a tag é renderizada como **HTML literal** (um elemento `<NavMenu></NavMenu>` sem filhos), os handlers de clique nunca são conectados e os parâmetros desaparecem silenciosamente. Por isso o restante deste post trata isso como um erro que vale a pena bloquear no build.

## Por que o compilador Razor acha que sua tag é "unexpected"

O compilador Razor classifica cada elemento em um arquivo `.razor` usando uma regra: uma tag cujo nome começa com uma **letra ASCII maiúscula** é uma referência a um componente; qualquer outra coisa é HTML. Quando ele vê `<NavMenu />`, percorre a tabela de **tag helper descriptors** do arquivo atual, procurando um tipo de componente cujo nome curto bate e cujo namespace foi importado por uma diretiva `@using` que se aplica a esse arquivo.

Se nenhum descritor bate, o compilador tem duas escolhas: assumir HTML e emitir um aviso para um humano corrigir o rumo, ou falhar o build. Os designers escolheram a primeira, por isso RZ10012 é um aviso. A tabela de descritores é populada a partir de três fontes, nesta ordem:

1. **Diretivas `@using` no próprio arquivo.** Escopo léxico, somente o arquivo que as declara.
2. **Arquivos `_Imports.razor`**, aplicados **de baixo para cima por pasta**. O `_Imports.razor` ao lado do arquivo se aplica primeiro, depois o da pasta pai, e assim por diante até a raiz do projeto.
3. **Imports a nível de projeto** que o SDK injeta: `Microsoft.AspNetCore.Components`, `Microsoft.AspNetCore.Components.Web` e alguns outros. É por isso que você não precisa importar `<EditForm>` manualmente.

Note que `_Imports.razor` **não é transitivo entre projetos**. Um `_Imports.razor` dentro de uma Razor Class Library não flui para a aplicação que a consome. O `_Imports.razor` do consumidor (ou a própria página) precisa declarar `@using MyRcl` para que `<MyRclComponent />` se vincule.

## O arquivo mínimo que reproduz isso

A menor reprodução são dois arquivos no mesmo projeto:

```razor
@* .NET 11 preview 4, Razor SDK 11.0.0-preview.4 *@
@* File: Components/Pages/Home.razor *@

<h1>Home</h1>
<NavMenu />
```

```razor
@* File: Components/Layout/NavMenu.razor *@

<nav>Navigation here</nav>
```

`NavMenu` vive em `MyApp.Components.Layout`. `Home.razor` vive em `MyApp.Components.Pages`. Nenhum arquivo tem um `@using` para `MyApp.Components.Layout`, e não existe um `_Imports.razor` que faça a ponte entre eles. Build:

```text
Components\Pages\Home.razor(3,2): warning RZ10012: Found markup element with unexpected name 'NavMenu'. If this is intended to be a component, add a @using directive for its namespace.
```

Em runtime, a página renderiza `<navmenu></navmenu>` como uma tag HTML literal.

## As quatro correções, ordenadas

Aplique-as nesta ordem. Pare na primeira que resolver seu caso.

### 1. Adicione `@using` ao `_Imports.razor` mais próximo

Esta é a correção canônica e a que o próprio texto do aviso aponta. Solte uma única linha no `_Imports.razor` que cobre sua árvore de componentes:

```razor
@* File: Components/_Imports.razor *@
@using MyApp.Components.Layout
@using MyApp.Components.Shared
```

Se `_Imports.razor` ainda não existe para a pasta, crie um. O template padrão de `dotnet new blazor` coloca um em `Components/_Imports.razor` com os usings comuns já conectados.

Isso funciona porque o Razor SDK alimenta o compilador com cada `_Imports.razor` entre a raiz do projeto e o arquivo atual, como se suas diretivas aparecessem no topo do arquivo atual. Adicionar um using aqui se propaga para todo `.razor` em ou abaixo daquela pasta, incluindo layouts, páginas e parciais.

### 2. Adicione `@using` diretamente ao arquivo `.razor` consumidor

Quando o componente é referenciado por exatamente um arquivo e você quer manter a poluição de namespace contida, declare o using inline:

```razor
@* File: Components/Pages/Home.razor *@
@using MyApp.Components.Layout

<h1>Home</h1>
<NavMenu />
```

Mecanicamente idêntico à correção 1, apenas mais restrito em escopo. Útil quando duas pastas definem componentes com o mesmo nome curto e você só quer desambiguação em um lugar.

### 3. Adicione `@namespace` ao componente (cenário Razor Class Library)

Quando o componente vive em uma RCL, o namespace auto-gerado é derivado de `RootNamespace` mais o caminho do arquivo relativo ao arquivo de projeto da RCL. Se o `RootNamespace` da RCL não bate com o namespace real dela, ou o arquivo vive sob um nome de pasta que o compilador C# não aceita literalmente (números, hífens), o namespace gerado não vai bater com o que o consumidor importa. Adicione `@namespace` para corrigir a discrepância na origem:

```razor
@* File: src/MyRcl/Components/Button.razor *@
@namespace MyRcl.Components

<button class="my-rcl-button" @onclick="OnClick">@ChildContent</button>

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    [Parameter] public EventCallback OnClick { get; set; }
}
```

Agora o consumidor pode `@using MyRcl.Components` e obter uma vinculação limpa. Sem `@namespace`, o Razor geraria `MyRcl.src.MyRcl.Components` ou `Some.RootNamespace.src.MyRcl.Components` dependendo de como a RCL está organizada, e seu `@using` silenciosamente falharia em encontrar o tipo.

Você também pode definir `RootNamespace` no `.csproj` da RCL para pular completamente a nomenclatura baseada em pastas:

```xml
<!-- src/MyRcl/MyRcl.csproj -->
<PropertyGroup>
  <RootNamespace>MyRcl</RootNamespace>
</PropertyGroup>
```

### 4. Limpe o cache da IDE quando o aviso persiste após um build limpo

O serviço de linguagem Razor no Visual Studio cacheia os descritores de tag helper por projeto. Depois que uma referência de projeto é adicionada ou um namespace renomeado, o cache pode continuar reportando RZ10012 mesmo que `dotnet build` a partir de um `obj/` fresco esteja limpo. O reset confiável:

```powershell
# Close Visual Studio first, then from the solution root:
Remove-Item -Recurse -Force .vs, **/bin, **/obj
dotnet build
```

Reabra a solução. O primeiro build de IntelliSense vai reidratar o cache de descritores com o estado pós-correção. Se você está no JetBrains Rider, o equivalente é **File > Invalidate Caches**.

## Faça o aviso falhar o build

A severidade padrão entrega builds que renderizam páginas quebradas. Duas formas de elevá-la:

**Direcionada (recomendada):** trate apenas RZ10012 como erro.

```xml
<!-- MyApp.csproj, .NET 11 preview 4 -->
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);RZ10012</WarningsAsErrors>
</PropertyGroup>
```

O prefixo `$(WarningsAsErrors);` preserva o que quer que o SDK já tenha promovido, o que importa porque SDKs mais novos do .NET adicionam a essa lista ao longo do tempo.

**Geral:** trate todos os avisos como erros. Disciplina mais saudável no geral, mas força você a perseguir cada outro aviso que o SDK já emitiu, o que é mais limpeza do que a maioria dos times quer para uma única correção.

```xml
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

De qualquer forma, um `@using` faltante agora interrompe o build em vez de vazar para QA como um ticket de "o botão não faz nada".

## Variantes comuns que aterrissam aqui por engano

**Nome de tag em minúsculo.** `<navMenu />` não dispara RZ10012, porque a primeira letra é minúscula e o Razor classifica como HTML. Se seu componente renderiza como marcação literal e **não** existe aviso, você tem um bug de capitalização, não de namespace. Renomeie a tag para PascalCase.

**`@inherits` mascarando o componente.** Em .NET 7.0.302 e anteriores existe um problema conhecido ([dotnet/razor#8800](https://github.com/dotnet/razor/issues/8800)) onde adicionar `@inherits MyBase` a um componente fazia o compilador perder a noção de que era componente e emitir RZ10012 onde quer que fosse usado. Corrigido em .NET 8. Se você ainda está em .NET 7 e não pode atualizar, contorne herdando em `@code { protected partial class ... }` em vez da diretiva.

**Biblioteca de componentes de terceiros não registrada.** Quando usa MudBlazor, Radzen, Telerik ou Syncfusion, a biblioteca traz um snippet de `_Imports.razor` que você precisa colar no seu. Não fazer isso significa que cada `<MudButton />` acende com RZ10012. A página "getting started" do fornecedor tem a lista exata (MudBlazor precisa de `@using MudBlazor`, Radzen precisa de `@using Radzen` e `@using Radzen.Blazor`, etc.).

**Componente genérico com parâmetro de tipo.** `<MyList T="string" />` continua avisando se `MyList<T>` não está no escopo. O atributo `T="..."` não importa um namespace; a regra do `@using` aplica do mesmo jeito.

**Falso positivo do editor no VS 17.4.x.** [dotnet/razor#8146](https://github.com/dotnet/razor/issues/8146) acompanha uma série de falsos positivos em lançamentos iniciais do VS 2022. Se o build está limpo e somente a IDE marca RZ10012, atualize o VS para 17.6 ou superior e limpe `.vs/` como na correção 4.

**Componente em um projeto referenciado mirando outro framework.** Uma Razor Class Library mirando `net6.0` consumida por uma aplicação `net11.0` pode falhar em expor seus componentes se a RCL não tem `<UseRazorSourceGenerator>true</UseRazorSourceGenerator>` ou tem uma referência ao SDK desatualizada. Atualize o `<PackageReference>` da RCL para `Microsoft.AspNetCore.App` 11 e recompile.

## Uma checklist de 30 segundos

Quando RZ10012 aterrissa no CI e você tem um voo para pegar, percorra esta lista de cima para baixo:

1. A tag está em PascalCase? Se minúscula, renomeie.
2. O componente está **neste** projeto? Se sim, `@using` o namespace dele no `_Imports.razor` mais próximo.
3. O componente está em uma RCL? Verifique que a RCL tem `@namespace` batendo com o que você importa, e que o consumidor referencia o pacote ou projeto da RCL.
4. Biblioteca de terceiros? Cole o snippet do fornecedor em `_Imports.razor`.
5. Ainda avisa após um build limpo? Apague `.vs/`, `bin/`, `obj/` e recompile.
6. Quer que isso falhe o CI? Adicione `RZ10012` a `<WarningsAsErrors>`.

Noventa por cento dos casos é passo 2 ou passo 4. O resto é encanamento de namespace.

## Relacionados

- [Fix: The type or namespace name could not be found after a project reference](/pt-br/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) cobre o lado C# da mesma família de falhas de resolução de namespace.
- [Como compartilhar lógica de validação entre servidor e Blazor WebAssembly](/pt-br/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) percorre o tipo de layout multi-projeto onde RZ10012 morde mais.
- [Como usar Tailwind CSS com Blazor WebAssembly no .NET 11](/pt-br/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) mostra um layout de projeto Blazor limpo que você pode comparar.
- [Como adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) é a contraparte em runtime para capturar os bugs de "tag renderizada como HTML literal" que RZ10012 teria prevenido.

## Fontes

- [dotnet/aspnetcore#45427: Referenced Razor Class Library component reporting error RZ10012](https://github.com/dotnet/aspnetcore/issues/45427)
- [dotnet/razor#8800: `@inherits` breaks component recognition](https://github.com/dotnet/razor/issues/8800)
- [dotnet/razor#8146: Unusable Blazor analyzers blinking invalid RZ10012 warnings in VS 17.4.x](https://github.com/dotnet/razor/issues/8146)
- [Microsoft Learn: ASP.NET Core Blazor namespaces](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-9.0#namespaces)
- [Jonathan Crozier: Treat Blazor component warnings as errors](https://jonathancrozier.com/blog/treat-blazor-component-warnings-as-errors-found-markup-element-with-unexpected-name)
