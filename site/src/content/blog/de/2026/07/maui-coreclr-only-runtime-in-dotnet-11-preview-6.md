---
title: "MAUI Mobile läuft in .NET 11 Preview 6 nur noch auf CoreCLR: Die Mono-Notausstiegsluke ist weg"
description: ".NET 11 Preview 6 entfernt den separaten Mono-Pfad für MAUI auf Android, iOS und Mac Catalyst. CoreCLR ist jetzt die einzige mobile Laufzeit, die UseMonoRuntime-Notausstiegsluke ist geschlossen, und die GA ist für November 2026 geplant."
pubDate: 2026-07-19
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "de"
translationOf: "2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-19
---

Vor zwei Monaten [stellte MAUI seine standardmäßige mobile Laufzeit in .NET 11 Preview 4 auf CoreCLR um](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), und die Release Notes reichten Ihnen eine Notausstiegsluke: Mit `<UseMonoRuntime>true</UseMonoRuntime>` kehrten Ihre Builds für Android, iOS und Mac Catalyst zur alten Laufzeit zurück. Diese Luke schließt sich. In [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/) bestätigt David Ortinau, dass CoreCLR ab .NET 11 Preview 6 (veröffentlicht am 2026-07-10) die einzige verfügbare Laufzeit für mobile MAUI-Apps ist. Microsoft "bietet keinen separaten Mono-Pfad mehr für Android, iOS oder Mac Catalyst an".

## Vom Standard zur einzigen Option

Die Unterscheidung ist wichtig. In Preview 4 war CoreCLR der Standard und Mono nur eine Property-Änderung entfernt, ausdrücklich als vorübergehende Entsperrung dargestellt, während Sie eine Regression melden. Preview 6 entfernt diese Doppel-Laufzeit-Haltung auf mobilen Plattformen. Es gibt kein unterstütztes Mono-Target mehr für die mobilen Heads von MAUI, und die Opt-out-Property, die sie früher zurücksetzte, ist nicht mehr Teil der Geschichte. Wenn sich Ihr Projekt oder eine transitive Abhängigkeit auf `UseMonoRuntime` stützte, um eine CoreCLR-Regression zu umgehen, läuft dieser Plan jetzt aus, nicht erst bei der GA.

Blazor WebAssembly ist nicht betroffen. WebAssembly läuft weiterhin auf Mono, weil CoreCLR kein Wasm-Target hat, und daran ändert sich nichts.

```xml
<!-- Preview 4: still an option -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>

<!-- Preview 6: no separate Mono path for MAUI mobile -->
```

## Wo die Zahlen landeten

Der ehrliche Teil der Preview-4-Ankündigung war das Eingeständnis von Regressionen bei größeren Android-Apps. Preview 6 liest sich ruhiger. Ortinau berichtet, dass iOS und Mac Catalyst insgesamt schneller sind als auf Mono und dass Android jetzt bei Startzeit und App-Größe innerhalb von etwa 10% von Mono liegt. Das ist nahe genug, dass die Laufzeit-Vereinheitlichung, die denselben JIT, GC und dieselben Diagnosen wie ASP.NET Core teilt, kein Kompromiss mehr ist, über den Sie streiten, sondern eine Basis, auf der Sie aufbauen. Sie hält außerdem NativeAOT für MAUI als nächsten Schritt auf dem Tisch, was nie möglich war, solange Mobile auf einer separaten Laufzeit lief.

## Was Sie vor November testen sollten

Die GA ist im November 2026, und das Preview-Fenster ist genau der Zeitpunkt, an dem sich Prioritäten aufgrund Ihres Feedbacks noch verschieben können. Konkret:

- Kompilieren Sie Ihre App auf Preview 6 und bestätigen Sie, dass sie lädt. Die Plattformen, die CoreCLR früher im .NET-11-Zyklus verworfen hat (Android x86, API 23 und niedriger, die alten Xamarin.Android-Embedding-APIs), scheitern zur Build- oder Ladezeit, nicht still in der Produktion.
- Führen Sie einen Release-Build auf einem repräsentativen Android-Gerät der unteren Preisklasse aus und vergleichen Sie Kaltstart, Warmstart und Paketgröße mit .NET 10. Die 10%-Zahl ist der Durchschnitt von Microsoft, kein Versprechen über Ihren Abhängigkeitsgraphen.
- Prüfen Sie jede lange nicht angefasste Xamarin.Android-Bibliothek. Wenn sie die Embedding-APIs nutzt, lädt sie nicht auf CoreCLR, und Sie brauchen einen Ersatz in der Warteschlange, bevor der GA-Zug abfährt.

Die Laufzeit, auf der Sie MAUI im November ausliefern, wird jetzt entschieden. Preview 6 ist der letzte bequeme Moment, um herauszufinden, ob Ihre App damit einverstanden ist. Der vollständige Fortschrittsbericht und der Zeitplan stehen im [.NET Blog](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/).
