---
title: "Microsoft.Testing.Platform 2.3: --report-gh bringt Testfehler in den PR-Diff"
description: "Der Beitrag im .NET-Blog vom 2026-08-06 über MTP-Reporting rückt eine Reihe von Erweiterungen ins Licht, die in Microsoft.Testing.Platform 2.3.0 stabil wurden: GitHub-Actions-Annotationen, absturzsicheres TRX-Streaming und Flaky-Historie in Azure DevOps."
pubDate: 2026-08-07
tags:
  - "dotnet"
  - "testing"
  - "ci-cd"
  - "github-actions"
  - "msbuild"
lang: "de"
translationOf: "2026/08/microsoft-testing-platform-2-3-github-actions-annotations"
translatedBy: "claude"
translationDate: 2026-08-07
---

Am 2026-08-06 veröffentlichte der .NET-Blog [Test reporting in Microsoft.Testing.Platform: from red build to root cause](https://devblogs.microsoft.com/dotnet/microsoft-testing-platform-reporting/). Die Neuigkeit ist nicht der Artikel selbst, sondern wie viel dieser Reporting-Geschichte still und leise in Microsoft.Testing.Platform 2.3.0 gelandet ist (2026-07-07, letzter Patch 2.3.3 am 2026-07-28) und in den meisten Repositories weiterhin standardmäßig deaktiviert bleibt.

## Ein roter Job sollte kein Durchscrollen des Logs bedeuten

Ohne zusätzliche Konfiguration liefert ein fehlgeschlagener MTP-Lauf auf einem GitHub-Runner einen Exit-Code ungleich null und eine Wand aus Konsolentext. Das neue Paket `Microsoft.Testing.Extensions.GitHubActionsReport` zusammen mit dem Schalter `--report-gh` ändert, was der Runner mit diesen Daten macht: Log-Gruppen pro Assembly, `::error`-Annotationen, die im Bereich **Files changed** des Pull Requests erscheinen, sobald die Quellcode-Position aufgelöst werden kann, eine Markdown-Zusammenfassung des Jobs, die an `GITHUB_STEP_SUMMARY` angehängt wird, und `::notice`-Einträge für langsame Tests.

Die Erweiterung bleibt untätig, solange die Umgebungsvariable `GITHUB_ACTIONS` nicht `true` ist, ein lokales `dotnet test` ist also nicht betroffen. Jede Teilfunktion ist nach dem Setzen von `--report-gh` standardmäßig aktiv und lässt sich einzeln abschalten:

```yaml
- name: Test
  run: dotnet test -- --report-gh --report-gh-slow-test-threshold 30s --report-trx
```

Der Schwellwert akzeptiert eine reine Sekundenzahl oder einen Wert mit Suffix wie `90s`, `2m` oder `1.5h`. Der Standard ist `60s`.

## Repository-weit statt pro Aufruf konfigurieren

Es gibt zwei Wege, um Flags nicht in jeden Workflow-Schritt zu kopieren. Ziehen Sie den gesamten Microsoft-Erweiterungssatz über `Directory.Build.props` in jedes Testprojekt:

```xml
<PropertyGroup>
  <TestingExtensionsProfile>AllMicrosoft</TestingExtensionsProfile>
</PropertyGroup>
```

Setzen Sie die Optionen anschließend deklarativ in `testconfig.json` neben dem Testprojekt:

```json
{
  "commandLineOptions": {
    "report-trx": true,
    "report-html": true,
    "report-azdo": true,
    "report-azdo-flaky-history": 14
  }
}
```

Liegt `Microsoft.Testing.Platform.MSBuild` im Abhängigkeitsgraph (es kommt transitiv mit den Runnern von MSTest, NUnit und xUnit), registrieren sich die Report-Provider bei der Paketinstallation automatisch. Manuelle Aufrufe von `builder.AddGitHubActionsProvider()` sind nur nötig, wenn Sie `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` setzen.

## TRX, das einen toten Testhost überlebt

Die Änderung, die ich zuerst ausrollen würde, ist überhaupt kein Flag. Seit MTP 2.3.0 werden TRX-Ergebnisse fortlaufend auf die Festplatte geschrieben, ein Testhost, der mitten in der Suite abstürzt, hinterlässt also weiterhin ein TRX mit allem, was vor dem Absturz erfasst wurde. Zuvor erzeugte dieses Szenario ein leeres Ergebnisverzeichnis und einen CI-Fehler ohne verwertbare Ausgabe, dieselbe Sackgasse, wegen der Teams [zu einem Binlog-MCP-Server für die Build-Triage greifen](/de/2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures/).

Auch der Standardname des TRX wurde in 2.3.0 deterministisch: `{asm}_{tfm}_{arch}.trx` statt `<UserName>_<MachineName>_<timestamp>.trx`. Das allein behebt eine ganze Klasse brüchiger Glob-Muster beim Artefakt-Upload.

## Regressionen von instabilen Tests in Azure DevOps trennen

Auf der Azure-DevOps-Seite fragt `--report-azdo-flaky-history 14` die Testergebnis-Historie der letzten N Tage ab (1 bis 90) und versieht Fehlschläge mit Kontext zur Instabilität. In Kombination mit `--report-azdo-demote-known-flaky` sinkt ein Fehlschlag, der den Instabilitätsschwellwert überschreitet (standardmäßig 25%), von Fehler auf Warnung, sodass eine echte Regression das Einzige bleibt, was auf der Seite rot ist.

HTML-, JUnit-XML- und CTRF-JSON-Reports kamen ebenfalls in 2.3.0 über `--report-html`, `--report-junit` und `--report-ctrf` hinzu. Alle drei sind als experimentell markiert, pinnen Sie Ihre MTP-Version also, bevor Sie sie an einen Pflicht-Check hängen. Die vollständigen Optionstabellen stehen in der [MTP-Dokumentation zu Testreports](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-test-reports).
