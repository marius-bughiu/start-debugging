---
title: "El modo automatico de Claude Code ahora detecta el rm -rf con variable vacia"
description: "Las versiones de la semana 28 de Claude Code (v2.1.202-v2.1.206, del 6 al 10 de julio de 2026) ensenan al modo automatico a detenerse antes de un rm -rf cuya ruta provino de una variable que se expandio a nada, cerrando el clasico problema de rm -rf /."
pubDate: 2026-07-13
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/07/claude-code-auto-mode-guards-empty-variable-rm-rf"
translatedBy: "claude"
translationDate: 2026-07-13
---

Todo el que escribe scripts de shell ha visto el desastre: una linea de limpieza como `rm -rf "$BUILD_DIR/bin"` donde `$BUILD_DIR` nunca se definio, asi que el comando se expande silenciosamente a `rm -rf /bin`. Las versiones de la semana 28 de Claude Code (de la v2.1.202 a la v2.1.206, publicadas del 6 al 10 de julio de 2026) anaden una proteccion para exactamente este caso en el modo automatico: el agente ahora se detiene y pregunta antes de ejecutar un `rm -rf` cuya ruta de destino se construyo a partir de una variable que se resolvio a nada.

## Por que un agente cae en esto mas que tu

Tu escribes un comando destructivo una vez y lo revisas con la vista. Un agente en modo automatico encadena shell sobre la marcha, a menudo reutilizando una variable que definio tres turnos atras. Si un paso anterior fallo y dejo esa variable vacia, el peligro no es que el modelo escriba `rm -rf /` a proposito. Es que escribe algo que *parece* acotado y seguro, y el shell lo convierte en un borrado a nivel de la raiz en el momento de la expansion.

```bash
# The agent set this earlier, but the step that populated it failed
BUILD_DIR=""

# Looks scoped. Expands to: rm -rf /bin
rm -rf "$BUILD_DIR/bin"

# Same trap with an unset var under `set -u` off
rm -rf $ARTIFACTS_DIR/*
```

El clasificador del modo automatico ahora inspecciona el comando resuelto, no solo el texto literal que verias en la transcripcion. Cuando la ruta que un `rm -rf` esta a punto de borrar se remonta a una variable vacia o sin resolver, el agente se detiene y la presenta para tu aprobacion en lugar de ejecutarla.

## Intencion, no una prohibicion general

Esta es la misma linea de diseno que Claude Code trazo en la [v2.1.183, que bloqueo los comandos destructivos de Git e IaC que el agente decidia ejecutar por su cuenta](/es/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/). Un `rm -rf ./build` deliberado que tu pediste sigue ejecutandose sin preguntar. La proteccion se activa en el caso especifico donde el destino expandido es mucho mas amplio que la intencion, porque una variable quedo vacia.

Antes de la semana 28, el modo automatico evaluaba `rm -rf "$BUILD_DIR/bin"` por la cadena de superficie, que se lee como un borrado local y acotado. Despues, la comprobacion ocurre contra lo que el shell realmente va a eliminar, asi que un `$BUILD_DIR` vacio convierte una luz verde en una pregunta.

## El resto de la semana 28

El mismo lote de versiones refuerza el modo automatico contra la manipulacion de la transcripcion (el agente ya no puede reescribir en silencio su propio historial de sesion), convierte `/doctor` en una revision completa de configuracion que diagnostica y puede corregir problemas, con `/checkup` como alias, y rehace la vista `claude agents` para que cada fila muestre una palabra de estado en color y un titular escrito por un clasificador en lugar de la salida cruda de las herramientas. La aplicacion de escritorio tambien incorporo un navegador integrado esta semana, asi que Claude puede abrir documentacion y disenos igual que ya maneja las vistas previas de tu servidor de desarrollo local.

Si ejecutas agentes en modo automatico contra repositorios reales o checkouts de CI, esta es la clase de proteccion que solo notas el dia que te salva. Las notas completas estan en el [changelog de Claude Code](https://code.claude.com/docs/en/changelog).
