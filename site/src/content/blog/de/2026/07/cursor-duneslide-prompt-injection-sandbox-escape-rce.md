---
title: "DuneSlide: Zwei Cursor-Bugs, die Prompt Injection in Zero-Click-RCE verwandeln"
description: "Cato AI Labs hat CVE-2026-50548 und CVE-2026-50549 offengelegt, ein Paar von Schwachstellen mit CVSS 9.8 in Cursors Terminal-Sandbox. Eine vergiftete MCP-Antwort oder ein vergiftetes Web-Ergebnis kann die Sandbox verlassen und Code ausführen. Cursor 3.0 ist die Lösung."
pubDate: 2026-07-03
tags:
  - "cursor"
  - "ai-agents"
  - "security"
  - "prompt-injection"
  - "mcp"
lang: "de"
translationOf: "2026/07/cursor-duneslide-prompt-injection-sandbox-escape-rce"
translatedBy: "claude"
translationDate: 2026-07-03
---

Cato AI Labs hat diese Woche [ein Paar kritischer Cursor-Schwachstellen offengelegt](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/), geführt als CVE-2026-50548 und CVE-2026-50549 und gemeinsam DuneSlide genannt. Beide tragen einen CVSS-Wert von 9.8, und beide erlauben es, dass ein einziges Stück eingeschleusten Textes aus Cursors Terminal-Sandbox ausbricht und beliebige Befehle auf Ihrem Rechner ausführt. Kein Klick, kein Bestätigungsdialog, kein bösartiges Repository, das Sie von Hand geklont haben. Alle Versionen vor Cursor 3.0 sind betroffen.

Der Zustellungsvektor ist es, der dies auch dann beachtenswert macht, wenn Sie Cursor nicht verwenden: Prompt Injection als Primitive für die Remotecodeausführung. Der Angreifer berührt Ihren Editor nie. Er platziert Anweisungen in etwas, das Ihr Agent in Ihrem Namen liest, etwa der Antwort eines Model-Context-Protocol-Servers (MCP) oder einer von einer Websuche zurückgegebenen Seite, und der Agent erledigt den Rest.

## Die Sandbox vertraute den eigenen Parametern des Agenten

Cursor führt Shell-Befehle innerhalb einer Sandbox aus, die Schreibvorgänge auf Ihr Projektverzeichnis beschränkt. Das Problem bei CVE-2026-50548 ist, dass die Liste der erlaubten Schreibvorgänge teilweise vom Agenten kontrolliert wird. Das Tool `run_terminal_cmd` nimmt einen optionalen Parameter `working_directory` entgegen, und wenn der Agent ihn setzt, fügt Cursor diesen Pfad ohne Nachfrage zur Schreibmenge hinzu.

So kann eine eingeschleuste Anweisung das Modell zu einem Aufruf dieser Form lenken:

```json
{
  "tool": "run_terminal_cmd",
  "command": "cp payload ~/.zshrc",
  "working_directory": "/Users/you"
}
```

Die Sandbox sieht ein "legitimes" Arbeitsverzeichnis und gewährt den Schreibvorgang. Nun kann der Angreifer eine Datei in Ihrem Home-Verzeichnis ablegen, und `~/.zshrc`, `~/.zshenv` oder `~/Library/LaunchAgents` werden bei Ihrer nächsten Shell oder Anmeldung zur Ausführung.

## Die Symlink-Prüfung fiel offen aus

CVE-2026-50549 greift die Schutzvorkehrung direkt an. Vor dem Schreiben kanonisiert Cursor die Symlinks, um zu bestätigen, dass das echte Ziel innerhalb Ihres Projekts liegt. Der Bug liegt im Fallback. Wenn die Kanonisierung fehlschlägt, weil das Ziel nicht existiert oder der Angreifer die Leseberechtigung eines Verzeichnisses im Pfad entfernt hat, gibt Cursor auf und vertraut dem projektinternen Pfad des Symlinks.

Das ist ein klassisches Fail-Open. Ein reiner Schreib-Symlink, der auf Cursors eigenen Sandbox-Helfer `cursorsandbox` zeigt, kommt durch die Prüfung und erlaubt es einem Angreifer, genau die Binärdatei zu überschreiben, die den Agenten eigentlich einhegen soll.

## Warum "vertrauenswürdige" Agenten-Tools die neue Angriffsfläche sind

Die unbequeme Lektion ist, dass `run_terminal_cmd` kein Benutzer ist, der Befehle tippt. Es ist ein Tool, das das Modell mit Argumenten aufruft, die das Modell gewählt hat, und diese Argumente stammen aus Text, den das Modell gelesen hat. Sobald Sie akzeptieren, dass jeder in das Kontextfenster fließende Inhalt potenziell feindlich ist, sieht ein Parameter wie `working_directory` nicht mehr wie Konfiguration aus, sondern wie Angreifer-Eingabe.

Beide Bugs sind in [Cursor 3.0](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/) behoben, die unmittelbare Lösung ist also, zu aktualisieren und zu bestätigen, dass Sie auf 3.0 oder neuer sind. Die längerfristige Lektion überlebt den Patch: Behandeln Sie MCP-Ausgaben und abgerufene Web-Inhalte als nicht vertrauenswürdig, und begrenzen Sie die Berechtigungen der Agenten-Tools, als wäre der Prompt bereits kompromittiert, denn DuneSlide zeigt, dass er es sein kann.
