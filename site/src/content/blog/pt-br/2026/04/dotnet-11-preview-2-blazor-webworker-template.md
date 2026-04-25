---
title: "dotnet new webworker: Web Workers de primeira classe para Blazor no .NET 11 Preview 2"
description: "Um novo template de projeto no .NET 11 Preview 2 gera o encanamento JS, o WebWorkerClient e o boilerplate de JSExport necessários para rodar código .NET em um Web Worker do navegador."
pubDate: 2026-04-05
tags:
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "aspnet-core"
lang: "pt-br"
translationOf: "2026/04/dotnet-11-preview-2-blazor-webworker-template"
translatedBy: "claude"
translationDate: 2026-04-25
---

Rodar trabalho pesado de CPU no Blazor WebAssembly sempre teve o mesmo efeito colateral desagradável: a thread de UI trava, as animações engasgam, e o usuário suspeita que o navegador travou. No [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) a equipe entregou uma correção adequada para esse problema na forma de um template de projeto novinho, `dotnet new webworker`, que gera cada peça do encanamento que você antes tinha que fazer à mão.

## O que o template realmente te dá

O template produz uma biblioteca de classes Razor mirando `net11.0` que contém:

1. O bootstrapper JavaScript que inicia um Web Worker dedicado e arranca o runtime .NET dentro dele.
2. Um tipo C# `WebWorkerClient` que esconde a camada de interop de `postMessage`.
3. Um método `[JSExport]` de exemplo que você pode chamar de qualquer componente.

O detalhe importante é que nada disso depende do próprio Blazor. O template funciona para apps `wasmbrowser` standalone, frontends JS customizados, e Blazor WebAssembly igualmente. Você o liga com uma única chamada:

```bash
dotnet new blazorwasm -n SampleApp
dotnet new webworker -n WebWorker
dotnet sln SampleApp.sln add WebWorker/WebWorker.csproj
dotnet add SampleApp/SampleApp.csproj reference WebWorker/WebWorker.csproj
```

## Definindo um método worker

Métodos worker são métodos estáticos comuns decorados com `[JSExport]`. O runtime dentro do worker os vê pelo seu nome totalmente qualificado.

```csharp
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace WebWorker;

public static partial class PrimesWorker
{
    [JSExport]
    public static string ComputePrimes(int limit)
    {
        var primes = new List<int>();
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) primes.Add(n);
        }

        return JsonSerializer.Serialize(new { Count = primes.Count, Last = primes[^1] });
    }
}
```

Métodos `[JSExport]` ainda estão limitados a primitivos e strings como tipos de retorno, então qualquer coisa não trivial precisa de um round-trip JSON. O `WebWorkerClient` desserializa o resultado automaticamente pra você do outro lado.

## Chamando de um componente Blazor

Esta é a parte que costumava ser 200 linhas de interop. No .NET 11 são três:

```razor
@inject IJSRuntime JS

<button @onclick="Run">Find primes</button>
<p>@status</p>

@code {
    string status = "";

    async Task Run()
    {
        await using var worker = await WebWorkerClient.CreateAsync(JS);
        var result = await worker.InvokeAsync<PrimeResult>(
            "WebWorker.PrimesWorker.ComputePrimes",
            args: new object[] { 2_000_000 });

        status = $"Found {result.Count}, last was {result.Last}";
    }

    record PrimeResult(int Count, int Last);
}
```

`WebWorkerClient.CreateAsync` inicia o worker, espera o runtime .NET dentro dele estar pronto, e retorna um cliente que você invoca pelo nome de método totalmente qualificado. A thread principal nunca bloqueia, então suas chamadas a `StateHasChanged` mantêm a UI fluida enquanto dois milhões de números são fatorados em uma thread de SO em segundo plano.

## Por que isso importa

Antes do .NET 11 a comunidade Blazor dependia de pacotes de terceiros como [Tewr/BlazorWorker](https://github.com/Tewr/BlazorWorker) ou criava uma ponte `JSImport`/`JSExport` sob medida toda vez. O novo template remove essa classe de boilerplate inteiramente, é entregue como o caminho abençoado da Microsoft, e se compõe com os geradores de fonte JSImport/JSExport existentes. Se você estava adiando trabalho em segundo plano no Blazor porque o custo do encanamento era alto demais, Preview 2 é o release que torna esse custo zero. As notas de release completas estão no [anúncio do .NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) e nos [docs atualizados de .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0).
