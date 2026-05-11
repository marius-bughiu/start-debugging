---
title: "Cursor 3.3 agrega Build in Parallel, Split PRs y una revisión de PR unificada"
description: "Cursor 3.3 (7 de mayo de 2026) trae subagentes asíncronos que trabajan en pasos independientes de un plan al mismo tiempo, una acción rápida que divide un chat en varios pull requests, y un flujo de revisión de PR rediseñado que mantiene revisiones, commits y cambios en un solo lugar."
pubDate: 2026-05-11
tags:
  - "cursor"
  - "ai-agents"
  - "pull-requests"
  - "subagents"
lang: "es"
translationOf: "2026/05/cursor-3-3-build-in-parallel-split-prs"
translatedBy: "claude"
translationDate: 2026-05-11
---

El 7 de mayo de 2026, Cursor lanzó la [versión 3.3](https://cursor.com/changelog/05-07-26). Es una versión que profundiza en el mismo cambio que ya insinuaba la [versión preliminar del SDK de TypeScript](/es/2026/05/cursor-typescript-sdk-programmatic-coding-agents/): los agentes ya no son un único hilo de trabajo atado a un chat. Las características destacadas, "Build in Parallel", "Split PRs" y una superficie rediseñada de revisión de PRs, empujan al editor hacia un IDE multiagente donde una persona supervisa varias ejecuciones simultáneas.

## Build in Parallel convierte un plan en subagentes asíncronos

La planificación ya formaba parte del flujo de Cursor: tú redactas un plan y el agente recorre los pasos. En 3.3, una nueva acción "Build in Parallel" toma ese plan, identifica los pasos independientes y lanza subagentes asíncronos que trabajan en cada uno al mismo tiempo. Cursor mantiene los pasos dependientes en orden cuando el plan implica una secuencia, así que no tienes que marcar el grafo manualmente.

Si prefieres el sabor de CLI, hay un comando `/multitask` que controla la misma maquinaria desde el chat:

```text
/multitask
- Wire the Stripe webhook handler
- Add a Polly retry policy around the OpenAI client
- Rewrite the README install section
```

Cada elemento se ejecuta en su propio contexto de subagente. Los subagentes comparten el espacio de trabajo mediante instantáneas, no el mismo búfer, por lo que dos ediciones concurrentes sobre el mismo archivo ya no chocan. El subagente Explore ahora también acepta un selector de modelo (`model: opus`, `model: parent` o `disabled`), lo que significa que el salto barato de "encuentra el código relevante" puede ejecutarse en un modelo más pequeño que el escritor.

## Split PRs divide un chat en varios

Cualquiera que haya dejado correr un agente durante una hora conoce el dolor: cuando lo detienes, el diff cubre cuatro cambios sin relación entre sí y revisarlo como un solo PR es imposible. La nueva acción rápida "Split into PRs" analiza la transcripción del chat, agrupa los commits por preocupación lógica y abre un PR por grupo. Cursor mantiene los PRs independientes salvo que detecte una dependencia real, en cuyo caso los enlaza con una nota "depends on".

Antes de la división se crea una instantánea de seguridad, y Cursor pide aprobación antes de hacer push.

## PR Review unifica tres pestañas en un solo flujo

La tercera pieza es una vista de PR rediseñada dentro del editor. Tres pestañas reemplazan la antigua división entre GitHub y el panel del agente:

- **Reviews**: hilos de revisión en línea y comentarios de PR de nivel superior, con acciones rápidas para responder o aceptar.
- **Commits**: una lista de commits enfocada al PR, para recorrer paso a paso el historial del agente.
- **Changes**: un árbol de archivos más un selector, la parte que se nota cuando el PR toca cuarenta archivos.

En conjunto, las tres características esbozan la misma dirección que apuntaba el [SDK de TypeScript de Cursor](/es/2026/05/cursor-typescript-sdk-programmatic-coding-agents/): la unidad de trabajo ya no es "un prompt, un diff", es "un plan, muchos subagentes, muchos PRs".
