---
title: "Die Dynamic Workflows von Claude Code verteilen einen einzigen Prompt auf bis zu 1000 Subagenten"
description: "Anthropic veröffentlichte Opus 4.8 am 2026-05-28 mit Dynamic Workflows, einer Forschungs-Vorschau in Claude Code, die ein JavaScript-Orchestrierungsskript schreibt, um Dutzende bis Hunderte von Subagenten parallel auszuführen, begrenzt auf 1000 pro Lauf."
pubDate: 2026-05-31
tags:
  - "claude-code"
  - "ai-agents"
  - "opus-4-8"
lang: "de"
translationOf: "2026/05/claude-code-dynamic-workflows-opus-4-8"
translatedBy: "claude"
translationDate: 2026-05-31
---

Anthropic veröffentlichte Claude Opus 4.8 am 2026-05-28, und die Schlagzeile für alle, die in einem Terminal leben, ist nicht der Sprung in den Benchmarks. Es sind die Dynamic Workflows: eine Forschungs-Vorschau in Claude Code, die eine einzelne Anfrage in natürlicher Sprache in ein Skript verwandelt, das Dutzende bis Hunderte von Subagenten parallel orchestriert, begrenzt auf 1000 Agenten pro Lauf. Das ist der Unterschied dazwischen, einen Agenten in einer Schleife eine Aufgabe abarbeiten zu lassen, und Claude ein Programm schreiben zu lassen, das die Aufgabe zerlegt, verteilt und die Ergebnisse prüft, bevor es zurückmeldet.

## Ein Workflow ist ein Skript, keine Chat-Schleife

Der Mechanismus ist der interessante Teil. Wenn Sie etwas Großes anfordern ("prüfe jeden Controller auf fehlende Autorisierungsprüfungen" oder "migriere diese Codebasis mit 200k Zeilen weg von Newtonsoft.Json"), schreibt Claude ein JavaScript-Orchestrierungsskript, und eine Laufzeit führt es im Hintergrund aus. Sie betreuen kein einzelnes Kontextfenster, das sich langsam füllt. Das Skript erzeugt frische Subagenten, jeder mit eigenem Kontext, und sammelt deren strukturierte Ausgabe.

Die Form des generierten Skripts sieht ungefähr so aus:

```javascript
export const meta = {
  name: 'audit-authz',
  description: 'Find controllers missing [Authorize] and verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Verify' }],
};

// Fan out: one finder per area, then adversarially verify each hit
const findings = await pipeline(
  AREAS,
  area => agent(`Scan ${area} for actions missing authorization`, {
    phase: 'Scan',
    schema: FINDINGS_SCHEMA,
  }),
  review => parallel(review.findings.map(f => () =>
    agent(`Try to refute: ${f.title}. Is this really unprotected?`, {
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    }).then(v => ({ ...f, verdict: v }))
  ))
);

return findings.flat().filter(f => f.verdict?.isReal);
```

Die Muster, auf die sich Anthropic stützt, sind hier sichtbar: paralleles Verteilen, dann adversariale Verifikation, bei der separate Agenten dazu aufgefordert werden, jeden Befund zu widerlegen, bevor er Bestand hat. Die Ausgabe wird gegen ein JSON-Schema validiert, sodass der Orchestrator typisierte Daten zurückbekommt statt Prosa, die er parsen muss.

## Was es Sie kostet und wann es ausgelöst wird

Das offensichtliche Risiko sind die Kosten. Ein Lauf, der berechtigterweise Hunderte von Agenten startet, verbrennt schnell Tokens, was genau der Grund ist, warum die Grenze von 1000 Agenten als Sicherung gegen ein Durchgehen existiert. Claude Code zeigt Ihnen das Skript und den groben Plan, bevor der erste Workflow startet, und bittet um Ihre Bestätigung.

Es gibt zwei Wege hinein. Sie können das Ziel direkt beschreiben und Claude entscheiden lassen, dass ein Workflow gerechtfertigt ist, oder Sie schalten die Aufwandseinstellung `ultracode` ein, damit Claude bei umfangreichen Aufgaben automatisch zur Orchestrierung greift. Opus 4.8 bringt außerdem einen günstigeren Fast mode (etwa 2x die Standardrate für ungefähr 2,5x die Geschwindigkeit), was das Muster vieler kleiner Agenten weniger schmerzhaft macht, als es in früheren Releases gewesen wäre.

Dynamic Workflows ist eine Forschungs-Vorschau, behandeln Sie die API-Oberfläche also als instabil und behalten Sie Ihre Nutzung im Auge. Aber das zugrunde liegende Modell ist solide: Hören Sie auf, einen Agenten gegen ein wachsendes Transkript zu iterieren, und beginnen Sie, Programme zu schreiben, die viele kurzlebige Agenten koordinieren. Alle Details finden Sie in der [Opus-4.8-Ankündigung](https://www.anthropic.com/news) und im [Claude-Code-Changelog](https://code.claude.com/docs/en/changelog).
