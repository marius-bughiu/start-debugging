---
title: "Wie man einen benutzerdefinierten MCP-Server in TypeScript erstellt, der eine CLI einbindet"
description: "Schritt-für-Schritt-Anleitung zum Einbinden eines beliebigen Kommandozeilen-Tools als Model Context Protocol Server mit dem TypeScript SDK 1.29. Behandelt die stdout-Falle, child_process-Muster, Fehlerweitergabe und einen vollständig funktionierenden git-Server."
pubDate: 2026-04-24
tags:
  - "mcp"
  - "ai-agents"
  - "typescript"
  - "claude-code"
lang: "de"
translationOf: "2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli"
translatedBy: "claude"
translationDate: 2026-04-25
---

Der schnellste Weg, einem KI-Agenten Zugriff auf ein Kommandozeilen-Tool zu geben, ist es als Model Context Protocol (MCP) Server einzubinden. Der Agent ruft eine typisierte Funktion auf, Ihr Server delegiert per Subprozess an die CLI, erfasst die Ausgabe und gibt sie als strukturierte Antwort zurück -- keine REST API, keine SDK-Bindings, keine Webhooks erforderlich.

Diese Anleitung baut diesen Wrapper von Grund auf mit `@modelcontextprotocol/sdk` 1.29.0 und Node 18+ auf. Am Ende haben Sie einen funktionierenden `git-mcp` Server, der `git log` und `git diff` als aufrufbare Werkzeuge bereitstellt, an Claude Desktop über stdio-Transport angebunden. Jeder Stolperstein, der CLI-Wrapper in Produktion brechen lässt, wird abgedeckt.

## Warum "die CLI einbinden" der richtige erste Schritt ist

Die meisten internen Tools existieren nur als CLI: Deployment-Skripte, Datenbank-Migration-Runner, Audit-Log-Exporter, Bildverarbeitungs-Pipelines. Sie haben keine API, keine gRPC-Oberfläche, nichts, was ein Agent direkt aufrufen kann. Sie als MCP-Werkzeuge einzubinden braucht 50-100 Zeilen TypeScript und produziert eine auffindbare, schema-validierte Schnittstelle, die jeder MCP-kompatible Client nutzen kann, einschließlich Claude Code, Claude Desktop, Cursor, und jeder Client, der die [MCP-Spezifikation (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26) spricht.

Die Alternative -- den CLI-Aufruf in einen System-Prompt oder eine Werkzeugbeschreibung einzubetten -- ist fragil. Argumente werden verstümmelt, Fehlerbehandlung verschwindet, und der Agent kann einen Timeout nicht von einem schlechten Flag unterscheiden. Ein ordentlicher MCP-Server behebt all das.

## Projekt-Setup

Sie benötigen Node.js 18 oder neuer. Erstellen Sie das Projektverzeichnis und installieren Sie die Abhängigkeiten:

```bash
mkdir git-mcp
cd git-mcp
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@3
npm install -D @types/node typescript
```

Fügen Sie zwei Felder zur `package.json` hinzu sowie ein Build-Skript. Das Feld `"type": "module"` weist Node an, `.js`-Dateien als ES-Module zu behandeln, was das SDK voraussetzt:

```json
{
  "type": "module",
  "bin": {
    "git-mcp": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod +x build/index.js"
  },
  "files": ["build"]
}
```

Erstellen Sie `tsconfig.json` im Projekt-Root:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Erstellen Sie die Quelldatei:

```bash
mkdir src
touch src/index.ts
```

## Die stdout-Falle, die jeden MCP-stdio-Server tötet

Bevor Sie eine einzige Zeile Geschäftslogik schreiben, prägen Sie sich diese Regel ein: **rufen Sie niemals `console.log()` innerhalb eines stdio-MCP-Servers auf**.

Wenn Sie Ihren Server unter stdio-Transport laufen lassen, kommuniziert der MCP-Client mit ihm über `stdin`/`stdout` mit JSON-RPC-Nachrichten. Jede Bytes, die Sie außerhalb des JSON-RPC-Protokolls in `stdout` schreiben, korrumpieren den Nachrichten-Stream. Der Client sieht fehlerhaftes JSON, scheitert beim Parsen einer Antwort, und trennt die Verbindung -- meist mit einem kryptischen "MCP server disconnected"-Fehler, der nirgends in die Nähe Ihrer harmlos aussehenden Debug-Anweisung zeigt.

```typescript
// @modelcontextprotocol/sdk 1.29.0, MCP spec 2025-03-26

// Bad -- corrupts the JSON-RPC stream
console.log("Running git log...");

// Good -- stderr is not part of the stdio transport
console.error("Running git log...");
```

Verwenden Sie `console.error()` für jede diagnostische Zeile. Sie schreibt nach `stderr`, das der MCP-Client entweder ignoriert oder separat anzeigt. Das ist kein Randfall -- es bringt fast jeden MCP-Server-Erstautor zu Fall.

## Der CLI-Runner

Fügen Sie einen typisierten Helper hinzu, der einen Subprozess startet, stdout und stderr sammelt und mit einem strukturierten Ergebnis auflöst. `spawn` statt `exec` zu verwenden umgeht die 1-MB-Standard-Buffer-Grenze, die `exec` auferlegt:

```typescript
// src/index.ts
// @modelcontextprotocol/sdk 1.29.0, Node 18+

import { spawn } from "child_process";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      shell: false, // never pass shell: true with untrusted input
      timeout: timeoutMs,
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
```

Zwei Punkte sind erwähnenswert:

- `shell: false` ist nicht optional, wenn irgendein Teil der Argumente vom LLM kommt. Mit `shell: true` wird ein Argument wie `--format=%H; rm -rf /` zu einer Shell-Injection. Übergeben Sie Argumente immer als Array und lassen Sie `spawn` das Escaping erledigen.
- Der Timeout propagiert über die `timeout`-Option von Nodes `child_process`, die nach Ablauf der Frist `SIGTERM` sendet. Fügen Sie einen `SIGKILL`-Fallback hinzu, falls die CLI `SIGTERM` ignoriert.

## Die Werkzeuge registrieren

Verdrahten Sie nun zwei `git`-Werkzeuge. Das erste, `git_log`, gibt die letzten N Commits eines Repos zurück. Das zweite, `git_diff`, gibt das nicht gestagte Diff zurück:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "git-mcp",
  version: "1.0.0",
});

