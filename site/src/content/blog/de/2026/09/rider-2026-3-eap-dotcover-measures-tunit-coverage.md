---
title: "Rider 2026.3 EAP: dotCover misst endlich die TUnit-Abdeckung"
description: "Das Early Access Program für Rider 2026.3 startete am 7. September 2026. Unter den bunten Klammern steht die Zeile, die einen Build wirklich verändert: dotCover meldet jetzt Coverage für TUnit-Tests, vorausgesetzt Microsoft.Testing.Platform 2.3.0 und eine Paketreferenz."
pubDate: 2026-09-08
tags:
  - "dotnet"
  - "testing"
  - "rider"
  - "code-coverage"
  - "tooling"
lang: "de"
translationOf: "2026/09/rider-2026-3-eap-dotcover-measures-tunit-coverage"
translatedBy: "claude"
translationDate: 2026-09-08
---

JetBrains hat das [Early Access Program für Rider 2026.3](https://blog.jetbrains.com/dotnet/2026/09/07/rider-2026-3-eap/) am 7. September 2026 eröffnet. Die Schlagzeilenfunktionen sind die, die sich gut als Screenshot machen: bunte Klammern (standardmäßig deaktiviert, unter Settings | Editor | General | Appearance), eine Filterleiste im Completion-Popup und eine eigene Plugin-Kategorie für Game Development. Die Änderung, die ein Repository tatsächlich entsperrt, steht zwei Sätze weiter unten: Die dotCover-Integration in Rider misst jetzt die Abdeckung von Unit-Tests, die mit TUnit geschrieben sind.

## Warum TUnit-Projekte nichts gemeldet haben

TUnit ist ein natives Testframework für Microsoft.Testing.Platform. Es hat keinen VSTest-Adapter, und genau das ist der Punkt: Das Testprojekt kompiliert eine ausführbare Datei, die ihren eigenen Einstiegspunkt besitzt und das MTP-Protokoll spricht, statt von `vstest.console` gehostet zu werden. Das ist derselbe Architekturwechsel, der hinter [dem Umstieg von VSTest auf Microsoft.Testing.Platform in .NET 11](/de/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) steht.

Der Coverage-Runner von dotCover innerhalb der IDE hängte sich an den VSTest-Host. Ohne VSTest-Host im Spiel erzeugte "Cover Unit Tests" bei einem TUnit-Projekt entweder einen leeren Bericht oder startete gar nicht, und JetBrains führte das als [DCVR-12871](https://youtrack.jetbrains.com/projects/DCVR/issues/DCVR-12871). Teams, die Zahlen brauchten, wichen auf `dotnet test --coverage` mit `Microsoft.Testing.Extensions.CodeCoverage` aus und lasen eine Cobertura-Datei. Das funktioniert in der CI gut und ist nutzlos, wenn man Grün und Rot am Rand neben der gerade bearbeiteten Zeile sehen will.

## Die Aktivierung

Coverage kommt beim Update nicht von selbst. Es gibt zwei Voraussetzungen, beide ausdrücklich in der EAP-Ankündigung genannt.

Erstens braucht das Testprojekt das Profiler-Framework-Paket:

```xml
<ItemGroup>
  <PackageReference Include="TUnit" />
  <PackageReference Include="JetBrains.dotCover.Framework" />
</ItemGroup>
```

Zweitens liegt die Untergrenze bei `Microsoft.Testing.Platform` 2.3.0 oder neuer. Das ist dasselbe 2.3.0, das im Juli 2026 [streamendes TRX und GitHub-Actions-Annotationen](/de/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) gebracht hat, die meisten Repositories mit einem aktuellen TUnit liegen also bereits darüber. Prüfen Sie, was tatsächlich wiederhergestellt wurde, nicht was deklariert ist:

```bash
dotnet list package --include-transitive | grep Microsoft.Testing.Platform
```

Danach stellen Sie sicher, dass Rider überhaupt über MTP läuft: Settings | Build, Execution, Deployment | Unit Testing | Testing Platform, und setzen Sie den Haken bei "Enable Test Platform support". Ohne dieses Häkchen läuft Rider weiterhin über seinen alten Runner, und der Bericht bleibt leer.

## Die zweite Neuerung, die das EAP-Risiko wert ist

Data Breakpoints sind kein Ritual im Watches-Fenster mehr. Sie können eine Variable im Editor mit der rechten Maustaste anklicken und den Haltepunkt dort konfigurieren, oder ihn direkt im Breakpoints-Fenster über eine Speicheradresse und eine Regionsgröße anlegen. Lese- und Schreibzugriff, Bedingungen und Logging werden unterstützt. Um ein Feld zu verfolgen, das ein anderer Thread überschreibt, ist das ein deutlich kürzerer Weg als der bisherige Ablauf.

EAP-Builds sind während des Programms kostenlos und laufen ab. Behandeln Sie das also als Weg, die Coverage eines TUnit-Repositories jetzt zu entsperren, nicht als Maschine, von der aus Sie ausliefern.
