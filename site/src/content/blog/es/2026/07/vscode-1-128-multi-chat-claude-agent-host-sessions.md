---
title: "VS Code 1.128 agrega sesiones agent-host de Claude con varios chats"
description: "VS Code 1.128 (8 de julio de 2026) permite que una sola sesión agent-host de Claude contenga varios chats en paralelo, cada uno con su propio historial, título y modelo. Esto es lo que chat.agentHost.enabled realmente habilita y cómo encajan las piezas de quick chat y BYOK."
pubDate: 2026-07-09
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "es"
translationOf: "2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions"
translatedBy: "claude"
translationDate: 2026-07-09
---

VS Code 1.128 se lanzó el 8 de julio de 2026, y lo más destacado no es una característica de Copilot. Es que una sola sesión agent-host de Claude ahora puede contener varios chats relacionados a la vez, cada uno con su propio historial, título y selección de modelo, todos agrupados bajo una sesión principal. El modo agent-host funciona con el Claude Agent SDK de Anthropic ejecutándose directamente dentro de VS Code, y esta versión lo convierte de una experiencia de un solo hilo en algo más parecido a un banco de trabajo.

## Por qué importa una sesión con varios chats

Antes de la 1.128, explorar dos enfoques para el mismo problema significaba o bien arruinar tu contexto al pivotar a mitad del hilo, o bien iniciar una sesión completamente nueva y perder la configuración compartida. Los chats múltiples solucionan esto. Puedes ramificar desde un turno anterior, mantener el chat original intacto y ejecutar ambos en paralelo. Cada chat rastrea su propio modelo, así que puedes enfrentar un modelo más económico contra uno más potente en la misma tarea y comparar los diffs lado a lado sin salir de la sesión.

Esto está condicionado al modo agent-host. Actívalo en `settings.json`:

```json
{
  "chat.agentHost.enabled": true
}
```

Con eso configurado, la ventana **Agents** se convierte en el centro. Los chats nuevos aparecen en una sección **Chats** bajo la sesión principal, y enfocas la ventana con el comando `workbench.action.openAgentsWindow`.

## Los quick chats eliminan el requisito de un espacio de trabajo

El segundo cambio que reduce la fricción son los quick chats. Ahora puedes iniciar una conversación desde la ventana Agents sin abrir una carpeta primero. Eso suena menor hasta que te das cuenta de cuántas veces quieres preguntarle algo a un agente que no tiene nada que ver con el proyecto abierto, y antes tenías que abrir un espacio de trabajo temporal para hacerlo. Los quick chats solo son compatibles con las sesiones agent-host, así que dependen del mismo interruptor `chat.agentHost.enabled`.

Los subagentes también reciben una mención: el agent-host puede delegar a un subagente, y ves la transcripción del subagente en modo de solo lectura, de modo que una delegación no contamina el historial del chat principal.

## Usar tus propias claves de modelo

También hay una opción experimental para los equipos que quieren enrutar a través de su propio proveedor de modelos en lugar de la ruta incluida:

```json
{
  "chat.agentHost.byokModels.enabled": true
}
```

El soporte BYOK está marcado como experimental en la 1.128, así que trátalo como una versión preliminar y no como algo que estandarizar en un equipo esta semana. Combínalo con `chat.byokUtilityModelDefault` si quieres controlar qué modelo maneja las llamadas de utilidad más económicas.

Para cerrar la versión, Copilot Vision pasó a estar disponible de forma general, así que pegar, arrastrar o soltar imágenes y PDF en el Chat ya no es una versión preliminar, y el agente puede acceder a esos adjuntos mediante una llamada de herramienta.

La pieza de los chats múltiples es la que vale la pena probar primero. Si ya ejecutas el agent-host de Claude en VS Code, activa `chat.agentHost.enabled`, abre la ventana Agents y ramifica un chat en lugar de reiniciar uno. Las notas completas están en las [notas de la versión VS Code 1.128](https://code.visualstudio.com/updates/v1_128).
