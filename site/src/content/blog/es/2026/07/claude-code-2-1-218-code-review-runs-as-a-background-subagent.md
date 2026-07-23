---
title: "Claude Code 2.1.218 ejecuta /code-review como un subagente en segundo plano"
description: "La versión 2.1.218 mueve /code-review fuera de tu conversación principal a un subagente en segundo plano, y las skills con contexto fork ahora se ejecutan en segundo plano por defecto. Esto es lo que cambió y cómo optar por no hacerlo."
pubDate: 2026-07-23
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "es"
translationOf: "2026/07/claude-code-2-1-218-code-review-runs-as-a-background-subagent"
translatedBy: "claude"
translationDate: 2026-07-23
---

Claude Code 2.1.218, lanzada el 23 de julio de 2026, cambia dónde se ejecuta `/code-review`. En lugar de expandir una revisión larga dentro de la conversación y empujar tu trabajo real hacia arriba y fuera de la vista, la revisión ahora se ejecuta como un subagente en segundo plano. Tu conversación sigue siendo tuya. La revisión ocurre a un lado, y la consultas cuando quieres.

## Qué cambia en 2.1.218

El titular es pequeño en el registro de cambios y grande en el uso diario: `/code-review` ahora se ejecuta como un subagente en segundo plano. De ahí se derivan tres cosas.

La salida de la revisión ya no llena tu conversación. Una revisión de código puede producir docenas de hallazgos en muchos archivos. Antes todo eso caía en la transcripción principal, sepultando el hilo en el que estabas trabajando. Ahora vive en el subagente.

Los comandos slash apilados se mantienen como el objetivo de la revisión. Si pones `/code-review` en cola detrás de otros comandos, la revisión sigue sabiendo qué se supone que debe examinar en lugar de perder su objetivo cuando pasa a segundo plano.

La navegación ganó una barrera de seguridad. Presionar `Esc` en la vista del agente te devuelve a la conversación desde la que se envió la revisión a segundo plano, así que no pierdes tu lugar. La misma versión también corrigió que la tecla de flecha izquierda descartara silenciosamente una conversación sin posibilidad de deshacer. Ahora pide confirmación.

## El final de un cambio que empezó en 2.1.215

Esto no salió de la nada. Unas compilaciones antes, la 2.1.215 (19 de julio) dejó de que Claude ejecutara `/verify` y `/code-review` por su cuenta. Los invocas cuando los quieres. La 2.1.218 extiende la misma idea a la investigación: `/deep-research` ahora solo comienza cuando lo invocas manualmente, y Claude ya no lo lanza por su cuenta.

En conjunto, el mensaje es consistente. Las skills largas, ruidosas y costosas son opcionales y fuera de banda. No se disparan automáticamente, y cuando las disparas, no toman el control de tu sesión. Este es el mismo instinto detrás de que los subagentes se [ejecuten en segundo plano por defecto](/es/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/) desde la 2.1.198.

## Las skills con contexto fork ahora se ejecutan en segundo plano por defecto

Hay un cambio complementario que vale la pena conocer si escribes skills. Las skills con `context: fork` ahora se ejecutan en segundo plano por defecto. Eso coincide con el comportamiento de `/code-review` para tus propias skills que arrancan un contexto aislado.

Si quieres que una skill fork se mantenga en primer plano, opta por no hacerlo por skill con un indicador en el frontmatter:

```yaml
---
name: my-review-skill
context: fork
background: false
---
```

El parser de booleanos también se volvió más amigable en la 2.1.218: `yes`, `no`, `on`, `off`, `1` y `0` ahora se aceptan junto a `true` y `false` para los booleanos del frontmatter de skills y plugins, sin distinguir mayúsculas.

## Por qué esto importa

La conversación principal es donde piensas. Cualquier cosa que vuelque un muro de salida en ella te cuesta atención, no solo tokens. Mover la revisión y la investigación a subagentes en segundo plano mantiene la transcripción legible y deja que el trabajo lento corra sin bloquearte. Si tienes memoria muscular de `/code-review` inundando la pantalla, actualízala: ejecútalo, sigue trabajando, y consulta la vista del agente cuando termine.

Todos los detalles están en el [registro de cambios de Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
