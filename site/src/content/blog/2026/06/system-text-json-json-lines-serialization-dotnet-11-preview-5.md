---
title: "System.Text.Json Finally Writes JSON Lines in .NET 11 Preview 5"
description: ".NET 11 Preview 5 adds JsonSerializer.SerializeAsyncEnumerable with topLevelValues: true, so System.Text.Json can now stream JSONL out, not just read it."
pubDate: 2026-06-10
tags:
  - "dotnet-11"
  - "csharp"
  - "system-text-json"
  - "serialization"
---

The [.NET 11 Preview 5 library notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) close a gap that has been open since .NET 9: `System.Text.Json` can now serialize JSON Lines, not just deserialize it. The read side landed two versions ago, the write side was missing, and anyone exporting JSONL had to hand-roll a loop that wrote one document per line. Preview 5 makes it a single call.

## What JSON Lines Actually Is

JSON Lines (JSONL) is not a JSON array. It is one independent JSON value per line, separated by `\n`, with no enclosing brackets and no commas between records:

```
{"Device":"kitchen","Celsius":21.4}
{"Device":"garage","Celsius":8.1}
```

That shape is everywhere once you start streaming data: structured log files, large database exports, and the batch input/output formats used by LLM training and eval pipelines. The win is that you can append a record without rewriting the file, and you can process the file one line at a time without ever holding the whole thing in memory. A top-level JSON array gives you none of that, because a parser cannot know the array is valid until it sees the closing `]`.

## The Write Side That Was Missing

`System.Text.Json` learned to *read* multiple top-level values in .NET 9, when `DeserializeAsyncEnumerable` gained a `topLevelValues` parameter. Preview 5 adds the symmetric overload on the serializer:

```csharp
record SensorReading(string Device, double Celsius, DateTimeOffset At);

async IAsyncEnumerable<SensorReading> GetReadings()
{
    yield return new("kitchen", 21.4, DateTimeOffset.UtcNow);
    yield return new("garage", 8.1, DateTimeOffset.UtcNow);
}

await using var stream = File.Create("readings.jsonl");
await JsonSerializer.SerializeAsyncEnumerable(
    stream,
    GetReadings(),
    topLevelValues: true);
```

With `topLevelValues: true` you get JSONL: each item written as its own root document on its own line. Leave it at the default `false` and you get the old behavior, a single JSON array. The new overloads accept both a `Stream` and a `PipeWriter`, and take either `JsonSerializerOptions` or a source-generated `JsonTypeInfo<TValue>` for AOT-friendly, reflection-free serialization.

## A Clean Round Trip

Because the read side already exists, the two halves now line up:

```csharp
await using var input = File.OpenRead("readings.jsonl");

await foreach (var reading in JsonSerializer.DeserializeAsyncEnumerable<SensorReading>(
    input,
    topLevelValues: true))
{
    Console.WriteLine($"{reading.Device}: {reading.Celsius} C");
}
```

Note that `GetReadings` is an `IAsyncEnumerable<T>`, so the serializer pulls records as it writes them. You can stream straight from a database cursor or an HTTP response into a JSONL file without materializing a `List<T>` first. That is the whole point: constant memory regardless of how many records you push through.

This is still a preview, so the exact signatures can shift before the November release. But the API shape mirrors the read side closely enough that it is safe to start designing around it. If you have been gluing together `Utf8JsonWriter` and manual newlines to emit JSONL, this is the call that replaces all of it.
