---
title: "Wie 878 Copilot-Coding-Agent-PRs in dotnet/runtime tatsächlich aussehen"
description: "Das .NET-Team teilt zehn Monate echter Daten zum Betrieb von GitHubs Copilot Coding Agent in dotnet/runtime: 878 PRs, eine Merge-Rate von 67,9 % und klare Lehren, wo KI-gestützte Entwicklung hilft und wo sie immer noch zu kurz greift."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "ai"
  - "ai-agents"
  - "github-copilot"
  - "copilot"
  - "github"
lang: "de"
translationOf: "2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data"
translatedBy: "claude"
translationDate: 2026-04-25
---

GitHubs Copilot Coding Agent läuft seit Mai 2025 im [dotnet/runtime](https://github.com/dotnet/runtime)-Repository. Stephen Toubs [Tiefenanalyse-Post](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) deckt zehn Monate realer Nutzung ab: 878 eingereichte PRs, 535 gemergt, eine Merge-Rate von 67,9 % und eine Revert-Rate von nur 0,6 %.

## Wo die Zahlen interessant werden

Nicht alle PR-Größen sind gleich geschaffen. Kleine, fokussierte Änderungen haben höhere Erfolgsraten:

| PR-Größe (geänderte Zeilen) | Erfolgsrate |
|---|---|
| 1-10 Zeilen | 80,0 % |
| 11-50 Zeilen | 76,9 % |
| 101-500 Zeilen | 64,0 % |
| 1.001+ Zeilen | 71,9 % |

Der Einbruch bei 101-500 Zeilen spiegelt die Grenze wider, an der mechanische Aufgaben in architektonische übergehen. Aufräum- und Entfernungsarbeit führt die Kategorien mit 84,7 % Erfolg an, gefolgt von Testergänzungen mit 75,6 %. Das sind Aufgaben mit klaren Erfolgskriterien, ohne Mehrdeutigkeit der Intention und mit begrenztem Wirkungsradius.

## Anweisungen sind das ganze Spiel

Der erste Monat des Teams produzierte eine Merge-Rate von 41,7 % ohne nennenswerte Konfiguration. Nach dem Schreiben einer ordentlichen Agent-Anweisungsdatei -- mit Build-Befehlen, Testmustern und architektonischen Grenzen -- stieg die Rate innerhalb von Wochen auf 69 % und erreichte schließlich 72 %.

Ein minimales, aber effektives Setup sieht so aus:

```markdown
## Build
Run `./build.sh clr -subset clr.runtime` to build the runtime.
Run `./build.sh -test -subset clr.tests` to run tests.

## Testing Patterns
New public APIs require tests in src/tests/.
Use existing helpers in XUnitHelper rather than writing from scratch.

## Scope Limits
Do not change public API surface without a linked tracking issue.
Native (C++) components require Windows CI -- avoid if not needed.
```

Die Anweisungen müssen nicht lang sein. Sie müssen spezifisch sein.

## Review-Kapazität wird zum Engpass

Eine vielsagende Beobachtung aus den Daten: ein einzelner Entwickler konnte vom Telefon aus während einer Reise neun substanzielle PRs in die Warteschlange stellen und damit 5-9 Stunden Review-Arbeit für das Team erzeugen. Die PR-Generierung skalierte schneller als das PR-Review. Diese Asymmetrie hat parallele Investitionen in KI-gestütztes Code-Review angestoßen, um das neue Volumen zu absorbieren. Dieses Muster wird sich in jedem Team wiederholen, das den Agent in der Breite einführt.

## Was CCA nicht ersetzt

Architekturentscheidungen, plattformübergreifendes Argumentieren und Urteilsentscheidungen zur API-Form erforderten konsistent menschlichen Eingriff. CCAs gemergter Code teilt sich auf in 65,7 % Testcode gegenüber 49,9 % bei menschlichen Beitragenden. Er ist am stärksten beim Auffüllen mechanischer Arbeit, die Menschen routinemäßig zurückstellen.

Die breitere Validierung deckte sieben .NET-Repositories ab (aspire, roslyn, aspnetcore, efcore, extensions und andere): 1.885 gemergte PRs aus 2.963 eingereichten, eine Erfolgsrate von 68,6 %. Das Muster hält im großen Maßstab.

Für Teams, die über die Einführung des Copilot Coding Agent nachdenken: starten Sie mit kleinen Aufräum- oder Test-Aufgaben, schreiben Sie Ihre Anweisungsdatei vor allem anderen, und planen Sie ein, dass Review-Kapazität zur nächsten Beschränkung wird.

Die vollständige Analyse ist auf [devblogs.microsoft.com](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/).
