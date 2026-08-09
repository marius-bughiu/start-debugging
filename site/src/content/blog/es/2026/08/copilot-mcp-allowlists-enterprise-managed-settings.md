---
title: "Las listas de permitidos de MCP llegan a la configuración gestionada de empresa de Copilot"
description: "El changelog de GitHub del 6 de agosto de 2026 agrega allowedMcpServers y deniedMcpServers a copilot/managed-settings.json. Matchers por URL y argv, precedencia de la denegación y un valor por defecto que falla en cerrado, algo que el registro basado en nombres nunca tuvo."
pubDate: 2026-08-09
tags:
  - "github-copilot"
  - "mcp"
  - "ai-agents"
  - "security"
lang: "es"
translationOf: "2026/08/copilot-mcp-allowlists-enterprise-managed-settings"
translatedBy: "claude"
translationDate: 2026-08-09
---

El 2026-08-06 GitHub publicó [MCP allowlists in enterprise managed settings](https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings/). Dos claves, `allowedMcpServers` y `deniedMcpServers`, ahora deciden qué servidores Model Context Protocol tiene permitido iniciar un cliente de Copilot. Está disponible de forma general y aplica a la app de GitHub Copilot, a Copilot CLI y a VS Code.

Esto cierra un hueco que estaba abierto desde que el soporte de MCP se generalizó. La respuesta previa a nivel empresa era el [registro MCP personalizado](https://docs.github.com/en/copilot/concepts/mcp-management), todavía en versión preliminar pública, que identifica servidores por nombre o por ID. Los nombres son etiquetas que asigna el usuario, así que quien quiera un servidor bloqueado simplemente lo renombra en su máquina. La propia documentación de GitHub es directa sobre la consecuencia: los usuarios pueden saltarse la restricción editando archivos de configuración.

## Los matchers son toda la historia

El archivo vive en el repositorio `.github-private` de la empresa, en `copilot/managed-settings.json`, sobre la rama por defecto. Cada entrada identifica un servidor con exactamente un matcher.

```json
{
  "allowedMcpServers": [
    { "serverUrl": "https://api.githubcopilot.com/*" },
    { "serverCommand": ["npx", "@playwright/mcp@latest"] },
    { "serverCommand": ["cmd", "/c", "uvx", "markitdown-mcp"] }
  ],
  "deniedMcpServers": [
    { "serverUrl": "https://learn.microsoft.com/*" }
  ]
}
```

Fíjate en que `serverCommand` es un arreglo argv, no una cadena de shell, y la coincidencia es exacta. `serverUrl` admite comodines `*` y la URL se canonicaliza antes de comparar, así que los trucos con codificación o con la barra final no compran un veredicto distinto. `serverName` sigue existiendo, pero solo como respaldo: para un servidor remoto la coincidencia debe venir de una entrada `serverUrl`, y `serverName` cuenta únicamente cuando no hay ninguna entrada `serverUrl`. La misma relación aplica entre los servidores stdio y `serverCommand`. Trátalo como una comodidad, no como una frontera de seguridad.

## Los valores por defecto fallan en cerrado

La distinción entre vacío y no definido es donde los equipos van a tropezar:

- `allowedMcpServers` sin definir permite todos los servidores que no sean los predeterminados.
- `allowedMcpServers: []` los bloquea todos. Ese es tu interruptor de denegar todo.
- `deniedMcpServers` sin definir o vacío no bloquea nada.
- La denegación siempre gana. Un servidor que coincide con ambas listas queda bloqueado.
- Los servidores propios, como el servidor MCP de GitHub integrado, quedan exentos de ambas listas.

Además, una configuración mal formada o no verificable se bloquea en lugar de permitirse, y cuando las políticas llegan desde más de una capa, un servidor tiene que pasar todas las capas. Ese es el modo de fallo inverso al del registro, y es la razón real para migrar.

Para los equipos que necesitan su propia lista, envuelve los objetos matcher bajo `overridable` en el nivel de empresa y luego usa la sintaxis normal en el archivo de cada equipo. Donde haya conflicto, gana la decisión de la plataforma.

## Combínalo con el control de salida, no lo sustituyas

Una lista de permitidos gobierna qué procesos de servidor arrancan y con qué endpoints MCP se habla. No dice nada sobre a dónde se conecta una herramienta una vez que está corriendo, que es una superficie de control aparte y está cubierta en [cómo restringir la salida de red de un agente de código](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/). Dos capas, dos modos de fallo.

La sintaxis completa de los matchers está en la [Enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference).
