---
title: "Aspire 13.5 bringt ein echtes Terminal ins Dashboard"
description: "WithTerminal() gibt einer Ressource eine interaktive PTY-Sitzung, in die man aus dem Dashboard tippen oder sich aus der eigenen Shell einklinken kann. Sie ist experimentell, hängt den Debugger ab, und die Shell-Option, gegen die du eventuell programmiert hast, ist weg."
pubDate: 2026-08-28
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "tooling"
lang: "de"
translationOf: "2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard"
translatedBy: "claude"
translationDate: 2026-08-28
---

[Aspire 13.5 ist am 18. August 2026 erschienen](https://devblogs.microsoft.com/aspire/whats-new-aspire-13-5/), mit überarbeitetem Dashboard, TypeScript-AppHosts in GA und einem Dutzend Breaking Changes. Das, was den Inner Loop tatsächlich verändert, ist kleiner als all das: `WithTerminal()` gibt einer Ressource ein laufendes Pseudo-Terminal, in das du aus dem Dashboard tippen kannst, statt nur ihr Konsolenlog zu lesen.

## Ein Aufruf, und die Ressource bekommt ein PTY

```csharp
#pragma warning disable ASPIRETERMINAL001
var agent = builder.AddExecutable("agent", "my-agent", ".")
    .WithTerminal();
#pragma warning restore ASPIRETERMINAL001
```

Die API ist experimentell, der Aufruf löst also `ASPIRETERMINAL001` aus, und dein AppHost baut erst, wenn du das quittierst – entweder mit dem Pragma oben oder indem du die ID in `<NoWarn>` aufnimmst. Ist es aktiv, bekommt die Console-Logs-Seite der Ressource im Dashboard eine Terminalansicht neben dem gewohnten Log-Stream, und laufende Ressourcen öffnen standardmäßig in dieser Ansicht.

Die Overload mit Optionen deckt die Rastergeometrie ab:

```csharp
.WithTerminal(options =>
{
    options.Columns = 200;  // Standard 120
    options.Rows = 50;      // Standard 30
});
```

Beide müssen mindestens 1 sein; null oder negativ wirft eine `ArgumentOutOfRangeException`. Die dritte Option, `ShowTerminalHost` (Standard `false`), verrät die Implementierung auf nützliche Weise: Sie steuert, "ob die verborgenen Terminal-Host-Ressourcen pro Replikat im Dashboard und in den Ressourcenlisten der CLI erscheinen". Jedes Replikat bekommt seine eigene unabhängige Sitzung hinter einer eigenen verborgenen Host-Ressource, `.WithReplicas(3).WithTerminal()` liefert also drei, zwischen denen du im Dashboard wechseln kannst. Die Reihenfolge dieser beiden Aufrufe spielt keine Rolle. `WithTerminal()` zweimal auf derselben Ressource aufzurufen wirft eine Exception.

## Aus der eigenen Shell verbinden

Die CLI-Hälfte steckt hinter einem Feature-Flag:

```bash
aspire config set features.terminalCommandsEnabled true
aspire terminal ps
aspire terminal attach agent --replica 1
```

Sitzungen unterstützen mehrere gleichzeitige Zuschauer, ein Browser-Tab und eine lokale Shell können denselben Prozess also bedienen, ohne dass eines von beiden die Sitzung abreißt.

## Zwei scharfe Kanten

Die erste ist der Debugger. Laut Dokumentation "führt Aspire die Ressource als einfachen Prozess aus und hängt den Debugger nicht automatisch an", wenn du `WithTerminal` anwendest. Damit ist es das falsche Werkzeug für das Projekt, durch das du gerade steppst, und das richtige für eine TUI, ein REPL oder ein Migrationsskript, das du von Hand steuern willst. Aspire nennt das eine vorübergehende Einschränkung.

Die zweite trifft alle, die das in den 13.4-Previews probiert haben: Es gibt keine Möglichkeit, die zu startende Shell zu wählen. Die Option `Shell` ist verschwunden, entfernt, "weil sie nie mit dem darunterliegenden Pseudo-Terminal verdrahtet war und keinerlei Wirkung hatte". Code, der `TerminalOptions.Shell` gesetzt hat, kompiliert unter 13.5 nicht mehr – nachdem er unter 13.4 nichts getan hat.

Noch ein Upgrade-Hinweis, bevor du irgendetwas davon ausprobierst: Die Release Notes weisen darauf hin, dass gemischte 13.4- und 13.5-Pakete zur Laufzeit mit `MissingMethodException` oder `TypeLoadException` scheitern. Hebe das SDK und jedes `Aspire.Hosting.*`-Paket im selben Commit auf zueinander passende Versionen. Wenn du mehrere AppHosts nebeneinander betreibst, passt das gut zu [dem `--isolated`-Flag aus 13.2](/de/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/): Jeder isolierte Lauf bekommt seine eigenen Terminalsitzungen zusätzlich zu seinen eigenen Ports.
