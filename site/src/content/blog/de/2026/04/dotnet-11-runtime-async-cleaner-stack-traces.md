---
title: ".NET 11 Runtime Async ersetzt State Machines durch sauberere Stack Traces"
description: "Runtime Async in .NET 11 verlagert die async/await-Behandlung von compiler-generierten State Machines in die Laufzeit selbst und produziert lesbare Stack Traces, korrekte Breakpoints und weniger Heap-Allokationen."
pubDate: 2026-04-06
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
  - "debugging"
lang: "de"
translationOf: "2026/04/dotnet-11-runtime-async-cleaner-stack-traces"
translatedBy: "claude"
translationDate: 2026-04-25
---

Falls Sie jemals auf einen async Stack Trace in .NET gestarrt haben und versucht haben herauszufinden, welche Methode tatsächlich geworfen hat, kennen Sie den Schmerz. Die compiler-generierte State-Machine-Infrastruktur verwandelt eine einfache Drei-Methoden-Aufrufkette in eine Wand aus `AsyncMethodBuilderCore`, `MoveNext` und verstümmelten generischen Namen. .NET 11 Preview 2 liefert ein Preview-Feature namens Runtime Async, das das auf der tiefstmöglichen Ebene behebt: die CLR selbst verwaltet nun async-Suspension und -Resumption statt des C#-Compilers.

## Wie es vorher funktionierte: State Machines überall

In .NET 10 und früher weist das Markieren einer Methode als `async` den C#-Compiler an, sie in ein Struct oder eine Klasse umzuschreiben, die `IAsyncStateMachine` implementiert. Jede lokale Variable wird zu einem Feld auf diesem generierten Typ, und jedes `await` ist ein Zustandsübergang innerhalb von `MoveNext()`. Das Ergebnis ist korrekt, aber es hat Kosten:

```csharp
async Task<string> FetchDataAsync(HttpClient client, string url)
{
    var response = await client.GetAsync(url);
    response.EnsureSuccessStatusCode();
    return await response.Content.ReadAsStringAsync();
}
```

Wenn eine Exception innerhalb von `FetchDataAsync` auftritt, enthält der Stack Trace Frames für `AsyncMethodBuilderCore.Start`, das generierte `<FetchDataAsync>d__0.MoveNext()` und die generische `TaskAwaiter`-Klempnerei. Für eine Kette von drei async-Aufrufen können Sie leicht 15+ Frames sehen, wo nur drei sinnvolle Information tragen.

## Was Runtime Async ändert

Mit aktiviertem Runtime Async emittiert der Compiler keine vollständige State Machine mehr. Stattdessen markiert er die Methode mit Metadaten, die der CLR sagen, die Suspension nativ zu handhaben. Die Laufzeit hält lokale Variablen auf dem Stack und schüttet sie nur dann auf den Heap, wenn die Ausführung tatsächlich eine `await`-Grenze überschreitet, die nicht synchron abgeschlossen werden kann. Das praktische Ergebnis: weniger Allokationen und drastisch kürzere Stack Traces.

Eine async-Drei-Methoden-Kette wie `OuterAsync -> MiddleAsync -> InnerAsync` produziert einen Stack Trace, der direkt auf Ihre Quelle abgebildet wird:

```
at Program.InnerAsync() in Program.cs:line 24
at Program.MiddleAsync() in Program.cs:line 14
at Program.OuterAsync() in Program.cs:line 8
```

Kein synthetisches `MoveNext`, kein `AsyncMethodBuilderCore`, keine typ-verstümmelten Generics. Nur Methoden und Zeilennummern.

## Debugging funktioniert jetzt tatsächlich

Preview 2 hat einen kritischen Fix hinzugefügt: Breakpoints binden nun korrekt innerhalb von runtime-async-Methoden. In Preview 1 übersprang der Debugger manchmal Breakpoints oder landete auf unerwarteten Zeilen beim Schritthalten durch `await`-Grenzen. Mit Preview 2 können Sie einen Breakpoint auf eine Zeile nach einem `await` setzen, ihn treffen und Locals normal inspizieren. Über ein `await` zu steppen landet auf der nächsten Anweisung, nicht innerhalb der Laufzeitinfrastruktur.

Das nützt auch Profiling-Werkzeugen und Diagnose-Logging. Alles, was `new StackTrace()` aufruft oder `Environment.StackTrace` zur Laufzeit liest, sieht nun die echte Aufrufkette, was strukturiertes Logging und benutzerdefinierte Exception-Handler ohne zusätzliche Filterung nützlicher macht.

## Runtime Async aktivieren

Das ist immer noch ein Preview-Feature. Treten Sie bei, indem Sie zwei Eigenschaften zu Ihrem `.csproj` hinzufügen:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

Die CLR-seitige Unterstützung ist in .NET 11 standardmäßig aktiviert, also müssen Sie die Umgebungsvariable `DOTNET_RuntimeAsync` nicht mehr setzen. Der Compiler-Schalter ist der einzige Schalter.

## Worauf zu achten ist

Runtime Async ist noch nicht der Standard für Produktionscode. Das .NET-Team arbeitet noch an Edge Cases mit Tail Calls, bestimmten generischen Constraints und der Interaktion mit bestehenden Diagnose-Werkzeugen. Falls Sie bereits auf .NET 11 Previews sind und es in einem Testprojekt ausprobieren wollen, sind die zwei MSBuild-Zeilen oben alles, was Sie brauchen.

Die vollständigen Runtime-Async-Details sind in den [.NET 11 Preview 2 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/runtime.md) und auf der Seite [What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) bei Microsoft Learn.
