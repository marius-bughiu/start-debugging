---
title: "Claude Code 2.1.259 agrega managedMcpServers: distribuye servidores MCP sin MDM"
description: "Hasta ahora, la única forma de entregar los mismos servidores MCP a cada desarrollador era managed-mcp.json, un archivo en una ruta del sistema que toma el control exclusivo de MCP. Claude Code 2.1.259 agrega una configuración managedMcpServers para servidores HTTP y SSE, y de paso reduce el alcance de allowedMcpServers."
pubDate: 2026-09-03
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "es"
translationOf: "2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm"
translatedBy: "claude"
translationDate: 2026-09-03
---

Claude Code 2.1.259 salió el 2026-09-02 con una entrada de una línea en el changelog que resuelve un problema que los administradores llevan meses esquivando: una configuración administrada `managedMcpServers` que permite a una organización proveer servidores MCP HTTP y SSE a todos los usuarios. La misma versión cambió `allowedMcpServers` para que solo gobierne los servidores que los usuarios agregan por su cuenta. Esas dos líneas juntas reorganizan cómo funciona la gobernanza de MCP, y la segunda elimina una red de seguridad en la que algunos equipos confían hoy.

## Por qué managed-mcp.json era la herramienta equivocada para "todos reciben Sentry"

Antes de 2.1.259 había dos mecanismos y ninguno servía bien para distribuir. Las listas de permitidos filtran, no despliegan: la [documentación de MCP administrado](https://code.claude.com/docs/en/managed-mcp) es explícita en que `allowedMcpServers` y `deniedMcpServers` "no son un registro" y que un servidor primero tiene que ser agregado por un usuario, un plugin o `managed-mcp.json` antes de que cualquiera de las dos listas aplique.

Queda `managed-mcp.json`, que sí despliega servidores pero viene con dos condiciones pesadas. Es un archivo independiente en una ruta del sistema, así que necesita Jamf, Intune, Group Policy o algo más con permisos de administrador en la máquina:

```json
{
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

Si lo implementas, Claude Code carga únicamente lo que define ese archivo. Los servidores de plugins dejan de cargarse. Los servidores pasados con `--mcp-config` son rechazados. Los conectores de claude.ai quedan suprimidos salvo que además configures `allowAllClaudeAiMcps`. Es un mecanismo de bloqueo que además distribuye servidores, no un mecanismo de distribución. Y según la [documentación de configuración administrada por servidor](https://code.claude.com/docs/en/server-managed-settings), "no se puede distribuir mediante configuración administrada por servidor", de modo que una organización sin MDM no tenía ninguna vía.

`managedMcpServers` es una clave de configuración en lugar de un archivo independiente, lo que significa que viaja por el canal normal de configuración administrada, incluida la consola de administración de claude.ai:

```json
{
  "managedMcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

La restricción a HTTP y SSE es la decisión de diseño interesante. Una entrada stdio sería un arreglo argv ejecutado en cada máquina de desarrollo, entregado por la red desde un servidor. Limitar la clave a transportes remotos evita que una carga de configuración se convierta en ejecución remota de código.

## La lista de permitidos dejó de ser una red de seguridad

La segunda línea del changelog importa más de lo que aparenta. La documentación actual todavía dice que `allowedMcpServers` y `deniedMcpServers` "también aplican a los servidores administrados, así que un servidor administrado que no las pase no se cargará". En 2.1.259 la lista de permitidos solo gobierna los servidores que agregan los usuarios. Los servidores impuestos por el administrador ya son una decisión del administrador, así que volver a verificarlos contra su propia lista era redundante, pero si escribiste una lista estricta de `serverUrl` como verificación adicional sobre todo lo que se carga, ya no cubre el conjunto administrado. Las listas de bloqueo no cambiaron y siguen fusionándose desde todos los ámbitos, que es la palanca que conviene conservar.

La referencia de configuración todavía no incorpora la clave nueva, así que confirma la forma de la entrada en una máquina con `claude mcp list` antes de implementarla en toda la flota. Si aún estás montando el lado de filtrado, [cómo controlar de forma centralizada qué servidores MCP puede ejecutar tu equipo](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) cubre la precedencia de coincidencias que hace tropezar a la mayoría de las primeras implementaciones.

Todos los detalles en el [changelog de Claude Code](https://code.claude.com/docs/en/changelog).
