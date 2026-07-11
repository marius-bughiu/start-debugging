---
title: ".NET 11 Runtime Async verzichtet auf das Flag EnablePreviewFeatures"
description: "Wahrend die .NET-11-Vorschauversionen auf das November-Release zusteuern, ist Runtime Async erwachsen geworden: net11.0-Projekte aktivieren es uber eine einzige MSBuild-Eigenschaft, und die Laufzeitbibliotheken selbst werden nun damit kompiliert."
pubDate: 2026-07-11
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
lang: "de"
translationOf: "2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures"
translatedBy: "claude"
translationDate: 2026-07-11
---

Als Runtime Async erstmals in .NET 11 Preview 2 erschien, bedeutete das Aktivieren zwei MSBuild-Eigenschaften und ein ausdruckliches Eingestandnis, dass man am Rand des Machbaren arbeitete. Wahrend die Vorschauversionen auf das Release im November 2026 zusteuern (Preview 6 erschien am 10. Juli), ist diese Hurde still und leise gefallen. Runtime Async ist weiterhin eine Vorschaufunktion, aber ein `net11.0`-Projekt benotigt `<EnablePreviewFeatures>true</EnablePreviewFeatures>` nicht mehr, um es zu nutzen, und die Laufzeitbibliotheken von .NET werden nun selbst damit kompiliert.

## Eine Eigenschaft statt zwei

Wenn Sie dem [ursprunglichen Artikel zu Runtime Async](/de/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/) gefolgt sind, sah Ihre `.csproj` so aus:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

Das Aktivieren erfolgt jetzt nur noch uber das Compiler-Flag:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
</PropertyGroup>
```

`EnablePreviewFeatures` zog die gesamte Analyseflache von `System.Runtime.Experimental` heran und markierte Ihr Projekt als Teilnehmer an samtlichen Vorschau-APIs des SDK. Der Wegfall bedeutet, dass Sie das laufzeitnative async ausprobieren konnen, ohne versehentlich unabhangige experimentelle Funktionen im gesamten Assembly freizuschalten.

## Die BCL nutzt es jetzt selbst

Das deutlichere Signal ist, dass die Laufzeitbibliotheken von .NET mit `runtime-async=on` kompiliert werden. Sie enthalten keine vom Compiler generierten Zustandsautomaten mehr und verlassen sich vollstandig auf das von der Laufzeit bereitgestellte async. Jedes `await` in Richtung `System.Net.Http`, `System.IO` oder `System.Text.Json` lauft bereits uber das neue Modell. Das verschafft der Funktion eine breite funktionale und leistungsbezogene Validierung, bevor sie zum Standard wird, und bedeutet, dass eine Anwendung, deren einzige asynchrone Abhangigkeiten Framework-Bibliotheken sind, praktisch bereits migriert ist.

## Schalter, die sich unbemerkt geandert haben

Wenn Sie Skripte oder Startprofile hatten, die an den alten Umgebungsvariablen drehten: Sie sind weg. Die Variablen `DOTNET_RuntimeAsync` und `UNSUPPORTED_RuntimeAsync`, die das Verhalten fruher umschalteten, wurden entfernt. Um ein bestimmtes Projekt jetzt auszuschliessen, legen Sie stattdessen eine Projekteigenschaft fest:

```xml
<PropertyGroup>
  <UseRuntimeAsync>false</UseRuntimeAsync>
</PropertyGroup>
```

## Breitere Kompilierungsabdeckung

Zwei Korrekturen erweitern, wo Runtime Async tatsachlich greift. Kovariante Uberschreibungen von `Task` zu `Task<T>` funktionieren jetzt: Wenn eine abgeleitete Klasse `Task<T>` fur eine als `Task` typisierte Basismethode zuruckgibt, erzeugt die Laufzeit einen void-zuruckgebenden Thunk, der den Unterschied in der Aufrufkonvention uberbruckt, sodass der virtuelle Dispatch fur beide Varianten funktioniert, auch unter NativeAOT. Und die Einschrankung, die das Inlining von runtime-async-Methoden wahrend der ReadyToRun-Kompilierung (crossgen2) verhinderte, wurde aufgehoben, sodass der synchrone schnelle Pfad einer async-Methode ohne await durchgangig inline eingebettet werden kann.

Nichts davon macht Runtime Async bereits zum Produktionsstandard. Aber der Aufwand, es an einer echten .NET-11-Codebasis auszuprobieren, ist jetzt eine einzige Zeile MSBuild, und die Standardbibliothek ist bereits der Beweis, dass es tragt. Alle Details zur Aktivierung finden Sie auf der Seite [Neuigkeiten in der .NET-11-Laufzeit](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime).
