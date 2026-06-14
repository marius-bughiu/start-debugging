---
title: "Der neue EF1004-Analyzer in EF Core 11 erkennt einen stillen Async-Fehler"
description: "EF Core 11 Preview 5 liefert den EF1004-Analyzer. Er markiert ToAsyncEnumerable() auf einem IQueryable, damit Sie eine Datenbankabfrage nicht versehentlich synchron in einem await foreach durchlaufen."
pubDate: 2026-06-14
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "de"
translationOf: "2026/06/ef-core-11-ef1004-analyzer-toasyncenumerable-vs-asasyncenumerable"
translatedBy: "claude"
translationDate: 2026-06-14
---

.NET 11 Preview 5, veröffentlicht am 2026-06-09, fügt einen neuen EF-Core-Analyzer mit der Diagnose-ID `EF1004` hinzu. Er erkennt einen Fehler, der seit der Aufnahme von `System.Linq.AsyncEnumerable` in die BCL mit .NET 10 deutlich leichter passiert: der Aufruf von `ToAsyncEnumerable()` auf einer EF-Core-Abfrage, die dann unbemerkt synchron ausgeführt wird.

## Wie sich der falsche Aufruf einschleicht

Da `System.Linq.AsyncEnumerable` jetzt in der Laufzeit enthalten ist, stehen seine Erweiterungsmethoden fast überall zur Verfügung. Eine davon ist `ToAsyncEnumerable()`, die ein beliebiges `IEnumerable<T>` in ein `IAsyncEnumerable<T>` umwandelt. Ein `IQueryable<T>` von EF Core ist ebenfalls ein `IEnumerable<T>`, daher kompiliert der Aufruf problemlos und sieht neben einem `await foreach` korrekt aus:

```csharp
// Looks async. Is not.
await foreach (var blog in db.Blogs.ToAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

Das Problem ist, dass `ToAsyncEnumerable()` eine synchrone Enumeration umschließt. Es durchläuft das `IQueryable` mit dem blockierenden Enumerator, sodass der Datenbank-Roundtrip auf dem aufrufenden Thread ausgeführt wird. Das `await foreach` liefert Ihnen die Syntax des Streamings ohne das asynchrone Verhalten. Unter Last ist dies genau die Form, die den Thread-Pool erschöpft und Deadlocks erzeugt, die erst in der Produktion auftreten.

## Was EF1004 stattdessen erwartet

EF Core stellt seine eigene Methode `AsAsyncEnumerable()` bereit. Diese leitet die Abfrage durch die asynchrone Pipeline von EF Core, sodass jede Zeile materialisiert wird, sobald sie aus dem `DbDataReader` kommt, ohne einen Thread zu blockieren:

```csharp
// Runs through EF Core's async query pipeline.
await foreach (var blog in db.Blogs.AsAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

Die beiden Methodennamen unterscheiden sich um drei Zeichen, beide geben `IAsyncEnumerable<T>` zurück und beide kompilieren. Vor Preview 5 sagte Ihnen nichts, welche Sie ausgewählt hatten. `EF1004` schlägt zur Buildzeit an, sobald Sie `ToAsyncEnumerable()` auf einem `IQueryable<T>` aufrufen, und verweist Sie auf `AsAsyncEnumerable()`.

## So wird daraus ein Fehler

Der Analyzer ist im EF-Core-Analyzer-Paket enthalten und läuft während eines normalen Builds, sodass Sie die Warnung ohne zusätzliche Konfiguration in einem Projekt erhalten, das `Microsoft.EntityFrameworkCore` 11.0.0 referenziert. Wenn Sie sicherstellen möchten, dass niemand die synchrone Version ausliefert, stufen Sie sie in Ihrer Projektdatei hoch:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);EF1004</WarningsAsErrors>
</PropertyGroup>
```

Das passt natürlich zu den Streaming-Mustern, die in [Wie man IAsyncEnumerable&lt;T&gt; mit EF Core 11 verwendet](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) behandelt werden: `AsAsyncEnumerable()` ist der Aufruf, der `await foreach` tatsächlich streamen lässt. EF1004 ist lediglich das Schutzgeländer, das verhindert, dass die ähnlich aussehende Methode am Code-Review vorbeischlüpft.

Quelle: die [Versionshinweise zu EF Core für .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/efcore.md) und die [Ankündigung von .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/).
