---
title: "Ejecuta el Binlog MCP Server en CI para diagnosticar fallos de compilación automáticamente"
description: "El 2026-06-30 Microsoft mostró el Binlog MCP Server ejecutándose sin supervisión en un GitHub Agentic Workflow, para que un agente lea el .binlog y comente la causa raíz en cuanto una compilación de CI falla."
pubDate: 2026-07-02
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
  - "ci"
lang: "es"
translationOf: "2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures"
translatedBy: "claude"
translationDate: 2026-07-02
---

El 2026-06-30 el equipo de .NET publicó [MCP Beyond the Chat Window: Build Diagnostics in CI](https://devblogs.microsoft.com/dotnet/mcp-build-diagnostics-workflows/), y saca el Binlog MCP Server de tu editor para dejarlo dentro de tu pipeline. Hace dos semanas ese servidor era algo a lo que apuntabas Claude o Copilot a mano desde un `.binlog` local (cubrí esa configuración en [El Binlog MCP Server deja que una IA lea tus registros de MSBuild](/es/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/)). La nueva demostración lo ejecuta sin supervisión en GitHub Actions: la compilación falla, un agente lee el registro y un comentario con la causa raíz aparece en el pull request antes de que nadie descargue nada.

## Por qué CI es el mejor lugar para un binlog

La historia interactiva está bien, pero el verdadero dolor está en CI. Una compilación se pone en rojo, sacas un registro binario de varios megabytes del runner, abres el MSBuild Structured Log Viewer y recorres targets anidados buscando el único error que importa. Mover el parser al pipeline elimina todo ese ciclo. El `.binlog` nunca sale del runner y el modelo hace la lectura.

Sigues generando el registro de la misma forma. Añade `/bl` a cualquier comando basado en MSBuild:

```bash
dotnet build /bl
dotnet test /bl
dotnet pack /bl
```

## Conectarlo a un GitHub Agentic Workflow

La diferencia clave es que el servidor se distribuye como una imagen de contenedor, así que el workflow monta el registro en modo de solo lectura y deja que el agente lo consulte. El repositorio `microsoft/testfx` usa más o menos esta forma:

```yaml
mcp-servers:
  binlog-mcp:
    container: "mcr.microsoft.com/dotnet-buildtools/prereqs:azurelinux-3.0-binlog-mcp-amd64"
    mounts:
      - "/tmp/build.binlog:/data/build.binlog:ro"
    allowed: ["*"]
```

El job ejecuta la compilación con un registro binario, y solo cuando la compilación falla despierta al agente. Nada se ejecuta en verde, así que no pagas ningún coste de tokens por las compilaciones que pasan.

## binlog_diagnose hace la primera pasada

La herramienta que hace esto práctico es `binlog_diagnose`. En lugar de que el agente encadene `binlog_errors`, `binlog_search` y `binlog_target_reasons` por su cuenta, `binlog_diagnose` lee el registro, agrupa los errores, identifica la causa raíz probable y sugiere una solución en una sola llamada. El resto del conjunto (`binlog_overview`, `binlog_compare`, `binlog_task_details` y una lista creciente de otras que cubren rendimiento, grafos de dependencias e introspección de compilaciones incrementales) sigue ahí cuando el agente necesita profundizar más.

En la propia evaluación de Microsoft, darle estas herramientas al agente movió la puntuación de calidad del diagnóstico de 3,25 a 3,68 frente a una línea base sin herramientas, y terminó cerca de un 44% más rápido (196s vs 350s de tiempo total). Más rápido y mejor es una combinación rara, y viene de que el agente consulta datos estructurados en lugar de hacer grep sobre texto de registro en crudo.

Si tienes una compilación de CI inestable que sigue produciendo un registro que nadie quiere abrir, esta es la versión de la configuración que de verdad ahorra tiempo a tu equipo: el diagnóstico ocurre automáticamente, en el PR, mientras el fallo todavía está fresco.
