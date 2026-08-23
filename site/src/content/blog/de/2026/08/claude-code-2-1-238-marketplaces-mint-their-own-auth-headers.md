---
title: "Claude Code 2.1.238 lässt einen Plugin-Marketplace eigene Auth-Header erzeugen"
description: "Ein Feld headersHelper an url-Marketplaces und an Katalogeinträgen führt einen lokalen Befehl aus, der HTTP-Header ausgibt. Damit kann sich ein interner Plugin-Katalog hinter S3 oder einem Artefakt-Repository mit einem kurzlebigen Token authentifizieren. Hier sind das Schema, die Zustimmungsabfrage und die Header-Namen, die Claude Code verwirft."
pubDate: 2026-08-23
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
  - "security"
lang: "de"
translationOf: "2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers"
translatedBy: "claude"
translationDate: 2026-08-23
---

Die Verteilung interner Claude-Code-Plugins setzte bisher ein git-Repository voraus, gegen das sich der Client bereits authentifizieren kann. Claude Code 2.1.238, am 2026-08-20 auf npm veröffentlicht, hebt diese Einschränkung auf: Ein Marketplace kann jetzt einen lokalen Befehl ausführen, der HTTP-Header ausgibt, und diese Header gehen mit dem Katalogabruf und mit den Plugin-Downloads hinaus. Ich habe das Schema gegen den Windows-Build 2.1.239 geprüft (commit `9bf8e95`, gebaut am 2026-08-21), in dem `headersHelper` erstmals in den Marketplace- und Katalogschemata auftaucht. In 2.1.224 existierte das Feld nur an MCP-Serverdefinitionen.

## Ein Befehl, ein JSON-Objekt aus Headern

Das Feld sitzt an einem Marketplace mit Quelle `url`, neben der bereits vorhandenen statischen `headers`-Map:

```json
{
  "source": {
    "source": "url",
    "url": "https://artifacts.internal/claude/marketplace.json",
    "headersHelper": "/usr/local/bin/mint-artifact-token"
  }
}
```

Der Befehl gibt ein JSON-Objekt aus, seine Ausgabe hat Vorrang vor `headers`, und er läuft bei jeder Aktualisierung dieses Marketplace erneut. Zwei Details fallen in der Praxis ins Gewicht. Er läuft aus einem festen Verzeichnis, dem Konfigurationsverzeichnis von Claude und nicht dem Arbeitsverzeichnis der Sitzung, also verwenden Sie einen über `PATH` auflösbaren Befehl oder einen absoluten Pfad. Und seine Header werden von Archiv-Downloads gleicher Herkunft geerbt, was das Verfahren zusammen mit der Plugin-Quelle `archive` nützlich macht: ein einfaches ZIP über HTTPS auf S3, GitLab oder nginx, ohne git und ohne npm auf dem Client. Kombinieren Sie das mit `sha256` am Eintrag, das bei jedem Download geprüft wird und die Installation bei Abweichung verweigert.

## Helper pro Eintrag müssen ihr Manifest einbetten

Ein Katalogeintrag kann einen eigenen `headersHelper` tragen, der den des Marketplace überschreibt. Dieser läuft nur, wenn ein Benutzer das Plugin ausdrücklich installiert oder aktualisiert, nie beim Durchsehen des Katalogs, und er bringt eine Regel mit, gegen die Sie sofort laufen, wenn Sie sie überspringen:

```text
Plugin "internal-tools" sets headersHelper but is not "strict": false. An entry
with headersHelper must inline its full manifest (strict: false, with
commands/agents/hooks/mcpServers declared in the entry) so users can review what
it ships before the command runs
```

Die Zustimmung muss allein aus dem Eintrag heraus informiert erfolgen, bevor irgendein Befehl ausgeführt wird. Bei der Installation sehen Sie das Ziel und den Befehl wörtlich: "runs a local command and sends its output as headers to:", gefolgt von der URL und der Befehlszeile. `claude plugin install -y` akzeptiert den angezeigten Befehl ohne Abfrage und ist erforderlich, wenn stdin kein TTY ist.

## Header, die Sie nicht fälschen dürfen

Nicht jeder Header-Name überlebt. Alles, was außerhalb operatorseitig verwalteter Einstellungen deklariert wird, läuft gegen eine Sperrliste mit `host`, `cookie`, `forwarded`, `connection`, `transfer-encoding`, `content-length`, `via`, der Client-IP-Familie (`x-real-ip`, `true-client-ip`, `cf-connecting-ip` und Verwandte) sowie den Präfixen `x-forwarded-`, `x-original-` und `proxy-`. Die Namen werden zuvor in Kleinbuchstaben umgewandelt und Unterstriche zu Bindestrichen normalisiert, `X_Real_IP` rutscht also nicht durch. Ein verworfener Header erzeugt eine Warnung, statt den Abruf scheitern zu lassen.

Administratoren schalten den gesamten Mechanismus mit `disableCommandPluginSources` oder `allowManagedHooksOnly` in den verwalteten Einstellungen ab. Dann wird die Installation verweigert, und der Befehl läuft nie. Das ist dieselbe Richtung wie [das Laden von Plugins aus .zip-Archiven in 2.1.128](/de/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): weniger Annahmen darüber, was Ihr Client erreichen kann. Der [Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) enthält den Eintrag zur Version, die [Marketplace-Dokumentation](https://code.claude.com/docs/en/plugin-marketplaces) hat noch nicht nachgezogen.
