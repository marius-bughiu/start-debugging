---
title: "Blazor static SSR ganha [SupplyParameterFromSession] no .NET 11 Preview 5"
description: "Ler o estado de sessão no Blazor renderizado no servidor estático significava acessar HttpContext.Session e serializar na mão. O .NET 11 Preview 5 adiciona [SupplyParameterFromSession] para vincular uma propriedade de componente diretamente a uma chave de sessão."
pubDate: 2026-06-16
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-16
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), lançado em 2026-06-09, completa a família de atributos "supply parameter from X" que a renderização no servidor estática (static SSR) do Blazor já tinha para query strings e dados de formulário. O novo é `[SupplyParameterFromSession]`, e ele vincula uma propriedade de componente a uma chave na sessão do servidor do ASP.NET Core. Se você já carregou o estado de um assistente de várias etapas através de carregamentos de página de static SSR, sabe por que isso importa.

## Por que a sessão era a incômoda

Static SSR renderiza HTML puro sem circuito SignalR e sem payload de WebAssembly, então não há estado de componente em memória que sobreviva a uma navegação. O Blazor já dava acesso tipado e declarativo às duas entradas por requisição óbvias: `[SupplyParameterFromQuery]` para a URL e `[SupplyParameterFromForm]` para um corpo POST. A sessão era a lacuna. Para lê-la, você passava o `HttpContext` em cascata para o componente e ia por `HttpContext.Session` você mesmo, com strings de chave manuais e serialização manual nos dois lados:

```csharp
@inject IHttpContextAccessor Http

@code {
    private int CurrentStep;

    protected override void OnInitialized()
    {
        var raw = Http.HttpContext?.Session.GetString("checkout-step");
        CurrentStep = raw is null ? 0 : JsonSerializer.Deserialize<int>(raw);
    }
}
```

Cada componente que tocava a sessão repetia essa cerimônia, e a string de chave era um contrato baseado em string esperando para desviar.

## O que o atributo substitui

O Preview 5 reduz a leitura a uma declaração de propriedade. O atributo recebe um `Name` para a chave de sessão e usa `System.Text.Json` para serializar e desserializar o valor, então funciona para qualquer tipo que possa ser convertido para JSON, não apenas strings:

```csharp
@code {
    [SupplyParameterFromSession(Name = "checkout-step")]
    public int CurrentStep { get; set; }
}
```

O framework lê `checkout-step` da sessão, desserializa para `int` e atribui antes de o componente renderizar. Atribuir de volta à propriedade grava o novo valor na sessão, então um assistente pode avançar sua etapa em uma única linha em vez de uma dança de obter, mutar, serializar e atribuir.

A infraestrutura é o middleware de sessão padrão do ASP.NET Core, então você ainda o configura no `Program.cs`:

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();

// ...
app.UseSession();
```

## Onde ele se encaixa

Esta é uma de várias passadas de refinamento de static SSR no Preview 5. Combina naturalmente com a [validação no lado do cliente para formulários static SSR](/pt-br/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/), que chegou na mesma versão: vincule o estado de trabalho do formulário a uma chave de sessão, valide no navegador e mantenha o modo de renderização barato por todo um fluxo de checkout. A ordenação e a paginação do QuickGrid agora também rodam em static SSR, então o padrão de "sensação interativa, zero circuito" continua se ampliando.

Para experimentar, instale o SDK do .NET 11 Preview 5, direcione para `net11.0` e confira as [notas de versão do ASP.NET Core Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md) para a lista completa.
