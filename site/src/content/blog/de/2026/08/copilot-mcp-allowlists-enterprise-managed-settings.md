---
title: "MCP-Allowlists kommen in die Enterprise Managed Settings von Copilot"
description: "Das GitHub-Changelog vom 6. August 2026 ergänzt copilot/managed-settings.json um allowedMcpServers und deniedMcpServers. Matcher über URL und argv, Vorrang der Verweigerung und ein Standardverhalten, das fail closed ist und dem namensbasierten Registry gefehlt hat."
pubDate: 2026-08-09
tags:
  - "github-copilot"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "de"
translationOf: "2026/08/copilot-mcp-allowlists-enterprise-managed-settings"
translatedBy: "claude"
translationDate: 2026-08-09
---

Am 2026-08-06 hat GitHub [MCP allowlists in enterprise managed settings](https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings/) veröffentlicht. Zwei Schlüssel, `allowedMcpServers` und `deniedMcpServers`, entscheiden nun, welche Model-Context-Protocol-Server ein Copilot-Client starten darf. Die Funktion ist allgemein verfügbar und gilt für die GitHub Copilot App, Copilot CLI und VS Code.

Damit schließt sich eine Lücke, die seit der breiten Einführung von MCP offen war. Die bisherige Antwort auf Unternehmensebene war das [eigene MCP-Registry](https://docs.github.com/en/copilot/concepts/mcp-management), weiterhin in der Public Preview, das Server über Name oder ID zuordnet. Namen sind vom Benutzer vergebene Labels, also benennt jemand einen gesperrten Server einfach lokal um. Die GitHub-Dokumentation benennt die Konsequenz deutlich: Benutzer können die Einschränkung umgehen, indem sie Konfigurationsdateien bearbeiten.

## Die Matcher sind der eigentliche Kern

Die Datei liegt im Repository `.github-private` des Unternehmens unter `copilot/managed-settings.json` auf dem Standardbranch. Jeder Eintrag identifiziert einen Server über genau einen Matcher.

```json
{
  "allowedMcpServers": [
    { "serverUrl": "https://api.githubcopilot.com/*" },
    { "serverCommand": ["npx", "@playwright/mcp@latest"] },
    { "serverCommand": ["cmd", "/c", "uvx", "markitdown-mcp"] }
  ],
  "deniedMcpServers": [
    { "serverUrl": "https://learn.microsoft.com/*" }
  ]
}
```

Beachten Sie: `serverCommand` ist ein argv-Array, keine Shell-Zeichenkette, und der Abgleich erfolgt exakt. `serverUrl` unterstützt `*` als Platzhalter, und die URL wird vor dem Vergleich kanonisiert, sodass Tricks mit Kodierung oder abschließendem Schrägstrich kein anderes Ergebnis liefern. `serverName` existiert weiterhin, aber nur als Rückfallebene: Bei einem Remote-Server muss die Übereinstimmung aus einem `serverUrl`-Eintrag stammen, und `serverName` zählt nur, wenn überhaupt kein `serverUrl`-Eintrag vorhanden ist. Zwischen stdio-Servern und `serverCommand` gilt dasselbe Verhältnis. Das ist eine Bequemlichkeit, keine Sicherheitsgrenze.

## Die Standardwerte sind fail closed

Der Unterschied zwischen leer und nicht gesetzt ist die Stelle, an der Teams stolpern:

- `allowedMcpServers` nicht gesetzt erlaubt jeden Server, der nicht zu den Standardservern gehört.
- `allowedMcpServers: []` blockiert sie alle. Das ist der Schalter für Deny-all.
- `deniedMcpServers` nicht gesetzt oder leer blockiert nichts.
- Die Verweigerung gewinnt immer. Ein Server, der auf beide Listen passt, wird blockiert.
- Erstanbieter-Server wie der eingebaute GitHub-MCP-Server sind von beiden Listen ausgenommen.

Zusätzlich wird eine fehlerhafte oder nicht überprüfbare Konfiguration blockiert statt erlaubt, und wenn Richtlinien aus mehreren Schichten kommen, muss ein Server jede Schicht passieren. Das ist das umgekehrte Fehlverhalten gegenüber dem Registry und der eigentliche Grund für die Migration.

Teams, die eine eigene Liste brauchen, packen die Matcher-Objekte auf Unternehmensebene unter `overridable` und verwenden dann die normale Syntax in der Datei des jeweiligen Teams. Bei Konflikten gewinnt die Entscheidung der Plattform.

## Ergänzend zur Egress-Kontrolle, nicht als Ersatz

Eine Allowlist regelt, welche Serverprozesse starten und mit welchen MCP-Endpunkten gesprochen wird. Sie sagt nichts darüber aus, wohin ein Tool sich verbindet, sobald es läuft. Das ist eine eigene Kontrollfläche und wird in [Netzwerk-Egress eines Coding-Agents absichern](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) behandelt. Zwei Schichten, zwei Fehlermodi.

Die vollständige Matcher-Syntax steht in der [Enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference).
