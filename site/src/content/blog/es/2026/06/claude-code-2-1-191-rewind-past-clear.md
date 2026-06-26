---
title: "Claude Code 2.1.191 permite que /rewind regrese más allá de un /clear"
description: "Claude Code v2.1.191 (24 de junio de 2026) amplía /rewind para que puedas restaurar el estado de la conversación y del código de antes de ejecutar /clear, recuperando contexto que antes se perdía para siempre."
pubDate: 2026-06-26
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/06/claude-code-2-1-191-rewind-past-clear"
translatedBy: "claude"
translationDate: 2026-06-26
---

Claude Code v2.1.191 se lanzó el 24 de junio de 2026, y el cambio destacado es pequeño en su descripción pero grande en la práctica: `/rewind` ahora puede retroceder más allá de un `/clear`. El contexto que borraste para empezar de cero ya no se ha perdido, está a un solo rewind de distancia.

## Lo que solía costarte /clear

`/clear` reinicia la conversación. Es la jugada correcta cuando el hilo actual está sobrecargado, el modelo está anclado en un callejón sin salida, o estás cambiando de tarea y quieres una ventana nueva. El costo era que trazaba un piso firme bajo tu historial. Todo lo anterior al `/clear` quedaba inaccesible, aunque Claude Code ya estaba creando puntos de control de tu sesión a medida que avanzabas.

Ese piso es lo que elimina 2.1.191. Los puntos de control de sesión que respaldan a `/rewind` ahora sobreviven a un `/clear`, así que el selector de rewind puede ofrecer puntos de antes del reinicio.

## Cómo funciona /rewind

`/rewind` te lleva hacia atrás por los puntos de control que Claude Code registra en cada paso de una sesión. Lo abres con el comando `/rewind` o presionando `Esc` dos veces:

```text
Esc Esc          # open the rewind picker
/rewind          # same thing, typed
```

Elige un punto de control y decides qué restaurar: la conversación, el código en disco, o ambos. Esa distinción importa. Puedes regresar la conversación a un punto de hace tres pasos para volver a hacer una pregunta sin tocar tu árbol de trabajo, o restaurar los archivos a un estado conocido como bueno conservando la discusión que te llevó hasta ahí.

Antes de este lanzamiento, la lista de puntos de control disponibles se detenía en tu `/clear` más reciente. Ahora sigue adelante. Una recuperación típica luce así:

```text
# A long debugging thread, then a reset
/clear
# ...new work, then you realize you need the earlier repro
Esc Esc
# the picker now lists checkpoints from before the /clear
# select one, restore conversation + code, keep going
```

## Por qué esto cambia cómo usas /clear

La razón honesta por la que la gente dudaba en ejecutar `/clear` era la aversión a la pérdida. Limpiar significaba comprometerse con el corte, así que mantenías un contexto rancio y costoso por si acaso. Hacer reversible el reinicio le da la vuelta a eso. `/clear` se convierte en una forma barata y rutinaria de mantener cada ventana ajustada, porque un corte equivocado se puede recuperar en lugar de ser permanente.

También encaja con la dirección de "puntos de control primero" de los lanzamientos recientes. Tu sesión es una secuencia de puntos de restauración entre los que puedes moverte, no una sola transcripción lineal que conservas o destruyes.

## El resto del lanzamiento

2.1.191 también corrige el salto de la posición de desplazamiento durante las respuestas en streaming, arregla un error de resurrección de agentes en segundo plano y mejora el mensaje de `/voice` que se muestra cuando una política lo deshabilita. La compilación inmediatamente posterior, 2.1.193, agrega `autoMode.classifyAllShell` para enrutar Bash y PowerShell a través del clasificador del modo automático y expone los motivos de denegación del modo automático en la traza y en `/permissions`.

Las notas completas están en el [changelog de Claude Code](https://code.claude.com/docs/en/changelog).
