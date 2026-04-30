---
title: "cowork-terminal-mcp: Host-Terminal-Zugriff für Claude Cowork in einem einzigen MCP-Server"
description: "cowork-terminal-mcp v0.4.1 verbindet die isolierte VM von Claude Cowork mit Ihrer Host-Shell. Ein Tool, stdio-Transport, fest verdrahtetes Git Bash unter Windows."
pubDate: 2026-04-29
tags:
  - "mcp"
  - "claude-cowork"
  - "claude-code"
  - "ai-coding-agents"
lang: "de"
translationOf: "2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork"
translatedBy: "claude"
translationDate: 2026-04-29
---

[Claude Cowork](https://www.anthropic.com/claude-cowork) läuft in einer isolierten Linux-VM auf Ihrem Rechner. Diese Isolation macht es angenehm, Cowork unbeaufsichtigt laufen zu lassen, bedeutet aber zugleich, dass der Agent die Abhängigkeiten Ihres Projekts nicht installieren, Ihren Build nicht ausführen und auch keinen Commit in Ihr Host-Repository pushen kann. Ohne Brücke endet der Agent an der Dateisystemgrenze der VM. [`cowork-terminal-mcp`](https://github.com/marius-bughiu/cowork-terminal-mcp) v0.4.1 ist genau diese Brücke: ein [MCP](https://modelcontextprotocol.io/)-Server mit einem einzigen Zweck, der auf dem Host läuft, ein einziges Tool (`execute_command`) bereitstellt und es dabei belässt. Insgesamt sind es etwa 200 Zeilen TypeScript, ausgeliefert über npm als [`cowork-terminal-mcp`](https://www.npmjs.com/package/cowork-terminal-mcp).

## Das eine Tool, das der Server bereitstellt

`execute_command` ist die gesamte Oberfläche. Das Zod-Schema liegt in [`src/tools/execute-command.ts`](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/src/tools/execute-command.ts) und akzeptiert vier Parameter:

| Parameter | Typ                        | Standardwert        | Beschreibung                                                  |
|-----------|----------------------------|---------------------|---------------------------------------------------------------|
| `command` | `string`                   | erforderlich        | Der auszuführende bash-Befehl                                 |
| `cwd`     | `string`                   | Home-Verzeichnis    | Arbeitsverzeichnis (bevorzugt gegenüber `cd <path> &&`)       |
| `timeout` | `number`                   | `30000` ms          | Wie lange gewartet wird, bevor der Lauf abgebrochen wird      |
| `env`     | `Record<string, string>`   | geerbt              | Zusätzliche Umgebungsvariablen über `process.env` gelegt      |

Zurückgegeben wird ein JSON-Objekt mit `stdout`, `stderr`, `exitCode` und `timedOut`. Die Ausgabe ist auf 1MB pro Stream begrenzt; bei Erreichen der Obergrenze wird ein Suffix `[stdout truncated at 1MB]` (oder `stderr`) angehängt.

Warum nur ein Tool? Weil sich jede Anfrage nach "liste die Dateien", "führe die Tests aus" oder "was sagt git status" auf einen Shell-Befehl reduziert. Ein zweites Tool wäre lediglich ein dünnerer Wrapper um denselben `spawn`. Der MCP-Katalog bleibt klein, das Modell greift nicht zum falschen Tool, und die Angriffsfläche auf dem Host bleibt trivial zu auditieren.

## Anbindung an Claude Cowork

Claude Cowork liest MCP-Server aus der **Claude-Desktop**-Konfiguration und reicht sie in seine isolierte VM weiter. Die Konfigurationsdatei liegt an einem von drei Orten:

- **Windows (Microsoft-Store-Installation):** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows (Standard-Installation):** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Die minimale Konfiguration:

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "npx",
      "args": ["-y", "cowork-terminal-mcp"]
    }
  }
}
```

Unter Windows umschließen Sie den Befehl mit `cmd /c`, damit `npx` korrekt aufgelöst wird (Claude Desktop startet Befehle über eine PowerShell-kompatible Schicht, die die npm-Shims nicht immer findet):

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cowork-terminal-mcp"]
    }
  }
}
```

