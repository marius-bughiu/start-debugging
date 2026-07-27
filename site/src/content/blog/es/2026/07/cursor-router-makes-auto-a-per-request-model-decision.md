---
title: "Cursor Router convierte Auto en una decisión de modelo por solicitud"
description: "Cursor Router llegó el 2026-07-22. Auto ahora clasifica cada solicitud y la enruta a un modelo distinto, y los modos Cost, Balance e Intelligence cambian tanto la calidad que obtienes como la forma en que te facturan."
pubDate: 2026-07-27
tags:
  - "cursor"
  - "ai-agents"
  - "developer-tools"
lang: "es"
translationOf: "2026/07/cursor-router-makes-auto-a-per-request-model-decision"
translatedBy: "claude"
translationDate: 2026-07-27
---

Cursor lanzó [Cursor Router](https://cursor.com/blog/router) el 2026-07-22, y eso cambia sin hacer ruido lo que significa la opción de modelo Auto. Antes, Auto era una única política de enrutamiento orientada a mantener bajo el gasto de tokens. Ahora es un sistema de decisión que se coloca delante de todos los modelos de tu cuenta, clasifica cada solicitud por tipo de tarea y complejidad, y elige el modelo para esa solicitud concreta.

## Tres modos, tres facturas distintas

En el selector de modelos eliges Auto y luego un modo bajo "Optimize For". La [documentación](https://cursor.com/docs/cursor-router) los describe así:

- **Cost** usa la lógica de enrutamiento anterior de Auto. Optimiza el gasto de tokens y mantiene el precio empaquetado de Auto, facturado por millón de tokens.
- **Balance** optimiza inteligencia, velocidad y costo, y factura por solicitud a la tarifa del modelo al que enrutó.
- **Intelligence** enruta a los modelos más capaces para tareas más difíciles, a un costo menor que ejecutar un único modelo de frontera. También se factura por solicitud.

Esa facturación por solicitud es la parte que conviene leer dos veces. Cost es el único modo que conserva la tarifa empaquetada. La propia guía de Cursor indica que Balance e Intelligence cuestan en promedio alrededor del doble que Cost, y hasta dos a cuatro veces más según el modo que selecciones.

El intercambio es real, no marketing. Cursor reporta que clientes de acceso anticipado recortaron entre 30 y 50 por ciento frente a usar Opus 4.8 para todo, con costos por commit de 6.76 USD en Intelligence y 4.63 USD en Balance. Intelligence queda cerca de Fable en satisfacción de usuario con un costo aproximadamente 60 por ciento menor para equipos, y Balance se ubica por encima de Opus 4.8 con un costo cerca de 36 por ciento menor.

## El modelo enrutado está oculto por defecto

Existe una opción en el panel para mostrar a qué modelo enrutó Auto al inicio de cada respuesta. Oculto es el valor predeterminado, y Cursor recomienda dejarlo así.

Para el trabajo del día a día está bien. Para quien intenta razonar sobre el comportamiento del agente, no. Cuando el mismo prompt produce una refactorización limpia el lunes y una mediocre el martes, la diferencia puede ser el modelo enrutado, y por defecto nada en la transcripción te lo dice. Si estás evaluando el router antes de desplegarlo a un equipo, activa primero la visualización y déjala encendida durante toda la prueba.

## Fija el modelo cuando la ejecución tiene que ser reproducible

El enrutamiento es excelente para trabajo interactivo y malo para cualquier cosa que compares contra una línea base. Para ejecuciones de CI, arneses de evaluación y trabajos de agente en scripts, fija un modelo explícito en lugar de heredar Auto:

```bash
# see the exact model ids this account exposes
agent --list-models

# pin one for a run that has to be repeatable
agent -p "run the failing tests and fix them" \
  --model <id-from-list-models> \
  --output-format json
```

Cursor Router funciona en escritorio, web, iOS, la CLI y el SDK. Está activo por defecto en los planes Teams, los administradores de Enterprise lo habilitan desde el panel, y los planes individuales (Hobby, Pro, Pro+, Ultra) lo reciben unos meses después del lanzamiento. Los administradores pueden restringir qué modos pueden elegir los miembros, definir el predeterminado, permitir o bloquear modelos subyacentes concretos, y aplicar de forma suave o estricta la estandarización en Auto.

Si tu equipo ya se apoya en trabajo con agentes en paralelo, como los [side chats que llegaron en Cursor 3.11](/es/2026/07/cursor-3-11-side-chats-parallel-agent-threads/), el router cambia la forma del costo de todo eso de una sola vez. Revisa el modo que fijó tu administrador antes de suponer que la factura quedó igual.
