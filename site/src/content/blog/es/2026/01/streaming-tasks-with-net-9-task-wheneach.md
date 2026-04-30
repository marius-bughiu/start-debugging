---
title: "Streaming de tareas con Task.WhenEach de .NET 9"
description: ".NET 9 introduce Task.WhenEach, que devuelve un IAsyncEnumerable de tareas a medida que se completan. Aquí está cómo simplifica el procesamiento de resultados paralelos a medida que llegan."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/streaming-tasks-with-net-9-task-wheneach"
translatedBy: "claude"
translationDate: 2026-04-30
---
Manejar múltiples tareas paralelas siempre ha sido un poco binario en .NET. O esperas a que todo termine (`Task.WhenAll`) o esperas la primera (`Task.WhenAny`).

Pero ¿qué pasa si quieres procesar resultados _a medida que llegan_?

Antes de .NET 9, tenías que escribir un loop complejo involucrando `Task.WhenAny`, removiendo tareas terminadas de una lista y volviendo a iterar. Esto no solo era verboso sino que tenía características de rendimiento O(N^2).

## Aquí entra `Task.WhenEach`

En .NET 9, `Task.WhenEach` resuelve esto de forma nativa. Devuelve un `IAsyncEnumerable` que produce tareas a medida que se completan.

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

## Por qué esto importa

1.  **Experiencia de usuario**: en apps de UI (MAUI, WPF), puedes renderizar items progresivamente en lugar de mostrar un spinner hasta que todo el batch esté listo.
2.  **Throughput**: en servicios de backend, puedes empezar a procesar los primeros resultados de inmediato, manteniendo la CPU alimentada mientras esperas a que terminen operaciones de I/O más lentas.
3.  **Simplicidad**: el código es lineal y legible. No más loops `while` ni mutaciones de listas.

Esta es una de esas pequeñas adiciones de API que borra mucho código "utilitario" de nuestros proyectos.
