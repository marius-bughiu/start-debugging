---
title: "Claude Code 2.1.200 renombra el modo de permiso predeterminado a Manual"
description: "Claude Code v2.1.200 (3 de julio de 2026) renombra el modo de permiso 'default' a 'Manual' en la CLI, VS Code y JetBrains, y evita que los diálogos de AskUserQuestion continúen automáticamente. El valor de configuración sigue siendo 'default', con 'manual' aceptado como alias."
pubDate: 2026-07-04
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual"
translatedBy: "claude"
translationDate: 2026-07-04
---

Claude Code v2.1.200 salió el 3 de julio de 2026, y hace dos cosas que afectan a cualquiera que ejecute el agente de forma interactiva: renombra el modo de permiso que venías llamando "default" a "Manual", y cambia los diálogos de `AskUserQuestion` para que ya no avancen por su cuenta. Ninguno es una característica enorme, pero ambos cambian la memoria muscular y, en el segundo caso, cierran una pequeña trampa.

## Por qué "default" era un mal nombre

El modo de permiso que revisa cada acción y pregunta antes de ejecutar cualquier cosa históricamente se etiquetaba como "default". Ese nombre te decía dónde estaba en una lista, no qué hacía. Los usuarios nuevos leían "default" y asumían que era una configuración pasiva en lugar del modo que bloquea cada llamada a herramienta detrás de una solicitud de aprobación.

2.1.200 lo reetiqueta como "Manual" en todos los lugares donde lo lee una persona: el selector de la CLI, `claude --help`, y las extensiones de VS Code y JetBrains. El punto es que el nombre ahora describe el comportamiento: apruebas cada paso a mano.

Es crucial que el valor de configuración no cambió. Los hooks, el SDK y tu `settings.json` existente siguen usando `default`, así que nada se rompe:

```jsonc
// Both of these mean the same mode
{ "permissions": { "defaultMode": "default" } }
{ "permissions": { "defaultMode": "manual" } }
```

```bash
# manual is accepted as an alias wherever you type the value
claude --permission-mode manual
claude --permission-mode default   # still valid
```

Si programas scripts con Claude Code o compartes una configuración versionada con un equipo, mantén `default`: es el valor estable y canónico. Recurre a `manual` solo cuando lo estés escribiendo a mano y quieras que la etiqueta coincida con lo que ahora muestra la interfaz.

## AskUserQuestion deja de continuar automáticamente

El segundo cambio es el que vale la pena señalar en la revisión de código. La herramienta `AskUserQuestion`, que es como el agente te presenta una decisión de opción múltiple a mitad de una tarea, solía continuar automáticamente después de un periodo de inactividad, eligiendo una opción resaltada si te alejabas. Eso es conveniente hasta el momento en que te compromete de forma silenciosa con una rama de trabajo que no leíste.

En 2.1.200 estos diálogos ya no continúan automáticamente de forma predeterminada. El agente te espera. Si realmente quieres el antiguo comportamiento de alejarte, activas un tiempo de espera por inactividad de forma explícita a través de `/config` en lugar de obtenerlo lo hayas pedido o no. Este es el mismo instinto de "no decidir cosas irreversibles en nombre del usuario" que hay detrás de [2.1.183 bloqueando comandos destructivos de git e IaC en el modo automático](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/).

## El resto de la versión

2.1.200 está cargada de mejoras en la fiabilidad de los agentes en segundo plano. Corrige que las sesiones en segundo plano se detuvieran de forma silenciosa tras suspender/reanudar, un `daemon.lock` obsoleto cuyo PID reutilizado impedía que los agentes volvieran a iniciarse, y subagentes cortados por un límite de tasa que devolvían un resultado vacío en lugar de fallar de forma limpia. También hay una corrección de un fallo de arranque para cuando `disabledMcpServers` o `enabledMcpServers` en `.claude.json` tiene asignado un valor que no es un arreglo, además de un lote de mejoras para lectores de pantalla y una corrección del parpadeo de renderizado en tmux 3.4+.

Si mantienes una configuración compartida de equipo, la conclusión es pequeña pero real: tu modo de permiso no cambió, solo su nombre visible, y tus diálogos interactivos ahora están un poco menos ansiosos por avanzar sin ti. Las notas completas están en el [registro de cambios de v2.1.200](https://code.claude.com/docs/en/changelog).
