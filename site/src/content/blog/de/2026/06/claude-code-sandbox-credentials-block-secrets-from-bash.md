---
title: "Claude Code 2.1.187 hindert die Sandbox daran, Ihre AWS-Schlüssel zu lesen"
description: "Die neue Option sandbox.credentials in Claude Code v2.1.187 verweigert das Lesen von Anmeldedatendateien und hebt geheime Umgebungsvariablen auf, bevor Bash-Befehle in der Sandbox laufen. Warum die Standard-Leserichtlinie ein Loch war und wie Sie es schließen."
pubDate: 2026-06-25
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "de"
translationOf: "2026/06/claude-code-sandbox-credentials-block-secrets-from-bash"
translatedBy: "claude"
translationDate: 2026-06-25
---

Die Bash-Sandbox von Claude Code hatte immer eine Asymmetrie, die zubeißt, sobald man das Kleingedruckte liest: Sie sperrt Schreibzugriffe streng ab, doch Lesezugriffe sind weit offen. Seit v2.1.187, veröffentlicht am 2026-06-24, gibt es endlich eine erstklassige Lösung. Die neue Option `sandbox.credentials` verweigert das Lesen bestimmter Anmeldedatendateien und entfernt geheime Umgebungsvariablen, bevor ein Befehl in der Sandbox ausgeführt wird.

## Warum die Standard-Leserichtlinie ein Loch war

Die Sandbox beschränkt Schreibzugriffe auf das Arbeitsverzeichnis und das temporäre Verzeichnis der Sitzung und leitet Netzwerkverkehr über einen Proxy mit Positivliste. Ihr Standard-Leseverhalten lautet jedoch "Lesezugriff auf den gesamten Computer, ausgenommen bestimmte gesperrte Verzeichnisse". Das umfasst ausdrücklich `~/.aws/credentials` und `~/.ssh/`. Hinzu kommt: Bash-Befehle in der Sandbox erben die Umgebung des übergeordneten Prozesses, sodass ein in Ihrer Shell exportiertes `GITHUB_TOKEN` oder `NPM_TOKEN` für jeden Befehl sichtbar ist, den Claude ausführt.

Das ist wichtig, weil die Netzwerkseite nicht dicht ist. Der integrierte Proxy trifft seine Erlaubnisentscheidung anhand des vom Client gelieferten Hostnamens und inspiziert TLS nicht. Erlauben Sie eine breite Domain wie `github.com`, hat ein kompromittierter oder per Prompt-Injection manipulierter Befehl einen plausiblen Exfiltrationsweg. Lesezugriff auf Ihre Schlüssel plus ein nutzbarer Ausgangskanal ist genau die Kombination, die Sie bei einem unbeaufsichtigt laufenden Agenten nicht wollen.

## Wie sandbox.credentials funktioniert

Der neue Block hat zwei Arrays, `files` und `envVars`. Aufgeführte Dateien werden für das Lesen innerhalb der Sandbox verweigert, dieselbe Durchsetzung, die `filesystem.denyRead` anwendet, und aufgeführte Umgebungsvariablen werden vor jeder Ausführung eines Sandbox-Befehls aufgehoben.

```json
{
  "sandbox": {
    "enabled": true,
    "credentials": {
      "files": [
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.ssh", "mode": "deny" }
      ],
      "envVars": [
        { "name": "GITHUB_TOKEN", "mode": "deny" },
        { "name": "NPM_TOKEN", "mode": "deny" }
      ]
    }
  }
}
```

Jeder Eintrag trägt `"mode": "deny"`, derzeit der einzige unterstützte Wert. Das explizite Feld hält das Schema für künftige Modi offen. Dateipfade folgen denselben Präfixregeln wie der Rest von `sandbox.filesystem.*`: `~/` ist Ihr Home-Verzeichnis, `/` ist absolut und ein Pfad ohne Präfix ist projektrelativ.

## Warum der eigene Block und nicht nur denyRead

Anmeldedaten-Lesezugriffe ließen sich bereits mit `filesystem.denyRead` verweigern. Der Sinn des neuen Blocks ist, dass er Dateisperren mit der Aufhebung von Umgebungsvariablen gruppiert und über alle Konfigurationsbereiche hinweg zusammenführt. Einträge aus Benutzer-, Projekt- und verwalteten Einstellungen werden kombiniert, und da `deny` der einzige Modus ist, kann jeder Bereich Einschränkungen hinzufügen, aber keiner sie entfernen.

Das macht ihn zu einem sauberen Hebel für verwaltete Bereitstellungen. Verteilen Sie aus Ihrem MDM die Sperren für `~/.aws` und `~/.ssh` plus die Aufhebung von Tokens, und Entwickler können sie lokal nicht ausweiten. Er passt natürlich zu einer abgeriegelten Richtlinie: `enabled: true`, `failIfUnavailable: true` und `allowUnsandboxedCommands: false`.

## Zwei Vorbehalte, die man kennen sollte

Es gibt keine integrierte Sperrliste. Nur die Dateien und Variablen, die Sie benennen, werden eingeschränkt, eine leere Konfiguration schützt also nichts. Die Option betrifft zudem nur Bash-Befehle in der Sandbox. Um die Anmeldedaten von Anthropic und der Cloud-Anbieter aus allen Subprozessen unabhängig von der Sandbox zu entfernen, setzen Sie stattdessen die Umgebungsvariable `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.

Wenn Sie Claude Code im Auto-Allow-Modus gegen ein Repository ausführen, dem Sie nicht vollständig vertrauen, ist dies die Option, die Sie heute hinzufügen sollten. Alle Einzelheiten finden Sie in der [Sandbox-Dokumentation](https://code.claude.com/docs/en/sandboxing).
