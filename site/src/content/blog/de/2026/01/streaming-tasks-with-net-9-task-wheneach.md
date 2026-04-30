---
title: "Tasks streamen mit Task.WhenEach in .NET 9"
description: ".NET 9 führt Task.WhenEach ein, das ein IAsyncEnumerable von Tasks zurückgibt, sobald sie abgeschlossen sind. Hier sehen Sie, wie es die Verarbeitung paralleler Ergebnisse vereinfacht, sobald sie eintreffen."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/streaming-tasks-with-net-9-task-wheneach"
translatedBy: "claude"
translationDate: 2026-04-30
---
Mit mehreren parallelen Tasks umzugehen war in .NET schon immer etwas binär. Sie warten entweder, bis alles fertig ist (`Task.WhenAll`), oder Sie warten auf den ersten (`Task.WhenAny`).

Aber was, wenn Sie Ergebnisse verarbeiten wollen, _sobald sie eintreffen_?

Vor .NET 9 mussten Sie eine komplexe Schleife schreiben, die `Task.WhenAny` einbezog, fertige Tasks aus einer Liste entfernte und erneut iterierte. Das war nicht nur ausschweifend, sondern hatte auch O(N^2) Leistungseigenschaften.

## Auftritt `Task.WhenEach`

In .NET 9 löst `Task.WhenEach` das nativ. Es gibt ein `IAsyncEnumerable` zurück, das Tasks ausliefert, sobald sie abgeschlossen sind.

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

## Warum das wichtig ist

1.  **Nutzererlebnis**: In UI-Apps (MAUI, WPF) können Sie Items progressiv rendern, statt einen Spinner anzuzeigen, bis der gesamte Batch fertig ist.
2.  **Durchsatz**: In Backend-Diensten können Sie sofort mit der Verarbeitung der ersten Ergebnisse beginnen und die CPU beschäftigt halten, während Sie auf langsamere I/O-Operationen warten.
3.  **Einfachheit**: Der Code ist linear und gut lesbar. Keine `while`-Schleifen oder Listenmutationen mehr.

Das ist eine dieser kleinen API-Ergänzungen, die viel "Utility"-Code aus unseren Projekten löschen.
