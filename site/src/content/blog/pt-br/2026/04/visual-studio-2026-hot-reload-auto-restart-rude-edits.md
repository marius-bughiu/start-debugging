---
title: "Hot Reload auto-restart no Visual Studio 2026: rude edits param de matar sua sessão de debug"
description: "Visual Studio 2026 adiciona HotReloadAutoRestart, um opt-in no nível de projeto que reinicia a app quando um rude edit de outra forma terminaria a sessão de debug. Especialmente útil pra projetos Razor e Aspire."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "visual-studio"
  - "hot-reload"
  - "razor"
lang: "pt-br"
translationOf: "2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits"
translatedBy: "claude"
translationDate: 2026-04-24
---

Uma das vitórias mais silenciosas na atualização de março do Visual Studio 2026 é [Hot Reload auto-restart pra rude edits](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload). Um "rude edit" é uma mudança que o engine EnC do Roslyn não consegue aplicar in-process: modificar assinatura de método, renomear uma classe, trocar um tipo base. Até agora a única resposta honesta era parar o debugger, rebuildar e attachar de novo. Em projetos .NET 10 com Visual Studio 2026 você pode optar por um default muito melhor: a IDE reinicia o processo pra você e mantém a sessão de debug andando.

## Opt-in com uma única property

A feature é gatada numa property MSBuild de nível de projeto, o que significa que dá pra ligar seletivamente pros projetos onde um restart de processo é barato, tipo APIs ASP.NET Core, apps Blazor Server, ou orquestrações Aspire, e deixar desligado pra hosts desktop pesados.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Dá pra içar num `Directory.Build.props` pra uma solution inteira optar de uma vez:

```xml
<Project>
  <PropertyGroup>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Quando a property está setada, rude edits disparam um rebuild focado do projeto mudado e seus dependentes, um novo processo é lançado, e o debugger reattacha. Os projetos não reiniciados continuam rodando, o que importa muito no Aspire: seu contêiner Postgres e seu worker service não precisam quicar só porque você renomeou um método de controller.

## Razor finalmente parece rápido

A segunda metade da atualização é o compilador Razor. Em versões anteriores, o build do Razor vivia num processo separado e um Hot Reload num arquivo `.razor` podia levar dezenas de segundos enquanto o compilador subia a frio. No Visual Studio 2026 o compilador Razor é co-hospedado dentro do processo Roslyn, então editar um arquivo `.razor` durante o Hot Reload é efetivamente grátis.

Um exemplo pequeno pra ilustrar o que agora sobrevive ao Hot Reload sem um restart completo:

```razor
@page "/counter"
@rendermode InteractiveServer

<h1>Counter: @count</h1>
<button @onclick="Increment">+1</button>

@code {
    private int count;

    private void Increment() => count++;
}
```

Mudar o texto do `<h1>`, ajustar o lambda, ou adicionar um segundo botão continua funcionando com Hot Reload. Se agora você refatorar `Increment` pra um `async Task IncrementAsync()` (um rude edit porque a assinatura mudou), o auto-restart entra em ação, o processo quica, e você volta em `/counter` sem tocar a toolbar do debugger.

## Ao que ficar atento

O auto-restart não preserva state in-process. Se seu loop de debugging depende de um cache quente, uma sessão autenticada, ou uma conexão SignalR, você vai perdê-lo no restart. Duas mitigações práticas:

1. Mova warmup caro pra implementações de `IHostedService` que sejam baratas de re-executar, ou respalde com cache compartilhado.
2. Use um [handler de Hot Reload custom](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) via `MetadataUpdateHandlerAttribute` pra limpar e re-semear caches quando um update é aplicado.

```csharp
[assembly: MetadataUpdateHandler(typeof(MyApp.CacheResetHandler))]

namespace MyApp;

internal static class CacheResetHandler
{
    public static void UpdateApplication(Type[]? updatedTypes)
    {
        AppCache.Clear();
        AppCache.Warm();
    }
}
```

Pra times de Blazor e Aspire o efeito combinado é o maior salto de quality-of-life do Hot Reload desde que a feature saiu. Uma property MSBuild, um compilador co-hospedado, e o ritual "parar, rebuildar, re-attachar" que engolia cinco minutos uma dúzia de vezes por dia finalmente vai embora.
