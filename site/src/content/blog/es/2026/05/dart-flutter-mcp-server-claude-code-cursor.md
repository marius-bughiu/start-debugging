---
title: "El servidor MCP de Dart y Flutter: un solo comando para darle a Claude Code tu app Flutter en ejecución"
description: "Dart 3.12 incluye dart mcp-server, el puente MCP oficial al toolchain de Dart y Flutter. Regístralo una vez en Claude Code, Cursor o Codex CLI y tu agente obtiene hot reload, búsqueda en pub.dev e introspección de widgets en vivo sin copiar y pegar un URI de DTD."
pubDate: 2026-05-28
tags:
  - "dart"
  - "flutter"
  - "mcp"
  - "claude-code"
  - "ai-agents"
lang: "es"
translationOf: "2026/05/dart-flutter-mcp-server-claude-code-cursor"
translatedBy: "claude"
translationDate: 2026-05-28
---

En Google I/O 2026 (19 y 20 de mayo), el equipo de Dart anunció Dart 3.12 junto con algo más discreto pero más útil en el día a día: el `dart mcp-server` oficial. Se distribuye con el SDK desde Dart 3.9 en adelante y permite que cualquier agente de codificación compatible con MCP (Claude Code, Cursor, Gemini CLI, Codex CLI, GitHub Copilot en VS Code) controle tu app Flutter en ejecución sin que vuelvas a copiar y pegar un URI del Dart Tooling Daemon. El estado sigue siendo "experimental" en los [docs oficiales](https://docs.flutter.dev/ai/mcp-server), pero la ruta de instalación es estable entre clientes y vale la pena conectarlo ya.

La fricción que elimina es real. Antes, pedirle a un agente que "arregle este texto rojo en el árbol de widgets" significaba ejecutar la app, abrir DevTools, copiar el URI de conexión DTD, pegarlo en un prompt de herramienta y rezar para que el agente no lo perdiera en el siguiente turno. Ahora el servidor MCP descubre el DTD por sí solo y el agente simplemente llama a `hot_reload`.

## Qué expone realmente el servidor

Según los docs del servidor MCP de Dart y Flutter, las herramientas se agrupan en cuatro categorías:

- **Proyecto**: analiza y corrige errores a través del analysis server, resuelve símbolos, obtiene documentación de paquetes, busca en pub.dev, edita `pubspec.yaml`, formatea con `dart format`.
- **Pruebas**: ejecuta tests, parsea fallos y trae trazas de pila al contexto del agente.
- **Runtime**: se conecta a una app en ejecución por DTD, lista widgets, inspecciona estado, toma una captura del árbol de renderizado.
- **Hot reload**: se dispara automáticamente tras la edición del agente, sin paso manual.

Cada herramienta devuelve resultados conscientes de Dart. `analyze_files` devuelve los mismos diagnósticos que el analysis server, no una expresión regular sobre la salida del compilador. `pub_search` consulta pub.dev con el mismo scoring que usa la web. `get_runtime_errors` extrae excepciones en vivo de la app en ejecución, incluido el widget que las lanzó.

## Conéctalo a Claude Code

Un solo comando, desde la raíz del proyecto Flutter:

```bash
claude mcp add --transport stdio dart -- dart mcp-server
```

Eso registra `dart` como servidor MCP por stdio en tu workspace actual de Claude Code. El servidor descubre el DTD activo desde la raíz del workspace, así que mientras `flutter run` siga vivo en otra terminal, `hot_reload` y `take_screenshot` se activan automáticamente.

Para Cursor, coloca esto en `.cursor/mcp.json`:

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

Para Codex CLI, el SDK aún tiene un hueco en la detección de roots en algunos shells, así que pasa el flag de fallback:

```bash
codex mcp add dart -- dart mcp-server --force-roots-fallback
```

Quienes usen Copilot en VS Code no necesitan nada de esto. Activa `dart.mcpServer: true` en los ajustes (Dart Code v3.116 o superior) y la extensión conecta el mismo binario por ti.

## El detalle a tener en cuenta

El servidor MCP es por SDK de Dart. Si tienes varios canales de Flutter instalados y tu agente toma `master` mientras tu proyecto está en `stable`, las llamadas a herramientas funcionarán, pero hablarán con el analysis server equivocado, y obtendrás respuestas confusas de tipo "símbolo no encontrado" para código que compila sin problemas. Fija el binario explícitamente en máquinas con varios canales:

```bash
claude mcp add --transport stdio dart -- /path/to/flutter/bin/dart mcp-server
```

Un segundo detalle: el servidor espera una sola raíz de workspace. Si abres un monorepo melos y dejas que el agente se mueva entre paquetes, el hot reload sigue apuntando a la app que iniciaste con `flutter run`. Pasa `--force-roots-fallback` para que el servidor use las raíces anunciadas por el cliente en lugar de adivinarlas.

Para el changelog completo, consulta nuestro post anterior sobre [los parámetros con nombre privados de Dart 3.12 y los formales inicializadores](/es/2026/05/dart-3-12-private-named-parameters-initializing-formals/). El servidor MCP es la pieza más silenciosa de ese release y probablemente la que más cambia tu loop diario.
