---
title: "VS Code 1.135 trae /rubber-duck, y usa un modelo distinto a propósito"
description: "El comando experimental /rubber-duck de VS Code 1.135 entrega el plan, el código y las pruebas del agente a un modelo de otra familia para que los revise. GPT-5.4 critica a Claude, y esa elección entre familias es justamente el punto."
pubDate: 2026-09-01
tags:
  - "ai-agents"
  - "github-copilot"
  - "llm"
  - "claude-code"
lang: "es"
translationOf: "2026/09/vscode-1-135-rubber-duck-cross-model-review"
translatedBy: "claude"
translationDate: 2026-09-01
---

VS Code 1.135 salió el 2026-08-26, y GitHub lo incluyó en el changelog "GitHub Copilot in VS Code, August 2026 releases" el 2026-08-31. Entre todo el trabajo de diseño de sesiones se esconde lo más interesante de la versión: un comando experimental `/rubber-duck` que consigue una segunda opinión sobre el trabajo del agente a partir de un modelo de otra familia.

## La autorrevisión no encuentra lo que el modelo ya pasó por alto

Pedirle a un modelo que revise su propia salida es casi gratis, y por eso lo hace prácticamente cualquier harness de agentes. También es débil. Los mismos pesos que produjeron el plan producen la revisión, así que los puntos ciegos están correlacionados: si el modelo no pensó en el caso de escritura concurrente al escribir el código, tampoco piensa en él al revisar el código.

Rubber Duck apuesta por lo contrario. El orquestador es cualquier modelo de la familia Claude elegido en el selector de modelos, y el revisor es GPT-5.4. La estrategia de modelo complementario es explícita, no accidental: el revisor se elige de una familia distinta a la del modelo principal, de modo que una sesión con Claude recibe un crítico GPT y una sesión con GPT recibe lo inverso. GitHub reconoce abiertamente que esto es un experimento, y dice que está "explorando otras familias de modelos para el orquestador y para Rubber Duck".

## Un crítico de solo lectura con salida triada

Rubber Duck no puede editar. Lee el plan, el diff y las pruebas, y busca problemas de fondo: errores de lógica, fallas de diseño, huecos de seguridad, cobertura de pruebas faltante. Lo que devuelve viene triado, no volcado sin más:

```text
> /rubber-duck

Blocking
  - RefreshTokenAsync writes the new token before the old one is revoked.
    A crash between the two leaves both valid.

Non-blocking
  - The retry loop has no jitter. Three clients failing together will
    stay in lockstep.

Suggestions
  - No test covers an expired token with a valid signature.
```

La división entre bloqueante, no bloqueante y sugerencias es la parte que vale la pena copiar si construyes tu propio subagente de revisión. Una lista sin jerarquía de doce observaciones se lee en diagonal; tres puntos bloqueantes se leen de verdad.

## Se dispara solo, con moderación

Puedes invocarlo a mano, pero Copilot también lo llama en cuatro momentos donde el retorno es mayor: después de redactar un plan, después de una implementación compleja, después de escribir pruebas pero antes de ejecutarlas, y cuando el agente se queda atascado en un bucle. Ese último disparador es el que más justifica su costo, porque un agente en bucle es la señal más clara de que el modelo principal se quedó sin ideas sobre su propia salida.

Por dentro corre a través de la herramienta de tareas que Copilot ya tenía, la misma maquinaria que usan los demás subagentes. Eso significa que no es gratis: cada invocación automática es un turno completo de modelo contra tu consumo premium, además de los tokens del agente principal. VS Code 1.135 también agregó contabilidad de tokens por modelo en el pie de cada respuesta del chat, que es como vas a enterarte de lo que cuesta el pato.

## Cómo activarlo

En VS Code, `/rubber-duck` funciona dentro de una sesión agent host de Copilot, el modo que ejecuta el harness en un proceso dedicado sobre el Agent Host Protocol. Si todavía no habilitaste las sesiones agent host, ese es el mismo conjunto de funcionalidades que [estrenó las sesiones agent-host de Claude con varios chats en VS Code 1.128](/es/2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions/). En GitHub Copilot CLI, lo habilitas con el comando `/experimental`.

La disponibilidad es condicional: la sesión principal tiene que estar sobre un modelo Claude o GPT, y tiene que haber un modelo complementario adecuado. Si no se cumple ninguna de las dos cosas, el comando sencillamente no aparece.

Todos los detalles están en las [notas de la versión de VS Code 1.135](https://code.visualstudio.com/updates/v1_135) y en el artículo de GitHub sobre [combinar familias de modelos para una segunda opinión](https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/).