server.registerTool(
  "git_log",
  {
    description:
      "Return the last N commits for a git repository. " +
      "Includes hash, author, date, and subject line.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      count: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Number of commits to return"),
    },
  },
  async ({ repo, count }) => {
    const result = await runCli(
      "git",
      ["log", `--max-count=${count}`, "--pretty=format:%H|%an|%ad|%s", "--date=iso"],
      repo
    );

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git log failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.stdout || "(no commits)" }],
    };
  }
);

server.registerTool(
  "git_diff",
  {
    description:
      "Return the unstaged diff for a git repository, or the diff for a specific file.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      file: z
        .string()
        .optional()
        .describe("Optional relative path to a specific file"),
      staged: z
        .boolean()
        .default(false)
        .describe("If true, show staged (cached) diff instead of unstaged"),
    },
  },
  async ({ repo, file, staged }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);

    const result = await runCli("git", args, repo);

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git diff failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: result.stdout || "(no changes)" },
      ],
    };
  }
);
```

Einige Dinge, auf die Sie in den Werkzeug-Handlern achten sollten:

- Das `inputSchema` verwendet Zod-Schemas direkt. Das SDK konvertiert sie zu JSON Schema für die Tool-Call-Validierung des Clients. Wenn Sie stattdessen ein einfaches JSON-Schema-Objekt übergeben, verlieren Sie die Semantik von `.default()` und `.optional()`.
- Geben Sie `isError: true` neben dem Inhalt zurück, wenn die CLI mit einem Exit-Code ungleich null beendet wird. Das teilt dem Client mit, dass der Aufruf fehlgeschlagen ist, ohne eine Exception zu werfen, die den Server zum Absturz bringen würde.
- Halten Sie den `repo`-Parameter als absoluten Pfad, den der Client liefern muss. Versuchen Sie nicht, ihn aus `process.cwd()` abzuleiten -- das Arbeitsverzeichnis des Servers ist dort, wo der MCP-Client ihn gestartet hat, was fast nie das Repo des Benutzers ist.

## Den Transport anbinden und den Server starten

Fügen Sie den Haupteinstiegspunkt am Ende von `src/index.ts` hinzu:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0, stdio transport

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("git-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

Kompilieren und überprüfen, dass es kompiliert:

```bash
npm run build
```

## An Claude Desktop anbinden

Öffnen Sie die Claude-Desktop-Konfiguration. Unter macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. Unter Windows: `%AppData%\Claude\claude_desktop_config.json`.

Fügen Sie Ihren Server unter `mcpServers` hinzu:

```json
{
  "mcpServers": {
    "git-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/git-mcp/build/index.js"]
    }
  }
}
```

Starten Sie Claude Desktop neu. Das Hammer-Symbol in der Toolbar sollte erscheinen und `git_log` und `git_diff` als verfügbare Werkzeuge anzeigen. Sie können nun Claude fragen: "Zeige mir die letzten 10 Commits in /Users/me/projects/myrepo" und es wird `git_log` direkt aufrufen.

Um es an Claude Code anzubinden, fügen Sie denselben Block zu Ihren Claude Code MCP-Einstellungen (`.claude/settings.json` unter `mcpServers`) hinzu, oder führen Sie `claude mcp add git-mcp -- node /path/to/build/index.js` vom Terminal aus.

## Stolpersteine in CLI-Wrappern für Produktion

**Trunkierung großer Ausgaben.** Manche CLIs produzieren Megabytes an Ausgabe (`git diff` bei einem großen Refactoring, `ps aux`, ein vollständiger SQL-Dump). Die MCP-Spezifikation erzwingt keine harte Inhalts-Größengrenze, aber Clients haben praktische Grenzen. Fügen Sie eine `maxBytes`-Sicherung in `runCli` hinzu und geben Sie einen Trunkierungshinweis zurück:

```typescript
const MAX_BYTES = 512_000; // 500 KB

