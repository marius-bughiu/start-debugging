---
title: "Стриминг задач с Task.WhenEach в .NET 9"
description: ".NET 9 представляет Task.WhenEach, возвращающий IAsyncEnumerable задач по мере их завершения. Вот как это упрощает обработку параллельных результатов по мере поступления."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-9"
lang: "ru"
translationOf: "2026/01/streaming-tasks-with-net-9-task-wheneach"
translatedBy: "claude"
translationDate: 2026-04-30
---
Обработка нескольких параллельных задач в .NET всегда была немного бинарной. Вы либо ждёте, пока всё закончится (`Task.WhenAll`), либо ждёте первую (`Task.WhenAny`).

Но что, если вы хотите обрабатывать результаты _по мере поступления_?

До .NET 9 приходилось писать сложный цикл с `Task.WhenAny`, удаляющий завершённые задачи из списка и итерирующийся заново. Это было не только многословно, но и имело производительность O(N^2).

## На сцену выходит `Task.WhenEach`

В .NET 9 `Task.WhenEach` решает это нативно. Он возвращает `IAsyncEnumerable`, выдающий задачи по мере их завершения.

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

## Почему это важно

1.  **Опыт пользователя**: в UI-приложениях (MAUI, WPF) вы можете отображать элементы постепенно, вместо показа спиннера, пока весь батч не готов.
2.  **Пропускная способность**: в backend-сервисах вы можете начать обрабатывать первые результаты сразу, поддерживая загрузку CPU, пока ждёте завершения более медленных I/O-операций.
3.  **Простота**: код линейный и читаемый. Больше никаких `while`-циклов или мутаций списков.

Это одно из тех маленьких добавлений API, которые удаляют много "вспомогательного" кода из наших проектов.
