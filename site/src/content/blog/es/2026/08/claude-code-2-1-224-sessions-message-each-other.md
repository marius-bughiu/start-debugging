---
title: "Claude Code 2.1.224 permite que una sesión le escriba a otra"
description: "La mensajería entre sesiones llegó el 2026-08-07. ListAgents y SendMessage mueven texto plano entre tus sesiones, y crossSessionInbound decide qué llega de verdad."
pubDate: 2026-08-10
tags:
  - "claude-code"
  - "ai-agents"
  - "developer-tools"
lang: "es"
translationOf: "2026/08/claude-code-2-1-224-sessions-message-each-other"
translatedBy: "claude"
translationDate: 2026-08-10
---

Dos terminales, el mismo repositorio. El que corre la migración acaba de renombrar una columna contra la que el otro todavía escribe consultas. Hasta la semana pasada, la solución eras tú, copiando y pegando entre ventanas. Claude Code 2.1.224, publicado el 2026-08-07, cierra ese ciclo: una sesión puede entregarle un mensaje a otra sesión en la misma máquina.

## ListAgents la encuentra, SendMessage la entrega

Dos herramientas hacen el trabajo, y no llamas a ninguna. `ListAgents` enumera los agentes que una sesión puede alcanzar, `SendMessage` le habla a uno de ellos por nombre. Tú describes la intención:

```text
Tell the session working on the payments API that the tenant_id column landed
```

Claude escribe el texto del mensaje por su cuenta. Para ver la lista tú mismo, ejecuta `/list-agents`, con alias `/peers`. Una sesión responde al nombre que le pusiste con `--name` o `/rename`; si no le pones ninguno, Claude Code deriva un nombre del directorio de trabajo, como `myapp-3f`.

La entrega dentro de la misma máquina va por un socket Unix por sesión y nunca pasa por los servidores de Anthropic. `/status` muestra la ruta en una fila `Peer address`, y los hooks y comandos de Bash la reciben como `CLAUDE_CODE_MESSAGING_SOCKET`, que es la vía por la que un script escribe de vuelta a la sesión que lo lanzó.

Los requisitos son estrechos: v2.1.224 o posterior, macOS o Linux (WSL 2 cuenta, Windows nativo no), y no funciona en Amazon Bedrock, Google Cloud's Agent Platform ni Microsoft Foundry.

## Lo que el canal se niega a transportar

Un mensaje es texto plano. No es historial de conversación, ni archivos, ni permisos. Al llegar, Claude Code le dice a la sesión receptora que el texto vino de otro agente y no de ti, y ese encuadre tiene dientes: el mensaje no puede responder una solicitud de permiso pendiente, no puede convencer al receptor de reescribir `CLAUDE.md` ni sus reglas de permisos, y un `/compact` en el cuerpo llega como texto inerte en vez de como comando.

El manejo de los mensajes entrantes es una opción de configuración, `crossSessionInbound`, con tres valores: `accept`, `hold` y `refuse`. Sin nada configurado, Claude Code decide mensaje por mensaje comparando las clases de modo de permisos de ambas sesiones. Una sesión en `bypassPermissions` retiene lo que envía una sesión que pregunta, y una sesión que pregunta retiene lo que envía una que omite las solicitudes. Los mensajes retenidos abren un diálogo de aprobación que expira a los cinco minutos, ajustable con `dialogExpiry`.

Ese comportamiento por defecto explica por qué un worker headless se queda callado. Una sesión `claude -p` abre un socket de bandeja de entrada y aparece en el listado, pero no puede mostrar un diálogo de aprobación, así que un mensaje retenido se queda retenido. Dale un accept explícito en su valor de `--settings`:

```json
{
  "crossSessionInbound": "accept"
}
```

Apagarlo es la imagen espejo, y los administradores pueden imponerlo mediante los ajustes gestionados:

```json
{
  "permissions": {
    "deny": ["SendMessage", "ListAgents"]
  },
  "crossSessionInbound": "refuse"
}
```

Denegar `SendMessage` también elimina la mensajería hacia subagentes y hacia compañeros de un equipo de agentes, porque la misma herramienta sirve para ambos. Si dependes del [anidamiento de tres capas que reabrió la 2.1.219](/es/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/), esa regla de denegación cuesta más de lo que parece.

## Entre máquinas, un día después

La versión 2.1.225, publicada el 2026-08-08, extiende el alcance. Según el [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), `SendMessage` ahora puede iniciar una conversación por nombre con tus sesiones de Remote Control en otras máquinas, y `ListAgents` las muestra como `name [ref]`. Antes de eso, el tráfico entre máquinas era solo de respuesta, que es como todavía lo describe la [documentación](https://code.claude.com/docs/en/cross-session-messaging).

Esos mensajes sí viajan por los servidores de Anthropic sobre la conexión de Remote Control, así que hay un interruptor para ello. Poner `isolatePeerMachines` en `true` exige tu aprobación explícita antes de que algo salga de la máquina, incluso en modo `bypassPermissions`, y un `true` desde cualquier ámbito de configuración manda.

La cháchara desbocada está acotada por el transporte y no por la buena conducta: las repeticiones tienen límite de frecuencia por emisor, las idénticas dentro de una ventana corta se descartan, y como mucho 50 mensajes aceptados hacen cola para una sesión que no los ha leído.
