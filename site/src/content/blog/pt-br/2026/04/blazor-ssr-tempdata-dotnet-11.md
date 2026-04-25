---
title: "Blazor SSR finalmente ganha TempData no .NET 11"
description: "ASP.NET Core no .NET 11 Preview 2 traz TempData para a renderização estática do lado servidor do Blazor, habilitando mensagens flash e fluxos Post-Redirect-Get sem workarounds."
pubDate: 2026-04-13
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "ssr"
lang: "pt-br"
translationOf: "2026/04/blazor-ssr-tempdata-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Se você construiu aplicações Blazor SSR estáticas, quase certamente bateu na mesma parede: depois de um POST de formulário que redireciona, não há jeito embutido de passar uma mensagem única para a próxima página. MVC e Razor Pages tiveram `TempData` por mais de uma década. Blazor SSR não, até o [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/).

## Como o TempData funciona no Blazor SSR

Quando você chama `AddRazorComponents()` no seu `Program.cs`, TempData é registrado automaticamente. Sem fiação de serviço extra. Dentro de qualquer componente SSR estático, capture-o como um parâmetro em cascata:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private void HandleSubmit()
    {
        // Store a flash message before redirecting
        TempData?.Set("StatusMessage", "Record saved.");
        Navigation.NavigateTo("/dashboard", forceLoad: true);
    }
}
```

Na página de destino, leia o valor. Uma vez que você chama `Get`, a entrada é removida do armazenamento:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private string? StatusMessage;

    protected override void OnInitialized()
    {
        StatusMessage = TempData?.Get<string>("StatusMessage");
    }
}
```

Esse é o padrão clássico Post-Redirect-Get, e agora funciona no Blazor SSR sem gerenciamento de estado personalizado.

## Peek e Keep

`ITempData` fornece quatro métodos que espelham o ciclo de vida do TempData do MVC:

- `Get<T>(key)` lê o valor e o marca para exclusão.
- `Peek<T>(key)` lê sem marcar, então o valor sobrevive até a próxima requisição.
- `Keep()` retém todos os valores.
- `Keep(key)` retém um valor específico.

Estes te dão controle sobre se uma mensagem flash desaparece depois de uma leitura ou permanece para um segundo redirecionamento.

## Provedores de armazenamento

Por padrão, o TempData é baseado em cookie via `CookieTempDataProvider`. Os valores são criptografados com o ASP.NET Core Data Protection, então você ganha proteção contra adulteração de saída. Se você preferir armazenamento do lado do servidor, troque para `SessionStorageTempDataProvider`:

```csharp
builder.Services.AddSession();
builder.Services
    .AddSingleton<ITempDataProvider, SessionStorageTempDataProvider>();
```

## A pegadinha: só SSR estático

TempData não funciona com os modos de renderização Blazor Server interativo ou Blazor WebAssembly. Está limitado a SSR estático, onde cada navegação é uma requisição HTTP completa. Para cenários interativos, `PersistentComponentState` ou seu próprio estado em cascata continuam sendo as ferramentas certas.

Essa é uma pequena adição, mas remove uma das reclamações comuns "por que o Blazor não pode fazer o que Razor Pages pode?". Pegue [.NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0) e experimente no seu próximo fluxo de formulário SSR.
