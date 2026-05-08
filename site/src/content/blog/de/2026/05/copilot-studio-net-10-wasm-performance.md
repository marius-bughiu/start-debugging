---
title: "Copilot Studio mit .NET 10 WebAssembly: 20% Cold Path, 5% Warm Path"
description: "Microsoft hat die WASM-Engine von Copilot Studio von .NET 8 auf .NET 10 umgestellt. Das duale JIT/AOT-Paket, Fingerprinting und WasmStripILAfterAOT erklären die Zahlen."
pubDate: 2026-05-08
tags:
  - "dotnet"
  - "webassembly"
  - "performance"
  - "blazor"
lang: "de"
translationOf: "2026/05/copilot-studio-net-10-wasm-performance"
translatedBy: "claude"
translationDate: 2026-05-08
---

Am 7. Mai 2026 hat Daniel Roth eine [Fallstudie zu Copilot Studio](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/) im .NET-Blog veröffentlicht. Die Schlagzeile: Die WebAssembly-Laufzeit von Copilot Studio, die als NPM-Paket ausgeliefert und in viele Microsoft-365-Oberflächen eingebettet wird, läuft jetzt produktiv auf .NET 10. Die Cold-Path-Ausführung ist rund 20% schneller, der Warm Path rund 5%, und die Migration selbst war im Wesentlichen eine Anhebung von `<TargetFramework>`.

Interessant ist, wie Copilot Studio zwei Engines in ein einziges Bundle verpackt und was sich am WebAssembly-Tooling von .NET 10 geändert hat, sodass der neue Build dort kleiner wird, wo es zählt, und dort etwas größer, wo es nicht zählt.

## Zwei Engines, ein Paket

Copilot Studio entscheidet sich nicht zwischen JIT und AOT. Es liefert beide im selben NPM-Paket aus und lässt die Seite sie parallel laden.

Die JIT-Engine startet zuerst und nimmt Benutzerinteraktionen sofort entgegen. Die AOT-Engine, die größer ist und länger zum Herunterladen braucht, lädt im Hintergrund fertig. Sobald sie bereit ist, übergibt die Laufzeit die aktive Sitzung an AOT, und die JIT-Engine wird verworfen. Der Benutzer erlebt eine schnelle erste Antwort und danach eine im Stillen schnellere Erfahrung für den Rest der Konversation.

Dieses duale Laden ist der Grund, warum Copilot Studio so viel Wert auf das Teilen von Assets zwischen den beiden Engines legt. Was beide referenzieren können, sollte nicht zweimal heruntergeladen werden.

## Was sich in .NET 10 tatsächlich geändert hat

Zwei Änderungen im WebAssembly-Workload von .NET 10 erklären den Großteil des Unterschieds.

Erstens: **automatisches Asset-Fingerprinting**. In .NET 8 musste das Team einen eigenen PowerShell-Schritt ausführen, um an jeden WASM- und DLL-Dateinamen einen SHA256-Hash anzuhängen, damit Caches und Integritätsprüfungen sich richtig verhielten. In .NET 10 ist das eingebaut, und die Publish-Ausgabe vergibt bereits Namen wie `dotnet.runtime.{hash}.js` ohne eigenen MSBuild-Klebercode.

Zweitens: **`WasmStripILAfterAOT` ist standardmäßig aktiviert**. Nach der AOT-Kompilierung wird der ursprüngliche IL-Code für kompilierte Methoden nicht mehr ausgeliefert. Das verkleinert die AOT-Payload, reduziert aber auch die Anzahl der Dateien, die JIT- und AOT-Engine gemeinsam nutzen können, weil AOT-spezifische Dateien den IL-Code, den die JIT-Engine bräuchte, nicht mehr enthalten.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <RunAOTCompilation>true</RunAOTCompilation>
  <!-- Defaults to true on net10.0; shown here for clarity. -->
  <WasmStripILAfterAOT>true</WasmStripILAfterAOT>
</PropertyGroup>
```

Unter .NET 8 wurden 59 Dateien zwischen den JIT- und AOT-Engines von Copilot Studio geteilt. Unter .NET 10 sind es nur noch 22. Das Gesamtpaket ist um etwa 15% gewachsen. Das ist der Preis dafür, IL aus AOT-Methoden zu entfernen: Das duale Modell verliert einen Teil seiner Dedup-Gewinne.

## Die Zahlen ehrlich lesen

Microsoft benennt den Trade-off offen. AOT-Downloads sind in einem schnellen LAN rund 6% langsamer, was etwa 200 ms entspricht, und in einer 4G-Verbindung rund 17% langsamer, also etwa 5 Sekunden. Diese Strafe wird im Hintergrund bezahlt, während die JIT-Engine den Benutzer bereits bedient, sodass sie nicht in der Time-to-Interactive sichtbar ist. Sie wird sichtbar, wenn ein Benutzer mitten im Laden die Verbindung verliert oder Copilot Studio in einem eingeschränkten Netzwerk ausführt.

Im Gegenzug:

- Cold Path der Ausführung: ~20% schneller.
- Warm Path der Ausführung: ~5% schneller.
- Keine Codeänderungen über die Framework-Anhebung hinaus.

Für einen Workload, der innerhalb der Microsoft-365-Oberflächen läuft und ständig getroffen wird, zählt ein Gewinn von 20% auf dem Cold Path bei jeder Interaktion mehr als fünf Sekunden Hintergrund-Download.

## Was das für Ihre Blazor-WebAssembly-App bedeutet

Wenn Sie eine Blazor-WebAssembly- oder .NET-WASM-App ausliefern und noch auf .NET 8 sind, ist die Migration günstig. Setzen Sie `TargetFramework` auf `net10.0`, restaurieren Sie, publishen Sie, und lassen Sie das neue Fingerprinting und die AOT-Defaults greifen. Wenn Sie in Ihrer Pipeline einen eigenen Hashing- oder IL-Stripping-Schritt haben, löschen Sie ihn.

Wenn Sie keine dualen JIT- und AOT-Engines ausliefern (die meisten Apps tun das nicht), werden Sie das 15%-Paketwachstum, das Copilot Studio gesehen hat, nicht erleben. Sie bekommen die Einsparungen durch das IL-Stripping ohne den Verlust an Deduplication. Auf diese Konfiguration sind die Defaults von .NET 10 abgestimmt.

Die vollständige Fallstudie, einschließlich Deployment-Details und der Frage, wie Copilot Studio diese Zahlen in der Produktion misst, finden Sie im [.NET-Blog](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/).
