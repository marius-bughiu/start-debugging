---
title: "Ignite UI for Blazor passa para MIT: mais de 50 componentes gratuitos no IgniteUI.Blazor.Lite 1.0.0"
description: "A Infragistics abriu o código de mais de 50 controles do Ignite UI for Blazor sob MIT, lançados como IgniteUI.Blazor.Lite e IgniteUI.Blazor.GridLite 1.0.0 para net8.0, net9.0 e net10.0. Veja o que é gratuito, como configurar e as armadilhas."
pubDate: 2026-10-28
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
lang: "pt-br"
translationOf: "2026/10/ignite-ui-for-blazor-goes-mit-50-free-components-in-igniteui-blazor-lite"
translatedBy: "claude"
translationDate: 2026-10-28
---

Em 27 de outubro de 2026, a equipe do ASP.NET [anunciou](https://devblogs.microsoft.com/dotnet/blazor-welcomes-infragistics/) que a Infragistics agora é contribuidora do Blazor, e o destaque para a maioria de nós é a licença: mais de 50 controles do Ignite UI for Blazor agora são MIT, gratuitos para uso comercial, com o código-fonte no [GitHub](https://github.com/IgniteUI/igniteui-blazor). Não é uma camada de avaliação. É um subconjunto permanente da suíte comercial.

## O que é realmente gratuito

Dois pacotes, ambos na versão 1.0.0 no NuGet e ambos com destino a `net8.0`, `net9.0` e `net10.0`:

- `IgniteUI.Blazor.Lite`: controles de entrada, navegação e layout. Combo, Date Picker, Date Range Picker, Tree, Stepper, Tile Manager, Splitter, Dialog, Tabs, Calendar, Mask Input, Slider, Rating, Chat (preview) e cerca de 40 outros.
- `IgniteUI.Blazor.GridLite`: uma grade de dados leve com filtro de colunas e templates de célula personalizados.

O Grid completo, Tree Grid, Pivot Grid, Hierarchical Grid e Dock Manager continuam comerciais no pacote `IgniteUI.Blazor`. Se você precisa de agrupamento, edição ou exportação para Excel, o Grid Lite não é essa grade.

## Configurando em um Blazor Web App

```bash
dotnet add package IgniteUI.Blazor.Lite --version 1.0.0
```

Registre os serviços em `Program.cs` e importe o namespace em `_Imports.razor`:

```csharp
builder.Services.AddIgniteUIBlazor();
```

```razor
@using IgniteUI.Blazor.Controls
```

Depois adicione um tema em `Components/App.razor` (ou `wwwroot/index.html` para WebAssembly standalone):

```html
<link href="_content/IgniteUI.Blazor/themes/light/bootstrap.css" rel="stylesheet" />
```

Atenção ao caminho: é `_content/IgniteUI.Blazor/`, não `_content/IgniteUI.Blazor.Lite/`. Verifiquei o pacote 1.0.0 e o `BasePath` dos seus static web assets está definido como `_content/IgniteUI.Blazor`, então os pacotes Lite e comercial compartilham as mesmas URLs de assets. Se você chutar o caminho "óbvio", ficará com componentes sem estilo e um 404 na aba de rede. Os temas vêm em `bootstrap`, `fluent`, `indigo` e `material`, cada um em `light` e `dark`.

Nenhuma tag `<script>` é necessária. Um inicializador JavaScript carrega os web components quando o Blazor inicia.

## Um Combo com vinculação de dados real

`IgbCombo` é genérico sobre `TValue` e `TItem`, e `Value` é sempre um `TValue[]`, mesmo com `SingleSelect`. Isso confunde muita gente na primeira vez:

```razor
@rendermode InteractiveServer

<IgbCombo TItem="City" TValue="int"
          Data="cities"
          ValueKey="Id"
          DisplayKey="Name"
          Label="Destination"
          SingleSelect="true"
          @bind-Value="selected" />

<p>Selected id: @(selected.FirstOrDefault())</p>

@code {
    record City(int Id, string Name);

    City[] cities = [new(1, "Bucharest"), new(2, "Cluj"), new(3, "Iasi")];
    int[] selected = [];
}
```

A linha `@rendermode` importa. Os componentes são construídos sobre interop com JavaScript, então exigem `InteractiveServer`, `InteractiveWebAssembly` ou `InteractiveAuto`. SSR estático não é suportado, e uma página sem modo de renderização apenas renderiza markup inerte.

## A parte que chega no .NET 11

Engenheiros da Infragistics também contribuíram com dois analisadores de Blazor, mesclados para o .NET 11 em [dotnet/aspnetcore#67176](https://github.com/dotnet/aspnetcore/pull/67176) e [#67383](https://github.com/dotnet/aspnetcore/pull/67383). O primeiro sinaliza chamadas a `StateHasChanged()` que o `ComponentBase` já torna redundantes, como uma chamada logo antes do primeiro `await` em `OnInitializedAsync`, e traz uma correção de código que as remove. O segundo avisa quando uma classe chama `GetAuthenticationStateAsync()` sem assinar `AuthenticationStateChanged`, que é como você acaba com um usuário em cache desatualizado.

Também há uma skill `use-igniteui-blazor` em [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-blazor/skills/use-igniteui-blazor) para agentes de código, além de um scaffolder ainda em revisão em [dotnet/Scaffolding#3823](https://github.com/dotnet/Scaffolding/pull/3823).

Para equipes que descartaram fornecedores de componentes por causa do licenciamento por usuário, um Combo, Date Range Picker e Tree gratuitos sob MIT, que passam pelo critério de trimming e acessibilidade da equipe do Blazor, merecem um spike esta semana.