// after collecting chunks:
const raw = Buffer.concat(chunks);
const text =
  raw.byteLength > MAX_BYTES
    ? raw.slice(0, MAX_BYTES).toString("utf8") + "\n\n[output truncated]"
    : raw.toString("utf8");
```

**PATH-Suche unter Windows.** Unter Windows kann `spawn("git", ...)` mit `shell: false` scheitern, falls `git` nicht im PATH ist, den der MCP-Client erbt. Verwenden Sie entweder den vollen Pfad zur ausführbaren Datei, oder starten Sie einen `cmd.exe /c git ...`-Wrapper (mit ordentlicher Argument-Sanitisierung). Alternativ lösen Sie den Pfad zur ausführbaren Datei beim Start mit dem npm-Paket `which` auf und cachen das Ergebnis.

**Timeout bei langsamen Operationen.** `git log` in einem Repo mit 500.000 Commits kann mehrere Sekunden dauern. Stimmen Sie `timeoutMs` pro Werkzeug ab, statt einen globalen Standard zu verwenden. Stellen Sie es als optionalen Parameter zur Verfügung, falls die Repo-Größe des Benutzers unvorhersehbar ist.

**Fehlermeldungen aus stderr.** Viele CLIs schreiben Nutzungsfehler nach stderr mit Exit-Code 0 (eine bekannte schlechte Angewohnheit). Prüfen Sie `result.stderr` auch wenn `exitCode === 0`, und geben Sie ihn in der Werkzeug-Antwort neben dem stdout-Inhalt aus.

**Kein Shell-Globbing.** Mit `shell: false` werden Globs wie `*.ts` in einem Argument nicht von der Shell expandiert. Falls Ihre CLI Glob-Expansion erwartet, listen Sie die Dateien entweder selbst auf (mit `glob` aus npm) oder akzeptieren Sie nur explizite Pfade im Werkzeug-Schema.

## Testen ohne Client

Installieren Sie `@modelcontextprotocol/inspector` global, um den Server interaktiv zu testen, ohne einen vollständigen MCP-Client zu konfigurieren:

```bash
npm install -g @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector node build/index.js
```

Der Inspector öffnet eine Browser-UI, in der Sie Werkzeuge auflisten, Argumente ausfüllen und sie direkt aufrufen können. Er zeigt auch die rohen JSON-RPC-Nachrichten, was die Diagnose des stdout-Korrumpierungsproblems trivial macht -- Sie können die Müllbytes sofort im Stream landen sehen.

## Was als nächstes bereitstellen

Zwei Werkzeuge sind ein dünner Querschnitt. Dasselbe Muster skaliert auf jede CLI, auf die sich Ihr Team verlässt:

- Stellen Sie `git blame`, `git show` und `git grep` bereit, um einen Code-Archäologie-Agenten zu bauen.
- Binden Sie `aws s3 ls` und `aws cloudformation describe-stacks` für einen infrastruktur-bewussten Agenten ein.
- Stellen Sie `sqlite3 :memory: .schema` oder `psql \d tablename` bereit, damit ein Agent ein Datenbank-Schema inspizieren kann, bevor er Abfragen schreibt.
- Binden Sie eine benutzerdefinierte interne CLI für Deployment, Ticket-Erstellung oder Log-Export ein -- Dinge, die nur in Shell-Skripten gelebt haben, weil "niemand eine API für sie brauchte."

Dem MCP-Server ist es egal, was die CLI macht. Er braucht nur ein wohldefiniertes Eingabe-Schema (das Zod Ihnen in 3 Zeilen gibt) und einen Handler, der die Binärdatei ausführt und die Ausgabe zurückgibt.

Wenn Ihr Team C# statt TypeScript verwendet, ist dasselbe Muster über das [ModelContextProtocol NuGet-Paket verfügbar, das wir beim Anbinden von MCP-Servern auf .NET 10 behandelt haben](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/). Für einen breiteren Blick darauf, wie MCP aussieht, wenn eine IDE es direkt mitliefert, ist [der Azure MCP Server, der innerhalb von Visual Studio 2022 17.14.30 ausgeliefert wird](/de/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) ein nützliches Praxisbeispiel für die Skala, auf die dieses Protokoll abzielt. Und falls Sie autonome Agenten bauen, die mehrere Werkzeuge koordinieren und ein Framework jenseits von rohem MCP brauchen, deckt [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) die C#-Seite ab. Und für Agent-Integration auf IDE-Ebene zeigen [Agent Skills in Visual Studio 2026 18.5](/de/2026/04/visual-studio-2026-copilot-agent-skills/), wie Copilot Skill-Definitionen automatisch aus der `SKILL.md` Ihres Repos entdeckt.

## Quellen

- [MCP TypeScript SDK -- modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [Official build-server guide -- modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Inspector -- @modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)
