---
title: "cowork-terminal-mcp: acceso al terminal del host para Claude Cowork en un único servidor MCP"
description: "cowork-terminal-mcp v0.4.1 conecta la VM aislada de Claude Cowork con la shell de tu host. Una sola herramienta, transporte stdio, Git Bash anclado por ruta absoluta en Windows."
pubDate: 2026-04-29
tags:
  - "mcp"
  - "claude-cowork"
  - "claude-code"
  - "ai-coding-agents"
lang: "es"
translationOf: "2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork"
translatedBy: "claude"
translationDate: 2026-04-29
---

[Claude Cowork](https://www.anthropic.com/claude-cowork) se ejecuta dentro de una VM Linux aislada en tu equipo. Ese aislamiento es lo que vuelve cómodo dejar a Cowork corriendo sin supervisión, pero también significa que el agente no puede instalar las dependencias de tu proyecto, compilar tu código ni hacer push de un commit a tu repositorio del host por su cuenta. Sin un puente, el agente se detiene en el límite del sistema de archivos de la VM. [`cowork-terminal-mcp`](https://github.com/marius-bughiu/cowork-terminal-mcp) v0.4.1 es ese puente: un servidor [MCP](https://modelcontextprotocol.io/) de propósito único que se ejecuta en el host, expone una sola herramienta (`execute_command`) y nada más. En total son unas 200 líneas de TypeScript y se distribuye en npm como [`cowork-terminal-mcp`](https://www.npmjs.com/package/cowork-terminal-mcp).

## La única herramienta que expone el servidor

`execute_command` es toda la superficie. Su esquema Zod vive en [`src/tools/execute-command.ts`](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/src/tools/execute-command.ts) y acepta cuatro parámetros:

| Parámetro | Tipo                       | Valor por defecto | Descripción                                                  |
|-----------|----------------------------|-------------------|--------------------------------------------------------------|
| `command` | `string`                   | obligatorio       | El comando bash a ejecutar                                   |
| `cwd`     | `string`                   | directorio home   | Directorio de trabajo (prefiérelo sobre `cd <path> &&`)      |
| `timeout` | `number`                   | `30000` ms        | Cuánto se espera antes de abortar la ejecución               |
| `env`     | `Record<string, string>`   | heredado          | Variables de entorno extra superpuestas a `process.env`      |

Devuelve un objeto JSON con `stdout`, `stderr`, `exitCode` y `timedOut`. La salida está limitada a 1MB por flujo, con un sufijo `[stdout truncated at 1MB]` (o `stderr`) cuando se alcanza el tope.

¿Por qué una sola herramienta? Porque cada solicitud de "lista los archivos", "ejecuta los tests" o "qué dice git status" se reduce a un comando de shell. Una segunda herramienta sería apenas un envoltorio más fino sobre el mismo `spawn`. El catálogo MCP se mantiene pequeño, el modelo no elige la herramienta equivocada y la superficie de ataque del host queda trivial de auditar.

## Cómo conectarlo a Claude Cowork

Claude Cowork lee los servidores MCP desde la configuración de **Claude Desktop** y los reenvía a su VM aislada. El archivo de configuración vive en uno de tres lugares:

- **Windows (instalación desde Microsoft Store):** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows (instalación estándar):** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

La configuración mínima:

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

En Windows, envuelve el comando en `cmd /c` para que `npx` se resuelva correctamente (Claude Desktop lanza los comandos a través de plomería compatible con PowerShell que no siempre encuentra los shims de npm):

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

Para los usuarios de Claude Code CLI, el mismo servidor sirve además como vía de escape al terminal del host y se registra con una sola línea:

```bash
claude mcp add cowork-terminal -- npx -y cowork-terminal-mcp
```

El único requisito es bash. En macOS y Linux la shell del sistema basta. En Windows hay que tener instalado [Git for Windows](https://git-scm.com/download/win), y el servidor es opinado sobre cuál `bash.exe` está dispuesto a aceptar, que es la siguiente parte interesante.

## La trampa de Git Bash en Windows

`spawn("bash")` en Windows parece inocente y casi siempre está mal. El orden del PATH de Windows pone `C:\Windows\System32` cerca del principio, y `System32\bash.exe` existe en la mayoría de las instalaciones modernas de Windows. Ese binario es el lanzador de WSL. Cuando el servidor MCP le entrega un comando, este se ejecuta dentro de una VM Linux que no puede ver el sistema de archivos de Windows como lo ve el host, no puede leer el `PATH` de Windows y no puede ejecutar archivos `.exe` de Windows. El síntoma visible es curioso: `dotnet --version` devuelve "command not found" aunque el SDK de .NET esté claramente instalado y en el `PATH`. Lo mismo con `node`, `npm`, `git` y cada herramienta nativa de Windows que el agente intente invocar.

`cowork-terminal-mcp` lo soluciona en el arranque. `resolveBashPath()` se salta por completo la búsqueda en PATH en Windows y recorre una lista fija de ubicaciones de instalación de Git Bash:

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

Gana el primer candidato que `existsSync` confirma, y la ruta absoluta resuelta es con la que se llama a `spawn`. Si ninguno existe, el servidor lanza una excepción al cargar el módulo con un error que enumera todas las rutas que revisó y apunta a `https://git-scm.com/download/win`. No hay fallback al bash de System32 ni degradación silenciosa.

La lección de fondo: en Windows, "confiar en el PATH" es un disparo en el pie cada vez que importa el comportamiento de un binario específico. Resuelve por ruta absoluta o falla en voz alta. La corrección llegó en v0.4.1 precisamente porque había usuarios viendo al agente insistir en que `dotnet` no estaba instalado en máquinas donde claramente sí lo estaba.

## Tiempos de espera, límites de salida y la regla de una sola shell

En el ejecutor aparecen tres decisiones más, todas deliberadas.

**AbortController en lugar de un timeout de shell.** Cuando un comando supera su `timeout`, el servidor no envuelve la invocación de bash en `timeout 30s ...`. Llama a `abortController.abort()`, lo que Node.js traduce en matar el proceso. El hijo emite un evento `error` cuyo `name` es `AbortError`, el handler limpia el timer y la herramienta resuelve con `exitCode: null` y `timedOut: true`:

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

Esto mantiene la maquinaria del timeout fuera de la cadena del comando del usuario y se comporta de forma idéntica en Windows y en Unix.

**Tope de 1MB, por flujo, integrado.** `stdout` y `stderr` se acumulan en strings de JavaScript, pero cada evento `data` está condicionado a `length < MAX_OUTPUT_SIZE` (1.048.576 bytes). Una vez alcanzado el tope, los datos adicionales se descartan y se activa una bandera. La cadena de resultado final lleva el sufijo `[stdout truncated at 1MB]`. Ese es el costo de bufferizar en lugar de hacer streaming: el modelo recibe un resultado estructurado y limpio, pero `tail -f some.log` no es un caso de uso para el que este servidor esté pensado. Un `npm test` o `dotnet build` típico cabe sin problemas.

**La shell es bash, punto.** v0.3.0 tenía un parámetro `shell` que dejaba al modelo elegir `cmd` en Windows. v0.4.0 lo eliminó. La razón está enterrada en el [CHANGELOG](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/CHANGELOG.md): las reglas de comillas dobles de `cmd.exe` truncan silenciosamente las cadenas multilínea en el primer salto de línea, así que los cuerpos de heredoc que el modelo enviaba a través de `cmd` colapsaban a su primera línea. El modelo asumía que el comando se había ejecutado con el cuerpo que había construido; bash al otro lado discrepaba. Eliminar la opción salió más barato que enseñarle al modelo a elegir bash siempre. También por eso la descripción de la herramienta (en `src/tools/execute-command.ts`) empuja activamente al modelo a usar heredocs:

```
gh pr create --title "My PR" --body "$(cat <<'EOF'
## Summary

- First item
- Second item
EOF
)"
```

Los caracteres `\n` en la cadena `command` del JSON se decodifican como saltos de línea reales antes de que bash los vea, y la semántica de heredoc de bash hace el resto.

## Sin PTY, por diseño

El proceso hijo se lanza con `stdio: ["ignore", "pipe", "pipe"]`, sin pseudoterminal. No hay forma de adjuntarse a un prompt activo, no hay señalización de ancho de terminal, no hay negociación de color por defecto. Para comandos de compilación, instalaciones de paquetes, git y ejecuciones de tests, esto está bien; el modelo recibe salida limpia sin escapes ANSI ensuciando el resultado. Para `vim`, `top`, `lldb` o cualquier REPL que espere una TTY interactiva, esta es la herramienta equivocada. El servidor no intenta fingir una.

Esa concesión es deliberada. Un servidor MCP respaldado por PTY necesitaría streaming, un protocolo de salida parcial y semántica de E/S interactiva que MCP en sí mismo todavía no modela bien. `cowork-terminal-mcp` se queda dentro del límite donde la ejecución de comandos de un solo disparo realmente encaja con el protocolo.

## Cuándo este es el puente adecuado

`cowork-terminal-mcp` es pequeño a propósito. Una sola herramienta, solo stdio, resolución de bash que falla en voz alta, límites de salida deliberados, sin opción de shell, sin PTY. Si ejecutas Claude Cowork en Windows y quieres que de verdad pueda ejecutar cosas en el host, este es el puente que hace que el límite del sandbox deje de doler. Si ya usas Claude Code CLI, es una capacidad extra barata de tener registrada para el día en que un flujo de trabajo necesite salirse de la herramienta `Bash` integrada del modelo. El código fuente y los issues están en [github.com/marius-bughiu/cowork-terminal-mcp](https://github.com/marius-bughiu/cowork-terminal-mcp); el paquete está en npm en [cowork-terminal-mcp](https://www.npmjs.com/package/cowork-terminal-mcp).
