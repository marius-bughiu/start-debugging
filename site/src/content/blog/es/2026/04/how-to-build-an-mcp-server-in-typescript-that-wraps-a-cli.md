---
title: "Cómo crear un servidor MCP personalizado en TypeScript que envuelve una CLI"
description: "Guía paso a paso para envolver cualquier herramienta de línea de comandos como un servidor Model Context Protocol usando el SDK de TypeScript 1.29. Cubre la trampa de stdout, patrones de child_process, propagación de errores y un servidor git completo y funcional."
pubDate: 2026-04-24
tags:
  - "mcp"
  - "ai-agents"
  - "typescript"
  - "claude-code"
lang: "es"
translationOf: "2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli"
translatedBy: "claude"
translationDate: 2026-04-25
---

La forma más rápida de dar a un agente de IA acceso a una herramienta de línea de comandos es envolverla como un servidor Model Context Protocol (MCP). El agente llama a una herramienta tipada, tu servidor invoca la CLI por subproceso, captura la salida y la devuelve como una respuesta estructurada -- sin API REST, sin bindings de SDK, sin webhooks necesarios.

Esta guía construye ese envoltorio desde cero usando `@modelcontextprotocol/sdk` 1.29.0 y Node 18+. Al final tendrás un servidor `git-mcp` funcional que expone `git log` y `git diff` como herramientas invocables, conectado a Claude Desktop a través del transporte stdio. Cubre cada detalle que rompe envoltorios de CLI en producción.

## Por qué "envolver la CLI" es la primera jugada correcta

