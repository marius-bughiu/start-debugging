---
title: "El servidor MCP de Binlog deja que una IA lea tus registros de MSBuild"
description: "Microsoft publicó Microsoft.AITools.BinlogMcp el 2026-06-17, un servidor MCP que expone 15 herramientas para que Claude o Copilot diagnostiquen fallos de compilación y targets lentos directamente desde un archivo .binlog."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
lang: "es"
translationOf: "2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds"
translatedBy: "claude"
translationDate: 2026-06-20
---

El 2026-06-17 Microsoft publicó el [servidor MCP de Binlog](https://devblogs.microsoft.com/dotnet/msbuild-binlog-mcp-server/), un servidor MCP que analiza los registros binarios de MSBuild y le entrega a un asistente de IA 15 herramientas especializadas para investigarlos. La propuesta es simple: en lugar de abrir un `.binlog` de varios megabytes en el MSBuild Structured Log Viewer y rastrear targets anidados a mano, preguntas "¿por qué falló mi compilación?" y el modelo va y lee el registro por ti.

## Por qué un binlog es la superficie correcta

Un registro binario es el registro de mayor fidelidad que produce MSBuild. Captura cada target, tarea, evaluación de propiedad e item, además de los archivos fuente que se incrustaron durante la compilación. Ese detalle es exactamente lo que lo hace doloroso de leer manualmente, y exactamente lo que un modelo sabe consultar bien. Al poner el analizador detrás del Model Context Protocol, el mismo registro funciona en cualquier cliente MCP: Claude Code, Copilot en VS Code o Visual Studio.

Genera uno de la forma habitual:

```bash
dotnet build /bl:build-a.binlog
```

## Conectarlo a un cliente MCP

El servidor se publica como la herramienta dotnet `Microsoft.AITools.BinlogMcp`. En VS Code apuntas `mcp.json` hacia él por stdio:

```json
{
  "servers": {
    "binlog-mcp": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["tool", "run", "Microsoft.AITools.BinlogMcp"]
    }
  }
}
```

Si quieres que el modelo abra un registro específico al iniciar, pásalo después del separador `--`:

```json
{
  "args": ["tool", "run", "Microsoft.AITools.BinlogMcp", "--", "--binlog", "msbuild.binlog"]
}
```

Visual Studio y VS Code también pueden incorporarlo a través del plugin `dotnet-msbuild` del marketplace `dotnet/skills`, que descubre el servidor automáticamente para que te saltes el JSON por completo.

## Las 15 herramientas, agrupadas por lo que realmente preguntas

Las herramientas se dividen en cuatro trabajos. Para diagnosticar una compilación en rojo está `binlog_overview` (estado, duración, conteo de errores y proyectos), `binlog_errors`, `binlog_warnings` filtrable por código y `binlog_search`, que ejecuta consultas de texto completo en el DSL de StructuredLog. La que más destaca es `binlog_explain_property`: rastrea de dónde vino en realidad el valor de una propiedad, así que una pregunta como "¿por qué `TargetFramework` está establecido en net8.0 aquí?" obtiene una cadena de evaluación en lugar de una suposición.

Para compilaciones lentas, `binlog_expensive_projects`, `binlog_expensive_targets` y `binlog_expensive_tasks` clasifican por tiempo de reloj. Y `binlog_compare` compara dos registros, que es la que espero que se gane su lugar:

> Compara `build-a.binlog` y `build-b.binlog`. ¿Qué propiedades de MSBuild y versiones de paquetes cambiaron?

Ese único prompt reemplaza el tedioso escaneo lado a lado que haces cuando una compilación funciona en tu máquina y falla en CI.

Esto es parte de un patrón más amplio de Microsoft envolviendo los diagnósticos de .NET en MCP para que los agentes puedan manejarlos. El servidor vive en [`dotnet/skills`](https://github.com/dotnet/skills); reporta los problemas ahí. Si tienes una compilación inestable de CI atrapada en un registro que nadie quiere abrir, esta es la forma de menor esfuerzo de apuntar un modelo hacia ella.
