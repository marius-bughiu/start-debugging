---
title: "MSTest 4.4 macht den Reflection Source Generator offiziell, und Native-AOT-Projekte bekommen ihn automatisch"
description: "MSTest 4.4 nimmt MSTest.SourceGeneration aus dem experimentellen Status und koppelt es an die MSTest-Version. Native-AOT-Testprojekte binden es ohne Opt-in ein, der ReflectionFree-Modus kann die Laufzeiterkennung für einfache [TestMethod]- und [DataRow]-Methoden überspringen, und fünf AOTSG-Diagnosen zeigen, welche Testformen nicht durchkommen."
pubDate: 2026-09-04
tags:
  - "mstest"
  - "native-aot"
  - "testing"
  - "source-generators"
  - "dotnet"
lang: "de"
translationOf: "2026/09/mstest-4-4-native-aot-source-generation"
translatedBy: "claude"
translationDate: 2026-09-04
---

Microsoft hat am 3. September 2026 den Beitrag ["Test what you ship: MSTest and Native AOT"](https://devblogs.microsoft.com/dotnet/mstest-source-generation/) veröffentlicht, und das Argument im Titel ist der ganze Punkt. Wenn Sie Ihre Anwendung mit `PublishAot` bereitstellen, validiert Ihre CI ein anderes Binary als das, was Ihre Anwender ausführen: Der Test-Host lädt auf CoreCLR mit vollständiger Reflexion, also ist ein Member, das der Trimmer entfernt hätte, beim Ausführen der Assertion noch vorhanden. Der Fehler zeigt sich stattdessen in der Produktion.

MSTest 4.3 lieferte dafür eine Lösung im experimentellen, unabhängig versionierten Paket `MSTest.SourceGeneration`. MSTest 4.4 macht sie offiziell: Das Paket verliert das Experimental-Label und wechselt auf die MSTest-Versionslinie, und `MSTest.Sdk` hält `MSTest.SourceGeneration`, `MSTest.TestFramework` und `MSTest.TestAdapter` über `MSTestVersion` auf demselben Stand.

## Native-AOT-Projekte bekommen den Generator ohne Opt-in

Ein Testprojekt, das `PublishAot` setzt, zieht den Generator jetzt automatisch mit:

```xml
<Project Sdk="MSTest.Sdk/4.4.0">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Der Testcode selbst ändert sich nicht. Gewöhnliche `[TestClass]`- und `[TestMethod]`-Member bleiben, wie sie sind, und der Generator erzeugt die Registry, die Attributdaten und die Aufruf-Delegates zur Kompilierzeit, bevor der Trimmer läuft.

Für ein Nicht-AOT-Projekt auf `MSTest.Sdk` ist der Generator optional:

```xml
<EnableMSTestSourceGeneration>true</EnableMSTestSourceGeneration>
```

Das funktioniert auch in wiederverwendbaren Testbibliotheken und unter Central Package Management, wo das SDK die passenden `PackageVersion`-Items erzeugt. Unter .NET Standard funktioniert es nicht: Die benötigten Laufzeit-Hooks von `MSTest.TestAdapter` existieren dort nicht, und das SDK lässt den Build mit einem expliziten Fehler scheitern, statt eine kaputte Registry zu erzeugen.

## Erkennung zur Kompilierzeit ändert eine Regel

Weil die Erkennung zur Kompilierzeit passiert, muss `[TestClass]` an der Klasse selbst deklariert sein. Das Erben von einer Basisklasse funktionierte unter Reflexion und erzeugt jetzt stillschweigend nichts. Der Analyzer [MSTEST0069](https://learn.microsoft.com/en-us/dotnet/core/testing/mstest-analyzers/mstest0069) meldet genau diesen Fall, und das ist der Unterschied zwischen einer Build-Warnung und einem CI-Lauf, der null Tests meldet und grün endet.

## Was ReflectionFree in 4.4 tatsächlich abdeckt

`MSTestSourceGenMode` steht seit MSTest 4.3.2 für getrimmte und Native-AOT-Projekte standardmäßig auf `ReflectionFree`. Auf einer Laufzeit, die noch Reflexion hat, greift für alles, was der Generator nicht abgedeckt hat, ein Fallback.

4.4 erweitert den abgedeckten Bereich. Die reflexionsfreie Generierung materialisiert jetzt vollständige geerbte Attribut-Metadaten, einschließlich `AttributeUsage` und `AllowMultiple`, und auf [Microsoft.Testing.Platform](/de/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) kann sie Laufzeiterkennung und -validierung für einfache synchrone `[TestMethod]`- und `[DataRow]`-Methoden vollständig überspringen. Asynchrone Tests, eigene Testmethoden-Attribute, `DynamicData`, eigene `ITestDataSource`-Implementierungen und mehrdeutige Formen nehmen weiterhin den Fallback-Pfad. VSTest behält in beiden Fällen seinen bestehenden Pfad.

Fünf Diagnosen zeigen, was der reflexionsfreie Modus nicht generieren kann: `AOTSG0001` statische Testklasse, `AOTSG0002` offene generische Testklasse (auch eine, die in einem generischen Typ verschachtelt ist), `AOTSG0003` eine Klasse, die generierter Code nicht erreicht, etwa eine file-local oder privat verschachtelte Klasse, `AOTSG0004` generische Testmethode und `AOTSG0005` eine Testmethode mit einem `ref`-, `in`- oder `out`-Parameter.

Wenn etwas bricht und Sie eingrenzen müssen, gibt es einen Notausgang, der die Erkennung behält, aber die reflexive Ausführung wiederherstellt:

```xml
<PropertyGroup>
  <MSTestSourceGenMode>Rooting</MSTestSourceGenMode>
</PropertyGroup>
```

Ein Hinweis, den Sie lesen sollten, bevor Sie eine Pipeline umschreiben: Das Verhalten von 4.4 gibt es derzeit nur in Preview-Builds, bis MSTest 4.4.0 erscheint. Die [Dokumentation zur MSTest-SDK-Konfiguration](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-sdk) enthält die vollständige Liste der Eigenschaften.
