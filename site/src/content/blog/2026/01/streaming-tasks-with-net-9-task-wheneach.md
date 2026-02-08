---
title: "Streaming Tasks with .NET 9 Task.WhenEach"
description: ".NET 9 introduces Task.WhenEach, which returns an IAsyncEnumerable of tasks as they complete. Here is how it simplifies processing parallel results as they arrive."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-9"
---
Handling multiple parallel tasks has always been a bit binary in .NET. You either wait for everything to finish (`Task.WhenAll`) or you wait for the first one (`Task.WhenAny`).

But what if you want to process results _as they arrive_?

Before .NET 9, you had to write a complex loop involving `Task.WhenAny`, removing finished tasks from a list, and looping again. This was not only verbose but had O(N^2) performance characteristics.

## Enter `Task.WhenEach`

In .NET 9, `Task.WhenEach` solves this natively. It returns an `IAsyncEnumerable` that yields tasks as they complete.

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

## Why This Matters

1.  **User Experience**: In UI apps (MAUI, WPF), you can render items progressively instead of showing a spinner until the entire batch is done.
2.  **Throughput**: In backend services, you can start processing the first results immediately, keeping the CPU fed while waiting for slower I/O operations to finish.
3.  **Simplicity**: The code is linear and readable. No more `while` loops or list mutations.

This is one of those small API additions that deletes a lot of “utility” code from our projects.
