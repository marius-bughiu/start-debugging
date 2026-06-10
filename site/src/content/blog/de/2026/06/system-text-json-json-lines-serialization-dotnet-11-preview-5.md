---
title: "System.Text.Json schreibt in .NET 11 Preview 5 endlich JSON Lines"
description: ".NET 11 Preview 5 ergänzt JsonSerializer.SerializeAsyncEnumerable mit topLevelValues: true, sodass System.Text.Json JSONL nicht nur lesen, sondern auch streamen kann."
pubDate: 2026-06-10
tags:
  - "dotnet-11"
  - "csharp"
  - "system-text-json"
  - "serialization"
lang: "de"
translationOf: "2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-10
---

Die [Bibliotheksnotizen zu .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) schließen eine Lücke, die seit .NET 9 offen war: `System.Text.Json` kann JSON Lines jetzt serialisieren, nicht nur deserialisieren. Die Leseseite kam vor zwei Versionen, die Schreibseite fehlte, und wer JSONL exportierte, musste von Hand eine Schleife schreiben, die ein Dokument pro Zeile ausgab. Preview 5 macht daraus einen einzigen Aufruf.

## Was JSON Lines wirklich ist

JSON Lines (JSONL) ist kein JSON-Array. Es ist ein eigenständiger JSON-Wert pro Zeile, getrennt durch `\n`, ohne umschließende Klammern und ohne Kommas zwischen den Datensätzen:

```
{"Device":"kitchen","Celsius":21.4}
{"Device":"garage","Celsius":8.1}
```

Diese Form findet sich überall, sobald Sie Daten streamen: strukturierte Logdateien, große Datenbankexporte und die Batch-Ein-/Ausgabeformate, die von Trainings- und Evaluierungspipelines für LLMs verwendet werden. Der Vorteil ist, dass Sie einen Datensatz anhängen können, ohne die Datei neu zu schreiben, und dass Sie die Datei Zeile für Zeile verarbeiten können, ohne jemals das Ganze im Speicher zu halten. Ein JSON-Array auf oberster Ebene bietet davon nichts, denn ein Parser kann nicht wissen, dass das Array gültig ist, bis er die schließende `]` sieht.

## Die Schreibseite, die fehlte

`System.Text.Json` lernte in .NET 9, mehrere Werte auf oberster Ebene zu *lesen*, als `DeserializeAsyncEnumerable` einen Parameter `topLevelValues` erhielt. Preview 5 ergänzt die symmetrische Überladung im Serialisierer:

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

Mit `topLevelValues: true` erhalten Sie JSONL: jedes Element wird als eigenes Wurzeldokument in einer eigenen Zeile geschrieben. Belassen Sie es beim Standardwert `false`, erhalten Sie das alte Verhalten, ein einzelnes JSON-Array. Die neuen Überladungen akzeptieren sowohl einen `Stream` als auch einen `PipeWriter` und nehmen entweder `JsonSerializerOptions` oder ein quellgeneriertes `JsonTypeInfo<TValue>` für eine AOT-freundliche, reflexionsfreie Serialisierung entgegen.

## Ein sauberer Rundlauf

Da die Leseseite bereits existiert, passen die beiden Hälften nun zusammen:

```csharp
await using var input = File.OpenRead("readings.jsonl");

await foreach (var reading in JsonSerializer.DeserializeAsyncEnumerable<SensorReading>(
    input,
    topLevelValues: true))
{
    Console.WriteLine($"{reading.Device}: {reading.Celsius} C");
}
```

Beachten Sie, dass `GetReadings` ein `IAsyncEnumerable<T>` ist, sodass der Serialisierer die Datensätze abruft, während er sie schreibt. Sie können direkt aus einem Datenbankcursor oder einer HTTP-Antwort in eine JSONL-Datei streamen, ohne zuvor eine `List<T>` zu materialisieren. Genau darum geht es: konstanter Speicher, egal wie viele Datensätze Sie durchschieben.

Dies ist noch eine Vorschau, daher können sich die genauen Signaturen vor dem Release im November ändern. Doch die Form der API spiegelt die Leseseite so weit, dass es sicher ist, bereits darauf hin zu entwerfen. Wenn Sie bisher `Utf8JsonWriter` mit manuellen Zeilenumbrüchen zusammengeklebt haben, um JSONL auszugeben, ist dies der Aufruf, der all das ersetzt.
