---
title: "Claude Code 2.1.259 bringt managedMcpServers: MCP-Server ohne MDM ausliefern"
description: "Bisher war managed-mcp.json der einzige Weg, allen Entwicklern dieselben MCP-Server zu geben: eine Datei in einem Systempfad, die die exklusive Kontrolle über MCP übernimmt. Claude Code 2.1.259 ergänzt eine managedMcpServers-Einstellung für HTTP- und SSE-Server und schränkt nebenbei ein, was allowedMcpServers steuert."
pubDate: 2026-09-03
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "de"
translationOf: "2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm"
translatedBy: "claude"
translationDate: 2026-09-03
---

Claude Code 2.1.259 erschien am 2026-09-02 mit einem einzeiligen Changelog-Eintrag, der ein Problem löst, das Administratoren seit Monaten umgehen mussten: eine verwaltete Einstellung `managedMcpServers`, mit der eine Organisation allen Benutzern HTTP- und SSE-MCP-Server bereitstellen kann. Dasselbe Release hat `allowedMcpServers` so geändert, dass die Liste nur noch die Server steuert, die Benutzer selbst hinzufügen. Zusammen ordnen diese beiden Zeilen die MCP-Governance neu, und die zweite entfernt eine Absicherung, auf die manche Teams heute setzen.

## Warum managed-mcp.json das falsche Werkzeug für "alle bekommen Sentry" war

Vor 2.1.259 gab es zwei Mechanismen, und keiner davon eignete sich zur Verteilung. Allowlists filtern, sie stellen nicht bereit: die [Dokumentation zu verwaltetem MCP](https://code.claude.com/docs/en/managed-mcp) sagt ausdrücklich, dass `allowedMcpServers` und `deniedMcpServers` "keine Registry sind" und dass ein Server erst von einem Benutzer, einem Plugin oder von `managed-mcp.json` hinzugefügt werden muss, bevor eine der beiden Listen überhaupt greift.

Bleibt `managed-mcp.json`. Diese Datei verteilt tatsächlich Server, bringt aber zwei schwere Bedingungen mit. Sie ist eine eigenständige Datei in einem Systempfad und erfordert daher Jamf, Intune, Group Policy oder etwas anderes mit Administratorrechten auf dem Rechner:

```json
{
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

Nach der Bereitstellung lädt Claude Code ausschließlich das, was die Datei definiert. Plugin-Server werden nicht mehr geladen. Mit `--mcp-config` übergebene Server werden abgelehnt. claude.ai-Konnektoren werden unterdrückt, sofern Sie nicht zusätzlich `allowAllClaudeAiMcps` setzen. Das ist ein Sperrmechanismus, der nebenbei Server verteilt, kein Verteilmechanismus. Und laut der [Dokumentation zu serververwalteten Einstellungen](https://code.claude.com/docs/en/server-managed-settings) "kann sie nicht über serververwaltete Einstellungen verteilt werden", eine Organisation ohne MDM hatte also überhaupt keinen Weg.

`managedMcpServers` ist ein Einstellungsschlüssel und keine eigenständige Datei. Damit läuft er über den normalen Kanal für verwaltete Einstellungen, einschließlich der claude.ai-Administrationskonsole:

```json
{
  "managedMcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

Die Beschränkung auf HTTP und SSE ist die interessante Design-Entscheidung. Ein stdio-Eintrag wäre ein argv-Array, das auf jedem Entwicklerrechner ausgeführt wird und über das Netzwerk von einem Server geliefert wurde. Die Begrenzung auf Remote-Transporte verhindert, dass eine Einstellungs-Payload zu Remote Code Execution wird.

## Die Allowlist ist keine Absicherung mehr

Die zweite Changelog-Zeile wiegt schwerer, als sie klingt. Die aktuelle Dokumentation sagt noch, dass `allowedMcpServers` und `deniedMcpServers` "auch für verwaltete Server gelten, sodass ein verwalteter Server, der sie nicht passiert, nicht geladen wird". In 2.1.259 steuert die Allowlist nur noch die Server, die Benutzer hinzufügen. Vom Administrator ausgerollte Server sind bereits eine Administratorentscheidung, eine erneute Prüfung gegen dessen eigene Allowlist war also redundant. Wenn Sie aber eine strikte `serverUrl`-Allowlist als zusätzliche Kontrolle über alles Geladene geschrieben haben, deckt sie den verwalteten Satz nicht mehr ab. Denylists sind unverändert und werden weiterhin über alle Ebenen zusammengeführt, das ist der Hebel, den Sie behalten sollten.

Die Einstellungsreferenz führt den neuen Schlüssel noch nicht, prüfen Sie die Form des Eintrags daher auf einem Rechner mit `claude mcp list`, bevor Sie ihn auf die gesamte Flotte ausrollen. Wer die Filterseite noch aufbaut, findet in [wie Sie zentral steuern, welche MCP-Server Ihr Team ausführen darf](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) die Matcher-Rangfolge, über die die meisten ersten Rollouts stolpern.

Alle Details im [Claude Code Changelog](https://code.claude.com/docs/en/changelog).