Für Claude-Code-CLI-Nutzer dient derselbe Server zugleich als Notausgang in das Host-Terminal und wird mit einer einzigen Zeile registriert:

```bash
claude mcp add cowork-terminal -- npx -y cowork-terminal-mcp
```

Die einzige Voraussetzung ist bash. Unter macOS und Linux genügt die System-Shell. Unter Windows muss [Git for Windows](https://git-scm.com/download/win) installiert sein, und der Server hat eine klare Meinung dazu, welches `bash.exe` er akzeptiert. Das ist der nächste interessante Punkt.

## Die Git-Bash-Falle unter Windows

`spawn("bash")` unter Windows sieht harmlos aus und ist fast immer falsch. Die PATH-Reihenfolge unter Windows platziert `C:\Windows\System32` weit vorn, und `System32\bash.exe` existiert auf den meisten modernen Windows-Installationen. Diese Binärdatei ist der WSL-Launcher. Wenn der MCP-Server ihm einen Befehl übergibt, läuft dieser in einer Linux-VM, die das Windows-Dateisystem nicht so sieht wie der Host, den Windows-`PATH` nicht lesen kann und keine Windows-`.exe`-Dateien ausführt. Das sichtbare Symptom ist kurios: `dotnet --version` liefert "command not found", obwohl das .NET-SDK eindeutig installiert und im `PATH` ist. Das Gleiche gilt für `node`, `npm`, `git` und jedes Windows-eigene Werkzeug, nach dem der Agent greift.

`cowork-terminal-mcp` löst das beim Start. `resolveBashPath()` überspringt unter Windows die PATH-Suche vollständig und geht eine feste Liste von Git-Bash-Installationsorten durch:

```typescript
const candidates = [
  path.join(programFiles, "Git", "bin", "bash.exe"),
  path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
];
```

Der erste Kandidat, den `existsSync` bestätigt, gewinnt; der aufgelöste absolute Pfad ist das, womit `spawn` aufgerufen wird. Existiert keiner, wirft der Server beim Modul-Laden eine Exception, deren Fehlermeldung jeden geprüften Pfad nennt und auf `https://git-scm.com/download/win` verweist. Es gibt keinen Fallback auf das System32-bash und keine stille Verschlechterung.

Die übergeordnete Lehre: Unter Windows ist "auf den PATH vertrauen" ein Eigentor, sobald das Verhalten einer bestimmten Binärdatei zählt. Lösen Sie über den absoluten Pfad auf, oder scheitern Sie laut. Die Korrektur kam ausdrücklich in v0.4.1, weil Nutzer beobachteten, wie der Agent darauf bestand, `dotnet` fehle, obwohl es offensichtlich installiert war.

## Timeouts, Ausgabegrenzen und die Ein-Shell-Regel

Im Executor finden sich drei weitere Entscheidungen, alle bewusst getroffen.

**AbortController statt Shell-Timeout.** Wenn ein Befehl seinen `timeout` überschreitet, umschließt der Server den bash-Aufruf nicht in `timeout 30s ...`. Stattdessen ruft er `abortController.abort()` auf, was Node.js in das Beenden des Prozesses übersetzt. Der Kindprozess löst ein `error`-Ereignis aus, dessen `name` `AbortError` ist; der Handler räumt den Timer auf, und das Tool resolvt mit `exitCode: null` und `timedOut: true`:

```typescript
const timer = setTimeout(() => {
  abortController.abort();
}, options.timeout);

child.on("error", (error) => {
  clearTimeout(timer);
  if (error.name === "AbortError") {
    resolve({ stdout, stderr, exitCode: null, timedOut: true });
  } else {
    reject(error);
  }
});
```

Dadurch bleibt die Timeout-Mechanik außerhalb der Befehlszeichenkette des Nutzers und verhält sich unter Windows und Unix identisch.

**1MB-Obergrenze pro Stream, fest eingebaut.** `stdout` und `stderr` werden in JavaScript-Strings akkumuliert, doch jedes `data`-Ereignis ist an `length < MAX_OUTPUT_SIZE` (1.048.576 Byte) gekoppelt. Sobald die Grenze erreicht ist, werden weitere Daten verworfen und ein Flag gesetzt. Die finale Ergebniszeichenkette erhält das Suffix `[stdout truncated at 1MB]`. Das ist der Preis für Pufferung statt Streaming: Das Modell bekommt ein sauberes, strukturiertes Ergebnis, aber `tail -f some.log` ist keine Workload, für die dieser Server gedacht ist. Ein typisches `npm test` oder `dotnet build` passt mühelos hinein.

**Die Shell ist bash, Punkt.** v0.3.0 hatte einen `shell`-Parameter, der das Modell unter Windows `cmd` wählen ließ. v0.4.0 hat ihn entfernt. Der Grund ist im [CHANGELOG](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/CHANGELOG.md) vergraben: Die Anführungszeichen-Regeln von `cmd.exe` schneiden mehrzeilige Zeichenketten still beim ersten Zeilenumbruch ab, sodass Heredoc-Bodies, die das Modell durch `cmd` schickte, auf ihre erste Zeile zusammenfielen. Das Modell ging davon aus, der Befehl sei mit dem konstruierten Body gelaufen; bash auf der anderen Seite war anderer Meinung. Die Wahlmöglichkeit zu entfernen war billiger, als dem Modell beizubringen, immer bash zu wählen. Aus demselben Grund drängt die Tool-Beschreibung (in `src/tools/execute-command.ts`) das Modell aktiv zu Heredocs:

```
gh pr create --title "My PR" --body "$(cat <<'EOF'
## Summary

- First item
- Second item
EOF
)"
```

Die `\n`-Zeichen im JSON-`command`-String werden zu echten Zeilenumbrüchen dekodiert, bevor bash sie sieht; den Rest erledigt bash mit seiner Heredoc-Semantik.

## Kein PTY, mit Absicht

Der Kindprozess wird mit `stdio: ["ignore", "pipe", "pipe"]` gestartet, ohne Pseudo-Terminal. Es gibt keine Möglichkeit, sich an einen laufenden Prompt zu hängen, keine Signalisierung der Terminalbreite, keine Farb-Aushandlung in der Voreinstellung. Für Build-Befehle, Paketinstallationen, git und Testläufe ist das in Ordnung; das Modell erhält saubere Ausgabe ohne ANSI-Escapes als Rauschen. Für `vim`, `top`, `lldb` oder jede REPL, die ein interaktives TTY erwartet, ist dieses Tool das falsche. Der Server unternimmt keinen Versuch, eines vorzutäuschen.

Dieser Kompromiss ist beabsichtigt. Ein PTY-gestützter MCP-Server bräuchte Streaming, ein Protokoll für Teilausgaben und eine interaktive E/A-Semantik, die MCP selbst derzeit nicht gut modelliert. `cowork-terminal-mcp` bleibt im Bereich, in dem die einmalige Befehlsausführung tatsächlich zum Protokoll passt.

## Wann diese Brücke die richtige ist

`cowork-terminal-mcp` ist mit Absicht klein. Ein Tool, ausschließlich stdio, laut scheiternde bash-Auflösung, bewusste Ausgabegrenzen, keine Shell-Wahl, kein PTY. Wenn Sie Claude Cowork unter Windows betreiben und möchten, dass es tatsächlich Dinge auf dem Host ausführt, ist das die Brücke, die die Sandbox-Grenze schmerzlos macht. Wenn Sie ohnehin Claude Code CLI verwenden, ist es eine günstige Zusatzfähigkeit für den Tag, an dem ein Workflow das in das Modell eingebaute `Bash`-Tool verlassen muss. Quellcode und Issues finden sich unter [github.com/marius-bughiu/cowork-terminal-mcp](https://github.com/marius-bughiu/cowork-terminal-mcp); das Paket liegt im npm unter [cowork-terminal-mcp](https://www.npmjs.com/package/cowork-terminal-mcp).
