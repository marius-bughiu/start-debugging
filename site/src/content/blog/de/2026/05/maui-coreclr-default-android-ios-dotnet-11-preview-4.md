---
title: "MAUI wechselt in .NET 11 Preview 4 standardmäßig zu CoreCLR auf Android, iOS und Mac Catalyst"
description: ".NET 11 Preview 4 macht CoreCLR zur Standard-Laufzeit für MAUI auf Android, iOS, Mac Catalyst und tvOS. Mono ist nur eine MSBuild-Eigenschaft entfernt. Das ändert sich, das bricht, und so deaktivieren Sie es."
pubDate: 2026-05-14
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "de"
translationOf: "2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-14
---

Microsoft hat [die Standard-Laufzeit von MAUI in .NET 11 Preview 4 auf CoreCLR umgestellt](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), veröffentlicht am 13. Mai 2026. Neue MAUI-Projekte, die auf Android, iOS, Mac Catalyst und tvOS abzielen, laufen jetzt auf derselben Laufzeit wie ASP.NET Core und Konsolen-Apps auf dem Desktop. Mono ist nicht mehr die implizite Wahl auf mobilen Geräten. Dies ist die größte einzelne architektonische Änderung in MAUI seit der Xamarin-Fusion, und sie landet leise hinter einem Standard-Flag.

Wenn Sie die Mobile-Story von .NET 11 verfolgen, baut dies auf [`dotnet watch`, das in derselben Vorschau MAUI auf Android und iOS erreicht hat](/de/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/), auf.

## Warum CoreCLR auf einem Telefon wichtig ist

Etwa ein Jahrzehnt lang liefen Xamarin und dann MAUI auf mobilen Geräten auf Mono, weil CoreCLR keine funktionierende AOT-Story für ARM-Mobilziele hatte. Mono brachte seinen eigenen AOT-Compiler, GC, JIT, Profiler und Debugger mit. Jede Tooling-Investition, die Microsoft in CoreCLR machte (Tiered Compilation, dynamisches PGO, die Region-Engine des Server-GC, ReadyToRun), musste auf mobilen Geräten neu implementiert oder übersprungen werden.

Die Umstellung auf CoreCLR löst das auf. Mobile MAUI bekommt jetzt denselben JIT, GC und dieselbe Diagnose-Oberfläche wie ein Linux-Container, der ASP.NET Core ausführt. Microsofts Startzahlen sind positiv für Baseline-Templates mit ReadyToRun und PGO, aber die Ankündigung ist ehrlich über Regressionen in größeren Apps auf Android und bittet Teams, im Release-Modus auf echten Geräten zu messen, bevor sie einen kostenlosen Gewinn annehmen.

Der andere Grund, warum dies wichtig ist: CoreCLR auf Android schaltet NativeAOT für MAUI frei, was der Beitrag als "einen natürlichen nächsten Schritt" bezeichnet.

## Was standardmäßig wegfällt

CoreCLR auf mobilen Geräten lässt einige Plattformen fallen, die Mono trug:

- Android x86 ist weg.
- Android API 23 und niedriger ist weg.
- Die Android-Embedding-APIs (der Pfad, den die meisten Xamarin.Android-Bibliotheksautoren verwendeten) sind weg.
- Android arm32 wird "noch geprüft".
- Blazor WebAssembly ist nicht betroffen. WASM bleibt auf Mono, weil CoreCLR kein WebAssembly-Ziel hat.

Wenn Ihre App oder eine transitive NuGet-Abhängigkeit auf die Embedding-APIs oder ausgelieferte Binaries für x86 angewiesen ist, schlägt das Upgrade beim Build oder beim Laden fehl, nicht zur Laufzeit in der Produktion.

## Deaktivieren

Eine MSBuild-Eigenschaft setzt die betroffenen Target Frameworks auf Mono zurück:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>
```

Lassen Sie die `Condition` weg, um alle Plattformen zurückzusetzen. Behandeln Sie dies als temporären Notausgang. Microsoft hat sich nicht verpflichtet, Mono für mobile MAUI über den .NET 11 Lebenszyklus hinaus auszuliefern, und die Ankündigung positioniert die Eigenschaft als Möglichkeit, ein Release zu entsperren, während Sie ein Regressions-Issue eröffnen, nicht als langfristige Konfigurationsoption.

## Was diese Woche tatsächlich zu tun ist

Drei Dinge lohnen sich jetzt, solange es noch eine Vorschau ist:

1. Kompilieren Sie Ihre App mit .NET 11 Preview 4 und prüfen Sie auf Build-Fehler durch die weggefallenen Plattformen.
2. Führen Sie einen Release-Build auf einem repräsentativen Low-End-Android-Gerät aus und vergleichen Sie Cold Start, Warm Start und APK-Größe mit derselben App, die mit .NET 10 gebaut wurde. Community-Berichte enthalten sowohl Gewinne als auch Regressionen, daher werden generische Zahlen Ihre App nicht vorhersagen.
3. Wenn Sie von einer Xamarin.Android-Bibliothek abhängen, die seit Jahren nicht mehr angefasst wurde, prüfen Sie, ob sie die Embedding-APIs verwendet. Wenn ja, wird sie auf CoreCLR nicht geladen und Sie brauchen einen Ersatz, bevor der GA-Zug abfährt.

Das ist die Art von Änderung, die in Benchmarks gut aussieht und sechs Monate später leise die Produktion bricht, wenn eine transitive Abhängigkeit sich als Mono-only herausstellt. Besser, das während der Vorschau zu lernen.
