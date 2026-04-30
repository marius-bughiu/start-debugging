---
title: "Streaming de tarefas com Task.WhenEach do .NET 9"
description: "O .NET 9 introduz Task.WhenEach, que retorna um IAsyncEnumerable de tarefas conforme elas completam. Aqui está como ele simplifica o processamento de resultados paralelos conforme chegam."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/streaming-tasks-with-net-9-task-wheneach"
translatedBy: "claude"
translationDate: 2026-04-30
---
Lidar com várias tarefas paralelas sempre foi meio binário no .NET. Você ou espera tudo terminar (`Task.WhenAll`) ou espera a primeira (`Task.WhenAny`).

Mas e se você quer processar resultados _conforme eles chegam_?

Antes do .NET 9, você tinha que escrever um loop complexo envolvendo `Task.WhenAny`, removendo tarefas terminadas de uma lista e iterando de novo. Isso não só era verboso como tinha características de desempenho O(N^2).

## Entra `Task.WhenEach`

No .NET 9, `Task.WhenEach` resolve isso nativamente. Ele retorna um `IAsyncEnumerable` que entrega tarefas conforme elas completam.

```cs
using System.Threading.Tasks;

public async Task ProcessImagesAsync(List<string> urls)
{
    // Start all downloads in parallel
    List<Task<byte[]>> downloadTasks = urls.Select(DownloadAsync).ToList();

    // Process them one by one, as soon as they finish
    await foreach (var completedTask in Task.WhenEach(downloadTasks))
    {
        try 
        {
            byte[] image = await completedTask;
            Console.WriteLine($"Processed image: {image.Length} bytes");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"One download failed: {ex.Message}");
        }
    }
}
```

## Por que isso importa

1.  **Experiência do usuário**: em apps de UI (MAUI, WPF), você pode renderizar itens progressivamente em vez de mostrar um spinner até o batch inteiro acabar.
2.  **Throughput**: em serviços de backend, você pode começar a processar os primeiros resultados imediatamente, mantendo a CPU alimentada enquanto espera operações de I/O mais lentas terminarem.
3.  **Simplicidade**: o código é linear e legível. Sem mais loops `while` ou mutações de lista.

Essa é uma daquelas pequenas adições de API que apagam um monte de código "utilitário" dos nossos projetos.
