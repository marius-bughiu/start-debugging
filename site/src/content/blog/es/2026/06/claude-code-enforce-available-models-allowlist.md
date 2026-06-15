---
title: "Claude Code 2.1.175 cierra el resquicio de availableModels con enforceAvailableModels"
description: "Durante meses availableModels restringió el selector de modelos, pero dejó la opción Default totalmente abierta. Claude Code 2.1.175 agrega enforceAvailableModels para que los administradores por fin puedan fijar una lista estricta de modelos permitidos."
pubDate: 2026-06-15
tags:
  - "claude-code"
  - "ai-agents"
  - "governance"
lang: "es"
translationOf: "2026/06/claude-code-enforce-available-models-allowlist"
translatedBy: "claude"
translationDate: 2026-06-15
---

Si tu organización se estandarizó en `availableModels` para controlar qué modelos de Claude pueden ejecutar los desarrolladores, todo este tiempo ha existido un agujero silencioso en esa valla. La lista de permitidos regía `/model`, la bandera `--model`, `ANTHROPIC_MODEL`, los subagentes y las anulaciones del asesor, pero nunca tocó la única opción que muestra todo selector: Default. Un desarrollador podía elegir Default y terminar en el valor predeterminado del sistema para su nivel, pasando por encima de tu lista curada. Claude Code 2.1.175, publicado el 2026-06-12, por fin cierra esa brecha con una nueva configuración administrada: `enforceAvailableModels`.

## Por qué Default era la fuga

`availableModels` siempre fue una lista de permitidos para modelos *con nombre*. La entrada Default es especial. No es un alias de modelo, sino que se resuelve al valor predeterminado en tiempo de ejecución para el nivel de la cuenta (Opus 4.8 en la API de Anthropic para Max y pago por uso, Sonnet 4.6 en los asientos por suscripción, y así sucesivamente). Como Default esquiva la lista con nombre, un administrador que configurara esto:

```json
{
  "availableModels": ["claude-sonnet-4-5", "haiku"]
}
```

aun así no podía impedir que un usuario seleccionara Default y obtuviera el modelo más nuevo del nivel. Para los equipos que fijan una versión específica por motivos de costo o cumplimiento, eso era una elusión real, no teórica.

## Qué hace realmente enforceAvailableModels

Configúralo en `true` en los ajustes administrados o de política junto con una lista `availableModels` no vacía. Cuando el valor predeterminado del nivel no está en la lista de permitidos, Default ahora se resuelve a la primera entrada permitida en lugar del valor predeterminado del nivel.

```json
{
  "model": "claude-sonnet-4-5",
  "availableModels": ["claude-sonnet-4-5", "haiku"],
  "enforceAvailableModels": true,
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5"
  }
}
```

Las dos configuraciones cubren ámbitos distintos. `enforceAvailableModels` hace que Default obedezca la lista de permitidos, mientras que el bloque `env` fija a qué versión se resuelve un alias permitido como `sonnet`. Una advertencia que vale la pena memorizar: una lista vacía `availableModels: []` nunca activa la aplicación, así que los usuarios conservan su Default de nivel sin importar lo que diga `enforceAvailableModels`.

## La pasada de endurecimiento de 2.1.176

Un día después, 2.1.176 selló dos bordes adyacentes. Las elecciones de modelos por alias ya no pueden redirigirse a un modelo bloqueado mediante las variables de entorno `ANTHROPIC_DEFAULT_*_MODEL`, y `/fast` ahora se niega a alternar cuando el cambio aterrizaría en un modelo fuera de la lista de permitidos.

Igual de importante es el comportamiento de fusión. Cuando `availableModels` se configura en los ajustes administrados o de política, ese valor reemplaza por completo el resultado fusionado. Las entradas agregadas en los ajustes de usuario o de proyecto no pueden ampliarlo, y `enforceAvailableModels` se reemplaza de la misma manera. A partir de 2.1.175, esta es la única forma de aplicar una lista de permitidos estricta; las versiones anteriores fusionaban la lista administrada con las entradas de menor precedencia, lo que significaba que un desarrollador podía agregarle entradas de forma silenciosa.

Si ejecutas Claude Code en todo un equipo y te importa qué modelos se ejecutan realmente, actualiza a 2.1.175 o posterior y combina `availableModels` con `enforceAvailableModels`. Las reglas completas de precedencia están en la [documentación de configuración de modelos](https://code.claude.com/docs/en/model-config).
