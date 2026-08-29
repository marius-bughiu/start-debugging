---
title: "Claude Code 2.1.251 schließt vier Wege an der Berechtigungsprüfung vorbei"
description: "Ein Symlink, der nach der Prüfung ausgetauscht wird, Deny-Regeln, die über einen Symlink-Suchpfad nicht mehr griffen, ein Marketplace-Kommando außerhalb seines Plugins und ein Workflow-Skript, das vor der Freigabe gelesen wurde. Vier Fixes in einem Release, alle derselbe Bug."
pubDate: 2026-08-29
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
  - "devops"
lang: "de"
translationOf: "2026/08/claude-code-2-1-251-four-ways-around-the-permission-check"
translatedBy: "claude"
translationDate: 2026-08-29
---

Claude Code 2.1.251 ist am 28. August 2026 erschienen, mit einem Changelog, das lang genug ist, um das Interessante zu begraben. Vier seiner Fixes haben dieselbe Form: Etwas hat eine Datei erreicht, die die Berechtigungsprüfung nicht freigegeben hatte. Zusammen gelesen wirken sie nicht mehr wie vier Bugs, sondern wie eine Klasse.

## Die Prüfung ging durch, dann änderte sich der Pfad

Der wichtigste Fix ist ein lehrbuchreifes Time-of-check-to-time-of-use-Rennen. Laut Changelog folgten die Datei-Tools "einem Symlink, der nach der Berechtigungsprüfung innerhalb des Arbeitsverzeichnisses ausgetauscht wurde", und konnten "außerhalb des freigegebenen Ortes lesen oder schreiben". Du gibst eine Änderung an `src/config.ts` frei, der Pfad wird aufgelöst, die Prüfung sagt ja — und zwischen diesem Ja und dem Schreibvorgang wird der Eintrag zu einem Symlink, der woanders hinzeigt.

Wichtig ist, wer diesen Austausch vornehmen kann. Ein `postinstall`-Skript, ein File Watcher, ein Dev-Server, ein Test-Runner oder das eigene vorherige Bash-Kommando des Agents laufen, während die Sitzung offen ist. Das Arbeitsverzeichnis ist kein ruhiger Ort, und es war nie ein vertrauenswürdiger.

Grep und Glob hatten die Lese-Variante desselben Lochs: `Read(...)`-Deny-Regeln wurden nicht auf Dateien angewandt, die über einen Symlink-Suchpfad erreicht wurden. Eine Deny-Regel auf `secrets/**` hielt beim direkten Lesen und hörte still auf zu halten, sobald dieselbe Datei über einen hineinzeigenden Symlink gefunden wurde.

## Zwei Pfade, die aus der Konfiguration kamen, nicht von dir

Die anderen beiden kamen über Dateien herein, die mit einem Repository mitreisen. Plugin-Kommandos, die in einem Marketplace-Eintrag deklariert sind, konnten außerhalb des Plugin-Verzeichnisses liegen; solche Pfade werden jetzt mit einem expliziten Path-Traversal-Fehler abgelehnt. Und das Workflow-Tool las einen `scriptPath` außerhalb dessen, was die Sitzung lesen durfte, *bevor* die Berechtigungsprüfung lief — und zitierte den Inhalt anschließend in seiner Fehlermeldung, was aus einem blockierten Lesevorgang einen erfolgreichen macht.

## Dasselbe Release zieht die Einstellungen weiter an

Ein halbes Dutzend weiterer Änderungen in 2.1.251 zeigen in dieselbe Richtung und behandeln ein geklontes Repository durchweg als nicht vertrauenswürdige Eingabe:

- Projekteinstellungen können detailliertes Beta-Tracing und das Loggen roher API-Bodies nicht mehr einschalten. Das waren deine Request-Bodies.
- `ANTHROPIC_CUSTOM_HEADERS` aus verwalteten oder Projekteinstellungen braucht jetzt eine Freigabe, wenn es einen Credential-, Org/Tenant-, Routing- oder API-Verhaltens-Header wie `Authorization` oder `Host` setzt.
- Das `env` in `.claude/settings.json` auf Projektebene setzt `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` und `TMPDIR`/`TMP`/`TEMP` nicht mehr — setze sie in deiner Shell oder in den Benutzer- bzw. verwalteten Einstellungen.
- Die Bash-Berechtigungsprüfungen genehmigen keine Zuweisungen eines arithmetischen Ausdrucks an eine ganzzahlige Shell-Variable mehr automatisch (`OPTIND=1/0`, `RANDOM=2+2`), die bislang als harmlos durchrutschten.
- Servergesteuerte Einstellungen, die das TLS der Sandbox terminieren, ihren Verkehr über einen Proxy leiten, Credentials einschleusen oder die Sandbox-Isolation schwächen, brauchen jetzt eine Freigabe, bevor sie greifen.

Keine davon ist für sich ein dramatischer Exploit. Zusammen schließen sie die Lücke zwischen "das Berechtigungssystem hat nein gesagt" und "die Datei blieb ungelesen".

## Aktualisieren

`claude update`, oder per npm neu installieren. Zwei Notizen aus derselben Woche: 2.1.250 kam am selben Tag und enthält nur Bugfixes, und 2.1.248 (27. August) brachte `--restricted` — gleichbedeutend `CLAUDE_CODE_RESTRICTED=1` — das die Werkzeuge entfernt, die Kommandos oder Code ausführen, `WebFetch` streicht, sofern du es nicht in `--tools` nennst, Datei-Tools im Arbeitsverzeichnis hält, `bypassPermissions` verweigert und Benutzer-, Projekt- und lokale Einstellungsdateien vollständig ignoriert. Dieses Flag und die Fixes dieser Woche sind dasselbe Argument aus zwei Richtungen: Die Einstellungen und Pfade, die ein Repository dir reicht, sind Eingabe, keine Konfiguration.

Der Marketplace-Fix kommt dabei eine Woche, nachdem 2.1.238 Katalogen echte Reichweite gab und [einem Plugin-Marketplace erlaubte, eigene Auth-Header auszustellen](/de/2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers/) — je mehr ein Marketplace-Eintrag kann, desto besser muss die Verzeichnisgrenze um ihn herum halten.