La mayoría del tooling interno existe solo como CLI: scripts de implementación, ejecutores de migraciones de base de datos, exportadores de logs de auditoría, pipelines de procesamiento de imágenes. No tienen API, no tienen superficie gRPC, nada que un agente pueda llamar directamente. Envolverlas como herramientas MCP toma 50-100 líneas de TypeScript y produce una interfaz descubrible y validada por esquema que cualquier cliente compatible con MCP puede usar, incluyendo Claude Code, Claude Desktop, Cursor, y cualquier cliente que hable la [especificación MCP (2025-03-26)](https://spec.modelcontextprotocol.io).

La alternativa -- incrustar la llamada a la CLI dentro de un prompt de sistema o descripción de herramienta -- es frágil. Los argumentos se desfiguran, el manejo de errores desaparece, y el agente no puede distinguir un timeout de un flag incorrecto. Un servidor MCP adecuado arregla todo eso.

## Configuración del proyecto

Necesitas Node.js 18 o posterior. Crea el directorio del proyecto e instala las dependencias:

```bash
mkdir git-mcp
cd git-mcp
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@3
npm install -D @types/node typescript
```

Agrega dos campos a `package.json` y un script de compilación. El campo `"type": "module"` le dice a Node que trate los archivos `.js` como módulos ES, lo que el SDK requiere:

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

Crea `tsconfig.json` en la raíz del proyecto:

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

Crea el archivo fuente:

```bash
mkdir src
touch src/index.ts
```

## La trampa de stdout que mata todo servidor MCP stdio

Antes de escribir una sola línea de lógica de negocio, graba esta regla: **nunca llames a `console.log()` dentro de un servidor MCP stdio**.

Cuando ejecutas tu servidor bajo el transporte stdio, el cliente MCP se comunica con él sobre `stdin`/`stdout` usando mensajes JSON-RPC. Cualquier byte que escribas en `stdout` fuera del protocolo JSON-RPC corrompe el flujo de mensajes. El cliente verá JSON malformado, fallará al parsear una respuesta, y se desconectará -- usualmente con un críptico error "MCP server disconnected" que no apunta a ningún lugar cerca de tu inocente sentencia de depuración.

```typescript
// @modelcontextprotocol/sdk 1.29.0, MCP spec 2025-03-26

// Bad -- corrupts the JSON-RPC stream
console.log("Running git log...");

// Good -- stderr is not part of the stdio transport
console.error("Running git log...");
```

Usa `console.error()` para cada línea de diagnóstico. Escribe en `stderr`, que el cliente MCP ignora o muestra por separado. Esto no es un caso límite -- tropieza con casi todos los autores de servidores MCP primerizos.

## El ejecutor de la CLI

Agrega un helper tipado que crea un subproceso, recolecta stdout y stderr, y resuelve con un resultado estructurado. Usar `spawn` en lugar de `exec` evita el límite de buffer por defecto de 1 MB que `exec` impone:

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

Dos puntos vale la pena destacar:

- `shell: false` no es opcional si alguna parte de los argumentos viene del LLM. Con `shell: true` un argumento como `--format=%H; rm -rf /` se convierte en una inyección de shell. Siempre pasa los argumentos como un array y deja que `spawn` maneje el escape.
- El timeout se propaga vía la opción `timeout` de `child_process` de Node, que envía `SIGTERM` después de la fecha límite. Agrega un fallback `SIGKILL` si la CLI ignora `SIGTERM`.

## Registrando las herramientas

Ahora conecta dos herramientas `git`. La primera, `git_log`, devuelve los últimos N commits de un repo. La segunda, `git_diff`, devuelve el diff sin staged:

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

Algunas cosas a las que prestar atención en los handlers de las herramientas:

- El `inputSchema` usa esquemas Zod directamente. El SDK los convierte a JSON Schema para la validación de llamadas a herramientas del cliente. Si pasas un objeto JSON Schema plano en su lugar, pierdes la semántica de `.default()` y `.optional()`.
- Devuelve `isError: true` junto con el contenido cuando la CLI sale con un código distinto de cero. Esto le dice al cliente que la invocación falló sin lanzar una excepción que crashearía el servidor.
- Mantén el parámetro `repo` como una ruta absoluta que el cliente debe proporcionar. No intentes inferirla de `process.cwd()` -- el directorio de trabajo del servidor está donde sea que el cliente MCP lo haya lanzado, que casi nunca es el repo del usuario.

## Conectando el transporte e iniciando el servidor

Agrega el punto de entrada principal al final de `src/index.ts`:

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

Compila y verifica:

```bash
npm run build
```

## Conectándolo a Claude Desktop

Abre la config de Claude Desktop. En macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. En Windows: `%AppData%\Claude\claude_desktop_config.json`.

Agrega tu servidor bajo `mcpServers`:

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

Reinicia Claude Desktop. El icono de martillo en la barra de herramientas debería aparecer mostrando `git_log` y `git_diff` como herramientas disponibles. Ahora puedes preguntarle a Claude: "Muéstrame los últimos 10 commits en /Users/me/projects/myrepo" y llamará a `git_log` directamente.

Para conectarlo a Claude Code, agrega el mismo bloque a tu configuración MCP de Claude Code (`.claude/settings.json` bajo `mcpServers`), o ejecuta `claude mcp add git-mcp -- node /path/to/build/index.js` desde la terminal.

## Detalles a tener en cuenta en envoltorios de CLI en producción

**Truncamiento de salidas grandes.** Algunas CLIs producen megabytes de salida (`git diff` en una refactorización grande, `ps aux`, un dump completo de SQL). La especificación MCP no aplica un límite de tamaño de contenido estricto, pero los clientes tienen límites prácticos. Agrega un guardia `maxBytes` en `runCli` y devuelve un aviso de truncamiento:

```typescript
const MAX_BYTES = 512_000; // 500 KB

// after collecting chunks:
const raw = Buffer.concat(chunks);
const text =
  raw.byteLength > MAX_BYTES
    ? raw.slice(0, MAX_BYTES).toString("utf8") + "\n\n[output truncated]"
    : raw.toString("utf8");
```

**Búsqueda de PATH en Windows.** En Windows, `spawn("git", ...)` con `shell: false` puede fallar si `git` no está en el PATH que hereda el cliente MCP. O bien usa la ruta completa al ejecutable, o crea un envoltorio `cmd.exe /c git ...` (con saneo apropiado de argumentos). Alternativamente, resuelve la ruta del ejecutable al inicio usando el paquete npm `which` y cachea el resultado.

**Timeout en operaciones lentas.** `git log` en un repo con 500 000 commits puede tomar varios segundos. Ajusta `timeoutMs` por herramienta en lugar de usar un valor por defecto global. Exponlo como un parámetro opcional si el tamaño del repo del usuario es impredecible.

**Mensajes de error desde stderr.** Muchas CLIs escriben errores de uso en stderr con código de salida 0 (un mal hábito conocido). Verifica `result.stderr` incluso cuando `exitCode === 0` y muéstralo en la respuesta de la herramienta junto al contenido de stdout.

**Sin globbing del shell.** Con `shell: false`, los globs como `*.ts` en un argumento no son expandidos por el shell. Si tu CLI espera expansión de glob, o bien enumera los archivos tú mismo (usando `glob` desde npm) o acepta solo rutas explícitas en el esquema de la herramienta.

## Probándolo sin un cliente

Instala `@modelcontextprotocol/inspector` globalmente para probar el servidor interactivamente sin configurar un cliente MCP completo:

```bash
npm install -g @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector node build/index.js
```

El inspector abre una UI de navegador donde puedes listar herramientas, llenar argumentos, y llamarlas directamente. También muestra los mensajes JSON-RPC en bruto, lo que hace trivial el diagnóstico del problema de corrupción de stdout -- puedes ver los bytes basura aterrizar en el flujo inmediatamente.

## Qué exponer a continuación

Dos herramientas son una rebanada delgada. El mismo patrón escala a cualquier CLI en la que se apoye tu equipo:

- Expón `git blame`, `git show`, y `git grep` para construir un agente de arqueología de código.
- Envuelve `aws s3 ls` y `aws cloudformation describe-stacks` para un agente con conciencia de infraestructura.
- Expón `sqlite3 :memory: .schema` o `psql \d tablename` para que un agente inspeccione un esquema de base de datos antes de escribir consultas.
- Envuelve una CLI interna personalizada para implementación, creación de tickets, o exportación de logs -- cosas que han vivido solo en scripts de shell porque "nadie necesitaba una API para ellos."

Al servidor MCP no le importa qué hace la CLI. Solo necesita un esquema de entrada bien definido (que Zod te da en 3 líneas) y un handler que ejecute el binario y devuelva la salida.

Si tu equipo usa C# en lugar de TypeScript, el mismo patrón está disponible a través del [paquete NuGet ModelContextProtocol, que cubrimos al conectar servidores MCP en .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/). Para una mirada más amplia de cómo se ve MCP cuando un IDE lo empaqueta directamente, [el Azure MCP Server que se entrega dentro de Visual Studio 2022 17.14.30](/es/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) es un ejemplo útil del mundo real de la escala que apunta este protocolo. Y si estás construyendo agentes autónomos que coordinan múltiples herramientas y necesitas un framework más allá de MCP en bruto, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) cubre el lado de C#. Y para integración de agentes a nivel de IDE, [los agent skills en Visual Studio 2026 18.5](/es/2026/04/visual-studio-2026-copilot-agent-skills/) muestran cómo Copilot autodescubre definiciones de skills desde el `SKILL.md` de tu repo.

## Enlaces de fuente

- [MCP TypeScript SDK -- modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP spec (2025-03-26)](https://spec.modelcontextprotocol.io)
- [Official build-server guide -- modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Inspector -- @modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)
