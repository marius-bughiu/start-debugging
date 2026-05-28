---
title: "Der Dart- und Flutter-MCP-Server: ein Befehl, um Claude Code Ihre laufende Flutter-App zu übergeben"
description: "Dart 3.12 liefert dart mcp-server, die offizielle MCP-Brücke in die Dart- und Flutter-Toolchain. Einmal in Claude Code, Cursor oder Codex CLI registrieren und Ihr Agent erhält Hot Reload, pub.dev-Suche und Live-Widget-Introspection, ohne eine DTD-URI zu kopieren."
pubDate: 2026-05-28
tags:
  - "dart"
  - "flutter"
  - "mcp"
  - "claude-code"
  - "ai-agents"
lang: "de"
translationOf: "2026/05/dart-flutter-mcp-server-claude-code-cursor"
translatedBy: "claude"
translationDate: 2026-05-28
---

Auf der Google I/O 2026 (19. und 20. Mai) kündigte das Dart-Team Dart 3.12 an, zusammen mit etwas Unauffälligerem, aber im Alltag Nützlicherem: dem offiziellen `dart mcp-server`. Er ist seit Dart 3.9 im SDK enthalten und erlaubt jedem MCP-kompatiblen Coding-Agent (Claude Code, Cursor, Gemini CLI, Codex CLI, GitHub Copilot in VS Code), Ihre laufende Flutter-App zu steuern, ohne dass Sie jemals wieder eine Dart-Tooling-Daemon-URI kopieren müssen. Der Status ist in der [offiziellen Dokumentation](https://docs.flutter.dev/ai/mcp-server) weiterhin "experimentell", aber der Installationspfad ist über alle Clients hinweg stabil und lohnt sich jetzt schon.

Die Reibung, die er beseitigt, ist real. Bisher bedeutete der Auftrag an einen Agenten "behebe diesen roten Text im Widget-Baum": App starten, DevTools öffnen, DTD-Verbindungs-URI kopieren, in einen Tool-Prompt einfügen und hoffen, dass der Agent ihn in der nächsten Runde nicht verliert. Jetzt findet der MCP-Server den DTD selbst und der Agent ruft einfach `hot_reload` auf.

## Was der Server tatsächlich bereitstellt

Laut der Dokumentation des Dart- und Flutter-MCP-Servers gliedern sich die Tools in vier Kategorien:

- **Projekt**: Fehler über den Analysis Server analysieren und beheben, Symbole auflösen, Paketdokumentation abrufen, pub.dev durchsuchen, `pubspec.yaml` bearbeiten, mit `dart format` formatieren.
- **Tests**: Tests ausführen, Fehlschläge parsen, Stack Traces in den Kontext des Agenten holen.
- **Laufzeit**: über DTD an eine laufende App andocken, Widgets auflisten, State inspizieren, einen Screenshot des Renderbaums machen.
- **Hot Reload**: nach der Bearbeitung durch den Agenten automatisch ausgelöst, ohne manuellen Schritt.

Jedes Tool liefert Dart-bewusste Ergebnisse. `analyze_files` gibt dieselben Diagnosen zurück wie der Analysis Server, keine Regex über Compiler-Output. `pub_search` befragt pub.dev mit demselben Scoring, das die Website verwendet. `get_runtime_errors` zieht Live-Exceptions aus der laufenden App, einschließlich des Widgets, das sie geworfen hat.

## In Claude Code einbinden

Ein Befehl, aus dem Wurzelverzeichnis des Flutter-Projekts:

```bash
claude mcp add --transport stdio dart -- dart mcp-server
```

Das registriert `dart` als stdio-MCP-Server in Ihrem aktuellen Claude-Code-Workspace. Der Server entdeckt den aktiven DTD ausgehend vom Workspace-Root, sodass `hot_reload` und `take_screenshot` automatisch verfügbar sind, solange `flutter run` in einem anderen Terminal läuft.

Für Cursor tragen Sie Folgendes in `.cursor/mcp.json` ein:

```json
{
  "mcpServers": {
    "dart": {
      "command": "dart",
      "args": ["mcp-server"]
    }
  }
}
```

Für die Codex CLI hat das SDK in manchen Shells noch eine Lücke bei der Roots-Erkennung. Übergeben Sie deshalb das Fallback-Flag:

```bash
codex mcp add dart -- dart mcp-server --force-roots-fallback
```

Wer Copilot in VS Code nutzt, braucht nichts davon. Setzen Sie `dart.mcpServer: true` in den Einstellungen (Dart Code v3.116 oder neuer), und die Erweiterung bindet dasselbe Binary automatisch ein.

## Die eine Falle, die man kennen sollte

Der MCP-Server ist pro Dart-SDK. Wenn Sie mehrere Flutter-Kanäle installiert haben und Ihr Agent `master` aufgreift, während Ihr Projekt auf `stable` läuft, funktionieren die Tool-Aufrufe zwar, sprechen aber mit dem falschen Analysis Server, und Sie bekommen verwirrende "Symbol nicht gefunden"-Antworten für Code, der sauber kompiliert. Pinnen Sie das Binary auf Mehrkanal-Maschinen explizit:

```bash
claude mcp add --transport stdio dart -- /path/to/flutter/bin/dart mcp-server
```

Eine zweite Falle: Der Server erwartet einen einzigen Workspace-Root. Wenn Sie ein Melos-Monorepo öffnen und den Agenten zwischen Paketen wechseln lassen, zielt Hot Reload weiterhin auf die App, die Sie mit `flutter run` gestartet haben. Übergeben Sie `--force-roots-fallback`, damit der Server die vom Client gemeldeten Roots verwendet, statt zu raten.

Den vollständigen Changelog finden Sie in unserem früheren Beitrag zu [Dart 3.12: private benannte Parameter und initialisierende Formals](/de/2026/05/dart-3-12-private-named-parameters-initializing-formals/). Der MCP-Server ist das leiseste Stück dieses Releases und vermutlich dasjenige, das Ihren täglichen Loop am stärksten verändert.
