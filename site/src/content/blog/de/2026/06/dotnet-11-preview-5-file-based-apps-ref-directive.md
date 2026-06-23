---
title: ".NET 11 Preview 5 lässt file-based Apps sich mit `#:ref` gegenseitig referenzieren"
description: ".NET 11 Preview 5 fügt die Direktive #:ref hinzu, damit ein dotnet-run-Skript eine andere file-based App als Bibliothek referenzieren kann, mit transitiven Referenzen und ohne Projektdatei."
pubDate: 2026-06-23
tags:
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/dotnet-11-preview-5-file-based-apps-ref-directive"
translatedBy: "claude"
translationDate: 2026-06-23
---
File-based Apps begannen als Möglichkeit, eine einzelne `.cs`-Datei mit `dotnet run` und ohne Projekt auszuführen. In [.NET 10 lernten sie `#:include`](/de/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/), das zusätzliche Dateien in eine einzige Kompilierung zieht. [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) geht einen Schritt weiter: Die neue Direktive `#:ref` erlaubt es einer file-based App, eine andere file-based App als *Bibliothek* zu referenzieren, und transitive Referenzen werden unterstützt. Keine `.csproj` erforderlich.

## Wie sich `#:ref` von `#:include` unterscheidet

Der Unterschied ist real, nicht kosmetisch. `#:include` führt eine andere Datei in dieselbe Kompilierungseinheit zusammen, sodass alles in einem einzigen Assembly landet. `#:ref` behandelt das Ziel als separate Bibliothek und referenziert es, genau wie es ein `ProjectReference` täte, nur dass auf keiner Seite ein Projekt existiert.

Das bedeutet, dass `#:ref` Ihnen eine echte Grenze gibt. Die referenzierte Datei kompiliert eigenständig, stellt ihre öffentlichen Typen bereit, und der Konsument verlinkt dagegen. Sie erhalten Wiederverwendung über Skripte hinweg, ohne Hilfsfunktionen zu kopieren oder eine Klassenbibliothek aufzusetzen.

## Ein Zwei-Dateien-Beispiel, das Sie ausführen können

Legen Sie eine kleine Bibliothek in `lib.cs` ab:

```csharp
// lib.cs
namespace MyLib;

public static class Greeter
{
    public static string Greet(string name) => $"Hello, {name}!";
}
```

Referenzieren Sie sie aus `app.cs`:

```csharp
// app.cs
#:ref lib.cs

Console.WriteLine(MyLib.Greeter.Greet("World"));
```

Führen Sie es mit einem .NET 11 Preview 5 SDK aus:

```bash
dotnet run app.cs
```

Wenn `lib.cs` selbst ein `#:ref` auf eine dritte Datei trägt, fließt diese Referenz durch. Transitive Referenzen werden aufgelöst, sodass Sie einen kleinen Graphen aus Skripten zusammensetzen können, so wie Sie einen kleinen Graphen aus Projekten zusammensetzen würden.

## Die Direktiven sind nicht mehr gesperrt

Die andere Neuigkeit in Preview 5 ist, dass die file-based-App-Direktiven `#:include`, `#:exclude` und `#:project` kein Feature Flag mehr benötigen und Direktiven innerhalb eingebundener Dateien nun transitiv verarbeitet werden. So kann `#:include` durch verschachtelte Dateien hindurchgreifen, und `#:project` kann ein Skript auf eine echte `.csproj` zeigen lassen, wenn Sie dem reinen Skript-Aufbau entwachsen.

Das gibt Ihnen einen Verlauf statt einer Klippe. Beginnen Sie mit einer Datei. Lagern Sie Hilfsfunktionen mit `#:include` aus. Befördern Sie eine Hilfsfunktion mit `#:ref` zu einer wiederverwendbaren Bibliothek. Binden Sie mit `#:project` ein vollständiges Projekt ein, sobald die Sache aufhört, ein Skript zu sein. Jeder Schritt ist eine Direktivzeile, und keiner zwingt Sie, `dotnet run` aufzugeben.

## Wo das hineinpasst

`#:ref` richtet sich an dasselbe Publikum wie die übrige Arbeit an file-based Apps: Tooling-Skripte, Beispiele, Reproduktionen und die Art von Klebecode, der nie eine Solution-Datei verdient hat. Die neue Grenze macht diese Skripte teilbar, ohne die MSBuild-Zeremonie mitzuschleppen. Es ist eine Vorschau-Funktion, also probieren Sie sie mit einem .NET 11 Preview 5 SDK aus und lesen Sie die [SDK-Release-Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) für das genaue Verhalten, bevor Sie sich darauf verlassen.
